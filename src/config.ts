import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";

// ── Load .env file (if present) ──
// Simple .env loader — no dependencies. Reads key=value pairs from .env
// in the project root. Does NOT override existing environment variables.
const envPath = path.resolve(process.cwd(), ".env");
try {
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
  }
} catch {
  // Ignore .env read errors — env vars still work
}

export const PORT = parseInt(process.env.PORT || "1000", 10);
export const STORE_DIR =
  process.env.STORE_DIR || path.resolve(process.cwd(), "store");

// ── Webhook config ──

/**
 * URL to POST comment webhook notifications to (e.g. Liz's tracker channel endpoint).
 * When set, the tracker will POST a JSON payload to this URL whenever a qualifying
 * comment is created. Set via WEBHOOK_URL env var or .env file.
 */
export const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

/**
 * Shared secret for authenticating webhook payloads.
 * Both the tracker (sender) and the receiver (Liz) must have the same secret.
 * Set via WEBHOOK_SECRET env var or .env file.
 */
export const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// ── Container path translation ──

/**
 * Root directory of the assistant project on the host filesystem.
 * Used to translate container paths (e.g. /workspace/group/...) to host paths
 * when agents call tracker_upload_attachment_from_path from inside containers.
 *
 * Container mount mapping:
 *   /workspace/group   → {ASSISTANT_PROJECT_ROOT}/groups/{groupname}/
 *   /workspace/project → {ASSISTANT_PROJECT_ROOT}/
 *   /workspace/ipc     → {ASSISTANT_PROJECT_ROOT}/data/ipc/{groupname}/
 */
export const ASSISTANT_PROJECT_ROOT = (() => {
  const raw = process.env.ASSISTANT_PROJECT_ROOT || path.join(os.homedir(), "assistant");
  // Expand leading ~ to the user's home directory (shells expand ~ but Node.js does not)
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  if (raw === "~") return os.homedir();
  return raw;
})();

// ── Tracker public URL (for shareable links in MCP responses) ──

/**
 * Public-facing URL for the tracker dashboard.
 * Used by MCP tool responses to include clickable links to work items.
 * Defaults to http://localhost:{PORT} for local development.
 * Override via env var for LAN/VPN/production scenarios.
 */
export const TRACKER_PUBLIC_URL = (
  process.env.TRACKER_PUBLIC_URL || `http://localhost:${PORT}`
).replace(/\/+$/, ""); // Strip trailing slash to avoid double-slash in URLs

/**
 * Short base URL for the shortest possible deep links to tracker items.
 * When set (e.g. `http://t`), item links become `http://t/TRACK-187` instead
 * of the longer `http://localhost:1000/#/item/TRACK-187`.
 *
 * Requires setting up a DNS alias (e.g. via /etc/hosts) or a reverse proxy
 * so the short hostname resolves to the tracker server.
 *
 * Falls back to TRACKER_PUBLIC_URL if not set.
 */
export const TRACKER_SHORT_URL = (
  process.env.TRACKER_SHORT_URL || TRACKER_PUBLIC_URL
).replace(/\/+$/, "");

// ── Dynamic dashboard base URL ──

/**
 * The last base URL used by a browser to access the tracker dashboard.
 * Updated on every dashboard page load (GET / or deep-link HTML requests)
 * from the request's Host header. Persisted to disk so it survives restarts.
 *
 * When set, buildItemUrl() uses this instead of the static TRACKER_SHORT_URL,
 * so MCP responses return URLs reachable from the user's current network
 * (e.g. different VPN IPs).
 */
let _lastDashboardBaseUrl: string | null = null;
const DASHBOARD_URL_PATH = path.join(STORE_DIR, "last_dashboard_url");

// Load persisted value on startup
try {
  if (fs.existsSync(DASHBOARD_URL_PATH)) {
    const saved = fs.readFileSync(DASHBOARD_URL_PATH, "utf-8").trim();
    if (saved) _lastDashboardBaseUrl = saved;
  }
} catch {
  // Ignore read errors — fall back to static config
}

export function setLastDashboardBaseUrl(baseUrl: string): void {
  if (baseUrl === _lastDashboardBaseUrl) return;
  _lastDashboardBaseUrl = baseUrl;
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(DASHBOARD_URL_PATH, baseUrl + "\n", { mode: 0o600 });
  } catch {
    // Non-critical — URL still used for this process lifetime
  }
}

export function getLastDashboardBaseUrl(): string | null {
  return _lastDashboardBaseUrl;
}

/**
 * Build a browser-facing deep link URL to a work item in the tracker dashboard.
 * Uses the shortest possible format: {base}/{KEY}
 *
 * Prefers the last URL the user accessed the dashboard from (dynamic, persisted)
 * so MCP responses include URLs reachable on the user's current network.
 * Falls back to TRACKER_SHORT_URL if no dashboard access has been recorded.
 *
 * The server handles /{KEY} paths by redirecting to /#/item/{KEY}, so the
 * short URL works as a redirect that resolves to the full dashboard URL.
 * Example: http://192.168.50.19:1000/TRACK-187 → redirects to /#/item/TRACK-187
 */
export function buildItemUrl(key: string): string {
  const base = _lastDashboardBaseUrl || TRACKER_SHORT_URL;
  return `${base}/${encodeURIComponent(key)}`;
}

// ── Orchestrator config ──

/**
 * Server-side URL for orchestrator → OpenCode API calls.
 * Must be reachable from the tracker process (LAN IP, not a VPN tunnel address).
 */
export const OPENCODE_SERVER_URL =
  process.env.OPENCODE_SERVER_URL || "http://localhost:3000";

/**
 * Public-facing URL for browser deeplinks shown in the dashboard.
 * Defaults to OPENCODE_SERVER_URL if not set separately.
 * Use this when the server is reachable by clients via a different address
 * (e.g. a VPN tunnel address that only browsers can reach).
 */
export const OPENCODE_PUBLIC_URL =
  process.env.OPENCODE_PUBLIC_URL || process.env.OPENCODE_SERVER_URL || "http://localhost:3000";
export const ORCHESTRATOR_ENABLED =
  process.env.ORCHESTRATOR_ENABLED === "true" ||
  process.env.ORCHESTRATOR_ENABLED === "1";
export const ORCHESTRATOR_INTERVAL = parseInt(
  process.env.ORCHESTRATOR_INTERVAL || "30000",
  10,
);
export const OPENCODE_MAX_CONCURRENT = parseInt(
  process.env.OPENCODE_MAX_CONCURRENT || "3",
  10,
);

/**
 * Maximum number of concurrent OpenCode sessions per project.
 * Prevents multiple agents from working on the same project simultaneously,
 * which would cause git conflicts and file corruption.
 *
 * Default: 1 (one agent per project at a time).
 * The global OPENCODE_MAX_CONCURRENT limit still applies across all projects.
 */
export const OPENCODE_MAX_PER_PROJECT = parseInt(
  process.env.OPENCODE_MAX_PER_PROJECT || "1",
  10,
);
export const SESSION_TIMEOUT = parseInt(
  process.env.SESSION_TIMEOUT || String(45 * 60 * 1000), // 45 minutes
  10,
);

/**
 * Model to use for coder bot sessions dispatched by the orchestrator.
 * Format: "providerID/modelID" (e.g. "anthropic/claude-opus-4-6").
 * Defaults to the best available Claude model.
 */
export const CODER_MODEL_PROVIDER =
  process.env.CODER_MODEL_PROVIDER || "anthropic";
export const CODER_MODEL_ID =
  process.env.CODER_MODEL_ID || "claude-opus-4-6";

/**
 * Dispatch mode: "opencode" uses the OpenCode SDK, "runner" uses the direct
 * Claude Code Agent SDK session runner.
 */
export const DISPATCH_MODE: "opencode" | "runner" =
  (process.env.DISPATCH_MODE as "opencode" | "runner") || "opencode";

// ── Actor classification ──

/**
 * Display name used as the default assignee for owner-review states
 * (testing, needs_input, brainstorming) and human-initiated in_development.
 * Set via env var, e.g. OWNER_NAME="Alice"
 */
export const OWNER_NAME = process.env.OWNER_NAME || "Owner";

/**
 * Additional actor names classified as "human" (can approve items).
 * "dashboard" and "me" are always recognised as human.
 * Set via comma-separated env var, e.g. HUMAN_ACTORS="alice,bob"
 */
const DEFAULT_HUMAN_ACTORS = ["dashboard", "me"];
export const HUMAN_ACTORS: string[] = [
  ...DEFAULT_HUMAN_ACTORS,
  ...(process.env.HUMAN_ACTORS
    ? process.env.HUMAN_ACTORS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : []),
];

/**
 * Additional actor names classified as "agent" (AI/bot identifiers).
 * "coder" and "harmoni" are always recognised as agents.
 * Set via comma-separated env var, e.g. AGENT_ACTORS="my-bot,helper"
 */
const DEFAULT_AGENT_ACTORS = ["coder", "harmoni"];
export const AGENT_ACTORS: string[] = [
  ...DEFAULT_AGENT_ACTORS,
  ...(process.env.AGENT_ACTORS
    ? process.env.AGENT_ACTORS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : []),
];

// ── API Authentication (Section 4.8) ──

/**
 * Path to the token file within the store directory.
 * The token is persisted here so it survives restarts.
 */
const AUTH_TOKEN_PATH = path.join(STORE_DIR, "auth_token");

/**
 * Whether the token was freshly generated this startup (for logging purposes).
 */
export let AUTH_TOKEN_IS_NEW = false;

/**
 * Bearer token for authenticating API requests to the tracker.
 *
 * Resolution order:
 *  1. TRACKER_API_TOKEN environment variable
 *  2. TRACKER_API_TOKEN in ~/.config/assistant/.env
 *  3. Token file at store/auth_token (auto-generated on first run)
 */
function loadApiToken(): string {
  // 1. Check env var first
  if (process.env.TRACKER_API_TOKEN) return process.env.TRACKER_API_TOKEN;

  // 2. Try to load from ~/.config/assistant/.env
  const envPath = path.join(os.homedir(), ".config", "assistant", ".env");
  try {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      const match = content.match(/^TRACKER_API_TOKEN=(.+)$/m);
      if (match) return match[1].trim();
    }
  } catch {
    // Ignore read errors
  }

  // 3. Load from store/auth_token, creating it if it doesn't exist
  try {
    if (fs.existsSync(AUTH_TOKEN_PATH)) {
      const token = fs.readFileSync(AUTH_TOKEN_PATH, "utf-8").trim();
      if (token) return token;
    }
  } catch {
    // Fall through to generation
  }

  // Generate a new random token and persist it
  const token = crypto.randomBytes(32).toString("hex");
  try {
    // Ensure store directory exists
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(AUTH_TOKEN_PATH, token + "\n", { mode: 0o600 });
    AUTH_TOKEN_IS_NEW = true;
  } catch {
    // If we can't write the file, still use the generated token for this run
    AUTH_TOKEN_IS_NEW = true;
  }
  return token;
}

export const TRACKER_API_TOKEN = loadApiToken();

// ── Coder Bot Security (Section 4.4.3) ──

/**
 * File patterns that the coder bot should never modify.
 * These are checked post-execution and trigger alerts if violated.
 */
export const BLOCKED_PATHS: string[] = [
  "~/.ssh/",
  "~/.config/assistant/",
  "~/.gnupg/",
  "*/LaunchAgents/*.plist",
  "*/LaunchDaemons/*.plist",
  "*/.env",
  "*/container/agent-runner/src/index.ts",   // security hooks
  "*/scripts/health-check.sh",               // security monitoring
  "*/src/host-mcp-server.ts",                // MCP tool definitions
];

// ── Circuit Breaker (Section 4.7.2) ──

/**
 * Number of consecutive failures before auto-pausing the orchestrator.
 */
export const CIRCUIT_BREAKER_THRESHOLD = parseInt(
  process.env.CIRCUIT_BREAKER_THRESHOLD || "2",
  10,
);

/**
 * Time window for circuit breaker (default: 1 hour).
 */
export const CIRCUIT_BREAKER_WINDOW = parseInt(
  process.env.CIRCUIT_BREAKER_WINDOW || String(60 * 60 * 1000),
  10,
);

// ── Per-Item Retry Limit ──

/**
 * Maximum number of dispatch failures allowed for a single work item before
 * the orchestrator auto-moves it to needs_input and stops retrying.
 * This prevents a single broken item from looping indefinitely (e.g. oversized
 * attachments that will never succeed). Resets when the item state changes
 * externally (e.g. human moves it back to approved after fixing the issue).
 */
export const ITEM_DISPATCH_FAILURE_LIMIT = parseInt(
  process.env.ITEM_DISPATCH_FAILURE_LIMIT || "3",
  10,
);

// ── DeckWright config ──

/**
 * Base URL of the DeckWright presentation server.
 * Used by the presentation space plugin for thumbnail proxying and deck links.
 * Same for all decks in a given tracker installation.
 * Set via DECKWRIGHT_URL env var or .env file.
 */
export const DECKWRIGHT_URL = (
  process.env.DECKWRIGHT_URL || "http://192.168.50.19:2222"
).replace(/\/+$/, ""); // Strip trailing slash

// ── AI Categorization ──

/**
 * Anthropic API key for AI-powered item categorization.
 * When set, enables the "AI Categorize" button in the dashboard that
 * extracts title, priority, assignee, due date, and improved description
 * from freeform text using Claude Haiku.
 * Set via ANTHROPIC_API_KEY env var or .env file.
 */
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

/**
 * Model to use for AI categorization. Should be fast and cheap.
 * Default: claude-haiku-4-5-20251001 (fast, good at structured extraction).
 */
export const AI_CATEGORIZE_MODEL =
  process.env.AI_CATEGORIZE_MODEL || "claude-haiku-4-5-20251001";

// ── OpenCode deep link helpers ──

/**
 * Encode a directory path to base64url format (as used by the OpenCode web UI).
 * The OpenCode SPA routes are: /{base64url(directory)}/session/{sessionId}
 */
export function base64UrlEncode(str: string): string {
  return Buffer.from(str, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Build a browser-facing deep link URL to an OpenCode session within a specific project directory.
 * Format: {OPENCODE_PUBLIC_URL}/{base64url(directory)}/session/{sessionId}
 *
 * The OpenCode SPA client-side router expects `/:dir/session/:id` directly —
 * without the `/s/` prefix that older versions used. The server serves the SPA
 * for any unmatched path, so the route is handled client-side.
 *
 * Uses OPENCODE_PUBLIC_URL (not OPENCODE_SERVER_URL) so that dashboard links
 * point to the address reachable by browsers, which may differ from the address
 * the orchestrator uses for server-side API calls.
 */
export function buildOpencodeSessionUrl(
  sessionId: string,
  directory: string,
): string {
  const encodedDir = base64UrlEncode(directory);
  return `${OPENCODE_PUBLIC_URL}/${encodedDir}/session/${sessionId}`;
}

/**
 * Build a browser-facing deep link URL to an OpenCode directory landing page.
 * Format: {OPENCODE_PUBLIC_URL}/{base64url(directory)}/session
 *
 * This opens the OpenCode web UI showing the session list for the given directory.
 * The SPA route `/:dir/session` (without a session ID) shows the project's
 * session list. The SPA's `/:dir/` route auto-redirects to `/:dir/session`.
 *
 * Use this when you want to link to the OpenCode workspace for a project
 * without pointing to a specific session.
 */
export function buildOpencodeDirectoryUrl(directory: string): string {
  const encodedDir = base64UrlEncode(directory);
  return `${OPENCODE_PUBLIC_URL}/${encodedDir}/session`;
}

/**
 * Build a server-side API URL for creating a session via HTTP POST.
 * Format: {OPENCODE_SERVER_URL}/session?directory={directory}
 *
 * This is the REST API endpoint used by the orchestrator's SDK dispatch.
 * It is NOT a deep link — it is used for programmatic session creation.
 *
 * The distinction between this and buildOpencodeSessionUrl() is:
 * - This uses OPENCODE_SERVER_URL (server-to-server, LAN IP)
 * - buildOpencodeSessionUrl() uses OPENCODE_PUBLIC_URL (browser-facing, may be VPN)
 *
 * NOTE: Deep link dispatch (creating sessions via a URL that a browser opens)
 * is not supported by OpenCode v1.2.19. The SPA deep links are for *viewing*
 * existing sessions, not for creating new ones programmatically. Session creation
 * requires the SDK API (session.create + session.promptAsync). See TRACK-54
 * research findings for details.
 */
export function buildOpencodeApiSessionUrl(directory: string): string {
  return `${OPENCODE_SERVER_URL}/session?directory=${encodeURIComponent(directory)}`;
}
