import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { materializeGitWorkspace } from "../../src/workspace/materialize.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("task workspace materialization", () => {
  it("shallow clones an allowlisted task source and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "mob-workspace-"));
    directories.push(root);
    const source = join(root, "source");
    const target = join(root, "tasks", "task-1");
    await execFileAsync("git", ["init", "--initial-branch=main", source]);
    await writeFile(join(source, "README.md"), "# Test repository\n");
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", ["-C", source, "-c", "user.name=Mob Test", "-c", "user.email=mob@example.test", "commit", "-m", "initial"]);

    const input = { taskDirectory: target, remoteUrl: source, baseRevision: "main" };
    await materializeGitWorkspace(input);
    await materializeGitWorkspace(input);

    expect(await readFile(join(target, "README.md"), "utf8")).toBe("# Test repository\n");
  });
});
