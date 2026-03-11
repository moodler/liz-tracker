/**
 * Orchestrator unit tests
 *
 * Tests PID-based stale session detection, related helpers,
 * and agent config validation.
 * Uses dependency injection for the exec function to avoid ESM spy limitations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isProcessAlive, resolveOpencodePid, sendSignal, killProcessGracefully, validateAgentConfig, is413Error, isImageTooLargeError, isPostCompletionError } from "./orchestrator.js";
import { base64UrlEncode, buildOpencodeSessionUrl, buildOpencodeDirectoryUrl, buildOpencodeApiSessionUrl } from "./config.js";
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
