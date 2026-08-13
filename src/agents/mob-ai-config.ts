import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface MobAiProviderConfig {
  directory: string;
  baseUrl: string;
  model: string;
  claudeModel?: string | undefined;
  codexModel?: string | undefined;
}

export async function writeMobAiProviderConfig(input: MobAiProviderConfig): Promise<void> {
  const directory = resolve(input.directory);
  const parent = dirname(directory);
  await mkdir(parent, { recursive: true, mode: 0o711 });
  const parentInformation = await lstat(parent);
  if (!parentInformation.isDirectory() || parentInformation.isSymbolicLink()) {
    throw new Error("Agent profile parent must be a real directory");
  }
  try {
    await mkdir(directory, { mode: 0o755 });
  } catch (error) {
    if (!isExistingFileError(error)) throw error;
  }
  const directoryInformation = await lstat(directory);
  if (!directoryInformation.isDirectory() || directoryInformation.isSymbolicLink()) {
    throw new Error("Agent profile must be a real directory, not a symbolic link");
  }
  // Existing Railway volumes may still contain the former 0700 directory.
  // These files are secret-free and must be readable by the isolated CLI uid.
  await chmod(directory, 0o755);
  const baseUrl = `${input.baseUrl.replace(/\/$/u, "")}/v1`;

  const piConfig = {
    providers: {
      "mob-ai": {
        baseUrl,
        api: "openai-completions",
        apiKey: "$MOB_AI_KEY",
        authHeader: true,
        headers: {
          "User-Agent": "mob-agent-crew/0.1",
        },
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: "max_tokens",
        },
        models: [
          {
            id: input.model,
            name: "DeepSeek V4 Pro via MobAI",
            reasoning: true,
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 16384,
          },
        ],
      },
    },
  };
  await writeReadableProviderFile(join(directory, "models.json"), `${JSON.stringify(piConfig, null, 2)}\n`);

  const ompConfig = `providers:
  mob-ai:
    baseUrl: ${baseUrl}
    api: openai-completions
    apiKey: MOB_AI_KEY
    authHeader: true
    models:
      - id: ${input.model}
        name: DeepSeek V4 Pro via MobAI
        reasoning: true
        contextWindow: 128000
        maxTokens: 16384
`;
  await writeReadableProviderFile(join(directory, "models.yml"), ompConfig);

  // Hermes resolves the secret named by key_env at runtime. The API key is
  // deliberately never persisted in config.yaml.
  const yamlString = (value: string): string => JSON.stringify(value);
  const hermesConfig = `_config_version: 33
model:
  provider: mob-ai
  default: ${yamlString(input.model)}
providers:
  mob-ai:
    api: ${yamlString(baseUrl)}
    key_env: MOB_AI_KEY
    transport: chat_completions
    default_model: ${yamlString(input.model)}
    discover_models: false
    extra_headers:
      User-Agent: mob-agent-crew/0.1
    models:
      - ${yamlString(input.model)}
`;
  await writeReadableProviderFile(join(directory, "config.yaml"), hermesConfig);

  // Codex supports custom Responses API providers. Keep the secret out of the
  // file and resolve it through MOB_AI_KEY at process start.
  const codexConfig = `model = ${yamlString(input.codexModel ?? "gpt-5.6-sol")}
model_provider = "mob_ai"

[model_providers.mob_ai]
name = "MobAI Router"
base_url = ${yamlString(baseUrl)}
env_key = "MOB_AI_KEY"
wire_api = "responses"
requires_openai_auth = false
`;
  await writeReadableProviderFile(join(directory, "config.toml"), codexConfig);

  // dsh headless has no model flag. Its documented --patch layer is the
  // secret-free way to select Mob's configured model for each fresh session.
  const deepSeekHarnessPatch = `- id: agent-default-model
  config:
    provider: deepseek-official
    model: ${yamlString(input.model)}
- insert:
    - id: mob-agent-crew
      name: mob-agent-crew-dsh-plugin
      config:
        executable: mob
        timeoutMs: 30000
        maxOutputBytes: 1048576
        fileApiBaseUrl: ''
        fileApiTokenEnv: MOB_DSH_TOKEN
        allowInsecureFileApi: false
`;
  await writeReadableProviderFile(
    join(directory, "dsh.cordis.patch.yml"),
    deepSeekHarnessPatch,
  );
}

async function writeReadableProviderFile(path: string, contents: string): Promise<void> {
  // Atomic replacement avoids following a provider-file symlink persisted by
  // an older, less isolated Agent runtime.
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o644);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function isExistingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}
