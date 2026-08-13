import { AsyncQueue, deferred, type Deferred } from "./async-queue.js";
import { encodeJsonl, JsonlDecoder } from "./jsonl.js";
import { mapHermesEvent } from "./native-mappers.js";
import {
  spawnSupervisedProcess,
  type SpawnSupervisedProcessOptions,
  type SupervisedProcess,
} from "./process-supervisor.js";
import type {
  AgentCapabilities,
  AgentCommand,
  AgentCommandAck,
  AgentEvent,
  AgentEventDraft,
  AgentRun,
  AgentRunInput,
  AgentRunOutcome,
  AgentRunResult,
  NativeTerminal,
} from "./types.js";
import { UnsupportedAgentCapabilityError } from "./types.js";

type HermesCommand = AgentCommand["type"] | "prompt" | "abort";

interface PendingRequest {
  readonly method: string;
  readonly deferred: Deferred<Readonly<Record<string, unknown>>>;
  readonly timer: NodeJS.Timeout;
}

export interface SpawnHermesJsonRpcRunOptions
  extends Omit<SpawnSupervisedProcessOptions, "cwd" | "timeoutMs" | "onTimeout"> {
  readonly input: AgentRunInput;
  readonly capabilities: AgentCapabilities;
  readonly requestTimeoutMs?: number;
  readonly cancelGraceMs?: number;
  readonly terminalExitGraceMs?: number;
  readonly maxFrameBytes?: number;
}

export async function spawnHermesJsonRpcRun(
  options: SpawnHermesJsonRpcRunOptions,
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
  return new HermesJsonRpcRun({ ...options, process });
}

interface HermesJsonRpcRunOptions extends SpawnHermesJsonRpcRunOptions {
  readonly process: SupervisedProcess;
}

/**
 * A deliberately small host for Hermes' documented TUI-gateway JSON-RPC
 * protocol. It owns one gateway process and one live session per Mob run.
 */
export class HermesJsonRpcRun implements AgentRun {
  readonly #input: AgentRunInput;
  readonly #capabilities: AgentCapabilities;
  readonly #process: SupervisedProcess;
  readonly #requestTimeoutMs: number;
  readonly #cancelGraceMs: number;
  readonly #terminalExitGraceMs: number;
  readonly #maxFrameBytes: number;
  readonly #decoder: JsonlDecoder;
  readonly #events = new AsyncQueue<AgentEvent>();
  readonly #result = deferred<AgentRunResult>();
  readonly #gatewayReady = deferred<void>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #stderr: string[] = [];
  #requestSequence = 0;
  #eventSequence = 0;
  #sessionId: string | undefined;
  #storedSessionId: string | undefined;
  #terminal: NativeTerminal | undefined;
  #lastMessage: string | undefined;
  #protocolError: string | undefined;
  #requestedOutcome: "cancelled" | "timed_out" | undefined;
  #cancelPromise: Promise<void> | undefined;
  #settled = false;

  constructor(options: HermesJsonRpcRunOptions) {
    this.#input = options.input;
    this.#capabilities = options.capabilities;
    this.#process = options.process;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.#cancelGraceMs = options.cancelGraceMs ?? 1_000;
    this.#terminalExitGraceMs = options.terminalExitGraceMs ?? 2_000;
    this.#maxFrameBytes = options.maxFrameBytes ?? 4 * 1024 * 1024;
    this.#decoder = new JsonlDecoder({ maxFrameBytes: this.#maxFrameBytes });
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
      throw new UnsupportedAgentCapabilityError("hermes", "steer");
    }
    if (command.type === "follow_up" && !this.#capabilities.followUp) {
      throw new UnsupportedAgentCapabilityError("hermes", "followUp");
    }
    if (!this.#sessionId || this.#terminal || this.#settled || this.#requestedOutcome) {
      return {
        accepted: false,
        command: command.type,
        error: "Hermes run is not accepting commands",
      };
    }

    // Follow-up is intentionally not advertised until Mob can keep the run
    // open across multiple message.complete events.
    return this.#requestCommand(
      "session.steer",
      { session_id: this.#sessionId, text: command.message },
      command.type,
      (result) => result.status !== "rejected",
    );
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
      await withTimeout(
        this.#gatewayReady.promise,
        this.#requestTimeoutMs,
        "Hermes gateway.ready",
      );
      if (this.#requestedOutcome || this.#settled) return;

      const created = await this.#request("session.create", {
        cwd: this.#input.cwd,
        source: "tool",
        close_on_disconnect: true,
      });
      this.#sessionId = stringValue(created.session_id);
      this.#storedSessionId = stringValue(created.stored_session_id);
      if (!this.#sessionId) {
        throw new Error("Hermes session.create did not return session_id");
      }

      const info = asRecord(created.info);
      this.#emit({
        kind: "runtime.ready",
        nativeType: "session.create.result",
        data: {
          session_id: this.#sessionId,
          ...(this.#storedSessionId
            ? { stored_session_id: this.#storedSessionId }
            : {}),
          ...pick(info, [
            "model",
            "provider",
            "tools",
            "skills",
            "cwd",
            "branch",
            "project",
          ]),
        },
      });

      if (this.#requestedOutcome || this.#settled) return;
      const promptAck = await this.#requestCommand(
        "prompt.submit",
        { session_id: this.#sessionId, text: this.#input.prompt },
        "prompt",
        (result) => result.status === "streaming" || result.status === "queued",
      );
      if (!promptAck.accepted) {
        throw new Error(promptAck.error ?? "Hermes rejected the initial prompt");
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
    if (record.jsonrpc !== "2.0") {
      this.#failProtocol(new Error("Hermes emitted a non-JSON-RPC 2.0 frame"));
      return;
    }

    const id = record.id;
    if ((typeof id === "string" || typeof id === "number") &&
      (record.result !== undefined || record.error !== undefined)) {
      this.#handleResponse(String(id), record);
      return;
    }
    if (record.method !== "event") return;

    const params = asRecord(record.params);
    const type = stringValue(params.type) ?? "unknown";
    if (type === "gateway.ready") {
      this.#gatewayReady.resolve();
      return;
    }

    const eventSessionId = stringValue(params.session_id);
    if (this.#sessionId && eventSessionId && eventSessionId !== this.#sessionId) {
      return;
    }
    if (INTERACTIVE_EVENT_TYPES.has(type)) {
      this.#failProtocol(
        new Error(`Hermes requested unsupported interactive input (${type})`),
      );
      return;
    }

    const mapping = mapHermesEvent(record);
    for (const draft of mapping.events) {
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
        ...(this.#storedSessionId
          ? { sessionId: this.#storedSessionId }
          : this.#sessionId
            ? { sessionId: this.#sessionId }
            : {}),
      };
      this.#process.closeStdin();
      void this.#ensureExitAfterTerminal();
    }
  }

  #handleResponse(
    id: string,
    frame: Readonly<Record<string, unknown>>,
  ): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    if (frame.error !== undefined) {
      pending.deferred.reject(
        new Error(errorText(frame.error) ?? `${pending.method} was rejected`),
      );
      return;
    }
    pending.deferred.resolve(asRecord(frame.result));
  }

  async #requestCommand(
    method: string,
    params: Readonly<Record<string, unknown>>,
    command: HermesCommand,
    accepts: (result: Readonly<Record<string, unknown>>) => boolean = () => true,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<AgentCommandAck> {
    try {
      const result = await this.#request(method, params, timeoutMs);
      const accepted = accepts(result);
      const error = accepted ? undefined : `${method} returned status '${String(result.status)}'`;
      this.#emit({
        kind: accepted ? "command.accepted" : "command.rejected",
        nativeType: `${method}.result`,
        ...(error ? { message: error } : {}),
        data: pick(result, ["status"]),
      });
      return { accepted, command, ...(error ? { error } : {}) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#emit({
        kind: "command.rejected",
        nativeType: `${method}.error`,
        message,
      });
      return { accepted: false, command, error: message };
    }
  }

  async #request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (this.#settled || this.#process.hasExited) {
      throw new Error("Hermes gateway process has exited");
    }
    this.#requestSequence += 1;
    const id = `${this.#input.attemptId}:${this.#requestSequence}`;
    const encoded = encodeJsonl({ jsonrpc: "2.0", id, method, params });
    if (Buffer.byteLength(encoded, "utf8") > this.#maxFrameBytes) {
      throw new Error(`Hermes JSON-RPC frame exceeds ${this.#maxFrameBytes} bytes`);
    }

    const request = deferred<Readonly<Record<string, unknown>>>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      request.reject(
        new Error(`${method} response timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    timer.unref();
    this.#pending.set(id, { method, deferred: request, timer });

    try {
      await this.#process.write(encoded);
    } catch (error) {
      clearTimeout(timer);
      this.#pending.delete(id);
      request.reject(error);
    }
    return request.promise;
  }

  #cancelAs(outcome: "cancelled" | "timed_out"): Promise<void> {
    if (!this.#requestedOutcome) this.#requestedOutcome = outcome;
    if (this.#cancelPromise) return this.#cancelPromise;

    this.#cancelPromise = (async () => {
      if (!this.#process.hasExited && this.#sessionId && !this.#terminal) {
        await this.#requestCommand(
          "session.interrupt",
          { session_id: this.#sessionId },
          "abort",
          () => true,
          Math.min(this.#requestTimeoutMs, 500),
        );
      }
      this.#process.closeStdin();
      const exited = await this.#process.waitForExit(this.#cancelGraceMs);
      if (!exited) {
        await this.#process.cancel({
          signal: "SIGTERM",
          graceMs: this.#cancelGraceMs,
        });
      }
    })();
    return this.#cancelPromise;
  }

  async #ensureExitAfterTerminal(): Promise<void> {
    const exited = await this.#process.waitForExit(this.#terminalExitGraceMs);
    if (!exited) {
      await this.#process.cancel({
        signal: "SIGTERM",
        graceMs: this.#cancelGraceMs,
      });
    }
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
      nativeType: "protocol.hermes-jsonrpc",
      message: this.#protocolError,
    });
    this.#process.closeStdin();
    void this.#process.cancel({ signal: "SIGTERM", graceMs: 250 });
  }

  async #finish(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.#settled) return;
    this.#settled = true;
    this.#gatewayReady.reject(
      new Error("Hermes gateway exited before gateway.ready"),
    );
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.deferred.reject(
        new Error(`Hermes gateway exited before ${pending.method} responded`),
      );
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
        : this.#storedSessionId
          ? { sessionId: this.#storedSessionId }
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
    const stderr = truncate(this.#stderr.join("").trim(), 8_192);
    return stderr ||
      `Hermes exited without a terminal event (code=${String(code)}, signal=${String(signal)})`;
  }

  #emit(draft: AgentEventDraft): void {
    this.#eventSequence += 1;
    this.#events.push({
      version: 1,
      driver: "hermes",
      jobId: this.#input.jobId,
      attemptId: this.#input.attemptId,
      sequence: this.#eventSequence,
      timestamp: new Date().toISOString(),
      ...draft,
    });
  }
}

const INTERACTIVE_EVENT_TYPES = new Set([
  "approval.request",
  "clarify.request",
  "sudo.request",
  "secret.request",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return stringValue(record.message) ?? stringValue(record.error);
}

function pick(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const key of keys) {
    if (record[key] !== undefined) selected[key] = record[key];
  }
  return selected;
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
