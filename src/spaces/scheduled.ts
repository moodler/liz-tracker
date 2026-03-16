/**
 * Scheduled Space Plugin — Server-Side
 *
 * Provides: scheduledPlugin, sanitizeScheduledSpaceData
 * Capabilities: liveRefresh
 * API routes: POST/DELETE /items/:id/scheduled/todo, POST/DELETE /items/:id/scheduled/ignore
 * MCP tools: tracker_add_scheduled_todo, tracker_remove_scheduled_todo,
 *            tracker_add_scheduled_ignore, tracker_remove_scheduled_ignore
 * Dependencies: db.ts (getWorkItemKey, updateWorkItem)
 *
 * Scheduled task workspace — schedule config (frequency, time, days),
 * live status panel (next/last run, run count), task instructions editor,
 * TODO list, IGNORE list + run history sidebar.
 */

import { z } from "zod";
import { getWorkItemKey, updateWorkItem } from "../db.js";
import type { SpacePlugin, SpaceApiRoute, SpaceMcpTool, WorkItem } from "./types.js";

// ── Data Layer ──

interface ScheduledSpaceData {
  schedule: Record<string, unknown>;
  status: Record<string, unknown>;
  todo: string[];
  ignore: string[];
}

const DEFAULTS: ScheduledSpaceData = {
  schedule: { frequency: "daily", time: "09:00", days_of_week: null, timezone: "Australia/Perth", cron_override: null },
  status: { next_run: null, last_run: null, last_status: null, last_duration_ms: null, run_count: 0 },
  todo: [],
  ignore: [],
};

/**
 * Parse the space_data JSON from a scheduled task work item.
 * Returns the parsed object with all fields normalised.
 */
function parseScheduledSpaceData(raw: string | null): ScheduledSpaceData {
  if (!raw) return { ...DEFAULTS, schedule: { ...DEFAULTS.schedule }, status: { ...DEFAULTS.status }, todo: [], ignore: [] };
  try {
    const parsed = JSON.parse(raw);
    return {
      schedule: parsed.schedule || { ...DEFAULTS.schedule },
      status: parsed.status || { ...DEFAULTS.status },
      todo: Array.isArray(parsed.todo) ? parsed.todo.map(String) : [],
      ignore: Array.isArray(parsed.ignore) ? parsed.ignore.map(String) : [],
    };
  } catch {
    return { ...DEFAULTS, schedule: { ...DEFAULTS.schedule }, status: { ...DEFAULTS.status }, todo: [], ignore: [] };
  }
}

/**
 * Sanitize space_data JSON for scheduled tasks.
 * Coerces todo/ignore array items to plain strings to prevent "[object Object]".
 *
 * This is the single authoritative implementation — previously duplicated
 * in both api.ts and mcp-server.ts.
 */
export function sanitizeScheduledSpaceData(spaceDataStr: string, spaceType?: string | null): string {
  try {
    const parsed = JSON.parse(spaceDataStr);
    const isScheduled = spaceType === "scheduled" ||
      (parsed.schedule && typeof parsed.schedule === "object") ||
      Array.isArray(parsed.todo) || Array.isArray(parsed.ignore);
    if (!isScheduled) return spaceDataStr;

    const coerceToStrings = (arr: unknown[]): string[] => arr.map((item: unknown) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        return String(obj.text || obj.title || obj.name || obj.content || obj.description || obj.value || JSON.stringify(item));
      }
      return String(item);
    });

    if (Array.isArray(parsed.todo)) parsed.todo = coerceToStrings(parsed.todo);
    if (Array.isArray(parsed.ignore)) parsed.ignore = coerceToStrings(parsed.ignore);
    return JSON.stringify(parsed);
  } catch {
    return spaceDataStr;
  }
}

/** Save updated space_data back to a scheduled task. */
function saveScheduledData(itemId: string, data: ScheduledSpaceData) {
  return updateWorkItem(itemId, { space_data: JSON.stringify(data) });
}

// ── API Routes ──

// Import types needed for route handlers — these are passed to us via the handler signature.
// The generic dispatcher in api.ts provides parseBody, json, error as closure-bound helpers,
// but our route handlers receive (req, res, item) directly. We need to use the same HTTP
// utilities. To avoid circular imports, we define inline helpers that match the api.ts pattern.

function jsonResponse(res: import("http").ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body).toString() });
  res.end(body);
}

function errorResponse(res: import("http").ServerResponse, message: string, status = 400): void {
  jsonResponse(res, { error: message }, status);
}

function parseRequestBody(req: import("http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString();
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const scheduledApiRoutes: SpaceApiRoute[] = [
  // POST /items/:id/scheduled/todo — add TODO items
  {
    method: "POST",
    path: "todo",
    handler: async (req, res, item) => {
      const body = await parseRequestBody(req);
      if (!body.items || !Array.isArray(body.items)) return errorResponse(res, "items (array of strings) is required");

      const spaceData = parseScheduledSpaceData(item.space_data);
      const newItems = (body.items as unknown[]).map((i) => String(i));
      spaceData.todo.push(...newItems);

      const updated = saveScheduledData(item.id, spaceData);
      if (!updated) return errorResponse(res, "Failed to update work item", 500);
      jsonResponse(res, { todo: spaceData.todo, added: newItems.length, total: spaceData.todo.length });
    },
  },
  // DELETE /items/:id/scheduled/todo — remove TODO items by indices
  {
    method: "DELETE",
    path: "todo",
    handler: async (req, res, item) => {
      const body = await parseRequestBody(req);
      if (!body.indices || !Array.isArray(body.indices)) return errorResponse(res, "indices (array of numbers) is required");

      const spaceData = parseScheduledSpaceData(item.space_data);
      const indices = (body.indices as unknown[]).map(Number);
      const invalidIndices = indices.filter((i) => i < 0 || i >= spaceData.todo.length);
      if (invalidIndices.length > 0) {
        return errorResponse(res, `Invalid indices: ${invalidIndices.join(", ")}. TODO list has ${spaceData.todo.length} items.`);
      }

      const sortedIndices = [...indices].sort((a, b) => b - a);
      const removed: string[] = [];
      for (const idx of sortedIndices) {
        removed.push(spaceData.todo[idx]);
        spaceData.todo.splice(idx, 1);
      }

      const updated = saveScheduledData(item.id, spaceData);
      if (!updated) return errorResponse(res, "Failed to update work item", 500);
      jsonResponse(res, { todo: spaceData.todo, removed: removed.length, total: spaceData.todo.length });
    },
  },
  // POST /items/:id/scheduled/ignore — add IGNORE rules
  {
    method: "POST",
    path: "ignore",
    handler: async (req, res, item) => {
      const body = await parseRequestBody(req);
      if (!body.rules || !Array.isArray(body.rules)) return errorResponse(res, "rules (array of strings) is required");

      const spaceData = parseScheduledSpaceData(item.space_data);
      const newRules = (body.rules as unknown[]).map((r) => String(r));
      spaceData.ignore.push(...newRules);

      const updated = saveScheduledData(item.id, spaceData);
      if (!updated) return errorResponse(res, "Failed to update work item", 500);
      jsonResponse(res, { ignore: spaceData.ignore, added: newRules.length, total: spaceData.ignore.length });
    },
  },
  // DELETE /items/:id/scheduled/ignore — remove IGNORE rules by indices
  {
    method: "DELETE",
    path: "ignore",
    handler: async (req, res, item) => {
      const body = await parseRequestBody(req);
      if (!body.indices || !Array.isArray(body.indices)) return errorResponse(res, "indices (array of numbers) is required");

      const spaceData = parseScheduledSpaceData(item.space_data);
      const indices = (body.indices as unknown[]).map(Number);
      const invalidIndices = indices.filter((i) => i < 0 || i >= spaceData.ignore.length);
      if (invalidIndices.length > 0) {
        return errorResponse(res, `Invalid indices: ${invalidIndices.join(", ")}. IGNORE list has ${spaceData.ignore.length} rules.`);
      }

      const sortedIndices = [...indices].sort((a, b) => b - a);
      const removed: string[] = [];
      for (const idx of sortedIndices) {
        removed.push(spaceData.ignore[idx]);
        spaceData.ignore.splice(idx, 1);
      }

      const updated = saveScheduledData(item.id, spaceData);
      if (!updated) return errorResponse(res, "Failed to update work item", 500);
      jsonResponse(res, { ignore: spaceData.ignore, removed: removed.length, total: spaceData.ignore.length });
    },
  },
];

// ── MCP Tools ──

const scheduledMcpTools: SpaceMcpTool[] = [
  {
    name: "tracker_add_scheduled_todo",
    description: "Add one or more TODO items to a scheduled task. Much simpler than updating space_data manually — just pass the item key and the text strings to add.",
    schema: {
      item_id: z.string().describe("Work item ID or display key (e.g. \"HARMONI-5\")"),
      items: z.array(z.string()).describe("TODO items to add — each must be a plain text string describing a task step"),
    },
    handler: async (args, item) => {
      const data = parseScheduledSpaceData(item.space_data);
      const newItems = (args.items as string[]).map((i) => String(i));
      data.todo.push(...newItems);

      const updated = saveScheduledData(item.id, data);
      if (!updated) return { content: [{ type: "text" as const, text: "Error: Failed to update work item" }] };

      return {
        content: [{
          type: "text" as const,
          text: `Added ${newItems.length} TODO item(s) to ${getWorkItemKey(item)}. Total TODO items: ${data.todo.length}.\n\nCurrent TODO list:\n${data.todo.map((t, i) => `  ${i}: ${t}`).join("\n")}`,
        }],
      };
    },
  },
  {
    name: "tracker_remove_scheduled_todo",
    description: "Remove TODO items from a scheduled task by their index numbers. Use tracker_get_item first to see the current TODO list and their indices.",
    schema: {
      item_id: z.string().describe("Work item ID or display key (e.g. \"HARMONI-5\")"),
      indices: z.array(z.number()).describe("Zero-based indices of TODO items to remove. Use tracker_get_item to see the list and indices first."),
    },
    handler: async (args, item) => {
      const data = parseScheduledSpaceData(item.space_data);
      const indices = args.indices as number[];

      const invalidIndices = indices.filter((i) => i < 0 || i >= data.todo.length);
      if (invalidIndices.length > 0) {
        return { content: [{ type: "text" as const, text: `Error: Invalid indices: ${invalidIndices.join(", ")}. TODO list has ${data.todo.length} items (indices 0-${data.todo.length - 1}).` }] };
      }

      const sortedIndices = [...indices].sort((a, b) => b - a);
      const removed: string[] = [];
      for (const idx of sortedIndices) {
        removed.push(data.todo[idx]);
        data.todo.splice(idx, 1);
      }

      const updated = saveScheduledData(item.id, data);
      if (!updated) return { content: [{ type: "text" as const, text: "Error: Failed to update work item" }] };

      return {
        content: [{
          type: "text" as const,
          text: `Removed ${removed.length} TODO item(s) from ${getWorkItemKey(item)}. Remaining: ${data.todo.length}.\n\nRemoved:\n${removed.map((t) => `  - ${t}`).join("\n")}\n\nCurrent TODO list:\n${data.todo.length > 0 ? data.todo.map((t, i) => `  ${i}: ${t}`).join("\n") : "  (empty)"}`,
        }],
      };
    },
  },
  {
    name: "tracker_add_scheduled_ignore",
    description: "Add one or more IGNORE rules to a scheduled task. Much simpler than updating space_data manually — just pass the item key and the rule strings to add.",
    schema: {
      item_id: z.string().describe("Work item ID or display key (e.g. \"HARMONI-5\")"),
      rules: z.array(z.string()).describe("IGNORE rules to add — each must be a plain text string describing what to skip or exclude"),
    },
    handler: async (args, item) => {
      const data = parseScheduledSpaceData(item.space_data);
      const newRules = (args.rules as string[]).map((r) => String(r));
      data.ignore.push(...newRules);

      const updated = saveScheduledData(item.id, data);
      if (!updated) return { content: [{ type: "text" as const, text: "Error: Failed to update work item" }] };

      return {
        content: [{
          type: "text" as const,
          text: `Added ${newRules.length} IGNORE rule(s) to ${getWorkItemKey(item)}. Total IGNORE rules: ${data.ignore.length}.\n\nCurrent IGNORE list:\n${data.ignore.map((r, i) => `  ${i}: ${r}`).join("\n")}`,
        }],
      };
    },
  },
  {
    name: "tracker_remove_scheduled_ignore",
    description: "Remove IGNORE rules from a scheduled task by their index numbers. Use tracker_get_item first to see the current IGNORE list and their indices.",
    schema: {
      item_id: z.string().describe("Work item ID or display key (e.g. \"HARMONI-5\")"),
      indices: z.array(z.number()).describe("Zero-based indices of IGNORE rules to remove. Use tracker_get_item to see the list and indices first."),
    },
    handler: async (args, item) => {
      const data = parseScheduledSpaceData(item.space_data);
      const indices = args.indices as number[];

      const invalidIndices = indices.filter((i) => i < 0 || i >= data.ignore.length);
      if (invalidIndices.length > 0) {
        return { content: [{ type: "text" as const, text: `Error: Invalid indices: ${invalidIndices.join(", ")}. IGNORE list has ${data.ignore.length} rules (indices 0-${data.ignore.length - 1}).` }] };
      }

      const sortedIndices = [...indices].sort((a, b) => b - a);
      const removed: string[] = [];
      for (const idx of sortedIndices) {
        removed.push(data.ignore[idx]);
        data.ignore.splice(idx, 1);
      }

      const updated = saveScheduledData(item.id, data);
      if (!updated) return { content: [{ type: "text" as const, text: "Error: Failed to update work item" }] };

      return {
        content: [{
          type: "text" as const,
          text: `Removed ${removed.length} IGNORE rule(s) from ${getWorkItemKey(item)}. Remaining: ${data.ignore.length}.\n\nRemoved:\n${removed.map((r) => `  - ${r}`).join("\n")}\n\nCurrent IGNORE list:\n${data.ignore.length > 0 ? data.ignore.map((r, i) => `  ${i}: ${r}`).join("\n") : "  (empty)"}`,
        }],
      };
    },
  },
];

// ── Plugin Export ──

export const scheduledPlugin: SpacePlugin = {
  name: "scheduled",
  label: "Scheduled",
  icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  description: "Scheduled task with frequency, timing, and run history",

  capabilities: {
    liveRefresh: true,
  },

  defaultSpaceData: () => ({ ...DEFAULTS }),
  parseSpaceData: (raw) => parseScheduledSpaceData(raw) as unknown as Record<string, unknown>,
  sanitizeSpaceData: (raw) => sanitizeScheduledSpaceData(raw, "scheduled"),

  apiRoutes: scheduledApiRoutes,
  mcpTools: scheduledMcpTools,
};
