/**
 * Space Plugin Types — Server-Side
 *
 * Defines the SpacePlugin interface (the contract for all space types),
 * plus SpaceApiRoute and SpaceMcpTool types for extending the REST API
 * and MCP tool surface.
 *
 * Each space type implements this interface in a single co-located file
 * (e.g. scheduled.ts, engagement.ts). Registration happens explicitly
 * in ./index.ts — no auto-discovery.
 */

import type http from "http";
import type { z } from "zod";
import type { WorkItem } from "../db.js";

// Re-export WorkItem so plugins can import from a single location
export type { WorkItem } from "../db.js";

/** Result shape returned by MCP tool handlers. */
export interface McpResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
}

/**
 * A single REST API sub-route contributed by a space plugin.
 *
 * Routes are mounted under /api/v1/items/:id/{spaceName}/{path}
 * e.g. a route with path="todo" on the "scheduled" plugin becomes
 * POST /api/v1/items/:id/scheduled/todo
 */
export interface SpaceApiRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  handler: (req: http.IncomingMessage, res: http.ServerResponse, item: WorkItem) => void | Promise<void>;
}

/**
 * A single MCP tool contributed by a space plugin.
 *
 * The schema is a Zod object used for input validation.
 * The handler receives the validated args, the resolved work item,
 * and a reference to the owning plugin.
 */
export interface SpaceMcpTool {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>, item: WorkItem, plugin: SpacePlugin) => Promise<McpResult>;
}

/**
 * The SpacePlugin interface — the contract every space type must implement.
 *
 * Identity fields (name, label, icon, description) are used by the UI
 * registry and the /spaces API endpoint.
 *
 * Capabilities flags control which shared features are enabled for this space.
 *
 * Data layer methods handle parsing and sanitizing the opaque space_data JSON blob.
 *
 * Server extensions (apiRoutes, mcpTools) are dynamically registered
 * by the generic dispatchers in api.ts and mcp-server.ts.
 */
export interface SpacePlugin {
  // ── Identity ──
  /** Unique name matching the space_type column in DB (e.g. "scheduled"). */
  name: string;
  /** Human-readable display name (e.g. "Scheduled"). */
  label: string;
  /** SVG string for the UI icon. */
  icon: string;
  /** Human-readable one-liner description. */
  description: string;

  // ── Capabilities ──
  capabilities: {
    /** Supports cover images? */
    coverImage?: boolean;
    /** Uses description versioning? */
    versionHistory?: boolean;
    /** Supports live SSE refresh in the overlay? */
    liveRefresh?: boolean;
  };

  // ── Data Layer ──
  /** Return default space_data for newly created items, or null. */
  defaultSpaceData(): Record<string, unknown> | null;
  /** Parse the raw space_data JSON string into a structured object. */
  parseSpaceData(raw: string | null): Record<string, unknown>;
  /** Optional: sanitize/coerce incoming space_data before storage. */
  sanitizeSpaceData?(raw: string): string;

  // ── Agent Reference ──
  /**
   * Markdown string providing comprehensive agent-facing documentation
   * for this space type. Returned by the tracker_agent_reference MCP tool.
   * Should include data formats, examples, and important caveats.
   * Omit for spaces with no complex data formats (e.g. standard, text).
   */
  agentReference?: string;

  // ── Server Extensions ──
  /** REST API routes under /items/:id/{name}/... */
  apiRoutes?: SpaceApiRoute[];
  /** MCP tool definitions. */
  mcpTools?: SpaceMcpTool[];
}
