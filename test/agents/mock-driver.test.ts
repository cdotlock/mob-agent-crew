import { describe, expect, it } from "vitest";
import {
  AgentDriverRegistry,
  MockDriver,
  UnsupportedAgentCapabilityError,
  type AgentEvent,
} from "../../src/agents/index.js";

describe("MockDriver", () => {
  it("streams delegated output through the same AgentRun contract", async () => {
    const driver = new MockDriver({
      delegate: async (input, context) => {
        context.emit({
          kind: "tool.completed",
          nativeType: "mock.delegate",
          data: { delegatedPrompt: input.prompt },
        });
        return {
          finalMessage: `reviewed: ${input.prompt}`,
          data: { artifact: "review.md" },
        };
      },
    });
    const registry = new AgentDriverRegistry([driver]);
    const run = await registry.get("mock").run({
      jobId: "job-1",
      attemptId: "attempt-1",
      prompt: "inspect parser",
      cwd: process.cwd(),
    });
    const eventsPromise = collect(run);
    const result = await run.result;
    const events = await eventsPromise;

    expect(result).toMatchObject({
      outcome: "completed",
      terminalObserved: true,
      finalMessage: "reviewed: inspect parser",
    });
    expect(events.map((event) => event.kind)).toEqual([
      "runtime.started",
      "runtime.ready",
      "turn.started",
      "tool.completed",
      "message.completed",
      "turn.completed",
    ]);
    expect(events.at(-1)?.data).toEqual({ artifact: "review.md" });
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    await expect(
      run.send({ type: "steer", message: "change course" }),
    ).rejects.toBeInstanceOf(UnsupportedAgentCapabilityError);
  });
});

async function collect(source: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}
