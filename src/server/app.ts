import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import type { AppConfig } from "../config.js";
import type { CollaborationStore } from "../db/store.js";
import { StoreError } from "../db/store.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import { issueSessionToken, verifyToken, type TokenClaims } from "../auth/tokens.js";
import { normalizeGitHubRepositoryUrl } from "../domain/rules.js";
import { parseMarkdownImport } from "../imports/context-imports.js";
import type { MobWorker } from "../worker/worker.js";
import { writeMobAiProviderConfig } from "../agents/mob-ai-config.js";
import { redactText } from "../security/redaction.js";

const sessionCookie = "mob_session";

type AppDependencies = {
  config: AppConfig;
  store: CollaborationStore;
  worker?: MobWorker;
};

declare module "fastify" {
  interface FastifyRequest {
    mobActor?: TokenClaims;
  }
}

export async function ensureBootstrap(config: AppConfig, store: CollaborationStore): Promise<void> {
  let workspace = await store.getWorkspaceBySlug("crew");
  let owner: { id: string } | undefined;
  if (!workspace) {
    if (!config.adminEmail || !config.adminPassword) {
      throw new Error("MOB_ADMIN_EMAIL and MOB_ADMIN_PASSWORD are required for first startup");
    }
    const passwordHash = await hashPassword(config.adminPassword);
    const created = await store.bootstrap({
      slug: "crew",
      name: "Mob Agent Crew",
      owner: {
        handle: "admin",
        displayName: config.adminName,
        provider: "password",
        subject: config.adminEmail.toLowerCase(),
        email: config.adminEmail.toLowerCase(),
        passwordHash,
      },
    });
    workspace = created.workspace;
    owner = created.owner;
  } else {
    owner = (await store.listActors(workspace.id)).find((actor) => actor.kind === "human");
  }
  if (!owner) throw new Error("Bootstrap workspace has no human owner");

  const repositories = await store.listRepositories(workspace.id);
  const repository = repositories[0] ?? await store.createRepository({
      workspaceId: workspace.id,
      name: config.bootstrapRepositoryUrl.split("/").filter(Boolean).at(-1) ?? "workspace",
      kind: "git",
      remoteUrl: normalizeGitHubRepositoryUrl(config.bootstrapRepositoryUrl),
      defaultBranch: "main",
      createdByActorId: owner.id,
    });

  const actors = await store.listActors(workspace.id);

  for (const agent of [
    { handle: "builder", name: "Builder", role: "Implementation agent", driver: "omp" },
    { handle: "reviewer", name: "Reviewer", role: "Review and risk agent", driver: "pi" },
  ]) {
    const actor = actors.find((item) => item.handle === agent.handle) ?? await store.createActor({
        workspaceId: workspace.id,
        kind: "agent",
        handle: agent.handle,
        displayName: agent.name,
      });
    const home = resolve(config.dataDir, "agents", actor.id);
    await writeMobAiProviderConfig({ directory: home, baseUrl: config.mobAiBaseUrl, model: config.mobAiModel });
    const profileRows = await store.sql<Array<{ actor_id: string }>>`
      SELECT actor_id FROM agent_profiles WHERE actor_id = ${actor.id}
    `;
    if (profileRows.length === 0) {
      await store.createAgentProfile({
        workspaceId: workspace.id,
        actorId: actor.id,
        ownerActorId: owner.id,
        driver: agent.driver,
        home,
        role: agent.role,
        capabilities: {
          streaming: true,
          steer: true,
          followUp: true,
          resume: false,
          nativeCancel: true,
        },
      });
    }
  }

  const existingTasks = await store.listTasks(workspace.id, 1);
  if (existingTasks.length > 0) return;
  const task = await store.createTask({
    workspaceId: workspace.id,
    repositoryId: repository.id,
    createdByActorId: owner.id,
    title: "Welcome to the shared agent workspace",
    description: "Chat with your team, attach Markdown context, import a GitHub repository, and @mention an agent.",
    baseRevision: "main",
  });
  await store.createMessage({
    taskId: task.id,
    actorId: owner.id,
    body: "This is a shared thread. Try asking @builder for a plan, then ask @reviewer to challenge it.",
    enqueueMentionedAgents: false,
  });
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const { config, store } = dependencies;
  const app = Fastify({ logger: true, trustProxy: true });
  await app.register(cookie);
  await app.register(multipart, { limits: { files: 1, fileSize: 1_000_000 } });
  app.addHook("preSerialization", async (_request, _reply, payload) => jsonSafe(payload));

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "invalid_request", message: error.issues[0]?.message ?? "Invalid request" });
    }
    if (error instanceof StoreError) {
      const status = error.code === "not_found" ? 404 : error.code.includes("allowlist") ? 403 : 409;
      return reply.code(status).send({ error: error.code, message: error.message });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "internal_error", message: "The request could not be completed." });
  });

  app.get("/health", async () => {
    await store.sql`SELECT 1`;
    return { ok: true };
  });

  app.post("/api/session", async (request, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(request.body);
    const rows = await store.sql<Array<{ actor_id: string; workspace_id: string; password_hash: string | null }>>`
      SELECT actor_id, workspace_id, password_hash
      FROM user_auth_records
      WHERE provider = 'password' AND lower(email) = ${body.email.toLowerCase()}
      LIMIT 1
    `;
    const auth = rows[0];
    if (!auth?.password_hash || !(await verifyPassword(body.password, auth.password_hash))) {
      return reply.code(401).send({ error: "invalid_credentials", message: "Invalid email or password" });
    }
    const token = issueSessionToken(
      { actorId: auth.actor_id, workspaceId: auth.workspace_id },
      config.sessionSecret,
    );
    reply.setCookie(sessionCookie, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.nodeEnv === "production",
      maxAge: 7 * 24 * 60 * 60,
    });
    return { ok: true };
  });

  app.delete("/api/session", async (_request, reply) => {
    reply.clearCookie(sessionCookie, { path: "/" });
    return reply.code(204).send();
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/") || request.url === "/api/session") return;
    const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/iu)?.[1];
    const token = bearer ?? request.cookies[sessionCookie];
    if (!token) return reply.code(401).send({ error: "authentication_required" });
    try {
      request.mobActor = verifyToken(token, config.sessionSecret, bearer ? "run" : "session");
    } catch {
      return reply.code(401).send({ error: "invalid_session" });
    }
  });

  app.get("/api/bootstrap", async (request) => {
    const actor = requireActor(request);
    const [workspaceRows, userRows, actors, profiles, tasks, repositories] = await Promise.all([
      store.sql<Array<{ id: string; name: string }>>`SELECT id, name FROM workspaces WHERE id = ${actor.workspaceId}`,
      store.sql<Array<{ id: string; display_name: string }>>`SELECT id, display_name FROM actors WHERE id = ${actor.actorId}`,
      store.listActors(actor.workspaceId),
      store.sql<Array<{ actor_id: string; driver: string; role: string; capabilities: Record<string, boolean> }>>`
        SELECT actor_id, driver, role, capabilities FROM agent_profiles WHERE workspace_id = ${actor.workspaceId}
      `,
      store.listTasks(actor.workspaceId),
      store.listRepositories(actor.workspaceId),
    ]);
    const profileByActor = new Map(profiles.map((profile) => [profile.actor_id, profile]));
    const repositoryById = new Map(repositories.map((repository) => [repository.id, repository]));
    const currentUser = userRows[0];
    return {
      workspace: { ...workspaceRows[0], environment: config.nodeEnv === "production" ? "Railway" : "Local" },
      currentUser: { id: currentUser?.id, name: currentUser?.display_name },
      tasks: tasks.map((task) => ({
        ...task,
        repository: repositoryById.get(task.repositoryId)?.name ?? "Unknown repository",
        branch: task.branchName ?? task.baseRevision,
        participantIds: task.assignedActorId ? [task.assignedActorId] : [],
      })),
      agents: actors.filter((item) => item.kind === "agent").map((item) => ({
        id: item.id,
        name: item.displayName,
        status: item.status === "active" ? "available" : "offline",
        ...profileByActor.get(item.id),
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request) => {
    const actor = requireActor(request);
    const thread = await store.getTaskThread(request.params.id);
    assertWorkspace(actor, thread.task.workspaceId);
    const [repositories, actors] = await Promise.all([
      store.listRepositories(actor.workspaceId),
      store.listActors(actor.workspaceId),
    ]);
    const repo = repositories.find((item) => item.id === thread.task.repositoryId);
    const actorMap = new Map(actors.map((item) => [item.id, item]));
    return {
      ...thread.task,
      repository: repo?.name,
      branch: thread.task.branchName ?? thread.task.baseRevision,
      messages: thread.messages.map((message) => ({
        ...message,
        content: message.body,
        actorName: actorMap.get(message.actorId)?.displayName,
        actorKind: actorMap.get(message.actorId)?.kind,
        runId: message.sourceRunId,
      })),
      runs: thread.runs.map((run) => ({ ...run, agentId: run.agentActorId, attempt: run.latestAttemptNumber })),
      artifacts: thread.artifacts,
    };
  });

  app.post("/api/tasks", async (request) => {
    const actor = requireHuman(request);
    const body = z.object({
      title: z.string().min(1), repository: z.string().min(1), baseRef: z.string().default("main"),
      initialMessage: z.string().default(""), agentId: z.string().optional(),
    }).parse(request.body);
    const repositories = await store.listRepositories(actor.workspaceId);
    const repository = repositories.find((item) => item.id === body.repository || item.name === body.repository || item.remoteUrl?.includes(body.repository));
    if (!repository) throw new StoreError("repository_not_allowlisted", "Choose an imported, allowlisted repository.");
    const task = await store.createTask({
      workspaceId: actor.workspaceId, repositoryId: repository.id, createdByActorId: actor.actorId,
      assignedActorId: body.agentId || null, title: body.title, description: body.initialMessage,
      baseRevision: body.baseRef || repository.defaultBranch,
    });
    if (body.initialMessage) {
      await store.createMessage({ taskId: task.id, actorId: actor.actorId, body: body.initialMessage, enqueueMentionedAgents: true });
    }
    if (body.agentId) await store.queueRun({ taskId: task.id, agentActorId: body.agentId, requestedByActorId: actor.actorId });
    return store.getTaskThread(task.id);
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/messages", async (request) => {
    const actor = requireActor(request);
    const body = z.object({ content: z.string().min(1).max(20_000) }).parse(request.body);
    const task = await store.getTask(request.params.id);
    if (!task) throw new StoreError("not_found", "Task was not found.");
    assertWorkspace(actor, task.workspaceId);
    const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/iu)?.[1];
    const content = actor.kind === "run"
      ? redactText(body.content, [config.mobAiKey, bearer])
      : body.content;
    return store.createMessage({ taskId: task.id, actorId: actor.actorId, sourceRunId: actor.kind === "run" ? actor.runId : null, body: content, enqueueMentionedAgents: true });
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/delegations", async (request) => {
    const actor = requireActor(request);
    const body = z.object({ agentId: z.string().uuid(), deliverable: z.string().min(1) }).parse(request.body);
    const task = await store.getTask(request.params.id);
    if (!task) throw new StoreError("not_found", "Task was not found.");
    assertWorkspace(actor, task.workspaceId);
    if (actor.kind === "run") {
      return store.createDelegation({ taskId: task.id, fromActorId: actor.actorId, toAgentActorId: body.agentId, sourceRunId: actor.runId, intent: "collaborate", deliverable: body.deliverable });
    }
    return store.queueRun({ taskId: task.id, agentActorId: body.agentId, requestedByActorId: actor.actorId });
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (request) => {
    const actor = requireActor(request);
    await dependencies.worker?.cancelRun(request.params.id);
    return store.cancelRun({ runId: request.params.id, requestedByActorId: actor.actorId });
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/artifacts", async (request, reply) => {
    const actor = requireActor(request);
    const part = await request.file();
    if (!part) return reply.code(400).send({ error: "file_required", message: "Choose a Markdown file." });
    const parsed = parseMarkdownImport(part.filename, (await part.toBuffer()).toString("utf8"));
    const document = await store.createWorkspaceDocument({
      workspaceId: actor.workspaceId, name: parsed.filename, content: parsed.content,
      source: `task:${request.params.id}`, uploadedByActorId: actor.actorId,
    });
    await store.createArtifact({
      taskId: request.params.id, actorId: actor.actorId, sourceRunId: actor.kind === "run" ? actor.runId : null,
      kind: "file", name: parsed.filename, uri: `document:${document.id}`, mediaType: "text/markdown", byteSize: BigInt(parsed.bytes),
      metadata: { title: parsed.title },
    });
    return { context: { ...document, kind: "markdown", summary: `${parsed.bytes} bytes Markdown context` } };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/imports/github", async (request) => {
    const actor = requireHuman(request);
    const body = z.object({ url: z.string().url() }).parse(request.body);
    const repositoryImport = await store.createRepositoryImport(actor.workspaceId, actor.actorId, body.url);
    const name = new URL(repositoryImport.sourceUrl).pathname.split("/").filter(Boolean).at(-1)?.replace(/\.git$/u, "") ?? "repository";
    const completed = await store.completeRepositoryImport(repositoryImport.id, { name });
    return { context: { id: completed.repositoryImport.id, name: completed.repository.name, kind: "github", summary: "Repository imported and allowlisted", content: completed.repository.remoteUrl, sourceUrl: completed.repository.remoteUrl, createdAt: completed.repository.createdAt } };
  });

  const webRoot = resolve(process.cwd(), "web-dist");
  if (existsSync(webRoot)) {
    await app.register(staticPlugin, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") ? reply.code(404).send({ error: "not_found" }) : reply.sendFile("index.html"));
  }
  return app;
}

function requireActor(request: FastifyRequest): TokenClaims {
  if (!request.mobActor) throw new StoreError("authentication_required", "Authentication is required.");
  return request.mobActor;
}

function requireHuman(request: FastifyRequest): Extract<TokenClaims, { kind: "session" }> {
  const actor = requireActor(request);
  if (actor.kind !== "session") throw new StoreError("human_required", "A human account is required.");
  return actor;
}

function assertWorkspace(actor: TokenClaims, workspaceId: string): void {
  if (actor.workspaceId !== workspaceId) throw new StoreError("not_found", "Resource was not found.");
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonSafe(item)]),
    );
  }
  return value;
}
