/**
 * Tracker MCP Server
 *
 * Streamable HTTP MCP endpoint at /mcp using @modelcontextprotocol/sdk.
 * Exposes all tracker tools so agents can manage the tracker programmatically.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import http from "http";
import os from "os";

import {
  createProject,
  getProject,
  listProjects,
  createWorkItem,
  getWorkItem,
  getWorkItemByKey,
  getWorkItemKey,
  listWorkItems,
  updateWorkItem,
  moveWorkItem,
  changeWorkItemState,
  lockWorkItem,
  unlockWorkItem,
  clearStaleLocks,
  addDependency,
  removeDependency,
  getDependencies,
  getDependents,
  getBlockers,
  isBlocked,
  createComment,
  listComments,
  listTransitions,
  addWatcher,
  getProjectStats,
  createAttachment,
  getAttachment,
  listAttachments,
  deleteAttachment,
  MAX_ATTACHMENT_SIZE,
  VALID_STATES,
  VALID_PRIORITIES,
  VALID_PLATFORMS,
  type WorkItemState,
  type Priority,
  type Platform,
  type WorkItemFilters,
  type ActorClass,
} from "./db.js";
import fs from "fs";
import path from "path";
import { logger } from "./logger.js";
import { dispatchItem, abortSession, getOrchestratorStatus, emergencyStop, requestSafeRestart, getRestartStatus, cancelRestart, isSafeToRestart, validateAgentConfig } from "./orchestrator.js";
import { OPENCODE_PUBLIC_URL, buildOpencodeSessionUrl, STORE_DIR, ASSISTANT_PROJECT_ROOT, buildItemUrl } from "./config.js";
import { listSpacePlugins, getSpacePlugin, getCoverSpaceTypes } from "./spaces/index.js";
import { sanitizeScheduledSpaceData } from "./spaces/scheduled.js";

/** Simple MIME type detection from file extension. */
function detectMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".xml": "application/xml",
    ".html": "text/html",
    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".log": "text/plain",
  };
  return mimeMap[ext] || "application/octet-stream";
}

/** Format bytes as human-readable string. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// sanitizeScheduledSpaceData is imported from ./spaces/scheduled.js

/**
 * Sanitize space_data using the appropriate space plugin's sanitizer.
 * Falls back to the scheduled sanitizer for backward compatibility.
 */
function sanitizeSpaceData(raw: string, spaceType?: string | null): string {
  if (spaceType) {
    const plugin = getSpacePlugin(spaceType);
    if (plugin?.sanitizeSpaceData) return plugin.sanitizeSpaceData(raw);
  }
  return sanitizeScheduledSpaceData(raw, spaceType);
}

/**
 * Translate a container-relative path to a host filesystem path.
 *
 * Agent containers mount host directories at /workspace/:
 *   /workspace/group   → {ASSISTANT_PROJECT_ROOT}/groups/{groupname}/
 *   /workspace/project → {ASSISTANT_PROJECT_ROOT}/
 *   /workspace/ipc     → {ASSISTANT_PROJECT_ROOT}/data/ipc/{groupname}/
 *
 * Since the tracker server doesn't know which group the caller belongs to,
 * we try each group folder under {ASSISTANT_PROJECT_ROOT}/groups/ and return the
 * first path where the file actually exists. Falls back to 'main' if the
 * groups directory doesn't exist.
 *
 * Returns the resolved host path, or null if no translation applies
 * (i.e. the path doesn't start with /workspace/).
 */
function translateContainerPath(containerPath: string): { hostPath: string; translated: boolean } | null {
  // Only translate paths starting with /workspace/
  if (!containerPath.startsWith("/workspace/")) return null;

  const groupsDir = path.join(ASSISTANT_PROJECT_ROOT, "groups");

  // /workspace/group/... → try each group folder
  if (containerPath.startsWith("/workspace/group/")) {
    const relativePath = containerPath.slice("/workspace/group/".length);

    // Try each group folder and return the first match
    try {
      const groupFolders = fs.readdirSync(groupsDir).filter((entry) => {
        try {
          return fs.statSync(path.join(groupsDir, entry)).isDirectory();
        } catch {
          return false;
        }
      });

      // Try 'main' first (most common), then others
      const sorted = groupFolders.sort((a, b) =>
        a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b),
      );

      for (const folder of sorted) {
        const candidate = path.join(groupsDir, folder, relativePath);
        if (fs.existsSync(candidate)) {
          return { hostPath: candidate, translated: true };
        }
      }
    } catch {
      // groups dir doesn't exist — fall through
    }

    // No match found — return the main group path as best guess (for error message)
    return { hostPath: path.join(groupsDir, "main", relativePath), translated: true };
  }

  // /workspace/project/... → project root
  if (containerPath.startsWith("/workspace/project/")) {
    const relativePath = containerPath.slice("/workspace/project/".length);
    return { hostPath: path.join(ASSISTANT_PROJECT_ROOT, relativePath), translated: true };
  }

  // /workspace/ipc/... → data/ipc/ (try each group folder)
  if (containerPath.startsWith("/workspace/ipc/")) {
    const relativePath = containerPath.slice("/workspace/ipc/".length);
    const ipcDir = path.join(ASSISTANT_PROJECT_ROOT, "data", "ipc");

    try {
      const groupFolders = fs.readdirSync(ipcDir).filter((entry) => {
        try {
          return fs.statSync(path.join(ipcDir, entry)).isDirectory();
        } catch {
          return false;
        }
      });

      for (const folder of groupFolders.sort((a, b) =>
        a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b),
      )) {
        const candidate = path.join(ipcDir, folder, relativePath);
        if (fs.existsSync(candidate)) {
          return { hostPath: candidate, translated: true };
        }
      }
    } catch {
      // ipc dir doesn't exist
    }

    return { hostPath: path.join(ipcDir, "main", relativePath), translated: true };
  }

  // Other /workspace/ paths — not a known mount
  return null;
}

/**
 * Resolve an item identifier — could be a raw ID or a display key like "WRITING-28".
 * Tries key lookup first (if it matches the KEY-NUMBER pattern), falls back to raw ID.
 * Returns the resolved WorkItem or undefined if not found.
 */
function resolveItem(idOrKey: string): ReturnType<typeof getWorkItem> {
  return getWorkItemByKey(idOrKey) || getWorkItem(idOrKey);
}

/**
 * Resolve an item identifier to a raw ID string.
 * Returns the raw ID if found, otherwise returns the original string (for error handling downstream).
 */
function resolveId(idOrKey: string): string {
  const item = getWorkItemByKey(idOrKey);
  if (item) return item.id;
  return idOrKey;
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "tracker",
    version: "1.0.0",
  });

  // ── Projects ──

  server.tool("tracker_list_projects", "List all projects on the tracker", {}, async () => ({
    content: [{ type: "text", text: JSON.stringify(listProjects(), null, 2) }],
  }));

  server.tool(
    "tracker_create_project",
    'Create a new project. short_name is auto-derived from name if not provided.',
    {
      name: z.string().describe("Project name"),
      short_name: z.string().optional().describe('Short uppercase prefix for item keys (e.g. "LIZ").'),
      description: z.string().optional().describe("Project description"),
    },
    async (args) => {
      const project = createProject({
        name: args.name,
        short_name: args.short_name,
        description: args.description,
      });
      return { content: [{ type: "text", text: JSON.stringify(project, null, 2) }] };
    },
  );

  // Note: project context is intentionally NOT exposed as an MCP parameter on create/update tools.
  // It is dashboard-only — editable via the REST API PATCH /projects/:id but not through MCP,
  // because it contains owner-level operational instructions that agents should not modify.

  server.tool(
    "tracker_project_stats",
    "Get statistics for a project (counts by state, priority, assignee)",
    { project_id: z.string().describe("Project ID") },
    async (args) => {
      const project = getProject(args.project_id);
      if (!project) return { content: [{ type: "text", text: "Error: Project not found" }] };
      const stats = getProjectStats(args.project_id);
      return { content: [{ type: "text", text: JSON.stringify({ project: project.name, ...stats }, null, 2) }] };
    },
  );

  // ── Work Items ──

  server.tool(
    "tracker_create_item",
    `Create a new work item. States: ${VALID_STATES.join(", ")}. Priorities: ${VALID_PRIORITIES.join(", ")}. Use blocked_by to set dependencies (e.g. for a chain of issues where one must be completed before another).`,
    {
      project_id: z.string().describe("Project ID"),
      title: z.string().describe("Work item title"),
      description: z.string().optional().describe("Spec/description (supports markdown)"),
      state: z.string().optional().describe(`Initial state (default: brainstorming)`),
      priority: z.string().optional().describe(`Priority (default: none)`),
      assignee: z.string().optional().describe("Assignee name"),
      labels: z.array(z.string()).optional().describe("Labels/tags"),
      requires_code: z.boolean().optional().describe("Whether this item requires code changes"),
      bot_dispatch: z.boolean().optional().describe("Whether to dispatch this item to the bot for processing"),
      platform: z.enum(["any", "server", "ios", "web"]).optional().describe("Target platform"),
      date_due: z.string().optional().describe("Due date in YYYY-MM-DD format (optional)"),
      link: z.string().optional().describe("Optional URL link associated with this item"),
      space_type: z.string().optional().describe('Space type for specialized UI (e.g. "standard", "song", "engagement", "scheduled"). Default: "standard"'),
      space_data: z.string().optional().describe('JSON string for space-specific custom fields. For scheduled tasks, prefer the dedicated tracker_add_scheduled_todo/tracker_remove_scheduled_todo tools. For engagement items, prefer the dedicated tracker_update_engagement_contact/tracker_update_engagement_quote/tracker_add_engagement_milestone/tracker_add_engagement_comms tools — they handle the GET-parse-modify-save cycle automatically.'),
      created_by: z.string().optional().describe("Ignored — MCP items are always attributed to Harmoni for security (TRACK-213)"),
      blocked_by: z.array(z.string()).optional().describe('Item IDs or display keys (e.g. "TRACK-5") that block this item. The blocked item cannot be worked on until all blockers are done/testing/cancelled.'),
    },
    async (args) => {
      const project = getProject(args.project_id);
      if (!project) return { content: [{ type: "text", text: "Error: Project not found" }] };
      // Security: MCP requests always originate from agents (never from a verified
      // human source). Force created_by = "Harmoni" so that passing a human actor name
      // (e.g. "dashboard", "Martin") cannot bypass actor classification and gain
      // human-level privileges like auto-approval (TRACK-213).
      const MCP_CREATED_BY = "Harmoni";
      const item = createWorkItem({
        project_id: args.project_id,
        title: args.title,
        description: args.description,
        state: args.state as WorkItemState | undefined,
        priority: args.priority as Priority | undefined,
        assignee: args.assignee,
        labels: args.labels,
        requires_code: args.requires_code === true,
        bot_dispatch: args.bot_dispatch,
        platform: args.platform as Platform | undefined,
        date_due: args.date_due || null,
        link: args.link || null,
        space_type: args.space_type,
        space_data: args.space_data ? sanitizeSpaceData(args.space_data, args.space_type) : null,
        created_by: MCP_CREATED_BY,
      });

      // Add dependencies if blocked_by was specified
      const dependencyErrors: string[] = [];
      if (args.blocked_by && args.blocked_by.length > 0) {
        for (const ref of args.blocked_by) {
          const blocker = getWorkItemByKey(ref) || getWorkItem(ref);
          if (!blocker) {
            dependencyErrors.push(`Blocker not found: "${ref}"`);
            continue;
          }
          try {
            addDependency(item.id, blocker.id);
          } catch (e) {
            dependencyErrors.push(`Failed to add blocker "${ref}": ${e instanceof Error ? e.message : "unknown error"}`);
          }
        }
      }

      const key = getWorkItemKey(item);
      const url = buildItemUrl(key);
      const dependencies = getDependencies(item.id).map((dep) => ({ ...dep, key: getWorkItemKey(dep) }));
      const result: Record<string, unknown> = { ...item, key, url, dependencies };
      if (dependencyErrors.length > 0) {
        result.dependency_errors = dependencyErrors;
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "tracker_get_item",
    'Get a work item with comments, transitions, and dependencies. Accepts item ID or display key like "LIZ-3".',
    { item_id: z.string().describe('Work item ID or display key (e.g. "LIZ-3")') },
    async (args) => {
      const item = getWorkItemByKey(args.item_id) || getWorkItem(args.item_id);
      if (!item) return { content: [{ type: "text", text: "Error: Work item not found" }] };
      const key = getWorkItemKey(item);
      const comments = listComments(item.id);
      const transitions = listTransitions(item.id);
      const attachments = listAttachments(item.id);
      const dependencies = getDependencies(item.id).map((dep) => ({
        id: dep.id, key: getWorkItemKey(dep), title: dep.title, state: dep.state,
      }));
      const dependents = getDependents(item.id).map((dep) => ({
        id: dep.id, key: getWorkItemKey(dep), title: dep.title, state: dep.state,
      }));
      const blocked = isBlocked(item.id);
      const url = buildItemUrl(key);
      return { content: [{ type: "text", text: JSON.stringify({ ...item, key, url, blocked, dependencies, dependents, comments, transitions, attachments }, null, 2) }] };
    },
  );

  server.tool(
    "tracker_list_items",
    "List work items with optional filters.",
    {
      project_id: z.string().optional().describe("Filter by project ID"),
      state: z.string().optional().describe("Filter by state"),
      assignee: z.string().optional().describe("Filter by assignee"),
      priority: z.string().optional().describe("Filter by priority"),
      search: z.string().optional().describe("Search in title and description"),
    },
    async (args) => {
      const filters: WorkItemFilters = {};
      if (args.project_id) filters.project_id = args.project_id;
      if (args.state) filters.state = args.state as WorkItemState;
      if (args.assignee) filters.assignee = args.assignee;
      if (args.priority) filters.priority = args.priority as Priority;
      if (args.search) filters.search = args.search;
      const items = listWorkItems(filters);
      if (items.length === 0)
        return { content: [{ type: "text", text: "No work items found matching filters." }] };
      const summary = items.map((i) => {
        const key = getWorkItemKey(i);
        return {
          id: i.id, key, url: buildItemUrl(key), title: i.title, state: i.state,
          priority: i.priority, assignee: i.assignee, date_due: i.date_due, updated_at: i.updated_at,
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    },
  );

  server.tool(
    "tracker_update_item",
    "Update a work item (title, description, priority, assignee, labels, requires_code, platform)",
    {
      item_id: z.string().describe("Work item ID or display key (e.g. \"WRITING-28\")"),
      title: z.string().optional().describe("New title"),
      description: z.string().optional().describe("New description"),
      priority: z.string().optional().describe("New priority"),
      assignee: z.string().optional().describe("New assignee (empty to unassign)"),
      requires_code: z.boolean().optional().describe("Whether this item requires code changes"),
      bot_dispatch: z.boolean().optional().describe("Whether to dispatch this item to the bot for processing"),
      platform: z.enum(["any", "server", "ios", "web"]).optional().describe("Target platform"),
      date_due: z.string().optional().describe("Due date in YYYY-MM-DD format. Pass empty string to clear."),
      link: z.string().optional().describe("Optional URL link associated with this item. Pass empty string to clear."),
      space_type: z.string().optional().describe('Space type for specialized UI (e.g. "standard", "song", "engagement", "scheduled")'),
      space_data: z.string().optional().describe('JSON string for space-specific custom fields. For scheduled tasks, prefer the dedicated tracker_add_scheduled_todo/tracker_remove_scheduled_todo tools. For engagement items, prefer the dedicated tracker_update_engagement_contact/tracker_update_engagement_quote/tracker_add_engagement_milestone/tracker_add_engagement_comms tools — they handle the GET-parse-modify-save cycle automatically.'),
      actor: z.string().optional().describe("Who made this change"),
    },
    async (args) => {
      const itemId = resolveId(args.item_id);
      // Sanitize space_data for scheduled tasks to prevent [object Object] in todo/ignore
      let sanitizedSpaceData: string | null | undefined = undefined;
      if (args.space_data !== undefined) {
        if (args.space_data) {
          const existingItem = getWorkItem(itemId);
          const effectiveSpaceType = args.space_type || existingItem?.space_type;
          sanitizedSpaceData = sanitizeSpaceData(args.space_data, effectiveSpaceType);
        } else {
          sanitizedSpaceData = null;
        }
      }
      const item = updateWorkItem(itemId, {
        title: args.title,
        description: args.description,
        priority: args.priority as Priority | undefined,
        assignee: args.assignee,
        requires_code: args.requires_code !== undefined ? (args.requires_code as unknown as number) : undefined,
        bot_dispatch: args.bot_dispatch !== undefined ? (args.bot_dispatch as unknown as number) : undefined,
        platform: args.platform && VALID_PLATFORMS.includes(args.platform as Platform) ? (args.platform as Platform) : undefined,
        date_due: args.date_due !== undefined ? (args.date_due || null) : undefined,
        link: args.link !== undefined ? (args.link || null) : undefined,
        space_type: args.space_type,
        space_data: sanitizedSpaceData,
        actor: args.actor,
      });
      if (!item) return { content: [{ type: "text", text: "Error: Work item not found" }] };
      const key = getWorkItemKey(item);
      return { content: [{ type: "text", text: JSON.stringify({ ...item, key, url: buildItemUrl(key) }, null, 2) }] };
    },
  );

  server.tool(
    "tracker_move_item",
    "Move a work item to a different project. Allocates a new sequence number and resets space_type if not available on the target project.",
    {
      item_id: z.string().describe("Work item ID or display key (e.g. \"TRACK-5\")"),
      target_project_id: z.string().describe("Target project ID to move the item to"),
      actor: z.string().optional().describe("Who is making this change"),
    },
    async (args) => {
      // Resolve display key to ID if needed
      let itemId = args.item_id;
      if (itemId.includes("-")) {
        const resolved = getWorkItemByKey(itemId);
        if (resolved) itemId = resolved.id;
      }
      const targetProject = getProject(args.target_project_id);
      if (!targetProject) return { content: [{ type: "text", text: "Error: Target project not found" }] };
      const item = moveWorkItem(itemId, args.target_project_id, args.actor);
      if (!item) return { content: [{ type: "text", text: "Error: Work item not found" }] };
      const key = getWorkItemKey(item);
      return { content: [{ type: "text", text: JSON.stringify({ ...item, key, url: buildItemUrl(key) }, null, 2) }] };
    },
  );

  server.tool(
    "tracker_change_state",
    `Change the state of a work item. Records a transition in the audit trail. Note: only human actors (dashboard) can move items to 'approved' or 'cancelled' state.`,
    {
      item_id: z.string().describe("Work item ID or display key (e.g. \"WRITING-28\")"),
      state: z.string().describe(`New state: ${VALID_STATES.join(", ")}`),
      actor: z.string().optional().describe("Who is making this change"),
      comment: z.string().optional().describe("Optional comment about why"),
    },
    async (args) => {
      if (!VALID_STATES.includes(args.state as WorkItemState)) {
        return { content: [{ type: "text", text: `Error: Invalid state. Valid: ${VALID_STATES.join(", ")}` }] };
      }
      try {
        // Security: MCP requests always originate from agents (never from a verified
        // human source). Force actor_class = "agent" so that passing a human actor name
        // cannot bypass the approved/cancelled guard (LIZ-57).
        const MCP_ACTOR_CLASS: ActorClass = "agent";
        const itemId = resolveId(args.item_id);
        const item = changeWorkItemState(itemId, args.state as WorkItemState, args.actor || "Coder", args.comment, MCP_ACTOR_CLASS);
        if (!item) return { content: [{ type: "text", text: "Error: Work item not found" }] };
        const key = getWorkItemKey(item);
        return { content: [{ type: "text", text: JSON.stringify({ ...item, key, url: buildItemUrl(key) }, null, 2) }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "State change rejected";
        return { content: [{ type: "text", text: `Error: ${msg}` }] };
      }
    },
  );

  // ── Comments ──

  server.tool(
    "tracker_add_comment",
    "Add a comment to a work item.",
    {
      item_id: z.string().describe("Work item ID or display key (e.g. \"WRITING-28\")"),
      author: z.string().optional().describe("Comment author"),
      body: z.string().describe("Comment text (supports markdown)"),
    },
    async (args) => {
      const item = resolveItem(args.item_id);
      if (!item) return { content: [{ type: "text", text: "Error: Work item not found" }] };
      try {
        const comment = createComment({ work_item_id: item.id, author: args.author || "Coder", body: args.body });
        return { content: [{ type: "text", text: JSON.stringify(comment, null, 2) }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("Comment blocked")) return { content: [{ type: "text", text: `Error: ${msg}` }] };
        throw e;
      }
    },
  );

  // ── Watchers ──

  server.tool(
    "tracker_watch_item",
    "Watch a work item for changes.",
    {
      item_id: z.string().describe("Work item ID or display key (e.g. \"WRITING-28\")"),
      entity: z.string().describe("Who should watch"),
      notify_via: z.string().optional().describe("Notification method"),
    },
    async (args) => {
      const itemId = resolveId(args.item_id);
      const watcher = addWatcher({ work_item_id: itemId, entity: args.entity, notify_via: args.notify_via });
      return { content: [{ type: "text", text: JSON.stringify(watcher, null, 2) }] };
    },
  );

  // ── Board View ──

  server.tool(
    "tracker_view",
    "Get a kanban-style tracker view of a project.",
    { project_id: z.string().describe("Project ID") },
    async (args) => {
      const project = getProject(args.project_id);
      if (!project) return { content: [{ type: "text", text: "Error: Project not found" }] };
      const items = listWorkItems({ project_id: args.project_id });
      const lines: string[] = [`# ${project.name} [${project.short_name}]`, ""];
      for (const state of VALID_STATES) {
        const stateItems = items.filter((i) => i.state === state);
        if (stateItems.length === 0) continue;
        lines.push(`## ${state.replace(/_/g, " ").toUpperCase()} (${stateItems.length})`);
        for (const item of stateItems) {
          const key = `${project.short_name}-${item.seq_number}`;
          const priority = item.priority !== "none" ? ` [${item.priority}]` : "";
          const assignee = item.assignee ? ` → ${item.assignee}` : "";
          const lock = item.locked_by ? ` 🔒${item.locked_by}` : "";
          const blocked = isBlocked(item.id) ? " ⛔BLOCKED" : "";
          const code = item.requires_code ? " 💻" : "";
          const plat = item.platform && item.platform !== "any" ? ` 🖥️${item.platform}` : "";
          const due = item.date_due ? ` 📅${item.date_due}` : "";
          lines.push(`  - [${key}] ${item.title}${priority}${assignee}${lock}${blocked}${code}${plat}${due}`);
        }
        lines.push("");
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ── Locking ──

  server.tool(
    "tracker_lock_item",
    "Lock a work item to signal you are actively working on it. Locks auto-expire after 2 hours.",
    {
      item_id: z.string().describe("Work item ID or display key (e.g. \"WRITING-28\")"),
      agent: z.string().describe("Agent name"),
    },
    async (args) => {
      const itemId = resolveId(args.item_id);
      const item = lockWorkItem(itemId, args.agent);
      if (!item) return { content: [{ type: "text", text: "Error: Work item not found" }] };
      const key = getWorkItemKey(item);
      return { content: [{ type: "text", text: JSON.stringify({ ...item, key, url: buildItemUrl(key) }, null, 2) }] };
    },
  );

  server.tool(
    "tracker_unlock_item",
    "Unlock a work item when done working or handing off.",
    { item_id: z.string().describe("Work item ID or display key (e.g. \"WRITING-28\")") },
    async (args) => {
      const itemId = resolveId(args.item_id);
      const item = unlockWorkItem(itemId);
      if (!item) return { content: [{ type: "text", text: "Error: Work item not found" }] };
      const key = getWorkItemKey(item);
      return { content: [{ type: "text", text: JSON.stringify({ ...item, key, url: buildItemUrl(key) }, null, 2) }] };
    },
  );

  server.tool(
    "tracker_clear_stale_locks",
    "Clear locks older than the threshold (default 2 hours).",
    { max_age_hours: z.number().optional().describe("Max lock age in hours (default: 2)") },
    async (args) => {
      const maxAgeMs = args.max_age_hours ? args.max_age_hours * 60 * 60 * 1000 : undefined;
      const cleared = clearStaleLocks(maxAgeMs);
      if (cleared.length === 0) return { content: [{ type: "text", text: "No stale locks found." }] };
      const msg = `Cleared ${cleared.length} stale lock(s):\n` +
        cleared.map((i) => `  - "${i.title}" (was locked by ${i.locked_by})`).join("\n");
      return { content: [{ type: "text", text: msg }] };
    },
  );

  // ── Dependencies ──

  server.tool(
    "tracker_add_dependency",
    "Add a dependency: the item is blocked by another item. Use this to create chains of work where one issue must be completed before another can start. A blocked item won't be dispatched for implementation until all its blockers reach done/testing/cancelled state.",
    {
      work_item_id: z.string().describe("The item that is blocked (ID or display key e.g. \"WRITING-28\")"),
      depends_on_id: z.string().describe("The item that must be completed first (ID or display key e.g. \"WRITING-28\")"),
    },
    async (args) => {
      try {
        const workItemId = resolveId(args.work_item_id);
        const dependsOnId = resolveId(args.depends_on_id);
        const dep = addDependency(workItemId, dependsOnId);
        return { content: [{ type: "text", text: JSON.stringify(dep, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : "Failed"}` }] };
      }
    },
  );

  server.tool(
    "tracker_remove_dependency",
    "Remove a dependency between two items.",
    {
      work_item_id: z.string().describe("The item that was blocked (ID or display key e.g. \"WRITING-28\")"),
      depends_on_id: z.string().describe("The item it depended on (ID or display key e.g. \"WRITING-28\")"),
    },
    async (args) => {
      const workItemId = resolveId(args.work_item_id);
      const dependsOnId = resolveId(args.depends_on_id);
      const ok = removeDependency(workItemId, dependsOnId);
      return { content: [{ type: "text", text: ok ? "Dependency removed." : "Error: Dependency not found." }] };
    },
  );

  server.tool(
    "tracker_get_blockers",
    "Get unfinished blockers for an item. Returns items that must reach done/testing/cancelled before this item can be worked on.",
    { item_id: z.string().describe("Work item ID or display key (e.g. \"WRITING-28\")") },
    async (args) => {
      const itemId = resolveId(args.item_id);
      const blockerList = getBlockers(itemId);
      if (blockerList.length === 0) return { content: [{ type: "text", text: "No blockers — item is unblocked." }] };
      const msg = `Blocked by ${blockerList.length} item(s):\n` +
        blockerList.map((b) => {
          const bKey = getWorkItemKey(b);
          return `  - [${bKey}] "${b.title}" [${b.state}] (${b.id})`;
        }).join("\n");
      return { content: [{ type: "text", text: msg }] };
    },
  );

  // ── Attachments ──

  server.tool(
    "tracker_upload_attachment",
    `Upload a file attachment to a work item. Accepts base64-encoded file data. Max size: ${Math.round(MAX_ATTACHMENT_SIZE / 1024 / 1024)}MB.`,
    {
      item_id: z.string().describe("Work item ID"),
      filename: z.string().describe("Original filename (e.g. screenshot.png)"),
      data: z.string().describe("Base64-encoded file content"),
      mime_type: z.string().optional().describe("MIME type (e.g. image/png). Auto-detected from extension if omitted."),
      uploaded_by: z.string().optional().describe("Who uploaded this (default: Claude)"),
      comment_id: z.string().optional().describe("Optional comment ID to associate with"),
    },
    async (args) => {
      const item = getWorkItemByKey(args.item_id) || getWorkItem(args.item_id);
      if (!item) return { content: [{ type: "text", text: "Error: Work item not found" }] };

      const fileData = Buffer.from(args.data, "base64");
      if (fileData.length > MAX_ATTACHMENT_SIZE) {
        return { content: [{ type: "text", text: `Error: File exceeds maximum size of ${Math.round(MAX_ATTACHMENT_SIZE / 1024 / 1024)}MB` }] };
      }

      // Auto-detect MIME type from extension if not provided
      const mimeType = args.mime_type || detectMimeType(args.filename);

      // Sanitize filename
      const safeFilename = args.filename
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .replace(/^\.+/, "_")
        .substring(0, 200);

      const storagePath = path.join("attachments", item.id, safeFilename);
      const fullPath = path.join(STORE_DIR, storagePath);

      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, fileData);

      const attachment = createAttachment({
        work_item_id: item.id,
        comment_id: args.comment_id,
        filename: args.filename,
        mime_type: mimeType,
        size_bytes: fileData.length,
        storage_path: storagePath,
        uploaded_by: args.uploaded_by || "Coder",
      });

      return {
        content: [{
          type: "text",
          text: `Uploaded "${args.filename}" (${formatBytes(fileData.length)}, ${mimeType}) to ${getWorkItemKey(item)}.\nAttachment ID: ${attachment.id}`,
        }],
      };
    },
  );

  server.tool(
    "tracker_upload_attachment_from_path",
    `Upload a local file to a work item by file path. The file must exist on the tracker server's filesystem. Max size: ${Math.round(MAX_ATTACHMENT_SIZE / 1024 / 1024)}MB. Use this instead of tracker_upload_attachment when the file is already on disk — avoids base64 encoding overhead. Accepts both host paths and container paths (e.g. /workspace/group/...) — container paths are automatically translated to host paths.`,
    {
      item_id: z.string().describe("Work item ID or display key (e.g. \"TRACK-5\")"),
      file_path: z.string().describe("Absolute path to the file on disk or container path (e.g. \"/workspace/group/inbox/file.pdf\" or \"/home/user/project/docs/diagram.png\")"),
      filename: z.string().optional().describe("Override filename for the attachment. Defaults to the basename of file_path."),
      uploaded_by: z.string().optional().describe("Who uploaded this (default: Claude)"),
      comment_id: z.string().optional().describe("Optional comment ID to associate with"),
    },
    async (args) => {
      const item = getWorkItemByKey(args.item_id) || getWorkItem(args.item_id);
      if (!item) return { content: [{ type: "text", text: "Error: Work item not found" }] };

      // Expand leading ~ to the user's home directory (shells expand ~ but Node.js does not)
      const filePath = args.file_path.startsWith("~/")
        ? path.join(os.homedir(), args.file_path.slice(2))
        : args.file_path;

      // Validate file_path is absolute
      if (!path.isAbsolute(filePath)) {
        return { content: [{ type: "text", text: "Error: file_path must be an absolute path" }] };
      }

      // Translate container paths (/workspace/...) to host paths
      let resolvedPath = filePath;
      let wasTranslated = false;
      const translation = translateContainerPath(filePath);
      if (translation) {
        resolvedPath = translation.hostPath;
        wasTranslated = true;
        logger.info({ containerPath: filePath, hostPath: resolvedPath }, "Translated container path to host path");
      }

      if (!fs.existsSync(resolvedPath)) {
        if (wasTranslated) {
          return {
            content: [{
              type: "text",
               text: `Error: File not found after container path translation.\n` +
                `  Container path: ${filePath}\n` +
                `  Resolved to: ${resolvedPath}\n` +
                `  Liz project root: ${ASSISTANT_PROJECT_ROOT}\n\n` +
                `Tip: The path was translated from container namespace to host filesystem. ` +
                `Check that the file exists on the host and that ASSISTANT_PROJECT_ROOT is set correctly.`,
            }],
          };
        }
        return { content: [{ type: "text", text: `Error: File not found: ${filePath}` }] };
      }

      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) {
        return { content: [{ type: "text", text: `Error: Path is not a file: ${resolvedPath}` }] };
      }
      if (stat.size > MAX_ATTACHMENT_SIZE) {
        return { content: [{ type: "text", text: `Error: File exceeds maximum size of ${Math.round(MAX_ATTACHMENT_SIZE / 1024 / 1024)}MB (${formatBytes(stat.size)})` }] };
      }

      const originalFilename = args.filename || path.basename(resolvedPath);
      const mimeType = detectMimeType(originalFilename);
      const safeFilename = originalFilename
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .replace(/^\.+/, "_")
        .substring(0, 200);

      const storagePath = path.join("attachments", item.id, safeFilename);
      const fullPath = path.join(STORE_DIR, storagePath);

      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.copyFileSync(resolvedPath, fullPath);

      const attachment = createAttachment({
        work_item_id: item.id,
        comment_id: args.comment_id,
        filename: originalFilename,
        mime_type: mimeType,
        size_bytes: stat.size,
        storage_path: storagePath,
        uploaded_by: args.uploaded_by || "Coder",
      });

      const translationNote = wasTranslated ? ` (translated from container path: ${filePath})` : "";
      return {
        content: [{
          type: "text",
          text: `Uploaded "${originalFilename}" (${formatBytes(stat.size)}, ${mimeType}) to ${getWorkItemKey(item)}.${translationNote}\nAttachment ID: ${attachment.id}`,
        }],
      };
    },
  );

  server.tool(
    "tracker_list_attachments",
    "List all file attachments on a work item.",
    {
      item_id: z.string().describe("Work item ID or display key"),
    },
    async (args) => {
      const item = getWorkItemByKey(args.item_id) || getWorkItem(args.item_id);
      if (!item) return { content: [{ type: "text", text: "Error: Work item not found" }] };

      const attachments = listAttachments(item.id);
      if (attachments.length === 0) {
        return { content: [{ type: "text", text: "No attachments on this item." }] };
      }

      const lines = attachments.map((a) =>
        `- ${a.filename} (${formatBytes(a.size_bytes)}, ${a.mime_type}) — uploaded by ${a.uploaded_by} at ${a.created_at} [id: ${a.id}]`
      );
      return { content: [{ type: "text", text: `${attachments.length} attachment(s):\n${lines.join("\n")}` }] };
    },
  );

  server.tool(
    "tracker_delete_attachment",
    "Delete a file attachment from a work item.",
    {
      attachment_id: z.string().describe("Attachment ID to delete"),
    },
    async (args) => {
      const attachment = deleteAttachment(args.attachment_id);
      if (!attachment) return { content: [{ type: "text", text: "Error: Attachment not found" }] };

      // Delete file from disk
      const fullPath = path.join(STORE_DIR, attachment.storage_path);
      try {
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      } catch {
        // File already gone
      }

      return { content: [{ type: "text", text: `Deleted attachment "${attachment.filename}"` }] };
    },
  );

  // ── Orchestrator ──

  server.tool(
    "tracker_dispatch_item",
    "Manually dispatch a work item to OpenCode for implementation. Item must be approved, have bot_dispatch enabled, not be locked/blocked, and its project must have a working_directory set.",
    { item_id: z.string().describe("Work item ID or display key (e.g. \"WRITING-28\")") },
    async (args) => {
      const itemId = resolveId(args.item_id);
      const result = await dispatchItem(itemId);
      if ("error" in result) {
        return { content: [{ type: "text", text: `Error: ${result.error}` }] };
      }
      return {
        content: [
          {
            type: "text",
            text: `Dispatched to OpenCode session ${result.sessionId}. View at ${result.opencodeUrl}`,
          },
        ],
      };
    },
  );

  server.tool(
    "tracker_get_session_status",
    "Get the OpenCode session status for a work item.",
    { item_id: z.string().describe("Work item ID or display key") },
    async (args) => {
      const item = getWorkItemByKey(args.item_id) || getWorkItem(args.item_id);
      if (!item) return { content: [{ type: "text", text: "Error: Work item not found" }] };
      if (!item.session_id) {
        return { content: [{ type: "text", text: "No OpenCode session associated with this item." }] };
      }
      const project = getProject(item.project_id);
      const url = project?.working_directory
        ? buildOpencodeSessionUrl(item.session_id, project.working_directory)
        : `${OPENCODE_PUBLIC_URL}/${item.session_id}`;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                session_id: item.session_id,
                session_status: item.session_status,
                opencode_url: url,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "tracker_abort_session",
    "Abort the active OpenCode session for a work item. Use this when a session is stalled or stuck. The item will be unlocked and a comment added.",
    {
      item_id: z.string().describe("Work item ID or display key"),
      reason: z
        .string()
        .optional()
        .describe("Reason for aborting (shown in comment)"),
    },
    async (args) => {
      const item =
        getWorkItemByKey(args.item_id) || getWorkItem(args.item_id);
      if (!item)
        return {
          content: [{ type: "text", text: "Error: Work item not found" }],
        };
      if (!item.session_id)
        return {
          content: [
            {
              type: "text",
              text: "No active session for this item.",
            },
          ],
        };
      const reason = args.reason || "Manually aborted via MCP tool";
      const aborted = await abortSession(item.session_id, reason);
      if (!aborted) {
        return {
          content: [
            {
              type: "text",
              text: "Session not found in active sessions (may already be completed).",
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Aborted session ${item.session_id}. Item unlocked and comment added.`,
          },
        ],
      };
    },
  );

  server.tool(
    "tracker_orchestrator_status",
    "Get the current orchestrator status (enabled, paused, active sessions).",
    {},
    async () => {
      const status = getOrchestratorStatus();
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    },
  );

  // Section 4.7.1: Emergency stop
  server.tool(
    "tracker_emergency_stop",
    "EMERGENCY STOP: Immediately pause the orchestrator and abort ALL active coder sessions. Use when a session appears compromised or malicious.",
    {
      reason: z.string().optional().describe("Reason for the emergency stop"),
    },
    async (args) => {
      const reason = args.reason || "Emergency stop via MCP tool";
      const aborted = await emergencyStop(reason);
      return {
        content: [
          {
            type: "text",
            text: `🛑 Emergency stop complete. ${aborted} session(s) aborted. Orchestrator paused.\nResume with tracker_orchestrator_status or the dashboard.`,
          },
        ],
      };
    },
  );

  // ── Safe Restart ──

  server.tool(
    "tracker_safe_restart",
    "Safely restart the tracker service without interrupting active agent sessions. Pauses the orchestrator, waits for active sessions to complete, then restarts via launchctl. Use this instead of manual launchctl commands when other agents might be working.",
    {
      reason: z.string().optional().describe("Reason for the restart (e.g. 'deployed code changes')"),
      force: z.boolean().optional().describe("Force restart immediately even if sessions are active (default: false)"),
      wait: z.boolean().optional().describe("Wait for active sessions to complete before restarting (default: true)"),
      requested_by: z.string().optional().describe("Who is requesting the restart"),
    },
    async (args) => {
      const result = requestSafeRestart({
        requestedBy: args.requested_by || "mcp",
        reason: args.reason || "Restart requested via MCP tool",
        force: args.force || false,
        wait: args.wait !== false,
      });

      const icon = result.status === "restarting" ? "🔄" :
                   result.status === "waiting" ? "⏳" :
                   result.status === "already_pending" ? "⚠️" : "❌";

      return {
        content: [
          {
            type: "text",
            text: `${icon} ${result.message}\n\nActive sessions: ${result.activeSessions}\nStatus: ${result.status}`,
          },
        ],
      };
    },
  );

  server.tool(
    "tracker_restart_status",
    "Check the current restart status: whether a restart is pending, waiting for sessions, or if it's safe to restart now.",
    {},
    async () => {
      const status = getRestartStatus();
      const safeIcon = status.safe ? "✅" : "⚠️";

      let text = `Safe to restart: ${safeIcon} ${status.safe ? "Yes" : "No"}\n`;
      text += `Active sessions: ${status.activeSessions}\n`;
      if (status.pending) {
        text += `\nRestart pending:\n`;
        text += `  Status: ${status.status}\n`;
        text += `  Requested by: ${status.requestedBy}\n`;
        text += `  Requested at: ${status.requestedAt}\n`;
        text += `  Reason: ${status.reason}`;
      }

      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "tracker_cancel_restart",
    "Cancel a pending safe restart request. The orchestrator will be resumed if it was paused for the restart.",
    {},
    async () => {
      const cancelled = cancelRestart();
      if (!cancelled) {
        return { content: [{ type: "text", text: "No pending restart to cancel." }] };
      }
      return { content: [{ type: "text", text: "✅ Restart cancelled. Orchestrator resumed." }] };
    },
  );

  // ── Agent Validation ──

  server.tool(
    "tracker_validate_agent_config",
    "Check that the tracker-worker agent configuration file exists and is valid. Returns the agent file path, validation status, and any errors. Use this to diagnose dispatch failures caused by agent misconfiguration.",
    {},
    async () => {
      const result = validateAgentConfig();
      const icon = result.valid ? "✅" : "❌";
      let text = `${icon} Agent config validation: ${result.valid ? "PASSED" : "FAILED"}\n`;
      text += `Agent path: ${result.agentPath}\n`;
      if (result.valid) {
        text += `File size: ${result.sizeBytes} bytes`;
      } else {
        text += `Error: ${result.error}`;
      }
      return { content: [{ type: "text", text }] };
    },
  );

  // ── Dynamic Space Plugin Tool Registration ──
  // Each space plugin defines its own MCP tools in its mcpTools array.
  // This loop replaces ~765 lines of hardcoded tool registrations for
  // scheduled, engagement, and cover image tools.
  for (const plugin of listSpacePlugins()) {
    if (!plugin.mcpTools) continue;
    for (const tool of plugin.mcpTools) {
      server.tool(tool.name, tool.description, tool.schema, async (args: Record<string, unknown>) => {
        const item = resolveItem(args.item_id as string);
        if (!item) return { content: [{ type: "text", text: "Error: Work item not found" }] };
        if (item.space_type !== plugin.name) {
          return { content: [{ type: "text", text: `Error: Item ${getWorkItemKey(item)} is not a ${plugin.label} (space_type="${item.space_type}"). This tool only works on ${plugin.label.toLowerCase()} items.` }] };
        }
        return tool.handler(args, item, plugin);
      });
    }
  }

  // ── Cover Image Tools ──
  // These are cross-cutting tools shared by all spaces with coverImage capability.
  // They use getCoverSpaceTypes() from the registry instead of a hardcoded list.

  const COVER_FILENAME_RE = /^cover\.(png|jpg|jpeg|webp)$/i;

  function deleteExistingCovers(itemId: string): number {
    const attachments = listAttachments(itemId);
    let deleted = 0;
    for (const att of attachments) {
      if (COVER_FILENAME_RE.test(att.filename)) {
        deleteAttachment(att.id);
        const fullPath = path.join(STORE_DIR, att.storage_path);
        try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch { /* ignore */ }
        deleted++;
      }
    }
    return deleted;
  }

  server.tool(
    "tracker_set_cover_image",
    "Set or replace the cover image on a song or engagement space item. Accepts base64-encoded image data. Automatically removes any existing cover image before uploading the new one.",
    {
      item_id: z.string().describe("Work item ID or display key (e.g. \"MUSIC-3\")"),
      data: z.string().describe("Base64-encoded image file content"),
      filename: z.string().optional().describe("Original filename (e.g. \"cover.jpg\"). Used to determine image format. Defaults to \"cover.jpg\"."),
      uploaded_by: z.string().optional().describe("Who uploaded this (default: Claude)"),
    },
    async (args) => {
      const item = resolveItem(args.item_id);
      if (!item) return { content: [{ type: "text", text: "Error: Work item not found" }] };
      const coverTypes = getCoverSpaceTypes();
      if (!coverTypes.includes(item.space_type)) {
        return { content: [{ type: "text", text: `Error: Item ${getWorkItemKey(item)} has space_type="${item.space_type}". Cover images are only supported on: ${coverTypes.join(", ")}.` }] };
      }

      const fileData = Buffer.from(args.data, "base64");
      if (fileData.length > MAX_ATTACHMENT_SIZE) {
        return { content: [{ type: "text", text: `Error: File exceeds maximum size of ${Math.round(MAX_ATTACHMENT_SIZE / 1024 / 1024)}MB` }] };
      }

      const sourceFilename = args.filename || "cover.jpg";
      const ext = path.extname(sourceFilename).toLowerCase().replace(".", "");
      const validExts = ["png", "jpg", "jpeg", "webp"];
      const finalExt = validExts.includes(ext) ? ext : "jpg";
      const coverFilename = `cover.${finalExt}`;
      const mimeType = detectMimeType(coverFilename);

      const deletedCount = deleteExistingCovers(item.id);

      const storagePath = path.join("attachments", item.id, coverFilename);
      const fullPath = path.join(STORE_DIR, storagePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, fileData);

      const attachment = createAttachment({
        work_item_id: item.id,
        filename: coverFilename,
        mime_type: mimeType,
        size_bytes: fileData.length,
        storage_path: storagePath,
        uploaded_by: args.uploaded_by || "Coder",
      });

      const replacedNote = deletedCount > 0 ? ` (replaced ${deletedCount} existing cover)` : "";
      return {
        content: [{
          type: "text",
          text: `Set cover image on ${getWorkItemKey(item)}${replacedNote}.\nFilename: ${coverFilename} (${formatBytes(fileData.length)}, ${mimeType})\nAttachment ID: ${attachment.id}`,
        }],
      };
    },
  );

  server.tool(
    "tracker_set_cover_image_from_path",
    "Set or replace the cover image on a song or engagement space item from a local file path. Automatically removes any existing cover image before uploading the new one.",
    {
      item_id: z.string().describe("Work item ID or display key (e.g. \"MUSIC-3\")"),
      file_path: z.string().describe("Absolute path to the image file on disk"),
      uploaded_by: z.string().optional().describe("Who uploaded this (default: Claude)"),
    },
    async (args) => {
      const item = resolveItem(args.item_id);
      if (!item) return { content: [{ type: "text", text: "Error: Work item not found" }] };
      const coverTypes = getCoverSpaceTypes();
      if (!coverTypes.includes(item.space_type)) {
        return { content: [{ type: "text", text: `Error: Item ${getWorkItemKey(item)} has space_type="${item.space_type}". Cover images are only supported on: ${coverTypes.join(", ")}.` }] };
      }

      let filePath = args.file_path.startsWith("~/")
        ? path.join(os.homedir(), args.file_path.slice(2))
        : args.file_path;

      if (!path.isAbsolute(filePath)) {
        return { content: [{ type: "text", text: "Error: file_path must be an absolute path" }] };
      }

      let resolvedPath = filePath;
      let wasTranslated = false;
      const translation = translateContainerPath(filePath);
      if (translation) {
        resolvedPath = translation.hostPath;
        wasTranslated = true;
      }

      if (!fs.existsSync(resolvedPath)) {
        const note = wasTranslated ? ` (translated from container path: ${filePath})` : "";
        return { content: [{ type: "text", text: `Error: File not found: ${resolvedPath}${note}` }] };
      }

      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) {
        return { content: [{ type: "text", text: `Error: Path is not a file: ${resolvedPath}` }] };
      }
      if (stat.size > MAX_ATTACHMENT_SIZE) {
        return { content: [{ type: "text", text: `Error: File exceeds maximum size of ${Math.round(MAX_ATTACHMENT_SIZE / 1024 / 1024)}MB (${formatBytes(stat.size)})` }] };
      }

      const ext = path.extname(resolvedPath).toLowerCase().replace(".", "");
      const validExts = ["png", "jpg", "jpeg", "webp"];
      const finalExt = validExts.includes(ext) ? ext : "jpg";
      const coverFilename = `cover.${finalExt}`;
      const mimeType = detectMimeType(coverFilename);

      const deletedCount = deleteExistingCovers(item.id);

      const storagePath = path.join("attachments", item.id, coverFilename);
      const fullPath = path.join(STORE_DIR, storagePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.copyFileSync(resolvedPath, fullPath);

      const attachment = createAttachment({
        work_item_id: item.id,
        filename: coverFilename,
        mime_type: mimeType,
        size_bytes: stat.size,
        storage_path: storagePath,
        uploaded_by: args.uploaded_by || "Coder",
      });

      const replacedNote = deletedCount > 0 ? ` (replaced ${deletedCount} existing cover)` : "";
      const translationNote = wasTranslated ? ` (translated from container path: ${args.file_path})` : "";
      return {
        content: [{
          type: "text",
          text: `Set cover image on ${getWorkItemKey(item)}${replacedNote}.\nFilename: ${coverFilename} (${formatBytes(stat.size)}, ${mimeType})\nAttachment ID: ${attachment.id}${translationNote}`,
        }],
      };
    },
  );

  server.tool(
    "tracker_remove_cover_image",
    "Remove the cover image from a song or engagement space item.",
    {
      item_id: z.string().describe("Work item ID or display key (e.g. \"MUSIC-3\")"),
    },
    async (args) => {
      const item = resolveItem(args.item_id);
      if (!item) return { content: [{ type: "text", text: "Error: Work item not found" }] };
      const coverTypes = getCoverSpaceTypes();
      if (!coverTypes.includes(item.space_type)) {
        return { content: [{ type: "text", text: `Error: Item ${getWorkItemKey(item)} has space_type="${item.space_type}". Cover images are only supported on: ${coverTypes.join(", ")}.` }] };
      }

      const deletedCount = deleteExistingCovers(item.id);
      if (deletedCount === 0) {
        return { content: [{ type: "text", text: `No cover image found on ${getWorkItemKey(item)}.` }] };
      }

      return {
        content: [{
          type: "text",
          text: `Removed cover image from ${getWorkItemKey(item)} (${deletedCount} attachment(s) deleted).`,
        }],
      };
    },
  );

  return server;
}

/**
 * Attach the MCP Streamable HTTP endpoint to an existing HTTP server.
 * Handles POST /mcp, GET /mcp, DELETE /mcp.
 *
 * Stateless mode: each request gets a fresh McpServer + transport pair
 * because McpServer.connect() can only be called once per instance.
 */
export function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  });

  server.connect(transport).then(() => {
    transport.handleRequest(req, res);
  }).catch((err) => {
    logger.error({ err }, "MCP transport error");
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "MCP server error" }));
    }
  });
}
