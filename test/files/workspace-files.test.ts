import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceFileBrowser } from "../../src/files/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WorkspaceFileBrowser", () => {
  it("lists Mob state and reads a text file", async () => {
    const root = await fixture();
    const browser = new WorkspaceFileBrowser({ dataDir: root });
    const listing = await browser.list({ scope: "workspace", workspaceId: "workspace-1" });
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      "knowledge",
      "binary.dat",
      "invalid-utf8.txt",
      "large.txt",
      "workspace.json",
    ]);

    const document = await browser.read({
      scope: "workspace",
      workspaceId: "workspace-1",
      path: "knowledge/wiki/overview.md",
    });
    expect(document).toMatchObject({ language: "markdown", content: "# Overview\n", truncated: false });
  });

  it("hides repository credentials and generated dependency trees", async () => {
    const root = await fixture();
    const browser = new WorkspaceFileBrowser({ dataDir: root });
    const listing = await browser.list({ scope: "repository", workspaceId: "workspace-1", taskId: "task-1" });
    expect(listing.entries.map((entry) => entry.name)).toEqual(["src", "README.md"]);
    await expect(browser.read({
      scope: "repository",
      workspaceId: "workspace-1",
      taskId: "task-1",
      path: ".env",
    })).rejects.toThrow("private");
  });

  it("rejects traversal, symlinks, and binary content", async () => {
    const root = await fixture();
    const browser = new WorkspaceFileBrowser({ dataDir: root });
    await expect(browser.read({ scope: "workspace", workspaceId: "workspace-1", path: "../secret" })).rejects.toThrow("unsafe");
    await expect(browser.read({ scope: "workspace", workspaceId: "workspace-1", path: "binary.dat" })).rejects.toThrow("Binary");
    await expect(browser.read({ scope: "workspace", workspaceId: "workspace-1", path: "invalid-utf8.txt" })).rejects.toThrow("non-UTF-8");
    await expect(browser.read({ scope: "workspace", workspaceId: "workspace-1", path: "escape.md" })).rejects.toThrow("Symbolic links");
  });

  it("returns an explicit truncated preview for oversized text", async () => {
    const root = await fixture();
    const browser = new WorkspaceFileBrowser({ dataDir: root, maxReadBytes: 8 });
    const document = await browser.read({
      scope: "workspace",
      workspaceId: "workspace-1",
      path: "large.txt",
    });

    expect(document).toMatchObject({
      bytes: 16,
      content: "01234567",
      truncated: true,
    });
  });

  it("shares short-lived listings across request instances and supports explicit invalidation", async () => {
    const root = await fixture();
    const first = new WorkspaceFileBrowser({ dataDir: root, listingCacheMs: 60_000 });
    const second = new WorkspaceFileBrowser({ dataDir: root, listingCacheMs: 60_000 });
    const input = { scope: "workspace" as const, workspaceId: "workspace-1" };
    await first.list(input);
    await writeFile(join(root, "state/workspaces/workspace-1/new.md"), "# New\n");

    expect((await second.list(input)).entries.some((entry) => entry.name === "new.md")).toBe(false);
    second.invalidate();
    expect((await second.list(input)).entries.some((entry) => entry.name === "new.md")).toBe(true);
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mob-file-browser-"));
  roots.push(root);
  const workspace = join(root, "state/workspaces/workspace-1");
  const repository = join(root, "tasks/task-1");
  await Promise.all([
    mkdir(join(workspace, "knowledge/wiki"), { recursive: true }),
    mkdir(join(repository, "src"), { recursive: true }),
    mkdir(join(repository, "node_modules/pkg"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(workspace, "workspace.json"), "{}\n"),
    writeFile(join(workspace, "knowledge/wiki/overview.md"), "# Overview\n"),
    writeFile(join(workspace, "binary.dat"), Buffer.from([0, 1, 2])),
    writeFile(join(workspace, "invalid-utf8.txt"), Buffer.from([0xc3, 0x28])),
    writeFile(join(workspace, "large.txt"), "0123456789abcdef"),
    writeFile(join(repository, "README.md"), "# Repo\n"),
    writeFile(join(repository, ".env"), "TOKEN=nope\n"),
  ]);
  await symlink(join(repository, "README.md"), join(workspace, "escape.md"));
  return root;
}
