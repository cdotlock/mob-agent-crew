import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { normalizeServerUrl } from "./url.js";

export type MobClientConfig = {
  server: string;
  token: string;
};

export type ClientConfigPathOptions = {
  configPath?: string;
  environment?: NodeJS.ProcessEnv;
  homeDir?: string;
  cwd?: string;
};

export function resolveClientConfigPath(options: ClientConfigPathOptions = {}): string {
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const explicitPath = options.configPath ?? environment.MOB_CONFIG_PATH;
  if (explicitPath !== undefined) {
    if (!explicitPath.trim()) throw new Error("Mob client configuration path must not be empty");
    return resolve(cwd, explicitPath);
  }

  const xdgConfigHome = environment.XDG_CONFIG_HOME;
  if (xdgConfigHome?.trim()) return resolve(cwd, xdgConfigHome, "mob", "config.json");
  return join(options.homeDir ?? homedir(), ".config", "mob", "config.json");
}

function parseClientConfig(value: unknown): MobClientConfig {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid Mob client configuration");
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.server !== "string" ||
    typeof candidate.token !== "string" ||
    !candidate.token ||
    candidate.token.trim() !== candidate.token ||
    /[\u0000-\u001f\u007f]/u.test(candidate.token)
  ) {
    throw new Error("Invalid Mob client configuration");
  }

  let server: string;
  try {
    server = normalizeServerUrl(candidate.server);
  } catch {
    throw new Error("Invalid Mob client configuration");
  }
  return { server, token: candidate.token };
}

export async function loadClientConfig(
  options: ClientConfigPathOptions = {},
): Promise<MobClientConfig | null> {
  const configPath = resolveClientConfigPath(options);
  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error(`Invalid Mob client configuration at ${configPath}`);
  }

  try {
    return parseClientConfig(value);
  } catch {
    throw new Error(`Invalid Mob client configuration at ${configPath}`);
  }
}

export async function saveClientConfig(
  config: MobClientConfig,
  options: ClientConfigPathOptions = {},
): Promise<MobClientConfig> {
  const normalized = parseClientConfig(config);
  const configPath = resolveClientConfigPath(options);
  const parentDirectory = dirname(configPath);
  await mkdir(parentDirectory, { recursive: true, mode: 0o700 });

  const temporaryPath = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, configPath);
    await chmod(configPath, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }

  return normalized;
}

export async function clearClientConfig(options: ClientConfigPathOptions = {}): Promise<boolean> {
  const configPath = resolveClientConfigPath(options);
  try {
    await unlink(configPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
