import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueRunToken, issueSessionToken } from "../src/auth/tokens.js";
import type { AppConfig } from "../src/config.js";
import type { CollaborationStore } from "../src/db/store.js";
import type { Approval, Repository, Task, TaskThread } from "../src/domain/model.js";
import type { FileWorkspaceStore } from "../src/storage/index.js";

const publishTaskBranch = vi.fn(async () => ({
  branch: "mob/44444444",
  commit: "a".repeat(40),
  changedFiles: ["README.md"],
}));
const assertGitHubPublishRemote = vi.fn();
vi.mock("../src/workspace/publish.js", () => ({ publishTaskBranch, assertGitHubPublishRemote }));

const { buildApp } = await import("../src/server/app.js");

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const TASK_ID = "44444444-4444-4444-8444-444444444444";
const REPOSITORY_ID = "55555555-5555-4555-8555-555555555555";
const RUN_ID = "66666666-6666-4666-8666-666666666666";
const ATTEMPT_ID = "77777777-7777-4777-8777-777777777777";
const EXECUTION_CONVERSATION_ID = "88888888-8888-4888-8888-888888888888";
const SECRET = "review-publication-test-secret-more-than-32-characters";
const now = new Date("2026-08-13T00:00:00.000Z");
const temporaryDirectories: string[] = [];
const openApps: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  publishTaskBranch.mockClear();
  assertGitHubPublishRemote.mockClear();
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("human review and publication API", () => {
  it("accepts a review, records the human decision in the thread, and repairs file state", async () => {
    const fixture = await createFixture();
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/tasks/${TASK_ID}/reviews`,
      headers: { authorization: `Bearer ${sessionToken()}` },
      payload: { decision: "accept", note: "Focused tests passed." },
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.reviewTask).toHaveBeenCalledWith({
      taskId: TASK_ID,
      decidedByActorId: HUMAN_ID,
      decision: "accept",
    });
    expect(fixture.createMessage).toHaveBeenCalledWith(expect.objectContaining({
      actorId: HUMAN_ID,
      kind: "system",
      body: expect.stringContaining("Publication still requires a separate human action"),
    }));
    expect(fixture.repairTaskThread).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ status: "completed" }),
    }));
    expect(response.json()).toMatchObject({ status: "completed", resolution: "accepted" });
  });

  it("reopens a task when the human requests changes", async () => {
    const fixture = await createFixture();
    fixture.reviewTask.mockResolvedValueOnce({ ...task, status: "open" });
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/tasks/${TASK_ID}/reviews`,
      headers: { authorization: `Bearer ${sessionToken()}` },
      payload: { decision: "request_changes", note: "Add the missing regression test." },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "open", resolution: "unreviewed" });
  });

  it("records a hidden execution review in its canonical conversation ledger", async () => {
    const fixture = await createFixture();
    const executionTask = {
      ...task,
      executionConversationId: EXECUTION_CONVERSATION_ID,
      isExecution: true,
    };
    fixture.getTask.mockResolvedValueOnce(executionTask);
    fixture.reviewTask.mockResolvedValueOnce({ ...executionTask, status: "completed" });

    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/tasks/${TASK_ID}/reviews`,
      headers: { authorization: `Bearer ${sessionToken()}` },
      payload: { decision: "accept", note: "Looks good." },
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.createConversationMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: EXECUTION_CONVERSATION_ID,
      actorId: HUMAN_ID,
      kind: "system",
      invokeAgentActorIds: [],
    }));
    expect(fixture.createMessage).not.toHaveBeenCalled();
    expect(fixture.repairConversationThread).toHaveBeenCalledWith(expect.objectContaining({
      conversation: expect.objectContaining({ id: EXECUTION_CONVERSATION_ID }),
    }));
  });

  it("publishes only after an explicit human confirmation and writes the approved audit record", async () => {
    const fixture = await createFixture();
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/tasks/${TASK_ID}/publications`,
      headers: { authorization: `Bearer ${sessionToken()}` },
      payload: { confirm: true, commitMessage: "mob: publish reviewed change" },
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.withTaskPublicationLock).toHaveBeenCalledWith(
      { taskId: TASK_ID, approvedByActorId: HUMAN_ID, branchName: "mob/44444444" },
      expect.any(Function),
    );
    expect(assertGitHubPublishRemote).toHaveBeenCalledWith(repository.remoteUrl);
    expect(publishTaskBranch).toHaveBeenCalledWith(expect.objectContaining({
      taskDirectory: join(fixture.dataDir, "tasks", TASK_ID),
      controlDirectory: join(fixture.dataDir, "control", "tasks", TASK_ID),
      remoteUrl: repository.remoteUrl,
      branchName: "mob/44444444",
      authorName: "Clock",
    }));
    expect(fixture.requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      kind: "publish_branch",
      requestedByActorId: HUMAN_ID,
    }));
    expect(fixture.decideApproval).toHaveBeenCalledWith(expect.objectContaining({
      decision: "approved",
      decidedByActorId: HUMAN_ID,
    }));
    expect(fixture.writeApproval).toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      branch: "mob/44444444",
      commit: "a".repeat(40),
      changedFiles: ["README.md"],
    });
  });

  it("rejects Agent publication and missing human confirmation", async () => {
    const fixture = await createFixture();
    const runToken = issueRunToken({
      actorId: AGENT_ID,
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
    }, SECRET);
    const agentResponse = await fixture.app.inject({
      method: "POST",
      url: `/api/tasks/${TASK_ID}/publications`,
      headers: { authorization: `Bearer ${runToken}` },
      payload: { confirm: true },
    });
    const unconfirmedResponse = await fixture.app.inject({
      method: "POST",
      url: `/api/tasks/${TASK_ID}/publications`,
      headers: { authorization: `Bearer ${sessionToken()}` },
      payload: { confirm: false },
    });

    expect(agentResponse.statusCode).toBe(403);
    expect(unconfirmedResponse.statusCode).toBe(400);
    expect(publishTaskBranch).not.toHaveBeenCalled();
  });

  it("does not create a publication approval before review and ref preflight pass", async () => {
    const fixture = await createFixture();
    fixture.getTask.mockResolvedValueOnce({ ...task, status: "open" });
    const unreviewed = await fixture.app.inject({
      method: "POST",
      url: `/api/tasks/${TASK_ID}/publications`,
      headers: { authorization: `Bearer ${sessionToken()}` },
      payload: { confirm: true },
    });
    const unsafeRef = await fixture.app.inject({
      method: "POST",
      url: `/api/tasks/${TASK_ID}/publications`,
      headers: { authorization: `Bearer ${sessionToken()}` },
      payload: { confirm: true, branch: "mob/../main" },
    });

    expect(unreviewed.statusCode).toBe(409);
    expect(unsafeRef.statusCode).toBe(400);
    expect(fixture.requestApproval).not.toHaveBeenCalled();
  });
});

const task: Task = {
  id: TASK_ID,
  workspaceId: WORKSPACE_ID,
  repositoryId: REPOSITORY_ID,
  executionConversationId: null,
  isExecution: false,
  createdByActorId: HUMAN_ID,
  assignedActorId: AGENT_ID,
  title: "Review me",
  description: "",
  baseRevision: "main",
  branchName: null,
  status: "review_ready",
  maxDelegationDepth: 2,
  runBudget: 8,
  writerFence: 0n,
  createdAt: now,
  updatedAt: now,
};

const repository: Repository = {
  id: REPOSITORY_ID,
  workspaceId: WORKSPACE_ID,
  name: "repository",
  kind: "git",
  remoteUrl: "https://github.com/example/repository",
  localPath: null,
  defaultBranch: "main",
  allowlisted: true,
  enabled: true,
  createdByActorId: HUMAN_ID,
  createdAt: now,
  updatedAt: now,
};

async function createFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "mob-review-publication-"));
  temporaryDirectories.push(dataDir);
  const completed = { ...task, status: "completed" as const };
  const approval: Approval = {
    id: "77777777-7777-4777-8777-777777777777",
    workspaceId: WORKSPACE_ID,
    taskId: TASK_ID,
    requestedByActorId: HUMAN_ID,
    decidedByActorId: null,
    kind: "publish_branch",
    status: "pending",
    payload: {},
    decisionNote: null,
    createdAt: now,
    decidedAt: null,
  };
  const approved = { ...approval, decidedByActorId: HUMAN_ID, status: "approved" as const, decidedAt: now };
  const emptyThread = (nextTask: Task): TaskThread => ({
    task: nextTask,
    conversations: [],
    conversationMemberships: [],
    messages: [],
    delegations: [],
    runs: [],
    attempts: [],
    events: [],
    artifacts: [],
    approvals: [],
  });
  const reviewTask = vi.fn(async (_input: unknown): Promise<Task> => completed);
  const createMessage = vi.fn(async () => ({ message: {}, queuedRuns: [] }));
  const createConversationMessage = vi.fn(async () => ({ message: {}, queuedRuns: [], deliveries: [] }));
  const requestApproval = vi.fn(async () => approval);
  const decideApproval = vi.fn(async () => approved);
  const withTaskPublicationLock = vi.fn(async (
    _input: unknown,
    publish: (context: { task: Task; repository: Repository }) => Promise<unknown>,
  ) => ({ task: completed, repository, result: await publish({ task: completed, repository }) }));
  let latestTask: Task = completed;
  const store = {
    getTask: vi.fn(async () => latestTask),
    listRepositories: vi.fn(async () => [repository]),
    reviewTask: vi.fn(async (input: unknown) => {
      const result = await reviewTask(input);
      latestTask = result;
      return result;
    }),
    createMessage,
    createConversationMessage,
    canActorAccessConversation: vi.fn(async () => true),
    getConversationContext: vi.fn(async () => ({
      conversation: {
        id: EXECUTION_CONVERSATION_ID,
        workspaceId: WORKSPACE_ID,
        taskId: null,
        activeRepositoryId: REPOSITORY_ID,
        createdByActorId: HUMAN_ID,
        kind: "direct",
        title: null,
        isPrimary: false,
        createdAt: now,
        updatedAt: now,
      },
      members: [],
      messages: [],
      runs: [],
    })),
    getTaskThread: vi.fn(async () => emptyThread(latestTask)),
    listActors: vi.fn(async () => [{
      id: HUMAN_ID,
      workspaceId: WORKSPACE_ID,
      kind: "human",
      handle: "clock",
      displayName: "Clock",
      status: "active",
      createdAt: now,
      updatedAt: now,
    }]),
    requestApproval,
    decideApproval,
    withTaskPublicationLock,
    sql: vi.fn(async () => [{
      task_id: TASK_ID,
      workspace_id: WORKSPACE_ID,
      agent_actor_id: AGENT_ID,
      conversation_id: TASK_ID,
      attempt_id: ATTEMPT_ID,
      run_status: "running",
      attempt_status: "running",
      lease_active: true,
    }]),
  } as unknown as CollaborationStore;
  const repairTaskThread = vi.fn(async () => ({ root: "", written: 0, paths: [], removed: 0 }));
  const repairConversationThread = vi.fn(async () => ({ root: "", written: 0, paths: [], removed: 0 }));
  const writeApproval = vi.fn(async () => "approval.json");
  const files = {
    workspaceRoot: vi.fn(() => join(dataDir, "state", "workspaces", WORKSPACE_ID)),
    repairTaskThread,
    repairConversationThread,
    writeApproval,
  } as unknown as FileWorkspaceStore;
  const app = await buildApp({ config: config(dataDir), store, files });
  openApps.push(app);
  return {
    app,
    dataDir,
    getTask: (store as unknown as { getTask: ReturnType<typeof vi.fn> }).getTask,
    reviewTask,
    createMessage,
    createConversationMessage,
    requestApproval,
    decideApproval,
    withTaskPublicationLock,
    repairTaskThread,
    repairConversationThread,
    writeApproval,
  };
}

function sessionToken(): string {
  return issueSessionToken({ actorId: HUMAN_ID, workspaceId: WORKSPACE_ID }, SECRET);
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
    bootstrapRepositoryUrl: repository.remoteUrl ?? "https://github.com/example/repository",
    mobAiBaseUrl: "https://example.test/api",
    mobAiModel: "test-model",
  };
}
