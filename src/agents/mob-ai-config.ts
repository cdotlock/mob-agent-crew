import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface MobAiProviderConfig {
  directory: string;
  baseUrl: string;
  model: string;
}

export async function writeMobAiProviderConfig(input: MobAiProviderConfig): Promise<void> {
  await mkdir(input.directory, { recursive: true, mode: 0o700 });

  const piConfig = {
    providers: {
      "mob-ai": {
        baseUrl: `${input.baseUrl.replace(/\/$/u, "")}/v1`,
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
  await writeFile(join(input.directory, "models.json"), `${JSON.stringify(piConfig, null, 2)}\n`, { mode: 0o600 });

  const ompConfig = `providers:
  mob-ai:
    baseUrl: ${input.baseUrl.replace(/\/$/u, "")}/v1
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
  await writeFile(join(input.directory, "models.yml"), ompConfig, { mode: 0o600 });
}
