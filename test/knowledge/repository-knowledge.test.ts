import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncRepositoryKnowledge, WorkspaceKnowledge } from "../../src/knowledge/index.js";

describe("repository knowledge sync", () => {
  it("imports safe Markdown snapshots and maintains a deterministic wiki catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "mob-repository-knowledge-"));
    const checkout = join(root, "checkout");
    await mkdir(join(checkout, "docs"), { recursive: true });
    await writeFile(join(checkout, "README.md"), "# Mob Crew\n\nThe main repository guide.\n");
    await writeFile(join(checkout, "docs", "control.md"), "# External control\n\nUse the Mob CLI.\n");
    await writeFile(join(checkout, "docs", "ignored.bin"), Buffer.from([0, 1, 2]));
    await symlink("/etc/passwd", join(checkout, "docs", "escape.md"));
    const knowledge = new WorkspaceKnowledge({ rootDirectory: join(root, "knowledge") });

    const first = await syncRepositoryKnowledge({
      checkoutDirectory: checkout,
      repositoryName: "mob-agent-crew",
      remoteUrl: "https://github.com/cdotlock/mob-agent-crew",
      revision: "a".repeat(40),
      knowledge,
    });
    const second = await syncRepositoryKnowledge({
      checkoutDirectory: checkout,
      repositoryName: "mob-agent-crew",
      remoteUrl: "https://github.com/cdotlock/mob-agent-crew",
      revision: "a".repeat(40),
      knowledge,
    });

    expect(second.snapshot).toBe(first.snapshot);
    expect(first.documents).toBe(2);
    expect(first.rawPaths).toHaveLength(2);
    const wiki = await knowledge.read(first.wikiPath);
    expect(wiki.content).toContain("README.md");
    expect(wiki.content).toContain("docs/control.md");
    expect(wiki.content).not.toContain("escape.md");
    expect(await knowledge.search("External control Mob CLI")).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: expect.stringContaining("control.md") })]),
    );
  });

  it("rejects a symbolic-link checkout root", async () => {
    const root = await mkdtemp(join(tmpdir(), "mob-repository-knowledge-link-"));
    const target = join(root, "target");
    const checkout = join(root, "checkout");
    await mkdir(target);
    await writeFile(join(target, "README.md"), "# Outside\n");
    await symlink(target, checkout);

    await expect(syncRepositoryKnowledge({
      checkoutDirectory: checkout,
      repositoryName: "mob-agent-crew",
      remoteUrl: "https://github.com/cdotlock/mob-agent-crew",
      revision: "a".repeat(40),
      knowledge: new WorkspaceKnowledge({ rootDirectory: join(root, "knowledge") }),
    })).rejects.toThrow("real directory");
  });
});
