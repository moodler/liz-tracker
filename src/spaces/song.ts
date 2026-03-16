/**
 * Song Space Plugin — Server-Side
 *
 * Provides: songPlugin
 * Capabilities: coverImage, versionHistory, liveRefresh
 * API routes: none (cover image routes are shared infrastructure)
 * MCP tools: none (cover image tools are shared infrastructure)
 * Dependencies: none
 *
 * The song space is a songwriting workspace with lyrics editor,
 * conversation sidebar, and metadata bar. Cover image support is
 * handled by the shared cover image infrastructure in api.ts and
 * mcp-server.ts (which uses getCoverSpaceTypes() from the registry).
 */

import type { SpacePlugin } from "./types.js";

export const songPlugin: SpacePlugin = {
  name: "song",
  label: "Song",
  icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="18" r="3"/><circle cx="20" cy="16" r="3"/><path d="M11 18V5l9-2v13"/></svg>',
  description: "Songwriting workspace with lyrics editor and conversation",

  capabilities: {
    coverImage: true,
    versionHistory: true,
    liveRefresh: true,
  },

  defaultSpaceData: () => null,
  parseSpaceData: (raw) => raw ? JSON.parse(raw) : {},
};
