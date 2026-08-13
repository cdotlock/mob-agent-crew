import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import type { WorkspaceKnowledge } from "./workspace-knowledge.js";

const MAX_FILES = 200;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const ROOT_DOCUMENT = /^(?:README(?:\.[^.]+)?|AGENTS|CONTRIBUTING|CHANGELOG|SECURITY)\.md$/iu;
const DOCUMENT_DIRECTORIES = new Set(["docs", "doc", "wiki"]);

export interface SyncRepositoryKnowledgeInput {
  readonly checkoutDirectory: string;
  readonly repositoryName: string;
  readonly remoteUrl: string;
  /** Exact commit supplied by the trusted control repository materializer. */
  readonly revision: string;
  readonly knowledge: WorkspaceKnowledge;
}

export interface RepositoryKnowledgeSyncResult {
  readonly repository: string;
  readonly revision: string;
  readonly snapshot: string;
  readonly documents: number;
  readonly rawPaths: readonly string[];
  readonly wikiPath: string;
}

interface SourceDocument {
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
  readonly digest: string;
}

/**
 * Imports repository-owned Markdown into the platform knowledge tree.
 *
 * Source snapshots are immutable under raw/. The small wiki index is a mutable,
 * deterministic catalog, so every task run sees current repository knowledge
 * without requiring an Agent to remember an ingestion command.
 */
export async function syncRepositoryKnowledge(
  input: SyncRepositoryKnowledgeInput,
): Promise<RepositoryKnowledgeSyncResult> {
  const repository = safeRepositorySegment(input.repositoryName);
  const documents = await readRepositoryDocuments(input.checkoutDirectory);
  const revision = requireRevision(input.revision);
  const snapshot = snapshotId(revision, documents);
  const rawPaths: string[] = [];

  for (const document of documents) {
    const rawPath = `repositories/${repository}/${snapshot}/${document.path}`;
    const written = await input.knowledge.writeRaw({
      path: rawPath,
      content: document.content,
      source: `${safeRemoteUrl(input.remoteUrl)}#${revision}:${document.path}`,
      metadata: {
        repository,
        revision,
        snapshot,
        sourcePath: document.path,
        digest: document.digest,
      },
    });
    rawPaths.push(written.path);
  }

  const wikiPath = `repositories/${repository}/index.md`;
  await input.knowledge.writeWiki({
    path: wikiPath,
    content: repositoryIndex({ repository, remoteUrl: input.remoteUrl, revision, snapshot, documents, rawPaths }),
    source: `repository-sync:${safeRemoteUrl(input.remoteUrl)}#${revision}`,
    metadata: { repository, revision, snapshot, documents: documents.length },
  });
  await input.knowledge.rebuildIndex();

  return { repository, revision, snapshot, documents: documents.length, rawPaths, wikiPath: `wiki/${wikiPath}` };
}

async function readRepositoryDocuments(root: string): Promise<SourceDocument[]> {
  const rootInformation = await lstat(root);
  if (!rootInformation.isDirectory() || rootInformation.isSymbolicLink()) {
    throw new Error("Repository knowledge source must be a real directory");
  }
  const candidates: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && ROOT_DOCUMENT.test(entry.name)) candidates.push(entry.name);
    if (entry.isDirectory() && DOCUMENT_DIRECTORIES.has(entry.name.toLowerCase())) {
      await walkMarkdown(root, entry.name, candidates, 0);
    }
  }

  const documents: SourceDocument[] = [];
  let totalBytes = 0;
  for (const path of candidates.sort().slice(0, MAX_FILES)) {
    const absolute = join(root, path);
    let handle;
    try {
      handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (isUnsafeOrMissingPath(error)) continue;
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
      if (totalBytes + info.size > MAX_TOTAL_BYTES) break;
      const bytes = await handle.readFile();
      if (bytes.byteLength !== info.size || bytes.includes(0)) continue;
      const content = bytes.toString("utf8");
      if (Buffer.from(content, "utf8").compare(bytes) !== 0) continue;
      totalBytes += info.size;
      documents.push({ path: portablePath(path), content, bytes: info.size, digest: sha256(content) });
    } finally {
      await handle.close();
    }
  }
  return documents;
}

async function walkMarkdown(root: string, path: string, output: string[], depth: number): Promise<void> {
  if (depth > 5 || output.length >= MAX_FILES) return;
  const absolute = join(root, path);
  const directoryInformation = await lstat(absolute);
  if (!directoryInformation.isDirectory() || directoryInformation.isSymbolicLink()) return;
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    if (output.length >= MAX_FILES) return;
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) await walkMarkdown(root, child, output, depth + 1);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) output.push(child);
  }
}

function isUnsafeOrMissingPath(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return ["ELOOP", "ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code));
}

function requireRevision(value: string): string {
  const revision = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/u.test(revision)) {
    throw new Error("Repository knowledge requires an exact trusted revision");
  }
  return revision;
}

function snapshotId(revision: string, documents: readonly SourceDocument[]): string {
  const content = documents.map((document) => `${document.path}\0${document.digest}`).join("\n");
  return `${revision.slice(0, 12)}-${sha256(content).slice(0, 12)}`;
}

function repositoryIndex(input: {
  repository: string;
  remoteUrl: string;
  revision: string;
  snapshot: string;
  documents: readonly SourceDocument[];
  rawPaths: readonly string[];
}): string {
  const lines = [
    `# ${input.repository}`,
    "",
    `- Source: ${safeRemoteUrl(input.remoteUrl)}`,
    `- Revision: \`${input.revision}\``,
    `- Snapshot: \`${input.snapshot}\``,
    `- Imported documents: ${input.documents.length}`,
    "",
    "## Repository knowledge",
    "",
  ];
  if (input.documents.length === 0) {
    lines.push("No supported Markdown documentation was found in this checkout.");
  } else {
    for (let index = 0; index < input.documents.length; index += 1) {
      const document = input.documents[index];
      const rawPath = input.rawPaths[index];
      if (!document || !rawPath) continue;
      lines.push(`- [${document.path}](${rawPath}) — ${firstUsefulLine(document.content)}`);
    }
  }
  lines.push("", "This page is maintained automatically from the task checkout.", "");
  return lines.join("\n");
}

function firstUsefulLine(content: string): string {
  const line = content.split(/\r?\n/u).map((value) => value.trim()).find(Boolean) ?? "Markdown source";
  return line.replace(/^#+\s*/u, "").slice(0, 160);
}

function safeRepositorySegment(value: string): string {
  const candidate = basename(value.replace(/\.git$/iu, ""))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return candidate && candidate !== "." && candidate !== ".." ? candidate : "repository";
}

function safeRemoteUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return "repository";
  }
}

function portablePath(path: string): string {
  return relative(".", path).split(sep).join("/");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
