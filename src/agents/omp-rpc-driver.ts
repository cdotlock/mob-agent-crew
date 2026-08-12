import type { CliDriverOptions } from "./driver-options.js";
import { mergeRunEnvironment } from "./driver-options.js";
import { mapOmpEvent } from "./native-mappers.js";
import { spawnRpcJsonlRun } from "./rpc-jsonl-run.js";
import type {
  AgentCapabilities,
  AgentDriver,
  AgentRun,
  AgentRunInput,
} from "./types.js";

export const OMP_RPC_CAPABILITIES: AgentCapabilities = Object.freeze({
  transport: "duplex-jsonl",
  steer: true,
  followUp: true,
  nativeCancel: true,
  sessionResume: false,
  sandbox: "external-isolation-required",
  completionSignal: "agent_end where isTerminal !== false",
  notes: Object.freeze([
    "Uses OMP RPC v1 prompt/steer/follow_up/abort over strict LF JSONL.",
    "A command response is only an acknowledgement; terminal agent_end completes the run.",
    "Protocol-v2 rpc_chunk negotiation/reassembly is not advertised by this first driver.",
  ]),
});

export class OmpRpcDriver implements AgentDriver {
  readonly id = "omp" as const;
  readonly capabilities = OMP_RPC_CAPABILITIES;
  readonly #options: CliDriverOptions;

  constructor(options: CliDriverOptions = {}) {
    this.#options = options;
  }

  run(input: AgentRunInput): Promise<AgentRun> {
    const args = ["--mode", "rpc", ...(this.#options.extraArgs ?? [])];
    return spawnRpcJsonlRun({
      driver: this.id,
      capabilities: this.capabilities,
      input,
      mapper: mapOmpEvent,
      readiness: "ready-frame",
      command: this.#options.command ?? "omp",
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
      homePrefix: "mob-omp-",
    });
  }
}
