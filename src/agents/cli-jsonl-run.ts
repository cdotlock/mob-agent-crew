import { AsyncQueue, deferred } from "./async-queue.js";
import { JsonlDecoder } from "./jsonl.js";
import type { NativeMapper } from "./native-mappers.js";
import {
  spawnSupervisedProcess,
  type SpawnSupervisedProcessOptions,
  type SupervisedProcess,
} from "./process-supervisor.js";
import type {
  AgentCommand,
  AgentCommandAck,
  AgentDriverId,
  AgentEvent,
  AgentEventDraft,
  AgentRun,
  AgentRunInput,
  AgentRunOutcome,
  AgentRunResult,
  NativeTerminal,
} from "./types.js";
import { UnsupportedAgentCapabilityError } from "./types.js";

export interface OneShotJsonlRunOptions {
  readonly driver: AgentDriverId;
  readonly input: AgentRunInput;
  readonly process: SupervisedProcess;
  readonly mapper: NativeMapper;
  readonly cancelGraceMs?: number;
  readonly maxFrameBytes?: number;
}

export interface SpawnOneShotJsonlRunOptions
  extends Omit<SpawnSupervisedProcessOptions, "cwd" | "timeoutMs" | "onTimeout"> {
  readonly driver: AgentDriverId;
  readonly input: AgentRunInput;
  readonly mapper: NativeMapper;
  /** Close an otherwise-unused stdin pipe once output listeners are attached. */
  readonly closeStdinAfterSpawn?: boolean;
  readonly cancelGraceMs?: number;
  readonly maxFrameBytes?: number;
}

export async function spawnOneShotJsonlRun(
  options: SpawnOneShotJsonlRunOptions,
): Promise<AgentRun> {
  const process = await spawnSupervisedProcess({
    command: options.command,
    ...(options.args ? { args: options.args } : {}),
    cwd: options.input.cwd,
    ...(options.env ? { env: options.env } : {}),
    ...(options.envAllowlist ? { envAllowlist: options.envAllowlist } : {}),
    ...(options.killGraceMs !== undefined
      ? { killGraceMs: options.killGraceMs }
      : {}),
    ...(options.homePrefix ? { homePrefix: options.homePrefix } : {}),
  });
  const run = new OneShotJsonlRun({
    driver: options.driver,
    input: options.input,
    process,
    mapper: options.mapper,
    ...(options.cancelGraceMs !== undefined
      ? { cancelGraceMs: options.cancelGraceMs }
      : {}),
    ...(options.maxFrameBytes !== undefined
      ? { maxFrameBytes: options.maxFrameBytes }
      : {}),
  });
  if (options.closeStdinAfterSpawn) process.closeStdin();
  return run;
}

export class OneShotJsonlRun implements AgentRun {
  readonly #driver: AgentDriverId;
  readonly #input: AgentRunInput;
  readonly #process: SupervisedProcess;
  readonly #mapper: NativeMapper;
  readonly #decoder: JsonlDecoder;
  readonly #events = new AsyncQueue<AgentEvent>();
  readonly #result = deferred<AgentRunResult>();
  readonly #cancelGraceMs: number;
  readonly #stderr: string[] = [];
  #sequence = 0;
  #terminal: NativeTerminal | undefined;
  #requestedOutcome: "cancelled" | "timed_out" | undefined;
  #protocolError: string | undefined;
  #sessionId: string | undefined;
  #lastMessage: string | undefined;
  #settled = false;

  constructor(options: OneShotJsonlRunOptions) {
    this.#driver = options.driver;
    this.#input = options.input;
    this.#process = options.process;
    this.#mapper = options.mapper;
    this.#decoder = new JsonlDecoder({
      maxFrameBytes: options.maxFrameBytes ?? 4 * 1024 * 1024,
    });
    this.#cancelGraceMs = options.cancelGraceMs ?? 2_000;

    this.events = this.#events;
    this.result = this.#result.promise;
    this.#emit({
      kind: "runtime.started",
      nativeType: "process.spawned",
      data: { pid: this.#process.child.pid ?? null },
    });
    this.#wireProcess();

    if (options.input.timeoutMs !== undefined) {
      this.#process.armTimeout(options.input.timeoutMs, {
        softGraceMs: 0,
        onTimeout: async () => {
          await this.#cancelAs("timed_out");
        },
      });
    }
  }

  readonly events: AsyncIterable<AgentEvent>;
  readonly result: Promise<AgentRunResult>;

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return this.#events[Symbol.asyncIterator]();
  }

  send(command: AgentCommand): Promise<AgentCommandAck> {
    const capability = command.type === "steer" ? "steer" : "followUp";
    return Promise.reject(
      new UnsupportedAgentCapabilityError(this.#driver, capability),
    );
  }

  cancel(): Promise<void> {
    return this.#cancelAs("cancelled");
  }

  async forceKill(): Promise<void> {
    if (!this.#requestedOutcome) this.#requestedOutcome = "cancelled";
    await this.#process.forceKill();
  }

  async #cancelAs(outcome: "cancelled" | "timed_out"): Promise<void> {
    if (!this.#requestedOutcome) this.#requestedOutcome = outcome;
    await this.#process.cancel({ signal: "SIGINT", graceMs: this.#cancelGraceMs });
  }

  #wireProcess(): void {
    this.#process.child.stdout.on("data", (chunk: Buffer) => {
      this.#decodeChunk(chunk);
    });
    this.#process.child.stdout.once("end", () => {
      try {
        for (const frame of this.#decoder.end()) this.#handleFrame(frame);
      } catch (error) {
        this.#failProtocol(error);
      }
    });
    this.#process.child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8");
      this.#stderr.push(message);
      this.#emit({
        kind: "warning",
        nativeType: "process.stderr",
        message: truncate(message.trim(), 8_192),
      });
    });

    void this.#process.exit.then((exit) => this.#finish(exit.code, exit.signal));
  }

  #decodeChunk(chunk: Buffer): void {
    try {
      for (const frame of this.#decoder.push(chunk)) this.#handleFrame(frame);
    } catch (error) {
      this.#failProtocol(error);
    }
  }

  #handleFrame(frame: unknown): void {
    if (this.#settled) return;
    const mapping = this.#mapper(frame);
    for (const draft of mapping.events) {
      this.#captureSession(draft);
      this.#captureMessage(draft);
      this.#emit(draft);
    }
    if (mapping.terminal) {
      this.#terminal = {
        ...mapping.terminal,
        ...(mapping.terminal.finalMessage
          ? {}
          : this.#lastMessage
            ? { finalMessage: this.#lastMessage }
            : {}),
        ...(mapping.terminal.sessionId
          ? {}
          : this.#sessionId
            ? { sessionId: this.#sessionId }
            : {}),
      };
    }
  }

  #captureSession(event: AgentEventDraft): void {
    const value = event.data?.thread_id ?? event.data?.session_id;
    if (typeof value === "string") this.#sessionId = value;
  }

  #captureMessage(event: AgentEventDraft): void {
    if (!event.message) return;
    if (event.kind === "message.delta") {
      this.#lastMessage = `${this.#lastMessage ?? ""}${event.message}`;
    } else if (event.kind === "message.completed") {
      this.#lastMessage = event.message;
    }
  }

  #failProtocol(error: unknown): void {
    if (this.#protocolError) return;
    this.#protocolError = error instanceof Error ? error.message : String(error);
    this.#emit({
      kind: "error",
      nativeType: "protocol.jsonl",
      message: this.#protocolError,
    });
    void this.#process.cancel({ signal: "SIGTERM", graceMs: 250 });
  }

  async #finish(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.#settled) return;
    this.#settled = true;

    this.#emit({
      kind: "process.exited",
      nativeType: "process.close",
      data: { code, signal },
    });

    const outcome = this.#outcome(code);
    const error = this.#resultError(outcome, code, signal);
    const result: AgentRunResult = {
      outcome,
      exitCode: code,
      signal,
      terminalObserved: this.#terminal !== undefined,
      ...(this.#terminal?.finalMessage
        ? { finalMessage: this.#terminal.finalMessage }
        : {}),
      ...(this.#terminal?.sessionId
        ? { sessionId: this.#terminal.sessionId }
        : this.#sessionId
          ? { sessionId: this.#sessionId }
          : {}),
      ...(error ? { error } : {}),
    };

    await this.#process.cleanup();
    this.#events.end();
    this.#result.resolve(result);
  }

  #outcome(code: number | null): AgentRunOutcome {
    if (this.#requestedOutcome) return this.#requestedOutcome;
    if (this.#terminal?.outcome === "failed" || this.#protocolError) return "failed";
    if (this.#terminal?.outcome === "completed" && code === 0) return "completed";
    return "failed";
  }

  #resultError(
    outcome: AgentRunOutcome,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): string | undefined {
    if (outcome !== "failed") return undefined;
    if (this.#terminal?.error) return this.#terminal.error;
    if (this.#protocolError) return this.#protocolError;
    if (!this.#terminal) {
      const stderr = truncate(this.#stderr.join("").trim(), 8_192);
      return stderr || `Process exited without a terminal event (code=${String(code)}, signal=${String(signal)})`;
    }
    return `Process exited after completion with code ${String(code)}`;
  }

  #emit(draft: AgentEventDraft): void {
    this.#sequence += 1;
    this.#events.push({
      version: 1,
      driver: this.#driver,
      jobId: this.#input.jobId,
      attemptId: this.#input.attemptId,
      sequence: this.#sequence,
      timestamp: new Date().toISOString(),
      ...draft,
    });
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}
