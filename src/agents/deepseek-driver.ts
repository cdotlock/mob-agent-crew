import { join } from "node:path";
import { spawnOneShotTextRun } from "./cli-text-run.js";
import type { CliDriverOptions } from "./driver-options.js";
import { mergeRunEnvironment } from "./driver-options.js";
import type {
  AgentCapabilities,
  AgentDriver,
  AgentRun,
  AgentRunInput,
} from "./types.js";

export const DEEPSEEK_HARNESS_PATCH_FILENAME = "dsh.cordis.patch.yml";

export const DEEPSEEK_HARNESS_CAPABILITIES: AgentCapabilities = Object.freeze({
  transport: "one-shot",
  steer: false,
  followUp: false,
  nativeCancel: false,
  sessionResume: false,
  sandbox: "workspace-write",
  completionSignal: "stdout final message + process exit",
  notes: Object.freeze([
    "Uses the documented `dsh --profile headless <task>` positional interface.",
    "The developer-preview headless CLI exposes final stdout and exit status, not JSONL or tool events.",
    "Cancellation is an OS process-group signal; DeepSeek Harness remains a peer connector with no planner privilege.",
  ]),
});

export class DeepSeekHarnessDriver implements AgentDriver {
  readonly id = "deepseek" as const;
  readonly capabilities = DEEPSEEK_HARNESS_CAPABILITIES;
  readonly #options: CliDriverOptions;

  constructor(options: CliDriverOptions = {}) {
    this.#options = options;
  }

  run(input: AgentRunInput): Promise<AgentRun> {
    const merged = mergeRunEnvironment(this.#options.env, input.env);
    const routerBaseUrl = merged.MOB_AI_BASE_URL?.replace(/\/+$/u, "");
    const env = {
      ...merged,
      ...(merged.DEEPSEEK_API_KEY === undefined && merged.MOB_AI_KEY !== undefined
        ? { DEEPSEEK_API_KEY: merged.MOB_AI_KEY }
        : {}),
      ...(merged.DEEPSEEK_BASE_URL === undefined && routerBaseUrl !== undefined
        ? {
            DEEPSEEK_BASE_URL: routerBaseUrl.endsWith("/v1")
              ? routerBaseUrl
              : `${routerBaseUrl}/v1`,
          }
        : {}),
    };
    const profileArgs = input.profileDirectory
      ? ["--patch", join(input.profileDirectory, DEEPSEEK_HARNESS_PATCH_FILENAME)]
      : [];

    return spawnOneShotTextRun({
      driver: this.id,
      input,
      command: this.#options.command ?? "dsh",
      args: [
        "--profile",
        "headless",
        ...profileArgs,
        ...(this.#options.extraArgs ?? []),
        input.prompt,
      ],
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
        ? { maxOutputBytes: this.#options.maxFrameBytes }
        : {}),
      closeStdinAfterSpawn: true,
      homePrefix: "mob-deepseek-",
    });
  }
}
