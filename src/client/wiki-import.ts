import { lstat, readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import type { MobApiClient } from "./api.js";

export type WikiImportArea = "raw" | "wiki";

export interface WikiDirectoryImportResult {
  readonly area: WikiImportArea;
  readonly directory: string;
  readonly imported: readonly string[];
}

type KnowledgeWriteClient = Pick<MobApiClient, "request">;

/**
 * Import Markdown from one local directory without crossing symlinks or hidden
 * paths. Uploads are deliberately sequential so a failure identifies the
 * precise prefix already accepted by the server.
 */
export async function importWikiDirectory(
  client: KnowledgeWriteClient,
  directory: string,
  area: WikiImportArea,
): Promise<WikiDirectoryImportResult> {
  if (area !== "raw" && area !== "wiki") {
    throw new Error("Wiki import area must be 'raw' or 'wiki'");
  }
  const root = resolve(directory);
  const rootInfo = await lstat(root).catch((error: unknown) => {
    throw new Error(`Cannot open Wiki import directory '${root}': ${errorMessage(error)}`);
  });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`Wiki import root must be a real directory, not a file or symbolic link: ${root}`);
  }

  const files = await discoverMarkdownFiles(root);
  if (files.length === 0) {
    throw new Error(`No Markdown files were found in '${root}'`);
  }

  const imported: string[] = [];
  for (const absolutePath of files) {
    const knowledgePath = portableRelativePath(root, absolutePath);
    try {
      const content = await readFile(absolutePath, "utf8");
      await client.request(`/api/knowledge/${area}`, {
        method: "POST",
        body: {
          path: knowledgePath,
          content,
          source: `cli:import-dir:${knowledgePath}`,
          metadata: { importedRelativePath: knowledgePath },
        },
      });
      imported.push(knowledgePath);
    } catch (error) {
      throw new Error(
        `Wiki import failed for '${knowledgePath}' after ${imported.length}/${files.length} files: ${errorMessage(error)}`,
      );
    }
  }

  return { area, directory: root, imported };
}

export async function discoverMarkdownFiles(directory: string): Promise<string[]> {
  const results: string[] = [];

  async function visit(currentDirectory: string): Promise<void> {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const path = resolve(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && isMarkdownPath(entry.name)) {
        results.push(path);
      }
    }
  }

  await visit(directory);
  return results.sort((left, right) => left.localeCompare(right));
}

function portableRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function isMarkdownPath(path: string): boolean {
  return [".md", ".markdown"].includes(extname(path).toLowerCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
