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
  addLink,
  removeLink,
  listLinks,
  VALID_LINK_RELATIONS,
  getChildItems,
  getParentItem,
  createGroupFromItems,
  mergeItems,
  splitItem,
  bulkUpdate,
  createProposal,
  listProposals,
  getProposal,
  getProposalActions,
  applyProposal,
  getProposalStats,
  VALID_PROPOSAL_ACTION_KINDS,
  type ProposalActionKind,
  createComment,
  listComments,
  toggleReaction,
  listTransitions,
  addWatcher,
  getProjectStats,
  createAttachment,
  getAttachment,
  listAttachments,
  deleteAttachment,
  listActivity,
  getNeighbours,
  getDriftScore,
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

/** Normalize runner session IDs (e.g. "runner_mmyp5r1d_2uppg1") to "Coder" for display. */
function normalizeRunnerActor(name: string): string {
  return /^runner_/i.test(name) ? "Coder" : name;
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

// ── MCP Schema Coercion Helpers (TRACK-287) ──
// LLM clients sometimes serialize array/boolean params as strings (e.g.
// labels="bug,urgent" or requires_code="true"). These preprocessors coerce
// those common mis-types into the expected type so the call doesn't fail with
// a validation error on the first attempt.

/** String → boolean coercion: "true"/"1"/"yes" → true, "false"/"0"/"no" → false. */
export function coerceBoolean(val: unknown): unknown {
  if (typeof val !== "string") return val;
  const trimmed = val.trim().toLowerCase();
  if (trimmed === "true" || trimmed === "1" || trimmed === "yes") return true;
  if (trimmed === "false" || trimmed === "0" || trimmed === "no") return false;
  return val;
}

/** String → string[] coercion: JSON array string or comma-separated string. */
export function coerceStringArray(val: unknown): unknown {
  if (typeof val !== "string") return val;
  const trimmed = val.trim();
  if (trimmed === "") return [];
  // Try JSON parse for array-shaped strings: '["a","b"]'
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    } catch {
      // fall through to comma-split
    }
  }
  // Comma-separated: "bug, urgent" → ["bug", "urgent"]
  return trimmed.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Tolerant boolean schema for MCP tool inputs. */
const lenientBoolean = () => z.preprocess(coerceBoolean, z.boolean());
/** Tolerant string-array schema for MCP tool inputs. */
const lenientStringArray = () => z.preprocess(coerceStringArray, z.array(z.string()));

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
      labels: lenientStringArray().optional().describe('Labels/tags as an ARRAY of strings, e.g. ["bug", "urgent"]. A comma-separated string ("bug, urgent") or JSON array string is also accepted.'),
      requires_code: lenientBoolean().optional().describe('Whether this item requires code changes. Must be a BOOLEAN (true or false), not a string. Strings "true"/"false"/"1"/"0" are also accepted.'),
      bot_dispatch: lenientBoolean().optional().describe('Whether to dispatch this item to the bot for processing. Must be a BOOLEAN (true or false), not a string. Strings "true"/"false"/"1"/"0" are also accepted.'),
      platform: z.enum(["any", "server", "ios", "web"]).optional().describe("Target platform"),
      date_due: z.string().optional().describe("Due date in YYYY-MM-DD format (optional)"),
      link: z.string().optional().describe("Optional URL link associated with this item"),
      space_type: z.string().optional().describe('Space type for specialized UI (e.g. "standard", "song", "engagement", "scheduled"). Default: "standard"'),
      space_data: z.string().optional().describe('JSON string for space-specific custom fields. For scheduled tasks, prefer the dedicated tracker_add_scheduled_todo/tracker_remove_scheduled_todo tools. For engagement items, prefer the dedicated tracker_update_engagement_contact/tracker_update_engagement_quote/tracker_add_engagement_milestone/tracker_add_engagement_comms tools. For travel items, prefer tracker_update_travel_trip and tracker_add_travel_segment tools — they handle the GET-parse-modify-save cycle automatically and validate segment structure.'),
      created_by: z.string().optional().describe("Ignored — MCP items are always attributed to Harmoni for security (TRACK-213)"),
      blocked_by: lenientStringArray().optional().describe('Item IDs or display keys (e.g. ["TRACK-5", "TRACK-6"]) that block this item, as an ARRAY of strings. The blocked item cannot be worked on until all blockers are done/testing/cancelled.'),
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
    'Get a work item with comments, transitions, and dependencies. REQUIRED: item_id (string). Accepts a work item ID (24-char hex) or display key like "TRACK-287".',
    { item_id: z.string().min(1).describe('REQUIRED. Work item ID (24-char hex) or display key like "TRACK-287". Must be a non-empty string.') },
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
      requires_code: lenientBoolean().optional().describe('Whether this item requires code changes. Must be a BOOLEAN (true or false), not a string. Strings "true"/"false"/"1"/"0" are also accepted.'),
      bot_dispatch: lenientBoolean().optional().describe('Whether to dispatch this item to the bot for processing. Must be a BOOLEAN (true or false), not a string. Strings "true"/"false"/"1"/"0" are also accepted.'),
      platform: z.enum(["any", "server", "ios", "web"]).optional().describe("Target platform"),
      date_due: z.string().optional().describe("Due date in YYYY-MM-DD format. Pass empty string to clear."),
      link: z.string().optional().describe("Optional URL link associated with this item. Pass empty string to clear."),
      space_type: z.string().optional().describe('Space type for specialized UI (e.g. "standard", "song", "engagement", "scheduled")'),
      space_data: z.string().optional().describe('JSON string for space-specific custom fields. For scheduled tasks, prefer the dedicated tracker_add_scheduled_todo/tracker_remove_scheduled_todo tools. For engagement items, prefer the dedicated tracker_update_engagement_contact/tracker_update_engagement_quote/tracker_add_engagement_milestone/tracker_add_engagement_comms tools. For travel items, prefer tracker_update_travel_trip and tracker_add_travel_segment tools — they handle the GET-parse-modify-save cycle automatically and validate segment structure.'),
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
      const item = moveWorkItem(itemId, args.target_project_id, args.actor ? normalizeRunnerActor(args.actor) : args.actor);
      if (!item) return { content: [{ type: "text", text: "Error: Work item not found" }] };
      const key = getWorkItemKey(item);
      return { content: [{ type: "text", text: JSON.stringify({ ...item, key, url: buildItemUrl(key) }, null, 2) }] };
    },
  );

  server.tool(
    "tracker_change_state",
    `Change the state of a work item. Records a transition in the audit trail. REQUIRED: item_id, state. Note: only human actors (dashboard) can move items to 'approved' or 'cancelled' state.`,
    {
      item_id: z.string().min(1).describe("REQUIRED. Work item ID (24-char hex) or display key like \"TRACK-287\". Must be a non-empty string."),
      state: z.string().min(1).describe(`REQUIRED. New state. Must be one of: ${VALID_STATES.join(", ")}. Example: "in_development".`),
      actor: z.string().optional().describe("Who is making this change (e.g. \"Coder\"). Defaults to \"Coder\" if omitted."),
      comment: z.string().optional().describe("Optional comment about why the state is changing"),
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
        const item = changeWorkItemState(itemId, args.state as WorkItemState, normalizeRunnerActor(args.actor || "Coder"), args.comment, MCP_ACTOR_CLASS);
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
        const comment = createComment({ work_item_id: item.id, author: normalizeRunnerActor(args.author || "Harmoni"), body: args.body });
        const key = getWorkItemKey(item);
        return { content: [{ type: "text", text: JSON.stringify({ ...comment, item_key: key, item_url: buildItemUrl(key) }, null, 2) }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("Comment blocked")) return { content: [{ type: "text", text: `Error: ${msg}` }] };
        throw e;
      }
    },
  );

  server.tool(
    "tracker_react_to_comment",
    "Toggle an emoji reaction on a comment. Adds the reaction if not present, removes if already reacted.",
    {
      comment_id: z.string().describe("Comment ID"),
      emoji: z.string().describe("Emoji character (e.g. '\ud83d\udc4d')"),
    },
    async (args) => {
      try {
        const result = toggleReaction(args.comment_id, args.emoji, normalizeRunnerActor("Harmoni"));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `Error: ${msg}` }] };
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
          const url = buildItemUrl(key);
          lines.push(`  - [${key}](${url}) ${item.title}${priority}${assignee}${lock}${blocked}${code}${plat}${due}`);
        }
        lines.push("");
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ── Locking ──

  server.tool(
    "tracker_lock_item",
    "Lock a work item to signal you are actively working on it. Locks auto-expire after 2 hours. REQUIRED: item_id, agent.",
    {
      item_id: z.string().min(1).describe("REQUIRED. Work item ID (24-char hex) or display key like \"TRACK-287\". Must be a non-empty string."),
      agent: z.string().min(1).describe("REQUIRED. Name of the agent acquiring the lock (e.g. \"Coder\"). Must be a non-empty string."),
    },
    async (args) => {
      const itemId = resolveId(args.item_id);
      const item = lockWorkItem(itemId, normalizeRunnerActor(args.agent));
      if (!item) return { content: [{ type: "text", text: "Error: Work item not found" }] };
      const key = getWorkItemKey(item);
      return { content: [{ type: "text", text: JSON.stringify({ ...item, key, url: buildItemUrl(key) }, null, 2) }] };
    },
  );

  server.tool(
    "tracker_unlock_item",
    "Unlock a work item when done working or handing off. REQUIRED: item_id.",
    { item_id: z.string().min(1).describe("REQUIRED. Work item ID (24-char hex) or display key like \"TRACK-287\". Must be a non-empty string.") },
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

  // ── Embeddings (TRACK-283) ──

  server.tool(
    "tracker_find_similar",
    "Find work items semantically similar to a given item using cached embedding neighbours. Returns the top-K precomputed neighbours above the threshold. " +
      "Use this to surface possible duplicates, related items, or topic siblings before opening a new ticket. Pull-only — no notifications are sent.",
    {
      item_id: z.string().describe("Work item ID or display key (e.g. \"TRACK-5\")"),
      threshold: z.number().min(0).max(1).optional().describe("Minimum cosine similarity (default: 0.85)"),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum number of neighbours to return (default: 10)"),
    },
    async (args) => {
      const itemId = resolveId(args.item_id);
      const neighbours = getNeighbours(itemId, {
        threshold: args.threshold ?? 0.85,
        limit: args.limit ?? 10,
      });
      if (neighbours.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                "No similar items found above the threshold. Note: neighbours are precomputed nightly — " +
                "newly created items may not yet have a neighbour set.",
            },
          ],
        };
      }
      const lines = neighbours.map((n) => {
        const item = getWorkItem(n.neighbour_ref);
        if (!item) return `  - (deleted ${n.neighbour_ref}) sim=${n.similarity.toFixed(3)}`;
        const key = getWorkItemKey(item);
        return `  - [${key}] "${item.title}" [${item.state}] sim=${n.similarity.toFixed(3)}`;
      });
      const drift = getDriftScore(itemId);
      const driftLine = drift !== null ? `\n\nDrift score: ${drift.toFixed(3)} (higher = title and description have diverged)` : "";
      return {
        content: [
          {
            type: "text",
            text: `Similar items:\n${lines.join("\n")}${driftLine}`,
          },
        ],
      };
    },
  );

  // ── Links (TRACK-280) ──

  server.tool(
    "tracker_add_link",
    `Add a typed link between two work items. Relations: ${VALID_LINK_RELATIONS.join(", ")}. ` +
      `Use 'relates_to' for symmetric soft cross-references; 'duplicates'/'duplicated_by' for merges; ` +
      `'parent_of'/'child_of' for groupings; 'supersedes'/'superseded_by' for replacements. ` +
      `Cross-project links are allowed.`,
    {
      from_item_id: z.string().describe("Source item (ID or display key e.g. \"TRACK-5\")"),
      to_item_id: z.string().describe("Target item (ID or display key e.g. \"TRACK-6\")"),
      relation: z.enum(VALID_LINK_RELATIONS).describe("Relation type"),
      note: z.string().optional().describe("Optional human-readable note about why these items are linked"),
    },
    async (args) => {
      try {
        const fromId = resolveId(args.from_item_id);
        const toId = resolveId(args.to_item_id);
        const link = addLink({
          from_item_id: fromId,
          to_item_id: toId,
          relation: args.relation,
          note: args.note,
          source: "manual",
          created_by: "Harmoni",
        });
        return { content: [{ type: "text", text: JSON.stringify(link, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : "Failed"}` }] };
      }
    },
  );

  server.tool(
    "tracker_remove_link",
    "Remove a typed link between two items by (from, to, relation). Auto-extracted mention links are owned by the body text and should be removed by editing the description, not via this tool.",
    {
      from_item_id: z.string().describe("Source item (ID or display key)"),
      to_item_id: z.string().describe("Target item (ID or display key)"),
      relation: z.enum(VALID_LINK_RELATIONS).describe("Relation type"),
    },
    async (args) => {
      const fromId = resolveId(args.from_item_id);
      const toId = resolveId(args.to_item_id);
      const ok = removeLink({
        from_item_id: fromId,
        to_item_id: toId,
        relation: args.relation,
        actor: "Harmoni",
      });
      return { content: [{ type: "text", text: ok ? "Link removed." : "Error: Link not found." }] };
    },
  );

  server.tool(
    "tracker_list_links",
    "List all typed links involving an item. Symmetric links and inverse directions are normalized into the item's perspective. Optionally filter by relation.",
    {
      item_id: z.string().describe("Work item ID or display key (e.g. \"TRACK-5\")"),
      relation: z.enum(VALID_LINK_RELATIONS).optional().describe("Filter by relation type"),
    },
    async (args) => {
      const itemId = resolveId(args.item_id);
      const links = listLinks(itemId, args.relation);
      // Hydrate each link with the other item's display key + title for easy reading.
      const hydrated = links.map((l) => {
        const other = getWorkItem(l.other_item_id);
        return {
          ...l,
          other_item_key: other ? getWorkItemKey(other) : null,
          other_item_title: other?.title || null,
          other_item_state: other?.state || null,
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(hydrated, null, 2) }] };
    },
  );

  // ── Groups (TRACK-281) ──

  server.tool(
    "tracker_list_children",
    "List the parent_of children of a group item, sorted by drag position. Each child is the full work item plus its link's position.",
    {
      item_id: z.string().describe("Parent item ID or display key (e.g. \"TRACK-5\")"),
    },
    async (args) => {
      const itemId = resolveId(args.item_id);
      const children = getChildItems(itemId);
      const hydrated = children.map((c) => ({
        ...c,
        key: getWorkItemKey(c),
      }));
      const parent = getParentItem(itemId);
      const parentHydrated = parent
        ? { id: parent.id, key: getWorkItemKey(parent), title: parent.title, state: parent.state }
        : null;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ children: hydrated, parent: parentHydrated }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "tracker_create_group",
    "Create a group: a new parent work item linked to the given child items via parent_of links. The new item lives in the target project (or the first child's project if not specified). At least 2 child items are required. Note: MCP-created items have created_by_class=agent, which limits some downstream operations; for human-actor flows use the dashboard.",
    {
      title: z.string().describe("Title for the new group item"),
      child_item_ids: z
        .array(z.string())
        .min(2)
        .describe("Item IDs or display keys for children. At least 2 required."),
      description: z.string().optional().describe("Optional description for the group item"),
      target_project_id: z
        .string()
        .optional()
        .describe("Project to create the group in. Defaults to the first child's project."),
    },
    async (args) => {
      const childIds = args.child_item_ids.map(resolveId);
      try {
        const parent = createGroupFromItems({
          title: args.title,
          description: args.description,
          child_item_ids: childIds,
          target_project_id: args.target_project_id,
          created_by: "Harmoni",
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ...parent, key: getWorkItemKey(parent) },
                null,
                2,
              ),
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            { type: "text", text: `Error: ${e instanceof Error ? e.message : "Failed"}` },
          ],
        };
      }
    },
  );

  // ── Refactor Operations (TRACK-282) ──

  server.tool(
    "tracker_merge_items",
    "Merge one or more source items into a target item. Appends source descriptions, moves comments (prefixed with '[from KEY]'), moves attachments, copies outbound links, adds a superseded_by link from each source to the target, and cancels the sources with a transition comment. Single transaction — all or nothing.",
    {
      target_id: z.string().describe("Target item ID or display key (the surviving item)"),
      source_ids: z
        .array(z.string())
        .min(1)
        .describe("Source item IDs or display keys (these get absorbed and cancelled)"),
      strategy: z
        .enum(["append_descriptions", "replace_with_summary"])
        .optional()
        .describe("How to combine descriptions (default: append_descriptions)"),
      transfer_comments: z
        .boolean()
        .optional()
        .describe("Move source comments to target (default: true)"),
      transfer_attachments: z
        .boolean()
        .optional()
        .describe("Move source attachments to target (default: true)"),
      transfer_links: z
        .boolean()
        .optional()
        .describe("Copy non-conflicting outbound links from sources to target (default: true)"),
    },
    async (args) => {
      try {
        const targetId = resolveId(args.target_id);
        const sourceIds = args.source_ids.map(resolveId);
        const result = mergeItems({
          target_id: targetId,
          source_ids: sourceIds,
          strategy: args.strategy,
          transfer_comments: args.transfer_comments,
          transfer_attachments: args.transfer_attachments,
          transfer_links: args.transfer_links,
          actor: "Harmoni",
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return {
          content: [
            { type: "text", text: `Error: ${e instanceof Error ? e.message : "Merge failed"}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "tracker_split_item",
    "Split a source item into N new child items. Each split becomes a new work item in the source's project, linked via parent_of. Optionally moves matching comments by regex. If preserve_source=false, the source gets a stub description and is cancelled; otherwise the source remains as a parent. Description versions snapshot before any edit so the split is reversible.",
    {
      source_id: z.string().describe("Source item ID or display key (the item being split)"),
      splits: z
        .array(
          z.object({
            title: z.string().describe("Title for the new child item"),
            description: z.string().optional().describe("Description for the new child item"),
            take_comments_matching: z
              .string()
              .optional()
              .describe("Case-insensitive regex; comments whose body matches are moved to this split"),
            labels: z.array(z.string()).optional().describe("Labels for the new child item"),
            priority: z
              .enum(VALID_PRIORITIES)
              .optional()
              .describe("Priority for the new child item"),
          }),
        )
        .min(1)
        .describe("Specs for the new child items"),
      preserve_source: z
        .boolean()
        .optional()
        .describe("Keep the source as a parent stub (true, default) or cancel it (false)"),
    },
    async (args) => {
      try {
        const sourceId = resolveId(args.source_id);
        const result = splitItem({
          source_id: sourceId,
          splits: args.splits,
          preserve_source: args.preserve_source,
          actor: "Harmoni",
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return {
          content: [
            { type: "text", text: `Error: ${e instanceof Error ? e.message : "Split failed"}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "tracker_bulk_update",
    "Apply a patch to many items in a single transaction. Each per-item change goes through the normal mutators, so actor-class rules still apply (e.g. an agent cannot bulk-approve items — those will appear in `skipped`). Patch fields are all optional; only specified fields are touched. Returns { updated, skipped, applied_per_item }.",
    {
      item_ids: z
        .array(z.string())
        .min(1)
        .describe("Item IDs or display keys to update"),
      patch: z
        .object({
          labels: z
            .object({
              add: z.array(z.string()).optional(),
              remove: z.array(z.string()).optional(),
            })
            .optional()
            .describe("Add / remove labels (set semantics — dedups)"),
          priority: z.enum(VALID_PRIORITIES).optional(),
          project_id: z
            .string()
            .optional()
            .describe("Move items to another project (allocates new seq_number)"),
          assignee: z.string().optional(),
          state: z.enum(VALID_STATES).optional(),
          add_links: z
            .array(
              z.object({
                to: z.string().describe("Target item ID or display key"),
                relation: z.enum(VALID_LINK_RELATIONS).describe("Link relation"),
                note: z.string().optional(),
              }),
            )
            .optional()
            .describe("Adds these links to every item in item_ids"),
        })
        .describe("Patch to apply. Empty patch is a no-op."),
    },
    async (args) => {
      try {
        const ids = args.item_ids.map(resolveId);
        const result = bulkUpdate({
          item_ids: ids,
          patch: args.patch,
          actor: "Harmoni",
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return {
          content: [
            { type: "text", text: `Error: ${e instanceof Error ? e.message : "Bulk update failed"}` },
          ],
          isError: true,
        };
      }
    },
  );

  // ── Proposals (TRACK-284) ──

  server.tool(
    "tracker_propose_batch",
    "Stage a batch of proposed actions for human review. Agents (like Harmoni) use this to suggest changes — merges, splits, bulk updates, links, item creation/edits — without applying them. The proposal is recorded with status='pending' and individual actions start as 'pending'. A human reviewer must accept and apply the proposal via the dashboard or `tracker_apply_proposal`. Actions accepted: " + VALID_PROPOSAL_ACTION_KINDS.join(", ") + ". Returns the created proposal with all actions.",
    {
      title: z.string().describe("Short title for the proposal (shown in the review UI)"),
      summary: z.string().optional().describe("Optional longer description explaining the rationale"),
      proposed_by: z.string().optional().describe("Actor staging the proposal (default: Harmoni). Always forced to 'agent' actor class for security."),
      expires_in_days: z.number().optional().describe("Days until the proposal auto-expires (default 7). Set 0 for no expiry."),
      actions: z
        .array(
          z.object({
            kind: z
              .enum(VALID_PROPOSAL_ACTION_KINDS)
              .describe("Action kind"),
            payload: z
              .record(z.string(), z.any())
              .describe("Action-specific payload. Examples: create_item={project_id, title, description?, ...}; update_item={item_id, title?, description?, priority?, ...}; change_state={item_id, state, comment?}; add_link={from_item_id, to_item_id, relation, note?}; remove_link={from_item_id, to_item_id, relation}; merge_items={target_id, source_ids[], strategy?, ...}; split_item={source_id, splits[]}; bulk_update={item_ids[], patch}."),
            rationale: z.string().optional().describe("Why this specific action is recommended"),
          }),
        )
        .min(1)
        .describe("Actions to stage (at least one)"),
    },
    async (args) => {
      try {
        const result = createProposal({
          title: args.title,
          summary: args.summary ?? null,
          proposed_by: args.proposed_by || "Harmoni",
          expires_in_days: args.expires_in_days,
          actions: args.actions.map((a) => ({
            kind: a.kind as ProposalActionKind,
            payload: a.payload,
            rationale: a.rationale ?? null,
          })),
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return {
          content: [
            { type: "text", text: `Error: ${e instanceof Error ? e.message : "Failed to create proposal"}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "tracker_apply_proposal",
    "Apply accepted actions from a proposal. Routes each action through the appropriate mutator (createWorkItem, updateWorkItem, mergeItems, etc.), preserving all existing actor-class rules at the mutator boundary. SECURITY: Only human-class actors can apply proposals — agent/system/api callers will be rejected. Re-applying is idempotent: already-applied actions are skipped. Returns {applied_count, failed_count, skipped_count, actions[], proposal_status}.",
    {
      proposal_id: z.string().describe("Proposal ID to apply"),
      action_ids: z
        .array(z.string())
        .optional()
        .describe("Optional: apply only these specific actions. If omitted, applies all accepted actions."),
      actor: z
        .string()
        .describe("Human actor applying the proposal (e.g. 'dashboard', 'me'). Must classify as 'human'."),
    },
    async (args) => {
      try {
        const result = applyProposal({
          proposal_id: args.proposal_id,
          action_ids: args.action_ids,
          actor: args.actor,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return {
          content: [
            { type: "text", text: `Error: ${e instanceof Error ? e.message : "Failed to apply proposal"}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "tracker_list_proposals",
    "List staged proposals with optional filters (status, since). Use this to find pending proposals awaiting review. Returns {proposals[], stats}.",
    {
      status: z.enum(["pending", "partially_applied", "applied", "rejected", "expired"]).optional().describe("Filter by proposal status"),
      since: z.string().optional().describe("Only proposals created after this ISO timestamp"),
      limit: z.number().optional().describe("Max proposals to return (default 100, max 500)"),
    },
    async (args) => {
      const items = listProposals({
        status: args.status,
        since: args.since,
        limit: args.limit,
      });
      return {
        content: [
          { type: "text", text: JSON.stringify({ proposals: items, stats: getProposalStats() }, null, 2) },
        ],
      };
    },
  );

  server.tool(
    "tracker_get_proposal",
    "Get full details for a proposal including all actions.",
    {
      proposal_id: z.string().describe("Proposal ID"),
    },
    async (args) => {
      const proposal = getProposal(args.proposal_id);
      if (!proposal) {
        return { content: [{ type: "text", text: "Proposal not found" }], isError: true };
      }
      const actions = getProposalActions(args.proposal_id);
      return { content: [{ type: "text", text: JSON.stringify({ proposal, actions }, null, 2) }] };
    },
  );

  // ── Activity Log ──

  server.tool(
    "tracker_list_activity",
    "List recent activity log entries. Returns a unified audit trail of all significant actions: item edits, state changes, moves, attachment events, and more.",
    {
      project_id: z.string().optional().describe("Filter by project ID"),
      item_id: z.string().optional().describe("Filter by item ID or display key (e.g. \"TRACK-5\")"),
      action: z.string().optional().describe("Filter by action type (e.g. \"item.updated\", \"item.state_changed\", \"attachment.uploaded\")"),
      actor: z.string().optional().describe("Filter by actor name"),
      limit: z.number().optional().describe("Max entries to return (default 50, max 200)"),
      since: z.string().optional().describe("Only entries after this ISO date"),
    },
    async (args) => {
      // Resolve item_id if it's a display key
      let itemId = args.item_id;
      if (itemId) {
        const item = getWorkItemByKey(itemId);
        if (item) itemId = item.id;
      }

      const entries = listActivity({
        project_id: args.project_id,
        item_id: itemId,
        action: args.action,
        actor: args.actor,
        limit: args.limit,
        since: args.since,
      });

      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No activity entries found." }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
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
    "Set or replace the cover image on a song, engagement, or travel space item. Accepts base64-encoded image data. Automatically removes any existing cover image before uploading the new one.",
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
    "Set or replace the cover image on a song, engagement, or travel space item from a local file path. Automatically removes any existing cover image before uploading the new one.",
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
    "Remove the cover image from a song, engagement, or travel space item.",
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

  // ── Agent Reference ──

  server.tool(
    "tracker_agent_reference",
    "Get comprehensive agent-facing reference documentation for all tracker space types AND the cross-cutting Proposals workflow (the propose→review→apply pattern agents like Harmoni should use for multi-action batches). Call this when you need detailed information — it returns the authoritative, always-up-to-date reference directly from the tracker. Optionally filter by space_type (e.g. \"travel\", \"engagement\") or pass \"proposals\" to get only the Proposals section.",
    {
      space_type: z.string().optional().describe("Filter to a specific space type (e.g. \"travel\", \"engagement\", \"scheduled\", \"song\", \"text\") OR pass \"proposals\" for just the Proposals workflow reference. Omit to get everything."),
    },
    async (args) => {
      const plugins = listSpacePlugins();
      const sections: string[] = [];

      // Header with space types table
      sections.push("# Tracker Space Types Reference\n");
      sections.push("| Type | Description | Key Features |");
      sections.push("| --- | --- | --- |");
      for (const p of plugins) {
        const features: string[] = [];
        if (p.capabilities.coverImage) features.push("cover image");
        if (p.capabilities.versionHistory) features.push("version history");
        if (p.mcpTools?.length) features.push(`${p.mcpTools.length} MCP tools`);
        sections.push(`| \`${p.name}\` | ${p.description} | ${features.join(", ") || "—"} |`);
      }
      sections.push("");

      // Shared features
      const coverTypes = getCoverSpaceTypes();
      if (coverTypes.length > 0) {
        sections.push("## Shared: Cover Image Tools\n");
        sections.push(`Space types with cover image support: ${coverTypes.map(t => `\`${t}\``).join(", ")}\n`);
        sections.push("| Tool | Description |");
        sections.push("| --- | --- |");
        sections.push("| `tracker_set_cover_image` | Set/replace cover image (base64 data) |");
        sections.push("| `tracker_set_cover_image_from_path` | Set/replace cover image from file path |");
        sections.push("| `tracker_remove_cover_image` | Remove cover image |");
        sections.push("");
      }

      // Per-space reference sections
      const targetType = args.space_type?.toLowerCase();
      for (const p of plugins) {
        if (targetType && p.name !== targetType) continue;
        if (p.agentReference) {
          sections.push(p.agentReference);
          sections.push("");
        }
      }

      // General tips
      sections.push("## Working with Spaces\n");
      sections.push("- **When creating items**, set `space_type` to the appropriate type. The project must have that space type active.");
      sections.push("- **Attachments** are key for song and engagement spaces — cover images and style files are stored as attachments, not in `space_data`.");
      sections.push("- **`space_data`** is a JSON string — always stringify when setting, parse when reading.");
      sections.push("- **Always prefer dedicated MCP tools** over raw `space_data` updates — they handle validation, coercion, and the GET-parse-modify-save cycle.");
      sections.push("");

      // Proposals workflow — agents must understand the propose→review→apply pattern
      // so they batch multi-step cleanups behind a single human review point rather
      // than firing off N individual mutations.
      if (!targetType || targetType === "proposals") {
        sections.push("## Proposals — multi-action batches for human review\n");
        sections.push("When you want to make **multiple coordinated changes** to the tracker (e.g. cleaning up duplicates, reorganising items into a group, retitling a cluster + merging stragglers), use the **Proposals** workflow instead of firing individual mutations. The pattern is **propose → review → apply**: an agent stages a batch via `tracker_propose_batch`, a human reviews and accepts/rejects each action in the dashboard, then a human applies the accepted ones.");
        sections.push("");
        sections.push("### Why this exists\n");
        sections.push("- One review point instead of N separate notifications/changes.");
        sections.push("- Every action is auditable, reversible, and can be cherry-picked.");
        sections.push("- Security: agents cannot apply proposals — only human actors can. Even within an apply, each action routes through its normal mutator, so existing actor-class rules still apply (e.g. agents still can't approve `requires_code` items, even via a proposal).");
        sections.push("");
        sections.push("### When to use Proposals vs direct MCP tools\n");
        sections.push("- **Use Proposals** when: 2+ related changes; any merge/split/bulk action that needs review; touching items the human might want to vet individually; any \"cleanup\" or \"reorganise\" operation.");
        sections.push("- **Use direct tools** when: adding a comment, watching an item, reading data — anything that doesn't mutate structure.");
        sections.push("- **Default to Proposals for anything destructive or organisational.** A human's time to scan one proposal beats their time to scan five surprise edits.");
        sections.push("");
        sections.push("### MCP tools\n");
        sections.push("| Tool | Description |");
        sections.push("| --- | --- |");
        sections.push("| `tracker_propose_batch` | Stage a batch of actions (status=pending). Returns the proposal + actions. **Use this**, not the individual mutators. |");
        sections.push("| `tracker_list_proposals` | List staged proposals (filter by `status`, `since`). |");
        sections.push("| `tracker_get_proposal` | Get a proposal with all its actions and their statuses. |");
        sections.push("| `tracker_apply_proposal` | Apply accepted actions. **Rejected for agent callers** — humans only. |");
        sections.push("");
        sections.push("### Action kinds (each action's payload mirrors the matching mutator)\n");
        sections.push("| Kind | Payload shape |");
        sections.push("| --- | --- |");
        sections.push("| `create_item` | `{project_id, title, description?, state?, priority?, assignee?, labels?, requires_code?, ...}` |");
        sections.push("| `update_item` | `{item_id, title?, description?, priority?, assignee?, labels?, date_due?, link?}` |");
        sections.push("| `change_state` | `{item_id, state, comment?}` |");
        sections.push("| `add_link` | `{from_item_id, to_item_id, relation, note?}` — applied with `source='proposal'` |");
        sections.push("| `remove_link` | `{from_item_id, to_item_id, relation}` |");
        sections.push("| `merge_items` | `{target_id, source_ids[], strategy?, transfer_comments?, transfer_attachments?, transfer_links?}` |");
        sections.push("| `split_item` | `{source_id, splits: [{title, description?, comment_regex?, labels?, priority?, target_project_id?}], preserve_source?}` |");
        sections.push("| `bulk_update` | `{item_ids[], patch: {labels?: {add, remove}, priority?, assignee?, state?, project_id?, add_links?}}` |");
        sections.push("");
        sections.push("Item IDs in payloads accept either raw IDs (24-char hex) or display keys like `TRACK-5` — they're resolved at apply time.");
        sections.push("");
        sections.push("### Example: a cleanup batch\n");
        sections.push("```");
        sections.push("tracker_propose_batch({");
        sections.push("  title: \"Tidy up the Moodle-strategy cluster\",");
        sections.push("  summary: \"Five items look like duplicates of TRACK-200; suggest merging the stragglers and re-labeling.\",");
        sections.push("  proposed_by: \"Harmoni\",");
        sections.push("  expires_in_days: 7,");
        sections.push("  actions: [");
        sections.push("    {");
        sections.push("      kind: \"merge_items\",");
        sections.push("      payload: { target_id: \"TRACK-200\", source_ids: [\"TRACK-201\", \"TRACK-204\"] },");
        sections.push("      rationale: \"Same underlying topic, drift-detector flagged both as near-duplicates of 200.\"");
        sections.push("    },");
        sections.push("    {");
        sections.push("      kind: \"bulk_update\",");
        sections.push("      payload: { item_ids: [\"TRACK-200\", \"TRACK-205\"], patch: { labels: { add: [\"moodle-strategy\"] } } },");
        sections.push("      rationale: \"Common label for easier filtering.\"");
        sections.push("    },");
        sections.push("    {");
        sections.push("      kind: \"add_link\",");
        sections.push("      payload: { from_item_id: \"TRACK-200\", to_item_id: \"TRACK-205\", relation: \"relates_to\" },");
        sections.push("      rationale: \"Strategy and rollout — closely linked.\"");
        sections.push("    }");
        sections.push("  ]");
        sections.push("});");
        sections.push("```");
        sections.push("");
        sections.push("After staging, the human sees a single Proposals badge in the topbar with the count of pending batches. They drill in, accept/reject each row, and click Apply. The runtime executes each accepted action through its normal mutator, captures per-action results, and marks the proposal `applied` / `partially_applied` / `rejected` / `expired` as appropriate.");
        sections.push("");
        sections.push("### Lifecycle status values\n");
        sections.push("- `pending` — staged, awaiting any action.");
        sections.push("- `partially_applied` — some actions applied, others still pending or rejected.");
        sections.push("- `applied` — all accepted actions ran successfully.");
        sections.push("- `rejected` — the human cancelled the whole batch.");
        sections.push("- `expired` — auto-marked after `expires_at` if not actioned (default 7 days from staging).");
        sections.push("");
        sections.push("### Security boundary (read this before using these tools)\n");
        sections.push("- `tracker_propose_batch` **always** records `proposed_by_class='agent'` regardless of what you claim. You can't impersonate a human.");
        sections.push("- `tracker_apply_proposal` **rejects** agent/system/api callers at the boundary with the error `\"Only human actors can apply proposals.\"`. Don't attempt to apply your own proposals — stage them and let the human apply.");
        sections.push("- Each action inside an apply still goes through the regular mutator (e.g. `changeWorkItemState`), so per-item security rules continue to apply.");
        sections.push("");
      }

      return { content: [{ type: "text", text: sections.join("\n") }] };
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
