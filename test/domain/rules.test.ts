import { describe, expect, it } from "vitest";
import {
  DomainRuleError,
  assertAttemptTransition,
  assertDelegationAllowed,
  assertHumanApproval,
  assertRunTransition,
  assertTaskTransition,
  extractMentionHandles,
  isLeaseCurrent,
  leaseExpiry,
  normalizeGitHubRepositoryUrl,
  normalizeHandle,
} from "../../src/domain/index.js";

describe("actor handles and mentions", () => {
  it("normalizes handles and rejects ambiguous forms", () => {
    expect(normalizeHandle(" @Agent-One ")).toBe("agent-one");
    expect(() => normalizeHandle("agent_one")).toThrowError(DomainRuleError);
    expect(() => normalizeHandle("-agent")).toThrowError(DomainRuleError);
  });

  it("extracts unique mentions without treating email addresses as mentions", () => {
    expect(extractMentionHandles("Ask @Scout, then @review-bot. @SCOUT mail a@b.com")).toEqual([
      "scout",
      "review-bot",
    ]);
  });
});

describe("repository imports", () => {
  it("canonicalizes a GitHub repository URL", () => {
    expect(normalizeGitHubRepositoryUrl("https://github.com/cdotlock/mob-agent-crew/"))
      .toBe("https://github.com/cdotlock/mob-agent-crew.git");
  });

  it("rejects non-GitHub and nested URLs", () => {
    expect(() => normalizeGitHubRepositoryUrl("https://gitlab.com/a/b")).toThrowError(DomainRuleError);
    expect(() => normalizeGitHubRepositoryUrl("https://github.com/a/b/issues"))
      .toThrowError(DomainRuleError);
  });
});

describe("state transitions", () => {
  it("permits the intended happy paths", () => {
    expect(() => assertTaskTransition("open", "active")).not.toThrow();
    expect(() => assertRunTransition("queued", "running")).not.toThrow();
    expect(() => assertAttemptTransition("claimed", "running")).not.toThrow();
  });

  it("rejects reopening terminal states", () => {
    expect(() => assertTaskTransition("completed", "active")).toThrowError(DomainRuleError);
    expect(() => assertRunTransition("cancelled", "running")).toThrowError(DomainRuleError);
    expect(() => assertAttemptTransition("succeeded", "running")).toThrowError(DomainRuleError);
  });
});

describe("delegation and approval rules", () => {
  const valid = {
    fromActorId: "actor-a",
    toActorId: "actor-b",
    toActorKind: "agent" as const,
    toActorStatus: "active" as const,
    depth: 1,
    maxDepth: 2,
    existingRunCount: 1,
    runBudget: 4,
    deliverable: "Review the parser and post findings",
  };

  it("accepts a bounded delegation to an active agent", () => {
    expect(() => assertDelegationAllowed(valid)).not.toThrow();
  });

  it("rejects loops, excess depth, and exhausted run budgets", () => {
    expect(() => assertDelegationAllowed({ ...valid, toActorId: "actor-a" })).toThrowError("itself");
    expect(() => assertDelegationAllowed({ ...valid, depth: 3 })).toThrowError("depth");
    expect(() => assertDelegationAllowed({ ...valid, existingRunCount: 4 })).toThrowError("budget");
  });

  it("reserves publication approval for humans", () => {
    expect(() => assertHumanApproval("human")).not.toThrow();
    expect(() => assertHumanApproval("agent")).toThrowError("human");
  });
});

describe("lease rules", () => {
  const expected = {
    attemptId: "attempt-1",
    token: "lease-a",
    fence: 9n,
    writerFence: 12n,
    expiresAt: new Date("2026-08-13T10:01:00.000Z"),
  };

  it("requires matching attempt, token, fence, and an unexpired deadline", () => {
    const now = new Date("2026-08-13T10:00:00.000Z");
    expect(isLeaseCurrent(expected, expected, now)).toBe(true);
    expect(isLeaseCurrent(expected, { ...expected, token: "stale" }, now)).toBe(false);
    expect(isLeaseCurrent(expected, { ...expected, fence: 8n }, now)).toBe(false);
    expect(isLeaseCurrent(expected, { ...expected, writerFence: 11n }, now)).toBe(false);
    expect(isLeaseCurrent(expected, expected, expected.expiresAt)).toBe(false);
  });

  it("computes a deterministic expiry and validates durations", () => {
    const now = new Date("2026-08-13T10:00:00.000Z");
    expect(leaseExpiry(now, 30_000).toISOString()).toBe("2026-08-13T10:00:30.000Z");
    expect(() => leaseExpiry(now, 0)).toThrowError(DomainRuleError);
  });
});
