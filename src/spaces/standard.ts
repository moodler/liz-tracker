/**
 * Standard Space Plugin — Server-Side
 *
 * Provides: standardPlugin
 * Capabilities: none (uses default tracker detail panel)
 * Dependencies: none
 *
 * The standard space is the default — it has no custom routes, tools,
 * or space_data. Items with space_type="standard" open the normal
 * detail panel instead of a space overlay.
 */

import type { SpacePlugin } from "./types.js";

export const standardPlugin: SpacePlugin = {
  name: "standard",
  label: "Standard",
  icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 6h6M9 10h6M9 14h4"/></svg>',
  description: "Default tracker item view",

  capabilities: {},

  defaultSpaceData: () => null,
  parseSpaceData: (raw) => raw ? JSON.parse(raw) : {},
};
