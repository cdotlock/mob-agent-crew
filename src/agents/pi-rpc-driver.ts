import type { CliDriverOptions } from "./driver-options.js";
import { mergeRunEnvironment } from "./driver-options.js";
import { mapPiEvent } from "./native-mappers.js";
import { spawnRpcJsonlRun } from "./rpc-jsonl-run.js";
import type {
  AgentCapabilities,
  AgentDriver,
  AgentRun,
  AgentRunInput,
} from "./types.js";

export const PI_RPC_CAPABILITIES: AgentCapabilities = Object.freeze({
  transport: "duplex-jsonl",
  steer: true,
  followUp: true,
  nativeCancel: true,
  sessionResume: false,
  sandbox: "external-isolation-required",
  completionSignal: "agent_settled",
  notes: Object.freeze([
    "Uses Pi RPC commands prompt/steer/follow_up/abort over strict LF JSONL.",
    "A command response is only an acknowledgement; `agent_settled` is terminal.",
    "`agent_end` is deliberately non-terminal because retry or compaction may follow.",
  ]),
});

export class PiRpcDriver implements AgentDriver {
  readonly id = "pi" as const;
  readonly capabilities = PI_RPC_CAPABILITIES;
  readonly #options: CliDriverOptions;

  constructor(options: CliDriverOptions = {}) {
    this.#options = options;
  }

  run(input: AgentRunInput): Promise<AgentRun> {
    const args = [
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      ...(this.#options.extraArgs ?? []),
    ];
    return spawnRpcJsonlRun({
      driver: this.id,
      capabilities: this.capabilities,
      input,
      mapper: mapPiEvent,
      readiness: "get-state",
      command: this.#options.command ?? "pi",
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
      ...(input.profileDirectory
        ? {
            profileSeed: {
              sourceDirectory: input.profileDirectory,
              files: ["models.json"],
              environmentVariables: ["PI_CODING_AGENT_DIR"],
            },
          }
        : {}),
      homePrefix: "mob-pi-",
    });
  }
}
