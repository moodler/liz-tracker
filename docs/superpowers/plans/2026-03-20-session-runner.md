# Session Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace OpenCode with a direct Claude Code Agent SDK session runner, dispatched as a child process with stdio JSON communication.

**Architecture:** The orchestrator spawns `session-runner.ts` as a child process per work item. The runner uses the Agent SDK's `query()` to execute Claude Code, emitting structured JSON events on stdout. The orchestrator reads these events into the existing session state machine. A `DISPATCH_MODE` config switch selects between the new runner and the existing OpenCode path.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk` (^0.2.25), Node.js child_process, Vitest, SSE (server-sent events)

**Spec:** `docs/superpowers/specs/2026-03-20-session-runner-design.md`

---

## Implementation Notes (Read First)

The following corrections apply to code snippets throughout the plan. The implementor MUST apply these when implementing each task:

1. **SDK field names:** The Agent SDK uses `total_cost_usd` (not `totalCost`), and `SDKResultError` subtypes are `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries` (not `error_unknown`). Fix tests and `mapSdkMessage` accordingly.

2. **`SDKToolUseSummaryMessage` shape:** This type only has `{ summary: string, preceding_tool_use_ids: string[] }` — no `tool_name` or `error` fields. Map `tool_use_summary` events by parsing the summary string or emitting a generic tool_result.

3. **`dispatch()` takes one argument:** The existing `dispatch(item: WorkItem)` and `dispatchForClarification(item: WorkItem)` resolve the project internally. `dispatchViaRunner` should follow the same single-arg signature, looking up the project inside the function.

4. **API routing is raw Node.js HTTP, not Express:** `api.ts` uses manual path-segment matching (`parts.length === N && parts[N] === "..."`) — not Express routers. Translate the plan's `router.get()`/`router.post()` syntax to the existing pattern.

5. **DB access in orchestrator uses named exports, not raw `db`:** Use existing functions like `getWorkItem()`, `setSessionInfo()`, etc. For `recoverRunnerSessions`, add a new query helper in `db.ts` or use existing patterns. Use `unlockWorkItem` (not `unlockItem`).

6. **Attachments must use SDK multi-part prompt:** The SDK's `query()` accepts `prompt: string | AsyncIterable<SDKUserMessage>`. To include image attachments, pass an `SDKUserMessage` with multi-part content (text + image blocks) rather than a plain string. The `buildPromptParts` helper in session-runner.ts should construct the proper SDK message format.

7. **Research prompts need handling:** `dispatchForClarification` uses `buildResearchPrompt()` not `buildPrompt()`. Add a `promptType` parameter to the runner config (`"coder" | "research"`) and call the appropriate prompt builder. Or create `buildResearchPromptParts()` alongside `buildPromptParts()`.

8. **SDK session ID capture:** In `mapSdkMessage` for the `system/init` event, capture `msg.session_id` and include it in the `started` event as `sdkSessionId` so the orchestrator can store it for future session resume.

9. **Heartbeat display filter:** The dashboard heartbeat filter `event.elapsed % 150` is arbitrary. Use `event.elapsed % 120 === 0` (show every 2 minutes) or filter by turn count instead.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/session-runner.ts` | Create | Standalone runner script — Agent SDK execution, stdio JSON protocol |
| `src/runner-types.ts` | Create | Shared types for runner events and config (used by both runner and orchestrator) |
| `src/config.ts` | Modify | Add `DISPATCH_MODE`, runner-mode validation |
| `src/orchestrator.ts` | Modify | Add `dispatchViaRunner()`, event stream parser, child process management, session recovery |
| `src/api.ts` | Modify | Add SSE events endpoint, steer endpoint, update session info endpoint |
| `src/ui/core.html` | Modify | Add session viewer panel to item detail |
| `package.json` | Modify | Add `@anthropic-ai/claude-agent-sdk` dependency |
| `src/session-runner.test.ts` | Create | Runner unit tests |
| `src/orchestrator.test.ts` | Modify | Runner dispatch integration tests |
| `CLAUDE.md` | Modify | Document runner mode |

---

### Task 1: Add Dependency and Shared Types

**Files:**
- Modify: `package.json`
- Create: `src/runner-types.ts`

- [ ] **Step 1: Install the Agent SDK**

```bash
npm install @anthropic-ai/claude-agent-sdk@^0.2.25
```

- [ ] **Step 2: Create `src/runner-types.ts` with the shared types**

```typescript
// Runner event types emitted on stdout (runner → orchestrator)
export interface RunnerStartedEvent {
  event: "started";
  sessionId: string;
  pid: number;
}

export interface RunnerToolUseEvent {
  event: "tool_use";
  tool: string;
  file?: string;
  elapsed?: number;
}

export interface RunnerToolResultEvent {
  event: "tool_result";
  tool: string;
  status: "success" | "error";
  error?: string;
}

export interface RunnerTextEvent {
  event: "text";
  content: string;
}

export interface RunnerStatusEvent {
  event: "status";
  status: string;
}

export interface RunnerHeartbeatEvent {
  event: "heartbeat";
  elapsed: number;
  turns: number;
}

export interface RunnerCompletedEvent {
  event: "completed";
  result: "success" | "error";
  duration: number;
  turns: number;
  cost?: number;
}

export interface RunnerErrorEvent {
  event: "error";
  message: string;
  recoverable: boolean;
}

export type RunnerEvent =
  | RunnerStartedEvent
  | RunnerToolUseEvent
  | RunnerToolResultEvent
  | RunnerTextEvent
  | RunnerStatusEvent
  | RunnerHeartbeatEvent
  | RunnerCompletedEvent
  | RunnerErrorEvent;

// Config sent on stdin (orchestrator → runner)
export interface RunnerConfig {
  event: "config";
  itemKey: string;
  prompt: string;
  systemPromptAppend: string;
  cwd: string;
  model: string;
  maxTurns: number;
  attachments: Array<{ path: string; mime: string; filename: string }>;
}

// Steering message sent on stdin (orchestrator → runner)
export interface RunnerSteerMessage {
  event: "steer";
  message: string;
}

// Abort message sent on stdin (orchestrator → runner)
export interface RunnerAbortMessage {
  event: "abort";
}

export type RunnerIncomingMessage = RunnerConfig | RunnerSteerMessage | RunnerAbortMessage;
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json src/runner-types.ts
git commit -m "feat: add Agent SDK dependency and runner shared types"
```

---

### Task 2: Add `DISPATCH_MODE` Config

**Files:**
- Modify: `src/config.ts:111-159` (near OPENCODE_SERVER_URL and CODER_MODEL_ID)

- [ ] **Step 1: Write failing test for DISPATCH_MODE parsing**

Add to `src/orchestrator.test.ts`:

```typescript
describe("DISPATCH_MODE config", () => {
  it("defaults to opencode", () => {
    // DISPATCH_MODE not set in test env
    expect(DISPATCH_MODE).toBe("opencode");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --reporter=verbose 2>&1 | grep -A2 "DISPATCH_MODE"`
Expected: FAIL — `DISPATCH_MODE` is not exported from config.ts

- [ ] **Step 3: Add DISPATCH_MODE to config.ts**

Add after `CODER_MODEL_ID` (around line 159 of `src/config.ts`):

```typescript
/**
 * Dispatch mode: "opencode" uses the OpenCode SDK, "runner" uses the direct
 * Claude Code Agent SDK session runner.
 */
export const DISPATCH_MODE: "opencode" | "runner" =
  (process.env.DISPATCH_MODE as "opencode" | "runner") || "opencode";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --reporter=verbose 2>&1 | grep -A2 "DISPATCH_MODE"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/orchestrator.test.ts
git commit -m "feat: add DISPATCH_MODE config (opencode|runner)"
```

---

### Task 3: Build the Session Runner — Core Event Loop

**Files:**
- Create: `src/session-runner.ts`
- Create: `src/session-runner.test.ts`

This is the heart of the feature. The runner reads config from stdin, runs the Agent SDK, and emits JSON events on stdout.

- [ ] **Step 1: Write failing test for runner event parsing**

Create `src/session-runner.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mapSdkMessage } from "./session-runner.js";

describe("mapSdkMessage", () => {
  it("maps system init message to started event", () => {
    const sdkMsg = {
      type: "system",
      subtype: "init",
      session_id: "ses_abc",
      tools: [],
      cwd: "/tmp",
      model: "opus",
    };
    const events = mapSdkMessage(sdkMsg as any);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "started",
      sessionId: expect.stringMatching(/^runner_/),
    });
  });

  it("maps result success to completed event", () => {
    const sdkMsg = {
      type: "result",
      subtype: "success",
      result: "done",
      totalCost: 0.05,
    };
    const events = mapSdkMessage(sdkMsg as any, 120, 5);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "completed",
      result: "success",
      duration: 120,
      turns: 5,
      cost: 0.05,
    });
  });

  it("maps result error to error event", () => {
    const sdkMsg = {
      type: "result",
      subtype: "error_unknown",
      errors: ["Something went wrong"],
    };
    const events = mapSdkMessage(sdkMsg as any);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "error",
      message: "Something went wrong",
      recoverable: false,
    });
  });

  it("maps assistant message text blocks to text events", () => {
    const sdkMsg = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "I'll fix that bug" },
          { type: "tool_use", id: "t1", name: "Edit", input: {} },
        ],
      },
    };
    const events = mapSdkMessage(sdkMsg as any);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "text",
      content: "I'll fix that bug",
    });
  });

  it("maps tool_progress to tool_use event", () => {
    const sdkMsg = {
      type: "tool_progress",
      tool_name: "Bash",
      elapsed_time_seconds: 3.2,
    };
    const events = mapSdkMessage(sdkMsg as any);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "tool_use",
      tool: "Bash",
      elapsed: 3.2,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/session-runner.test.ts --reporter=verbose`
Expected: FAIL — `mapSdkMessage` not found

- [ ] **Step 3: Implement the session runner**

Create `src/session-runner.ts`:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomBytes } from "crypto";
import { readFileSync, existsSync, statSync } from "fs";
import { createInterface } from "readline";
import type { RunnerEvent, RunnerConfig, RunnerIncomingMessage } from "./runner-types.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_EMBED_SIZE = 4.5 * 1024 * 1024;

// Generate a unique runner session ID
function generateSessionId(): string {
  return `runner_${randomBytes(12).toString("hex")}`;
}

/**
 * Map an SDK message to zero or more RunnerEvents.
 * Exported for testing.
 */
export function mapSdkMessage(
  msg: any,
  elapsedSeconds?: number,
  turnCount?: number,
): RunnerEvent[] {
  const events: RunnerEvent[] = [];

  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        events.push({
          event: "started",
          sessionId: generateSessionId(),
          pid: process.pid,
        });
      } else if (msg.subtype === "status" && msg.status) {
        events.push({ event: "status", status: msg.status });
      }
      break;

    case "assistant": {
      const textBlocks = msg.message?.content?.filter(
        (b: any) => b.type === "text" && b.text,
      );
      if (textBlocks?.length) {
        const combined = textBlocks.map((b: any) => b.text).join("");
        if (combined.trim()) {
          events.push({ event: "text", content: combined });
        }
      }
      break;
    }

    case "tool_progress":
      events.push({
        event: "tool_use",
        tool: msg.tool_name || "unknown",
        elapsed: msg.elapsed_time_seconds,
      });
      break;

    case "tool_use_summary":
      events.push({
        event: "tool_result",
        tool: msg.tool_name || "unknown",
        status: msg.error ? "error" : "success",
        error: msg.error,
      });
      break;

    case "result":
      if (msg.subtype === "success") {
        events.push({
          event: "completed",
          result: "success",
          duration: elapsedSeconds ?? 0,
          turns: turnCount ?? 0,
          cost: msg.totalCost,
        });
      } else {
        const errorMsg = Array.isArray(msg.errors)
          ? msg.errors.join("; ")
          : "Unknown error";
        events.push({
          event: "error",
          message: errorMsg,
          recoverable: false,
        });
      }
      break;
  }

  return events;
}

/** Emit a RunnerEvent as a JSON line on stdout. */
function emit(event: RunnerEvent): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

/** Read a single JSON line from stdin (blocking until newline). */
async function readConfig(): Promise<RunnerConfig> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.once("line", (line) => {
      rl.close();
      try {
        const parsed = JSON.parse(line);
        if (parsed.event !== "config") {
          reject(new Error(`Expected config event, got: ${parsed.event}`));
        } else {
          resolve(parsed as RunnerConfig);
        }
      } catch (err) {
        reject(new Error(`Failed to parse config: ${err}`));
      }
    });
    rl.once("error", reject);
  });
}

/** Build prompt parts array (text + image attachments). */
function buildPromptParts(
  config: RunnerConfig,
): Array<{ type: string; text?: string; mime?: string; filename?: string; url?: string }> {
  const parts: Array<any> = [{ type: "text", text: config.prompt }];

  for (const att of config.attachments ?? []) {
    if (!existsSync(att.path)) continue;
    const stat = statSync(att.path);
    if (stat.size > MAX_EMBED_SIZE) continue;
    const data = readFileSync(att.path);
    parts.push({
      type: "file",
      mime: att.mime,
      filename: att.filename,
      url: `data:${att.mime};base64,${data.toString("base64")}`,
    });
  }

  return parts;
}

/** Main runner entry point. */
async function main(): Promise<void> {
  const config = await readConfig();
  const abortController = new AbortController();
  const startTime = Date.now();
  let turnCount = 0;

  // Set up stdin listener for steering and abort messages
  const stdinRl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const steeringQueue: string[] = [];

  stdinRl.on("line", (line) => {
    try {
      const msg: RunnerIncomingMessage = JSON.parse(line);
      if (msg.event === "abort") {
        abortController.abort();
      } else if (msg.event === "steer") {
        steeringQueue.push(msg.message);
      }
    } catch {
      // Ignore malformed lines
    }
  });

  // Heartbeat timer
  const heartbeat = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    emit({ event: "heartbeat", elapsed, turns: turnCount });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    const parts = buildPromptParts(config);

    const queryResult = query({
      prompt: config.prompt,
      options: {
        cwd: config.cwd,
        model: config.model as any,
        maxTurns: config.maxTurns,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: config.systemPromptAppend,
        },
        abortController,
        persistSession: true,
      },
    });

    for await (const msg of queryResult) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);

      if (msg.type === "assistant") turnCount++;

      const events = mapSdkMessage(msg, elapsed, turnCount);
      for (const event of events) {
        emit(event);
      }

      // Check for pending steering messages
      while (steeringQueue.length > 0) {
        const steerMsg = steeringQueue.shift()!;
        // Use streamInput to inject the steering message
        // The SDK's Query object supports this via async iterable
        queryResult.streamInput(
          (async function* () {
            yield { role: "user" as const, content: steerMsg };
          })(),
        );
      }
    }
  } catch (err) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    emit({
      event: "error",
      message: err instanceof Error ? err.message : String(err),
      recoverable: false,
    });
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeat);
    stdinRl.close();
  }
}

main().catch((err) => {
  process.stderr.write(`Runner fatal error: ${err}\n`);
  process.exit(1);
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/session-runner.test.ts --reporter=verbose`
Expected: All 5 tests PASS

- [ ] **Step 5: Build to verify TypeScript compiles**

Run: `npm run build`
Expected: Clean build with `dist/session-runner.js` output

- [ ] **Step 6: Commit**

```bash
git add src/session-runner.ts src/session-runner.test.ts
git commit -m "feat: implement session runner with Agent SDK integration"
```

---

### Task 4: Prompt Splitting — `buildPromptParts()`

**Files:**
- Modify: `src/orchestrator.ts:1758-2050` (buildPrompt area)

- [ ] **Step 1: Write failing test for buildPromptParts**

Add to `src/orchestrator.test.ts`:

```typescript
describe("buildPromptParts", () => {
  it("returns systemAppend and userPrompt as separate strings", () => {
    // Create a test item and project using _initTestTrackerDatabase helpers
    const { buildPromptParts } = await import("./orchestrator.js");
    const db = _initTestTrackerDatabase();
    const project = createProject({ name: "Test", prefix: "TEST" });
    const item = createWorkItem({
      project_id: project.id,
      title: "Fix bug",
      description: "Fix the auth bug",
    });
    const result = buildPromptParts(item, project, "ses_test");
    expect(result).toHaveProperty("systemAppend");
    expect(result).toHaveProperty("userPrompt");
    expect(result.systemAppend).toContain("Security Rules");
    expect(result.systemAppend).toContain("BLOCKED_PATHS");
    expect(result.userPrompt).toContain("Fix the auth bug");
    expect(result.userPrompt).not.toContain("Security Rules");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --reporter=verbose 2>&1 | grep -A2 "buildPromptParts"`
Expected: FAIL — function not exported

- [ ] **Step 3: Implement buildPromptParts in orchestrator.ts**

Refactor the existing `buildPrompt()` function (around line 1758). Extract the security rules section (~lines 1949-1976) into a separate function. Keep `buildPrompt()` intact for OpenCode compatibility.

```typescript
/**
 * Split prompt into system append (security rules) and user prompt (item context).
 * Used by the runner dispatch path.
 */
export function buildPromptParts(
  item: WorkItem,
  project: Project,
  sessionId: string,
): { systemAppend: string; userPrompt: string } {
  // Build the full prompt as before
  const fullPrompt = buildPrompt(item, project, sessionId);

  // Split at the security rules boundary
  const securityMarker = "## Security Rules";
  const instructionsMarker = "## Instructions";

  const securityStart = fullPrompt.indexOf(securityMarker);
  const instructionsStart = fullPrompt.indexOf(instructionsMarker);

  if (securityStart === -1 || instructionsStart === -1) {
    // Fallback: everything goes in the user prompt
    return { systemAppend: "", userPrompt: fullPrompt };
  }

  const systemAppend = fullPrompt.slice(securityStart, instructionsStart).trim();
  const userPrompt =
    fullPrompt.slice(0, securityStart).trim() +
    "\n\n" +
    fullPrompt.slice(instructionsStart).trim();

  return { systemAppend, userPrompt };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --reporter=verbose`
Expected: All tests pass including the new buildPromptParts test

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts src/orchestrator.test.ts
git commit -m "feat: add buildPromptParts for runner prompt splitting"
```

---

### Task 5: Orchestrator — `dispatchViaRunner()`

**Files:**
- Modify: `src/orchestrator.ts` (imports, ActiveSession, new dispatch function)
- Modify: `src/config.ts` (import DISPATCH_MODE)

- [ ] **Step 1: Add runner event types import and child_process import to orchestrator.ts**

At the top of `src/orchestrator.ts` (around line 1), add:

```typescript
import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";
import type { RunnerEvent, RunnerConfig } from "./runner-types.js";
```

Import `DISPATCH_MODE` from config.ts (in the existing config import block around line 46):

```typescript
import {
  // ...existing imports...
  DISPATCH_MODE,
} from "./config.js";
```

- [ ] **Step 2: Extend ActiveSession interface**

Add to the `ActiveSession` interface (around line 410 of `src/orchestrator.ts`):

```typescript
  // Runner mode fields
  childProcess?: ChildProcess;
  events?: RunnerEvent[];      // Buffered events for dashboard viewer (max 200)
  sdkSessionId?: string;       // Agent SDK session ID for potential resume
```

- [ ] **Step 3: Implement dispatchViaRunner function**

Add after the existing `dispatch()` function (around line 1585):

```typescript
/**
 * Dispatch a work item via the session runner (DISPATCH_MODE=runner).
 * Spawns session-runner.js as a child process, communicates via stdio JSON.
 */
async function dispatchViaRunner(item: WorkItem, project: Project): Promise<string | null> {
  const itemKey = getWorkItemKey(item);
  const sessionTitle = `${itemKey}: ${item.title}`;

  // Pre-flight validation
  if (!project.working_directory) {
    logger.warn({ itemId: item.id }, "Dispatch skipped: no working_directory");
    return null;
  }

  setSessionInfo(item.id, "", "pending");

  try {
    const { systemAppend, userPrompt } = buildPromptParts(item, project, "pending");

    // Build attachment list (paths only — runner reads from disk)
    const attachments = listAttachments(item.id)
      .filter((a) => EMBEDDABLE_IMAGE_TYPES.has(a.mime_type))
      .filter((a) => {
        const filePath = path.join(STORE_DIR, a.storage_path);
        try {
          return fs.existsSync(filePath) && fs.statSync(filePath).size <= 4.5 * 1024 * 1024;
        } catch { return false; }
      })
      .map((a) => ({
        path: path.join(STORE_DIR, a.storage_path),
        mime: a.mime_type,
        filename: a.filename,
      }));

    const config: RunnerConfig = {
      event: "config",
      itemKey,
      prompt: userPrompt,
      systemPromptAppend: systemAppend,
      cwd: project.working_directory,
      model: CODER_MODEL_ID,
      maxTurns: 100,
      attachments,
    };

    // Spawn the runner child process
    const runnerPath = path.join(__dirname, "session-runner.js");
    const child = spawn(process.execPath, [runnerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: project.working_directory,
      env: { ...process.env },
    });

    const runnerPid = child.pid!;
    let sessionId = `runner_pending_${item.id.slice(0, 8)}`;

    // Register in activeSessions immediately
    setSessionInfo(item.id, sessionId, "pending", runnerPid);
    activeSessions.set(sessionId, {
      itemId: item.id,
      projectId: project.id,
      sessionId,
      startedAt: new Date(),
      lastActivityAt: new Date(),
      pid: runnerPid,
      childProcess: child,
      events: [],
    });

    // Create execution audit
    createExecutionAudit({ work_item_id: item.id, session_id: sessionId });

    logger.info(
      { itemId: item.id, itemKey, sessionId, runnerPid, title: sessionTitle },
      "Spawned runner process",
    );

    // Send config to runner stdin
    child.stdin!.write(JSON.stringify(config) + "\n");

    // Read runner stdout for events
    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

    rl.on("line", (line) => {
      try {
        const event: RunnerEvent = JSON.parse(line);
        const session = activeSessions.get(sessionId);
        if (!session) return;

        session.lastActivityAt = new Date();

        // Buffer event for dashboard (cap at 200)
        if (session.events) {
          session.events.push(event);
          if (session.events.length > 200) session.events.shift();
        }

        // Push to SSE subscribers
        pushSessionEvent(item.id, event);

        switch (event.event) {
          case "started":
            // Update session ID to the runner's generated ID
            const oldId = sessionId;
            sessionId = event.sessionId;
            activeSessions.delete(oldId);
            session.sessionId = sessionId;
            session.sdkSessionId = event.sessionId;
            activeSessions.set(sessionId, session);
            setSessionInfo(item.id, sessionId, "running", runnerPid);
            updateSessionStatus(item.id, "running");
            logger.info({ itemId: item.id, sessionId, runnerPid }, "Runner session started");
            break;

          case "completed":
            handleSessionComplete(sessionId);
            break;

          case "error":
            handleSessionError(sessionId, event.message);
            break;

          // tool_use, text, heartbeat, status — just lastActivityAt update (already done above)
        }
      } catch (err) {
        logger.warn({ err, line: line.slice(0, 200) }, "Failed to parse runner event");
      }
    });

    // Capture stderr for debug logging
    if (child.stderr) {
      const stderrRl = createInterface({ input: child.stderr, crlfDelay: Infinity });
      stderrRl.on("line", (line) => {
        logger.debug({ itemId: item.id, sessionId, source: "runner-stderr" }, line);
      });
    }

    // Handle unexpected process exit
    child.on("exit", (code, signal) => {
      const session = activeSessions.get(sessionId);
      if (session && !session.aborting) {
        // Process exited without a completed/error event
        logger.warn(
          { itemId: item.id, sessionId, code, signal },
          "Runner process exited unexpectedly",
        );
        handleSessionError(sessionId, `Runner exited with code ${code}, signal ${signal}`);
      }
    });

    return sessionId;
  } catch (err) {
    const errMsg = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    logger.error({ err: errMsg, itemId: item.id }, "Failed to dispatch via runner");
    clearSessionInfo(item.id);
    recordItemDispatchFailure(item.id, errMsg);
    recordFailure(errMsg, item.id);
    return null;
  }
}
```

- [ ] **Step 4: Wire tryDispatch to use dispatchViaRunner when DISPATCH_MODE=runner**

In the `tryDispatch()` function (around line 1191), find where it calls `dispatch(item)` and wrap with mode check:

```typescript
// Inside the dispatch loop in tryDispatch():
const sessionId = DISPATCH_MODE === "runner"
  ? await dispatchViaRunner(item, project)
  : await dispatch(item, project);
```

Apply the same pattern for `tryDispatchFromClarification()` where it calls `dispatchForClarification()`:

```typescript
const sessionId = DISPATCH_MODE === "runner"
  ? await dispatchViaRunner(item, project)  // Runner handles both coder and research prompts
  : await dispatchForClarification(item, project);
```

And for `tryDispatchFromReview()` where it calls `dispatch()`.

- [ ] **Step 5: Update abort logic for runner mode**

In the `abortSession()` function, add runner-mode handling before the OpenCode SDK abort call:

```typescript
// At the start of abortSession(), after marking aborting=true:
if (DISPATCH_MODE === "runner" && session.childProcess) {
  // Send abort message to runner stdin
  try {
    session.childProcess.stdin?.write(JSON.stringify({ event: "abort" }) + "\n");
  } catch { /* stdin may be closed */ }

  // Escalate if runner doesn't exit
  setTimeout(() => {
    if (session.childProcess && !session.childProcess.killed) {
      session.childProcess.kill("SIGTERM");
    }
  }, 5000);
  setTimeout(() => {
    if (session.childProcess && !session.childProcess.killed) {
      session.childProcess.kill("SIGKILL");
    }
  }, 10000);

  // Skip the OpenCode SDK abort call
} else {
  // Existing OpenCode abort logic...
}
```

- [ ] **Step 6: Add steering message helper**

Add a helper function for the steer API endpoint to use:

```typescript
/**
 * Send a steering message to a running runner session.
 * The runner forwards it to the agent via streamInput.
 */
export function steerSession(sessionId: string, message: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session?.childProcess?.stdin?.writable) return false;
  try {
    session.childProcess.stdin.write(
      JSON.stringify({ event: "steer", message }) + "\n",
    );
    // Also buffer the steer message as an event for the dashboard
    const steerEvent: RunnerEvent = { event: "text", content: `[Human]: ${message}` };
    if (session.events) {
      session.events.push(steerEvent);
      if (session.events.length > 200) session.events.shift();
    }
    pushSessionEvent(session.itemId, steerEvent);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 7: Add SSE event push infrastructure**

Add near the activeSessions map (around line 499):

```typescript
// SSE subscribers: itemId → Set of response objects
const sseSubscribers = new Map<string, Set<any>>();

/** Push a runner event to all SSE subscribers for an item. */
function pushSessionEvent(itemId: string, event: RunnerEvent): void {
  const subscribers = sseSubscribers.get(itemId);
  if (!subscribers) return;
  const data = JSON.stringify(event);
  const eventId = Date.now().toString(36);
  for (const res of subscribers) {
    try {
      res.write(`id: ${eventId}\ndata: ${data}\n\n`);
    } catch {
      subscribers.delete(res);
    }
  }
}

/** Subscribe to session events for an item. Returns buffered events and the subscriber set. */
export function subscribeSessionEvents(
  itemId: string,
  res: any,
): RunnerEvent[] {
  if (!sseSubscribers.has(itemId)) sseSubscribers.set(itemId, new Set());
  sseSubscribers.get(itemId)!.add(res);

  // Find buffered events
  for (const session of activeSessions.values()) {
    if (session.itemId === itemId && session.events) {
      return [...session.events];
    }
  }
  return [];
}

/** Unsubscribe from session events. */
export function unsubscribeSessionEvents(itemId: string, res: any): void {
  sseSubscribers.get(itemId)?.delete(res);
}
```

- [ ] **Step 8: Build and run all tests**

Run: `npm run build && npm test`
Expected: Clean build, all existing tests pass

- [ ] **Step 9: Commit**

```bash
git add src/orchestrator.ts src/config.ts
git commit -m "feat: add dispatchViaRunner with child process management and SSE events"
```

---

### Task 6: Session Recovery for Runner Mode

**Files:**
- Modify: `src/orchestrator.ts` (recoverActiveSessions area, ~line 3922)

- [ ] **Step 1: Write failing test for runner session recovery**

Add to `src/orchestrator.test.ts`:

```typescript
describe("recoverRunnerSessions", () => {
  it("cleans up sessions with dead runner PIDs", () => {
    // Set up a work item with session_status='running' and a dead PID
    // Call recoverRunnerSessions
    // Verify session info is cleared and item is cleaned up
  });
});
```

- [ ] **Step 2: Implement runner recovery in startOrchestrator**

In `startOrchestrator()` (around line 555), after the existing `recoverActiveSessions()` call, add runner-mode recovery:

```typescript
if (DISPATCH_MODE === "runner") {
  recoverRunnerSessions();
} else {
  // existing OpenCode recovery
  await recoverActiveSessions();
}
```

```typescript
/**
 * Recover runner sessions after tracker restart.
 * Runner child processes die with the parent, so any 'running' sessions in the DB are stale.
 */
function recoverRunnerSessions(): void {
  const staleItems = db.prepare(`
    SELECT id, session_id, session_status, opencode_pid
    FROM tracker_work_items
    WHERE session_status IN ('running', 'pending')
  `).all() as Array<{ id: string; session_id: string; session_status: string; opencode_pid: number | null }>;

  for (const item of staleItems) {
    const alive = item.opencode_pid ? isProcessAlive(item.opencode_pid) : false;
    if (!alive) {
      logger.info(
        { itemId: item.id, sessionId: item.session_id, pid: item.opencode_pid },
        "Cleaning up stale runner session after restart",
      );
      clearSessionInfo(item.id);
      unlockItem(item.id);
      createComment({
        work_item_id: item.id,
        author: "orchestrator",
        body: "Runner session interrupted by tracker restart. The item will be re-dispatched.",
      });
    }
  }

  if (staleItems.length > 0) {
    logger.info({ count: staleItems.length }, "Recovered stale runner sessions");
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npm test -- --reporter=verbose`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator.ts src/orchestrator.test.ts
git commit -m "feat: add runner session recovery after tracker restart"
```

---

### Task 7: API Endpoints — SSE Events and Steering

**Files:**
- Modify: `src/api.ts:861-902` (session endpoints area)

- [ ] **Step 1: Add SSE events endpoint**

After the existing `GET /items/:id/session` handler (around line 880 of `src/api.ts`), add:

```typescript
// GET /items/:id/session/events — SSE stream of runner events
router.get("/items/:id/session/events", (req, res) => {
  const item = getWorkItem(req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send buffered events as catch-up burst
  const buffered = subscribeSessionEvents(item.id, res);
  for (const event of buffered) {
    const eventId = Date.now().toString(36);
    res.write(`id: ${eventId}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  // Handle disconnect
  req.on("close", () => {
    unsubscribeSessionEvents(item.id, res);
  });
});
```

- [ ] **Step 2: Add steer endpoint**

```typescript
// POST /items/:id/session/steer — Send steering message to runner
router.post("/items/:id/session/steer", requireAuth, (req, res) => {
  const item = getWorkItem(req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });

  const { message } = req.body;
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  const success = steerSession(item.session_id, message);
  if (!success) {
    return res.status(409).json({ error: "No active runner session for this item" });
  }

  res.json({ steered: true, session_id: item.session_id });
});
```

- [ ] **Step 3: Update GET /items/:id/session for runner mode**

Modify the existing handler (around line 861) to include dispatch mode info:

```typescript
// In the existing GET /items/:id/session handler, update the response:
const response: any = {
  session_id: item.session_id,
  session_status: item.session_status,
  dispatch_mode: DISPATCH_MODE,
};

if (DISPATCH_MODE === "opencode") {
  // Existing OpenCode URL logic
  response.opencode_url = opencodeUrl;
} else {
  // Runner mode: include event count
  const session = getActiveSession(item.session_id);
  response.event_count = session?.events?.length ?? 0;
}
```

- [ ] **Step 4: Add imports**

Import `subscribeSessionEvents`, `unsubscribeSessionEvents`, `steerSession` from orchestrator.ts and `DISPATCH_MODE` from config.ts.

- [ ] **Step 5: Build and test**

Run: `npm run build && npm test`
Expected: Clean build, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/api.ts
git commit -m "feat: add SSE session events and steering API endpoints"
```

---

### Task 8: Dashboard Session Viewer UI

**Files:**
- Modify: `src/ui/core.html` (add Session Viewer section)

- [ ] **Step 1: Add Session Viewer section**

Add a new section in `src/ui/core.html` after the item detail panel section. Use the project's `// -- Section Name --` convention:

```javascript
// ── Session Viewer ──

/**
 * Render a live session viewer for runner-mode sessions.
 * Shows activity feed, steering input, and abort button.
 */
function renderSessionViewer(container, item) {
  if (!item.session_id || !item.session_status || item.session_status === 'completed' || item.session_status === 'failed') {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <div class="session-viewer" style="border:1px solid var(--border); border-radius:8px; margin:12px 0; background:var(--surface);">
      <div style="padding:8px 12px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center;">
        <span style="font-weight:600; font-size:13px;">Agent Session</span>
        <span class="session-status-badge" style="font-size:12px;">${agentStatusHtml(item.session_status)}</span>
      </div>
      <div class="session-events" style="max-height:400px; overflow-y:auto; padding:8px 12px; font-family:monospace; font-size:12px; line-height:1.6;">
        <div style="color:var(--text-secondary); font-style:italic;">Connecting to session...</div>
      </div>
      <div style="padding:8px 12px; border-top:1px solid var(--border); display:flex; gap:8px;">
        <input type="text" class="session-steer-input" placeholder="Type to steer the agent..."
          style="flex:1; padding:6px 10px; border:1px solid var(--border); border-radius:6px; font-size:13px; background:var(--background);" />
        <button class="session-steer-btn" style="padding:6px 14px; border-radius:6px; background:var(--primary); color:white; border:none; cursor:pointer; font-size:13px;">Send</button>
        <button class="session-abort-btn" style="padding:6px 14px; border-radius:6px; background:#dc3545; color:white; border:none; cursor:pointer; font-size:13px;">Abort</button>
      </div>
    </div>
  `;

  const eventsContainer = container.querySelector('.session-events');
  const steerInput = container.querySelector('.session-steer-input');
  const steerBtn = container.querySelector('.session-steer-btn');
  const abortBtn = container.querySelector('.session-abort-btn');

  // Connect to SSE event stream
  const eventSource = new EventSource(`/api/v1/items/${item.id}/session/events`);
  let eventCount = 0;

  eventSource.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      if (eventCount === 0) eventsContainer.innerHTML = ''; // Clear "Connecting..." message
      eventCount++;
      appendSessionEvent(eventsContainer, event);
      eventsContainer.scrollTop = eventsContainer.scrollHeight;
    } catch {}
  };

  eventSource.onerror = () => {
    // Connection lost — session may have ended
    appendSessionEvent(eventsContainer, { event: 'status', status: 'disconnected' });
    eventSource.close();
  };

  // Steer button
  const sendSteer = () => {
    const message = steerInput.value.trim();
    if (!message) return;
    fetch(`/api/v1/items/${item.id}/session/steer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiToken}` },
      body: JSON.stringify({ message }),
    });
    steerInput.value = '';
  };
  steerBtn.onclick = sendSteer;
  steerInput.onkeydown = (e) => { if (e.key === 'Enter') sendSteer(); };

  // Abort button
  abortBtn.onclick = async () => {
    if (!confirm('Abort this agent session?')) return;
    await fetch(`/api/v1/items/${item.id}/session/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiToken}` },
      body: JSON.stringify({ reason: 'Aborted from dashboard' }),
    });
    eventSource.close();
  };

  // Return cleanup function
  return () => eventSource.close();
}

/** Append a single event to the session viewer. */
function appendSessionEvent(container, event) {
  const div = document.createElement('div');
  div.style.padding = '2px 0';

  switch (event.event) {
    case 'tool_use':
      div.style.color = 'var(--text-secondary)';
      div.textContent = `🔧 ${event.tool}${event.file ? ` ${event.file}` : ''}`;
      break;
    case 'tool_result':
      div.style.color = event.status === 'error' ? '#dc3545' : 'var(--text-secondary)';
      div.textContent = `  ${event.status === 'error' ? '✗' : '✓'} ${event.tool}${event.error ? ': ' + event.error : ''}`;
      break;
    case 'text':
      div.style.color = 'var(--text-primary)';
      div.textContent = event.content.length > 300 ? event.content.slice(0, 300) + '...' : event.content;
      break;
    case 'error':
      div.style.color = '#dc3545';
      div.style.fontWeight = '600';
      div.textContent = `✗ Error: ${event.message}`;
      break;
    case 'completed':
      div.style.color = '#28a745';
      div.style.fontWeight = '600';
      div.textContent = `✓ Completed (${event.duration}s, ${event.turns} turns${event.cost ? ', $' + event.cost.toFixed(3) : ''})`;
      break;
    case 'heartbeat':
      // Only show every 5th heartbeat to avoid noise
      if (event.elapsed % 150 !== 0) return;
      div.style.color = 'var(--text-tertiary)';
      div.style.fontSize = '11px';
      div.textContent = `… ${event.elapsed}s elapsed, ${event.turns} turns`;
      break;
    case 'status':
      div.style.color = 'var(--text-secondary)';
      div.style.fontStyle = 'italic';
      div.textContent = `⟳ ${event.status}`;
      break;
    case 'started':
      div.style.color = 'var(--text-secondary)';
      div.textContent = `▶ Session started (${event.sessionId})`;
      break;
    default:
      return; // Skip unknown events
  }

  container.appendChild(div);
}
```

- [ ] **Step 2: Wire the session viewer into the item detail panel**

Find the item detail panel rendering code and add a container for the session viewer. When an item is opened with an active session, call `renderSessionViewer()`.

In the detail panel rendering function (find by searching for where `session_status` is displayed), add:

```javascript
// After the existing session status display:
const sessionViewerContainer = document.createElement('div');
sessionViewerContainer.className = 'session-viewer-container';
detailPanel.appendChild(sessionViewerContainer);

// Render session viewer if there's an active session in runner mode
if (item.session_status === 'running' || item.session_status === 'pending') {
  renderSessionViewer(sessionViewerContainer, item);
}
```

- [ ] **Step 3: Build UI**

Run: `npm run build:ui`
Expected: `src/ui/index.html` generated without errors

- [ ] **Step 4: Commit**

```bash
git add src/ui/core.html
git commit -m "feat: add dashboard session viewer with activity feed and steering"
```

---

### Task 9: Agent Config Validation for Runner Mode

**Files:**
- Modify: `src/orchestrator.ts:276-330` (validateAgentConfig)

- [ ] **Step 1: Write failing test**

Add to `src/orchestrator.test.ts`:

```typescript
describe("validateAgentConfig (runner mode)", () => {
  it("skips OpenCode agent file check in runner mode", () => {
    // With DISPATCH_MODE=runner, validateAgentConfig should not
    // require ~/.config/opencode/agents/tracker-worker.md
    const result = validateAgentConfigForRunner();
    expect(result.valid).toBe(true);
  });

  it("checks that session-runner.js build artifact exists", () => {
    const result = validateAgentConfigForRunner("/nonexistent/path");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("session-runner.js");
  });
});
```

- [ ] **Step 2: Implement runner-mode validation**

Add alongside the existing `validateAgentConfig()`:

```typescript
export function validateAgentConfigForRunner(
  runnerPath?: string,
): { valid: boolean; error?: string } {
  const expectedPath = runnerPath ?? path.join(__dirname, "session-runner.js");
  if (!fs.existsSync(expectedPath)) {
    return {
      valid: false,
      error: `Session runner not found at ${expectedPath}. Run 'npm run build' first.`,
    };
  }
  return { valid: true };
}
```

Update the pre-flight validation in `dispatchViaRunner()` to call `validateAgentConfigForRunner()` instead of `validateAgentConfig()`.

- [ ] **Step 3: Run tests**

Run: `npm test -- --reporter=verbose`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator.ts src/orchestrator.test.ts
git commit -m "feat: add runner-mode agent config validation"
```

---

### Task 10: Skip SSE Event Stream in Runner Mode

**Files:**
- Modify: `src/orchestrator.ts:555-607` (startOrchestrator)

- [ ] **Step 1: Gate the SSE stream and OpenCode recovery behind dispatch mode**

In `startOrchestrator()`, wrap the OpenCode-specific startup with a mode check:

```typescript
if (DISPATCH_MODE === "opencode") {
  // Existing: recover active sessions from OpenCode
  await recoverActiveSessions();
  // Existing: start SSE event stream
  startEventStream();
} else {
  // Runner mode: recover stale runner sessions
  recoverRunnerSessions();
  // No SSE stream needed — runner events come via stdio
}
```

- [ ] **Step 2: Build and run full test suite**

Run: `npm run build && npm test`
Expected: Clean build, all tests pass

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator.ts
git commit -m "feat: gate OpenCode SSE stream behind DISPATCH_MODE"
```

---

### Task 11: Update CLAUDE.md Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add runner mode documentation**

Add a new section after the Orchestrator section in CLAUDE.md:

```markdown
### Session Runner (DISPATCH_MODE=runner)

Alternative dispatch mode that replaces OpenCode with direct Claude Code execution via the Agent SDK.

| Variable | Default | Description |
| --- | --- | --- |
| `DISPATCH_MODE` | `opencode` | Dispatch mode: `opencode` (default) or `runner` |

When `DISPATCH_MODE=runner`:
- The orchestrator spawns `session-runner.js` as a child process per work item
- The runner uses the Claude Agent SDK to execute Claude Code directly
- Communication is via stdio JSON pipes (no network, no ports)
- The dashboard shows a native session viewer with live activity feed
- Steering messages can be sent from the dashboard to redirect the agent
- OpenCode and the proxy are not needed

**New API Endpoints (runner mode):**

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/items/:id/session/events` | SSE stream of runner events |
| `POST` | `/api/v1/items/:id/session/steer` | Send steering message to agent |
```

- [ ] **Step 2: Add session-runner.ts to Key Files table**

```markdown
| `src/session-runner.ts` | Session runner — Agent SDK execution, stdio JSON protocol |
| `src/runner-types.ts` | Shared types for runner events and config |
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document DISPATCH_MODE=runner and session runner"
```

---

### Task 12: Integration Test — End-to-End Runner Dispatch

**Files:**
- Modify: `src/orchestrator.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
describe("dispatchViaRunner integration", () => {
  it("spawns runner and receives events via stdout", async () => {
    // This test verifies the full flow:
    // 1. Build a mock runner script that emits known events
    // 2. Point dispatchViaRunner at the mock
    // 3. Verify events are received and routed correctly
    //
    // Create a minimal mock runner:
    const mockRunnerCode = `
      const rl = require('readline').createInterface({ input: process.stdin });
      rl.once('line', (line) => {
        const config = JSON.parse(line);
        process.stdout.write(JSON.stringify({ event: "started", sessionId: "runner_test123", pid: process.pid }) + "\\n");
        setTimeout(() => {
          process.stdout.write(JSON.stringify({ event: "text", content: "Working on it..." }) + "\\n");
          setTimeout(() => {
            process.stdout.write(JSON.stringify({ event: "completed", result: "success", duration: 2, turns: 1 }) + "\\n");
          }, 100);
        }, 100);
      });
    `;
    // Write mock to temp file, test against it
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `npm test -- --reporter=verbose`
Expected: All tests pass

- [ ] **Step 3: Final build**

Run: `npm run build && npm run build:ui`
Expected: Clean build of both TypeScript and UI

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator.test.ts
git commit -m "test: add integration test for runner dispatch flow"
```

---

### Task 13: Final Verification

- [ ] **Step 1: Run full test suite**

```bash
npm test
```
Expected: All tests pass

- [ ] **Step 2: Build everything**

```bash
npm run build
```
Expected: Clean build

- [ ] **Step 3: Verify runner launches manually**

```bash
echo '{"event":"config","itemKey":"TEST-1","prompt":"Say hello","systemPromptAppend":"","cwd":"/tmp","model":"sonnet","maxTurns":1,"attachments":[]}' | node dist/session-runner.js
```
Expected: JSON events on stdout (started, text, completed)

- [ ] **Step 4: Test with DISPATCH_MODE=runner on the live tracker**

```bash
# In .env, add:
DISPATCH_MODE=runner

# Restart tracker
./scripts/safe-restart.sh --build
```

Approve a work item from the dashboard and verify:
- Runner process spawns
- Events appear in the session viewer
- Session completes and item advances state

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address issues found during manual verification"
```
