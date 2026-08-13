import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  configuredAgentIdentity,
  grantAgentWorkspace,
  revokeAgentWorkspace,
} from "./agent-access.js";

const execFileAsync = promisify(execFile);
const SAFE_GIT_CONFIG = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "credential.helper=",
] as const;

export interface MaterializeWorkspaceInput {
  /** Agent-owned checkout. No server credential is ever used with this Git directory. */
  taskDirectory: string;
  /** Control-plane-owned directory, distinct from and not traversable by the Agent. */
  controlDirectory: string;
  remoteUrl: string;
  baseRevision: string;
}

export interface MaterializeWorkspaceResult {
  /** Exact commit projected into the task checkout (also persisted in base-commit). */
  baseCommit: string;
  refreshed: boolean;
}

/** Stable control-plane location for one task's trusted repository state. */
export function controlRepositoryDirectory(dataDirectory: string, taskId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(taskId)) {
    throw new Error("Task id is not safe for a control repository path");
  }
  return join(resolve(dataDirectory), "control", "tasks", taskId);
}

export function controlGitDirectory(controlDirectory: string): string {
  return join(resolve(controlDirectory), "repository.git");
}

export function materializedBaseCommitPath(controlDirectory: string): string {
  return join(resolve(controlDirectory), "base-commit");
}

export async function readMaterializedBaseCommit(controlDirectory: string): Promise<string> {
  const value = (await readFile(materializedBaseCommitPath(controlDirectory), "utf8")).trim();
  if (!/^[0-9a-f]{40,64}$/u.test(value)) {
    throw new Error("Materialized base commit marker is invalid");
  }
  return value;
}

/**
 * Refresh a trusted, root/control-owned bare repository and project an exact
 * commit into the Agent-owned task checkout. Server credentials are confined
 * to the bare repository fetch; task Git commands run as the Agent identity
 * with a deliberately empty credential environment.
 */
export async function materializeGitWorkspace(
  input: MaterializeWorkspaceInput,
): Promise<MaterializeWorkspaceResult> {
  assertSeparateDirectories(input.taskDirectory, input.controlDirectory);
  const taskExists = await ensureTaskWorkspacePath(input.taskDirectory);
  if (taskExists) await revokeAgentWorkspace(input.taskDirectory);
  await ensureControlDirectory(input.controlDirectory);
  const repository = controlGitDirectory(input.controlDirectory);
  await ensureControlRepository(repository);

  const previousBase = await optionalBaseCommit(input.controlDirectory);
  let nextBase: string;
  try {
    nextBase = await refreshControlRepository(repository, input);
  } catch (error) {
    throw new Error(
      `Repository update failed in the control clone; the task checkout was preserved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (await exists(join(input.taskDirectory, ".git"))) {
    const comparisonBase = previousBase ?? await legacyCheckoutCommit(input.taskDirectory);
    if (!comparisonBase || !await controlHasCommit(repository, comparisonBase)) {
      // An old checkout without a trustworthy base is user state. Do not guess
      // and destroy it merely because the remote has moved.
      throw new Error("Task checkout was preserved because its exact base commit is unavailable");
    }
    if (!await taskTreeMatchesControl(input.taskDirectory, repository, comparisonBase)) {
      if (!previousBase) await writeBaseCommit(input.controlDirectory, comparisonBase);
      return { baseCommit: comparisonBase, refreshed: false };
    }
  } else if (await exists(input.taskDirectory)) {
    const entries = await readdir(input.taskDirectory);
    if (entries.length > 0) {
      throw new Error("Task workspace is non-empty but is not a Git checkout");
    }
  }

  await rebuildAgentCheckout(input, repository, nextBase);
  await writeBaseCommit(input.controlDirectory, nextBase);
  return { baseCommit: nextBase, refreshed: true };
}

async function ensureControlDirectory(directory: string): Promise<void> {
  const controlUid = typeof process.getuid === "function" ? process.getuid() : 0;
  const controlGid = typeof process.getgid === "function" ? process.getgid() : 0;
  const tasksDirectory = dirname(resolve(directory));
  const controlRoot = dirname(tasksDirectory);
  if (basename(tasksDirectory) !== "tasks" || basename(controlRoot) !== "control") {
    throw new Error("Control repository must be under a control/tasks directory");
  }
  for (const path of [controlRoot, tasksDirectory, resolve(directory)]) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!isExistingFileError(error)) throw error;
    }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Control repository path must contain only real directories");
    }
    await chown(path, controlUid, controlGid);
    await chmod(path, 0o700);
  }
}

async function ensureControlRepository(repository: string): Promise<void> {
  if (!await exists(repository)) {
    await controlGit(undefined, ["init", "--bare", "--", repository]);
  }
  const info = await lstat(repository);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Control Git repository must be a real directory");
  }
  const controlUid = typeof process.getuid === "function" ? process.getuid() : 0;
  const controlGid = typeof process.getgid === "function" ? process.getgid() : 0;
  await chown(repository, controlUid, controlGid);
  await chmod(repository, 0o700);
}

async function refreshControlRepository(
  repository: string,
  input: MaterializeWorkspaceInput,
): Promise<string> {
  const gitHubToken = await readServerGitHubToken();
  await controlGit(
    repository,
    [
      ...gitCredentialArguments(input.remoteUrl, gitHubToken),
      "fetch", "--force", "--no-tags", "--", input.remoteUrl, input.baseRevision,
    ],
    gitHubToken ? { GH_TOKEN: gitHubToken } : {},
  );
  const commit = (await controlGit(repository, [
    "rev-parse", "--verify", "FETCH_HEAD^{commit}",
  ])).trim();
  assertCommit(commit);
  // Keep every projected base reachable even after the tracked branch moves.
  await controlGit(repository, ["update-ref", `refs/mob/snapshots/${commit}`, commit]);
  return commit;
}

async function rebuildAgentCheckout(
  input: MaterializeWorkspaceInput,
  repository: string,
  commit: string,
): Promise<void> {
  const taskParent = dirname(resolve(input.taskDirectory));
  await mkdir(taskParent, { recursive: true, mode: 0o711 });
  await chmod(taskParent, 0o711);
  const transfer = await mkdtemp(join(taskParent, ".mob-materialize-"));
  const bundle = join(transfer, "repository.bundle");
  const template = join(transfer, "empty-template");
  try {
    await mkdir(template);
    await controlGit(repository, ["update-ref", "refs/heads/mob-materialized", commit]);
    await controlGit(repository, [
      "bundle", "create", bundle, "refs/heads/mob-materialized",
    ]);
    await grantAgentWorkspace(transfer);
    await rm(input.taskDirectory, { recursive: true, force: true });
    // The task parent is traversal-only (0711), so create and hand off the
    // empty destination before Git drops to MOB_AGENT_UID/GID.
    await mkdir(input.taskDirectory, { mode: 0o700 });
    await grantAgentWorkspace(input.taskDirectory);
    await agentGit(undefined, [
      "clone", "--no-local", "--no-checkout", `--template=${template}`, "--", bundle,
      input.taskDirectory,
    ]);
    await agentGit(input.taskDirectory, ["checkout", "--detach", commit]);
    if (await isSafeBranchName(repository, input.baseRevision)) {
      await agentGit(input.taskDirectory, ["switch", "-C", input.baseRevision, commit]);
    }
    await agentGit(input.taskDirectory, ["remote", "set-url", "origin", input.remoteUrl]);
    // No Agent process exists yet. Return the projected checkout to the
    // control plane so Wiki ingestion can read a frozen tree before the worker
    // performs the final handoff for the actual CLI run.
    await revokeAgentWorkspace(input.taskDirectory);
  } finally {
    await rm(transfer, { recursive: true, force: true });
  }
}

async function legacyCheckoutCommit(taskDirectory: string): Promise<string | undefined> {
  try {
    const gitDirectory = join(taskDirectory, ".git");
    const info = await lstat(gitDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    const head = (await readRegularFile(join(gitDirectory, "HEAD"))).trim();
    if (/^[0-9a-f]{40,64}$/u.test(head)) return head;
    const match = /^ref: (refs\/(?:heads|remotes)\/[A-Za-z0-9._/-]+)$/u.exec(head);
    if (!match?.[1] || match[1].includes("..") || match[1].includes("//")) return undefined;
    const loose = join(gitDirectory, ...match[1].split("/"));
    try {
      const value = (await readRegularFile(loose)).trim();
      return /^[0-9a-f]{40,64}$/u.test(value) ? value : undefined;
    } catch (error) {
      if (!isMissingFileError(error)) return undefined;
    }
    const packed = await readRegularFile(join(gitDirectory, "packed-refs"));
    for (const line of packed.split(/\r?\n/u)) {
      const packedMatch = /^([0-9a-f]{40,64}) (refs\/[A-Za-z0-9._/-]+)$/u.exec(line);
      if (packedMatch?.[2] === match[1]) return packedMatch[1];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function readRegularFile(path: string): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Git metadata path is not a regular file");
  }
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Git metadata path is not a regular file");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

type TreeEntry = { mode: string; oid: string; path: string };

async function taskTreeMatchesControl(
  taskDirectory: string,
  repository: string,
  commit: string,
): Promise<boolean> {
  const output = await controlGit(repository, [
    "ls-tree", "-r", "-z", "--full-tree", commit,
  ]);
  const expected = new Map<string, TreeEntry>();
  for (const record of output.split("\0").filter(Boolean)) {
    const match = /^(\d+) (blob|commit) ([0-9a-f]+)\t([\s\S]+)$/u.exec(record);
    if (!match) return false;
    const [, mode, , oid, path] = match;
    if (!mode || !oid || !path) return false;
    expected.set(path, { mode, oid, path });
  }
  const actualPaths = await listTaskPaths(taskDirectory);
  if (actualPaths.length !== expected.size) return false;
  for (const path of actualPaths) {
    const entry = expected.get(path);
    if (!entry || entry.mode === "160000") return false;
    const absolute = join(taskDirectory, ...path.split("/"));
    const info = await lstat(absolute);
    let contents: Buffer;
    let actualMode: string;
    if (info.isSymbolicLink()) {
      contents = Buffer.from(await readlink(absolute));
      actualMode = "120000";
    } else if (info.isFile()) {
      contents = await readRegularBuffer(absolute);
      actualMode = info.mode & 0o111 ? "100755" : "100644";
    } else {
      return false;
    }
    if (actualMode !== entry.mode || gitBlobOid(contents, entry.oid.length) !== entry.oid) return false;
  }
  return true;
}

async function readRegularBuffer(path: string): Promise<Buffer> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const information = await handle.stat();
    if (!information.isFile()) throw new Error("Task path is not a regular file");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function listTaskPaths(directory: string): Promise<string[]> {
  const paths: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const absolute = join(current, entry.name);
      const path = relative(directory, absolute).split(sep).join("/");
      if (entry.isSymbolicLink()) paths.push(path);
      else if (entry.isDirectory()) await visit(absolute);
      else paths.push(path);
    }
  }
  await visit(directory);
  return paths.sort();
}

function gitBlobOid(contents: Buffer, expectedLength = 40): string {
  return createHash(expectedLength === 64 ? "sha256" : "sha1")
    .update(`blob ${contents.byteLength}\0`)
    .update(contents)
    .digest("hex");
}

async function controlHasCommit(repository: string, commit: string): Promise<boolean> {
  try {
    await controlGit(repository, ["cat-file", "-e", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function isSafeBranchName(repository: string, branch: string): Promise<boolean> {
  try {
    await controlGit(repository, ["check-ref-format", "--branch", branch]);
    return true;
  } catch {
    return false;
  }
}

async function optionalBaseCommit(controlDirectory: string): Promise<string | undefined> {
  try {
    return await readMaterializedBaseCommit(controlDirectory);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

async function writeBaseCommit(controlDirectory: string, commit: string): Promise<void> {
  assertCommit(commit);
  const marker = materializedBaseCommitPath(controlDirectory);
  const temporary = join(controlDirectory, `.base-commit-${process.pid}.tmp`);
  await writeFile(temporary, `${commit}\n`, { mode: 0o600 });
  await rename(temporary, marker);
  await chmod(marker, 0o600);
}

async function controlGit(
  repository: string | undefined,
  args: readonly string[],
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    [...SAFE_GIT_CONFIG, ...(repository ? ["--git-dir", repository] : []), ...args],
    {
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      env: controlGitEnvironment(extraEnvironment),
    },
  );
  return stdout;
}

async function agentGit(directory: string | undefined, args: readonly string[]): Promise<string> {
  const identity = configuredAgentIdentity();
  const { stdout } = await execFileAsync(
    "git",
    [...SAFE_GIT_CONFIG, ...(directory ? ["-C", directory] : []), ...args],
    {
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      env: agentGitEnvironment(),
      ...(identity ? identity : {}),
    },
  );
  return stdout;
}

/** Exported for regression tests and runtime audits; never inherit credentials. */
export function agentGitEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: environment.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

function controlGitEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...extra,
  };
}

function gitCredentialArguments(remoteUrl: string, gitHubToken: string | undefined): string[] {
  if (!gitHubToken || !/^https:\/\/github\.com\//iu.test(remoteUrl)) return [];
  return ["-c", "credential.helper=!gh auth git-credential"];
}

async function readServerGitHubToken(): Promise<string | undefined> {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (!process.env.GH_TOKEN_FILE) return undefined;
  const token = (await readFile(process.env.GH_TOKEN_FILE, "utf8")).trim();
  return token || undefined;
}

function assertSeparateDirectories(taskDirectory: string, controlDirectory: string): void {
  const task = resolve(taskDirectory);
  const control = resolve(controlDirectory);
  if (task === control || task.startsWith(`${control}${sep}`) || control.startsWith(`${task}${sep}`)) {
    throw new Error("Task and control repository directories must be separate");
  }
}

async function ensureTaskWorkspacePath(taskDirectory: string): Promise<boolean> {
  const target = resolve(taskDirectory);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o711 });
  const parentInformation = await lstat(parent);
  if (!parentInformation.isDirectory() || parentInformation.isSymbolicLink()) {
    throw new Error("Task workspace parent must be a real directory");
  }
  try {
    const information = await lstat(target);
    if (!information.isDirectory() || information.isSymbolicLink()) {
      throw new Error("Task workspace must be a real directory, not a symbolic link");
    }
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

function assertCommit(commit: string): void {
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Error("Git returned an invalid commit id");
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isExistingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
