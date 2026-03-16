/**
 * Space Plugin Registration Manifest
 *
 * This is the ONLY file that knows which space plugins exist.
 * Adding a new space = add one import + one registerSpace() call here.
 *
 * Import this module early in the application startup (before the API
 * server and MCP server are created) to ensure all plugins are registered.
 */

import { registerSpace } from "./registry.js";
import { standardPlugin } from "./standard.js";
import { songPlugin } from "./song.js";
import { textPlugin } from "./text.js";
import { engagementPlugin } from "./engagement.js";
import { scheduledPlugin } from "./scheduled.js";
import { travelPlugin } from "./travel.js";

registerSpace(standardPlugin);
registerSpace(songPlugin);
registerSpace(textPlugin);
registerSpace(engagementPlugin);
registerSpace(scheduledPlugin);
registerSpace(travelPlugin);

// Re-export registry functions for convenience
export { registerSpace, getSpacePlugin, listSpacePlugins, getSpaceTypes, getCoverSpaceTypes } from "./registry.js";
export type { SpacePlugin, SpaceApiRoute, SpaceMcpTool, WorkItem, McpResult } from "./types.js";
