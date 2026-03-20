/**
 * Session Runner — standalone script that runs Claude Code via the Agent SDK.
 *
 * Communicates with the orchestrator via stdin/stdout JSON lines.
 * Spawned as a child process by the orchestrator when DISPATCH_MODE=runner.
 *
 * Protocol:
 *   stdin:  RunnerConfig (first line), then RunnerSteerMessage / RunnerAbortMessage
 *   stdout: RunnerEvent JSON lines
 *   stderr: SDK subprocess output + runner errors
 */

import { randomBytes } from "crypto";
import { createInterface } from "readline";
import type {
  RunnerConfig,
  RunnerEvent,
  RunnerIncomingMessage,
  RunnerStartedEvent,
  RunnerCompletedEvent,
  RunnerErrorEvent,
  RunnerToolUseEvent,
  RunnerToolResultEvent,
  RunnerTextEvent,
  RunnerStatusEvent,
  RunnerHeartbeatEvent,
} from "./runner-types.js";
import type {
  SDKMessage,
  SDKSystemMessage,
  SDKAssistantMessage,
  SDKToolProgressMessage,
  SDKToolUseSummaryMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKStatusMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

// ── Message mapping ──────────────────────────────────────────────────────────

/**
 * Maps an SDK message to zero or more RunnerEvent objects.
 * Exported for testing.
 */
export function mapSdkMessage(
  msg: SDKMessage,
  elapsedSeconds?: number,
  turnCount?: number,
): RunnerEvent[] {
  switch (msg.type) {
    case "system": {
      // SDKSystemMessage (init) vs SDKStatusMessage (status) — both have type: "system"
      const sysMsg = msg as SDKSystemMessage | SDKStatusMessage;
      if (sysMsg.subtype === "init") {
        const initMsg = sysMsg as SDKSystemMessage;
        const sessionId = `runner_${randomBytes(8).toString("hex")}`;
        const ev: RunnerStartedEvent = {
          event: "started",
          sessionId,
          sdkSessionId: initMsg.session_id,
          pid: process.pid,
        };
        return [ev];
      }
      if (sysMsg.subtype === "status") {
        const statusMsg = sysMsg as SDKStatusMessage;
        const ev: RunnerStatusEvent = {
          event: "status",
          status: statusMsg.status ?? "idle",
        };
        return [ev];
      }
      // Other system subtypes (task_notification, task_progress, etc.) — ignore
      return [];
    }

    case "assistant": {
      const assistMsg = msg as SDKAssistantMessage;
      const textBlocks = (assistMsg.message.content as any[])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text as string);
      if (textBlocks.length === 0) return [];
      const ev: RunnerTextEvent = {
        event: "text",
        content: textBlocks.join("\n"),
      };
      return [ev];
    }

    case "tool_progress": {
      const tpMsg = msg as SDKToolProgressMessage;
      const ev: RunnerToolUseEvent = {
        event: "tool_use",
        tool: tpMsg.tool_name,
        elapsed: tpMsg.elapsed_time_seconds,
      };
      return [ev];
    }

    case "tool_use_summary": {
      const tusMsg = msg as SDKToolUseSummaryMessage;
      const parsed = parseToolSummary(tusMsg.summary);
      const ev: RunnerToolResultEvent = {
        event: "tool_result",
        tool: parsed.tool,
        status: parsed.status,
        ...(parsed.error ? { error: parsed.error } : {}),
      };
      return [ev];
    }

    case "result": {
      const resultMsg = msg as SDKResultSuccess | SDKResultError;
      if (resultMsg.subtype === "success") {
        const ev: RunnerCompletedEvent = {
          event: "completed",
          result: "success",
          duration: elapsedSeconds ?? Math.round(resultMsg.duration_ms / 1000),
          turns: turnCount ?? resultMsg.num_turns,
          cost: resultMsg.total_cost_usd,
        };
        return [ev];
      }
      // Error subtypes
      const errMsg = resultMsg as SDKResultError;
      const ev: RunnerErrorEvent = {
        event: "error",
        message: errMsg.errors.join("; "),
        recoverable: false,
      };
      return [ev];
    }

    default:
      return [];
  }
}

// ── Summary parser ───────────────────────────────────────────────────────────

/**
 * Parse a tool_use_summary string like "Read(src/index.ts): success" or
 * "Bash(npm test): error - Process exited with code 1".
 */
function parseToolSummary(summary: string): {
  tool: string;
  status: "success" | "error";
  error?: string;
} {
  // Try pattern: ToolName(...): status [- detail]
  const match = summary.match(/^(\w+)\([^)]*\):\s*(success|error)(?:\s*-\s*(.*))?/);
  if (match) {
    return {
      tool: match[1]!,
      status: match[2] as "success" | "error",
      error: match[3] || undefined,
    };
  }

  // Check if "error" appears anywhere in the summary
  const hasError = /\berror\b/i.test(summary);
  return {
    tool: "unknown",
    status: hasError ? "error" : "success",
  };
}

// ── Stdin helpers ────────────────────────────────────────────────────────────

/**
 * Read the first JSON line from stdin — must be a RunnerConfig.
 */
export function readConfig(): Promise<RunnerConfig> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const timeout = setTimeout(() => {
      rl.close();
      reject(new Error("Timeout waiting for config on stdin"));
    }, 30_000);

    rl.once("line", (line) => {
      clearTimeout(timeout);
      rl.close();
      try {
        const parsed = JSON.parse(line) as RunnerIncomingMessage;
        if (parsed.event !== "config") {
          reject(new Error(`Expected config event, got: ${parsed.event}`));
          return;
        }
        resolve(parsed as RunnerConfig);
      } catch (err) {
        reject(new Error(`Invalid JSON on stdin: ${err}`));
      }
    });

    rl.once("close", () => {
      clearTimeout(timeout);
    });
  });
}

// ── Stdout helper ────────────────────────────────────────────────────────────

/**
 * Write a RunnerEvent as a JSON line to stdout.
 */
export function emit(event: RunnerEvent): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  let config: RunnerConfig;
  try {
    config = await readConfig();
  } catch (err) {
    process.stderr.write(`[session-runner] Failed to read config: ${err}\n`);
    process.exit(1);
    return; // unreachable, but helps TypeScript
  }

  // Dynamic import to avoid loading SDK at module level (helps testing)
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const abortController = new AbortController();
  const startTime = Date.now();
  let turnCount = 0;

  // Set up heartbeat timer
  const heartbeatInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const hb: RunnerHeartbeatEvent = {
      event: "heartbeat",
      elapsed,
      turns: turnCount,
    };
    emit(hb);
  }, 30_000);

  // Set up stdin listener for steer/abort messages (after config is consumed)
  const stdinRl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queryHandle: Awaited<ReturnType<typeof query>> | null = null;

  // Queue for steering messages — converted to an async iterable for streamInput
  const steerQueue: SDKUserMessage[] = [];
  let steerResolve: (() => void) | null = null;

  stdinRl.on("line", (line) => {
    try {
      const msg = JSON.parse(line) as RunnerIncomingMessage;
      if (msg.event === "abort") {
        process.stderr.write("[session-runner] Received abort\n");
        abortController.abort();
      } else if (msg.event === "steer" && queryHandle) {
        const userMsg: SDKUserMessage = {
          type: "user",
          message: {
            role: "user",
            content: msg.message,
          },
          parent_tool_use_id: null,
          session_id: "",
        };
        steerQueue.push(userMsg);
        if (steerResolve) {
          steerResolve();
          steerResolve = null;
        }
      }
    } catch {
      // Ignore malformed stdin lines
    }
  });

  try {
    // Build MCP server config — include tracker MCP if URL provided
    const mcpServers: Record<string, any> = {};
    if (config.trackerMcpUrl) {
      mcpServers["tracker"] = { type: "http", url: config.trackerMcpUrl };
    }

    const q = query({
      prompt: config.prompt,
      options: {
        cwd: config.cwd,
        model: config.model,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: false,
        maxTurns: config.maxTurns,
        persistSession: true,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: config.systemPromptAppend,
        },
        abortController,
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      },
    });
    queryHandle = q;

    // Process SDK messages
    for await (const msg of q) {
      const events = mapSdkMessage(
        msg,
        Math.round((Date.now() - startTime) / 1000),
        turnCount,
      );

      for (const ev of events) {
        emit(ev);
      }

      // Count turns from assistant messages
      if (msg.type === "assistant") {
        turnCount++;
      }
    }

    // If we got through the loop without a result event, emit completed
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    // The for-await loop ends after the result message is yielded,
    // so we don't need a fallback completed event here.
  } catch (err: any) {
    const errEvent: RunnerErrorEvent = {
      event: "error",
      message: err.message || String(err),
      recoverable: false,
    };
    emit(errEvent);
  } finally {
    clearInterval(heartbeatInterval);
    stdinRl.close();
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

// Only run main() when executed directly (not imported for testing)
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("session-runner.ts") ||
    process.argv[1].endsWith("session-runner.js"));

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`[session-runner] Fatal: ${err}\n`);
    process.exit(1);
  });
}
