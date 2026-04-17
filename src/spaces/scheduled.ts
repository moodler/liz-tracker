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
  model_strength?: "high" | "medium" | "low" | null;
}

const DEFAULTS: ScheduledSpaceData = {
  schedule: { frequency: "daily", time: "09:00", days_of_week: null, timezone: "Australia/Perth", cron_override: null },
  status: { next_run: null, last_run: null, last_status: null, last_duration_ms: null, run_count: 0 },
  todo: [],
  ignore: [],
  model_strength: null,
};

// ── Next Run Computation ──

/**
 * Compute the next scheduled run time from schedule config.
 * Returns an ISO string or null (for manual/completed-once/custom frequencies).
 *
 * Uses Intl.DateTimeFormat for timezone-aware date arithmetic so that
 * scheduled times stay consistent across DST boundaries.
 */
export function computeNextRun(
  schedule: Record<string, unknown>,
  now?: Date,
): string | null {
  const frequency = schedule.frequency as string | undefined;
  if (!frequency || frequency === "manual" || frequency === "custom") return null;

  const scheduledTime = schedule.time as string | undefined; // "HH:MM"
  const timezone = (schedule.timezone as string) || "UTC";

  if (frequency === "once") {
    // For 'once', only return the scheduled time if it's in the future
    // We need a full date for 'once' — but the schedule only stores time,
    // so 'once' tasks without a next_run already set can't be computed.
    // Return null and let it be handled by the caller if needed.
    return null;
  }

  const currentTime = now || new Date();

  if (frequency === "hourly") {
    // Next hour boundary from now
    const next = new Date(currentTime.getTime() + 60 * 60 * 1000);
    next.setMinutes(0, 0, 0);
    return next.toISOString();
  }

  if (!scheduledTime) return null;
  const [schedHour, schedMinute] = scheduledTime.split(":").map(Number);
  if (isNaN(schedHour) || isNaN(schedMinute)) return null;

  // Get current date components in the task's timezone
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      weekday: "long",
    });
    const parts = formatter.formatToParts(currentTime);
    const get = (type: string) => parts.find(p => p.type === type)?.value || "";

    const currentHour = parseInt(get("hour"), 10);
    const currentMinute = parseInt(get("minute"), 10);
    const currentYear = parseInt(get("year"), 10);
    const currentMonth = parseInt(get("month"), 10);
    const currentDay = parseInt(get("day"), 10);
    const currentWeekday = get("weekday").toLowerCase();

    const currentMinutes = currentHour * 60 + currentMinute;
    const scheduledMinutes = schedHour * 60 + schedMinute;
    const isPastToday = currentMinutes >= scheduledMinutes;

    // Helper: build an ISO string for a desired local time in the task's timezone.
    // Strategy: create a naive UTC date, see what local time it maps to,
    // then adjust by the offset to land on the desired local time.
    const buildTzDate = (year: number, month: number, day: number, hour: number, minute: number): string => {
      const pad = (n: number) => String(n).padStart(2, "0");
      const naiveUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
      const tzFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const localParts = tzFormatter.formatToParts(naiveUtc);
      const getP = (type: string) => localParts.find(p => p.type === type)?.value || "";
      const localDay = parseInt(getP("day"), 10);
      const localHour = parseInt(getP("hour"), 10);
      const localMinute = parseInt(getP("minute"), 10);
      // offset = (local - utc) in minutes, accounting for day wrap
      const dayDiff = localDay - naiveUtc.getUTCDate();
      const offsetMin = dayDiff * 1440 + (localHour - hour) * 60 + (localMinute - minute);
      // We want local=hour:minute, so UTC = naive - offset
      return new Date(naiveUtc.getTime() - offsetMin * 60 * 1000).toISOString();
    };

    if (frequency === "daily") {
      if (!isPastToday) {
        return buildTzDate(currentYear, currentMonth, currentDay, schedHour, schedMinute);
      }
      // Tomorrow
      const tomorrow = new Date(currentTime.getTime() + 24 * 60 * 60 * 1000);
      const tmParts = formatter.formatToParts(tomorrow);
      const tmGet = (type: string) => tmParts.find(p => p.type === type)?.value || "";
      return buildTzDate(parseInt(tmGet("year"), 10), parseInt(tmGet("month"), 10), parseInt(tmGet("day"), 10), schedHour, schedMinute);
    }

    if (frequency === "weekly") {
      const daysOfWeek = schedule.days_of_week as string[] | null;
      if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0) {
        // No days specified — treat like daily
        if (!isPastToday) {
          return buildTzDate(currentYear, currentMonth, currentDay, schedHour, schedMinute);
        }
        const tomorrow = new Date(currentTime.getTime() + 24 * 60 * 60 * 1000);
        const tmParts = formatter.formatToParts(tomorrow);
        const tmGet = (type: string) => tmParts.find(p => p.type === type)?.value || "";
        return buildTzDate(parseInt(tmGet("year"), 10), parseInt(tmGet("month"), 10), parseInt(tmGet("day"), 10), schedHour, schedMinute);
      }

      const weekDays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      const currentDayIdx = weekDays.indexOf(currentWeekday);

      // Find the next scheduled day (could be today if not past time, or a future day)
      for (let offset = 0; offset <= 7; offset++) {
        const checkDate = new Date(currentTime.getTime() + offset * 24 * 60 * 60 * 1000);
        const checkParts = formatter.formatToParts(checkDate);
        const checkGet = (type: string) => checkParts.find(p => p.type === type)?.value || "";
        const checkWeekday = checkGet("weekday").toLowerCase();

        if (daysOfWeek.includes(checkWeekday)) {
          if (offset === 0 && isPastToday) continue; // Today but already past
          return buildTzDate(
            parseInt(checkGet("year"), 10),
            parseInt(checkGet("month"), 10),
            parseInt(checkGet("day"), 10),
            schedHour,
            schedMinute,
          );
        }
      }
      return null; // Shouldn't happen with valid days_of_week
    }

    if (frequency === "monthly") {
      // 1st of current month if not past, else 1st of next month
      if (currentDay === 1 && !isPastToday) {
        return buildTzDate(currentYear, currentMonth, 1, schedHour, schedMinute);
      }
      // 1st of next month
      const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;
      const nextYear = currentMonth === 12 ? currentYear + 1 : currentYear;
      return buildTzDate(nextYear, nextMonth, 1, schedHour, schedMinute);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Parse the space_data JSON from a scheduled task work item.
 * Returns the parsed object with all fields normalised.
 */
function parseScheduledSpaceData(raw: string | null): ScheduledSpaceData {
  if (!raw) return { ...DEFAULTS, schedule: { ...DEFAULTS.schedule }, status: { ...DEFAULTS.status }, todo: [], ignore: [], model_strength: null };
  try {
    const parsed = JSON.parse(raw);
    const validStrengths = ["high", "medium", "low"];
    const strength = validStrengths.includes(parsed.model_strength) ? parsed.model_strength : null;
    return {
      schedule: parsed.schedule || { ...DEFAULTS.schedule },
      status: parsed.status || { ...DEFAULTS.status },
      todo: Array.isArray(parsed.todo) ? parsed.todo.map(String) : [],
      ignore: Array.isArray(parsed.ignore) ? parsed.ignore.map(String) : [],
      model_strength: strength,
    };
  } catch {
    return { ...DEFAULTS, schedule: { ...DEFAULTS.schedule }, status: { ...DEFAULTS.status }, todo: [], ignore: [], model_strength: null };
  }
}

/**
 * Sanitize space_data JSON for scheduled tasks.
 * Coerces todo/ignore array items to plain strings to prevent "[object Object]".
 *
 * This is the single authoritative implementation — previously duplicated
 * in both api.ts and mcp-server.ts.
 */
/**
 * Normalize a `days_of_week` value to an array of lowercase day-name strings.
 * Accepts strings (e.g. "Tuesday", "tuesday", "tue") and numeric indices using
 * the JS Date / cron convention (0=sunday, 1=monday, ..., 6=saturday).
 * Drops anything unrecognisable.
 *
 * TRACK-272: Agents occasionally wrote `days_of_week` as numeric arrays like
 * `[2]` via raw `space_data` PATCHes, which then crashed the scheduled-space
 * UI (it calls `.charAt(0)` on each entry). Normalising here prevents bad data
 * from being persisted, and keeps the cron generator / UI defenders on the
 * same string-name contract.
 */
function normalizeDaysOfWeek(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const WEEK_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const SHORT_MAP: Record<string, string> = {
    sun: "sunday", mon: "monday", tue: "tuesday", tues: "tuesday",
    wed: "wednesday", thu: "thursday", thur: "thursday", thurs: "thursday",
    fri: "friday", sat: "saturday",
  };
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry <= 6) {
      normalized.push(WEEK_DAYS[entry]);
    } else if (typeof entry === "string") {
      const lower = entry.trim().toLowerCase();
      if (WEEK_DAYS.includes(lower)) normalized.push(lower);
      else if (SHORT_MAP[lower]) normalized.push(SHORT_MAP[lower]);
      else if (/^[0-6]$/.test(lower)) normalized.push(WEEK_DAYS[parseInt(lower, 10)]);
    }
  }
  // Deduplicate while preserving order
  return Array.from(new Set(normalized));
}

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

    // Normalize schedule.days_of_week — see normalizeDaysOfWeek for rationale (TRACK-272).
    if (parsed.schedule && typeof parsed.schedule === "object" && parsed.schedule.days_of_week !== undefined && parsed.schedule.days_of_week !== null) {
      parsed.schedule.days_of_week = normalizeDaysOfWeek(parsed.schedule.days_of_week);
    }

    // Validate model_strength if present (TRACK-266)
    if (parsed.model_strength !== undefined) {
      const validStrengths = ["high", "medium", "low"];
      if (!validStrengths.includes(parsed.model_strength)) {
        parsed.model_strength = null;
      }
    }

    // Recompute next_run when schedule config is present (TRACK-264)
    if (parsed.schedule && typeof parsed.schedule === "object") {
      if (!parsed.status) parsed.status = {};
      parsed.status.next_run = computeNextRun(parsed.schedule);
    }

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

// ── Agent Reference ──

const SCHEDULED_AGENT_REFERENCE = `## Scheduled Space

Manages recurring automated tasks. Schedule config, status, and structured task lists are stored in \`space_data\`:

\`\`\`json
{
  "schedule": {
    "frequency": "daily|weekly|hourly|once|manual|custom",
    "time": "07:00",
    "days_of_week": ["monday", "wednesday", "friday"],
    "timezone": "Australia/Perth",
    "cron_override": null
  },
  "status": {
    "next_run": "2026-03-12T07:00:00+08:00",
    "last_run": "2026-03-11T07:00:00+08:00",
    "last_status": "completed|failed",
    "last_duration_ms": 1234,
    "run_count": 42
  },
  "model_strength": "medium",
  "todo": [
    "Check the inbox for new messages",
    "Update the daily log with findings"
  ],
  "ignore": [
    "Battery level warnings",
    "Routine maintenance reminders"
  ]
}
\`\`\`

- **Task instructions** → item description field (main prompt/instructions for the task)
- **Model strength** → optional \`space_data.model_strength\` — "high" (opus), "medium" (sonnet), or "low" (haiku). Defaults to the global model if unset.
- **TODO** → array of **plain strings** in \`space_data.todo\` — specific sub-tasks to perform during each run
- **IGNORE** → array of **plain strings** in \`space_data.ignore\` — types of information to skip/ignore
- **Run history** → displayed in the sidebar from status data

**Critical:** \`todo\` and \`ignore\` must be arrays of plain strings — never objects. Using objects like \`{"text": "task"}\` will cause \`[object Object]\` to display in the UI.

### MCP Tools for Scheduled

**Always use these dedicated tools** — they handle the GET-parse-modify-save cycle internally.

| Tool | Description |
| --- | --- |
| \`tracker_add_scheduled_todo\` | Add TODO items — pass \`item_id\` and \`items\` (array of strings) |
| \`tracker_remove_scheduled_todo\` | Remove TODO items — pass \`item_id\` and \`indices\` (array of zero-based index numbers) |
| \`tracker_add_scheduled_ignore\` | Add IGNORE rules — pass \`item_id\` and \`rules\` (array of strings) |
| \`tracker_remove_scheduled_ignore\` | Remove IGNORE rules — pass \`item_id\` and \`indices\` (array of zero-based index numbers) |

### Reading Scheduled Items

When reading scheduled items, always check both \`description\` (main instructions) and \`space_data\` (for \`todo\` and \`ignore\` lists):

\`\`\`
item = tracker_get_item(item_id="...")
space_data = JSON.parse(item.space_data)
todos = space_data.todo       // ["Check inbox", "Update log"]
ignores = space_data.ignore   // ["Battery warnings"]
\`\`\``;

// ── Plugin Export ──

export const scheduledPlugin: SpacePlugin = {
  name: "scheduled",
  label: "Scheduled",
  icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  description: "Scheduled task with frequency, timing, and run history",

  capabilities: {
    liveRefresh: true,
  },

  agentReference: SCHEDULED_AGENT_REFERENCE,

  defaultSpaceData: () => ({ ...DEFAULTS }),
  parseSpaceData: (raw) => parseScheduledSpaceData(raw) as unknown as Record<string, unknown>,
  sanitizeSpaceData: (raw) => sanitizeScheduledSpaceData(raw, "scheduled"),

  apiRoutes: scheduledApiRoutes,
  mcpTools: scheduledMcpTools,
};
