/**
 * Presentation Space Plugin — Server-Side
 *
 * Provides: presentationPlugin
 * Capabilities: versionHistory, liveRefresh
 * API routes: PATCH /items/:id/presentation/slides, PATCH /items/:id/presentation/artifact
 * Dependencies: db.ts (updateWorkItem)
 *
 * Tab-based workspace for developing presentations:
 * - Tab 1: Description (item description field, with version history)
 * - Tab 2: Slides (markdown editor for slide content, stored in space_data.slides_md)
 * - Tab 3: Artifact (iframe embed via URL, stored in space_data.artifact_url)
 * - Discussion sidebar (always visible)
 */

import { updateWorkItem } from "../db.js";
import type { SpacePlugin, SpaceApiRoute, WorkItem } from "./types.js";

// ── Data Layer ──

interface PresentationSpaceData {
  slides_md: string;
  artifact_url: string;
}

const DEFAULTS: PresentationSpaceData = {
  slides_md: "",
  artifact_url: "",
};

function parsePresentationSpaceData(raw: string | null): PresentationSpaceData {
  if (!raw) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(raw);
    return {
      slides_md: typeof parsed.slides_md === "string" ? parsed.slides_md : "",
      artifact_url: typeof parsed.artifact_url === "string" ? parsed.artifact_url : "",
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function sanitizePresentationSpaceData(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const clean: PresentationSpaceData = {
      slides_md: typeof parsed.slides_md === "string" ? parsed.slides_md : "",
      artifact_url: typeof parsed.artifact_url === "string" ? parsed.artifact_url : "",
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
  // PATCH /items/:id/presentation/slides — update slides markdown
  {
    method: "PATCH",
    path: "slides",
    handler: async (req, res, item) => {
      const body = await parseRequestBody(req);
      if (typeof body.slides_md !== "string") return errorResponse(res, "slides_md (string) is required");

      const spaceData = parsePresentationSpaceData(item.space_data);
      spaceData.slides_md = body.slides_md as string;

      const updated = updateWorkItem(item.id, { space_data: JSON.stringify(spaceData) });
      if (!updated) return errorResponse(res, "Failed to update work item", 500);
      jsonResponse(res, { slides_md: spaceData.slides_md });
    },
  },
  // PATCH /items/:id/presentation/artifact — update artifact URL
  {
    method: "PATCH",
    path: "artifact",
    handler: async (req, res, item) => {
      const body = await parseRequestBody(req);
      if (typeof body.artifact_url !== "string") return errorResponse(res, "artifact_url (string) is required");

      const spaceData = parsePresentationSpaceData(item.space_data);
      spaceData.artifact_url = body.artifact_url as string;

      const updated = updateWorkItem(item.id, { space_data: JSON.stringify(spaceData) });
      if (!updated) return errorResponse(res, "Failed to update work item", 500);
      jsonResponse(res, { artifact_url: spaceData.artifact_url });
    },
  },
];

// ── Agent Reference ──

const PRESENTATION_AGENT_REFERENCE = `## Presentation Space

Tab-based workspace for developing presentations:

- **Tab 1 (Description)** → stored in the item's \`description\` field (markdown). Used for brainstorming and overall structure.
- **Tab 2 (Slides)** → stored in \`space_data.slides_md\`. Markdown content for slide development.
- **Tab 3 (Artifact)** → stored in \`space_data.artifact_url\`. URL embedded as an iframe.
- **Discussion** → comments sidebar (always visible)

Use \`tracker_update_item\` to update description. Use the PATCH API routes or \`tracker_update_item\` with \`space_data\` to update slides/artifact.`;

// ── Plugin Export ──

export const presentationPlugin: SpacePlugin = {
  name: "presentation",
  label: "Presentation",
  icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  description: "Tab-based workspace for developing presentations",

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
