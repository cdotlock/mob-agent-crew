import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deferred, type Deferred } from "./async-queue.js";

export const DEFAULT_ENV_ALLOWLIST = [
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "COLORTERM",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const;

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface SpawnSupervisedProcessOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly envAllowlist?: readonly string[];
  readonly timeoutMs?: number;
  readonly timeoutGraceMs?: number;
  readonly killGraceMs?: number;
  readonly homePrefix?: string;
  readonly onTimeout?: (process: SupervisedProcess) => void | Promise<void>;
}

export interface CancelProcessOptions {
  readonly signal?: NodeJS.Signals;
  readonly graceMs?: number;
}

export async function createIsolatedProcessEnvironment(
  homeDirectory: string,
  additions: Readonly<Record<string, string | undefined>> = {},
  allowlist: readonly string[] = DEFAULT_ENV_ALLOWLIST,
): Promise<NodeJS.ProcessEnv> {
  const configDirectory = join(homeDirectory, ".config");
  const cacheDirectory = join(homeDirectory, ".cache");
  const tempDirectory = join(homeDirectory, "tmp");
  await Promise.all([
    mkdir(configDirectory, { recursive: true }),
    mkdir(cacheDirectory, { recursive: true }),
    mkdir(tempDirectory, { recursive: true }),
  ]);

  const env: NodeJS.ProcessEnv = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (env.PATH === undefined) env.PATH = "/usr/local/bin:/usr/bin:/bin";

  for (const [key, value] of Object.entries(additions)) {
    if (value !== undefined) env[key] = value;
  }

  // These are forced after additions so callers cannot escape the ephemeral HOME.
  env.HOME = homeDirectory;
  env.XDG_CONFIG_HOME = configDirectory;
  env.XDG_CACHE_HOME = cacheDirectory;
  env.TMPDIR = tempDirectory;
  env.TMP = tempDirectory;
  env.TEMP = tempDirectory;
  return env;
}

export class SupervisedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly homeDirectory: string;
  readonly exit: Promise<ProcessExit>;
  readonly #exitDeferred: Deferred<ProcessExit>;
  readonly #killGraceMs: number;
  #timeout: NodeJS.Timeout | undefined;
  #cancelPromise: Promise<void> | undefined;
  #exited = false;
  #cleaned = false;
  #didTimeOut = false;

  constructor(
    child: ChildProcessWithoutNullStreams,
    homeDirectory: string,
    exitDeferred: Deferred<ProcessExit>,
    killGraceMs: number,
  ) {
    this.child = child;
    this.homeDirectory = homeDirectory;
    this.#exitDeferred = exitDeferred;
    this.exit = exitDeferred.promise;
    this.#killGraceMs = killGraceMs;

    child.once("close", (code, signal) => {
      this.#exited = true;
      if (this.#timeout) clearTimeout(this.#timeout);
      this.#exitDeferred.resolve({ code, signal });
    });
  }

  get didTimeOut(): boolean {
    return this.#didTimeOut;
  }

  get hasExited(): boolean {
    return this.#exited;
  }

  write(data: string | Uint8Array): Promise<void> {
    if (this.#exited || this.child.stdin.destroyed) {
      return Promise.reject(new Error("Agent process stdin is closed"));
    }
    return new Promise<void>((resolve, reject) => {
      this.child.stdin.write(data, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  closeStdin(): void {
    if (!this.child.stdin.destroyed) this.child.stdin.end();
  }

  armTimeout(
    timeoutMs: number,
    options: {
      readonly softGraceMs: number;
      readonly onTimeout?: (process: SupervisedProcess) => void | Promise<void>;
    },
  ): void {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || this.#exited) return;
    if (this.#timeout) clearTimeout(this.#timeout);

    this.#timeout = setTimeout(() => {
      this.#didTimeOut = true;
      void (async () => {
        try {
          await options.onTimeout?.(this);
        } finally {
          const exitedSoftly = await this.waitForExit(options.softGraceMs);
          if (!exitedSoftly) {
            await this.cancel({ signal: "SIGTERM", graceMs: this.#killGraceMs });
          }
        }
      })();
    }, timeoutMs);
    this.#timeout.unref();
  }

  async cancel(options: CancelProcessOptions = {}): Promise<void> {
    if (this.#exited) return;
    if (this.#cancelPromise) return this.#cancelPromise;

    this.#cancelPromise = (async () => {
      this.signalGroup(options.signal ?? "SIGINT");
      const exited = await this.waitForExit(options.graceMs ?? this.#killGraceMs);
      if (!exited) await this.forceKill();
    })();
    return this.#cancelPromise;
  }

  async forceKill(): Promise<void> {
    if (this.#exited) return;
    this.signalGroup("SIGKILL");
    await this.exit;
  }

  signalGroup(signal: NodeJS.Signals): boolean {
    if (this.#exited) return false;
    const pid = this.child.pid;
    try {
      if (process.platform !== "win32" && pid !== undefined) {
        process.kill(-pid, signal);
        return true;
      }
      return this.child.kill(signal);
    } catch (error) {
      if (isMissingProcessError(error)) return false;
      throw error;
    }
  }

  async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.#exited) return true;
    if (timeoutMs <= 0) return false;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
      void this.exit.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  async cleanup(): Promise<void> {
    if (this.#cleaned) return;
    this.#cleaned = true;
    if (this.#timeout) clearTimeout(this.#timeout);
    await rm(this.homeDirectory, { recursive: true, force: true });
  }
}

export async function spawnSupervisedProcess(
  options: SpawnSupervisedProcessOptions,
): Promise<SupervisedProcess> {
  const homeDirectory = await mkdtemp(
    join(tmpdir(), options.homePrefix ?? "mob-agent-"),
  );
  const env = await createIsolatedProcessEnvironment(
    homeDirectory,
    options.env,
    options.envAllowlist,
  );
  const exitDeferred = deferred<ProcessExit>();

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    await waitForSpawn(child);
  } catch (error) {
    await rm(homeDirectory, { recursive: true, force: true });
    throw error;
  }

  const supervised = new SupervisedProcess(
    child,
    homeDirectory,
    exitDeferred,
    options.killGraceMs ?? 2_000,
  );
  if (options.timeoutMs !== undefined) {
    supervised.armTimeout(options.timeoutMs, {
      softGraceMs: options.timeoutGraceMs ?? 500,
      ...(options.onTimeout ? { onTimeout: options.onTimeout } : {}),
    });
  }
  return supervised;
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function isMissingProcessError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ESRCH"
  );
}
