// Shared types for the session runner stdio JSON protocol.
// Used by both the runner (src/session-runner.ts) and the orchestrator (src/orchestrator.ts).

// ── Runner → Orchestrator (stdout events) ──

export interface RunnerStartedEvent {
  event: "started";
  sessionId: string;
  sdkSessionId?: string;
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

// ── Orchestrator → Runner (stdin messages) ──

export interface RunnerConfig {
  event: "config";
  itemKey: string;
  prompt: string;
  systemPromptAppend: string;
  cwd: string;
  model: string;
  maxTurns: number;
  promptType: "coder" | "research";
  attachments: Array<{ path: string; mime: string; filename: string }>;
  trackerMcpUrl?: string;
}

export interface RunnerSteerMessage {
  event: "steer";
  message: string;
}

export interface RunnerAbortMessage {
  event: "abort";
}

export type RunnerIncomingMessage = RunnerConfig | RunnerSteerMessage | RunnerAbortMessage;
