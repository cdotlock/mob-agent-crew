import { execFile } from "node:child_process";
import { chmod, lstat, readdir, readFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Give the dedicated CLI user ownership of exactly one task checkout. The
 * production worker is intentionally single-concurrency; the checkout is
 * returned to the control plane as soon as the run settles.
 */
export async function grantAgentWorkspace(directory: string): Promise<boolean> {
  const identity = configuredAgentIdentity();
  const target = resolve(directory);
  await requireRealDirectory(target);
  if (!identity) return false;
  // A previous CLI may have daemonized outside its original process group.
  // The production topology deliberately has one fixed Agent UID and one run,
  // so clearing that UID before handing over a checkout is both narrow and
  // deterministic.
  await terminateAgentIdentityProcesses(identity);
  await execFileAsync("chown", ["-R", "-P", `${identity.uid}:${identity.gid}`, target], {
    timeout: 120_000,
    maxBuffer: 512 * 1024,
  });
  await chmod(target, 0o700);
  return true;
}

export async function revokeAgentWorkspace(directory: string): Promise<boolean> {
  const identity = configuredAgentIdentity();
  const controlUid = typeof process.getuid === "function" ? process.getuid() : 0;
  const controlGid = typeof process.getgid === "function" ? process.getgid() : 0;
  const target = resolve(directory);
  await requireRealDirectory(target);
  if (identity) {
    await terminateAgentIdentityProcesses(identity);
  }
  // Freeze every real entry, not merely the checkout root. This removes
  // group/other write bits left by Agent-created 0777 subdirectories while
  // deliberately never chmod'ing through a symbolic link.
  await freezeTree(target, identity ? { uid: controlUid, gid: controlGid } : undefined);
  await chmod(target, 0o700);
  return identity !== undefined;
}

/**
 * Kill every process running under the dedicated Agent identity.
 *
 * Process-group signals are insufficient because a CLI/tool can call setsid()
 * and survive its parent. Railway runs Linux and Mob intentionally reserves one
 * UID for a single Agent run, so a bounded /proc UID sweep is the smallest
 * reliable cleanup boundary without introducing another daemon or container.
 */
export async function terminateAgentIdentityProcesses(
  identity = configuredAgentIdentity(),
): Promise<number> {
  if (!identity || process.platform !== "linux") return 0;
  const controlUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  // Local tests may intentionally configure their own UID. Never signal the
  // control process or sibling developer processes in that configuration.
  if (controlUid === identity.uid) return 0;

  let signalled = 0;
  for (const [signal, rounds] of [["SIGTERM", 5], ["SIGKILL", 25]] as const) {
    for (let round = 0; round < rounds; round += 1) {
      const pids = await agentProcessIds(identity.uid);
      if (pids.length === 0) return signalled;
      for (const pid of pids) {
        try {
          process.kill(pid, signal);
          signalled += 1;
        } catch (error) {
          if (!isMissingProcessError(error)) throw error;
        }
      }
      await delay(20);
    }
  }
  const survivors = await agentProcessIds(identity.uid);
  if (survivors.length > 0) {
    throw new Error(`Unable to clear ${survivors.length} residual Agent process(es)`);
  }
  return signalled;
}

export function configuredAgentIdentity(
  environment: NodeJS.ProcessEnv = process.env,
): { uid: number; gid: number } | undefined {
  const uidValue = environment.MOB_AGENT_UID;
  const gidValue = environment.MOB_AGENT_GID;
  if (!uidValue && !gidValue) return undefined;
  const uid = Number(uidValue);
  const gid = Number(gidValue);
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) {
    throw new Error("MOB_AGENT_UID and MOB_AGENT_GID must be positive integers");
  }
  return { uid, gid };
}

async function requireRealDirectory(path: string): Promise<Stats> {
  const information = await lstat(path);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error("Agent workspace must be a real directory, not a symbolic link");
  }
  return information;
}

async function freezeTree(
  root: string,
  owner: { uid: number; gid: number } | undefined,
): Promise<void> {
  const visit = async (path: string): Promise<void> => {
    const information = await lstat(path);
    if (information.isSymbolicLink()) return;
    if (!information.isDirectory() && !information.isFile()) {
      throw new Error(`Agent workspace contains an unsupported path: ${path}`);
    }
    if (owner) {
      await execFileAsync("chown", [`${owner.uid}:${owner.gid}`, path], {
        timeout: 120_000,
        maxBuffer: 64 * 1024,
      });
    }
    await chmod(path, information.mode & ~0o022);
    if (!information.isDirectory()) return;
    for (const name of await readdir(path)) await visit(resolve(path, name));
  };
  await visit(root);
}

async function agentProcessIds(uid: number): Promise<number[]> {
  let entries;
  try {
    entries = await readdir("/proc", { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
  const currentPid = process.pid;
  const matches: number[] = [];
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) return;
    const pid = Number(entry.name);
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === currentPid) return;
    try {
      const status = await readFile(`/proc/${entry.name}/status`, "utf8");
      // An orphaned zombie has no executable state and cannot access files or
      // sockets. PID 1 may reap it asynchronously; treating it as live would
      // otherwise block every future Agent handoff forever.
      if (/^State:\s+Z\b/mu.test(status)) return;
      const realUid = /^Uid:\s+(\d+)/mu.exec(status)?.[1];
      if (realUid !== undefined && Number(realUid) === uid) matches.push(pid);
    } catch (error) {
      if (!isMissingFileError(error) && !isPermissionError(error)) throw error;
    }
  }));
  return matches.sort((left, right) => left - right);
}

function isMissingProcessError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH";
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isPermissionError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EACCES";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
