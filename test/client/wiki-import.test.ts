import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobApiClient, MobApiRequestOptions } from "../../src/client/api.js";
import {
  discoverMarkdownFiles,
  importWikiDirectory,
} from "../../src/client/wiki-import.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Wiki directory import", () => {
  it("uploads visible Markdown sequentially and preserves relative paths", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "nested"));
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, "b.md"), "# B\n");
    await writeFile(join(root, "nested", "a.markdown"), "# A\n");
    await writeFile(join(root, "nested", "ignore.txt"), "ignore\n");
    await writeFile(join(root, ".secret.md"), "secret\n");
    await writeFile(join(root, ".hidden", "inside.md"), "hidden\n");
    await symlink(join(root, "b.md"), join(root, "linked.md"));

    const request = vi.fn(async (_path: string, _options?: MobApiRequestOptions) => ({ ok: true }));
    const result = await importWikiDirectory(
      { request } as unknown as Pick<MobApiClient, "request">,
      root,
      "wiki",
    );

    expect(result).toEqual({
      area: "wiki",
      directory: resolve(root),
      imported: ["b.md", "nested/a.markdown"],
    });
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/api/knowledge/wiki",
      "/api/knowledge/wiki",
    ]);
    expect(request.mock.calls.map(([, options]) => options?.body)).toEqual([
      expect.objectContaining({ path: "b.md", content: "# B\n" }),
      expect.objectContaining({ path: "nested/a.markdown", content: "# A\n" }),
    ]);
  });

  it("stops at the first upload error and names the failed file", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "a.md"), "# A\n");
    await writeFile(join(root, "b.md"), "# B\n");
    await writeFile(join(root, "c.md"), "# C\n");
    const request = vi.fn(async (_path: string, _options?: MobApiRequestOptions) => ({ ok: true }))
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("server rejected the document"));

    await expect(importWikiDirectory(
      { request } as unknown as Pick<MobApiClient, "request">,
      root,
      "raw",
    )).rejects.toThrow("Wiki import failed for 'b.md' after 1/3 files: server rejected the document");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not traverse a symbolic-link root", async () => {
    const parent = await temporaryDirectory();
    const realRoot = join(parent, "real");
    const linkedRoot = join(parent, "linked");
    await mkdir(realRoot);
    await writeFile(join(realRoot, "page.md"), "# Page\n");
    await symlink(realRoot, linkedRoot);

    await expect(discoverMarkdownFiles(realRoot)).resolves.toEqual([join(realRoot, "page.md")]);
    await expect(importWikiDirectory(
      { request: vi.fn() } as unknown as Pick<MobApiClient, "request">,
      linkedRoot,
      "wiki",
    )).rejects.toThrow("must be a real directory");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mob-wiki-import-"));
  temporaryDirectories.push(directory);
  return directory;
}
