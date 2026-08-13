import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceKnowledge } from "../../src/knowledge/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; knowledge: WorkspaceKnowledge }> {
  const root = await mkdtemp(join(tmpdir(), "mob-knowledge-"));
  directories.push(root);
  return { root, knowledge: new WorkspaceKnowledge({ rootDirectory: join(root, "knowledge") }) };
}

describe("WorkspaceKnowledge", () => {
  it("creates the file-native workspace layout and keeps raw inputs immutable", async () => {
    const { root, knowledge } = await fixture();
    const first = await knowledge.writeRaw({
      path: "imports/architecture.md",
      content: "# Architecture\r\n\r\nOne small server.\r\n",
      source: "upload:architecture.md",
    });
    const retry = await knowledge.writeRaw({
      path: "imports/architecture.md",
      content: "# Architecture\n\nOne small server.",
      source: "upload:architecture.md",
    });

    expect(first.content).toBe("# Architecture\n\nOne small server.");
    expect(retry.revision).toBe(first.revision);
    await expect(
      knowledge.writeRaw({ path: "imports/architecture.md", content: "# Replaced" }),
    ).rejects.toThrow("immutable");
    await expect(readFile(join(root, "knowledge/manifests/catalog.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await knowledge.rebuildIndex();
    const catalog = JSON.parse(await readFile(join(root, "knowledge/manifests/catalog.json"), "utf8")) as {
      documents: Array<{ path: string }>;
    };
    expect(catalog.documents.map((document) => document.path)).toEqual(["raw/imports/architecture.md"]);
  });

  it("allows curated wiki updates and exposes one list/read API for both areas", async () => {
    const { knowledge } = await fixture();
    await knowledge.writeRaw({ path: "meeting.md", content: "# Meeting\n\nUnedited notes" });
    await knowledge.writeWiki({ path: "system/runtime.md", content: "# Runtime\n\nVersion one" });
    const updated = await knowledge.writeWiki({ path: "system/runtime.md", content: "# Runtime\n\nVersion two" });

    expect(updated.content).toContain("Version two");
    expect((await knowledge.read("wiki/system/runtime.md")).content).toContain("Version two");
    expect((await knowledge.list()).map((entry) => entry.path)).toEqual([
      "raw/meeting.md",
      "wiki/system/runtime.md",
    ]);
    expect((await knowledge.list("wiki")).map((entry) => entry.title)).toEqual(["Runtime"]);
  });

  it("rejects traversal, absolute paths, hidden segments, and source symlinks", async () => {
    const { root, knowledge } = await fixture();
    await knowledge.initialize();

    await expect(knowledge.writeRaw({ path: "../escape.md", content: "no" })).rejects.toThrow("unsafe");
    await expect(knowledge.writeRaw({ path: "/tmp/escape.md", content: "no" })).rejects.toThrow("relative");
    await expect(knowledge.writeWiki({ path: ".private/secret.md", content: "no" })).rejects.toThrow("unsafe");

    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.md"), "# Secret\n");
    await symlink(outside, join(root, "knowledge/raw/linked"));
    await expect(knowledge.read("raw/linked/secret.md")).rejects.toThrow("outside");
    await expect(knowledge.list()).rejects.toThrow("Symlinks");
  });

  it("rejects a managed area replaced with a symlink", async () => {
    const { root, knowledge } = await fixture();
    await knowledge.initialize();
    const outside = join(root, "outside-area");
    await mkdir(outside);
    await rm(join(root, "knowledge/wiki"), { recursive: true });
    await symlink(outside, join(root, "knowledge/wiki"));

    await expect(knowledge.writeWiki({ path: "escape.md", content: "# Escape" })).rejects.toThrow(
      "must not be a symlink",
    );
  });

  it("searches English and Chinese Markdown with explainable, revision-bound results", async () => {
    const { knowledge } = await fixture();
    await knowledge.writeRaw({
      path: "inputs/notes.md",
      content: "# 杂项记录\n\n讨论一些服务器问题和普通操作。",
    });
    await knowledge.writeWiki({
      path: "architecture/knowledge.md",
      content: "# 自动化知识库\n\nAgent 会按任务关键词读取合适的知识，并保留上下文清单。",
    });
    await knowledge.writeWiki({
      path: "architecture/runtime.md",
      content: "# Runtime architecture\n\nThe embedded worker runs on one small server.",
    });

    const chinese = await knowledge.search("自动知识", { topK: 2 });
    expect(chinese[0]).toMatchObject({
      path: "wiki/architecture/knowledge.md",
      title: "自动化知识库",
    });
    expect(chinese[0]?.revision).toMatch(/^[a-f0-9]{64}$/u);
    expect(chinese[0]?.reason).toContain("matched");

    const english = await knowledge.search("embedded worker");
    expect(english[0]?.path).toBe("wiki/architecture/runtime.md");
    expect(english[0]?.excerpt).toContain("embedded worker");
  });

  it("retrieves within a strict character budget and persists a context manifest", async () => {
    const { root, knowledge } = await fixture();
    await knowledge.writeWiki({
      path: "agents/collaboration.md",
      content: `# Agent collaboration\n\n${"Agents share task messages and immutable artifacts. ".repeat(30)}`,
    });
    await knowledge.writeWiki({
      path: "agents/delegation.md",
      content: `# Delegation\n\n${"Agents delegate bounded work to other agents. ".repeat(30)}`,
    });

    const retrieval = await knowledge.retrieve("agents work", { topK: 2, charBudget: 180 });

    expect(retrieval.context.length).toBeLessThanOrEqual(180);
    expect(retrieval.manifest.characters).toBe(retrieval.context.length);
    expect(retrieval.manifest.entries).toHaveLength(retrieval.items.length);
    expect(retrieval.manifest.entries[0]?.revision).toBe(retrieval.items[0]?.revision);
    expect(retrieval.manifestPath).toMatch(/^manifests\/contexts\/[a-f0-9]{24}\.json$/u);
    const stored = JSON.parse(
      await readFile(join(root, "knowledge", retrieval.manifestPath), "utf8"),
    ) as { id: string };
    expect(stored.id).toBe(retrieval.manifest.id);
  });

  it("detects direct file changes, rebuilds disposable cache, and lints bad source files", async () => {
    const { root, knowledge } = await fixture();
    await knowledge.initialize();
    const wiki = join(root, "knowledge/wiki");
    await writeFile(join(wiki, "direct.md"), "# Direct\n\nFirst unique phrase");
    expect((await knowledge.search("first unique"))[0]?.path).toBe("wiki/direct.md");

    await writeFile(join(wiki, "direct.md"), "# Direct\n\nSecond replacement phrase with more bytes");
    expect(await knowledge.search("first unique")).toEqual([]);
    expect((await knowledge.search("second replacement"))[0]?.path).toBe("wiki/direct.md");

    await writeFile(join(wiki, "ignored.txt"), "not markdown");
    await writeFile(join(wiki, "empty.md"), "  \n");
    const report = await knowledge.lint();
    expect(report.ok).toBe(false);
    expect(report.checked).toBe(3);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unsupported_file", path: "wiki/ignored.txt" }),
        expect.objectContaining({ code: "empty", path: "wiki/empty.md", severity: "warning" }),
      ]),
    );
  });
});
