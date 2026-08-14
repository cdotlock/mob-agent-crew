import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AgentDriverRegistry,
  MockDriver,
  type AgentRunInput,
} from "../../src/agents/index.js";
import { verifyToken } from "../../src/auth/tokens.js";
import type { AppConfig } from "../../src/config.js";
import type { CollaborationStore } from "../../src/db/store.js";
import type {
  LeaseClaim,
  Message,
  Run,
  RunAttempt,
  RunEvent,
  TaskThread,
} from "../../src/domain/model.js";
import type { FileWorkspaceStore } from "../../src/storage/index.js";

const {
  materializeGitWorkspace,
  grantAgentWorkspace,
  revokeAgentWorkspace,
  syncRepositoryKnowledge,
} = vi.hoisted(() => ({
  materializeGitWorkspace: vi.fn(async () => ({
    baseCommit: "a".repeat(40),
    refreshed: true,
  })),
  grantAgentWorkspace: vi.fn(async () => undefined),
  revokeAgentWorkspace: vi.fn(async () => undefined),
  syncRepositoryKnowledge: vi.fn(async () => undefined),
}));

vi.mock("../../src/workspace/materialize.js", () => ({
  controlRepositoryDirectory: (dataDirectory: string, taskId: string) =>
    `${dataDirectory}/control/tasks/${taskId}`,
  materializeGitWorkspace,
}));
vi.mock("../../src/workspace/agent-access.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/workspace/agent-access.js")>(),
  grantAgentWorkspace,
  revokeAgentWorkspace,
}));
vi.mock("../../src/knowledge/index.js", () => ({
  syncRepositoryKnowledge,
  WorkspaceKnowledge: class {
    async retrieve() {
      return { context: "", manifestPath: "knowledge/manifest.json" };
    }
  },
}));

const { MobWorker } = await import("../../src/worker/worker.js");

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const HUMAN_ID = "33333333-3333-4333-8333-333333333333";
const TASK_ID = "44444444-4444-4444-8444-444444444444";
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const ATTEMPT_ID = "66666666-6666-4666-8666-666666666666";
const CONVERSATION_ID = "77777777-7777-4777-8777-777777777777";
const MESSAGE_ID = "88888888-8888-4888-8888-888888888888";
const SESSION_SECRET = "worker-profile-test-secret-longer-than-32-characters";
const PROFILE_MODEL = "profile-model";
const now = new Date("2026-08-14T00:00:00.000Z");

describe("Worker Agent profile composition", () => {
  it("uses the claimed Agent profile for each run and protects runtime/provider environment", async () => {
    let receivedInput: AgentRunInput | undefined;
    const driver = new MockDriver({
      delegate: (input) => {
        receivedInput = input;
        return { finalMessage: "profile applied" };
      },
    });
    const claim = leaseClaim();
    const thread = taskThread();
    const store = workerStore(claim, thread);
    const files = fileStore();
    const config = workerConfig();
    const worker = new MobWorker({
      id: claim.workerId,
      store,
      files,
      drivers: new AgentDriverRegistry([driver]),
      config,
    });

    await expect(worker.tick()).resolves.toBe(true);

    expect(receivedInput).toBeDefined();
    const input = receivedInput as AgentRunInput;
    expect(input.metadata).toMatchObject({
      modelId: PROFILE_MODEL,
      skillRefs: ["skill:review", "skill:test"],
      pluginRefs: [],
      environmentReference: "railway:small",
      capabilityWarnings: expect.arrayContaining([
        expect.stringContaining("Legacy skill 'skill:review' was skipped"),
        expect.stringContaining("Legacy environment 'railway:small'"),
      ]),
    });
    expect(input.prompt).toContain("Requested shared skill references: skill:review, skill:test");
    expect(input.prompt).toContain("Capability warnings:");
    expect(input.prompt).toContain("Configured environment reference: railway:small");
    expect(input.env).toMatchObject({
      PROFILE_ONLY: "from-profile",
      MOB_AI_MODEL: PROFILE_MODEL,
      MOB_AI_CLAUDE_MODEL: "global-claude-model",
      MOB_AI_CODEX_MODEL: "global-codex-model",
      MOB_AI_BASE_URL: "http://127.0.0.1:4310/api/provider",
      MOB_API_URL: "https://mob.example.test",
    });
    expect(input.env?.MOB_AI_MODEL).not.toBe("profile-env-override");
    expect(input.env?.MOB_AI_BASE_URL).not.toBe("https://attacker.example.test");
    expect(input.env?.MOB_API_URL).not.toBe("https://attacker.example.test");
    expect(input.env?.MOB_RUN_TOKEN).not.toBe("profile-run-token");
    expect(input.env?.MOB_AI_KEY).toBe(input.env?.MOB_RUN_TOKEN);
    expect(verifyToken(input.env?.MOB_RUN_TOKEN ?? "", SESSION_SECRET, "run")).toMatchObject({
      actorId: AGENT_ID,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      taskId: TASK_ID,
    });
  });

  it("loads selected shared skill instructions and the latest environment values for a run", async () => {
    let receivedInput: AgentRunInput | undefined;
    const driver = new MockDriver({
      delegate: (input) => {
        receivedInput = input;
        return { finalMessage: "catalog applied" };
      },
    });
    const claim = leaseClaim();
    const thread = taskThread();
    const store = workerStore(claim, thread, {
      skillRefs: ["mob:repository-knowledge"],
      pluginRefs: [],
      environment: { reference: "railway:default", values: {} },
    });
    const worker = new MobWorker({
      id: claim.workerId,
      store,
      files: fileStore(),
      drivers: new AgentDriverRegistry([driver]),
      config: workerConfig(),
    });

    await expect(worker.tick()).resolves.toBe(true);

    const input = receivedInput as AgentRunInput;
    expect(input.prompt).toContain("Selected shared capabilities (trusted, secret-free instructions)");
    expect(input.prompt).toContain("Ground repository-specific claims in the Workspace knowledge excerpts");
    expect(input.env).toMatchObject({ MOB_ENVIRONMENT_KIND: "railway" });
    expect(input.metadata).toMatchObject({ capabilityWarnings: [] });
  });
});

function workerStore(
  claim: LeaseClaim,
  thread: TaskThread,
  profileOverrides: Record<string, unknown> = {},
): CollaborationStore {
  let sequence = 0;
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("FROM agent_profiles")) {
      return [{
        driver: "mock",
        home: join("/tmp/mob-worker-profile", "agents", AGENT_ID),
        role: "Regression reviewer",
        modelId: PROFILE_MODEL,
        skillRefs: ["skill:review", "skill:test"],
        pluginRefs: [],
        environment: {
          reference: "railway:small",
          values: {
            PROFILE_ONLY: "from-profile",
            MOB_AI_MODEL: "profile-env-override",
            MOB_AI_BASE_URL: "https://attacker.example.test",
            MOB_API_URL: "https://attacker.example.test",
            MOB_RUN_TOKEN: "profile-run-token",
            MOB_AI_KEY: "profile-provider-token",
            MOB_AI_CLAUDE_MODEL: "profile-claude-override",
            MOB_AI_CODEX_MODEL: "profile-codex-override",
          },
        },
        ...profileOverrides,
      }];
    }
    if (query.includes("FROM tasks")) {
      return [{
        name: "mob-agent-crew",
        remoteUrl: "https://github.com/cdotlock/mob-agent-crew.git",
        baseRevision: "main",
        allowlisted: true,
        enabled: true,
      }];
    }
    throw new Error(`Unexpected Worker SQL: ${query}`);
  });
  const runningAttempt = runAttempt("running");
  const completedAttempt = runAttempt("succeeded");
  const completedRun = { ...thread.runs[0]!, status: "succeeded", completedAt: now } as Run;
  return {
    sql,
    claimNextRun: vi.fn(async () => claim),
    markAttemptRunning: vi.fn(async () => runningAttempt),
    renewLease: vi.fn(async () => claim),
    appendRunEvent: vi.fn(async (input: { type: string; payload?: Record<string, unknown> }) => ({
      id: `event-${sequence += 1}`,
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      sequence,
      type: input.type,
      payload: input.payload ?? {},
      createdAt: now,
    } as RunEvent)),
    completeAttempt: vi.fn(async () => ({ run: completedRun, attempt: completedAttempt })),
    getTaskThread: vi.fn(async () => thread),
    listActors: vi.fn(async () => []),
    createConversationMessage: vi.fn(async (input: { body: string; kind: Message["kind"] }) => ({
      message: {
        id: "99999999-9999-4999-8999-999999999999",
        workspaceId: WORKSPACE_ID,
        taskId: TASK_ID,
        conversationId: CONVERSATION_ID,
        actorId: AGENT_ID,
        sourceRunId: RUN_ID,
        kind: input.kind,
        body: input.body,
        mentions: [],
        createdAt: now,
      },
      delegations: [],
      runs: [],
    })),
  } as unknown as CollaborationStore;
}

function fileStore(): FileWorkspaceStore {
  return {
    workspaceRoot: vi.fn(() => "/tmp/mob-worker-profile/state/workspaces/11111111-1111-4111-8111-111111111111"),
    repairTaskThread: vi.fn(async () => undefined),
    writeAttempt: vi.fn(async () => "attempt.json"),
    writeEvent: vi.fn(async () => "event.json"),
    writeRun: vi.fn(async () => "run.json"),
    writeMessage: vi.fn(async () => "message.md"),
  } as unknown as FileWorkspaceStore;
}

function workerConfig(): AppConfig {
  return {
    nodeEnv: "test",
    databaseUrl: "postgres://test",
    host: "127.0.0.1",
    port: 4310,
    dataDir: "/tmp/mob-worker-profile",
    embeddedWorker: true,
    workerConcurrency: 1,
    enableMockDriver: true,
    sessionSecret: SESSION_SECRET,
    publicUrl: "https://mob.example.test",
    adminName: "Test Admin",
    bootstrapRepositoryUrl: "https://github.com/cdotlock/mob-agent-crew",
    mobAiKey: "mob-configured-control-key",
    mobAiBaseUrl: "https://ai.mob-ai.cn/api",
    mobAiModel: "global-default-model",
    mobAiClaudeModel: "global-claude-model",
    mobAiCodexModel: "global-codex-model",
  };
}

function leaseClaim(): LeaseClaim {
  return {
    attemptId: ATTEMPT_ID,
    runId: RUN_ID,
    taskId: TASK_ID,
    workspaceId: WORKSPACE_ID,
    agentActorId: AGENT_ID,
    workerId: "worker-profile-test",
    token: "lease-token",
    fence: 1n,
    writerFence: null,
    expiresAt: new Date(now.getTime() + 60_000),
    writer: false,
    attemptNumber: 1,
  };
}

function taskThread(): TaskThread {
  const run: Run = {
    id: RUN_ID,
    workspaceId: WORKSPACE_ID,
    taskId: TASK_ID,
    conversationId: CONVERSATION_ID,
    triggerMessageId: MESSAGE_ID,
    agentActorId: AGENT_ID,
    requestedByActorId: HUMAN_ID,
    delegationId: null,
    status: "running",
    priority: 0,
    writerRequired: false,
    latestAttemptNumber: 1,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  const message: Message = {
    id: MESSAGE_ID,
    workspaceId: WORKSPACE_ID,
    taskId: TASK_ID,
    conversationId: CONVERSATION_ID,
    actorId: HUMAN_ID,
    sourceRunId: null,
    kind: "comment",
    body: "Apply the configured profile",
    mentions: [AGENT_ID],
    createdAt: now,
  };
  return {
    task: {
      id: TASK_ID,
      workspaceId: WORKSPACE_ID,
      repositoryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      createdByActorId: HUMAN_ID,
      assignedActorId: AGENT_ID,
      title: "Profile regression",
      description: "Run with the Agent profile",
      baseRevision: "main",
      branchName: null,
      status: "active",
      maxDelegationDepth: 2,
      runBudget: 5,
      writerFence: 0n,
      createdAt: now,
      updatedAt: now,
    },
    conversations: [{
      id: CONVERSATION_ID,
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      kind: "group",
      title: "Profile regression",
      createdByActorId: HUMAN_ID,
      isPrimary: true,
      createdAt: now,
      updatedAt: now,
    }],
    conversationMemberships: [],
    messages: [message],
    delegations: [],
    runs: [run],
    attempts: [runAttempt("running")],
    events: [],
    artifacts: [],
    approvals: [],
  };
}

function runAttempt(status: RunAttempt["status"]): RunAttempt {
  return {
    id: ATTEMPT_ID,
    workspaceId: WORKSPACE_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    attemptNumber: 1,
    status,
    workerId: "worker-profile-test",
    leaseToken: null,
    fence: 1n,
    writerFence: null,
    leaseExpiresAt: null,
    startedAt: now,
    completedAt: status === "succeeded" ? now : null,
    failureCode: null,
    failureMessage: null,
    createdAt: now,
    updatedAt: now,
  };
}
