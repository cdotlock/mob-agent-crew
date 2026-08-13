import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDefaultAgentDriverRegistry,
  DeepSeekHarnessDriver,
  type AgentEvent,
  writeMobAiProviderConfig,
} from "../../src/agents/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("DeepSeek Harness connector", () => {
  it("registers dsh headless as a one-shot peer connector", () => {
    const registry = createDefaultAgentDriverRegistry();

    expect(registry.has("deepseek")).toBe(true);
    expect(registry.get("deepseek").capabilities).toMatchObject({
      transport: "one-shot",
      steer: false,
      followUp: false,
      nativeCancel: false,
      sessionResume: false,
      completionSignal: "stdout final message + process exit",
    });
  });

  it("passes one positional task, maps MobAI routing, and emits only final-text lifecycle events", async () => {
    const fixture = await createFakeDsh("complete");
    await writeMobAiProviderConfig({
      directory: fixture.profileDirectory,
      baseUrl: "http://127.0.0.1:4310/api/provider",
      model: "deepseek-v4-pro",
    });
    const prompt = "inspect this repository";
    const driver = new DeepSeekHarnessDriver({
      command: fixture.command,
      env: { FAKE_CAPTURE_PATH: fixture.capturePath },
    });
    const run = await driver.run({
      jobId: "job-deepseek",
      attemptId: "attempt-deepseek",
      prompt,
      cwd: fixture.directory,
      profileDirectory: fixture.profileDirectory,
      timeoutMs: 5_000,
      env: {
        MOB_AI_KEY: "run-token",
        MOB_AI_BASE_URL: "http://127.0.0.1:4310/api/provider/",
        MOB_AI_MODEL: "deepseek-v4-pro",
      },
    });

    const eventsPromise = collect(run.events);
    await expect(run.result).resolves.toMatchObject({
      outcome: "completed",
      terminalObserved: true,
      finalMessage: "first line\nsecond line",
    });
    const events = await eventsPromise;
    expect(events.map((event) => event.kind)).toEqual([
      "runtime.started",
      "turn.started",
      "message.completed",
      "turn.completed",
      "process.exited",
    ]);
    expect(events.some((event) => event.kind === "message.delta")).toBe(false);

    const capture = JSON.parse(await readFile(fixture.capturePath, "utf8")) as {
      args: string[];
      stdin: string;
      deepseekApiKey: string;
      deepseekBaseUrl: string;
      patch: string;
    };
    expect(capture.args).toEqual([
      "--profile",
      "headless",
      "--patch",
      join(fixture.profileDirectory, "dsh.cordis.patch.yml"),
      prompt,
    ]);
    expect(capture.stdin).toBe("");
    expect(capture.deepseekApiKey).toBe("run-token");
    expect(capture.deepseekBaseUrl).toBe("http://127.0.0.1:4310/api/provider/v1");
    expect(capture.patch).toContain('model: "deepseek-v4-pro"');
  });

  it("uses stderr and a non-zero exit as the authoritative failed terminal", async () => {
    const fixture = await createFakeDsh("fail");
    const driver = new DeepSeekHarnessDriver({
      command: fixture.command,
      env: { FAKE_CAPTURE_PATH: fixture.capturePath },
    });
    const run = await driver.run({
      jobId: "job-deepseek-fail",
      attemptId: "attempt-deepseek-fail",
      prompt: "fail",
      cwd: fixture.directory,
      timeoutMs: 5_000,
    });

    const eventsPromise = collect(run.events);
    await expect(run.result).resolves.toMatchObject({
      outcome: "failed",
      exitCode: 1,
      terminalObserved: true,
      finalMessage: "partial answer",
      error: "dsh: MODEL_ERROR: provider rejected the request",
    });
    const events = await eventsPromise;
    expect(events.map((event) => event.kind)).toEqual([
      "runtime.started",
      "turn.started",
      "warning",
      "message.completed",
      "turn.failed",
      "process.exited",
    ]);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function createFakeDsh(mode: "complete" | "fail"): Promise<{
  directory: string;
  profileDirectory: string;
  command: string;
  capturePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "mob-deepseek-driver-"));
  directories.push(directory);
  const profileDirectory = join(directory, "profile");
  const command = join(directory, "fake-dsh.mjs");
  const capturePath = join(directory, "capture.json");
  const script = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const patchIndex = args.indexOf("--patch");
  writeFileSync(process.env.FAKE_CAPTURE_PATH, JSON.stringify({
    args,
    stdin: Buffer.concat(chunks).toString("utf8"),
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
    deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL,
    patch: patchIndex === -1 ? "" : readFileSync(args[patchIndex + 1], "utf8"),
  }));
  if (${JSON.stringify(mode)} === "complete") {
    process.stdout.write("first line\\nsecond line\\n");
    return;
  }
  process.stdout.write("partial answer\\n");
  process.stderr.write("dsh: MODEL_ERROR: provider rejected the request\\n");
  process.exitCode = 1;
});
process.stdin.resume();
`;
  await writeFile(command, script, { mode: 0o700 });
  await chmod(command, 0o700);
  return { directory, profileDirectory, command, capturePath };
}
