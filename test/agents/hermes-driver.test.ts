import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDefaultAgentDriverRegistry,
  HermesDriver,
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

describe("Hermes TUI-gateway connector", () => {
  it("registers Hermes as a peer default driver", () => {
    const registry = createDefaultAgentDriverRegistry();
    expect(registry.has("hermes")).toBe(true);
    expect(registry.get("hermes").capabilities).toMatchObject({
      steer: true,
      followUp: false,
      nativeCancel: true,
    });
  });

  it("creates one session and maps streaming/tool/terminal events", async () => {
    const fixture = await createFakeGateway("complete");
    const driver = new HermesDriver({
      command: fixture.command,
      env: { FAKE_CAPTURE_PATH: fixture.capturePath },
    });
    const run = await driver.run({
      jobId: "job-hermes",
      attemptId: "attempt-hermes",
      prompt: "inspect this repository",
      cwd: fixture.directory,
      env: {
        PI_CODING_AGENT_DIR: join(fixture.directory, "profile"),
        MOB_AI_KEY: "test-key",
      },
    });

    const result = await run.result;
    const events = await collect(run.events);
    expect(result).toMatchObject({
      outcome: "completed",
      terminalObserved: true,
      finalMessage: "done",
      sessionId: "stored-1",
    });
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "runtime.started",
        "runtime.ready",
        "command.accepted",
        "turn.started",
        "tool.started",
        "tool.progress",
        "tool.completed",
        "message.delta",
        "message.completed",
        "usage.updated",
        "turn.completed",
        "process.exited",
      ]),
    );

    const requests = (await readFile(fixture.capturePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(requests.map((request) => request.method)).toEqual([
      "session.create",
      "prompt.submit",
    ]);
    expect(requests[0]).toMatchObject({
      jsonrpc: "2.0",
      params: {
        cwd: fixture.directory,
        source: "tool",
        close_on_disconnect: true,
      },
    });
    expect(requests[1]).toMatchObject({
      params: { session_id: "live-1", text: "inspect this repository" },
    });
  });

  it("uses session.interrupt before the process-group cancellation fallback", async () => {
    const fixture = await createFakeGateway("wait");
    const driver = new HermesDriver({
      command: fixture.command,
      env: { FAKE_CAPTURE_PATH: fixture.capturePath },
      killGraceMs: 500,
    });
    const run = await driver.run({
      jobId: "job-cancel",
      attemptId: "attempt-cancel",
      prompt: "wait",
      cwd: fixture.directory,
    });

    const iterator = run.events[Symbol.asyncIterator]();
    await nextKind(iterator, "command.accepted");
    await run.cancel();
    await expect(run.result).resolves.toMatchObject({ outcome: "cancelled" });

    const requests = (await readFile(fixture.capturePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(requests.map((request) => request.method)).toContain(
      "session.interrupt",
    );
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function nextKind(
  iterator: AsyncIterator<AgentEvent>,
  kind: AgentEvent["kind"],
): Promise<AgentEvent> {
  while (true) {
    const next = await iterator.next();
    if (next.done) throw new Error(`Event stream ended before ${kind}`);
    if (next.value.kind === kind) return next.value;
  }
}

async function createFakeGateway(
  mode: "complete" | "wait",
): Promise<{ directory: string; command: string; capturePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "mob-hermes-driver-"));
  directories.push(directory);
  const command = join(directory, "fake-hermes-gateway.mjs");
  const capturePath = join(directory, "requests.jsonl");
  const script = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const emit = (type, payload = undefined) => send({
  jsonrpc: "2.0",
  method: "event",
  params: { type, session_id: "live-1", ...(payload === undefined ? {} : { payload }) },
});
send({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } });
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(process.env.FAKE_CAPTURE_PATH, JSON.stringify(request) + "\\n");
  if (request.method === "session.create") {
    send({ jsonrpc: "2.0", id: request.id, result: {
      session_id: "live-1",
      stored_session_id: "stored-1",
      info: { model: "deepseek-v4-pro", cwd: request.params.cwd, tools: {}, skills: {} },
    } });
    return;
  }
  if (request.method === "prompt.submit") {
    send({ jsonrpc: "2.0", id: request.id, result: { status: "streaming" } });
    if (${JSON.stringify(mode)} === "complete") {
      emit("message.start");
      emit("tool.start", { tool_id: "tool-1", name: "terminal", args: { command: "pwd" } });
      emit("tool.progress", { tool_id: "tool-1", text: "running" });
      emit("tool.complete", { tool_id: "tool-1", name: "terminal", result: "ok" });
      emit("message.delta", { text: "do" });
      emit("message.delta", { text: "ne" });
      emit("message.complete", { text: "done", status: "complete", usage: { input_tokens: 2 } });
    }
    return;
  }
  if (request.method === "session.interrupt") {
    send({ jsonrpc: "2.0", id: request.id, result: { status: "interrupted" } });
    emit("message.complete", { text: "", status: "interrupted" });
  }
});
`;
  await writeFile(command, script, { mode: 0o700 });
  await chmod(command, 0o700);
  return { directory, command, capturePath };
}
