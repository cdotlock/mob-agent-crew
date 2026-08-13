import { describe, expect, it } from "vitest";
import { issueRunToken, issueSessionToken, verifyAnyToken, verifyToken } from "../../src/auth/tokens.js";

const secret = "a-secret-that-is-long-enough-for-tests";
const actorId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const attemptId = "55555555-5555-4555-8555-555555555555";

describe("signed actor tokens", () => {
  it("round-trips a human session", () => {
    const token = issueSessionToken({ actorId, workspaceId }, secret, 1_000, 100);

    expect(verifyToken(token, secret, "session", 500)).toMatchObject({
      kind: "session",
      actorId,
      workspaceId,
    });
  });

  it("scopes agent tokens to one run and task", () => {
    const token = issueRunToken(
      {
        actorId,
        workspaceId,
        runId: "33333333-3333-4333-8333-333333333333",
        attemptId,
        taskId: "44444444-4444-4444-8444-444444444444",
      },
      secret,
      1_000,
      100,
    );

    const claims = verifyToken(token, secret, "run", 500);
    expect(claims).toMatchObject({ kind: "run", actorId, workspaceId, attemptId });
    expect(() => verifyToken(token, secret, "session", 500)).toThrow();
  });

  it("rejects tampering and expired tokens", () => {
    const token = issueSessionToken({ actorId, workspaceId }, secret, 100, 100);
    const tampered = `${token.slice(0, -1)}x`;

    expect(() => verifyToken(tampered, secret, "session", 150)).toThrow(
      "Invalid token signature",
    );
    expect(() => verifyToken(token, secret, "session", 200)).toThrow("Token expired");
  });

  it("verifies either token kind for external bearer clients", () => {
    const session = issueSessionToken({ actorId, workspaceId }, secret, 1_000, 100);
    const run = issueRunToken(
      {
        actorId,
        workspaceId,
        runId: "33333333-3333-4333-8333-333333333333",
        attemptId,
        taskId: "44444444-4444-4444-8444-444444444444",
      },
      secret,
      1_000,
      100,
    );

    expect(verifyAnyToken(session, secret, 500).kind).toBe("session");
    expect(verifyAnyToken(run, secret, 500).kind).toBe("run");
    expect(() => verifyAnyToken(`${session.slice(0, -1)}x`, secret, 500)).toThrow();
  });
});
