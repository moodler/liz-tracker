/**
 * Session runner unit tests
 *
 * Tests mapSdkMessage() mapping from SDK message types to RunnerEvent types.
 */

import { describe, it, expect } from "vitest";
import { mapSdkMessage } from "./session-runner.js";
import type { UUID } from "crypto";

const fakeUuid = "00000000-0000-0000-0000-000000000000" as UUID;
const fakeSessionId = "sess_abc123";

// ── System init → started event ──────────────────────────────────────────────

describe("mapSdkMessage — system init", () => {
  it("emits a started event with runner_ prefixed sessionId", () => {
    const msg = {
      type: "system" as const,
      subtype: "init" as const,
      apiKeySource: "user" as const,
      claude_code_version: "1.0.0",
      cwd: "/tmp",
      tools: [],
      mcp_servers: [],
      model: "claude-opus-4-6",
      permissionMode: "bypassPermissions" as const,
      slash_commands: [],
      output_style: "text",
      skills: [],
      plugins: [],
      uuid: fakeUuid,
      session_id: fakeSessionId,
    };

    const events = mapSdkMessage(msg);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.event).toBe("started");
    if (ev.event === "started") {
      expect(ev.sessionId).toMatch(/^runner_[0-9a-f]+$/);
      expect(ev.sdkSessionId).toBe(fakeSessionId);
      expect(ev.pid).toBe(process.pid);
    }
  });
});

// ── Result success → completed event ─────────────────────────────────────────

describe("mapSdkMessage — result success", () => {
  it("emits a completed event with cost from total_cost_usd", () => {
    const msg = {
      type: "result" as const,
      subtype: "success" as const,
      duration_ms: 15000,
      duration_api_ms: 12000,
      is_error: false,
      num_turns: 5,
      result: "Done",
      stop_reason: "end_turn",
      total_cost_usd: 0.42,
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      uuid: fakeUuid,
      session_id: fakeSessionId,
    };

    const events = mapSdkMessage(msg, 15, 5);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.event).toBe("completed");
    if (ev.event === "completed") {
      expect(ev.result).toBe("success");
      expect(ev.cost).toBe(0.42);
      expect(ev.duration).toBe(15);
      expect(ev.turns).toBe(5);
    }
  });
});

// ── Result error → error event ───────────────────────────────────────────────

describe("mapSdkMessage — result error", () => {
  it("emits an error event with joined error messages", () => {
    const msg = {
      type: "result" as const,
      subtype: "error_during_execution" as const,
      duration_ms: 5000,
      duration_api_ms: 3000,
      is_error: true,
      num_turns: 2,
      stop_reason: null,
      total_cost_usd: 0.1,
      usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      errors: ["Something went wrong", "And another thing"],
      uuid: fakeUuid,
      session_id: fakeSessionId,
    };

    const events = mapSdkMessage(msg);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.event).toBe("error");
    if (ev.event === "error") {
      expect(ev.message).toBe("Something went wrong; And another thing");
      expect(ev.recoverable).toBe(false);
    }
  });

  it("handles error_max_turns subtype", () => {
    const msg = {
      type: "result" as const,
      subtype: "error_max_turns" as const,
      duration_ms: 60000,
      duration_api_ms: 50000,
      is_error: true,
      num_turns: 100,
      stop_reason: null,
      total_cost_usd: 5.0,
      usage: { input_tokens: 10000, output_tokens: 5000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      errors: ["Max turns exceeded"],
      uuid: fakeUuid,
      session_id: fakeSessionId,
    };

    const events = mapSdkMessage(msg);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.event).toBe("error");
    if (ev.event === "error") {
      expect(ev.message).toContain("Max turns exceeded");
    }
  });
});

// ── Assistant message → text event ───────────────────────────────────────────

describe("mapSdkMessage — assistant", () => {
  it("extracts text blocks from message content", () => {
    const msg = {
      type: "assistant" as const,
      message: {
        content: [
          { type: "text" as const, text: "Hello world" },
          { type: "tool_use" as const, id: "tool_1", name: "Bash", input: {} },
          { type: "text" as const, text: "More text" },
        ],
        id: "msg_1",
        type: "message" as const,
        role: "assistant" as const,
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      parent_tool_use_id: null,
      uuid: fakeUuid,
      session_id: fakeSessionId,
    };

    const events = mapSdkMessage(msg);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.event).toBe("text");
    if (ev.event === "text") {
      expect(ev.content).toBe("Hello world\nMore text");
    }
  });

  it("returns empty array for assistant with no text blocks", () => {
    const msg = {
      type: "assistant" as const,
      message: {
        content: [
          { type: "tool_use" as const, id: "tool_1", name: "Bash", input: {} },
        ],
        id: "msg_1",
        type: "message" as const,
        role: "assistant" as const,
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      parent_tool_use_id: null,
      uuid: fakeUuid,
      session_id: fakeSessionId,
    };

    const events = mapSdkMessage(msg);
    expect(events).toHaveLength(0);
  });
});

// ── Tool progress → tool_use event ───────────────────────────────────────────

describe("mapSdkMessage — tool_progress", () => {
  it("emits tool_use event with tool name and elapsed time", () => {
    const msg = {
      type: "tool_progress" as const,
      tool_use_id: "tu_123",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 3.5,
      uuid: fakeUuid,
      session_id: fakeSessionId,
    };

    const events = mapSdkMessage(msg);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.event).toBe("tool_use");
    if (ev.event === "tool_use") {
      expect(ev.tool).toBe("Bash");
      expect(ev.elapsed).toBe(3.5);
    }
  });
});

// ── Tool use summary → tool_result event ─────────────────────────────────────

describe("mapSdkMessage — tool_use_summary", () => {
  it("emits tool_result event, parsing summary for tool info", () => {
    const msg = {
      type: "tool_use_summary" as const,
      summary: "Read(src/index.ts): success",
      preceding_tool_use_ids: ["tu_1"],
      uuid: fakeUuid,
      session_id: fakeSessionId,
    };

    const events = mapSdkMessage(msg);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.event).toBe("tool_result");
    if (ev.event === "tool_result") {
      expect(ev.tool).toBe("Read");
      expect(ev.status).toBe("success");
    }
  });

  it("handles summary with error indication", () => {
    const msg = {
      type: "tool_use_summary" as const,
      summary: "Bash(npm test): error - Process exited with code 1",
      preceding_tool_use_ids: ["tu_2"],
      uuid: fakeUuid,
      session_id: fakeSessionId,
    };

    const events = mapSdkMessage(msg);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.event).toBe("tool_result");
    if (ev.event === "tool_result") {
      expect(ev.tool).toBe("Bash");
      expect(ev.status).toBe("error");
      expect(ev.error).toContain("Process exited with code 1");
    }
  });

  it("handles unparseable summary gracefully", () => {
    const msg = {
      type: "tool_use_summary" as const,
      summary: "Some random summary text",
      preceding_tool_use_ids: [],
      uuid: fakeUuid,
      session_id: fakeSessionId,
    };

    const events = mapSdkMessage(msg);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.event).toBe("tool_result");
    if (ev.event === "tool_result") {
      expect(ev.tool).toBe("unknown");
      expect(ev.status).toBe("success");
    }
  });
});

// ── Status message → status event ────────────────────────────────────────────

describe("mapSdkMessage — status", () => {
  it("emits status event for system status messages", () => {
    const msg = {
      type: "system" as const,
      subtype: "status" as const,
      status: "compacting" as const,
      uuid: fakeUuid,
      session_id: fakeSessionId,
    };

    const events = mapSdkMessage(msg);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.event).toBe("status");
    if (ev.event === "status") {
      expect(ev.status).toBe("compacting");
    }
  });
});

// ── Unknown message types → empty array ──────────────────────────────────────

describe("mapSdkMessage — unknown types", () => {
  it("returns empty array for unhandled message types", () => {
    const msg = {
      type: "stream_event" as const,
      event: {} as any,
      parent_tool_use_id: null,
      uuid: fakeUuid,
      session_id: fakeSessionId,
    };

    const events = mapSdkMessage(msg as any);
    expect(events).toHaveLength(0);
  });
});
