import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { z } from "zod";

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
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);

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
  };
}
