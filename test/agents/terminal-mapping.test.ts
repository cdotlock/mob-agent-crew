import { describe, expect, it } from "vitest";
import {
  mapClaudeEvent,
  mapCodexEvent,
  mapOmpEvent,
  mapPiEvent,
} from "../../src/agents/index.js";

describe("native terminal event mapping", () => {
  it("uses Codex turn completion/failure, not ordinary stream errors, as terminal", () => {
    expect(mapCodexEvent({ type: "error", message: "retrying" }).terminal).toBeUndefined();
    expect(mapCodexEvent({ type: "turn.completed", usage: { input_tokens: 3 } })).toMatchObject({
      terminal: { outcome: "completed" },
      events: [{ kind: "turn.completed" }],
    });
    expect(
      mapCodexEvent({ type: "turn.failed", error: { message: "bad turn" } }),
    ).toMatchObject({
      terminal: { outcome: "failed", error: "bad turn" },
      events: [{ kind: "turn.failed" }],
    });
  });

  it("treats Claude result as terminal and preserves success/error", () => {
    expect(
      mapClaudeEvent({
        type: "result",
        subtype: "success",
        result: "done",
        session_id: "session-1",
      }),
    ).toMatchObject({
      terminal: {
        outcome: "completed",
        finalMessage: "done",
        sessionId: "session-1",
      },
    });
    expect(
      mapClaudeEvent({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        result: "limit reached",
      }).terminal,
    ).toEqual({ outcome: "failed", error: "limit reached" });
  });

  it("does not mistake Pi agent_end or an RPC ack for completion", () => {
    expect(mapPiEvent({ type: "response", id: "1", success: true }).terminal).toBeUndefined();
    expect(mapPiEvent({ type: "agent_end" }).terminal).toBeUndefined();
    expect(
      mapPiEvent({
        type: "agent_settled",
        messages: [{ role: "assistant", content: "settled output" }],
      }),
    ).toMatchObject({
      terminal: { outcome: "completed", finalMessage: "settled output" },
      events: [{ kind: "turn.completed" }],
    });
  });

  it("requires a terminal OMP agent_end", () => {
    expect(mapOmpEvent({ type: "agent_end", isTerminal: false }).terminal).toBeUndefined();
    expect(
      mapOmpEvent({
        type: "agent_end",
        isTerminal: true,
        messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
      }).terminal,
    ).toEqual({ outcome: "completed", finalMessage: "ok" });
    expect(
      mapOmpEvent({
        type: "response",
        id: "local-1",
        command: "prompt",
        success: true,
        data: { agentInvoked: false },
      }),
    ).toMatchObject({
      terminal: { outcome: "completed" },
      events: [
        { kind: "command.accepted" },
        { kind: "turn.completed", nativeType: "prompt.local_only" },
      ],
    });
  });
});
