/**
 * Tracker — Entry Point
 *
 * Standalone project management tracker with:
 * - REST API on port 1000 (0.0.0.0 for LAN access)
 * - Kanban dashboard UI
 * - Streamable HTTP MCP endpoint at /mcp
 * - OpenCode orchestrator (optional, ORCHESTRATOR_ENABLED=true)
 */

import { initTrackerDatabase } from "./db.js";
import { startTrackerServer } from "./api.js";
import { PORT, ORCHESTRATOR_ENABLED, TRACKER_API_TOKEN, AUTH_TOKEN_IS_NEW } from "./config.js";
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
