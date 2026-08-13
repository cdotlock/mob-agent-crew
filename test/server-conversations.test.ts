import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueRunToken, issueSessionToken } from "../src/auth/tokens.js";
import type { AppConfig } from "../src/config.js";
import type { CollaborationStore } from "../src/db/store.js";
import type { Actor, ConversationThread, TaskThread } from "../src/domain/model.js";
import { buildApp } from "../src/server/app.js";
import type { FileWorkspaceStore } from "../src/storage/index.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const TASK_ID = "44444444-4444-4444-8444-444444444444";
const CONVERSATION_ID = "55555555-5555-4555-8555-555555555555";
const RUN_ID = "66666666-6666-4666-8666-666666666666";
const ATTEMPT_ID = "77777777-7777-4777-8777-777777777777";
const SECRET = "conversation-test-secret-with-more-than-32-characters";
const now = new Date("2026-08-13T00:00:00.000Z");

const human: Actor = {
  id: HUMAN_ID,
  workspaceId: WORKSPACE_ID,
  kind: "human",
  handle: "clock",
  displayName: "Clock",
  status: "active",
  createdAt: now,
  updatedAt: now,
};
const agent: Actor = {
  ...human,
  id: AGENT_ID,
  kind: "agent",
  handle: "builder",
  displayName: "Builder",
};
const secondHuman: Actor = {
  ...human,
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  handle: "alice",
  displayName: "Alice",
};

const directThread: ConversationThread = {
  conversation: {
    id: CONVERSATION_ID,
    workspaceId: WORKSPACE_ID,
    taskId: TASK_ID,
    kind: "direct",
    title: null,
    createdByActorId: HUMAN_ID,
    isPrimary: false,
    createdAt: now,
    updatedAt: now,
  },
  members: [human, agent].map((actor) => ({
    workspaceId: WORKSPACE_ID,
    conversationId: CONVERSATION_ID,
    actorId: actor.id,
    joinedAt: now,
  })),
  messages: [],
  runs: [],
};

const temporaryDirectories: string[] = [];
const openApps: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("conversation API", () => {
  it("creates a task-backed direct chat with exactly the human and chosen Agent", async () => {
    const fixture = await createFixture();
    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/conversations",
      headers: { authorization: `Bearer ${sessionToken()}` },
      payload: { taskId: TASK_ID, kind: "direct", members: ["@builder"] },
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.createConversation).toHaveBeenCalledWith(expect.objectContaining({
      taskId: TASK_ID,
      kind: "direct",
      createdByActorId: HUMAN_ID,
      memberActorIds: [AGENT_ID],
    }));
  });

  it("rejects a direct chat between two humans", async () => {
    const fixture = await createFixture();
    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/conversations",
      headers: { authorization: `Bearer ${sessionToken()}` },
      payload: { taskId: TASK_ID, kind: "direct", members: ["@alice"] },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "direct_human_agent_required",
      message: "A direct conversation requires exactly one human and one Agent.",
    });
    expect(fixture.createConversation).not.toHaveBeenCalled();
  });

  it("only invokes the sole Agent in a direct chat when invoke=true", async () => {
    const fixture = await createFixture();
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/conversations/${CONVERSATION_ID}/messages`,
      headers: { authorization: `Bearer ${sessionToken()}` },
      payload: { content: "写一个贪吃蛇", invoke: true },
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.createConversationMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: CONVERSATION_ID,
      actorId: HUMAN_ID,
      body: "写一个贪吃蛇",
      invokeAgentActorId: AGENT_ID,
    }));
  });

  it("does not turn ordinary chat into another Agent run", async () => {
    const fixture = await createFixture();
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/conversations/${CONVERSATION_ID}/messages`,
      headers: { authorization: `Bearer ${sessionToken()}` },
      payload: { content: "谢谢，先不用继续" },
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.createConversationMessage).toHaveBeenCalledWith(
      expect.not.objectContaining({ invokeAgentActorId: expect.anything() }),
    );
  });

  it("requires running Agents to delegate instead of bypassing guardrails", async () => {
    const fixture = await createFixture({
      ...directThread,
      runs: [{
        id: RUN_ID,
        workspaceId: WORKSPACE_ID,
        taskId: TASK_ID,
        conversationId: CONVERSATION_ID,
        triggerMessageId: null,
        agentActorId: AGENT_ID,
        requestedByActorId: HUMAN_ID,
        delegationId: null,
        status: "running",
        priority: 0,
        writerRequired: true,
        latestAttemptNumber: 1,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      }],
    });
    const token = issueRunToken({
      actorId: AGENT_ID,
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
    }, SECRET);
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/conversations/${CONVERSATION_ID}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content: "@builder continue", invoke: true },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "explicit_delegation_required" });
    expect(fixture.createConversationMessage).not.toHaveBeenCalled();
  });

  it.each(["direct", "group"] as const)(
    "routes Agent mob say/done output back to its %s conversation without touching the primary chat",
    async (kind) => {
      const thread: ConversationThread = {
        ...directThread,
        conversation: { ...directThread.conversation, kind },
        runs: [{
          id: RUN_ID,
          workspaceId: WORKSPACE_ID,
          taskId: TASK_ID,
          conversationId: CONVERSATION_ID,
          triggerMessageId: null,
          agentActorId: AGENT_ID,
          requestedByActorId: HUMAN_ID,
          delegationId: null,
          status: "running",
          priority: 0,
          writerRequired: true,
          latestAttemptNumber: 1,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        }],
      };
      const fixture = await createFixture(thread);
      const token = issueRunToken({
        actorId: AGENT_ID,
        workspaceId: WORKSPACE_ID,
        taskId: TASK_ID,
        runId: RUN_ID,
        attemptId: ATTEMPT_ID,
      }, SECRET);

      const response = await fixture.app.inject({
        method: "POST",
        url: `/api/tasks/${TASK_ID}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: "private run result", kind: "result" },
      });

      expect(response.statusCode).toBe(200);
      expect(fixture.createConversationMessage).toHaveBeenCalledWith(expect.objectContaining({
        conversationId: CONVERSATION_ID,
        actorId: AGENT_ID,
        sourceRunId: RUN_ID,
        kind: "result",
        body: "private run result",
      }));
      expect(fixture.createMessage).not.toHaveBeenCalled();
    },
  );

  it("keeps a direct conversation private from another workspace human", async () => {
    const fixture = await createFixture();

    const denied = await fixture.app.inject({
      method: "GET",
      url: `/api/conversations/${CONVERSATION_ID}`,
      headers: { authorization: `Bearer ${sessionTokenFor(secondHuman.id)}` },
    });
    const allowed = await fixture.app.inject({
      method: "GET",
      url: `/api/conversations/${CONVERSATION_ID}`,
      headers: { authorization: `Bearer ${sessionToken()}` },
    });

    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toMatchObject({ error: "not_found" });
    expect(allowed.statusCode).toBe(200);
  });

  it("does not expose artifacts produced by a direct-chat run in task detail", async () => {
    const directRun = {
      id: RUN_ID,
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      conversationId: CONVERSATION_ID,
      triggerMessageId: null,
      agentActorId: AGENT_ID,
      requestedByActorId: HUMAN_ID,
      delegationId: null,
      status: "succeeded" as const,
      priority: 0,
      writerRequired: true,
      latestAttemptNumber: 1,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    };
    const fixture = await createFixture({ ...directThread, runs: [directRun] });
    fixture.taskThread.artifacts.push({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      actorId: AGENT_ID,
      sourceRunId: RUN_ID,
      sourceAttemptId: null,
      kind: "file",
      name: "private-result.md",
      uri: "file:/missing/private-result.md",
      mediaType: "text/markdown",
      byteSize: 10n,
      sha256: null,
      metadata: {},
      createdAt: now,
    });

    const denied = await fixture.app.inject({
      method: "GET",
      url: `/api/tasks/${TASK_ID}`,
      headers: { authorization: `Bearer ${sessionTokenFor(secondHuman.id)}` },
    });
    const allowed = await fixture.app.inject({
      method: "GET",
      url: `/api/tasks/${TASK_ID}`,
      headers: { authorization: `Bearer ${sessionToken()}` },
    });

    expect(denied.statusCode).toBe(200);
    expect(denied.json().artifacts).toEqual([]);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().artifacts).toEqual([
      expect.objectContaining({ name: "private-result.md" }),
    ]);
  });
});

describe("Agent identity API", () => {
  it("creates a thin file-backed Agent connector profile", async () => {
    const fixture = await createFixture();
    const createActor = vi.fn(async () => ({
      ...agent,
      id: "99999999-9999-4999-8999-999999999999",
      handle: "hermes-reviewer",
      displayName: "Hermes Reviewer",
    }));
    const createAgentProfile = vi.fn(async (input: Record<string, unknown>) => ({
      ...input,
      createdAt: now,
      updatedAt: now,
    }));
    Object.assign(fixture.store, { createActor, createAgentProfile });
    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { authorization: `Bearer ${sessionToken()}` },
      payload: {
        handle: "hermes-reviewer",
        name: "Hermes Reviewer",
        driver: "hermes",
        role: "Independent reviewer",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(createAgentProfile).toHaveBeenCalledWith(expect.objectContaining({
      driver: "hermes",
      role: "Independent reviewer",
      capabilities: expect.objectContaining({ steer: true, followUp: false }),
    }));
    expect(fixture.writeActor).toHaveBeenCalledOnce();
    expect(fixture.writeAgentProfile).toHaveBeenCalledOnce();
  });
});

async function createFixture(thread: ConversationThread = directThread) {
  const dataDir = await mkdtemp(join(tmpdir(), "mob-conversations-"));
  temporaryDirectories.push(dataDir);
  const createConversation = vi.fn(async () => directThread);
  const createConversationMessage = vi.fn(async (input: { body: string; actorId: string }) => ({
    message: {
      id: "77777777-7777-4777-8777-777777777777",
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      conversationId: CONVERSATION_ID,
      actorId: input.actorId,
      sourceRunId: null,
      kind: "comment" as const,
      body: input.body,
      mentions: [],
      createdAt: now,
    },
    queuedRuns: [],
  }));
  const createMessage = vi.fn(async () => ({ message: {}, queuedRuns: [] }));
  const task = {
    id: TASK_ID,
    workspaceId: WORKSPACE_ID,
    repositoryId: "88888888-8888-4888-8888-888888888888",
    createdByActorId: HUMAN_ID,
    assignedActorId: null,
    title: "Task",
    description: "",
    baseRevision: "main",
    branchName: null,
    status: "open" as const,
    maxDelegationDepth: 2,
    runBudget: 8,
    writerFence: 0n,
    createdAt: now,
    updatedAt: now,
  };
  const taskThread: TaskThread = {
    task,
    conversations: [thread.conversation],
    conversationMemberships: thread.members,
    messages: thread.messages,
    delegations: [],
    runs: thread.runs,
    attempts: [],
    events: [],
    artifacts: [],
    approvals: [],
  };
  const store = {
    getTask: vi.fn(async () => task),
    listRepositories: vi.fn(async () => []),
    listActors: vi.fn(async () => [human, secondHuman, agent]),
    createConversation,
    getConversationThread: vi.fn(async () => thread),
    canActorAccessConversation: vi.fn(async (conversationId: string, actorId: string) =>
      conversationId === CONVERSATION_ID && thread.members.some((member) => member.actorId === actorId),
    ),
    canActorAccessTaskRepository: vi.fn(async () => true),
    createConversationMessage,
    createMessage,
    getTaskThread: vi.fn(async () => taskThread),
    sql: vi.fn(async () => [{
      task_id: TASK_ID,
      workspace_id: WORKSPACE_ID,
      agent_actor_id: AGENT_ID,
      conversation_id: CONVERSATION_ID,
      attempt_id: ATTEMPT_ID,
      run_status: "running",
      attempt_status: "running",
      lease_active: true,
    }]),
  } as unknown as CollaborationStore;
  const files = {
    workspaceRoot: vi.fn(() => join(dataDir, "state", "workspaces", WORKSPACE_ID)),
    repairTaskThread: vi.fn(async () => ({ root: "", written: 0, paths: [], removed: 0 })),
    writeActor: vi.fn(async () => "actor.json"),
    writeAgentProfile: vi.fn(async () => "profile.json"),
  } as unknown as FileWorkspaceStore;
  const app = await buildApp({ config: config(dataDir), store, files });
  openApps.push(app);
  return {
    app,
    store,
    createConversation,
    createConversationMessage,
    createMessage,
    taskThread,
    writeActor: (files as unknown as { writeActor: ReturnType<typeof vi.fn> }).writeActor,
    writeAgentProfile: (files as unknown as { writeAgentProfile: ReturnType<typeof vi.fn> }).writeAgentProfile,
  };
}

function sessionToken(): string {
  return sessionTokenFor(HUMAN_ID);
}

function sessionTokenFor(actorId: string): string {
  return issueSessionToken({ actorId, workspaceId: WORKSPACE_ID }, SECRET);
}

function config(dataDir: string): AppConfig {
  return {
    nodeEnv: "test",
    databaseUrl: "postgres://unused",
    host: "127.0.0.1",
    port: 4310,
    dataDir,
    embeddedWorker: false,
    workerConcurrency: 1,
    enableMockDriver: false,
    sessionSecret: SECRET,
    adminName: "Test",
    bootstrapRepositoryUrl: "https://github.com/example/repository",
    mobAiKey: "test-key",
    mobAiBaseUrl: "https://example.test/api",
    mobAiModel: "test-model",
  };
}
