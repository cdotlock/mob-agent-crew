import { AsyncQueue, deferred } from "./async-queue.js";
import type {
  AgentCapabilities,
  AgentCommand,
  AgentCommandAck,
  AgentDriver,
  AgentEvent,
  AgentEventDraft,
  AgentRun,
  AgentRunInput,
  AgentRunResult,
} from "./types.js";
import { UnsupportedAgentCapabilityError } from "./types.js";

export interface MockDelegateContext {
  readonly signal: AbortSignal;
  emit(event: AgentEventDraft): void;
}

export interface MockDelegateOutput {
  readonly finalMessage?: string;
  readonly events?: readonly AgentEventDraft[];
  readonly data?: Readonly<Record<string, unknown>>;
}

export type MockAgentDelegate = (
  input: AgentRunInput,
  context: MockDelegateContext,
) => MockDelegateOutput | Promise<MockDelegateOutput>;

export interface MockDriverOptions {
  readonly delegate?: MockAgentDelegate;
  readonly defaultMessage?: string;
}

export const MOCK_DRIVER_CAPABILITIES: AgentCapabilities = Object.freeze({
  transport: "in-process",
  steer: false,
  followUp: false,
  nativeCancel: true,
  sessionResume: false,
  sandbox: "mock",
  completionSignal: "delegate promise settlement",
  notes: Object.freeze([
    "The mock delegates in-process and is intended for deterministic worker tests.",
    "Cancellation aborts the delegate signal; steer/follow-up are not simulated.",
  ]),
});

export class MockDriver implements AgentDriver {
  readonly id = "mock" as const;
  readonly capabilities = MOCK_DRIVER_CAPABILITIES;
  readonly #delegate: MockAgentDelegate;

  constructor(options: MockDriverOptions = {}) {
    this.#delegate =
      options.delegate ??
      ((input) => ({
        finalMessage: options.defaultMessage ?? `Mock completed: ${input.prompt}`,
      }));
  }

  run(input: AgentRunInput): Promise<AgentRun> {
    return Promise.resolve(new MockAgentRun(input, this.#delegate));
  }
}

class MockAgentRun implements AgentRun {
  readonly #input: AgentRunInput;
  readonly #delegate: MockAgentDelegate;
  readonly #events = new AsyncQueue<AgentEvent>();
  readonly #result = deferred<AgentRunResult>();
  readonly #abortController = new AbortController();
  #sequence = 0;
  #settled = false;
  #timedOut = false;
  #timeout: NodeJS.Timeout | undefined;

  constructor(input: AgentRunInput, delegate: MockAgentDelegate) {
    this.#input = input;
    this.#delegate = delegate;
    this.events = this.#events;
    this.result = this.#result.promise;
    this.#emit({ kind: "runtime.started", nativeType: "mock.started" });
    this.#emit({ kind: "runtime.ready", nativeType: "mock.ready" });

    if (input.timeoutMs !== undefined && input.timeoutMs > 0) {
      this.#timeout = setTimeout(() => {
        this.#timedOut = true;
        void this.#cancelInternal();
      }, input.timeoutMs);
      this.#timeout.unref();
    }
    queueMicrotask(() => {
      void this.#execute();
    });
  }

  readonly events: AsyncIterable<AgentEvent>;
  readonly result: Promise<AgentRunResult>;

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return this.#events[Symbol.asyncIterator]();
  }

  send(command: AgentCommand): Promise<AgentCommandAck> {
    const capability = command.type === "steer" ? "steer" : "followUp";
    return Promise.reject(
      new UnsupportedAgentCapabilityError("mock", capability),
    );
  }

  cancel(): Promise<void> {
    return this.#cancelInternal();
  }

  forceKill(): Promise<void> {
    return this.#cancelInternal();
  }

  async #execute(): Promise<void> {
    if (this.#settled) return;
    this.#emit({ kind: "turn.started", nativeType: "mock.delegate.started" });
    try {
      const output = await this.#delegate(this.#input, {
        signal: this.#abortController.signal,
        emit: (event) => this.#emit(event),
      });
      if (this.#settled) return;
      for (const event of output.events ?? []) this.#emit(event);
      if (output.finalMessage) {
        this.#emit({
          kind: "message.completed",
          nativeType: "mock.delegate.output",
          message: output.finalMessage,
        });
      }
      this.#emit({
        kind: "turn.completed",
        nativeType: "mock.delegate.completed",
        ...(output.finalMessage ? { message: output.finalMessage } : {}),
        ...(output.data ? { data: output.data } : {}),
      });
      this.#settle({
        outcome: "completed",
        exitCode: 0,
        signal: null,
        terminalObserved: true,
        ...(output.finalMessage ? { finalMessage: output.finalMessage } : {}),
      });
    } catch (error) {
      if (this.#settled) return;
      const message = error instanceof Error ? error.message : String(error);
      this.#emit({
        kind: "turn.failed",
        nativeType: "mock.delegate.failed",
        message,
      });
      this.#settle({
        outcome: "failed",
        exitCode: 1,
        signal: null,
        terminalObserved: true,
        error: message,
      });
    }
  }

  #cancelInternal(): Promise<void> {
    if (this.#settled) return Promise.resolve();
    this.#abortController.abort();
    this.#settle({
      outcome: this.#timedOut ? "timed_out" : "cancelled",
      exitCode: null,
      signal: null,
      terminalObserved: false,
    });
    return Promise.resolve();
  }

  #settle(result: AgentRunResult): void {
    if (this.#settled) return;
    this.#settled = true;
    if (this.#timeout) clearTimeout(this.#timeout);
    this.#events.end();
    this.#result.resolve(result);
  }

  #emit(draft: AgentEventDraft): void {
    if (this.#settled) return;
    this.#sequence += 1;
    this.#events.push({
      version: 1,
      driver: "mock",
      jobId: this.#input.jobId,
      attemptId: this.#input.attemptId,
      sequence: this.#sequence,
      timestamp: new Date().toISOString(),
      ...draft,
    });
  }
}
