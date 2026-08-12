import { spawnOneShotJsonlRun } from "./cli-jsonl-run.js";
import type { CliDriverOptions } from "./driver-options.js";
import { mergeRunEnvironment } from "./driver-options.js";
import { mapCodexEvent } from "./native-mappers.js";
import type {
  AgentCapabilities,
  AgentDriver,
  AgentRun,
  AgentRunInput,
} from "./types.js";

export const CODEX_EXEC_CAPABILITIES: AgentCapabilities = Object.freeze({
  transport: "one-shot",
  steer: false,
  followUp: false,
  nativeCancel: false,
  sessionResume: false,
  sandbox: "workspace-write",
  completionSignal: "turn.completed | turn.failed",
  notes: Object.freeze([
    "Uses `codex exec --json`; it is not the Codex app-server protocol.",
    "Cancellation is an OS process-group signal, not a Codex protocol command.",
    "No steer/follow-up is advertised; resume would require a separate process.",
  ]),
});

export class CodexExecDriver implements AgentDriver {
  readonly id = "codex" as const;
  readonly capabilities = CODEX_EXEC_CAPABILITIES;
  readonly #options: CliDriverOptions;

  constructor(options: CliDriverOptions = {}) {
    this.#options = options;
  }

  run(input: AgentRunInput): Promise<AgentRun> {
    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "workspace-write",
      "--cd",
      input.cwd,
      ...(this.#options.extraArgs ?? []),
      input.prompt,
    ];

    return spawnOneShotJsonlRun({
      driver: this.id,
      input,
      mapper: mapCodexEvent,
      command: this.#options.command ?? "codex",
      args,
      env: mergeRunEnvironment(this.#options.env, input.env),
      ...(this.#options.envAllowlist
        ? { envAllowlist: this.#options.envAllowlist }
        : {}),
      ...(this.#options.killGraceMs !== undefined
        ? {
            killGraceMs: this.#options.killGraceMs,
            cancelGraceMs: this.#options.killGraceMs,
          }
        : {}),
      ...(this.#options.maxFrameBytes !== undefined
        ? { maxFrameBytes: this.#options.maxFrameBytes }
        : {}),
      homePrefix: "mob-codex-",
    });
  }
}
