import { describe, expect, it } from "vitest";
import {
  agentOutputPersistence,
  redactRuntimeError,
  redactRuntimePayload,
  redactedRuntimeError,
} from "../../src/worker/runtime-redaction.js";

const mobAiKey = "mob-123456789012345678901234567890";
const runBearer = "signed-run-bearer-payload.signature";
const leaseToken = "lease-token-that-must-never-be-persisted";
const secrets = [mobAiKey, runBearer, leaseToken];

describe("worker runtime persistence redaction", () => {
  it("redacts secrets recursively from CLI/RPC event payloads", () => {
    const payload = redactRuntimePayload(
      {
        message: `stderr: MOB_AI_KEY=${mobAiKey}`,
        stderr: `Authorization: Bearer ${runBearer}`,
        nested: {
          command: ["mob", "--lease", leaseToken],
          provider: { apiKey: mobAiKey },
        },
      },
      secrets,
    );

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(mobAiKey);
    expect(serialized).not.toContain(runBearer);
    expect(serialized).not.toContain(leaseToken);
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts driver result errors before they become failure messages", () => {
    const message = redactRuntimeError(
      `RPC failed with MOB_RUN_TOKEN=${runBearer}; lease=${leaseToken}; key=${mobAiKey}`,
      secrets,
    );

    expect(message).not.toContain(runBearer);
    expect(message).not.toContain(leaseToken);
    expect(message).not.toContain(mobAiKey);
    expect(message.match(/\[REDACTED\]/gu)?.length).toBeGreaterThanOrEqual(3);
  });

  it("creates a loggable error that contains no configured runtime secret", () => {
    const error = redactedRuntimeError(new Error(`transport rejected ${runBearer}`), secrets);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("transport rejected [REDACTED]");
    expect(String(error)).not.toContain(runBearer);
  });

  it("stores final output safely without treating mentions as implicit delegation", () => {
    const persistence = agentOutputPersistence(
      `Done. @Reviewer can inspect this with ${runBearer}`,
      secrets,
    );

    expect(persistence).toEqual({
      body: "Done. @Reviewer can inspect this with [REDACTED]",
      enqueueMentionedAgents: false,
    });
  });
});
