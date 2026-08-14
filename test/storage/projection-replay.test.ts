import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../../src/db/client.js";
import type {
  Actor,
  AgentProfile,
  Message,
  Repository,
  Run,
  RunAttempt,
  RunEvent,
  Task,
  TaskThread,
  Workspace,
} from "../../src/domain/model.js";
import {
  FileWorkspaceStore,
  countFileWorkspaceSnapshot,
  loadFileWorkspaceSnapshot,
  replayWorkspaceProjection,
  validateFileWorkspaceSnapshot,
} from "../../src/storage/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const ids = {
  workspace: "00000000-0000-4000-8000-000000000001",
  human: "00000000-0000-4000-8000-000000000002",
  agent: "00000000-0000-4000-8000-000000000003",
  repository: "00000000-0000-4000-8000-000000000004",
  task: "00000000-0000-4000-8000-000000000005",
  message: "00000000-0000-4000-8000-000000000006",
  run: "00000000-0000-4000-8000-000000000007",
  attempt: "00000000-0000-4000-8000-000000000008",
  event: "00000000-0000-4000-8000-000000000009",
} as const;
const createdAt = new Date("2026-08-13T01:02:03.000Z");

function fixture(): {
  workspace: Workspace;
  actors: Actor[];
  repository: Repository;
  thread: TaskThread;
  agentProfile: AgentProfile;
} {
  const workspace: Workspace = {
    id: ids.workspace,
    slug: "mob",
    name: "Mob",
    createdAt,
    updatedAt: createdAt,
  };
  const actors: Actor[] = [
    {
      id: ids.human,
      workspaceId: ids.workspace,
      kind: "human",
      handle: "clock",
      displayName: "Clock",
      status: "active",
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: ids.agent,
      workspaceId: ids.workspace,
      kind: "agent",
      handle: "builder",
      displayName: "Builder",
      status: "active",
      createdAt,
      updatedAt: createdAt,
    },
  ];
  const repository: Repository = {
    id: ids.repository,
    workspaceId: ids.workspace,
    name: "mob",
    kind: "git",
    remoteUrl: "https://github.com/cdotlock/mob-agent-crew",
    localPath: null,
    defaultBranch: "main",
    allowlisted: true,
    enabled: true,
    createdByActorId: ids.human,
    createdAt,
    updatedAt: createdAt,
  };
  const agentProfile: AgentProfile = {
    actorId: ids.agent,
    workspaceId: ids.workspace,
    ownerActorId: ids.human,
    driver: "pi",
    home: `/data/agents/${ids.agent}`,
    role: "Builder",
    modelId: null,
    skillRefs: [],
    pluginRefs: [],
    environment: { reference: null, values: {} },
    capabilities: { streaming: true, steer: true, followUp: true, resume: false, nativeCancel: true },
    maxConcurrentRuns: 1,
    createdAt,
    updatedAt: createdAt,
  };
  const task: Task = {
    id: ids.task,
    workspaceId: ids.workspace,
    repositoryId: ids.repository,
    executionConversationId: null,
    isExecution: false,
    createdByActorId: ids.human,
    assignedActorId: ids.agent,
    title: "Replay",
    description: "Recover files",
    baseRevision: "abc1234",
    branchName: null,
    status: "active",
    maxDelegationDepth: 2,
    runBudget: 8,
    writerFence: 2n,
    createdAt,
    updatedAt: createdAt,
  };
  const message: Message = {
    id: ids.message,
    workspaceId: ids.workspace,
    taskId: ids.task,
    conversationId: ids.task,
    actorId: ids.human,
    sourceRunId: null,
    kind: "comment",
    body: "@builder recover this",
    mentions: [ids.agent],
    createdAt,
  };
  const run: Run = {
    id: ids.run,
    workspaceId: ids.workspace,
    taskId: ids.task,
    conversationId: ids.task,
    triggerMessageId: ids.message,
    agentActorId: ids.agent,
    requestedByActorId: ids.human,
    delegationId: null,
    status: "running",
    priority: 0,
    writerRequired: true,
    latestAttemptNumber: 1,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
  };
  const attempt: RunAttempt = {
    id: ids.attempt,
    workspaceId: ids.workspace,
    taskId: ids.task,
    runId: ids.run,
    attemptNumber: 1,
    status: "running",
    workerId: "lost-worker",
    leaseToken: null,
    fence: 2n,
    writerFence: 2n,
    leaseExpiresAt: createdAt,
    startedAt: createdAt,
    completedAt: null,
    failureCode: null,
    failureMessage: null,
    createdAt,
    updatedAt: createdAt,
  };
  const event: RunEvent = {
    id: ids.event,
    workspaceId: ids.workspace,
    taskId: ids.task,
    runId: ids.run,
    attemptId: ids.attempt,
    sequence: 1,
    type: "run.started",
    payload: {},
    createdAt,
  };
  return {
    workspace,
    actors,
    repository,
    agentProfile,
    thread: {
      task,
      conversations: [{
        id: ids.task,
        workspaceId: ids.workspace,
        taskId: ids.task,
        activeRepositoryId: null,
        kind: "group",
        title: task.title,
        createdByActorId: ids.human,
        isPrimary: true,
        createdAt,
        updatedAt: createdAt,
      }],
      conversationMemberships: [
        { workspaceId: ids.workspace, conversationId: ids.task, actorId: ids.human, joinedAt: createdAt },
        { workspaceId: ids.workspace, conversationId: ids.task, actorId: ids.agent, joinedAt: createdAt },
      ],
      messages: [message],
      delegations: [],
      runs: [run],
      attempts: [attempt],
      events: [event],
      artifacts: [],
      approvals: [],
    },
  };
}

async function persistedFixture(): Promise<{ files: FileWorkspaceStore; snapshot: Awaited<ReturnType<typeof loadFileWorkspaceSnapshot>> }> {
  const dataDir = await mkdtemp(join(tmpdir(), "mob-replay-"));
  directories.push(dataDir);
  const files = new FileWorkspaceStore({ dataDir });
  const value = fixture();
  await files.writeWorkspace(value.workspace);
  for (const actor of value.actors) await files.writeActor(actor);
  await files.writeAgentProfile(value.agentProfile);
  await files.writeRepository(value.repository);
  await files.exportTaskThread(value.thread);
  return { files, snapshot: await loadFileWorkspaceSnapshot(files, ids.workspace) };
}

describe("file projection replay", () => {
  it("loads a deterministic workspace snapshot and validates its graph", async () => {
    const { snapshot } = await persistedFixture();

    expect(snapshot.actors.map((actor) => actor.id)).toEqual([ids.human, ids.agent]);
    expect(validateFileWorkspaceSnapshot(snapshot)).toEqual([]);
    expect(countFileWorkspaceSnapshot(snapshot)).toMatchObject({
      workspaces: 1,
      actors: 2,
      agent_profiles: 1,
      repositories: 1,
      tasks: 1,
      messages: 1,
      message_mentions: 1,
      runs: 1,
      run_attempts: 1,
      run_events: 1,
    });
  });

  it("normalizes legacy profile files that predate composition metadata", async () => {
    const { files } = await persistedFixture();
    const path = join(
      files.workspaceRoot(ids.workspace),
      "agents",
      ids.agent,
      "profile.json",
    );
    const envelope = JSON.parse(await readFile(path, "utf8")) as { data: Record<string, unknown> };
    delete envelope.data.modelId;
    delete envelope.data.skillRefs;
    delete envelope.data.pluginRefs;
    delete envelope.data.environment;
    await writeFile(path, `${JSON.stringify(envelope)}\n`, "utf8");

    const snapshot = await loadFileWorkspaceSnapshot(files, ids.workspace);

    expect(snapshot.agentProfiles[0]).toMatchObject({
      modelId: null,
      skillRefs: [],
      pluginRefs: [],
      environment: { reference: null, values: {} },
    });
    expect(validateFileWorkspaceSnapshot(snapshot)).toEqual([]);
  });

  it("reports broken references before touching PostgreSQL", async () => {
    const { snapshot } = await persistedFixture();
    snapshot.conversationThreads[0]!.messages[0]!.actorId =
      "00000000-0000-4000-8000-999999999999";

    expect(validateFileWorkspaceSnapshot(snapshot)).toContainEqual(expect.objectContaining({
      code: "missing_reference",
      path: `messages/${ids.message}.actorId`,
    }));
  });

  it("is read-only by default and requires exact confirmation to apply", async () => {
    const { files } = await persistedFixture();
    const statements: string[] = [];
    const sql = fakeDatabase(statements);

    const dryRun = await replayWorkspaceProjection({ sql, files, workspaceId: ids.workspace });
    expect(dryRun).toMatchObject({ mode: "dry-run", valid: true, applied: false });
    expect(statements.some((statement) => statement.startsWith("INSERT"))).toBe(false);

    await expect(replayWorkspaceProjection({
      sql,
      files,
      workspaceId: ids.workspace,
      apply: true,
      confirmation: "wrong-workspace",
    })).rejects.toMatchObject({ code: "confirmation_required" });
  });

  it("applies file rows without rebuilding operational tables", async () => {
    const { files } = await persistedFixture();
    const statements: string[] = [];
    const sql = fakeDatabase(statements);

    const result = await replayWorkspaceProjection({
      sql,
      files,
      workspaceId: ids.workspace,
      apply: true,
      confirmation: ids.workspace,
    });

    expect(result.applied).toBe(true);
    expect(statements).toContain("SELECT pg_advisory_xact_lock(514509012320260814)");
    expect(statements.some((statement) => statement.startsWith("INSERT INTO messages"))).toBe(true);
    expect(statements.some((statement) => statement.startsWith("INSERT INTO agent_profiles"))).toBe(true);
    expect(statements.some((statement) => statement.includes("model_id"))).toBe(true);
    for (const operational of ["user_auth_records", "repository_imports", "task_writer_leases"]) {
      expect(statements.some((statement) => new RegExp(`(?:INSERT INTO|DELETE FROM|UPDATE) ${operational}`).test(statement))).toBe(false);
    }
  });
});

function fakeDatabase(statements: string[]): DatabaseClient {
  const unsafe = async (
    query: string,
    parameters: unknown[] = [],
  ): Promise<Array<Record<string, string>>> => {
    statements.push(query.trim());
    if (query.includes("jsonb_to_recordset")) {
      // postgres.js serializes a pre-stringified value as a JSON string. Replay
      // must bind the actual array or PostgreSQL rejects recordset expansion.
      expect(Array.isArray(parameters[0])).toBe(true);
    }
    if (query.includes("AS active_runs")) {
      return [{
        active_runs: "0",
        active_attempts: "0",
        active_writer_leases: "0",
        pending_repository_imports: "0",
        auth_records: "1",
        agent_profiles: "1",
      }];
    }
    if (query.includes("'workspaces' AS entity")) return [];
    return [];
  };
  const transaction = { unsafe };
  return {
    unsafe,
    begin: async (callback: (sql: typeof transaction) => Promise<unknown>) => callback(transaction),
  } as unknown as DatabaseClient;
}
