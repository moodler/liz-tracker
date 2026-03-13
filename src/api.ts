/**
 * Tracker REST API Server
 *
 * Lightweight HTTP server (no Express) providing a full REST API
 * for the project tracker. Runs on its own port.
 *
 * API prefix: /api/v1/
 *
 * Routes:
 *   Projects:  GET/POST /projects, PUT /projects/reorder, GET/PATCH/DELETE /projects/:id
 *   Items:     GET/POST /projects/:pid/items, GET/PATCH/DELETE /items/:id
 *   State:     POST /items/:id/state
 *   Lock:      POST /items/:id/lock, POST /items/:id/unlock
 *   Deps:      GET/POST /items/:id/dependencies, DELETE /items/:id/dependencies/:dep_id
 *   Stale:     POST /items/clear-stale-locks
 *   Comments:  GET/POST /items/:id/comments, PATCH/DELETE /comments/:id
 *   Transitions: GET /items/:id/transitions
 *   Versions:  GET/POST /items/:id/versions
 *   Watchers:  GET/POST /items/:id/watchers, DELETE /items/:id/watchers/:entity
 *   Stats:     GET /projects/:id/stats
 *   Tracker:   GET /projects/:id/tracker  (kanban-grouped view)
 *   Search:    GET /search?q=...&project_id=...
 *   Dispatch:  POST /items/:id/dispatch
 *   Session:   GET /items/:id/session, POST /items/:id/session/abort
 *   Orchestrator: GET /orchestrator/status, POST /orchestrator/pause, POST /orchestrator/resume
 */

import http from "http";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import Database from "better-sqlite3";

import { logger } from "./logger.js";
import { handleMcpRequest } from "./mcp-server.js";
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
  deleteProject,
  reorderProjects,
  createWorkItem,
  getWorkItem,
  getWorkItemByKey,
  getWorkItemKey,
  listWorkItems,
  updateWorkItem,
  moveWorkItem,
  changeWorkItemState,
  deleteWorkItem,
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
  getCommentCounts,
  updateComment,
  deleteComment,
  listTransitions,
  addWatcher,
  listWatchers,
  removeWatcher,
  getProjectStats,
  getRecentItems,
  getAttentionItems,
  getExecutionAudits,
  createAttachment,
  getAttachment,
  listAttachments,
  deleteAttachment,
  MAX_ATTACHMENT_SIZE,
  createDescriptionVersion,
  listDescriptionVersions,
  revertToDescriptionVersion,
  classifyActor,
  VALID_STATES,
  VALID_PRIORITIES,
  VALID_PLATFORMS,
  type WorkItemState,
  type Priority,
  type Platform,
  type WorkItemFilters,
} from "./db.js";
import {
  dispatchItem,
  abortSession,
  pauseOrchestrator,
  resumeOrchestrator,
  getOrchestratorStatus,
  emergencyStop,
  requestSafeRestart,
  getRestartStatus,
  cancelRestart,
  isSafeToRestart,
} from "./orchestrator.js";
import { OPENCODE_PUBLIC_URL, buildOpencodeSessionUrl, TRACKER_API_TOKEN, STORE_DIR, buildItemUrl } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Helpers ──

/**
 * Sanitize space_data JSON for scheduled tasks.
 * Coerces todo/ignore array items to plain strings to prevent "[object Object]".
 */
function sanitizeScheduledSpaceData(spaceDataStr: string, spaceType?: string | null): string {
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

/**
 * Parse space_data from a scheduled task work item for API operations.
 * Returns a structured object with todo/ignore arrays, or null on parse failure.
 */
function parseScheduledSpaceDataForApi(item: { space_type: string; space_data: string | null }): {
  schedule: Record<string, unknown>;
  status: Record<string, unknown>;
  todo: string[];
  ignore: string[];
} | null {
  if (!item.space_data) {
    return {
      schedule: { frequency: "daily", time: "09:00", days_of_week: null, timezone: "Australia/Perth", cron_override: null },
      status: { next_run: null, last_run: null, last_status: null, last_duration_ms: null, run_count: 0 },
      todo: [],
      ignore: [],
    };
  }
  try {
    const parsed = JSON.parse(item.space_data);
    return {
      schedule: parsed.schedule || {},
      status: parsed.status || {},
      todo: Array.isArray(parsed.todo) ? parsed.todo.map(String) : [],
      ignore: Array.isArray(parsed.ignore) ? parsed.ignore.map(String) : [],
    };
  } catch {
    return null;
  }
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, message: string, status = 400): void {
  json(res, { error: message }, status);
}

function parseBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** Read the raw body as a Buffer. */
function parseRawBody(
  req: http.IncomingMessage,
  maxSize: number = MAX_ATTACHMENT_SIZE + 1024 * 1024, // Extra room for multipart framing
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        return reject(new Error(`Request body exceeds maximum size of ${Math.round(maxSize / 1024 / 1024)}MB`));
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Parsed file from a multipart/form-data request. */
interface MultipartFile {
  fieldName: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

/** Parsed field from a multipart/form-data request. */
interface MultipartField {
  fieldName: string;
  value: string;
}

/** Parse multipart/form-data body into files and fields. */
function parseMultipart(
  body: Buffer,
  boundary: string,
): { files: MultipartFile[]; fields: MultipartField[] } {
  const files: MultipartFile[] = [];
  const fields: MultipartField[] = [];

  const boundaryBuf = Buffer.from(`--${boundary}`);
  const endBuf = Buffer.from(`--${boundary}--`);

  // Split on boundary
  let pos = 0;
  const parts: Buffer[] = [];

  while (pos < body.length) {
    const nextBoundary = body.indexOf(boundaryBuf, pos);
    if (nextBoundary === -1) break;

    if (parts.length > 0) {
      // Previous part ends here (minus the CRLF before boundary)
      const partEnd = nextBoundary - 2; // strip trailing \r\n
      if (partEnd > pos) {
        parts.push(body.subarray(pos, partEnd));
      }
    }

    // Move past boundary + CRLF
    pos = nextBoundary + boundaryBuf.length;

    // Check if this is the end boundary
    if (body.subarray(nextBoundary, nextBoundary + endBuf.length).equals(endBuf)) {
      break;
    }

    // Skip CRLF after boundary
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) {
      pos += 2;
    }

    // Find header/body separator (double CRLF)
    const headerEnd = body.indexOf("\r\n\r\n", pos);
    if (headerEnd === -1) break;

    const headerStr = body.subarray(pos, headerEnd).toString("utf-8");
    const bodyStart = headerEnd + 4;

    // Find next boundary to get the body
    const nextB = body.indexOf(boundaryBuf, bodyStart);
    const bodyEnd = nextB !== -1 ? nextB - 2 : body.length; // strip trailing \r\n
    const partData = body.subarray(bodyStart, bodyEnd);

    // Parse headers
    const headers = headerStr.split("\r\n");
    let fieldName = "";
    let filename = "";
    let contentType = "application/octet-stream";

    for (const header of headers) {
      const lowerHeader = header.toLowerCase();
      if (lowerHeader.startsWith("content-disposition:")) {
        const nameMatch = header.match(/\bname="([^"]+)"/);
        if (nameMatch) fieldName = nameMatch[1];
        const fileMatch = header.match(/\bfilename="([^"]+)"/);
        if (fileMatch) filename = fileMatch[1];
      }
      if (lowerHeader.startsWith("content-type:")) {
        contentType = header.split(":")[1].trim();
      }
    }

    if (filename) {
      files.push({ fieldName, filename, contentType, data: partData });
    } else if (fieldName) {
      fields.push({ fieldName, value: partData.toString("utf-8") });
    }

    pos = nextB !== -1 ? nextB : body.length;
  }

  return { files, fields };
}

/** Sanitize a filename for safe filesystem storage. */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "_") // Replace special chars
    .replace(/^\.+/, "_")              // No leading dots
    .substring(0, 200);                // Limit length
}

/** Extract path segments: /api/v1/projects/abc/items -> ['projects', 'abc', 'items'] */
function segments(url: string): string[] {
  const pathname = new URL(url, "http://localhost").pathname;
  return pathname
    .replace(/^\/api\/v1\//, "")
    .split("/")
    .filter(Boolean);
}

function queryParams(url: string): URLSearchParams {
  return new URL(url, "http://localhost").searchParams;
}

// ── API Authentication (Section 4.8) ──

/** Timing-safe token comparison to prevent timing attacks. */
function tokenEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against self to keep constant time regardless of length mismatch
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Check if a request is authenticated.
 * If TRACKER_API_TOKEN is configured, ALL API endpoints require a valid Bearer token.
 * Static file serving (dashboard HTML/CSS/JS) remains unauthenticated so the
 * login page can load.
 *
 * Returns true if authenticated, false if rejected (and response already sent).
 */
function checkAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  if (!TRACKER_API_TOKEN) return true; // Auth not configured — allow all

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    error(res, "Authentication required. Include: Authorization: Bearer <token>", 401);
    return false;
  }

  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!tokenEquals(token, TRACKER_API_TOKEN)) {
    error(res, "Invalid authentication token", 403);
    return false;
  }

  return true;
}

/**
 * Legacy alias — checkWriteAuth now delegates to the unified checkAuth.
 */
function checkWriteAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  return checkAuth(req, res);
}

/**
 * Determine if a request is a "write" operation (POST, PATCH, PUT, DELETE).
 * GET requests are always allowed without auth.
 */
function isWriteMethod(method: string): boolean {
  return ["POST", "PATCH", "PUT", "DELETE"].includes(method);
}

// ── Route Handler ──

/**
 * Resolve an item identifier — could be a raw ID or a display key like "LIZ-3".
 * Returns the canonical ID, or the original string if no key match.
 */
function resolveItemId(idOrKey: string): string {
  // If it looks like a key (LETTERS-DIGITS), try key lookup first
  if (/^[A-Za-z]+-\d+$/.test(idOrKey)) {
    const item = getWorkItemByKey(idOrKey);
    if (item) return item.id;
  }
  return idOrKey;
}

async function handleApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const method = req.method || "GET";
  const url = req.url || "/";
  const parts = segments(url);
  const params = queryParams(url);

  try {
    // ── Auth verify endpoint (unauthenticated — used by login screen) ──
    if (parts[0] === "auth" && parts[1] === "verify" && method === "POST") {
      if (!TRACKER_API_TOKEN) {
        // No token configured — auth disabled, always valid
        return json(res, { valid: true, authRequired: false });
      }
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return json(res, { valid: false, authRequired: true }, 401);
      }
      const token = authHeader.replace(/^Bearer\s+/i, "");
      if (tokenEquals(token, TRACKER_API_TOKEN)) {
        return json(res, { valid: true, authRequired: true });
      }
      return json(res, { valid: false, authRequired: true }, 401);
    }

    // ── Auth status endpoint (unauthenticated — tells frontend if auth is needed) ──
    if (parts[0] === "auth" && parts[1] === "status" && method === "GET") {
      return json(res, { authRequired: !!TRACKER_API_TOKEN });
    }

    // ── Attachment file serving (unauthenticated — browser must be able to load files directly) ──
    // GET /attachments/:id — serve the file without auth so browser can display/download
    // GET /attachments/:id/meta — get metadata (also unauthenticated for convenience)
    if (parts[0] === "attachments" && parts.length >= 2 && method === "GET") {
      const attachmentId = parts[1];

      if (parts.length === 2) {
        // Serve the file
        const attachment = getAttachment(attachmentId);
        if (!attachment) return error(res, "Attachment not found", 404);

        const fullPath = path.join(STORE_DIR, attachment.storage_path);
        if (!fs.existsSync(fullPath)) return error(res, "Attachment file not found on disk", 404);

        const stat = fs.statSync(fullPath);
        const content = fs.readFileSync(fullPath);

        res.writeHead(200, {
          "Content-Type": attachment.mime_type,
          "Content-Length": stat.size.toString(),
          "Content-Disposition": `inline; filename="${attachment.filename}"`,
          "Cache-Control": "max-age=3600",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(content);
        return;
      }

      if (parts.length === 3 && parts[2] === "meta") {
        // Serve metadata
        const attachment = getAttachment(attachmentId);
        if (!attachment) return error(res, "Attachment not found", 404);
        return json(res, attachment);
      }
    }

    // ── Section 4.8: API Authentication ──
    // ALL API endpoints require authentication when TRACKER_API_TOKEN is set
    if (!checkAuth(req, res)) {
      return;
    }

    // ── Projects ──
    if (parts[0] === "projects") {
      // GET /projects
      if (parts.length === 1 && method === "GET") {
        return json(res, listProjects());
      }

      // POST /projects
      if (parts.length === 1 && method === "POST") {
        const body = await parseBody(req);
        if (!body.name) return error(res, "name is required");
        const project = createProject({
          name: String(body.name),
          short_name: body.short_name ? String(body.short_name) : undefined,
          description: body.description ? String(body.description) : undefined,
        });
        return json(res, project, 201);
      }

      // PUT /projects/reorder — reorder project tabs
      if (parts.length === 2 && parts[1] === "reorder" && method === "PUT") {
        const body = await parseBody(req);
        if (!Array.isArray(body.order))
          return error(res, "order (array of project IDs) is required");
        reorderProjects(body.order as string[]);
        return json(res, { ok: true });
      }

      const projectId = parts[1];

      // GET /projects/:id/stats
      if (parts.length === 3 && parts[2] === "stats" && method === "GET") {
        const project = getProject(projectId);
        if (!project) return error(res, "Project not found", 404);
        return json(res, getProjectStats(projectId));
      }

      // GET /projects/:id/tracker
      if (parts.length === 3 && parts[2] === "tracker" && method === "GET") {
        const project = getProject(projectId);
        if (!project) return error(res, "Project not found", 404);
        const items = listWorkItems({ project_id: projectId });
        const commentCounts = getCommentCounts(items.map((i) => i.id));
        const enriched = items.map((i) => {
          const key = `${project.short_name}-${i.seq_number}`;
          return {
            ...i,
            key,
            url: buildItemUrl(key),
            comment_count: commentCounts[i.id] || 0,
          };
        });
        const tracker: Record<string, typeof enriched> = {};
        for (const state of VALID_STATES) {
          tracker[state] = enriched.filter((i) => i.state === state);
        }
        return json(res, { project, tracker });
      }

      // GET/POST /projects/:id/items
      if (parts.length === 3 && parts[2] === "items") {
        if (method === "GET") {
          const filters: WorkItemFilters = { project_id: projectId };
          if (params.get("state"))
            filters.state = params.get("state") as WorkItemState;
          if (params.get("assignee"))
            filters.assignee = params.get("assignee")!;
          if (params.get("priority"))
            filters.priority = params.get("priority") as Priority;
          if (params.get("search")) filters.search = params.get("search")!;
          if (params.get("label")) filters.label = params.get("label")!;
          return json(res, listWorkItems(filters));
        }
        if (method === "POST") {
          const project = getProject(projectId);
          if (!project) return error(res, "Project not found", 404);
          const body = await parseBody(req);
          if (!body.title) return error(res, "title is required");
          if (
            body.state &&
            !VALID_STATES.includes(body.state as WorkItemState)
          ) {
            return error(
              res,
              `Invalid state. Valid: ${VALID_STATES.join(", ")}`,
            );
          }
          if (
            body.priority &&
            !VALID_PRIORITIES.includes(body.priority as Priority)
          ) {
            return error(
              res,
              `Invalid priority. Valid: ${VALID_PRIORITIES.join(", ")}`,
            );
          }
          const item = createWorkItem({
            project_id: projectId,
            title: String(body.title),
            description: body.description
              ? String(body.description)
              : undefined,
            state: body.state as WorkItemState | undefined,
            priority: body.priority as Priority | undefined,
            assignee: body.assignee ? String(body.assignee) : undefined,
            labels: Array.isArray(body.labels)
              ? body.labels.map(String)
              : undefined,
            requires_code:
              body.requires_code !== undefined
                ? Boolean(body.requires_code)
                : undefined,
            bot_dispatch:
              body.bot_dispatch !== undefined
                ? Boolean(body.bot_dispatch)
                : undefined,
            platform:
              body.platform &&
              VALID_PLATFORMS.includes(body.platform as Platform)
                ? (body.platform as Platform)
                : undefined,
            date_due:
              body.date_due !== undefined
                ? (body.date_due ? String(body.date_due) : null)
                : undefined,
            link:
              body.link !== undefined
                ? (body.link ? String(body.link) : null)
                : undefined,
            space_type: body.space_type ? String(body.space_type) : undefined,
            space_data: body.space_data !== undefined
              ? sanitizeScheduledSpaceData(
                  typeof body.space_data === "string" ? body.space_data : JSON.stringify(body.space_data),
                  body.space_type ? String(body.space_type) : undefined,
                )
              : undefined,
            created_by: body.created_by ? String(body.created_by) : undefined,
          });
          const key = getWorkItemKey(item);
          return json(res, { ...item, key, url: buildItemUrl(key) }, 201);
        }
      }

      // GET/PATCH/DELETE /projects/:id
      if (parts.length === 2) {
        if (method === "GET") {
          const project = getProject(projectId);
          if (!project) return error(res, "Project not found", 404);
          return json(res, project);
        }
        if (method === "PATCH") {
          const body = await parseBody(req);
          const project = updateProject(projectId, {
            name: body.name ? String(body.name) : undefined,
            short_name: body.short_name ? String(body.short_name) : undefined,
            description:
              body.description !== undefined
                ? String(body.description)
                : undefined,
            context:
              body.context !== undefined
                ? String(body.context)
                : undefined,
            theme: body.theme ? String(body.theme) : undefined,
            working_directory:
              body.working_directory !== undefined
                ? String(body.working_directory)
                : undefined,
            opencode_project_id:
              body.opencode_project_id !== undefined
                ? String(body.opencode_project_id)
                : undefined,
            orchestration:
              body.orchestration !== undefined
                ? (body.orchestration ? 1 : 0)
                : undefined,
            active_spaces:
              body.active_spaces !== undefined
                ? (typeof body.active_spaces === "string" ? body.active_spaces : JSON.stringify(body.active_spaces))
                : undefined,
          });
          if (!project) return error(res, "Project not found", 404);
          return json(res, project);
        }
        if (method === "DELETE") {
          const ok = deleteProject(projectId);
          if (!ok) return error(res, "Project not found", 404);
          return json(res, { deleted: true }, 200);
        }
      }
    }

    // ── Work Items (direct access) ──
    if (parts[0] === "items") {
      const itemId =
        parts[1] === "clear-stale-locks" || parts[1] === "recent" ? parts[1] : resolveItemId(parts[1]);

      // POST /items/clear-stale-locks (note: before :id routes)
      if (
        parts.length === 2 &&
        parts[1] === "clear-stale-locks" &&
        method === "POST"
      ) {
        const body = await parseBody(req);
        const maxAgeMs = body.max_age_hours
          ? Number(body.max_age_hours) * 60 * 60 * 1000
          : undefined;
        const cleared = clearStaleLocks(maxAgeMs);
        return json(res, {
          cleared: cleared.length,
          items: cleared.map((i) => ({
            id: i.id,
            title: i.title,
            locked_by: i.locked_by,
            locked_at: i.locked_at,
          })),
        });
      }

      // GET /items/recent?project_id=...&limit=20&exclude=...
      if (
        parts.length === 2 &&
        parts[1] === "recent" &&
        method === "GET"
      ) {
        const projectId = params.get("project_id") || undefined;
        const limit = Math.min(Number(params.get("limit") || 20), 50);
        const excludeId = params.get("exclude") || undefined;
        let items = getRecentItems(projectId, limit + (excludeId ? 1 : 0));
        if (excludeId) {
          items = items.filter((i) => i.id !== excludeId);
          items = items.slice(0, limit);
        }
        // Enrich with keys and urls
        const enriched = items.map((item) => {
          const key = getWorkItemKey(item);
          return { ...item, key, url: buildItemUrl(key) };
        });
        return json(res, enriched);
      }

      // POST /items/:id/state
      if (parts.length === 3 && parts[2] === "state" && method === "POST") {
        const body = await parseBody(req);
        if (!body.state) return error(res, "state is required");
        if (!VALID_STATES.includes(body.state as WorkItemState)) {
          return error(res, `Invalid state. Valid: ${VALID_STATES.join(", ")}`);
        }
        try {
          const item = changeWorkItemState(
            itemId,
            body.state as WorkItemState,
            body.actor ? String(body.actor) : "api",
            body.comment ? String(body.comment) : undefined,
          );
          if (!item) return error(res, "Work item not found", 404);
          const key = getWorkItemKey(item);
          return json(res, { ...item, key, url: buildItemUrl(key) });
        } catch (e) {
          // Security control rejections (e.g., non-human trying to approve)
          const msg = e instanceof Error ? e.message : "State change rejected";
          logger.warn({ itemId, error: msg }, "State change rejected by security control");
          return error(res, msg, 403);
        }
      }

      // POST /items/:id/lock
      if (parts.length === 3 && parts[2] === "lock" && method === "POST") {
        const body = await parseBody(req);
        if (!body.agent) return error(res, "agent is required");
        const item = lockWorkItem(itemId, String(body.agent));
        if (!item) return error(res, "Work item not found", 404);
        const lockKey = getWorkItemKey(item);
        return json(res, { ...item, key: lockKey, url: buildItemUrl(lockKey) });
      }

      // POST /items/:id/unlock
      if (parts.length === 3 && parts[2] === "unlock" && method === "POST") {
        const item = unlockWorkItem(itemId);
        if (!item) return error(res, "Work item not found", 404);
        const unlockKey = getWorkItemKey(item);
        return json(res, { ...item, key: unlockKey, url: buildItemUrl(unlockKey) });
      }

      // POST /items/:id/dispatch — manually dispatch to OpenCode
      if (parts.length === 3 && parts[2] === "dispatch" && method === "POST") {
        const result = await dispatchItem(itemId);
        if ("error" in result) return error(res, result.error);
        return json(res, result);
      }

      // GET /items/:id/session — get session info
      if (parts.length === 3 && parts[2] === "session" && method === "GET") {
        const item = getWorkItem(itemId);
        if (!item) return error(res, "Work item not found", 404);
        let opencodeUrl: string | null = null;
        if (item.session_id) {
          const project = getProject(item.project_id);
          opencodeUrl = project?.working_directory
            ? buildOpencodeSessionUrl(
                item.session_id,
                project.working_directory,
              )
            : `${OPENCODE_PUBLIC_URL}/${item.session_id}`;
        }
        return json(res, {
          session_id: item.session_id,
          session_status: item.session_status,
          opencode_url: opencodeUrl,
        });
      }

      // POST /items/:id/session/abort — abort the active session
      if (
        parts.length === 4 &&
        parts[2] === "session" &&
        parts[3] === "abort" &&
        method === "POST"
      ) {
        const item = getWorkItem(itemId);
        if (!item) return error(res, "Work item not found", 404);
        if (!item.session_id)
          return error(res, "No active session for this item");
        const body = await parseBody(req);
        const reason = (body.reason as string) || "Manually aborted via API";
        const aborted = await abortSession(item.session_id, reason);
        if (!aborted)
          return error(
            res,
            "Session not found in active sessions (may already be completed)",
          );
        return json(res, { aborted: true, session_id: item.session_id });
      }

      // GET/POST /items/:id/dependencies
      if (parts.length === 3 && parts[2] === "dependencies") {
        if (method === "GET") {
          const deps = getDependencies(itemId);
          const blocked = isBlocked(itemId);
          return json(res, { blocked, dependencies: deps });
        }
        if (method === "POST") {
          const body = await parseBody(req);
          if (!body.depends_on_id)
            return error(res, "depends_on_id is required");
          try {
            const dep = addDependency(itemId, String(body.depends_on_id));
            return json(res, dep, 201);
          } catch (e) {
            return error(
              res,
              e instanceof Error ? e.message : "Failed to add dependency",
            );
          }
        }
      }

      // DELETE /items/:id/dependencies/:depends_on_id
      if (
        parts.length === 4 &&
        parts[2] === "dependencies" &&
        method === "DELETE"
      ) {
        const ok = removeDependency(itemId, decodeURIComponent(parts[3]));
        if (!ok) return error(res, "Dependency not found", 404);
        return json(res, { deleted: true });
      }

      // GET/POST /items/:id/comments
      if (parts.length === 3 && parts[2] === "comments") {
        if (method === "GET") {
          return json(res, listComments(itemId));
        }
        if (method === "POST") {
          const item = getWorkItem(itemId);
          if (!item) return error(res, "Work item not found", 404);
          const body = await parseBody(req);
          if (!body.body) return error(res, "body is required");
          try {
            const comment = createComment({
              work_item_id: itemId,
              author: body.author ? String(body.author) : "anonymous",
              body: String(body.body),
            });
            return json(res, comment, 201);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("Comment blocked")) return error(res, msg, 400);
            throw e;
          }
        }
      }

      // GET /items/:id/transitions
      if (
        parts.length === 3 &&
        parts[2] === "transitions" &&
        method === "GET"
      ) {
        return json(res, listTransitions(itemId));
      }

      // GET /items/:id/versions — description version history
      if (
        parts.length === 3 &&
        parts[2] === "versions" &&
        method === "GET"
      ) {
        const item = getWorkItem(itemId);
        if (!item) return error(res, "Work item not found", 404);
        return json(res, listDescriptionVersions(itemId));
      }

      // POST /items/:id/versions — save a description version snapshot
      if (
        parts.length === 3 &&
        parts[2] === "versions" &&
        method === "POST"
      ) {
        const item = getWorkItem(itemId);
        if (!item) return error(res, "Work item not found", 404);
        const body = await parseBody(req);
        const version = createDescriptionVersion({
          work_item_id: itemId,
          description: body.description !== undefined ? String(body.description) : item.description,
          saved_by: body.saved_by ? String(body.saved_by) : "system",
        });
        return json(res, version, 201);
      }

      // POST /items/:id/versions/:vid/revert — revert description to a specific version
      if (
        parts.length === 4 &&
        parts[2] === "versions" &&
        parts[3] === "revert" &&
        method === "POST"
      ) {
        const body = await parseBody(req);
        const versionId = body.version_id ? String(body.version_id) : "";
        if (!versionId) return error(res, "version_id is required");
        const result = revertToDescriptionVersion(
          itemId,
          versionId,
          body.actor ? String(body.actor) : "system",
        );
        if (!result) return error(res, "Work item or version not found", 404);
        const revertKey = getWorkItemKey(result.item);
        return json(res, {
          ...result.item,
          key: revertKey,
          url: buildItemUrl(revertKey),
          reverted_to_version: result.version.version,
        });
      }

      // GET /items/:id/audits — execution audit records (Section 4.6.2)
      if (
        parts.length === 3 &&
        parts[2] === "audits" &&
        method === "GET"
      ) {
        return json(res, getExecutionAudits(itemId));
      }

      // GET /items/:id/attachments — list attachments
      if (parts.length === 3 && parts[2] === "attachments" && method === "GET") {
        const item = getWorkItem(itemId);
        if (!item) return error(res, "Work item not found", 404);
        return json(res, listAttachments(itemId));
      }

      // POST /items/:id/attachments — upload file attachment (multipart/form-data)
      if (parts.length === 3 && parts[2] === "attachments" && method === "POST") {
        const item = getWorkItem(itemId);
        if (!item) return error(res, "Work item not found", 404);

        const contentType = req.headers["content-type"] || "";

        // Handle multipart/form-data uploads
        if (contentType.includes("multipart/form-data")) {
          const boundaryMatch = contentType.match(/boundary=(.+)/);
          if (!boundaryMatch) return error(res, "Missing boundary in Content-Type");

          const rawBody = await parseRawBody(req);
          const { files, fields } = parseMultipart(rawBody, boundaryMatch[1]);

          if (files.length === 0) return error(res, "No file found in upload");

          const uploadedBy = fields.find((f) => f.fieldName === "uploaded_by")?.value || "anonymous";
          const commentId = fields.find((f) => f.fieldName === "comment_id")?.value || undefined;
          const attachments = [];

          for (const file of files) {
            if (file.data.length > MAX_ATTACHMENT_SIZE) {
              return error(res, `File "${file.filename}" exceeds maximum size of ${Math.round(MAX_ATTACHMENT_SIZE / 1024 / 1024)}MB`);
            }

            const safeFilename = sanitizeFilename(file.filename);
            const storagePath = path.join("attachments", itemId, safeFilename);
            const fullPath = path.join(STORE_DIR, storagePath);

            // Ensure directory exists
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, file.data);

            const attachment = createAttachment({
              work_item_id: itemId,
              comment_id: commentId,
              filename: file.filename,
              mime_type: file.contentType,
              size_bytes: file.data.length,
              storage_path: storagePath,
              uploaded_by: uploadedBy,
            });
            attachments.push(attachment);
          }

          return json(res, attachments.length === 1 ? attachments[0] : attachments, 201);
        }

        // Handle JSON upload (base64 data) — for MCP tool usage
        if (contentType.includes("application/json")) {
          const body = await parseBody(req);
          if (!body.filename) return error(res, "filename is required");
          if (!body.data) return error(res, "data (base64) is required");

          const data = Buffer.from(String(body.data), "base64");
          if (data.length > MAX_ATTACHMENT_SIZE) {
            return error(res, `File exceeds maximum size of ${Math.round(MAX_ATTACHMENT_SIZE / 1024 / 1024)}MB`);
          }

          const safeFilename = sanitizeFilename(String(body.filename));
          const storagePath = path.join("attachments", itemId, safeFilename);
          const fullPath = path.join(STORE_DIR, storagePath);

          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, data);

          const attachment = createAttachment({
            work_item_id: itemId,
            filename: String(body.filename),
            mime_type: body.mime_type ? String(body.mime_type) : "application/octet-stream",
            size_bytes: data.length,
            storage_path: storagePath,
            uploaded_by: body.uploaded_by ? String(body.uploaded_by) : "api",
            comment_id: body.comment_id ? String(body.comment_id) : undefined,
          });

          return json(res, attachment, 201);
        }

        return error(res, "Unsupported Content-Type. Use multipart/form-data or application/json");
      }

      // ── Scheduled Task List Management ──

      // POST /items/:id/scheduled/todo — add TODO items to a scheduled task
      if (parts.length === 4 && parts[2] === "scheduled" && parts[3] === "todo" && method === "POST") {
        const item = getWorkItem(itemId);
        if (!item) return error(res, "Work item not found", 404);
        if (item.space_type !== "scheduled") {
          return error(res, `Item is not a scheduled task (space_type="${item.space_type}")`, 400);
        }

        const body = await parseBody(req);
        if (!body.items || !Array.isArray(body.items)) return error(res, "items (array of strings) is required");

        const spaceData = parseScheduledSpaceDataForApi(item);
        if (!spaceData) return error(res, "Could not parse scheduled task data", 500);

        const newItems = (body.items as unknown[]).map((i) => String(i));
        spaceData.todo.push(...newItems);

        const updated = updateWorkItem(itemId, { space_data: JSON.stringify(spaceData) });
        if (!updated) return error(res, "Failed to update work item", 500);
        return json(res, { todo: spaceData.todo, added: newItems.length, total: spaceData.todo.length });
      }

      // DELETE /items/:id/scheduled/todo — remove TODO items by indices
      if (parts.length === 4 && parts[2] === "scheduled" && parts[3] === "todo" && method === "DELETE") {
        const item = getWorkItem(itemId);
        if (!item) return error(res, "Work item not found", 404);
        if (item.space_type !== "scheduled") {
          return error(res, `Item is not a scheduled task (space_type="${item.space_type}")`, 400);
        }

        const body = await parseBody(req);
        if (!body.indices || !Array.isArray(body.indices)) return error(res, "indices (array of numbers) is required");

        const spaceData = parseScheduledSpaceDataForApi(item);
        if (!spaceData) return error(res, "Could not parse scheduled task data", 500);

        const indices = (body.indices as unknown[]).map(Number);
        const invalidIndices = indices.filter((i) => i < 0 || i >= spaceData.todo.length);
        if (invalidIndices.length > 0) {
          return error(res, `Invalid indices: ${invalidIndices.join(", ")}. TODO list has ${spaceData.todo.length} items.`, 400);
        }

        const sortedIndices = [...indices].sort((a, b) => b - a);
        const removed: string[] = [];
        for (const idx of sortedIndices) {
          removed.push(spaceData.todo[idx]);
          spaceData.todo.splice(idx, 1);
        }

        const updated = updateWorkItem(itemId, { space_data: JSON.stringify(spaceData) });
        if (!updated) return error(res, "Failed to update work item", 500);
        return json(res, { todo: spaceData.todo, removed: removed.length, total: spaceData.todo.length });
      }

      // POST /items/:id/scheduled/ignore — add IGNORE rules to a scheduled task
      if (parts.length === 4 && parts[2] === "scheduled" && parts[3] === "ignore" && method === "POST") {
        const item = getWorkItem(itemId);
        if (!item) return error(res, "Work item not found", 404);
        if (item.space_type !== "scheduled") {
          return error(res, `Item is not a scheduled task (space_type="${item.space_type}")`, 400);
        }

        const body = await parseBody(req);
        if (!body.rules || !Array.isArray(body.rules)) return error(res, "rules (array of strings) is required");

        const spaceData = parseScheduledSpaceDataForApi(item);
        if (!spaceData) return error(res, "Could not parse scheduled task data", 500);

        const newRules = (body.rules as unknown[]).map((r) => String(r));
        spaceData.ignore.push(...newRules);

        const updated = updateWorkItem(itemId, { space_data: JSON.stringify(spaceData) });
        if (!updated) return error(res, "Failed to update work item", 500);
        return json(res, { ignore: spaceData.ignore, added: newRules.length, total: spaceData.ignore.length });
      }

      // DELETE /items/:id/scheduled/ignore — remove IGNORE rules by indices
      if (parts.length === 4 && parts[2] === "scheduled" && parts[3] === "ignore" && method === "DELETE") {
        const item = getWorkItem(itemId);
        if (!item) return error(res, "Work item not found", 404);
        if (item.space_type !== "scheduled") {
          return error(res, `Item is not a scheduled task (space_type="${item.space_type}")`, 400);
        }

        const body = await parseBody(req);
        if (!body.indices || !Array.isArray(body.indices)) return error(res, "indices (array of numbers) is required");

        const spaceData = parseScheduledSpaceDataForApi(item);
        if (!spaceData) return error(res, "Could not parse scheduled task data", 500);

        const indices = (body.indices as unknown[]).map(Number);
        const invalidIndices = indices.filter((i) => i < 0 || i >= spaceData.ignore.length);
        if (invalidIndices.length > 0) {
          return error(res, `Invalid indices: ${invalidIndices.join(", ")}. IGNORE list has ${spaceData.ignore.length} rules.`, 400);
        }

        const sortedIndices = [...indices].sort((a, b) => b - a);
        const removed: string[] = [];
        for (const idx of sortedIndices) {
          removed.push(spaceData.ignore[idx]);
          spaceData.ignore.splice(idx, 1);
        }

        const updated = updateWorkItem(itemId, { space_data: JSON.stringify(spaceData) });
        if (!updated) return error(res, "Failed to update work item", 500);
        return json(res, { ignore: spaceData.ignore, removed: removed.length, total: spaceData.ignore.length });
      }

      // GET/POST /items/:id/watchers
      if (parts.length === 3 && parts[2] === "watchers") {
        if (method === "GET") {
          return json(res, listWatchers(itemId));
        }
        if (method === "POST") {
          const body = await parseBody(req);
          if (!body.entity) return error(res, "entity is required");
          const watcher = addWatcher({
            work_item_id: itemId,
            entity: String(body.entity),
            notify_via: body.notify_via ? String(body.notify_via) : undefined,
          });
          return json(res, watcher, 201);
        }
      }

      // DELETE /items/:id/watchers/:entity
      if (
        parts.length === 4 &&
        parts[2] === "watchers" &&
        method === "DELETE"
      ) {
        const ok = removeWatcher(itemId, decodeURIComponent(parts[3]));
        if (!ok) return error(res, "Watcher not found", 404);
        return json(res, { deleted: true });
      }

      // GET/PATCH/DELETE /items/:id
      if (parts.length === 2) {
        if (method === "GET") {
          const item = getWorkItem(itemId);
          if (!item) return error(res, "Work item not found", 404);
          // Enrich with key, comments, transitions, watchers, dependencies, attachments
          const key = getWorkItemKey(item);
          const comments = listComments(itemId);
          const transitions = listTransitions(itemId);
          const watchers = listWatchers(itemId);
          const dependencies = getDependencies(itemId).map((d) => ({ ...d, key: getWorkItemKey(d) }));
          const dependents = getDependents(itemId).map((d) => ({ ...d, key: getWorkItemKey(d) }));
          const blockers = getBlockers(itemId).map((d) => ({ ...d, key: getWorkItemKey(d) }));
          const blocked = blockers.length > 0;
          const attachments = listAttachments(itemId);
          return json(res, {
            ...item,
            key,
            url: buildItemUrl(key),
            comments,
            transitions,
            watchers,
            dependencies,
            dependents,
            blockers,
            blocked,
            attachments,
          });
        }
        if (method === "PATCH") {
          const body = await parseBody(req);
          if (
            body.priority &&
            !VALID_PRIORITIES.includes(body.priority as Priority)
          ) {
            return error(
              res,
              `Invalid priority. Valid: ${VALID_PRIORITIES.join(", ")}`,
            );
          }
          // Handle project move if project_id changed
          if (body.project_id) {
            const targetProject = getProject(String(body.project_id));
            if (!targetProject) return error(res, "Target project not found", 404);
            const moved = moveWorkItem(itemId, String(body.project_id), body.actor ? String(body.actor) : undefined);
            if (!moved) return error(res, "Work item not found", 404);
          }
          const item = updateWorkItem(itemId, {
            title: body.title ? String(body.title) : undefined,
            description:
              body.description !== undefined
                ? String(body.description)
                : undefined,
            priority: body.priority as Priority | undefined,
            assignee:
              body.assignee !== undefined
                ? body.assignee
                  ? String(body.assignee)
                  : ""
                : undefined,
            labels: body.labels !== undefined ? String(body.labels) : undefined,
            requires_code:
              body.requires_code !== undefined
                ? body.requires_code
                  ? 1
                  : 0
                : undefined,
            bot_dispatch:
              body.bot_dispatch !== undefined
                ? body.bot_dispatch
                  ? 1
                  : 0
                : undefined,
            platform:
              body.platform &&
              VALID_PLATFORMS.includes(body.platform as Platform)
                ? (body.platform as Platform)
                : undefined,
            date_due:
              body.date_due !== undefined
                ? (body.date_due ? String(body.date_due) : null)
                : undefined,
            link:
              body.link !== undefined
                ? (body.link ? String(body.link) : null)
                : undefined,
            space_type:
              body.space_type !== undefined
                ? String(body.space_type)
                : undefined,
            space_data:
              body.space_data !== undefined
                ? (() => {
                    const raw = typeof body.space_data === "string" ? body.space_data : JSON.stringify(body.space_data);
                    const existingItem = getWorkItem(itemId);
                    const effectiveSpaceType = body.space_type ? String(body.space_type) : existingItem?.space_type;
                    return sanitizeScheduledSpaceData(raw, effectiveSpaceType);
                  })()
                : undefined,
            actor: body.actor ? String(body.actor) : undefined,
          });
          if (!item) return error(res, "Work item not found", 404);
          const patchKey = getWorkItemKey(item);
          return json(res, { ...item, key: patchKey, url: buildItemUrl(patchKey) });
        }
        if (method === "DELETE") {
          const ok = deleteWorkItem(itemId);
          if (!ok) return error(res, "Work item not found", 404);
          return json(res, { deleted: true });
        }
      }
    }

    // ── Attachments (direct access) ──
    if (parts[0] === "attachments") {
      const attachmentId = parts[1];

      // GET /attachments/:id — serve the file
      if (parts.length === 2 && method === "GET") {
        const attachment = getAttachment(attachmentId);
        if (!attachment) return error(res, "Attachment not found", 404);

        const fullPath = path.join(STORE_DIR, attachment.storage_path);
        if (!fs.existsSync(fullPath)) return error(res, "Attachment file not found on disk", 404);

        const stat = fs.statSync(fullPath);
        const content = fs.readFileSync(fullPath);

        res.writeHead(200, {
          "Content-Type": attachment.mime_type,
          "Content-Length": stat.size.toString(),
          "Content-Disposition": `inline; filename="${attachment.filename}"`,
          "Cache-Control": "max-age=3600",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(content);
        return;
      }

      // GET /attachments/:id/meta — get metadata only
      if (parts.length === 3 && parts[2] === "meta" && method === "GET") {
        const attachment = getAttachment(attachmentId);
        if (!attachment) return error(res, "Attachment not found", 404);
        return json(res, attachment);
      }

      // DELETE /attachments/:id — delete attachment (record + file)
      if (parts.length === 2 && method === "DELETE") {
        const attachment = deleteAttachment(attachmentId);
        if (!attachment) return error(res, "Attachment not found", 404);

        // Also remove the file from disk
        const fullPath = path.join(STORE_DIR, attachment.storage_path);
        try {
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        } catch {
          // File already gone — that's fine
        }

        return json(res, { deleted: true, filename: attachment.filename });
      }
    }

    // ── Comments (direct access) ──
    if (parts[0] === "comments") {
      const commentId = parts[1];
      if (parts.length === 2 && method === "PATCH") {
        const body = await parseBody(req);
        if (!body.body) return error(res, "body is required");
        const comment = updateComment(commentId, { body: String(body.body) });
        if (!comment) return error(res, "Comment not found", 404);
        return json(res, comment);
      }
      if (parts.length === 2 && method === "DELETE") {
        const ok = deleteComment(commentId);
        if (!ok) return error(res, "Comment not found", 404);
        return json(res, { deleted: true });
      }
    }

    // ── Attention (cross-project) ──
    if (parts[0] === "attention" && parts.length === 1 && method === "GET") {
      return json(res, getAttentionItems());
    }

    // ── Overview (cross-project kanban) ──
    if (parts[0] === "overview" && parts.length === 1 && method === "GET") {
      const allProjects = listProjects();
      const projectMap = new Map(allProjects.map((p) => [p.id, p]));
      const allItems = listWorkItems({});
      const commentCounts = getCommentCounts(allItems.map((i) => i.id));
      const enriched = allItems.map((i) => {
        const proj = projectMap.get(i.project_id);
        const prefix = proj?.short_name || "???";
        const key = `${prefix}-${i.seq_number}`;
        return {
          ...i,
          key,
          url: buildItemUrl(key),
          project_name: proj?.name || "Unknown",
          project_theme: proj?.theme || "midnight",
          comment_count: commentCounts[i.id] || 0,
        };
      });
      const tracker: Record<string, typeof enriched> = {};
      for (const state of VALID_STATES) {
        tracker[state] = enriched.filter((i) => i.state === state);
      }
      return json(res, { projects: allProjects, tracker });
    }

    // ── Search ──
    if (parts[0] === "search" && method === "GET") {
      const q = params.get("q") || "";
      const filters: WorkItemFilters = {};
      if (q) filters.search = q;
      if (params.get("project_id"))
        filters.project_id = params.get("project_id")!;
      if (params.get("state"))
        filters.state = params.get("state") as WorkItemState;
      if (params.get("assignee")) filters.assignee = params.get("assignee")!;
      if (params.get("priority"))
        filters.priority = params.get("priority") as Priority;

      // Check if query matches an issue key pattern (e.g. "LIZ-50")
      // If so, do a direct key lookup (cross-project) and prepend to results
      const keyMatch = q.match(/^([A-Z]+)-(\d+)$/i);
      let results = listWorkItems(filters);
      if (keyMatch) {
        const keyItem = getWorkItemByKey(q);
        if (keyItem && !results.some((r) => r.id === keyItem.id)) {
          results = [keyItem, ...results];
        }
        // If scoped to a project but the key belongs to another project,
        // also do an unscoped text search so the key item appears
        if (keyItem && filters.project_id && keyItem.project_id !== filters.project_id) {
          const unscopedFilters = { ...filters };
          delete unscopedFilters.project_id;
          const unscopedResults = listWorkItems(unscopedFilters);
          // Merge: add any items not already in results
          for (const item of unscopedResults) {
            if (!results.some((r) => r.id === item.id)) {
              results.push(item);
            }
          }
        }
      }
      // Enrich with keys and urls
      const enriched = results.map((item) => {
        const key = getWorkItemKey(item);
        return { ...item, key, url: buildItemUrl(key) };
      });
      return json(res, enriched);
    }

    // ── Orchestrator ──
    if (parts[0] === "orchestrator") {
      if (
        parts.length === 1 &&
        parts[0] === "orchestrator" &&
        method === "GET"
      ) {
        // GET /orchestrator — alias for status
        return json(res, getOrchestratorStatus());
      }
      if (parts.length === 2 && parts[1] === "status" && method === "GET") {
        return json(res, getOrchestratorStatus());
      }
      if (parts.length === 2 && parts[1] === "pause" && method === "POST") {
        pauseOrchestrator();
        return json(res, { paused: true });
      }
      if (parts.length === 2 && parts[1] === "resume" && method === "POST") {
        resumeOrchestrator();
        return json(res, { paused: false });
      }
      // POST /orchestrator/emergency-stop (Section 4.7.1)
      if (parts.length === 2 && parts[1] === "emergency-stop" && method === "POST") {
        const body = await parseBody(req);
        const reason = body.reason ? String(body.reason) : "Emergency stop via API";
        const aborted = await emergencyStop(reason);
        return json(res, {
          stopped: true,
          sessionsAborted: aborted,
          message: `Emergency stop complete. ${aborted} session(s) aborted. Orchestrator paused.`,
        });
      }

      // GET /orchestrator/restart — check restart status and safety
      if (parts.length === 2 && parts[1] === "restart" && method === "GET") {
        return json(res, getRestartStatus());
      }

      // POST /orchestrator/restart — request a safe restart
      if (parts.length === 2 && parts[1] === "restart" && method === "POST") {
        const body = await parseBody(req);
        const result = requestSafeRestart({
          requestedBy: body.requested_by ? String(body.requested_by) : "api",
          reason: body.reason ? String(body.reason) : undefined,
          force: body.force === true,
          wait: body.wait !== false, // Default true
        });
        const statusCode = result.status === "error" ? 409 : 200;
        return json(res, result, statusCode);
      }

      // DELETE /orchestrator/restart — cancel a pending restart
      if (parts.length === 2 && parts[1] === "restart" && method === "DELETE") {
        const cancelled = cancelRestart();
        if (!cancelled) {
          return json(res, { cancelled: false, message: "No pending restart to cancel" });
        }
        return json(res, { cancelled: true, message: "Restart cancelled. Orchestrator resumed." });
      }

      // GET /orchestrator/safe-to-restart — quick check if restart is safe
      if (parts.length === 2 && parts[1] === "safe-to-restart" && method === "GET") {
        return json(res, isSafeToRestart());
      }
    }

    // ── States reference ──
    if (parts[0] === "states" && method === "GET") {
      return json(res, { states: VALID_STATES, priorities: VALID_PRIORITIES });
    }

    // ── Config (public dashboard config) ──
    if (parts[0] === "config" && parts.length === 1 && method === "GET") {
      return json(res, {
        opencodePublicUrl: OPENCODE_PUBLIC_URL,
      });
    }

    error(res, "Not found", 404);
  } catch (err) {
    logger.error({ err, method, url }, "Tracker API error");
    error(res, "Internal server error", 500);
  }
}

function serveStaticFile(res: http.ServerResponse, filePath: string): void {
  const ext = path.extname(filePath);
  const mimeTypes: Record<string, string> = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };

  const contentType = mimeTypes[ext] || "application/octet-stream";

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

// ── Server ──

export function startTrackerServer(port: number): http.Server {
  // Resolve UI directory: in dev (src/) or production (dist/)
  // From dist/api.js -> ../src/ui OR from src/api.ts -> ./ui
  let staticDir = path.join(__dirname, "..", "src", "ui");
  if (!fs.existsSync(staticDir)) {
    staticDir = path.join(__dirname, "ui");
  }

  const server = http.createServer(async (req, res) => {
    const url = req.url || "/";
    const method = req.method || "GET";

    // CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      return res.end();
    }

    // MCP endpoint
    if (url.startsWith("/mcp")) {
      return handleMcpRequest(req, res);
    }

    // API routes
    if (url.startsWith("/api/v1/")) {
      return handleApiRequest(req, res);
    }

    // ── Static file serving + SPA fallback ──
    // Short deep-link URLs like /TRACK-187 are handled entirely client-side:
    // the SPA fallback serves index.html, then handleInitialDeepLink() in
    // the JS detects the key pattern in the URL pathname and opens the item.
    // No server-side redirect needed — avoids service worker interference.
    if (method === "GET") {
      const pathname = new URL(url, "http://localhost").pathname;

      // Static files for dashboard
      let filePath: string;

      if (pathname === "/" || pathname === "/index.html") {
        filePath = path.join(staticDir, "index.html");
      } else {
        filePath = path.join(staticDir, pathname);
      }

      // Security: prevent path traversal
      if (!filePath.startsWith(staticDir)) {
        res.writeHead(403);
        return res.end("Forbidden");
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return serveStaticFile(res, filePath);
      }

      // SPA fallback: serve index.html for unmatched routes
      return serveStaticFile(res, path.join(staticDir, "index.html"));
    }

    error(res, "Not found", 404);
  });

  server.listen(port, "0.0.0.0", () => {
    logger.info({ port }, `Tracker server listening at http://0.0.0.0:${port}`);
  });

  return server;
}
