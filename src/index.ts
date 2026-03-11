/**
 * Tracker — Entry Point
 *
 * Standalone project management tracker with:
 * - REST API on port 1000 (0.0.0.0 for LAN access)
 * - Kanban dashboard UI
 * - Streamable HTTP MCP endpoint at /mcp
 * - OpenCode orchestrator (optional, ORCHESTRATOR_ENABLED=true)
 */

import { initTrackerDatabase, onTrackerEvent, getWorkItem, getWorkItemKey, getProject, classifyActor } from "./db.js";
import { startTrackerServer } from "./api.js";
import { PORT, ORCHESTRATOR_ENABLED, TRACKER_API_TOKEN, AUTH_TOKEN_IS_NEW, WEBHOOK_URL, WEBHOOK_SECRET } from "./config.js";
import { startOrchestrator, stopOrchestrator } from "./orchestrator.js";
import { logger } from "./logger.js";

logger.info("Starting Tracker...");
initTrackerDatabase();

// Log auth status — always show the token so the admin can find it in logs
logger.info("=".repeat(60));
if (AUTH_TOKEN_IS_NEW) {
  logger.info("NEW FRONTEND AUTH TOKEN GENERATED");
} else {
  logger.info("FRONTEND AUTH TOKEN (loaded from store/auth_token)");
}
logger.info("Token: %s", TRACKER_API_TOKEN);
logger.info("Enter this token in the browser to access the dashboard.");
logger.info("=".repeat(60));

const server = startTrackerServer(PORT);

if (ORCHESTRATOR_ENABLED) {
  startOrchestrator();
} else {
  logger.info("Orchestrator disabled (set ORCHESTRATOR_ENABLED=true to enable)");
}

// ── Comment Webhook (Tracker → Liz channel) ──

if (WEBHOOK_URL) {
  startCommentWebhook();
  logger.info({ url: WEBHOOK_URL }, "Comment webhook enabled");
} else {
  logger.info("Comment webhook disabled (set WEBHOOK_URL to enable)");
}

/**
 * Fire webhook notifications to Liz when qualifying comments are created.
 *
 * Qualifying criteria:
 * 1. Any comment by a human on a NON-ORCHESTRATION project (e.g. Writing, Martin)
 * 2. Any comment on ANY issue by anyone (except Harmoni/bots) that includes @harmoni
 *
 * The webhook payload includes issue key, author, comment body, and space_type
 * so Liz can route it to Harmoni with full context.
 */
function startCommentWebhook(): void {
  onTrackerEvent((event) => {
    if (event.type !== "comment.created") return;

    const { actor, work_item_id } = event;
    const body = (event.data.body as string) || "";
    const actorClass = classifyActor(actor);

    // Never forward bot/agent/system comments (loop prevention)
    if (actorClass === "agent" || actorClass === "system") return;

    const item = getWorkItem(work_item_id);
    if (!item) return;

    const project = getProject(item.project_id);
    if (!project) return;

    const key = getWorkItemKey(item);

    // Check qualifying criteria
    const isNonOrchestrationProject = project.orchestration === 0;
    const hasMention = /@harmoni\b/i.test(body);

    if (!isNonOrchestrationProject && !hasMention) return;

    // Build and send webhook payload
    const payload = {
      type: "comment.created",
      issue_key: key,
      item_id: item.id,
      project_id: project.id,
      project_name: project.name,
      author: actor,
      body,
      space_type: item.space_type || "standard",
      space_data: item.space_data,
      title: item.title,
      state: item.state,
      timestamp: event.timestamp,
    };

    // Fire and forget — don't block the event loop
    fireWebhook(payload).catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err), key }, "Webhook delivery failed");
    });
  });
}

async function fireWebhook(payload: Record<string, unknown>): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (WEBHOOK_SECRET) {
    headers["X-Webhook-Secret"] = WEBHOOK_SECRET;
  }

  const response = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`Webhook returned ${response.status}: ${response.statusText}`);
  }

  logger.debug({ key: payload.issue_key }, "Webhook delivered");
}

// ── Graceful Shutdown ──

/**
 * Handle SIGTERM (from launchctl kickstart -k) and SIGINT (Ctrl+C).
 * Cleanly stops the orchestrator and closes the HTTP server before exiting.
 * This ensures that in-flight requests complete and the orchestrator's
 * SSE connection is properly closed.
 */
function gracefulShutdown(signal: string): void {
  logger.info({ signal }, "Received shutdown signal — shutting down gracefully");

  // Stop the orchestrator first (clears intervals, closes SSE)
  stopOrchestrator();

  // Close the HTTP server (stop accepting new connections, let in-flight finish)
  server.close((err) => {
    if (err) {
      logger.error({ err }, "Error closing HTTP server");
    } else {
      logger.info("HTTP server closed");
    }
    process.exit(0);
  });

  // Force exit after 5 seconds if graceful shutdown takes too long
  setTimeout(() => {
    logger.warn("Graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
