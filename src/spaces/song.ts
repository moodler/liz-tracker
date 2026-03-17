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

const SONG_AGENT_REFERENCE = `## Song Space

Dedicated songwriting workspace. Data is stored across several fields:

- **Lyrics** → stored in the item's \`description\` field (plain text, editable in the lyrics pane)
- **Cover image** → uploaded as an attachment named \`cover.jpg\`, \`cover.png\`, or \`cover.webp\`. Upload/replace via \`tracker_set_cover_image\` or \`tracker_set_cover_image_from_path\`.
- **Style description** → uploaded as an attachment named \`styles.md\` (plain text describing musical style, mood, instrumentation, vocal approach)
- **Link** → stored in the item's \`link\` field (e.g. a link to the song recording, demo, or reference)
- **Version history** → description snapshots are saved as versions (navigable in the UI)

### Creating/Updating Songs

\`\`\`
tracker_create_item(project_id="...", title="Song Title", space_type="song", description="Verse 1 lyrics...")
tracker_update_item(item_id="...", description="Updated lyrics...", link="https://...")
tracker_set_cover_image(item_id="...", data=<base64 of image>)
tracker_upload_attachment(item_id="...", filename="styles.md", data=<base64 of text>, mime_type="text/plain")
\`\`\``;

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

  agentReference: SONG_AGENT_REFERENCE,

  defaultSpaceData: () => null,
  parseSpaceData: (raw) => raw ? JSON.parse(raw) : {},
};
