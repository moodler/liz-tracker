/**
 * Text Space Plugin — Server-Side
 *
 * Provides: textPlugin
 * Capabilities: versionHistory, liveRefresh
 * Dependencies: none
 *
 * The text space is a writing workspace for articles, blogs, and long-form
 * text. It has no server-side routes or MCP tools — all functionality is
 * in the UI renderer. Description versions are handled by the shared
 * /items/:id/versions endpoints.
 */

import type { SpacePlugin } from "./types.js";

export const textPlugin: SpacePlugin = {
  name: "text",
  label: "Text",
  icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 10h16M4 14h10M4 18h12"/></svg>',
  description: "Writing workspace for articles, blogs, and long-form text",

  capabilities: {
    versionHistory: true,
    liveRefresh: true,
  },

  defaultSpaceData: () => null,
  parseSpaceData: (raw) => raw ? JSON.parse(raw) : {},
};
