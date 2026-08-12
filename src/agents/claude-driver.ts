import { spawnOneShotJsonlRun } from "./cli-jsonl-run.js";
import type { CliDriverOptions } from "./driver-options.js";
import { mergeRunEnvironment } from "./driver-options.js";
import { mapClaudeEvent } from "./native-mappers.js";
import type {
  AgentCapabilities,
  AgentDriver,
  AgentRun,
  AgentRunInput,
} from "./types.js";

export const CLAUDE_CODE_CAPABILITIES: AgentCapabilities = Object.freeze({
  transport: "one-shot",
  steer: false,
  followUp: false,
  nativeCancel: false,
  sessionResume: false,
  sandbox: "external-isolation-required",
  completionSignal: "result",
  notes: Object.freeze([
    "Uses `claude -p --output-format stream-json`, not the Agent SDK.",
    "This first driver does not use stream-json input and therefore does not advertise steer.",
    "Claude Code is not an OS sandbox; the worker/workspace boundary must isolate it.",
  ]),
});

export class ClaudeCodeDriver implements AgentDriver {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CODE_CAPABILITIES;
  readonly #options: CliDriverOptions;

  constructor(options: CliDriverOptions = {}) {
    this.#options = options;
  }

  run(input: AgentRunInput): Promise<AgentRun> {
    const args = [
      "-p",
      input.prompt,
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      ...(this.#options.extraArgs ?? []),
    ];

    return spawnOneShotJsonlRun({
      driver: this.id,
      input,
      mapper: mapClaudeEvent,
      command: this.#options.command ?? "claude",
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
      homePrefix: "mob-claude-",
    });
  }
}
