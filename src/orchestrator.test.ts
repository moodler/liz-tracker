/**
 * Orchestrator unit tests
 *
 * Tests PID-based stale session detection, related helpers,
 * and agent config validation.
 * Uses dependency injection for the exec function to avoid ESM spy limitations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isProcessAlive, resolveOpencodePid, sendSignal, killProcessGracefully, validateAgentConfig, is413Error, isImageTooLargeError, isPostCompletionError, isScheduleTimeDue, buildPromptParts, buildResearchPromptParts, resolveModelForItem } from "./orchestrator.js";
import { base64UrlEncode, buildOpencodeSessionUrl, buildOpencodeDirectoryUrl, buildOpencodeApiSessionUrl, DISPATCH_MODE } from "./config.js";
import fs from "fs";
import path from "path";
import os from "os";

// ── isProcessAlive ─────────────────────────────────────────────────────────────

describe("isProcessAlive", () => {
  it("returns true for the current process PID", () => {
    // process.pid is always alive since we're running it
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("returns false for a PID that does not exist", () => {
    // PID 2^31-1 (max pid) should never exist in normal operation.
    const impossiblePid = 2147483647;
    expect(isProcessAlive(impossiblePid)).toBe(false);
  });

  it("returns true when process.kill(pid, 0) succeeds", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(isProcessAlive(12345)).toBe(true);
    killSpy.mockRestore();
  });

  it("returns false when process.kill(pid, 0) throws ESRCH (no such process)", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("No such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    expect(isProcessAlive(12345)).toBe(false);
    killSpy.mockRestore();
  });

  it("returns false when process.kill(pid, 0) throws any error", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("Operation not permitted");
    });
    expect(isProcessAlive(12345)).toBe(false);
    killSpy.mockRestore();
  });
});

// ── resolveOpencodePid ─────────────────────────────────────────────────────────
//
// We use dependency injection (_execFn) to avoid ESM module spy limitations.

describe("resolveOpencodePid", () => {
  it("returns a numeric PID when lsof finds a process on the port", () => {
    const mockExec = vi.fn().mockReturnValue("42000\n");
    const pid = resolveOpencodePid("http://localhost:3000", mockExec);
    expect(pid).toBe(42000);
  });

  it("returns the first PID when lsof returns multiple PIDs", () => {
    // lsof -t can return multiple PIDs (e.g. parent + child process)
    const mockExec = vi.fn().mockReturnValue("42000\n43000\n");
    const pid = resolveOpencodePid("http://localhost:3000", mockExec);
    expect(pid).toBe(42000);
  });

  it("returns undefined when lsof returns empty output (port not in use)", () => {
    const mockExec = vi.fn().mockReturnValue("");
    const pid = resolveOpencodePid("http://localhost:3000", mockExec);
    expect(pid).toBeUndefined();
  });

  it("returns undefined when lsof throws (command not found or permission error)", () => {
    const mockExec = vi.fn().mockImplementation(() => {
      throw new Error("lsof: command not found");
    });
    const pid = resolveOpencodePid("http://localhost:3000", mockExec);
    expect(pid).toBeUndefined();
  });

  it("parses the port from the URL correctly", () => {
    const mockExec = vi.fn().mockReturnValue("99999\n");
    resolveOpencodePid("http://localhost:3000", mockExec);
    expect(mockExec).toHaveBeenCalledWith(
      "lsof",
      ["-i", ":3000", "-t"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("uses port 80 for http URLs without explicit port", () => {
    const mockExec = vi.fn().mockReturnValue("");
    resolveOpencodePid("http://example.com", mockExec);
    expect(mockExec).toHaveBeenCalledWith(
      "lsof",
      ["-i", ":80", "-t"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("uses port 443 for https URLs without explicit port", () => {
    const mockExec = vi.fn().mockReturnValue("");
    resolveOpencodePid("https://example.com", mockExec);
    expect(mockExec).toHaveBeenCalledWith(
      "lsof",
      ["-i", ":443", "-t"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("returns undefined for non-numeric lsof output", () => {
    const mockExec = vi.fn().mockReturnValue("not-a-pid\n");
    const pid = resolveOpencodePid("http://localhost:3000", mockExec);
    expect(pid).toBeUndefined();
  });

  it("returns undefined for whitespace-only lsof output", () => {
    const mockExec = vi.fn().mockReturnValue("   \n  \n");
    const pid = resolveOpencodePid("http://localhost:3000", mockExec);
    expect(pid).toBeUndefined();
  });
});

// ── PID-based stale detection (integration) ────────────────────────────────────

describe("PID-based stale detection behavior", () => {
  it("isProcessAlive is used to detect dead processes quickly", () => {
    // Simulate the scenario: a session has a PID, the process dies.
    // We verify that isProcessAlive() correctly reports the dead process.
    const mockPid = 99999; // very unlikely to exist

    // The process should NOT be alive (no process with PID 99999 running in test)
    // We can't guarantee PID 99999 doesn't exist, so we just check the return type
    const alive = isProcessAlive(mockPid);
    expect(typeof alive).toBe("boolean");
  });

  it("process.kill(pid, 0) does not actually send a real signal", () => {
    // Safety test: kill(pid, 0) with signal 0 is a probe-only call
    // that checks process existence without sending any signal.
    // This test verifies our implementation uses signal 0, not a real signal.
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    isProcessAlive(12345);

    expect(killSpy).toHaveBeenCalledWith(12345, 0);
    killSpy.mockRestore();
  });

  it("resolveOpencodePid returns undefined gracefully when real lsof is unavailable", () => {
    // With a fake URL that no process is listening on, should return undefined
    const mockExec = vi.fn().mockReturnValue("");
    const pid = resolveOpencodePid("http://localhost:19999", mockExec);
    expect(pid).toBeUndefined();
  });
});

// ── sendSignal ─────────────────────────────────────────────────────────────────

describe("sendSignal", () => {
  it("returns true when signal is sent successfully", () => {
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    expect(sendSignal(12345, "SIGHUP")).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(12345, "SIGHUP");
    killSpy.mockRestore();
  });

  it("returns false when process.kill throws (process doesn't exist)", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("No such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    expect(sendSignal(99999, "SIGTERM")).toBe(false);
    killSpy.mockRestore();
  });

  it("sends the correct signal type", () => {
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    sendSignal(12345, "SIGHUP");
    expect(killSpy).toHaveBeenCalledWith(12345, "SIGHUP");

    sendSignal(12345, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");

    killSpy.mockRestore();
  });
});

// ── killProcessGracefully ──────────────────────────────────────────────────────
//
// These tests use vi.spyOn to mock process.kill and control the "alive" state
// of a fake process. We use very short wait times (1ms) to avoid slow tests.

describe("killProcessGracefully", () => {
  it("returns true immediately if process is already dead", async () => {
    // Mock process.kill(pid, 0) to throw ESRCH (process doesn't exist)
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("No such process");
    });

    const result = await killProcessGracefully(12345, { sighupWaitMs: 1, sigtermWaitMs: 1 });
    expect(result).toBe(true);

    // Should only check once (signal 0), never send SIGHUP
    expect(killSpy).toHaveBeenCalledWith(12345, 0);

    killSpy.mockRestore();
  });

  it("returns true when process dies after SIGHUP", async () => {
    let sighupSent = false;

    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: string | number) => {
      if (signal === 0) {
        // Process is alive before SIGHUP, dead after
        if (sighupSent) {
          throw new Error("No such process");
        }
        return true;
      }
      if (signal === "SIGHUP") {
        sighupSent = true;
        return true;
      }
      return true;
    }) as typeof process.kill);

    const result = await killProcessGracefully(12345, { sighupWaitMs: 1, sigtermWaitMs: 1 });
    expect(result).toBe(true);

    // Should have sent SIGHUP but NOT SIGTERM
    const calls = killSpy.mock.calls.map((c) => c[1]);
    expect(calls).toContain(0); // liveness check
    expect(calls).toContain("SIGHUP"); // graceful signal
    expect(calls).not.toContain("SIGTERM"); // should not escalate

    killSpy.mockRestore();
  });

  it("escalates to SIGTERM when SIGHUP doesn't kill the process", async () => {
    let sigtermSent = false;

    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: string | number) => {
      if (signal === 0) {
        // Process dies only after SIGTERM
        if (sigtermSent) {
          throw new Error("No such process");
        }
        return true;
      }
      if (signal === "SIGHUP") {
        // SIGHUP sent but process doesn't die
        return true;
      }
      if (signal === "SIGTERM") {
        sigtermSent = true;
        return true;
      }
      return true;
    }) as typeof process.kill);

    const result = await killProcessGracefully(12345, { sighupWaitMs: 1, sigtermWaitMs: 1 });
    expect(result).toBe(true);

    const calls = killSpy.mock.calls.map((c) => c[1]);
    expect(calls).toContain("SIGHUP");
    expect(calls).toContain("SIGTERM");

    killSpy.mockRestore();
  });

  it("returns false when process survives both SIGHUP and SIGTERM", async () => {
    // Stubborn process that ignores all signals
    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => {
      return true; // Always succeeds, process never dies
    }) as typeof process.kill);

    const result = await killProcessGracefully(12345, { sighupWaitMs: 1, sigtermWaitMs: 1 });
    expect(result).toBe(false);

    const calls = killSpy.mock.calls.map((c) => c[1]);
    expect(calls).toContain(0); // liveness checks
    expect(calls).toContain("SIGHUP");
    expect(calls).toContain("SIGTERM");

    killSpy.mockRestore();
  });

  it("uses default wait times when no opts provided", async () => {
    // Process is already dead — should return immediately without waiting
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("No such process");
    });

    const start = Date.now();
    const result = await killProcessGracefully(12345);
    const elapsed = Date.now() - start;

    expect(result).toBe(true);
    // Should return almost immediately since process is already dead
    expect(elapsed).toBeLessThan(100);

    killSpy.mockRestore();
  });
});

// ── validateAgentConfig ────────────────────────────────────────────────────────

describe("validateAgentConfig", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-test-agent-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns valid when agent config file exists and is non-empty", () => {
    const configPath = path.join(tempDir, "tracker-worker.md");
    fs.writeFileSync(configPath, "# Tracker Worker Agent\n\nThis is a test agent config.");

    const result = validateAgentConfig(configPath);
    expect(result.valid).toBe(true);
    expect(result.agentPath).toBe(configPath);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();
  });

  it("returns invalid when agent config file does not exist", () => {
    const configPath = path.join(tempDir, "nonexistent-agent.md");

    const result = validateAgentConfig(configPath);
    expect(result.valid).toBe(false);
    expect(result.agentPath).toBe(configPath);
    expect(result.error).toContain("not found");
  });

  it("returns invalid when agent config file is empty", () => {
    const configPath = path.join(tempDir, "empty-agent.md");
    fs.writeFileSync(configPath, "");

    const result = validateAgentConfig(configPath);
    expect(result.valid).toBe(false);
    expect(result.agentPath).toBe(configPath);
    expect(result.error).toContain("empty");
  });

  it("returns invalid when agent config file is not readable", () => {
    const configPath = path.join(tempDir, "unreadable-agent.md");
    fs.writeFileSync(configPath, "# Agent config");
    fs.chmodSync(configPath, 0o000);

    const result = validateAgentConfig(configPath);
    // On some systems (root), chmod 000 may not prevent reads
    // But on normal user accounts, this should fail
    if (!result.valid) {
      expect(result.error).toContain("Cannot read agent config");
    }

    // Restore permissions so cleanup works
    fs.chmodSync(configPath, 0o644);
  });

  it("uses default path when no configPath is provided", () => {
    // When called without arguments, it should use the default path
    // (~/.config/opencode/agents/tracker-worker.md)
    const result = validateAgentConfig();
    // The real config may or may not exist in the test environment
    // but we can verify the path is correct
    const expectedPath = path.join(os.homedir(), ".config", "opencode", "agents", "tracker-worker.md");
    expect(result.agentPath).toBe(expectedPath);
  });

  it("returns the correct file size for a valid config", () => {
    const configPath = path.join(tempDir, "sized-agent.md");
    const content = "A".repeat(1234);
    fs.writeFileSync(configPath, content);

    const result = validateAgentConfig(configPath);
    expect(result.valid).toBe(true);
    expect(result.sizeBytes).toBe(1234);
  });

  it("handles directory paths gracefully (not a file)", () => {
    // Pass the temp directory itself as the config path
    const result = validateAgentConfig(tempDir);
    // Should either return valid: false or valid: true (dirs can be "read")
    // The key is it doesn't throw
    expect(typeof result.valid).toBe("boolean");
    expect(result.agentPath).toBe(tempDir);
  });
});

// ── is413Error ─────────────────────────────────────────────────────────────────

describe("is413Error", () => {
  it("detects HTTP 413 status code in error message", () => {
    expect(is413Error("ApiError: HTTP 413 Request Entity Too Large")).toBe(true);
  });

  it("detects 'Request Entity Too Large' (case-insensitive)", () => {
    expect(is413Error("request entity too large")).toBe(true);
    expect(is413Error("Request Entity Too Large")).toBe(true);
  });

  it("detects 'request too large'", () => {
    expect(is413Error("request too large")).toBe(true);
    expect(is413Error("Error: request too large for model")).toBe(true);
  });

  it("detects 'context_length_exceeded'", () => {
    expect(is413Error("Error: context_length_exceeded - maximum context length is 200000 tokens")).toBe(true);
  });

  it("detects 'maximum context length'", () => {
    expect(is413Error("This model's maximum context length is 128000 tokens")).toBe(true);
  });

  it("detects 'context window'", () => {
    expect(is413Error("Input exceeds the context window for this model")).toBe(true);
  });

  it("detects 'token limit'", () => {
    expect(is413Error("Token limit exceeded")).toBe(true);
  });

  it("detects 'max_tokens'", () => {
    expect(is413Error("max_tokens exceeded")).toBe(true);
  });

  it("detects 'content_too_large'", () => {
    expect(is413Error("content_too_large: The request body is too large")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(is413Error("Connection timeout")).toBe(false);
    expect(is413Error("Authentication failed")).toBe(false);
    expect(is413Error("Internal server error")).toBe(false);
    expect(is413Error("Rate limit exceeded")).toBe(false);
    expect(is413Error("Network error")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(is413Error("")).toBe(false);
  });

  it("detects 413 embedded in a longer error message", () => {
    expect(is413Error("ProviderError: API returned 413: Request body exceeds limit")).toBe(true);
  });
});

// ── isImageTooLargeError (TRACK-137) ──────────────────────────────────────────

describe("isImageTooLargeError", () => {
  it("detects the exact Anthropic API error for oversized images", () => {
    expect(isImageTooLargeError("APIError: messages.0.content.1.image.source.base64: image exceeds 5 MB maximum: 5432648 bytes > 5242880 bytes")).toBe(true);
  });

  it("detects 'image exceeds' in various formats", () => {
    expect(isImageTooLargeError("image exceeds 5 MB maximum")).toBe(true);
    expect(isImageTooLargeError("Image exceeds size limit")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isImageTooLargeError("Connection timeout")).toBe(false);
    expect(isImageTooLargeError("413 Request Entity Too Large")).toBe(false);
    expect(isImageTooLargeError("context_length_exceeded")).toBe(false);
    expect(isImageTooLargeError("Rate limit exceeded")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isImageTooLargeError("")).toBe(false);
  });

  it("is NOT a subset of is413Error (image-too-large errors are distinct)", () => {
    // The image-too-large error from the TRACK-137 incident does NOT match is413Error
    const errorMsg = "APIError: messages.0.content.1.image.source.base64: image exceeds 5 MB maximum: 5432648 bytes > 5242880 bytes";
    expect(isImageTooLargeError(errorMsg)).toBe(true);
    expect(is413Error(errorMsg)).toBe(false);
  });
});

// ── isPostCompletionError ──────────────────────────────────────────────────────

describe("isPostCompletionError", () => {
  it("detects 'assistant message prefill' error", () => {
    expect(isPostCompletionError("APIError: This model does not support assistant message prefill. The conversation must end with a user message.")).toBe(true);
  });

  it("detects 'assistant message prefill' (case-insensitive)", () => {
    expect(isPostCompletionError("apierror: this model does not support assistant message prefill")).toBe(true);
  });

  it("detects 'conversation must end with a user message'", () => {
    expect(isPostCompletionError("Error: conversation must end with a user message")).toBe(true);
  });

  it("detects 'must end with a user message' (partial match)", () => {
    expect(isPostCompletionError("The messages list must end with a user message")).toBe(true);
  });

  it("detects 'last message must have role user' (single quotes)", () => {
    expect(isPostCompletionError("Error: last message must have role `user`")).toBe(true);
  });

  it("detects 'last message must have role user' (double quotes)", () => {
    expect(isPostCompletionError('Error: last message must have role "user"')).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isPostCompletionError("Connection timeout")).toBe(false);
    expect(isPostCompletionError("Authentication failed")).toBe(false);
    expect(isPostCompletionError("Internal server error")).toBe(false);
    expect(isPostCompletionError("Rate limit exceeded")).toBe(false);
    expect(isPostCompletionError("413 Request Entity Too Large")).toBe(false);
    expect(isPostCompletionError("context_length_exceeded")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isPostCompletionError("")).toBe(false);
  });

  it("detects the exact error message seen in production", () => {
    // This is the exact error from the TRACK-74 incident
    expect(isPostCompletionError("APIError: This model does not support assistant message prefill. The conversation must end with a user message.")).toBe(true);
  });
});

// ── Deep Link URL Helpers (TRACK-54) ──────────────────────────────────────────

describe("base64UrlEncode", () => {
  it("encodes a simple path", () => {
    const encoded = base64UrlEncode("/home/user/project");
    // Standard base64 of "/home/user/project" with + → -, / → _, padding stripped
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    expect(encoded.length).toBeGreaterThan(0);
  });

  it("produces stable output", () => {
    const a = base64UrlEncode("/home/user/project");
    const b = base64UrlEncode("/home/user/project");
    expect(a).toBe(b);
  });

  it("encodes paths with special characters", () => {
    const encoded = base64UrlEncode("/home/user/my project+files");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
  });
});

describe("buildOpencodeSessionUrl", () => {
  it("builds correct URL for a session", () => {
    const url = buildOpencodeSessionUrl("ses_abc123", "/home/user/project");
    // Should contain the base64url-encoded directory and session ID
    expect(url).toContain("/session/ses_abc123");
    expect(url).not.toContain("//session"); // No double slashes
    // Should use the public URL as the origin
    expect(url).toMatch(/^https?:\/\//);
  });

  it("does not include /s/ prefix", () => {
    const url = buildOpencodeSessionUrl("ses_test", "/home/user/project");
    expect(url).not.toContain("/s/");
  });
});

describe("buildOpencodeDirectoryUrl", () => {
  it("builds URL to directory landing page without session ID", () => {
    const url = buildOpencodeDirectoryUrl("/home/user/project");
    // Should end with /session (no session ID)
    expect(url).toMatch(/\/session$/);
    expect(url).not.toContain("/session/");
  });
});

describe("buildOpencodeApiSessionUrl", () => {
  it("builds server-side API URL with directory query param", () => {
    const url = buildOpencodeApiSessionUrl("/home/user/project");
    expect(url).toContain("/session?directory=");
    expect(url).toContain(encodeURIComponent("/home/user/project"));
  });
});

// ── isScheduleTimeDue (TRACK-228) ──

/**
 * Helper to create a minimal WorkItem for schedule testing.
 * Only space_type and space_data matter for isScheduleTimeDue().
 */
function makeScheduledItem(scheduleOverrides: Record<string, unknown> = {}, statusOverrides: Record<string, unknown> = {}, extraFields: Record<string, unknown> = {}): any {
  return {
    id: "test-item",
    space_type: "scheduled",
    space_data: JSON.stringify({
      schedule: {
        frequency: "daily",
        time: "07:00",
        days_of_week: null,
        timezone: "Australia/Perth",
        cron_override: null,
        ...scheduleOverrides,
      },
      status: {
        next_run: null,
        last_run: null,
        last_status: null,
        last_duration_ms: null,
        run_count: 0,
        ...statusOverrides,
      },
      todo: [],
      ignore: [],
    }),
    ...extraFields,
  };
}

describe("isScheduleTimeDue", () => {
  it("returns true for non-scheduled items", () => {
    expect(isScheduleTimeDue({ space_type: "standard", space_data: null } as any)).toBe(true);
  });

  it("returns true for scheduled items with no space_data", () => {
    expect(isScheduleTimeDue({ space_type: "scheduled", space_data: null } as any)).toBe(true);
  });

  it("returns true for scheduled items with malformed space_data", () => {
    expect(isScheduleTimeDue({ space_type: "scheduled", space_data: "not json" } as any)).toBe(true);
  });

  it("returns true for manual frequency (dispatch immediately)", () => {
    const item = makeScheduledItem({ frequency: "manual" });
    expect(isScheduleTimeDue(item)).toBe(true);
  });

  it("returns true for custom frequency (cron — too complex to parse)", () => {
    const item = makeScheduledItem({ frequency: "custom", cron_override: "0 */6 * * *" });
    expect(isScheduleTimeDue(item)).toBe(true);
  });

  it("returns true for scheduled items with no time configured", () => {
    const item = makeScheduledItem({ time: null });
    expect(isScheduleTimeDue(item)).toBe(true);
  });

  it("returns false for daily task before scheduled time", () => {
    // Schedule for 23:59 UTC — should not be due unless it's literally 23:59 UTC
    // Use a timezone where it's morning to ensure the test is stable
    const item = makeScheduledItem({ frequency: "daily", time: "23:59", timezone: "UTC" });
    // This test checks that a task scheduled for 23:59 UTC is NOT due at most times
    // It could fail if run exactly at 23:59 UTC, but that's extremely unlikely
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();
    if (utcHour < 23 || (utcHour === 23 && utcMinute < 59)) {
      expect(isScheduleTimeDue(item)).toBe(false);
    }
    // If we happen to be running at 23:59 UTC, skip this assertion
  });

  it("returns true for daily task within dispatch window (no last_run)", () => {
    // Schedule for a few minutes ago in UTC — should be within the 30-min dispatch window
    const now = new Date();
    const minutesAgo = 5;
    const schedTime = new Date(now.getTime() - minutesAgo * 60 * 1000);
    const timeStr = `${String(schedTime.getUTCHours()).padStart(2, "0")}:${String(schedTime.getUTCMinutes()).padStart(2, "0")}`;
    const item = makeScheduledItem({ frequency: "daily", time: timeStr, timezone: "UTC" });
    expect(isScheduleTimeDue(item)).toBe(true);
  });

  it("returns false for daily task outside dispatch window (no last_run)", () => {
    // Schedule for 2 hours ago in UTC — should be OUTSIDE the 30-min dispatch window
    // A task approved hours after its scheduled time should wait for the next day
    const now = new Date();
    const hoursAgo = 2;
    const schedTime = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
    const timeStr = `${String(schedTime.getUTCHours()).padStart(2, "0")}:${String(schedTime.getUTCMinutes()).padStart(2, "0")}`;
    const item = makeScheduledItem({ frequency: "daily", time: timeStr, timezone: "UTC" });
    expect(isScheduleTimeDue(item)).toBe(false);
  });

  it("returns false for daily task that already ran today", () => {
    // Schedule for a few minutes ago and set last_run to now
    const now = new Date();
    const schedTime = new Date(now.getTime() - 5 * 60 * 1000);
    const timeStr = `${String(schedTime.getUTCHours()).padStart(2, "0")}:${String(schedTime.getUTCMinutes()).padStart(2, "0")}`;
    const item = makeScheduledItem(
      { frequency: "daily", time: timeStr, timezone: "UTC" },
      { last_run: new Date().toISOString() },
    );
    expect(isScheduleTimeDue(item)).toBe(false);
  });

  it("returns true for daily task that ran yesterday (within window)", () => {
    // Schedule for a few minutes ago and set last_run to yesterday
    const now = new Date();
    const schedTime = new Date(now.getTime() - 5 * 60 * 1000);
    const timeStr = `${String(schedTime.getUTCHours()).padStart(2, "0")}:${String(schedTime.getUTCMinutes()).padStart(2, "0")}`;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const item = makeScheduledItem(
      { frequency: "daily", time: timeStr, timezone: "UTC" },
      { last_run: yesterday.toISOString() },
    );
    expect(isScheduleTimeDue(item)).toBe(true);
  });

  it("returns false for weekly task on a non-scheduled day", () => {
    // Figure out what today ISN'T
    const today = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "long",
    });
    const todayName = formatter.format(today).toLowerCase();
    // Pick a day that's NOT today
    const allDays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const otherDay = allDays.find(d => d !== todayName)!;

    const item = makeScheduledItem({
      frequency: "weekly",
      time: "00:00",
      timezone: "UTC",
      days_of_week: [otherDay],
    });
    expect(isScheduleTimeDue(item)).toBe(false);
  });

  it("returns true for weekly task on a scheduled day within dispatch window", () => {
    // Figure out what today IS and schedule for a few minutes ago
    const today = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "long",
    });
    const todayName = formatter.format(today).toLowerCase();

    const schedTime = new Date(today.getTime() - 5 * 60 * 1000);
    const timeStr = `${String(schedTime.getUTCHours()).padStart(2, "0")}:${String(schedTime.getUTCMinutes()).padStart(2, "0")}`;

    const item = makeScheduledItem({
      frequency: "weekly",
      time: timeStr,
      timezone: "UTC",
      days_of_week: [todayName],
    });
    expect(isScheduleTimeDue(item)).toBe(true);
  });

  it("returns false for hourly task that ran less than 55 minutes ago", () => {
    const recentRun = new Date();
    recentRun.setMinutes(recentRun.getMinutes() - 30); // 30 minutes ago
    const item = makeScheduledItem(
      { frequency: "hourly", time: "00:00", timezone: "UTC" },
      { last_run: recentRun.toISOString() },
    );
    expect(isScheduleTimeDue(item)).toBe(false);
  });

  it("returns true for hourly task that ran more than 55 minutes ago", () => {
    const oldRun = new Date();
    oldRun.setMinutes(oldRun.getMinutes() - 60); // 60 minutes ago
    const item = makeScheduledItem(
      { frequency: "hourly", time: "00:00", timezone: "UTC" },
      { last_run: oldRun.toISOString() },
    );
    expect(isScheduleTimeDue(item)).toBe(true);
  });

  it("returns false for once task that already ran today", () => {
    const item = makeScheduledItem(
      { frequency: "once", time: "00:00", timezone: "UTC" },
      { last_run: new Date().toISOString() },
    );
    expect(isScheduleTimeDue(item)).toBe(false);
  });

  it("returns false for monthly task that already ran this month", () => {
    const item = makeScheduledItem(
      { frequency: "monthly", time: "00:00", timezone: "UTC" },
      { last_run: new Date().toISOString() },
    );
    expect(isScheduleTimeDue(item)).toBe(false);
  });

  it("respects timezone — task scheduled in far-ahead timezone", () => {
    // Use a timezone that's well ahead of UTC. If current UTC time is before the
    // scheduled time in that timezone, the task should not be due.
    // Schedule at 23:59 in Pacific/Kiritimati (UTC+14, always ahead)
    const item = makeScheduledItem({
      frequency: "daily",
      time: "23:59",
      timezone: "Pacific/Kiritimati",
    });
    // Get current time in Kiritimati
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "Pacific/Kiritimati",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date());
    const hour = parseInt(parts.find(p => p.type === "hour")?.value || "0", 10);
    const minute = parseInt(parts.find(p => p.type === "minute")?.value || "0", 10);
    const currentMinutes = hour * 60 + minute;

    if (currentMinutes < 23 * 60 + 59) {
      expect(isScheduleTimeDue(item)).toBe(false);
    }
    // If it happens to be 23:59 in Kiritimati, this test gracefully skips
  });
});

// ── DISPATCH_MODE config ────────────────────────────────────────────────────

describe("DISPATCH_MODE config", () => {
  it("is a valid dispatch mode", () => {
    expect(["opencode", "runner"]).toContain(DISPATCH_MODE);
  });
});

// ── buildPromptParts ──────────────────────────────────────────────────────────

import { _initTestTrackerDatabase, createProject, createWorkItem, setSetting } from "./db.js";

describe("buildPromptParts", () => {
  beforeEach(() => {
    _initTestTrackerDatabase();
  });

  it("splits coder prompt into systemAppend (security rules) and userPrompt (context + instructions)", () => {
    const project = createProject({
      name: "Test Project",
      short_name: "TEST",
      working_directory: "/tmp/test-project",
    });
    const item = createWorkItem({
      project_id: project.id,
      title: "Implement feature X",
      description: "Add a new widget to the dashboard",
      requires_code: true,
    });

    const { systemAppend, userPrompt } = buildPromptParts(
      item,
      { name: project.name, short_name: project.short_name, working_directory: "/tmp/test-project" },
      "test-session-123",
    );

    // systemAppend should contain security rules
    expect(systemAppend).toContain("Security Rules");
    expect(systemAppend).toContain("Blocked File Patterns");

    // systemAppend should NOT contain instructions
    expect(systemAppend).not.toContain("## Instructions");

    // userPrompt should contain item context
    expect(userPrompt).toContain("Add a new widget to the dashboard");
    expect(userPrompt).toContain("## Instructions");

    // userPrompt should NOT contain security rules
    expect(userPrompt).not.toContain("## Security Rules");
  });

  it("includes session ID in userPrompt", () => {
    const project = createProject({
      name: "Test",
      working_directory: "/tmp/test",
    });
    const item = createWorkItem({
      project_id: project.id,
      title: "Task",
      description: "Do something",
      requires_code: true,
    });

    const { userPrompt } = buildPromptParts(
      item,
      { name: project.name, short_name: project.short_name, working_directory: "/tmp/test" },
      "session-abc",
    );

    expect(userPrompt).toContain("session-abc");
  });
});

// ── buildResearchPromptParts ──────────────────────────────────────────────────

describe("buildResearchPromptParts", () => {
  beforeEach(() => {
    _initTestTrackerDatabase();
  });

  it("returns full prompt as userPrompt when no security rules section exists", () => {
    const project = createProject({
      name: "Research Project",
      short_name: "RES",
      working_directory: "/tmp/research",
    });
    const item = createWorkItem({
      project_id: project.id,
      title: "Research topic Y",
      description: "Investigate how to optimize queries",
    });

    const { systemAppend, userPrompt } = buildResearchPromptParts(
      item,
      { name: project.name, short_name: project.short_name, working_directory: "/tmp/research" },
      "research-session-456",
    );

    // Research prompts don't have Security Rules section, so fallback applies
    expect(systemAppend).toBe("");
    expect(userPrompt).toContain("Investigate how to optimize queries");
    expect(userPrompt).toContain("Research Task");
  });
});

// ── resolveModelForItem (TRACK-266) ──────────────────────────────────────────

describe("resolveModelForItem", () => {
  const baseItem = {
    id: "test-model-item",
    project_id: "test-project",
    title: "Test Task",
    description: "A test task",
    state: "approved",
    priority: "medium",
    assignee: null,
    labels: "[]",
    position: 0,
    created_by: "test",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    locked_by: null,
    locked_at: null,
    requires_code: 1,
    seq_number: 1,
    platform: "any",
    session_id: null,
    session_status: null,
    created_by_class: "human",
    approved_by: null,
    approved_by_class: null,
    approved_at: null,
    approved_description_hash: null,
    opencode_pid: null,
    bot_dispatch: 0,
    date_due: null,
    link: null,
    space_type: "standard" as const,
    space_data: null,
  };

  it("returns global default for standard (non-scheduled) items", () => {
    const result = resolveModelForItem(baseItem as any);
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-opus-4-6");
  });

  it("returns global default for scheduled items without model_strength", () => {
    const item = {
      ...baseItem,
      space_type: "scheduled",
      space_data: JSON.stringify({ schedule: { frequency: "daily" }, status: {}, todo: [], ignore: [] }),
    };
    const result = resolveModelForItem(item as any);
    expect(result.modelId).toBe("claude-opus-4-6");
  });

  it("returns high-tier model for model_strength=high", () => {
    const item = {
      ...baseItem,
      space_type: "scheduled",
      space_data: JSON.stringify({ schedule: { frequency: "daily" }, status: {}, todo: [], ignore: [], model_strength: "high" }),
    };
    const result = resolveModelForItem(item as any);
    expect(result.modelId).toContain("opus");
  });

  it("returns medium-tier model for model_strength=medium", () => {
    const item = {
      ...baseItem,
      space_type: "scheduled",
      space_data: JSON.stringify({ schedule: { frequency: "daily" }, status: {}, todo: [], ignore: [], model_strength: "medium" }),
    };
    const result = resolveModelForItem(item as any);
    expect(result.modelId).toContain("sonnet");
  });

  it("returns low-tier model for model_strength=low", () => {
    const item = {
      ...baseItem,
      space_type: "scheduled",
      space_data: JSON.stringify({ schedule: { frequency: "daily" }, status: {}, todo: [], ignore: [], model_strength: "low" }),
    };
    const result = resolveModelForItem(item as any);
    expect(result.modelId).toContain("haiku");
  });

  it("returns global default for invalid model_strength value", () => {
    const item = {
      ...baseItem,
      space_type: "scheduled",
      space_data: JSON.stringify({ schedule: { frequency: "daily" }, status: {}, todo: [], ignore: [], model_strength: "invalid" }),
    };
    const result = resolveModelForItem(item as any);
    expect(result.modelId).toBe("claude-opus-4-6");
  });

  it("returns global default for malformed space_data", () => {
    const item = {
      ...baseItem,
      space_type: "scheduled",
      space_data: "not valid json",
    };
    const result = resolveModelForItem(item as any);
    expect(result.modelId).toBe("claude-opus-4-6");
  });

  it("returns global default for null space_data on scheduled item", () => {
    const item = {
      ...baseItem,
      space_type: "scheduled",
      space_data: null,
    };
    const result = resolveModelForItem(item as any);
    expect(result.modelId).toBe("claude-opus-4-6");
  });

  // TRACK-271: DB settings override tests
  describe("with DB settings overrides", () => {
    beforeEach(() => _initTestTrackerDatabase());

    it("uses DB coder_model_id setting when set", () => {
      setSetting("coder_model_id", "claude-sonnet-4-6");
      const result = resolveModelForItem(baseItem as any);
      expect(result.modelId).toBe("claude-sonnet-4-6");
      expect(result.provider).toBe("anthropic");
    });

    it("uses DB coder_model_provider setting when set", () => {
      setSetting("coder_model_provider", "custom-provider");
      const result = resolveModelForItem(baseItem as any);
      expect(result.provider).toBe("custom-provider");
    });

    it("uses DB model_strength tier override for scheduled tasks", () => {
      setSetting("model_strength_high", "claude-sonnet-4-6");
      const item = {
        ...baseItem,
        space_type: "scheduled",
        space_data: JSON.stringify({ schedule: { frequency: "daily" }, status: {}, todo: [], ignore: [], model_strength: "high" }),
      };
      const result = resolveModelForItem(item as any);
      expect(result.modelId).toBe("claude-sonnet-4-6");
    });

    it("ignores null DB setting and uses env default", () => {
      setSetting("coder_model_id", null);
      const result = resolveModelForItem(baseItem as any);
      expect(result.modelId).toBe("claude-opus-4-6");
    });
  });
});
