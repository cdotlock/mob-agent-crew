import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";

export type WorkspaceFileScope = "workspace" | "repository";

export interface WorkspaceFileEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly bytes: number | null;
  readonly updatedAt: string;
}

export interface WorkspaceFileListing {
  readonly scope: WorkspaceFileScope;
  readonly path: string;
  readonly entries: readonly WorkspaceFileEntry[];
}

export interface WorkspaceFileContents {
  readonly scope: WorkspaceFileScope;
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
  readonly language: string;
  readonly content: string;
  readonly truncated: boolean;
}

export interface WorkspaceFileBrowserOptions {
  readonly dataDir: string;
  readonly maxReadBytes?: number;
  readonly maxEntries?: number;
}

const privateRepositoryNames = new Set([
  ".aws",
  ".env",
  ".env.local",
  ".env.production",
  ".git",
  ".git-credentials",
  ".gnupg",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".ssh",
  "auth.json",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "node_modules",
]);

/**
 * A deliberately small, read-only view over Mob-owned workspace files and a
 * task's checked-out repository. Mutations continue to go through the normal
 * collaboration and knowledge APIs so the file ledger remains auditable.
 */
export class WorkspaceFileBrowser {
  readonly #dataDir: string;
  readonly #maxReadBytes: number;
  readonly #maxEntries: number;

  constructor(options: WorkspaceFileBrowserOptions) {
    this.#dataDir = resolve(options.dataDir);
    this.#maxReadBytes = options.maxReadBytes ?? 512 * 1024;
    this.#maxEntries = options.maxEntries ?? 500;
  }

  async list(input: {
    scope: WorkspaceFileScope;
    workspaceId: string;
    taskId?: string;
    path?: string;
  }): Promise<WorkspaceFileListing> {
    const root = this.#root(input.scope, input.workspaceId, input.taskId);
    const relativePath = safeRelativePath(input.path ?? "");
    const directory = await safeExistingPath(root, relativePath);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("File browser path is not a directory");

    const names = await readdir(directory);
    const entries: WorkspaceFileEntry[] = [];
    for (const name of names.sort((left, right) => left.localeCompare(right))) {
      if (input.scope === "repository" && isPrivateRepositoryEntry(relativePath, name)) continue;
      const absolutePath = resolve(directory, name);
      const entryInfo = await lstat(absolutePath);
      if (entryInfo.isSymbolicLink() || (!entryInfo.isDirectory() && !entryInfo.isFile())) continue;
      entries.push({
        name,
        path: joinRelative(relativePath, name),
        kind: entryInfo.isDirectory() ? "directory" : "file",
        bytes: entryInfo.isFile() ? entryInfo.size : null,
        updatedAt: entryInfo.mtime.toISOString(),
      });
      if (entries.length >= this.#maxEntries) break;
    }
    entries.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    return { scope: input.scope, path: relativePath, entries };
  }

  async read(input: {
    scope: WorkspaceFileScope;
    workspaceId: string;
    taskId?: string;
    path: string;
  }): Promise<WorkspaceFileContents> {
    const root = this.#root(input.scope, input.workspaceId, input.taskId);
    const relativePath = safeRelativePath(input.path);
    if (!relativePath) throw new Error("Choose a file to read");
    if (input.scope === "repository" && isPrivateRepositoryPath(relativePath)) {
      throw new Error("This repository path is private");
    }
    await rejectSymlinkPath(root, relativePath);
    const absolutePath = await safeExistingPath(root, relativePath);
    const info = await stat(absolutePath);
    if (!info.isFile()) throw new Error("File browser path is not a file");
    const bytesToRead = Math.min(info.size, this.#maxReadBytes);
    const handle = await open(absolutePath, "r");
    const slice = Buffer.alloc(bytesToRead);
    try {
      await handle.read(slice, 0, bytesToRead, 0);
    } finally {
      await handle.close();
    }
    if (slice.includes(0) || !isUtf8(slice)) {
      throw new Error("Binary or non-UTF-8 files are not rendered in the browser");
    }
    return {
      scope: input.scope,
      path: relativePath,
      name: basename(relativePath),
      bytes: info.size,
      language: languageFor(relativePath),
      content: slice.toString("utf8"),
      truncated: info.size > bytesToRead,
    };
  }

  #root(scope: WorkspaceFileScope, workspaceId: string, taskId?: string): string {
    const workspaceSegment = safeIdentifier(workspaceId, "workspaceId");
    if (scope === "workspace") {
      return resolve(this.#dataDir, "state", "workspaces", workspaceSegment);
    }
    if (!taskId) throw new Error("taskId is required for repository files");
    return resolve(this.#dataDir, "tasks", safeIdentifier(taskId, "taskId"));
  }
}

function safeIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function safeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  if (normalized.includes("\0")) throw new Error("File path is invalid");
  const segments = normalized ? normalized.split("/") : [];
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("File path contains an unsafe segment");
  }
  return segments.join("/");
}

async function safeExistingPath(root: string, relativePath: string): Promise<string> {
  const rootPath = resolve(root);
  const candidate = resolve(rootPath, relativePath);
  if (candidate !== rootPath && !candidate.startsWith(`${rootPath}${sep}`)) {
    throw new Error("File path escapes its workspace root");
  }
  const [realRoot, realCandidate] = await Promise.all([realpath(rootPath), realpath(candidate)]);
  if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${sep}`)) {
    throw new Error("File path escapes its workspace root");
  }
  return realCandidate;
}

function joinRelative(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

function isPrivateRepositoryEntry(parent: string, name: string): boolean {
  if (!parent && [".git", "node_modules"].includes(name)) return true;
  return isPrivateRepositoryPath(joinRelative(parent, name));
}

function isPrivateRepositoryPath(path: string): boolean {
  const segments = path.split("/");
  return segments.some((segment) =>
    privateRepositoryNames.has(segment) ||
    /^\.env(?:\.|$)/u.test(segment) ||
    /\.(?:key|pem|p12|pfx|kdbx)$/iu.test(segment)
  );
}

async function rejectSymlinkPath(root: string, relativePath: string): Promise<void> {
  let cursor = resolve(root);
  if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Symbolic links are not rendered");
  for (const segment of relativePath.split("/")) {
    cursor = resolve(cursor, segment);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Symbolic links are not rendered");
  }
}

function isUtf8(value: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(value);
    return true;
  } catch {
    return false;
  }
}

function languageFor(path: string): string {
  const extension = extname(path).toLowerCase();
  return ({
    ".css": "css",
    ".diff": "diff",
    ".html": "html",
    ".js": "javascript",
    ".json": "json",
    ".jsx": "jsx",
    ".md": "markdown",
    ".mjs": "javascript",
    ".patch": "diff",
    ".py": "python",
    ".sh": "shell",
    ".sql": "sql",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".yaml": "yaml",
    ".yml": "yaml",
  } as Record<string, string>)[extension] ?? "text";
}

export function relativeFilePath(root: string, path: string): string {
  return relative(resolve(root), resolve(path)).replaceAll("\\", "/");
}
