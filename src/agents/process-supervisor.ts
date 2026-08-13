import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { chown, lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  configuredAgentIdentity,
  terminateAgentIdentityProcesses,
} from "../workspace/agent-access.js";
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
  readonly profileSeed?: {
    readonly sourceDirectory: string;
    readonly files: readonly string[];
    readonly environmentVariables: readonly string[];
  };
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
  readonly #runIdentity: { uid: number; gid: number } | undefined;
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
    runIdentity: { uid: number; gid: number } | undefined,
  ) {
    this.child = child;
    this.homeDirectory = homeDirectory;
    this.#exitDeferred = exitDeferred;
    this.exit = exitDeferred.promise;
    this.#killGraceMs = killGraceMs;
    this.#runIdentity = runIdentity;

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
    try {
      await terminateAgentIdentityProcesses(this.#runIdentity);
    } catch (error) {
      // The next workspace handoff independently repeats this sweep and fails
      // closed if a process survived. Do not strand the current run result.
      console.error("failed to clear residual Agent processes", error);
    }
    await rm(this.homeDirectory, { recursive: true, force: true });
  }
}

export async function spawnSupervisedProcess(
  options: SpawnSupervisedProcessOptions,
): Promise<SupervisedProcess> {
  const runIdentity = configuredAgentIdentity();
  // Clear any daemon that escaped the previous CLI's process group before a
  // new HOME or task subprocess becomes available to the shared Agent UID.
  await terminateAgentIdentityProcesses(runIdentity);
  const homeDirectory = await mkdtemp(
    join(tmpdir(), options.homePrefix ?? "mob-agent-"),
  );
  let profileDirectory: string | undefined;
  let env: NodeJS.ProcessEnv;
  try {
    profileDirectory = options.profileSeed
      ? await seedIsolatedProfile(homeDirectory, options.profileSeed)
      : undefined;
    env = await createIsolatedProcessEnvironment(
      homeDirectory,
      options.env,
      options.envAllowlist,
    );
  } catch (error) {
    await rm(homeDirectory, { recursive: true, force: true });
    throw error;
  }
  if (profileDirectory) {
    for (const name of options.profileSeed?.environmentVariables ?? []) {
      env[name] = profileDirectory;
    }
  }
  try {
    if (runIdentity) {
      const paths = [
        chown(homeDirectory, runIdentity.uid, runIdentity.gid),
        chown(join(homeDirectory, ".config"), runIdentity.uid, runIdentity.gid),
        chown(join(homeDirectory, ".cache"), runIdentity.uid, runIdentity.gid),
        chown(join(homeDirectory, "tmp"), runIdentity.uid, runIdentity.gid),
      ];
      if (profileDirectory) {
        paths.push(chown(profileDirectory, runIdentity.uid, runIdentity.gid));
        for (const file of options.profileSeed?.files ?? []) {
          paths.push(chown(join(profileDirectory, file), runIdentity.uid, runIdentity.gid));
        }
      }
      await Promise.all(paths);
    }
  } catch (error) {
    await rm(homeDirectory, { recursive: true, force: true });
    throw error;
  }
  const exitDeferred = deferred<ProcessExit>();

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      ...(runIdentity ? runIdentity : {}),
    });
    await waitForSpawn(child);
  } catch (error) {
    await terminateAgentIdentityProcesses(runIdentity).catch(() => undefined);
    await rm(homeDirectory, { recursive: true, force: true });
    throw error;
  }

  const supervised = new SupervisedProcess(
    child,
    homeDirectory,
    exitDeferred,
    options.killGraceMs ?? 2_000,
    runIdentity,
  );
  if (options.timeoutMs !== undefined) {
    supervised.armTimeout(options.timeoutMs, {
      softGraceMs: options.timeoutGraceMs ?? 500,
      ...(options.onTimeout ? { onTimeout: options.onTimeout } : {}),
    });
  }
  return supervised;
}

async function seedIsolatedProfile(
  homeDirectory: string,
  seed: NonNullable<SpawnSupervisedProcessOptions["profileSeed"]>,
): Promise<string> {
  const sourceDirectory = resolve(seed.sourceDirectory);
  const sourceInformation = await lstat(sourceDirectory);
  if (!sourceInformation.isDirectory() || sourceInformation.isSymbolicLink()) {
    throw new Error("Agent profile source must be a real directory");
  }

  const destinationDirectory = join(homeDirectory, "agent");
  await mkdir(destinationDirectory, { mode: 0o700 });
  for (const filename of seed.files) {
    if (filename !== basename(filename) || filename === "." || filename === "..") {
      throw new Error(`Invalid Agent profile filename: ${filename}`);
    }
    const sourcePath = join(sourceDirectory, filename);
    const sourceHandle = await open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let contents: Buffer;
    try {
      const information = await sourceHandle.stat();
      if (!information.isFile()) throw new Error(`Agent profile file is not regular: ${filename}`);
      if (information.size > 1024 * 1024) throw new Error(`Agent profile file is too large: ${filename}`);
      contents = await sourceHandle.readFile();
    } finally {
      await sourceHandle.close();
    }
    const destinationHandle = await open(
      join(destinationDirectory, filename),
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await destinationHandle.writeFile(contents);
    } finally {
      await destinationHandle.close();
    }
  }
  return destinationDirectory;
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
