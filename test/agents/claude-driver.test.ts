import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeDriver } from "../../src/agents/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Claude Code connector", () => {
  it("runs non-interactively under Mob's external isolation boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mob-claude-driver-"));
    directories.push(directory);
    const capturePath = join(directory, "capture.json");
    const command = join(directory, "fake-claude.mjs");
    await writeFile(command, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:"done",session_id:"session-1"}) + "\\n");
`, { mode: 0o700 });
    await chmod(command, 0o700);

    const run = await new ClaudeCodeDriver({
      command,
      env: { FAKE_CAPTURE_PATH: capturePath },
    }).run({
      jobId: "job-claude",
      attemptId: "attempt-claude",
      prompt: "inspect",
      cwd: directory,
      timeoutMs: 3_000,
    });

    await expect(run.result).resolves.toMatchObject({
      outcome: "completed",
      finalMessage: "done",
      sessionId: "session-1",
    });
    const args = JSON.parse(await readFile(capturePath, "utf8")) as string[];
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("dontAsk");
  });
});
