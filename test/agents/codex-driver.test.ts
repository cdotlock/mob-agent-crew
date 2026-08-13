import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexExecDriver,
  type AgentEvent,
} from "../../src/agents/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("Codex exec connector", () => {
  it("closes stdin after passing the prompt argument", async () => {
    const fixture = await createFakeCodex();
    const prompt = "inspect this repository";
    const driver = new CodexExecDriver({
      command: fixture.command,
      env: { FAKE_CAPTURE_PATH: fixture.capturePath },
    });
    const run = await driver.run({
      jobId: "job-codex",
      attemptId: "attempt-codex",
      prompt,
      cwd: fixture.directory,
      timeoutMs: 1_000,
    });

    const eventsPromise = collect(run.events);
    await expect(run.result).resolves.toMatchObject({
      outcome: "completed",
      terminalObserved: true,
      finalMessage: "done",
      sessionId: "thread-1",
    });
    const events = await eventsPromise;
    expect(events.map((event) => event.kind)).toEqual([
      "runtime.started",
      "runtime.ready",
      "turn.started",
      "message.completed",
      "turn.completed",
      "process.exited",
    ]);

    const capture = JSON.parse(await readFile(fixture.capturePath, "utf8")) as {
      args: string[];
      stdin: string;
    };
    expect(capture.stdin).toBe("");
    expect(capture.args.filter((value) => value === prompt)).toHaveLength(1);
    expect(capture.args.slice(-1)).toEqual([prompt]);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function createFakeCodex(): Promise<{
  directory: string;
  command: string;
  capturePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "mob-codex-driver-"));
  directories.push(directory);
  const command = join(directory, "fake-codex.mjs");
  const capturePath = join(directory, "capture.json");
  const script = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  writeFileSync(process.env.FAKE_CAPTURE_PATH, JSON.stringify({
    args: process.argv.slice(2),
    stdin: Buffer.concat(chunks).toString("utf8"),
  }));
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  send({ type: "thread.started", thread_id: "thread-1" });
  send({ type: "turn.started" });
  send({ type: "item.completed", item: { type: "agent_message", text: "done" } });
  send({ type: "turn.completed", usage: { input_tokens: 1 } });
});
process.stdin.resume();
`;
  await writeFile(command, script, { mode: 0o700 });
  await chmod(command, 0o700);
  return { directory, command, capturePath };
}
