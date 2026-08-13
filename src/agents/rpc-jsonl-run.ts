import { AsyncQueue, deferred, type Deferred } from "./async-queue.js";
import { encodeJsonl, JsonlDecoder } from "./jsonl.js";
import type { NativeMapper } from "./native-mappers.js";
import {
  spawnSupervisedProcess,
  type SpawnSupervisedProcessOptions,
  type SupervisedProcess,
} from "./process-supervisor.js";
import type {
  AgentCapabilities,
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

type RpcCommandType = AgentCommand["type"] | "prompt" | "abort" | "get_state";
type RpcReadiness = "ready-frame" | "get-state";

interface PendingRequest {
  readonly command: RpcCommandType;
  readonly deferred: Deferred<AgentCommandAck>;
  readonly timer: NodeJS.Timeout;
}

export interface SpawnRpcJsonlRunOptions
  extends Omit<SpawnSupervisedProcessOptions, "cwd" | "timeoutMs" | "onTimeout"> {
  readonly driver: AgentDriverId;
  readonly capabilities: AgentCapabilities;
  readonly input: AgentRunInput;
  readonly mapper: NativeMapper;
  readonly readiness: RpcReadiness;
  readonly requestTimeoutMs?: number;
  readonly cancelGraceMs?: number;
  readonly terminalExitGraceMs?: number;
  readonly maxFrameBytes?: number;
}

export async function spawnRpcJsonlRun(
  options: SpawnRpcJsonlRunOptions,
): Promise<AgentRun> {
  const process = await spawnSupervisedProcess({
    command: options.command,
    ...(options.args ? { args: options.args } : {}),
    cwd: options.input.cwd,
    ...(options.env ? { env: options.env } : {}),
    ...(options.envAllowlist ? { envAllowlist: options.envAllowlist } : {}),
    ...(options.profileSeed ? { profileSeed: options.profileSeed } : {}),
    ...(options.killGraceMs !== undefined
      ? { killGraceMs: options.killGraceMs }
      : {}),
    ...(options.homePrefix ? { homePrefix: options.homePrefix } : {}),
  });
  return new RpcJsonlRun({ ...options, process });
}

interface RpcJsonlRunOptions extends SpawnRpcJsonlRunOptions {
  readonly process: SupervisedProcess;
}

export class RpcJsonlRun implements AgentRun {
  readonly #driver: AgentDriverId;
  readonly #capabilities: AgentCapabilities;
  readonly #input: AgentRunInput;
  readonly #process: SupervisedProcess;
  readonly #mapper: NativeMapper;
  readonly #readiness: RpcReadiness;
  readonly #requestTimeoutMs: number;
  readonly #cancelGraceMs: number;
  readonly #terminalExitGraceMs: number;
  readonly #decoder: JsonlDecoder;
  readonly #events = new AsyncQueue<AgentEvent>();
  readonly #result = deferred<AgentRunResult>();
  readonly #ready = deferred<void>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #stderr: string[] = [];
  #requestSequence = 0;
  #eventSequence = 0;
  #terminal: NativeTerminal | undefined;
  #requestedOutcome: "cancelled" | "timed_out" | undefined;
  #protocolError: string | undefined;
  #sessionId: string | undefined;
  #lastMessage: string | undefined;
  #settled = false;
  #cancelPromise: Promise<void> | undefined;
  #outboundMaxFrameBytes: number;

  constructor(options: RpcJsonlRunOptions) {
    this.#driver = options.driver;
    this.#capabilities = options.capabilities;
    this.#input = options.input;
    this.#process = options.process;
    this.#mapper = options.mapper;
    this.#readiness = options.readiness;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#cancelGraceMs = options.cancelGraceMs ?? 1_000;
    this.#terminalExitGraceMs = options.terminalExitGraceMs ?? 2_000;
    this.#outboundMaxFrameBytes = options.maxFrameBytes ?? 4 * 1024 * 1024;
    this.#decoder = new JsonlDecoder({ maxFrameBytes: this.#outboundMaxFrameBytes });
    this.events = this.#events;
    this.result = this.#result.promise;

    this.#emit({
      kind: "runtime.started",
      nativeType: "process.spawned",
      data: { pid: this.#process.child.pid ?? null },
    });
    this.#wireProcess();
    if (this.#input.timeoutMs !== undefined) {
      this.#process.armTimeout(this.#input.timeoutMs, {
        softGraceMs: 0,
        onTimeout: async () => {
          await this.#cancelAs("timed_out");
        },
      });
    }
    void this.#initialize();
  }

  readonly events: AsyncIterable<AgentEvent>;
  readonly result: Promise<AgentRunResult>;

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return this.#events[Symbol.asyncIterator]();
  }

  async send(command: AgentCommand): Promise<AgentCommandAck> {
    if (command.type === "steer" && !this.#capabilities.steer) {
      throw new UnsupportedAgentCapabilityError(this.#driver, "steer");
    }
    if (command.type === "follow_up" && !this.#capabilities.followUp) {
      throw new UnsupportedAgentCapabilityError(this.#driver, "followUp");
    }
    if (this.#terminal || this.#settled || this.#requestedOutcome) {
      return {
        accepted: false,
        command: command.type,
        error: "Agent run is no longer accepting commands",
      };
    }
    return this.#request(command.type, { message: command.message });
  }

  cancel(): Promise<void> {
    return this.#cancelAs("cancelled");
  }

  async forceKill(): Promise<void> {
    if (!this.#requestedOutcome) this.#requestedOutcome = "cancelled";
    await this.#process.forceKill();
  }

  async #initialize(): Promise<void> {
    try {
      if (this.#readiness === "ready-frame") {
        await withTimeout(
          this.#ready.promise,
          this.#requestTimeoutMs,
          `${this.#driver} RPC ready frame`,
        );
      } else {
        const stateAck = await this.#request("get_state", {});
        if (!stateAck.accepted) {
          throw new Error(stateAck.error ?? "get_state was rejected");
        }
        this.#emit({
          kind: "runtime.ready",
          nativeType: "get_state.response",
          data: { requestId: stateAck.requestId ?? null },
        });
      }

      if (this.#requestedOutcome || this.#settled) return;
      const promptAck = await this.#request("prompt", {
        message: this.#input.prompt,
      });
      if (!promptAck.accepted) {
        throw new Error(promptAck.error ?? "Initial prompt was rejected");
      }
    } catch (error) {
      if (this.#requestedOutcome || this.#settled) return;
      this.#failProtocol(error);
    }
  }

  #wireProcess(): void {
    this.#process.child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const frame of this.#decoder.push(chunk)) this.#handleFrame(frame);
      } catch (error) {
        this.#failProtocol(error);
      }
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

  #handleFrame(frame: unknown): void {
    if (this.#settled) return;
    const record = asRecord(frame);
    const type = typeof record.type === "string" ? record.type : undefined;
    if (type === "ready") {
      const maxFrameBytes = record.maxFrameBytes;
      if (typeof maxFrameBytes === "number" && Number.isSafeInteger(maxFrameBytes)) {
        this.#outboundMaxFrameBytes = Math.min(
          this.#outboundMaxFrameBytes,
          maxFrameBytes,
        );
      }
      this.#ready.resolve();
    }

    const id = record.id;
    let mappedFrame = frame;
    if ((typeof id === "string" || typeof id === "number") && record.success !== undefined) {
      const key = String(id);
      const pending = this.#pending.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(key);
        const accepted = record.success === true;
        const error = accepted
          ? undefined
          : errorText(record.error) ?? "RPC command rejected";
        pending.deferred.resolve({
          accepted,
          command: pending.command,
          requestId: key,
          ...(error ? { error } : {}),
        });
        mappedFrame = { ...record, command: pending.command };
      }
    }

    const mapping = this.#mapper(mappedFrame);
    for (const draft of mapping.events) {
      this.#captureSession(draft);
      this.#captureMessage(draft);
      this.#emit(draft);
    }
    if (mapping.terminal && !this.#terminal) {
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
      this.#process.closeStdin();
      void this.#ensureExitAfterTerminal();
    }
  }

  async #request(
    command: RpcCommandType,
    payload: Readonly<Record<string, unknown>>,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<AgentCommandAck> {
    if (this.#settled || this.#process.hasExited) {
      return { accepted: false, command, error: "RPC process has exited" };
    }
    this.#requestSequence += 1;
    const id = `${this.#input.attemptId}:${this.#requestSequence}`;
    const request = { type: command, id, ...payload };
    const encoded = encodeJsonl(request);
    if (Buffer.byteLength(encoded, "utf8") > this.#outboundMaxFrameBytes) {
      return {
        accepted: false,
        command,
        requestId: id,
        error: `RPC frame exceeds ${this.#outboundMaxFrameBytes} bytes`,
      };
    }

    const requestDeferred = deferred<AgentCommandAck>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      requestDeferred.resolve({
        accepted: false,
        command,
        requestId: id,
        error: `RPC ${command} acknowledgement timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    timer.unref();
    this.#pending.set(id, { command, deferred: requestDeferred, timer });

    try {
      await this.#process.write(encoded);
    } catch (error) {
      clearTimeout(timer);
      this.#pending.delete(id);
      requestDeferred.resolve({
        accepted: false,
        command,
        requestId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return requestDeferred.promise;
  }

  #cancelAs(outcome: "cancelled" | "timed_out"): Promise<void> {
    if (!this.#requestedOutcome) this.#requestedOutcome = outcome;
    if (this.#cancelPromise) return this.#cancelPromise;

    this.#cancelPromise = (async () => {
      if (!this.#process.hasExited && !this.#terminal) {
        try {
          await this.#request("abort", {}, Math.min(this.#requestTimeoutMs, 500));
        } catch {
          // Process-group termination below is the authoritative fallback.
        }
      }
      this.#process.closeStdin();
      const exited = await this.#process.waitForExit(this.#cancelGraceMs);
      if (!exited) {
        await this.#process.cancel({ signal: "SIGTERM", graceMs: this.#cancelGraceMs });
      }
    })();
    return this.#cancelPromise;
  }

  async #ensureExitAfterTerminal(): Promise<void> {
    const exited = await this.#process.waitForExit(this.#terminalExitGraceMs);
    if (!exited) {
      await this.#process.cancel({ signal: "SIGTERM", graceMs: this.#cancelGraceMs });
    }
  }

  #captureSession(event: AgentEventDraft): void {
    const value = event.data?.session_id ?? event.data?.thread_id;
    if (typeof value === "string") {
      this.#sessionId = value;
      return;
    }
    const nested = asRecord(event.data?.data);
    const nestedValue = nested.sessionId ?? nested.session_id;
    if (typeof nestedValue === "string") this.#sessionId = nestedValue;
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
    if (this.#protocolError || this.#settled) return;
    this.#protocolError = error instanceof Error ? error.message : String(error);
    this.#emit({
      kind: "error",
      nativeType: "protocol.rpc",
      message: this.#protocolError,
    });
    this.#process.closeStdin();
    void this.#process.cancel({ signal: "SIGTERM", graceMs: 250 });
  }

  async #finish(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.#settled) return;
    this.#settled = true;
    if (this.#readiness === "ready-frame") {
      this.#ready.reject(new Error("RPC process exited before readiness"));
    }
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.deferred.resolve({
        accepted: false,
        command: pending.command,
        requestId: id,
        error: "RPC process exited before acknowledging the command",
      });
    }
    this.#pending.clear();

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
      return stderr || `RPC process exited without a terminal event (code=${String(code)}, signal=${String(signal)})`;
    }
    return `RPC process exited after completion with code ${String(code)}`;
  }

  #emit(draft: AgentEventDraft): void {
    this.#eventSequence += 1;
    this.#events.push({
      version: 1,
      driver: this.#driver,
      jobId: this.#input.jobId,
      attemptId: this.#input.attemptId,
      sequence: this.#eventSequence,
      timestamp: new Date().toISOString(),
      ...draft,
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return typeof record.message === "string"
    ? record.message
    : typeof record.error === "string"
      ? record.error
      : undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref();
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
