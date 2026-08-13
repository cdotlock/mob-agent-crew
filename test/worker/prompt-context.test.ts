import { describe, expect, it } from "vitest";
import type { TaskThread } from "../../src/domain/model.js";
import { runConversationContext } from "../../src/worker/prompt-context.js";

const primaryConversation = "11111111-1111-4111-8111-111111111111";
const directConversation = "22222222-2222-4222-8222-222222222222";
const triggerMessage = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-08-13T00:00:00.000Z");

describe("run conversation prompt context", () => {
  it("uses the invocation message instead of repeating the stale task description", () => {
    const context = runConversationContext(thread(), runId);

    expect(context.currentInstruction).toBe("给我写一个贪吃蛇");
    expect(context.currentInstruction).not.toContain("KNOWLEDGE_READY");
    expect(context.messages.map((message) => message.body)).toEqual(["给我写一个贪吃蛇"]);
  });

  it("uses a bounded delegation deliverable as the child run instruction", () => {
    const value = thread();
    value.runs[0] = { ...value.runs[0]!, delegationId: "delegation-1" };
    value.delegations.push({
      id: "delegation-1",
      workspaceId: "workspace-1",
      taskId: primaryConversation,
      fromActorId: "agent-1",
      toAgentActorId: "agent-2",
      sourceRunId: "parent-run",
      parentDelegationId: null,
      intent: "collaborate",
      deliverable: "只审查鉴权边界",
      depth: 1,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });

    expect(runConversationContext(value, runId).currentInstruction).toBe("只审查鉴权边界");
  });
});

function thread(): TaskThread {
  return {
    task: {
      id: primaryConversation,
      workspaceId: "workspace-1",
      repositoryId: "repository-1",
      createdByActorId: "human-1",
      assignedActorId: null,
      title: "Old smoke task",
      description: "Return exactly KNOWLEDGE_READY, then stop.",
      baseRevision: "main",
      branchName: null,
      status: "active",
      maxDelegationDepth: 2,
      runBudget: 8,
      writerFence: 0n,
      createdAt: now,
      updatedAt: now,
    },
    conversations: [],
    conversationMemberships: [],
    messages: [
      {
        id: "old-message",
        workspaceId: "workspace-1",
        taskId: primaryConversation,
        conversationId: primaryConversation,
        actorId: "human-1",
        sourceRunId: null,
        kind: "comment",
        body: "Return exactly KNOWLEDGE_READY, then stop.",
        mentions: [],
        createdAt: now,
      },
      {
        id: triggerMessage,
        workspaceId: "workspace-1",
        taskId: primaryConversation,
        conversationId: directConversation,
        actorId: "human-1",
        sourceRunId: null,
        kind: "comment",
        body: "给我写一个贪吃蛇",
        mentions: ["agent-1"],
        createdAt: now,
      },
    ],
    delegations: [],
    runs: [{
      id: runId,
      workspaceId: "workspace-1",
      taskId: primaryConversation,
      conversationId: directConversation,
      triggerMessageId: triggerMessage,
      agentActorId: "agent-1",
      requestedByActorId: "human-1",
      delegationId: null,
      status: "queued",
      priority: 0,
      writerRequired: true,
      latestAttemptNumber: 1,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }],
    attempts: [],
    events: [],
    artifacts: [],
    approvals: [],
  };
}
