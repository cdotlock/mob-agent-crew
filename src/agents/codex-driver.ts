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
  sandbox: "external-isolation-required",
  completionSignal: "turn.completed | turn.failed",
  notes: Object.freeze([
    "Uses `codex exec --json`; it is not the Codex app-server protocol.",
    "Codex's Linux bubblewrap sandbox is disabled because Railway blocks user namespaces; Mob's dedicated UID, disposable HOME, task permissions, and credential proxy remain the isolation boundary.",
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
    const merged = mergeRunEnvironment(this.#options.env, input.env);
    const routerBaseUrl = merged.MOB_AI_BASE_URL?.replace(/\/$/u, "");
    const routerModel = merged.MOB_AI_CODEX_MODEL ?? "gpt-5.6-sol";
    const providerArgs = merged.MOB_AI_KEY && routerBaseUrl
      ? [
          "-c", 'model_provider="mob_ai"',
          "-c", 'model_providers.mob_ai.name="MobAI Router"',
          "-c", `model_providers.mob_ai.base_url=${JSON.stringify(`${routerBaseUrl}/v1`)}`,
          "-c", 'model_providers.mob_ai.env_key="MOB_AI_KEY"',
          "-c", 'model_providers.mob_ai.wire_api="responses"',
          "-c", "model_providers.mob_ai.requires_openai_auth=false",
          "-m", routerModel,
        ]
      : [];
    const args = [
      ...providerArgs,
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "danger-full-access",
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
      env: merged,
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
      // Codex treats any non-TTY stdin as optional prompt context and blocks
      // on read_to_end even though the prompt is already positional.
      closeStdinAfterSpawn: true,
      homePrefix: "mob-codex-",
    });
  }
}
