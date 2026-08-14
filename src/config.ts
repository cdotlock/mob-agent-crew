import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { z } from "zod";
import { isGitHubCliConfigured } from "./integrations/index.js";

const envFile = resolve(process.cwd(), ".env");
if (existsSync(envFile)) {
  loadEnvFile(envFile);
}

const booleanFromEnv = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1).default("postgres://mob:mob@localhost:5432/mob"),
  MOB_HOST: z.string().min(1).default("0.0.0.0"),
  MOB_PORT: z.coerce.number().int().min(1).max(65_535).default(4310),
  MOB_DATA_DIR: z.string().min(1).default("./data"),
  MOB_EMBEDDED_WORKER: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  MOB_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  MOB_ENABLE_MOCK_DRIVER: booleanFromEnv,
  MOB_SESSION_SECRET: z.string().min(32).default("development-only-secret-change-me-now"),
  MOB_PUBLIC_URL: z.string().url().optional(),
  MOB_ADMIN_EMAIL: z.string().email().optional(),
  MOB_ADMIN_PASSWORD: z.string().min(12).optional(),
  MOB_ADMIN_NAME: z.string().min(1).default("Workspace Admin"),
  MOB_BOOTSTRAP_REPOSITORY_URL: z.string().url().default("https://github.com/cdotlock/mob-agent-crew"),
  MOB_AI_KEY: z.string().startsWith("mob-").optional(),
  MOB_AI_KEY_FILE: z.string().min(1).optional(),
  MOB_AI_BASE_URL: z.string().url().default("https://ai.mob-ai.cn/api"),
  MOB_AI_MODEL: z.string().min(1).default("deepseek-v4-pro"),
  MOB_AI_CLAUDE_MODEL: z.string().min(1).default("claude-opus-4-6:free"),
  MOB_AI_CODEX_MODEL: z.string().min(1).default("gpt-5.6-sol"),
  MOB_AI_MODEL_CATALOG_JSON: z.string().min(2).optional(),
  MOB_AI_MODEL_CATALOG_URL: z.string().url().optional(),
  MOB_AI_MODEL_CATALOG_TTL_SECONDS: z.coerce.number().int().min(5).max(86_400).default(300),
  MOB_RELEASE_REVISION: z.string().min(1).max(128).optional(),
  RAILWAY_GIT_COMMIT_SHA: z.string().min(1).max(128).optional(),
  RAILWAY_DEPLOYMENT_ID: z.string().min(1).max(128).optional(),
});

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  databaseUrl: string;
  host: string;
  port: number;
  dataDir: string;
  embeddedWorker: boolean;
  workerConcurrency: number;
  enableMockDriver: boolean;
  sessionSecret: string;
  publicUrl?: string;
  adminEmail?: string;
  adminPassword?: string;
  adminName: string;
  bootstrapRepositoryUrl: string;
  mobAiKey?: string;
  mobAiBaseUrl: string;
  mobAiModel: string;
  mobAiClaudeModel?: string;
  mobAiCodexModel?: string;
  mobAiModelCatalogJson?: string;
  mobAiModelCatalogUrl?: string;
  mobAiModelCatalogTtlMs?: number;
  githubCliConfigured?: boolean;
  releaseRevision?: string;
  deploymentId?: string;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const mobAiKey = parsed.MOB_AI_KEY ?? readOptionalSecretFile(parsed.MOB_AI_KEY_FILE);
  const releaseRevision = parsed.MOB_RELEASE_REVISION ?? parsed.RAILWAY_GIT_COMMIT_SHA;

  if (
    parsed.NODE_ENV === "production" &&
    parsed.MOB_SESSION_SECRET === "development-only-secret-change-me-now"
  ) {
    throw new Error("MOB_SESSION_SECRET must be configured in production");
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    databaseUrl: parsed.DATABASE_URL,
    host: parsed.MOB_HOST,
    port: parsed.MOB_PORT,
    dataDir: resolve(parsed.MOB_DATA_DIR),
    embeddedWorker: parsed.MOB_EMBEDDED_WORKER,
    workerConcurrency: parsed.MOB_WORKER_CONCURRENCY,
    enableMockDriver: parsed.MOB_ENABLE_MOCK_DRIVER,
    sessionSecret: parsed.MOB_SESSION_SECRET,
    ...(parsed.MOB_PUBLIC_URL ? { publicUrl: parsed.MOB_PUBLIC_URL } : {}),
    ...(parsed.MOB_ADMIN_EMAIL ? { adminEmail: parsed.MOB_ADMIN_EMAIL } : {}),
    ...(parsed.MOB_ADMIN_PASSWORD ? { adminPassword: parsed.MOB_ADMIN_PASSWORD } : {}),
    adminName: parsed.MOB_ADMIN_NAME,
    bootstrapRepositoryUrl: parsed.MOB_BOOTSTRAP_REPOSITORY_URL,
    ...(mobAiKey ? { mobAiKey } : {}),
    mobAiBaseUrl: parsed.MOB_AI_BASE_URL,
    mobAiModel: parsed.MOB_AI_MODEL,
    mobAiClaudeModel: parsed.MOB_AI_CLAUDE_MODEL,
    mobAiCodexModel: parsed.MOB_AI_CODEX_MODEL,
    ...(parsed.MOB_AI_MODEL_CATALOG_JSON
      ? { mobAiModelCatalogJson: parsed.MOB_AI_MODEL_CATALOG_JSON }
      : {}),
    mobAiModelCatalogUrl: parsed.MOB_AI_MODEL_CATALOG_URL
      ?? `${parsed.MOB_AI_BASE_URL.replace(/\/+$/u, "")}/v1/models`,
    mobAiModelCatalogTtlMs: parsed.MOB_AI_MODEL_CATALOG_TTL_SECONDS * 1_000,
    githubCliConfigured: isGitHubCliConfigured(environment),
    ...(releaseRevision ? { releaseRevision } : {}),
    ...(parsed.RAILWAY_DEPLOYMENT_ID ? { deploymentId: parsed.RAILWAY_DEPLOYMENT_ID } : {}),
  };
}

function readOptionalSecretFile(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const value = readFileSync(path, "utf8").trim();
  return value || undefined;
}
