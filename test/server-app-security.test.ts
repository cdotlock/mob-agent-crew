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
import { agentRuntimeProviderEnvironment } from "../src/worker/worker.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const TASK_ID = "44444444-4444-4444-8444-444444444444";
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const ATTEMPT_ID = "66666666-6666-4666-8666-666666666666";
const CONVERSATION_ID = "77777777-7777-4777-8777-777777777777";
const SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
const MOB_AI_KEY = "mob-security-regression-secret-1234567890";

const openApps: Array<{ close(): Promise<void> }> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("server Agent security boundaries", () => {
  it("allows only an active matching run token to stream through the provider proxy", async () => {
    const fixture = await createFixture();
    const runToken = issueRunToken(
      { actorId: AGENT_ID, workspaceId: WORKSPACE_ID, taskId: TASK_ID, runId: RUN_ID, attemptId: ATTEMPT_ID },
      SESSION_SECRET,
    );
    const chunks = ["data: first\n\n", "data: second\n\n"];
    const upstream = new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
    const text = vi.spyOn(upstream, "text");
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => upstream);
    vi.stubGlobal("fetch", fetchMock);

    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/provider/v1/chat/completions",
      headers: { authorization: `Bearer ${runToken}`, accept: "text/event-stream" },
      payload: { model: "test-model", stream: true, messages: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(chunks.join(""));
    expect(response.body).not.toContain(MOB_AI_KEY);
    expect(text).not.toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${MOB_AI_KEY}`);
    expect(headers.get("authorization")).not.toContain(runToken);
  });

  it("rejects human sessions and mismatched run claims before contacting MobAI", async () => {
    const fixture = await createFixture();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const humanToken = issueSessionToken(
      { actorId: HUMAN_ID, workspaceId: WORKSPACE_ID },
      SESSION_SECRET,
    );
    const mismatchedTokens = [
      issueRunToken({
        actorId: AGENT_ID,
        workspaceId: WORKSPACE_ID,
        taskId: "77777777-7777-4777-8777-777777777777",
        runId: RUN_ID,
        attemptId: ATTEMPT_ID,
      }, SESSION_SECRET),
      issueRunToken({
        actorId: AGENT_ID,
        workspaceId: "88888888-8888-4888-8888-888888888888",
        taskId: TASK_ID,
        runId: RUN_ID,
        attemptId: ATTEMPT_ID,
      }, SESSION_SECRET),
      issueRunToken({
        actorId: "99999999-9999-4999-8999-999999999999",
        workspaceId: WORKSPACE_ID,
        taskId: TASK_ID,
        runId: RUN_ID,
        attemptId: ATTEMPT_ID,
      }, SESSION_SECRET),
    ];

    const human = await fixture.app.inject({
      method: "POST",
      url: "/api/provider/v1/responses",
      headers: { authorization: `Bearer ${humanToken}` },
      payload: {},
    });
    const mismatched = await Promise.all(mismatchedTokens.map((token) => fixture.app.inject({
      method: "POST",
      url: "/api/provider/v1/messages",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })));
    const disallowed = await fixture.app.inject({
      method: "POST",
      url: "/api/provider/v1/models",
      headers: { authorization: `Bearer ${mismatchedTokens[0]}` },
      payload: {},
    });

    expect(human.statusCode).toBe(403);
    expect(mismatched.map((response) => response.statusCode)).toEqual([404, 404, 404]);
    expect(disallowed.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revokes a completed run token across every Agent write surface", async () => {
    const fixture = await createFixture({
      runStatus: "succeeded",
      attemptStatus: "succeeded",
      leaseActive: false,
    });
    const runToken = issueRunToken(
      { actorId: AGENT_ID, workspaceId: WORKSPACE_ID, taskId: TASK_ID, runId: RUN_ID, attemptId: ATTEMPT_ID },
      SESSION_SECRET,
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const headers = { authorization: `Bearer ${runToken}` };
    const requests = [
      { url: "/api/provider/v1/responses", payload: {} },
      { url: `/api/tasks/${TASK_ID}/messages`, payload: { content: "late result" } },
      { url: `/api/conversations/${CONVERSATION_ID}/messages`, payload: { content: "late result" } },
      {
        url: `/api/tasks/${TASK_ID}/delegations`,
        payload: { agentId: AGENT_ID, deliverable: "late delegation" },
      },
      { url: `/api/tasks/${TASK_ID}/artifacts`, payload: undefined },
      {
        url: "/api/knowledge/wiki",
        payload: { path: "late.md", content: "must not be written" },
      },
      { url: "/api/knowledge/rebuild", payload: undefined },
    ];

    for (const request of requests) {
      const response = await fixture.app.inject({
        method: "POST",
        url: request.url,
        headers,
        ...(request.payload === undefined ? {} : { payload: request.payload }),
      });
      expect(response.statusCode, request.url).toBe(404);
      expect(response.json(), request.url).toMatchObject({ error: "not_found" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fixture.createMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["terminal latest attempt", { runStatus: "running", attemptStatus: "succeeded", leaseActive: true }],
    ["expired latest attempt lease", { runStatus: "running", attemptStatus: "running", leaseActive: false }],
  ])("rejects an otherwise matching token when the run has a %s", async (_case, runState) => {
    const fixture = await createFixture(runState);
    const runToken = issueRunToken(
      { actorId: AGENT_ID, workspaceId: WORKSPACE_ID, taskId: TASK_ID, runId: RUN_ID, attemptId: ATTEMPT_ID },
      SESSION_SECRET,
    );

    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/tasks/${TASK_ID}/messages`,
      headers: { authorization: `Bearer ${runToken}` },
      payload: { content: "late result" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "not_found" });
    expect(fixture.createMessage).not.toHaveBeenCalled();
  });

  it("keeps an old attempt token revoked while a retry attempt is active", async () => {
    const retryAttemptId = "88888888-8888-4888-8888-888888888888";
    const fixture = await createFixture({ attemptId: retryAttemptId });
    const oldAttemptToken = issueRunToken(
      {
        actorId: AGENT_ID,
        workspaceId: WORKSPACE_ID,
        taskId: TASK_ID,
        runId: RUN_ID,
        attemptId: ATTEMPT_ID,
      },
      SESSION_SECRET,
    );

    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/tasks/${TASK_ID}/messages`,
      headers: { authorization: `Bearer ${oldAttemptToken}` },
      payload: { content: "stale attempt must stay revoked" },
    });

    expect(response.statusCode).toBe(404);
    expect(fixture.createConversationMessage).not.toHaveBeenCalled();
  });

  it("puts only the scoped run token, never the server MobAI key, in Agent provider env", () => {
    const runToken = "signed-run-token";
    const env = agentRuntimeProviderEnvironment(testConfig("/tmp/mob-provider-test"), runToken);

    expect(env).toEqual({
      MOB_AI_KEY: runToken,
      MOB_AI_BASE_URL: "http://127.0.0.1:4310/api/provider",
    });
    expect(JSON.stringify(env)).not.toContain(MOB_AI_KEY);
  });

  it("keeps human @mentions active but never enqueues Agent @mentions from mob say", async () => {
    const fixture = await createFixture();
    const humanToken = issueSessionToken(
      { actorId: HUMAN_ID, workspaceId: WORKSPACE_ID },
      SESSION_SECRET,
    );
    const runToken = issueRunToken(
      { actorId: AGENT_ID, workspaceId: WORKSPACE_ID, taskId: TASK_ID, runId: RUN_ID, attemptId: ATTEMPT_ID },
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
    expect(fixture.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: HUMAN_ID,
        enqueueMentionedAgents: true,
      }),
    );
    expect(fixture.createConversationMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        actorId: AGENT_ID,
        sourceRunId: RUN_ID,
      }),
    );
  });

  it("redacts run credentials from every knowledge field while preserving human-authored text", async () => {
    const fixture = await createFixture();
    const runToken = issueRunToken(
      { actorId: AGENT_ID, workspaceId: WORKSPACE_ID, taskId: TASK_ID, runId: RUN_ID, attemptId: ATTEMPT_ID },
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
        source: `agent:${runToken}`,
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

async function createFixture(options: {
  runStatus?: string;
  attemptStatus?: string;
  leaseActive?: boolean;
  attemptId?: string;
} = {}): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  createMessage: ReturnType<typeof vi.fn<(input: CreateMessageInput) => Promise<unknown>>>;
  createConversationMessage: ReturnType<typeof vi.fn>;
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
  const createConversationMessage = vi.fn(async (input: CreateMessageInput & { conversationId: string }) => ({
    message: {
      id: "99999999-9999-4999-8999-999999999999",
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      conversationId: input.conversationId,
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
    createConversationMessage,
    getTaskThread: vi.fn(async () => ({})),
    sql: vi.fn(async () => [{
      task_id: TASK_ID,
      workspace_id: WORKSPACE_ID,
      agent_actor_id: AGENT_ID,
      conversation_id: CONVERSATION_ID,
      attempt_id: options.attemptId ?? ATTEMPT_ID,
      run_status: options.runStatus ?? "running",
      attempt_status: options.attemptStatus ?? "running",
      lease_active: options.leaseActive ?? true,
    }]),
  } as unknown as CollaborationStore;
  const files = {
    workspaceRoot: vi.fn(() => workspaceRoot),
    repairTaskThread: vi.fn(async () => ({ root: "", written: 0, paths: [], removed: 0 })),
  } as unknown as FileWorkspaceStore;
  const app = await buildApp({ config: testConfig(dataDir), store, files });
  openApps.push(app);
  return { app, createMessage, createConversationMessage, workspaceRoot };
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
