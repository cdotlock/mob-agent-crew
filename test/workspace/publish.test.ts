import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertGitHubPublishRemote,
  publishTaskBranch,
} from "../../src/workspace/publish.js";
import { materializeGitWorkspace } from "../../src/workspace/materialize.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("human-approved task publication", () => {
  it("commits Agent work on a new branch and pushes it to the explicit remote", async () => {
    const fixture = await repositoryFixture();
    await writeFile(join(fixture.checkout, "README.md"), "# Human-reviewed Agent change\n");

    const result = await publishTaskBranch({
      taskDirectory: fixture.checkout,
      controlDirectory: fixture.control,
      remoteUrl: fixture.remote,
      branchName: "mob/task-12345678",
      commitMessage: "mob: publish reviewed task",
      authorName: "Mob Human",
      authorEmail: "mob@example.test",
    });

    expect(result.branch).toBe("mob/task-12345678");
    expect(result.changedFiles).toEqual(["README.md"]);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/u);
    const published = await execFileAsync("git", [
      "--git-dir", fixture.remote,
      "show", "refs/heads/mob/task-12345678:README.md",
    ]);
    expect(published.stdout).toBe("# Human-reviewed Agent change\n");
  });

  it("rejects unsafe branch refs before changing the checkout", async () => {
    const fixture = await repositoryFixture();
    await writeFile(join(fixture.checkout, "README.md"), "changed\n");

    await expect(publishTaskBranch({
      taskDirectory: fixture.checkout,
      controlDirectory: fixture.control,
      remoteUrl: fixture.remote,
      branchName: "--force",
      commitMessage: "unsafe",
      authorName: "Mob Human",
      authorEmail: "mob@example.test",
    })).rejects.toThrow("safe Git branch");
    expect((await execFileAsync("git", ["-C", fixture.checkout, "branch", "--show-current"])).stdout.trim()).toBe("main");
  });

  it.each([".env", "config/private.pem", ".ssh/id_ed25519", ".github/token.json"])(
    "refuses to publish a secret-shaped filename: %s",
    async (filename) => {
      const fixture = await repositoryFixture();
      const path = join(fixture.checkout, filename);
      await import("node:fs/promises").then(({ mkdir }) => mkdir(join(path, ".."), { recursive: true }));
      await writeFile(path, "not-for-source-control\n");

      await expect(publishTaskBranch({
        taskDirectory: fixture.checkout,
        controlDirectory: fixture.control,
        remoteUrl: fixture.remote,
        branchName: "mob/secret-check",
        commitMessage: "must not publish",
        authorName: "Mob Human",
        authorEmail: "mob@example.test",
      })).rejects.toThrow("secret-shaped");
      expect(
        (await execFileAsync("git", ["-C", fixture.checkout, "branch", "--show-current"])).stdout.trim(),
      ).toBe("main");
      expect(
        (await execFileAsync("git", ["-C", fixture.checkout, "diff", "--cached", "--name-only"])).stdout,
      ).toBe("");
    },
  );

  it("never executes Agent-controlled Git hooks or config while publishing", async () => {
    const fixture = await repositoryFixture();
    const marker = join(fixture.root, "agent-hook-executed");
    const hook = join(fixture.checkout, ".git", "hooks", "pre-push");
    await mkdir(join(fixture.checkout, ".git", "hooks"), { recursive: true });
    await writeFile(hook, `#!/bin/sh\nprintf compromised > '${marker}'\n`);
    await chmod(hook, 0o755);
    await execFileAsync("git", [
      "-C", fixture.checkout, "config", "core.fsmonitor", hook,
    ]);
    await writeFile(join(fixture.checkout, "README.md"), "safe reviewed change\n");

    await publishTaskBranch({
      taskDirectory: fixture.checkout,
      controlDirectory: fixture.control,
      remoteUrl: fixture.remote,
      branchName: "mob/untrusted-git-metadata",
      commitMessage: "publish without trusting Agent Git metadata",
      authorName: "Mob Human",
      authorEmail: "mob@example.test",
    });

    await expect(access(marker)).rejects.toThrow();
  });

  it("rejects secret-shaped content in an ordinary source filename", async () => {
    const fixture = await repositoryFixture();
    await writeFile(join(fixture.checkout, "notes.md"), `accidental: ${"sk-"}${"a".repeat(32)}\n`);

    await expect(publishTaskBranch({
      taskDirectory: fixture.checkout,
      controlDirectory: fixture.control,
      remoteUrl: fixture.remote,
      branchName: "mob/secret-content",
      commitMessage: "must not publish",
      authorName: "Mob Human",
      authorEmail: "mob@example.test",
    })).rejects.toThrow("secret-shaped content");
  });

  it("rejects Mob's signed two-part run bearer in ordinary source", async () => {
    const fixture = await repositoryFixture();
    const payload = Buffer.from(JSON.stringify({
      kind: "run",
      actorId: "00000000-0000-4000-8000-000000000001",
      workspaceId: "00000000-0000-4000-8000-000000000002",
      runId: "00000000-0000-4000-8000-000000000003",
      taskId: "00000000-0000-4000-8000-000000000004",
    }), "utf8").toString("base64url");
    const runBearer = `${payload}.${"a".repeat(43)}`;
    await writeFile(join(fixture.checkout, "notes.md"), `runtime=${runBearer}\n`);

    await expect(publishTaskBranch({
      taskDirectory: fixture.checkout,
      controlDirectory: fixture.control,
      remoteUrl: fixture.remote,
      branchName: "mob/run-bearer-check",
      commitMessage: "must not publish",
      authorName: "Mob Human",
      authorEmail: "mob@example.test",
    })).rejects.toThrow("secret-shaped content");
  });

  it("accepts only canonical HTTPS GitHub remotes at the server boundary", () => {
    expect(() => assertGitHubPublishRemote("https://github.com/cdotlock/mob-agent-crew")).not.toThrow();
    expect(() => assertGitHubPublishRemote("git@github.com:cdotlock/mob-agent-crew.git")).toThrow("HTTPS GitHub");
    expect(() => assertGitHubPublishRemote("https://example.com/cdotlock/mob-agent-crew")).toThrow("HTTPS GitHub");
  });
});

async function repositoryFixture(): Promise<{
  root: string;
  source: string;
  remote: string;
  checkout: string;
  control: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "mob-publish-"));
  directories.push(root);
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const checkout = join(root, "checkout");
  const control = join(root, "control", "tasks", "publish-fixture");
  await execFileAsync("git", ["init", "--initial-branch=main", source]);
  await writeFile(join(source, "README.md"), "# Initial\n");
  await execFileAsync("git", ["-C", source, "add", "README.md"]);
  await execFileAsync("git", [
    "-C", source,
    "-c", "user.name=Mob Test",
    "-c", "user.email=mob@example.test",
    "commit", "-m", "initial",
  ]);
  await execFileAsync("git", ["clone", "--bare", source, remote]);
  await materializeGitWorkspace({
    taskDirectory: checkout,
    controlDirectory: control,
    remoteUrl: remote,
    baseRevision: "main",
  });
  return { root, source, remote, checkout, control };
}
