import type { CliDriverOptions } from "./driver-options.js";
import { mergeRunEnvironment } from "./driver-options.js";
import { spawnHermesJsonRpcRun } from "./hermes-jsonrpc-run.js";
import type {
  AgentCapabilities,
  AgentDriver,
  AgentRun,
  AgentRunInput,
} from "./types.js";

export const HERMES_CAPABILITIES: AgentCapabilities = Object.freeze({
  transport: "duplex-jsonl",
  steer: true,
  followUp: false,
  nativeCancel: true,
  sessionResume: false,
  sandbox: "external-isolation-required",
  completionSignal: "message.complete",
  notes: Object.freeze([
    "Uses Hermes' documented TUI-gateway JSON-RPC 2.0 protocol over stdio.",
    "Hermes is a peer CLI connector; it has no Mob planner or orchestrator privilege.",
    "Follow-up and resume remain disabled until Mob owns a multi-turn run lifecycle.",
  ]),
});

export class HermesDriver implements AgentDriver {
  readonly id = "hermes" as const;
  readonly capabilities = HERMES_CAPABILITIES;
  readonly #options: CliDriverOptions;

  constructor(options: CliDriverOptions = {}) {
    this.#options = options;
  }

  run(input: AgentRunInput): Promise<AgentRun> {
    const merged = mergeRunEnvironment(this.#options.env, input.env);
    const hermesHome = input.profileDirectory
      ? undefined
      : merged.HERMES_HOME ?? merged.PI_CODING_AGENT_DIR;
    const env = {
      ...merged,
      ...(hermesHome ? { HERMES_HOME: hermesHome } : {}),
      // Mob's task-scoped worktree and single-writer lease are the outer
      // approval boundary. Interactive approval frames cannot be answered by
      // today's worker, so headless runs explicitly use Hermes' documented
      // auto-approve mode; Hermes' hardline deny floor still applies.
      HERMES_YOLO_MODE: "1",
      PYTHONUNBUFFERED: "1",
    };

    return spawnHermesJsonRpcRun({
      input,
      capabilities: this.capabilities,
      command: this.#options.command ?? "hermes-python",
      args: ["-I", "-u", ...(this.#options.extraArgs ?? []), "-m", "tui_gateway.entry"],
      env,
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
              files: ["config.yaml"],
              environmentVariables: ["HERMES_HOME", "PI_CODING_AGENT_DIR"],
            },
          }
        : {}),
      homePrefix: "mob-hermes-",
    });
  }
}
