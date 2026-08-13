import { AsyncQueue, deferred } from "./async-queue.js";
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
} from "./types.js";
import { UnsupportedAgentCapabilityError } from "./types.js";

export interface SpawnOneShotTextRunOptions
  extends Omit<SpawnSupervisedProcessOptions, "cwd" | "timeoutMs" | "onTimeout"> {
  readonly driver: AgentDriverId;
  readonly input: AgentRunInput;
  readonly cancelGraceMs?: number;
  readonly maxOutputBytes?: number;
  /** Close stdin once listeners are attached; the task is already positional. */
  readonly closeStdinAfterSpawn?: boolean;
}

export async function spawnOneShotTextRun(
  options: SpawnOneShotTextRunOptions,
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
  const run = new OneShotTextRun({
    driver: options.driver,
    input: options.input,
    process,
    ...(options.cancelGraceMs !== undefined
      ? { cancelGraceMs: options.cancelGraceMs }
      : {}),
    ...(options.maxOutputBytes !== undefined
      ? { maxOutputBytes: options.maxOutputBytes }
      : {}),
  });
  if (options.closeStdinAfterSpawn) process.closeStdin();
  return run;
}

interface OneShotTextRunOptions {
  readonly driver: AgentDriverId;
  readonly input: AgentRunInput;
  readonly process: SupervisedProcess;
  readonly cancelGraceMs?: number;
  readonly maxOutputBytes?: number;
}

class OneShotTextRun implements AgentRun {
  readonly #driver: AgentDriverId;
  readonly #input: AgentRunInput;
  readonly #process: SupervisedProcess;
  readonly #events = new AsyncQueue<AgentEvent>();
  readonly #result = deferred<AgentRunResult>();
  readonly #cancelGraceMs: number;
  readonly #maxOutputBytes: number;
  readonly #stdout: Buffer[] = [];
  readonly #stderr: Buffer[] = [];
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #sequence = 0;
  #requestedOutcome: "cancelled" | "timed_out" | undefined;
  #outputError: string | undefined;
  #settled = false;

  constructor(options: OneShotTextRunOptions) {
    this.#driver = options.driver;
    this.#input = options.input;
    this.#process = options.process;
    this.#cancelGraceMs = options.cancelGraceMs ?? 2_000;
    this.#maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
    this.events = this.#events;
    this.result = this.#result.promise;

    this.#emit({
      kind: "runtime.started",
      nativeType: "process.spawned",
      data: { pid: this.#process.child.pid ?? null },
    });
    this.#emit({
      kind: "turn.started",
      nativeType: "process.task-positional",
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
      this.#captureOutput("stdout", chunk);
    });
    this.#process.child.stderr.on("data", (chunk: Buffer) => {
      this.#captureOutput("stderr", chunk);
      const message = truncate(chunk.toString("utf8").trim(), 8_192);
      if (message) {
        this.#emit({
          kind: "warning",
          nativeType: "process.stderr",
          message,
        });
      }
    });
    void this.#process.exit.then((exit) => this.#finish(exit.code, exit.signal));
  }

  #captureOutput(stream: "stdout" | "stderr", chunk: Buffer): void {
    if (this.#outputError) return;
    const currentBytes = stream === "stdout" ? this.#stdoutBytes : this.#stderrBytes;
    if (currentBytes + chunk.byteLength > this.#maxOutputBytes) {
      this.#outputError = `Agent ${stream} exceeded ${String(this.#maxOutputBytes)} bytes`;
      this.#emit({
        kind: "error",
        nativeType: `process.${stream}.limit`,
        message: this.#outputError,
      });
      void this.#process.cancel({ signal: "SIGTERM", graceMs: 250 });
      return;
    }
    if (stream === "stdout") {
      this.#stdout.push(Buffer.from(chunk));
      this.#stdoutBytes += chunk.byteLength;
    } else {
      this.#stderr.push(Buffer.from(chunk));
      this.#stderrBytes += chunk.byteLength;
    }
  }

  async #finish(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.#settled) return;
    this.#settled = true;

    const finalMessage = this.#outputError
      ? undefined
      : stripOneTrailingLineBreak(Buffer.concat(this.#stdout).toString("utf8"));
    const stderr = truncate(
      stripOneTrailingLineBreak(Buffer.concat(this.#stderr).toString("utf8")).trim(),
      8_192,
    );
    const outcome = this.#outcome(code);
    const error = outcome === "failed"
      ? this.#outputError ?? (stderr ||
        `Process exited without successful completion (code=${String(code)}, signal=${String(signal)})`)
      : undefined;

    if (!this.#requestedOutcome) {
      if (finalMessage) {
        this.#emit({
          kind: "message.completed",
          nativeType: "process.stdout.final",
          message: finalMessage,
        });
      }
      this.#emit(
        outcome === "completed"
          ? { kind: "turn.completed", nativeType: "process.exit.0" }
          : {
              kind: "turn.failed",
              nativeType: "process.exit.nonzero",
              ...(error ? { message: error } : {}),
            },
      );
    }

    this.#emit({
      kind: "process.exited",
      nativeType: "process.close",
      data: { code, signal },
    });

    const terminalObserved = !this.#requestedOutcome && !this.#outputError && code !== null;
    const result: AgentRunResult = {
      outcome,
      exitCode: code,
      signal,
      terminalObserved,
      ...(finalMessage ? { finalMessage } : {}),
      ...(error ? { error } : {}),
    };

    await this.#process.cleanup();
    this.#events.end();
    this.#result.resolve(result);
  }

  #outcome(code: number | null): AgentRunOutcome {
    if (this.#requestedOutcome) return this.#requestedOutcome;
    if (this.#outputError || code !== 0) return "failed";
    return "completed";
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

function stripOneTrailingLineBreak(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n") || value.endsWith("\r")) return value.slice(0, -1);
  return value;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}
