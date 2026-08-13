import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { CollaborationStore, CreateMessageInput } from "../src/db/store.js";
import type { FileWorkspaceStore } from "../src/storage/index.js";
import { issueRunToken, issueSessionToken } from "../src/auth/tokens.js";
import { buildApp } from "../src/server/app.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const TASK_ID = "44444444-4444-4444-8444-444444444444";
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
const MOB_AI_KEY = "mob-security-regression-secret-1234567890";

const openApps: Array<{ close(): Promise<void> }> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("server Agent security boundaries", () => {
  it("keeps human @mentions active but never enqueues Agent @mentions from mob say", async () => {
    const fixture = await createFixture();
    const humanToken = issueSessionToken(
      { actorId: HUMAN_ID, workspaceId: WORKSPACE_ID },
      SESSION_SECRET,
    );
    const runToken = issueRunToken(
      { actorId: AGENT_ID, workspaceId: WORKSPACE_ID, taskId: TASK_ID, runId: RUN_ID },
      SESSION_SECRET,
    );

    const humanResponse = await fixture.app.inject({
      method: "POST",
      url: `/api/tasks/${TASK_ID}/messages`,
      headers: { authorization: `Bearer ${humanToken}` },
      payload: { content: "@builder please start" },
    });
    const runResponse = await fixture.app.inject({
      method: "POST",
      url: `/api/tasks/${TASK_ID}/messages`,
      headers: { authorization: `Bearer ${runToken}` },
      payload: { content: "@builder this is progress, not a delegation" },
    });

    expect(humanResponse.statusCode).toBe(200);
    expect(runResponse.statusCode).toBe(200);
    expect(fixture.createMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        actorId: HUMAN_ID,
        enqueueMentionedAgents: true,
      }),
    );
    expect(fixture.createMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        actorId: AGENT_ID,
        sourceRunId: RUN_ID,
        enqueueMentionedAgents: false,
      }),
    );
  });

  it("redacts run credentials from every knowledge field while preserving human-authored text", async () => {
    const fixture = await createFixture();
    const runToken = issueRunToken(
      { actorId: AGENT_ID, workspaceId: WORKSPACE_ID, taskId: TASK_ID, runId: RUN_ID },
      SESSION_SECRET,
    );
    const humanToken = issueSessionToken(
      { actorId: HUMAN_ID, workspaceId: WORKSPACE_ID },
      SESSION_SECRET,
    );
    const runPath = `docs/${MOB_AI_KEY}.md`;
    const runResponse = await fixture.app.inject({
      method: "POST",
      url: "/api/knowledge/wiki",
      headers: { authorization: `Bearer ${runToken}` },
      payload: {
        path: runPath,
        content: `# Runtime\n\nprovider=${MOB_AI_KEY}\ntoken=${runToken}`,
        source: `agent:${MOB_AI_KEY}:${runToken}`,
        metadata: {
          credentials: `Bearer ${runToken} ${MOB_AI_KEY}`,
          count: 1,
        },
      },
    });

    expect(runResponse.statusCode).toBe(200);
    expect(runResponse.json()).toMatchObject({ path: "wiki/docs/[REDACTED].md" });
    const serializedRunResponse = runResponse.body;
    expect(serializedRunResponse).not.toContain(MOB_AI_KEY);
    expect(serializedRunResponse).not.toContain(runToken);

    const knowledgeRoot = join(fixture.workspaceRoot, "knowledge");
    const runDocument = await readFile(join(knowledgeRoot, "wiki/docs/[REDACTED].md"), "utf8");
    const runManifest = await readKnowledgeManifest(knowledgeRoot, "wiki/docs/[REDACTED].md");
    expect(`${runDocument}\n${runManifest}`).not.toContain(MOB_AI_KEY);
    expect(`${runDocument}\n${runManifest}`).not.toContain(runToken);
    expect(runManifest).toContain("[REDACTED]");

    const humanPath = "docs/human-secret.md";
    const humanResponse = await fixture.app.inject({
      method: "POST",
      url: "/api/knowledge/wiki",
      headers: { authorization: `Bearer ${humanToken}` },
      payload: {
        path: humanPath,
        content: `# Human note\n\n${MOB_AI_KEY}`,
        source: `human:${MOB_AI_KEY}`,
        metadata: { note: MOB_AI_KEY },
      },
    });

    expect(humanResponse.statusCode).toBe(200);
    expect(humanResponse.json()).toMatchObject({ path: `wiki/${humanPath}` });
    const humanDocument = await readFile(join(knowledgeRoot, "wiki", humanPath), "utf8");
    const humanManifest = await readKnowledgeManifest(knowledgeRoot, `wiki/${humanPath}`);
    expect(humanDocument).toContain(MOB_AI_KEY);
    expect(humanManifest).toContain(MOB_AI_KEY);
  });
});

async function createFixture(): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  createMessage: ReturnType<typeof vi.fn<(input: CreateMessageInput) => Promise<unknown>>>;
  workspaceRoot: string;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "mob-server-security-"));
  temporaryDirectories.push(dataDir);
  const workspaceRoot = join(dataDir, "state", "workspaces", WORKSPACE_ID);
  const createMessage = vi.fn(async (input: CreateMessageInput) => ({
    message: {
      id: "66666666-6666-4666-8666-666666666666",
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      actorId: input.actorId,
      sourceRunId: input.sourceRunId ?? null,
      kind: input.kind ?? "comment",
      body: input.body,
      mentions: [],
      createdAt: new Date("2026-08-13T00:00:00.000Z"),
    },
    queuedRuns: [],
  }));
  const store = {
    getTask: vi.fn(async (id: string) => id === TASK_ID
      ? { id: TASK_ID, workspaceId: WORKSPACE_ID }
      : null),
    createMessage,
    getTaskThread: vi.fn(async () => ({})),
  } as unknown as CollaborationStore;
  const files = {
    workspaceRoot: vi.fn(() => workspaceRoot),
    repairTaskThread: vi.fn(async () => ({ root: "", written: 0, paths: [], removed: 0 })),
  } as unknown as FileWorkspaceStore;
  const app = await buildApp({ config: testConfig(dataDir), store, files });
  openApps.push(app);
  return { app, createMessage, workspaceRoot };
}

function testConfig(dataDir: string): AppConfig {
  return {
    nodeEnv: "test",
    databaseUrl: "postgres://unused",
    host: "127.0.0.1",
    port: 4310,
    dataDir,
    embeddedWorker: false,
    workerConcurrency: 1,
    enableMockDriver: false,
    sessionSecret: SESSION_SECRET,
    adminName: "Test Admin",
    bootstrapRepositoryUrl: "https://github.com/example/repository",
    mobAiKey: MOB_AI_KEY,
    mobAiBaseUrl: "https://ai.example.test/api",
    mobAiModel: "test-model",
  };
}

async function readKnowledgeManifest(root: string, path: string): Promise<string> {
  const filename = `${createHash("sha256").update(path).digest("hex").slice(0, 32)}.json`;
  return readFile(join(root, "manifests/documents", filename), "utf8");
}
