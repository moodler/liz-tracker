/**
 * Presentation Space Plugin — Server-Side
 *
 * Provides: presentationPlugin
 * Capabilities: versionHistory, liveRefresh
 * API routes: PATCH /items/:id/presentation/deck, GET /items/:id/presentation/deck-mdx
 * Dependencies: db.ts (updateWorkItem)
 *
 * Tab-based workspace for developing presentations:
 * - Tab 1: Description (item description field, with version history)
 * - Tab 2: Slides (read-only MDX viewer showing deck content from DeckWright)
 * - Tab 3: Deck (thumbnail grid from DeckWright + live preview link)
 * - Discussion sidebar (always visible)
 */

import { readFileSync } from "fs";
import { join } from "path";
import { updateWorkItem } from "../db.js";
import type { SpacePlugin, SpaceApiRoute, WorkItem } from "./types.js";

// ── Filesystem Constants ──

const DECKWRIGHT_DECKS_DIR = join(process.env.HOME || "", "deckwright", "src", "content", "decks");

// ── Data Layer ──

interface PresentationSpaceData {
  deck_slug: string;
  deck_url: string;
}

const DEFAULTS: PresentationSpaceData = {
  deck_slug: "",
  deck_url: "",
};

function parsePresentationSpaceData(raw: string | null): PresentationSpaceData {
  if (!raw) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(raw);
    return {
      deck_slug: typeof parsed.deck_slug === "string" ? parsed.deck_slug : "",
      deck_url: typeof parsed.deck_url === "string" ? parsed.deck_url : "",
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function sanitizePresentationSpaceData(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const clean: PresentationSpaceData = {
      deck_slug: typeof parsed.deck_slug === "string" ? parsed.deck_slug : "",
      deck_url: typeof parsed.deck_url === "string" ? parsed.deck_url : "",
    };
    return JSON.stringify(clean);
  } catch {
    return raw;
  }
}

// ── HTTP Helpers ──

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

// ── API Routes ──

const presentationApiRoutes: SpaceApiRoute[] = [
  // PATCH /items/:id/presentation/deck — update deck configuration
  {
    method: "PATCH",
    path: "deck",
    handler: async (req, res, item) => {
      const body = await parseRequestBody(req);

      const spaceData = parsePresentationSpaceData(item.space_data);

      if (typeof body.deck_slug === "string") spaceData.deck_slug = body.deck_slug;
      if (typeof body.deck_url === "string") spaceData.deck_url = body.deck_url;

      const updated = updateWorkItem(item.id, { space_data: JSON.stringify(spaceData) });
      if (!updated) return errorResponse(res, "Failed to update work item", 500);
      jsonResponse(res, { deck_slug: spaceData.deck_slug, deck_url: spaceData.deck_url });
    },
  },
  // GET /items/:id/presentation/deck-mdx — read deck.mdx from DeckWright content directory
  {
    method: "GET",
    path: "deck-mdx",
    handler: async (_req, res, item) => {
      const spaceData = parsePresentationSpaceData(item.space_data);
      if (!spaceData.deck_slug) {
        return jsonResponse(res, { mdx: "", error: "No deck_slug configured" });
      }

      const filepath = join(DECKWRIGHT_DECKS_DIR, spaceData.deck_slug, "deck.mdx");
      try {
        const content = readFileSync(filepath, "utf-8");
        jsonResponse(res, { mdx: content });
      } catch {
        jsonResponse(res, { mdx: "", error: `deck.mdx not found for ${spaceData.deck_slug}` });
      }
    },
  },
];

// ── Agent Reference ──

const PRESENTATION_AGENT_REFERENCE = `## Presentation Space

Tab-based workspace for developing presentations with DeckWright integration:

- **Tab 1 (Description)** → stored in the item's \`description\` field (markdown). Used for brainstorming and overall structure.
- **Tab 2 (Slides)** → read-only view of the deck's MDX source from DeckWright.
- **Tab 3 (Deck)** → thumbnail grid from DeckWright API + live preview link.
- **Discussion** → comments sidebar (always visible)

### space_data format
\`\`\`json
{
  "deck_slug": "2026-03-moodlemoot-china",
  "deck_url": "http://192.168.50.19:2222"
}
\`\`\`

- \`deck_slug\` — DeckWright deck directory name (under ~/deckwright/src/content/decks/)
- \`deck_url\` — Base URL of the DeckWright server (e.g. http://192.168.50.19:2222)

Use \`tracker_update_item\` to update description. Use the PATCH API route or \`tracker_update_item\` with \`space_data\` to update deck config.

API routes:
- \`PATCH /items/:id/presentation/deck\` — update deck_slug and/or deck_url
- \`GET /items/:id/presentation/deck-mdx\` — read deck.mdx content from DeckWright content directory`;

// ── Plugin Export ──

export const presentationPlugin: SpacePlugin = {
  name: "presentation",
  label: "Presentation",
  icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  description: "Tab-based workspace for developing presentations with DeckWright",

  capabilities: {
    versionHistory: true,
    liveRefresh: true,
  },

  agentReference: PRESENTATION_AGENT_REFERENCE,

  defaultSpaceData: () => ({ ...DEFAULTS } as unknown as Record<string, unknown>),
  parseSpaceData: (raw) => parsePresentationSpaceData(raw) as unknown as Record<string, unknown>,
  sanitizeSpaceData: (raw) => sanitizePresentationSpaceData(raw),

  apiRoutes: presentationApiRoutes,
};
