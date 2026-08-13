import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { revokeAgentWorkspace } from "./agent-access.js";
import { controlGitDirectory, readMaterializedBaseCommit } from "./materialize.js";

const execFileAsync = promisify(execFile);

export interface PublishTaskBranchInput {
  taskDirectory: string;
  controlDirectory: string;
  remoteUrl: string;
  branchName: string;
  commitMessage: string;
  authorName: string;
  authorEmail: string;
  githubToken?: string;
}

export interface PublishTaskBranchResult {
  branch: string;
  commit: string;
  changedFiles: string[];
}

/**
 * Commit and push one already-reviewed task checkout.
 *
 * This function is deliberately control-plane-only. Callers must establish a
 * human session and the repository allowlist before entering it; the Agent
 * subprocess never receives the GitHub token used by the final push.
 */
export async function publishTaskBranch(
  input: PublishTaskBranchInput,
): Promise<PublishTaskBranchResult> {
  // The Agent-owned checkout (including its .git directory) is permanently
  // untrusted. Freeze it, then copy only ordinary working-tree files into a
  // fresh checkout cloned from Mob's root-only control repository. No Git
  // command below ever touches Agent-controlled Git metadata.
  await revokeAgentWorkspace(input.taskDirectory);
  const baseCommit = await readMaterializedBaseCommit(input.controlDirectory);
  const trustedGitDirectory = controlGitDirectory(input.controlDirectory);
  await assertSafeBranch(trustedGitDirectory, input.branchName);
  await trustedGit(trustedGitDirectory, ["cat-file", "-e", `${baseCommit}^{commit}`]);

  const publishDirectory = await mkdtemp(join(input.controlDirectory, "publish-"));
  await chmod(publishDirectory, 0o700);
  try {
    await trustedGit(input.controlDirectory, [
      "clone", "--no-hardlinks", "--no-checkout", "--", trustedGitDirectory, publishDirectory,
    ]);
    await trustedGit(publishDirectory, ["checkout", "-b", input.branchName, baseCommit]);
    await clearWorkingTree(publishDirectory);
    await copyUntrustedWorkingTree(input.taskDirectory, publishDirectory);
    await trustedGit(publishDirectory, ["add", "-A"]);

    const changedFiles = await nulSeparatedGit(
      publishDirectory,
      ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRD"],
    );
    if (changedFiles.length === 0) {
      throw new Error("The task checkout has no changes to publish relative to its materialized base commit.");
    }
    const contentFiles = await nulSeparatedGit(
      publishDirectory,
      ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"],
    );
    assertNoSecretFilenames(contentFiles);
    await assertNoSecretContents(publishDirectory, contentFiles);

    const authorName = singleLine(input.authorName, "author name");
    const authorEmail = singleLine(input.authorEmail, "author email");
    const commitMessage = singleLine(input.commitMessage, "commit message");
    await trustedGit(publishDirectory, [
      "-c", `user.name=${authorName}`,
      "-c", `user.email=${authorEmail}`,
      "-c", "commit.gpgSign=false",
      "commit", "--no-verify", "-m", commitMessage,
    ]);
    const commit = (await trustedGit(publishDirectory, ["rev-parse", "HEAD"])).trim();

    const githubToken = input.githubToken ?? await readServerGitHubToken();
    await trustedGit(
      publishDirectory,
      [
        ...(githubToken && /^https:\/\/github\.com\//iu.test(input.remoteUrl)
          ? ["-c", "credential.helper=!gh auth git-credential"]
          : []),
        "push", "--no-verify", "--set-upstream", "--", input.remoteUrl,
        `HEAD:refs/heads/${input.branchName}`,
      ],
      githubToken ? { GH_TOKEN: githubToken } : {},
    );

    return { branch: input.branchName, commit, changedFiles: changedFiles.sort() };
  } finally {
    await rm(publishDirectory, { recursive: true, force: true });
  }
}

/** The web/API release surface currently supports GitHub HTTPS remotes only. */
export function assertGitHubPublishRemote(remoteUrl: string): void {
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    throw new Error("Publication requires an allowlisted HTTPS GitHub repository.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/u.test(url.pathname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Publication requires an allowlisted HTTPS GitHub repository.");
  }
}

async function assertSafeBranch(directory: string, branch: string): Promise<void> {
  if (!branch.startsWith("mob/") || branch.length > 160) {
    throw new Error("Publication requires a safe Git branch under mob/.");
  }
  try {
    await trustedGit(directory, ["check-ref-format", "--branch", branch]);
  } catch {
    throw new Error("Publication requires a safe Git branch under mob/.");
  }
}

function assertNoSecretFilenames(paths: readonly string[]): void {
  const rejected = paths.find((path) => isSecretFilename(path));
  if (rejected) {
    throw new Error(`Refusing to publish secret-shaped filename '${rejected}'.`);
  }
}

async function assertNoSecretContents(directory: string, paths: readonly string[]): Promise<void> {
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
    /\bsk-[A-Za-z0-9_-]{20,}\b/u,
    /\bmob-[A-Za-z0-9]{32,}\b/u,
    /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/u,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
    /\bAKIA[0-9A-Z]{16}\b/u,
    // Mob run credentials are a signed two-part bearer, not a three-part JWT.
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{32,}\b/u,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  ];
  for (const path of paths) {
    const handle = await open(join(directory, path), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let content: Buffer;
    try {
      const information = await handle.stat();
      if (!information.isFile()) {
        throw new Error(`Refusing to publish non-regular path '${path}'.`);
      }
      content = await handle.readFile();
    } finally {
      await handle.close();
    }
    const text = content.toString("utf8");
    if (patterns.some((pattern) => pattern.test(text))) {
      throw new Error(`Refusing to publish secret-shaped content in '${path}'.`);
    }
  }
}

async function clearWorkingTree(directory: string): Promise<void> {
  const entries = await readdir(directory);
  await Promise.all(entries
    .filter((entry) => entry !== ".git")
    .map((entry) => rm(join(directory, entry), { recursive: true, force: true })));
}

async function copyUntrustedWorkingTree(source: string, destination: string): Promise<void> {
  const rootInformation = await lstat(source);
  if (!rootInformation.isDirectory() || rootInformation.isSymbolicLink()) {
    throw new Error("Refusing to publish a symbolic or non-directory task workspace.");
  }
  const limits = { files: 0, bytes: 0 };
  const copyDirectory = async (from: string, to: string, relativePath: string): Promise<void> => {
    await mkdir(to, { recursive: true, mode: 0o755 });
    for (const name of await readdir(from)) {
      if (name === ".git") continue;
      const sourcePath = join(from, name);
      const targetPath = join(to, name);
      const childRelativePath = relativePath ? `${relativePath}/${name}` : name;
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
        throw new Error(`Refusing to publish non-regular path '${childRelativePath}'.`);
      }
      if (info.isDirectory()) {
        await copyDirectory(sourcePath, targetPath, childRelativePath);
        continue;
      }
      // Open the untrusted source without following its final component, then
      // trust the descriptor's fstat rather than the earlier pathname lstat.
      // revokeAgentWorkspace has already killed the Agent UID and removed
      // group/other writes from every parent directory.
      const sourceHandle = await open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const openedInfo = await sourceHandle.stat();
        if (!openedInfo.isFile()) {
          throw new Error(`Refusing to publish non-regular path '${childRelativePath}'.`);
        }
        limits.files += 1;
        limits.bytes += openedInfo.size;
        if (limits.files > 20_000 || limits.bytes > 512 * 1024 * 1024) {
          throw new Error("The reviewed checkout exceeds the safe publication size limit.");
        }
        const mode = openedInfo.mode & 0o111 ? 0o755 : 0o644;
        await copyOpenedFile(sourceHandle, targetPath, openedInfo.size, mode);
      } finally {
        await sourceHandle.close();
      }
    }
  };
  await copyDirectory(source, destination, "");
}

async function copyOpenedFile(
  source: FileHandle,
  destination: string,
  bytes: number,
  mode: number,
): Promise<void> {
  const target = await open(
    destination,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    mode,
  );
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  try {
    while (offset < bytes) {
      const length = Math.min(buffer.byteLength, bytes - offset);
      const { bytesRead } = await source.read(buffer, 0, length, offset);
      if (bytesRead === 0) throw new Error("The reviewed checkout changed while it was being frozen.");
      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(buffer, written, bytesRead - written, offset + written);
        if (result.bytesWritten === 0) throw new Error("Unable to copy the reviewed checkout.");
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
  } finally {
    await target.close();
  }
  await chmod(destination, mode);
}

function isSecretFilename(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const name = basename(normalized);
  return parts.some((part) => [".aws", ".gnupg", ".ssh"].includes(part)) ||
    name === ".env" || name.startsWith(".env.") ||
    [".git-credentials", ".netrc", "credentials", "credentials.json", "auth.json", "token", "token.json"].includes(name) ||
    /(?:^|[._-])(secret|secrets|token|credentials?)(?:[._-]|$)/u.test(name) ||
    /\.(?:key|pem|p12|pfx|kdbx)$/u.test(name) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)$/u.test(name);
}

function singleLine(value: string, label: string): string {
  const normalized = value.replace(/[\r\n]+/gu, " ").trim();
  if (!normalized || normalized.length > 240) throw new Error(`Publication ${label} is invalid.`);
  return normalized;
}

async function nulSeparatedGit(directory: string, args: readonly string[]): Promise<string[]> {
  const output = await trustedGit(directory, args);
  return output.split("\0").filter(Boolean);
}

async function trustedGit(
  directory: string,
  args: readonly string[],
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "credential.helper=",
    "-C", directory,
    ...args,
  ], {
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      ...extraEnvironment,
    },
  });
  return stdout;
}

async function readServerGitHubToken(): Promise<string | undefined> {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (!process.env.GH_TOKEN_FILE) return undefined;
  const token = (await readFile(process.env.GH_TOKEN_FILE, "utf8")).trim();
  return token || undefined;
}
