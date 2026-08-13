import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentGitEnvironment,
  controlGitDirectory,
  materializeGitWorkspace,
  materializedBaseCommitPath,
  readMaterializedBaseCommit,
} from "../../src/workspace/materialize.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  delete process.env.GH_TOKEN;
  delete process.env.MOB_AI_KEY;
  delete process.env.MOB_AGENT_UID;
  delete process.env.MOB_AGENT_GID;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("task workspace materialization", () => {
  it("refreshes a clean Agent checkout from a distinct root-only control clone", async () => {
    const setup = await repositoryFixture("clean");
    const first = await materializeGitWorkspace(setup.input);
    await commitFile(setup.source, "README.md", "# Updated repository\n", "update");
    const second = await materializeGitWorkspace(setup.input);

    expect(second.refreshed).toBe(true);
    expect(second.baseCommit).not.toBe(first.baseCommit);
    expect(await readFile(join(setup.target, "README.md"), "utf8")).toBe("# Updated repository\n");
    expect(await readMaterializedBaseCommit(setup.control)).toBe(second.baseCommit);
    expect((await stat(setup.control)).mode & 0o777).toBe(0o700);
    await expect(stat(controlGitDirectory(setup.control))).resolves.toBeDefined();
  });

  it("preserves a dirty checkout and its exact original base marker", async () => {
    const setup = await repositoryFixture("dirty");
    const first = await materializeGitWorkspace(setup.input);
    await writeFile(join(setup.target, "README.md"), "# Agent work\n");
    await commitFile(setup.source, "README.md", "# Remote update\n", "remote");

    const second = await materializeGitWorkspace(setup.input);

    expect(second).toEqual({ baseCommit: first.baseCommit, refreshed: false });
    expect(await readMaterializedBaseCommit(setup.control)).toBe(first.baseCommit);
    expect(await readFile(join(setup.target, "README.md"), "utf8")).toBe("# Agent work\n");
  });

  it("preserves a task checkout when refreshing the control clone fails", async () => {
    const setup = await repositoryFixture("fetch-failure");
    await materializeGitWorkspace(setup.input);
    await rm(setup.source, { recursive: true, force: true });

    await expect(materializeGitWorkspace(setup.input)).rejects.toThrow("Repository update failed");
    await expect(readFile(join(setup.target, "README.md"), "utf8"))
      .resolves.toBe("# Original\n");
  });

  it("does not execute malicious task Git config or expose control-plane tokens", async () => {
    const setup = await repositoryFixture("malicious-config");
    await materializeGitWorkspace(setup.input);
    const capture = join(setup.root, "captured-environment");
    const malicious = join(setup.root, "malicious.sh");
    await writeFile(malicious, `#!/bin/sh\nenv > ${capture}\ncat\n`);
    await chmod(malicious, 0o755);
    await execFileAsync("git", ["-C", setup.target, "config", "core.fsmonitor", malicious]);
    await execFileAsync("git", ["-C", setup.target, "config", "filter.evil.clean", malicious]);
    await writeFile(join(setup.target, ".gitattributes"), "README.md filter=evil\n");
    process.env.GH_TOKEN = "github-control-secret";
    process.env.MOB_AI_KEY = "mob-control-secret";

    const result = await materializeGitWorkspace(setup.input);

    expect(result.refreshed).toBe(false);
    await expect(readFile(capture, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(agentGitEnvironment(process.env)).not.toHaveProperty("GH_TOKEN");
    expect(agentGitEnvironment(process.env)).not.toHaveProperty("MOB_AI_KEY");
  });

  it("rebuilds a clean checkout even when its local .git config is malicious", async () => {
    const setup = await repositoryFixture("malicious-clean");
    const first = await materializeGitWorkspace(setup.input);
    const capture = join(setup.root, "hook-ran");
    const malicious = join(setup.root, "malicious.sh");
    await writeFile(malicious, `#!/bin/sh\ntouch ${capture}\ncat\n`);
    await chmod(malicious, 0o755);
    await execFileAsync("git", ["-C", setup.target, "config", "core.fsmonitor", malicious]);
    await writeFile(join(setup.source, "SECOND.md"), "remote\n");
    await execFileAsync("git", ["-C", setup.source, "add", "SECOND.md"]);
    await execFileAsync("git", ["-C", setup.source, "commit", "-m", "second"]);

    const second = await materializeGitWorkspace(setup.input);

    expect(second.baseCommit).not.toBe(first.baseCommit);
    expect(second.refreshed).toBe(true);
    await expect(readFile(capture, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(setup.target, "SECOND.md"), "utf8")).resolves.toBe("remote\n");
  });

  it("keeps the base marker outside the Agent checkout", async () => {
    const setup = await repositoryFixture("marker");
    await materializeGitWorkspace(setup.input);
    const status = await execFileAsync("git", ["-C", setup.target, "status", "--porcelain=v1"]);
    expect(status.stdout).toBe("");
    expect(materializedBaseCommitPath(setup.control).startsWith(setup.target)).toBe(false);
  });

  it("runs task Git as the configured OS identity under a traversal-only parent", async () => {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const gid = typeof process.getgid === "function" ? process.getgid() : 0;
    if (uid <= 0 || gid <= 0) return;
    process.env.MOB_AGENT_UID = String(uid);
    process.env.MOB_AGENT_GID = String(gid);
    const setup = await repositoryFixture("identity");

    await materializeGitWorkspace(setup.input);

    expect((await stat(join(setup.target, ".."))).mode & 0o777).toBe(0o711);
    const status = await execFileAsync("git", ["-C", setup.target, "status", "--porcelain=v1"]);
    expect(status.stdout).toBe("");
  });

  it("migrates a legacy clean checkout without running Git as the Agent identity", async () => {
    const setup = await repositoryFixture("legacy");
    await execFileAsync("git", ["clone", "--", setup.source, setup.target]);

    const result = await materializeGitWorkspace(setup.input);

    expect(result.refreshed).toBe(true);
    expect(await readMaterializedBaseCommit(setup.control)).toBe(result.baseCommit);
  });

  it("ignores nested .git metadata but does not follow directory symlinks", async () => {
    const setup = await repositoryFixture("nested-git");
    const first = await materializeGitWorkspace(setup.input);
    await mkdir(join(setup.target, "nested", ".git"), { recursive: true });
    await writeFile(join(setup.target, "nested", ".git", "config"), "malicious metadata\n");
    const nestedOnly = await materializeGitWorkspace(setup.input);
    expect(nestedOnly.baseCommit).toBe(first.baseCommit);
    expect(nestedOnly.refreshed).toBe(true);

    await symlink(setup.source, join(setup.target, "escape"));
    const withSymlink = await materializeGitWorkspace(setup.input);
    expect(withSymlink.refreshed).toBe(false);
  });

  it("rejects a persisted symbolic-link task root without touching its target", async () => {
    const setup = await repositoryFixture("task-root-link");
    await mkdir(join(setup.target, ".."), { recursive: true });
    await symlink(setup.source, setup.target);

    await expect(materializeGitWorkspace(setup.input)).rejects.toThrow(
      "Task workspace must be a real directory",
    );
    await expect(readFile(join(setup.source, "README.md"), "utf8")).resolves.toBe("# Original\n");
  });
});

async function repositoryFixture(label: string) {
  const root = await mkdtemp(join(tmpdir(), `mob-workspace-${label}-`));
  directories.push(root);
  const source = join(root, "source");
  const target = join(root, "tasks", "task-1");
  const control = join(root, "control", "tasks", "task-1");
  await execFileAsync("git", ["init", "--initial-branch=main", source]);
  await execFileAsync("git", ["-C", source, "config", "user.name", "Mob Test"]);
  await execFileAsync("git", ["-C", source, "config", "user.email", "mob@example.test"]);
  await commitFile(source, "README.md", "# Original\n", "initial");
  return {
    root,
    source,
    target,
    control,
    input: { taskDirectory: target, controlDirectory: control, remoteUrl: source, baseRevision: "main" },
  };
}

async function commitFile(source: string, path: string, contents: string, message: string): Promise<void> {
  await writeFile(join(source, path), contents);
  await execFileAsync("git", ["-C", source, "add", path]);
  await execFileAsync("git", ["-C", source, "commit", "-m", message]);
}
