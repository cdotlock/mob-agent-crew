export type AgentDriverId = "mock" | "codex" | "claude" | "pi" | "omp";

export type AgentTransport = "in-process" | "one-shot" | "duplex-jsonl";

export interface AgentCapabilities {
  readonly transport: AgentTransport;
  readonly steer: boolean;
  readonly followUp: boolean;
  readonly nativeCancel: boolean;
  readonly sessionResume: boolean;
  readonly sandbox:
    | "mock"
    | "workspace-write"
    | "external-isolation-required";
  readonly completionSignal: string;
  readonly notes: readonly string[];
}

export type AgentEventKind =
  | "runtime.started"
  | "runtime.ready"
  | "command.accepted"
  | "command.rejected"
  | "turn.started"
  | "message.delta"
  | "message.completed"
  | "tool.started"
  | "tool.progress"
  | "tool.completed"
  | "usage.updated"
  | "warning"
  | "error"
  | "turn.completed"
  | "turn.failed"
  | "process.exited";

export interface AgentEvent {
  readonly version: 1;
  readonly driver: AgentDriverId;
  readonly jobId: string;
  readonly attemptId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly kind: AgentEventKind;
  readonly nativeType?: string;
  readonly message?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface AgentRunInput {
  readonly jobId: string;
  readonly attemptId: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
  /**
   * Explicit environment additions for this run. The process supervisor never
   * inherits the ambient environment wholesale.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type AgentCommand =
  | { readonly type: "steer"; readonly message: string }
  | { readonly type: "follow_up"; readonly message: string };

export interface AgentCommandAck {
  readonly accepted: boolean;
  readonly command: AgentCommand["type"] | "prompt" | "abort" | "get_state";
  readonly requestId?: string;
  readonly error?: string;
}

export type AgentRunOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface AgentRunResult {
  readonly outcome: AgentRunOutcome;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly terminalObserved: boolean;
  readonly finalMessage?: string;
  readonly sessionId?: string;
  readonly error?: string;
}

export interface AgentRun extends AsyncIterable<AgentEvent> {
  /** Alias for consumers that prefer `for await (const event of run.events)`. */
  readonly events: AsyncIterable<AgentEvent>;
  readonly result: Promise<AgentRunResult>;
  send(command: AgentCommand): Promise<AgentCommandAck>;
  cancel(reason?: string): Promise<void>;
  forceKill(): Promise<void>;
}

export interface AgentDriver {
  readonly id: AgentDriverId;
  readonly capabilities: AgentCapabilities;
  run(input: AgentRunInput): Promise<AgentRun>;
}

export interface AgentEventDraft {
  readonly kind: AgentEventKind;
  readonly nativeType?: string;
  readonly message?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface NativeTerminal {
  readonly outcome: "completed" | "failed";
  readonly finalMessage?: string;
  readonly sessionId?: string;
  readonly error?: string;
}

export interface NativeEventMapping {
  readonly events: readonly AgentEventDraft[];
  readonly terminal?: NativeTerminal;
}

export class UnsupportedAgentCapabilityError extends Error {
  readonly driver: AgentDriverId;
  readonly capability: "steer" | "followUp";

  constructor(
    driver: AgentDriverId,
    capability: "steer" | "followUp",
  ) {
    super(`${driver} driver does not implement ${capability}`);
    this.name = "UnsupportedAgentCapabilityError";
    this.driver = driver;
    this.capability = capability;
  }
}
