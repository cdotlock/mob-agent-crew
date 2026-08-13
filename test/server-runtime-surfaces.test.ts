import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueSessionToken } from "../src/auth/tokens.js";
import type { AppConfig } from "../src/config.js";
import type { CollaborationStore } from "../src/db/store.js";
import { buildApp } from "../src/server/app.js";
import type { FileWorkspaceStore } from "../src/storage/index.js";
import type { MobWorker } from "../src/worker/worker.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const OUTSIDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const CONVERSATION_ID = "55555555-5555-4555-8555-555555555555";
const ARTIFACT_ID = "66666666-6666-4666-8666-666666666666";
const SECRET = "runtime-surface-secret-longer-than-thirty-two";
const temporaryDirectories: string[] = [];
const apps: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("runtime control surfaces", () => {
  it("serves contained repository files and sends one command to the active worker", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mob-runtime-surface-"));
    temporaryDirectories.push(dataDir);
    await mkdir(join(dataDir, "tasks", TASK_ID), { recursive: true });
    await writeFile(join(dataDir, "tasks", TASK_ID, "README.md"), "# Working tree\n");
    const task = { id: TASK_ID, workspaceId: WORKSPACE_ID };
    const store = {
      getTask: vi.fn(async () => task),
      canActorAccessConversation: vi.fn(async (_conversationId: string, actorId: string) => actorId === HUMAN_ID),
      canActorAccessTaskRepository: vi.fn(async (_taskId: string, actorId: string) => actorId === HUMAN_ID),
      sql: vi.fn(async () => [{
        id: RUN_ID,
        task_id: TASK_ID,
        workspace_id: WORKSPACE_ID,
        conversation_id: CONVERSATION_ID,
      }]),
    } as unknown as CollaborationStore;
    const worker = {
      sendRunCommand: vi.fn(async () => ({ accepted: true, command: "steer" as const })),
    } as unknown as MobWorker;
    const app = await buildApp({
      config: config(dataDir),
      store,
      files: { workspaceRoot: vi.fn() } as unknown as FileWorkspaceStore,
      worker,
    });
    apps.push(app);
    const authorization = `Bearer ${issueSessionToken({ actorId: HUMAN_ID, workspaceId: WORKSPACE_ID }, SECRET)}`;

    const files = await app.inject({
      method: "GET",
      url: `/api/files?scope=repository&taskId=${TASK_ID}&path=`,
      headers: { authorization },
    });
    expect(files.statusCode).toBe(200);
    expect(files.json()).toMatchObject({ entries: [expect.objectContaining({ name: "README.md" })] });

    const command = await app.inject({
      method: "POST",
      url: `/api/runs/${RUN_ID}/commands`,
      headers: { authorization },
      payload: { type: "steer", message: "Focus on the current failure" },
    });
    expect(command.statusCode).toBe(200);
    expect(worker.sendRunCommand).toHaveBeenCalledWith(RUN_ID, {
      type: "steer",
      message: "Focus on the current failure",
    });
  });

  it("blocks a non-member from reading or controlling a direct-chat run", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mob-runtime-acl-"));
    temporaryDirectories.push(dataDir);
    const sql = vi.fn(async () => [{
      id: RUN_ID,
      task_id: TASK_ID,
      workspace_id: WORKSPACE_ID,
      conversation_id: CONVERSATION_ID,
      agent_actor_id: "77777777-7777-4777-8777-777777777777",
      status: "running",
      latest_attempt_number: 1,
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: null,
      attempt_status: "running",
      started_at: new Date(),
      failure_code: null,
      failure_message: null,
    }]);
    const store = {
      sql,
      canActorAccessConversation: vi.fn(async (_conversationId: string, actorId: string) => actorId === HUMAN_ID),
    } as unknown as CollaborationStore;
    const worker = {
      sendRunCommand: vi.fn(async () => ({ accepted: true, command: "steer" as const })),
      cancelRun: vi.fn(async () => undefined),
    } as unknown as MobWorker;
    const app = await buildApp({
      config: config(dataDir),
      store,
      files: { workspaceRoot: vi.fn() } as unknown as FileWorkspaceStore,
      worker,
    });
    apps.push(app);

    for (const request of [
      { method: "GET" as const, url: `/api/runs/${RUN_ID}` },
      { method: "GET" as const, url: `/api/runs/${RUN_ID}/events` },
      { method: "POST" as const, url: `/api/runs/${RUN_ID}/commands`, payload: { type: "steer", message: "leak" } },
      { method: "POST" as const, url: `/api/runs/${RUN_ID}/cancel` },
    ]) {
      const response = await app.inject({
        ...request,
        headers: { authorization: authorizationFor(OUTSIDER_ID) },
      });
      expect(response.statusCode, request.url).toBe(404);
    }
    expect(worker.sendRunCommand).not.toHaveBeenCalled();
    expect(worker.cancelRun).not.toHaveBeenCalled();

    const member = await app.inject({
      method: "GET",
      url: `/api/runs/${RUN_ID}`,
      headers: { authorization: authorizationFor(HUMAN_ID) },
    });
    expect(member.statusCode).toBe(200);
  });

  it("blocks direct-chat artifact downloads and repository browsing for non-members", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mob-artifact-acl-"));
    temporaryDirectories.push(dataDir);
    const artifactPath = join(dataDir, "artifacts", TASK_ID, "private.md");
    await mkdir(join(dataDir, "artifacts", TASK_ID), { recursive: true });
    await mkdir(join(dataDir, "tasks", TASK_ID), { recursive: true });
    await writeFile(artifactPath, "private result\n");
    await writeFile(join(dataDir, "tasks", TASK_ID, "README.md"), "# Private worktree\n");
    const store = {
      getTask: vi.fn(async () => ({ id: TASK_ID, workspaceId: WORKSPACE_ID })),
      canActorAccessConversation: vi.fn(async (_conversationId: string, actorId: string) => actorId === HUMAN_ID),
      canActorAccessTaskRepository: vi.fn(async (_taskId: string, actorId: string) => actorId === HUMAN_ID),
      sql: vi.fn(async () => [{
        workspace_id: WORKSPACE_ID,
        task_id: TASK_ID,
        conversation_id: CONVERSATION_ID,
        source_run_id: RUN_ID,
        name: "private.md",
        uri: `file:${artifactPath}`,
        media_type: "text/markdown",
      }]),
    } as unknown as CollaborationStore;
    const app = await buildApp({
      config: config(dataDir),
      store,
      files: { workspaceRoot: vi.fn() } as unknown as FileWorkspaceStore,
    });
    apps.push(app);

    for (const url of [
      `/api/artifacts/${ARTIFACT_ID}/download`,
      `/api/files?scope=repository&taskId=${TASK_ID}&path=`,
      `/api/files/content?scope=repository&taskId=${TASK_ID}&path=README.md`,
    ]) {
      const denied = await app.inject({
        method: "GET",
        url,
        headers: { authorization: authorizationFor(OUTSIDER_ID) },
      });
      expect(denied.statusCode, url).toBe(404);
    }

    const artifact = await app.inject({
      method: "GET",
      url: `/api/artifacts/${ARTIFACT_ID}/download`,
      headers: { authorization: authorizationFor(HUMAN_ID) },
    });
    const repository = await app.inject({
      method: "GET",
      url: `/api/files?scope=repository&taskId=${TASK_ID}&path=`,
      headers: { authorization: authorizationFor(HUMAN_ID) },
    });
    expect(artifact.statusCode).toBe(200);
    expect(artifact.body).toBe("private result\n");
    expect(repository.statusCode).toBe(200);
  });

  it("exposes only knowledge and documents from the workspace file ledger", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mob-workspace-files-acl-"));
    temporaryDirectories.push(dataDir);
    const workspaceRoot = join(dataDir, "state", "workspaces", WORKSPACE_ID);
    await mkdir(join(workspaceRoot, "knowledge"), { recursive: true });
    await mkdir(join(workspaceRoot, "documents"), { recursive: true });
    await mkdir(join(workspaceRoot, "tasks", TASK_ID, "conversations", CONVERSATION_ID), { recursive: true });
    await writeFile(join(workspaceRoot, "knowledge", "index.md"), "# Shared knowledge\n");
    await writeFile(join(workspaceRoot, "tasks", TASK_ID, "conversations", CONVERSATION_ID, "messages.md"), "private\n");
    const store = {
      getTask: vi.fn(async () => ({ id: TASK_ID, workspaceId: WORKSPACE_ID })),
      canActorAccessTaskRepository: vi.fn(async () => true),
    } as unknown as CollaborationStore;
    const app = await buildApp({
      config: config(dataDir),
      store,
      files: { workspaceRoot: vi.fn(() => workspaceRoot) } as unknown as FileWorkspaceStore,
    });
    apps.push(app);

    const root = await app.inject({
      method: "GET",
      url: `/api/files?scope=workspace&taskId=${TASK_ID}&path=`,
      headers: { authorization: authorizationFor(HUMAN_ID) },
    });
    expect(root.statusCode).toBe(200);
    expect(root.json().entries.map((entry: { name: string }) => entry.name)).toEqual(["documents", "knowledge"]);

    const denied = await app.inject({
      method: "GET",
      url: `/api/files/content?scope=workspace&taskId=${TASK_ID}&path=tasks/${TASK_ID}/conversations/${CONVERSATION_ID}/messages.md`,
      headers: { authorization: authorizationFor(HUMAN_ID) },
    });
    expect(denied.statusCode).toBe(404);
  });
});

function authorizationFor(actorId: string): string {
  return `Bearer ${issueSessionToken({ actorId, workspaceId: WORKSPACE_ID }, SECRET)}`;
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
    mobAiBaseUrl: "https://example.test/api",
    mobAiModel: "test-model",
  };
}
