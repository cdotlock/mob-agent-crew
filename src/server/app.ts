import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { basename, extname, join, resolve } from "node:path";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import type { AppConfig } from "../config.js";
import type { CollaborationStore } from "../db/store.js";
import { StoreError } from "../db/store.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import { issueSessionToken, verifyAnyToken, verifyToken, type TokenClaims } from "../auth/tokens.js";
import { DomainRuleError, extractMentionHandles, normalizeGitHubRepositoryUrl } from "../domain/rules.js";
import type { Actor, ConversationThread } from "../domain/model.js";
import { parseMarkdownImport } from "../imports/context-imports.js";
import type { MobWorker } from "../worker/worker.js";
import { writeMobAiProviderConfig } from "../agents/mob-ai-config.js";
import { redactText, redactValue } from "../security/redaction.js";
import { WorkspaceKnowledge } from "../knowledge/index.js";
import { WorkspaceFileBrowser } from "../files/index.js";
import {
  type FileWorkspaceStore,
  writeTaskFileState,
  writeWorkspaceFileState,
} from "../storage/index.js";
import { assertGitHubPublishRemote, publishTaskBranch } from "../workspace/publish.js";
import { controlRepositoryDirectory } from "../workspace/materialize.js";

const sessionCookie = "mob_session";

type AppDependencies = {
  config: AppConfig;
  store: CollaborationStore;
  files: FileWorkspaceStore;
  worker?: MobWorker;
};

type ActiveRunAuthorization = {
  conversationId: string;
};

declare module "fastify" {
  interface FastifyRequest {
    mobActor?: TokenClaims;
    mobActiveRun?: ActiveRunAuthorization;
  }
}

export async function ensureBootstrap(
  config: AppConfig,
  store: CollaborationStore,
  files: FileWorkspaceStore,
): Promise<void> {
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
    await writeMobAiProviderConfig({
      directory: home,
      baseUrl: providerProxyBaseUrl(config),
      model: config.mobAiModel,
      claudeModel: config.mobAiClaudeModel,
      codexModel: config.mobAiCodexModel,
    });
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
  if (existingTasks.length === 0) {
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
  await writeWorkspaceFileState(store, files, workspace);
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const { config, store, files } = dependencies;
  const app = Fastify({ logger: true, trustProxy: true });
  await app.register(cookie);
  await app.register(multipart, { limits: { files: 1, fileSize: 1_000_000 } });
  app.addHook("preSerialization", async (_request, _reply, payload) => jsonSafe(payload));

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "invalid_request", message: error.issues[0]?.message ?? "Invalid request" });
    }
    if (error instanceof StoreError) {
      const status = error.code === "not_found"
        ? 404
        : error.code === "authentication_required"
          ? 401
          : error.code === "human_required" || error.code.includes("allowlist")
            ? 403
            : 409;
      return reply.code(status).send({ error: error.code, message: error.message });
    }
    if (error instanceof DomainRuleError) {
      return reply.code(409).send({ error: error.code, message: error.message });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "internal_error", message: "The request could not be completed." });
  });

  app.get("/health", async () => {
    await store.sql`SELECT 1`;
    return {
      ok: true,
      revision: config.releaseRevision ?? "development",
      deploymentId: config.deploymentId ?? null,
    };
  });

  app.post("/api/session", async (request, reply) => {
    const body = z.object({
      email: z.string().email(),
      password: z.string().min(1),
      client: z.enum(["web", "cli"]).default("web"),
    }).parse(request.body);
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
    return { ok: true, ...(body.client === "cli" ? { token } : {}) };
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
      request.mobActor = bearer
        ? verifyAnyToken(token, config.sessionSecret)
        : verifyToken(token, config.sessionSecret, "session");
    } catch {
      return reply.code(401).send({ error: "invalid_session" });
    }
    if (request.mobActor.kind === "run") {
      request.mobActiveRun = await assertActiveRunClaims(store, request.mobActor);
    }
  });

  app.get("/api/bootstrap", async (request) => {
    const actor = requireHuman(request);
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
        resolution: taskResolution(task),
        repository: repositoryById.get(task.repositoryId)?.name ?? "Unknown repository",
        branch: task.branchName ?? task.baseRevision,
        participantIds: task.assignedActorId ? [task.assignedActorId] : [],
      })),
      agents: actors.filter((item) => item.kind === "agent").map((item) => ({
        id: item.id,
        handle: item.handle,
        name: item.displayName,
        status: item.status === "active" ? "available" : "offline",
        ...profileByActor.get(item.id),
      })),
    };
  });

  app.post("/api/agents", async (request) => {
    const actor = requireHuman(request);
    const body = z.object({
      handle: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u),
      name: z.string().min(1).max(120),
      role: z.string().max(500).default("Coding collaborator"),
      driver: z.enum(["pi", "omp", "claude", "codex", "hermes", "deepseek"]),
    }).parse(request.body);
    const actors = await store.listActors(actor.workspaceId);
    if (actors.some((candidate) => candidate.handle.toLowerCase() === body.handle.toLowerCase())) {
      throw new StoreError("agent_handle_exists", `@${body.handle.toLowerCase()} already exists.`);
    }
    const created = await store.createActor({
      workspaceId: actor.workspaceId,
      kind: "agent",
      handle: body.handle,
      displayName: body.name,
    });
    const home = resolve(config.dataDir, "agents", created.id);
    await writeMobAiProviderConfig({
      directory: home,
      baseUrl: providerProxyBaseUrl(config),
      model: config.mobAiModel,
      claudeModel: config.mobAiClaudeModel,
      codexModel: config.mobAiCodexModel,
    });
    const capabilities = connectorCapabilities(body.driver);
    const profile = await store.createAgentProfile({
      workspaceId: actor.workspaceId,
      actorId: created.id,
      ownerActorId: actor.actorId,
      driver: body.driver,
      home,
      role: body.role,
      capabilities,
      maxConcurrentRuns: 1,
    });
    await Promise.all([files.writeActor(created), files.writeAgentProfile(profile)]);
    return {
      id: created.id,
      handle: created.handle,
      name: created.displayName,
      status: "available",
      driver: profile.driver,
      role: profile.role,
      capabilities: profile.capabilities,
    };
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request) => {
    const actor = requireActor(request);
    const thread = await store.getTaskThread(request.params.id);
    assertTaskAccess(actor, thread.task.id, thread.task.workspaceId);
    const [repositories, actors] = await Promise.all([
      store.listRepositories(actor.workspaceId),
      store.listActors(actor.workspaceId),
    ]);
    const repo = repositories.find((item) => item.id === thread.task.repositoryId);
    const actorMap = new Map(actors.map((item) => [item.id, item]));
    const attemptByRun = new Map(thread.attempts.map((attempt) => [attempt.runId, attempt]));
    const visibleConversationIds = actor.kind === "session"
      ? new Set(thread.conversations
          .filter((conversation) =>
            conversation.isPrimary || thread.conversationMemberships.some((membership) =>
              membership.conversationId === conversation.id && membership.actorId === actor.actorId,
            ),
          )
          .map((conversation) => conversation.id))
      : new Set(thread.conversations.map((conversation) => conversation.id));
    const runById = new Map(thread.runs.map((run) => [run.id, run]));
    const activityByRun = new Map<string, string>();
    for (const event of thread.events) {
      const summary = summarizeRunEvent(event.type, event.payload);
      if (summary) activityByRun.set(event.runId, summary);
    }
    return {
      ...thread.task,
      resolution: taskResolution(thread.task),
      repository: repo?.name,
      branch: thread.task.branchName ?? thread.task.baseRevision,
      messages: thread.messages.filter((message) => message.conversationId === thread.task.id).map((message) => ({
        ...message,
        content: message.body,
        actorName: actorMap.get(message.actorId)?.displayName,
        actorKind: actorMap.get(message.actorId)?.kind,
        runId: message.sourceRunId,
      })),
      runs: thread.runs.filter((run) => run.conversationId === thread.task.id).map((run) => {
        const attempt = attemptByRun.get(run.id);
        return {
          ...run,
          agentId: run.agentActorId,
          attempt: run.latestAttemptNumber,
          startedAt: attempt?.startedAt ?? null,
          finishedAt: attempt?.completedAt ?? run.completedAt,
          summary: activityByRun.get(run.id) ?? runStatusSummary(run.status),
        };
      }),
      artifacts: await Promise.all(thread.artifacts.filter((artifact) => {
        if (!artifact.sourceRunId) return true;
        const sourceRun = runById.get(artifact.sourceRunId);
        return sourceRun !== undefined && visibleConversationIds.has(sourceRun.conversationId);
      }).map(async (artifact) => {
        let content = "";
        try {
          if (artifact.uri.startsWith("file:")) {
            content = (await readFile(artifact.uri.slice(5), "utf8")).slice(0, 100_000);
          } else if (artifact.uri.startsWith("document:")) {
            const rows = await store.sql<Array<{ content: string }>>`
              SELECT content FROM workspace_documents
              WHERE id = ${artifact.uri.slice(9)} AND workspace_id = ${actor.workspaceId}
            `;
            content = rows[0]?.content ?? "";
          }
        } catch {
          content = "";
        }
        return {
          ...artifact,
          producerAgentId: artifact.actorId,
          summary: typeof artifact.metadata.summary === "string"
            ? artifact.metadata.summary
            : artifact.mediaType ?? "Published artifact",
          revision: typeof artifact.metadata.revision === "string" ? artifact.metadata.revision : "unversioned",
          content,
          downloadUrl: `/api/artifacts/${artifact.id}/download`,
        };
      })),
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
    const initial = body.initialMessage
      ? await store.createMessage({
          taskId: task.id,
          actorId: actor.actorId,
          body: body.initialMessage,
          enqueueMentionedAgents: !body.agentId,
        })
      : null;
    if (body.agentId) {
      await store.queueRun({
        taskId: task.id,
        agentActorId: body.agentId,
        requestedByActorId: actor.actorId,
        ...(initial ? { triggerMessageId: initial.message.id } : {}),
      });
    }
    const thread = await store.getTaskThread(task.id);
    await files.repairTaskThread(thread);
    return thread;
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/reviews", async (request) => {
    const actor = requireHuman(request);
    const body = z.object({
      decision: z.enum(["accept", "reject", "request_changes"]),
      note: z.string().max(2_000).default(""),
    }).parse(request.body);
    const task = await store.reviewTask({
      taskId: request.params.id,
      decidedByActorId: actor.actorId,
      decision: body.decision,
    });
    const summary = body.decision === "accept"
      ? "Human review accepted. Publication still requires a separate human action."
      : body.decision === "reject"
        ? "Human review rejected this result. The task was cancelled."
        : "Human review requested changes. The task is open for a bounded follow-up.";
    await store.createMessage({
      taskId: task.id,
      actorId: actor.actorId,
      kind: "system",
      body: body.note.trim() ? `${summary}\n\nReview note: ${body.note.trim()}` : summary,
      enqueueMentionedAgents: false,
    });
    await writeTaskFileState(store, files, task.id);
    return { ...task, resolution: taskResolution(task) };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/publications", async (request) => {
    const actor = requireHuman(request);
    const body = z.object({
      confirm: z.literal(true),
      branch: z.string().min(5).max(160).refine(
        (value) => value.startsWith("mob/") && !value.includes("..") && !value.includes("//") && !/[\\~^:?*\[\]\s]/u.test(value),
        "Publication branch must be a safe ref under mob/.",
      ).optional(),
      commitMessage: z.string().min(1).max(240).default("mob: publish reviewed task"),
    }).parse(request.body);
    const branchName = body.branch ?? `mob/${request.params.id.slice(0, 8)}`;
    const task = await store.getTask(request.params.id);
    if (!task) throw new StoreError("not_found", "Task was not found.");
    assertTaskAccess(actor, task.id, task.workspaceId);
    if (task.status !== "completed") {
      throw new StoreError("human_review_required", "Accept the task result before publishing a branch.");
    }
    const preflightRepository = (await store.listRepositories(actor.workspaceId))
      .find((candidate) => candidate.id === task.repositoryId);
    if (!preflightRepository?.allowlisted || !preflightRepository.enabled || !preflightRepository.remoteUrl) {
      throw new StoreError("repository_not_allowlisted", "Publication requires an enabled, allowlisted Git repository.");
    }
    try {
      assertGitHubPublishRemote(preflightRepository.remoteUrl);
    } catch (error) {
      throw new StoreError(
        "repository_not_allowlisted",
        error instanceof Error ? error.message : "Publication requires an allowlisted HTTPS GitHub repository.",
      );
    }
    const workspaceActors = await store.listActors(actor.workspaceId);
    const human = workspaceActors.find((candidate) => candidate.id === actor.actorId);
    if (!human || human.kind !== "human") {
      throw new StoreError("human_required", "A human account is required.");
    }

    // The approval record is the durable authorization for this SCM write.
    // It is decided before Git sees credentials, and is separate from accepting
    // the Agent's result.
    const pending = await store.requestApproval({
      taskId: request.params.id,
      requestedByActorId: actor.actorId,
      kind: "publish_branch",
      payload: { branch: branchName, commitMessage: body.commitMessage },
    });
    const approved = await store.decideApproval({
      approvalId: pending.id,
      decidedByActorId: actor.actorId,
      decision: "approved",
      note: "Explicit publication confirmation received.",
    });
    await files.writeApproval(approved);

    const published = await store.withTaskPublicationLock({
      taskId: request.params.id,
      approvedByActorId: actor.actorId,
      branchName,
    }, async ({ task, repository }) => {
      try {
        assertGitHubPublishRemote(repository.remoteUrl ?? "");
        return await publishTaskBranch({
          taskDirectory: join(config.dataDir, "tasks", task.id),
          controlDirectory: controlRepositoryDirectory(config.dataDir, task.id),
          remoteUrl: repository.remoteUrl ?? "",
          branchName,
          commitMessage: body.commitMessage,
          authorName: human.displayName,
          authorEmail: `${human.handle}@users.noreply.mob.local`,
        });
      } catch (error) {
        throw new StoreError(
          "publication_failed",
          (error instanceof Error ? error.message : "The reviewed branch could not be published.").slice(0, 1_000),
        );
      }
    });
    await writeTaskFileState(store, files, published.task.id);
    return {
      ...published.result,
      approvalId: approved.id,
      resolution: "branch_published",
    };
  });

  app.get("/api/conversations", async (request) => {
    const actor = requireActor(request);
    const [summaries, actors] = await Promise.all([
      store.listConversations(actor.workspaceId, actor.actorId, actor.kind === "session"),
      store.listActors(actor.workspaceId),
    ]);
    const actorById = new Map(actors.map((item) => [item.id, item]));
    return {
      conversations: summaries.map(({ conversation, memberActorIds, lastMessage }) => ({
        ...conversation,
        members: memberActorIds.map((id) => actorById.get(id)).filter(Boolean),
        lastMessage,
      })),
    };
  });

  app.post("/api/conversations", async (request) => {
    const actor = requireHuman(request);
    const body = z.object({
      taskId: z.string().uuid(),
      kind: z.enum(["direct", "group"]),
      title: z.string().min(1).max(120).nullable().optional(),
      members: z.array(z.string().min(1).max(80)).max(32).default([]),
    }).parse(request.body);
    const task = await store.getTask(body.taskId);
    if (!task) throw new StoreError("not_found", "Task was not found.");
    assertTaskAccess(actor, task.id, task.workspaceId);
    const workspaceActors = await store.listActors(actor.workspaceId);
    const memberIds = body.members.map((needle) => {
      const handle = needle.replace(/^@/u, "").toLowerCase();
      const member = workspaceActors.find((candidate) =>
        candidate.id === needle || candidate.handle.toLowerCase() === handle,
      );
      if (!member) throw new StoreError("not_found", `Conversation member ${needle} was not found.`);
      return member.id;
    });
    const uniqueMembers = [actor.actorId, ...memberIds]
      .filter((id, index, values) => values.indexOf(id) === index)
      .map((id) => workspaceActors.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is Actor => candidate !== undefined);
    if (
      body.kind === "direct" &&
      (uniqueMembers.length !== 2 ||
        uniqueMembers.filter((candidate) => candidate.kind === "human").length !== 1 ||
        uniqueMembers.filter((candidate) => candidate.kind === "agent").length !== 1)
    ) {
      throw new StoreError(
        "direct_human_agent_required",
        "A direct conversation requires exactly one human and one Agent.",
      );
    }
    const thread = await store.createConversation({
      workspaceId: actor.workspaceId,
      taskId: task.id,
      createdByActorId: actor.actorId,
      kind: body.kind,
      ...(body.title !== undefined ? { title: body.title } : {}),
      memberActorIds: memberIds,
    });
    await writeTaskFileState(store, files, task.id);
    return replyConversation(thread, workspaceActors);
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id", async (request) => {
    const actor = requireActor(request);
    await assertSessionConversationAccess(store, actor, request.params.id);
    const thread = await store.getConversationThread(
      request.params.id,
      actor.actorId,
      actor.kind === "session",
    );
    assertWorkspace(actor, thread.conversation.workspaceId);
    if (actor.kind === "run" && !thread.runs.some((run) => run.id === actor.runId)) {
      throw new StoreError("not_found", "Conversation was not found.");
    }
    return replyConversation(thread, await store.listActors(actor.workspaceId));
  });

  app.post<{ Params: { id: string } }>("/api/conversations/:id/messages", async (request) => {
    const actor = requireActor(request);
    const body = z.object({
      content: z.string().min(1).max(20_000),
      kind: z.enum(["comment", "progress", "result"]).optional(),
      invoke: z.boolean().default(false),
      agent: z.string().min(1).max(80).optional(),
      writerRequired: z.boolean().default(true),
    }).parse(request.body);
    await assertSessionConversationAccess(store, actor, request.params.id);
    const thread = await store.getConversationThread(
      request.params.id,
      actor.actorId,
      actor.kind === "session",
    );
    assertWorkspace(actor, thread.conversation.workspaceId);
    if (actor.kind === "run" && !thread.runs.some((run) => run.id === actor.runId)) {
      throw new StoreError("not_found", "Conversation was not found.");
    }
    if (actor.kind === "run" && body.invoke) {
      throw new StoreError(
        "explicit_delegation_required",
        "Agents must use mob delegate so delegation depth and budgets remain enforced.",
      );
    }
    const workspaceActors = await store.listActors(actor.workspaceId);
    const memberIds = new Set(thread.members.map((membership) => membership.actorId));
    const agentMembers = workspaceActors.filter((candidate) =>
      candidate.kind === "agent" && memberIds.has(candidate.id) && candidate.id !== actor.actorId,
    );
    let invokedAgentId: string | undefined;
    if (body.invoke) {
      if (body.agent) {
        const needle = body.agent.replace(/^@/u, "").toLowerCase();
        invokedAgentId = agentMembers.find((candidate) =>
          candidate.id === body.agent || candidate.handle.toLowerCase() === needle,
        )?.id;
      } else {
        const mentions = new Set(extractMentionHandles(body.content));
        const mentionedAgents = agentMembers.filter((candidate) => mentions.has(candidate.handle));
        const candidates = mentionedAgents.length > 0
          ? mentionedAgents
          : thread.conversation.kind === "direct"
            ? agentMembers
            : [];
        if (candidates.length === 1) invokedAgentId = candidates[0]?.id;
      }
      if (!invokedAgentId) {
        throw new StoreError(
          "agent_required",
          "Choose one Agent member with agent, or @mention exactly one Agent and set invoke=true.",
        );
      }
    }
    const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/iu)?.[1];
    const content = actor.kind === "run"
      ? redactText(body.content, [config.mobAiKey, bearer])
      : body.content;
    const result = await store.createConversationMessage({
      conversationId: thread.conversation.id,
      actorId: actor.actorId,
      body: content,
      ...(body.kind ? { kind: body.kind } : {}),
      ...(actor.kind === "run" ? { sourceRunId: actor.runId } : {}),
      ...(invokedAgentId ? { invokeAgentActorId: invokedAgentId } : {}),
      writerRequired: body.writerRequired,
    });
    await writeTaskFileState(store, files, thread.conversation.taskId);
    return result;
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/messages", async (request) => {
    const actor = requireActor(request);
    const body = z.object({
      content: z.string().min(1).max(20_000),
      kind: z.enum(["comment", "progress", "result"]).optional(),
    }).parse(request.body);
    const task = await store.getTask(request.params.id);
    if (!task) throw new StoreError("not_found", "Task was not found.");
    assertTaskAccess(actor, task.id, task.workspaceId);
    const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/iu)?.[1];
    const content = actor.kind === "run"
      ? redactText(body.content, [config.mobAiKey, bearer])
      : body.content;
    const result = actor.kind === "run"
      ? await store.createConversationMessage({
          // Never trust a client-supplied conversation for an Agent message.
          // Authentication resolves this from the exact active attempt.
          conversationId: requireActiveRun(request).conversationId,
          actorId: actor.actorId,
          sourceRunId: actor.runId,
          kind: body.kind ?? "comment",
          body: content,
        })
      : await store.createMessage({
          taskId: task.id,
          actorId: actor.actorId,
          kind: "comment",
          body: content,
          enqueueMentionedAgents: true,
        });
    await writeTaskFileState(store, files, task.id);
    return result;
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/delegations", async (request) => {
    const actor = requireActor(request);
    const body = z.object({
      agentId: z.string().min(1).max(80),
      deliverable: z.string().min(1),
      writerRequired: z.boolean().default(true),
    }).parse(request.body);
    const task = await store.getTask(request.params.id);
    if (!task) throw new StoreError("not_found", "Task was not found.");
    assertTaskAccess(actor, task.id, task.workspaceId);
    const agentNeedle = body.agentId.replace(/^@/u, "").toLowerCase();
    const recipient = (await store.listActors(task.workspaceId)).find((candidate) =>
      candidate.kind === "agent" &&
      (candidate.id === body.agentId || candidate.handle.toLowerCase() === agentNeedle),
    );
    if (!recipient) throw new StoreError("not_found", "Receiving agent was not found.");
    if (actor.kind === "run") {
      const sourceRuns = await store.sql<Array<{ delegation_id: string | null }>>`
        SELECT delegation_id FROM runs WHERE id = ${actor.runId} AND task_id = ${task.id}
      `;
      const result = await store.createDelegation({
        taskId: task.id,
        fromActorId: actor.actorId,
        toAgentActorId: recipient.id,
        sourceRunId: actor.runId,
        parentDelegationId: sourceRuns[0]?.delegation_id ?? null,
        intent: "collaborate",
        deliverable: body.deliverable,
        writerRequired: body.writerRequired,
      });
      await writeTaskFileState(store, files, task.id);
      return result;
    }
    const instruction = await store.createMessage({
      taskId: task.id,
      actorId: actor.actorId,
      body: `@${recipient.handle} ${body.deliverable}`,
      enqueueMentionedAgents: false,
    });
    const result = await store.queueRun({
      taskId: task.id,
      agentActorId: recipient.id,
      requestedByActorId: actor.actorId,
      triggerMessageId: instruction.message.id,
      writerRequired: body.writerRequired,
    });
    await writeTaskFileState(store, files, task.id);
    return { ...result, message: instruction.message };
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (request) => {
    const actor = requireActor(request);
    const runRows = await store.sql<Array<{ task_id: string; workspace_id: string; conversation_id: string }>>`
      SELECT task_id, workspace_id, conversation_id FROM runs WHERE id = ${request.params.id}
    `;
    const run = runRows[0];
    if (!run) throw new StoreError("not_found", "Run was not found.");
    assertTaskAccess(actor, run.task_id, run.workspace_id);
    await assertSessionConversationAccess(store, actor, run.conversation_id);
    await dependencies.worker?.cancelRun(request.params.id);
    const cancelled = await store.cancelRun({ runId: request.params.id, requestedByActorId: actor.actorId });
    await writeTaskFileState(store, files, run.task_id);
    return cancelled;
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request) => {
    const actor = requireActor(request);
    const rows = await store.sql<Array<{
      id: string;
      task_id: string;
      workspace_id: string;
      conversation_id: string;
      agent_actor_id: string;
      status: string;
      latest_attempt_number: number;
      created_at: Date;
      updated_at: Date;
      completed_at: Date | null;
      attempt_status: string | null;
      started_at: Date | null;
      failure_code: string | null;
      failure_message: string | null;
    }>>`
      SELECT r.id, r.task_id, r.workspace_id, r.conversation_id, r.agent_actor_id, r.status,
             r.latest_attempt_number, r.created_at, r.updated_at, r.completed_at,
             a.status AS attempt_status, a.started_at, a.failure_code, a.failure_message
      FROM runs r
      LEFT JOIN run_attempts a
        ON a.run_id = r.id AND a.attempt_number = r.latest_attempt_number
      WHERE r.id = ${request.params.id}
    `;
    const run = rows[0];
    if (!run) throw new StoreError("not_found", "Run was not found.");
    assertTaskAccess(actor, run.task_id, run.workspace_id);
    await assertSessionConversationAccess(store, actor, run.conversation_id);
    return {
      id: run.id,
      taskId: run.task_id,
      agentId: run.agent_actor_id,
      status: run.status,
      attempt: run.latest_attempt_number,
      attemptStatus: run.attempt_status,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      failureCode: run.failure_code,
      failureMessage: run.failure_message,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
    };
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/runs/:id/events", async (request) => {
    const actor = requireActor(request);
    const after = z.coerce.number().int().min(0).default(0).parse(request.query.after);
    const runRows = await store.sql<Array<{ task_id: string; workspace_id: string; conversation_id: string }>>`
      SELECT task_id, workspace_id, conversation_id FROM runs WHERE id = ${request.params.id}
    `;
    const run = runRows[0];
    if (!run) throw new StoreError("not_found", "Run was not found.");
    assertTaskAccess(actor, run.task_id, run.workspace_id);
    await assertSessionConversationAccess(store, actor, run.conversation_id);
    const events = await store.sql<Array<{
      sequence: number;
      type: string;
      payload: Record<string, unknown>;
      created_at: Date;
    }>>`
      SELECT sequence, type, payload, created_at
      FROM run_events
      WHERE run_id = ${request.params.id} AND sequence > ${after}
      ORDER BY sequence
      LIMIT 200
    `;
    return {
      events: events.map((event) => ({
        sequence: event.sequence,
        type: event.type,
        payload: event.payload,
        createdAt: event.created_at,
      })),
      cursor: events.at(-1)?.sequence ?? after,
    };
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/commands", async (request, reply) => {
    const actor = requireHuman(request);
    const body = z.object({
      type: z.enum(["steer", "follow_up"]),
      message: z.string().min(1).max(20_000),
    }).parse(request.body);
    const runRows = await store.sql<Array<{ task_id: string; workspace_id: string; conversation_id: string }>>`
      SELECT task_id, workspace_id, conversation_id FROM runs WHERE id = ${request.params.id}
    `;
    const run = runRows[0];
    if (!run) throw new StoreError("not_found", "Run was not found.");
    assertTaskAccess(actor, run.task_id, run.workspace_id);
    await assertSessionConversationAccess(store, actor, run.conversation_id);
    const acknowledgement = await dependencies.worker?.sendRunCommand(request.params.id, body);
    if (!acknowledgement?.accepted) {
      return reply.code(409).send({
        error: "command_rejected",
        message: acknowledgement?.error ?? "This server is not hosting the active Agent run.",
        acknowledgement,
      });
    }
    return { acknowledgement };
  });

  for (const endpoint of ["chat/completions", "messages", "responses"] as const) {
    app.post(`/api/provider/v1/${endpoint}`, async (request, reply) => {
      requireRun(request);
      if (!config.mobAiKey) {
        return reply.code(503).send({ error: "provider_unavailable", message: "MobAI Router is not configured." });
      }

      const upstreamHeaders = new Headers({
        authorization: `Bearer ${config.mobAiKey}`,
        "content-type": "application/json",
        "user-agent": "mob-agent-crew/0.1",
      });
      for (const name of ["accept", "anthropic-version", "anthropic-beta", "openai-organization", "openai-project"]) {
        const value = request.headers[name];
        if (typeof value === "string") upstreamHeaders.set(name, value);
      }
      const controller = new AbortController();
      request.raw.once("aborted", () => controller.abort());
      const upstream = await fetch(
        `${config.mobAiBaseUrl.replace(/\/$/u, "")}/v1/${endpoint}`,
        {
          method: "POST",
          headers: upstreamHeaders,
          body: JSON.stringify(request.body ?? {}),
          signal: controller.signal,
        },
      );
      reply.hijack();
      reply.raw.statusCode = upstream.status;
      for (const name of ["content-type", "cache-control", "x-request-id", "request-id"]) {
        const value = upstream.headers.get(name);
        if (value) reply.raw.setHeader(name, value);
      }
      if (!upstream.body) {
        reply.raw.end();
        return reply;
      }
      Readable.from(upstream.body as unknown as AsyncIterable<Uint8Array>).pipe(reply.raw);
      return reply;
    });
  }

  app.get<{ Querystring: { scope?: string; taskId?: string; path?: string } }>("/api/files", async (request) => {
    const actor = requireHuman(request);
    const scope = z.enum(["workspace", "repository"]).parse(request.query.scope);
    const taskId = z.string().uuid().parse(request.query.taskId);
    const task = await store.getTask(taskId);
    if (!task) throw new StoreError("not_found", "Task was not found.");
    assertTaskAccess(actor, task.id, task.workspaceId);
    const path = request.query.path ?? "";
    if (scope === "repository") {
      await assertTaskRepositoryAccess(store, actor, task.id);
    } else {
      assertSafeWorkspaceFilePath(path, true);
    }
    try {
      const listing = await new WorkspaceFileBrowser({ dataDir: config.dataDir }).list({
        scope,
        workspaceId: actor.workspaceId,
        taskId,
        path,
      });
      return scope === "workspace" && path === ""
        ? { ...listing, entries: listing.entries.filter((entry) => safeWorkspaceFileRoots.has(entry.name)) }
        : listing;
    } catch {
      throw new StoreError("not_found", "The requested directory is unavailable.");
    }
  });

  app.get<{ Querystring: { scope?: string; taskId?: string; path?: string } }>("/api/files/content", async (request) => {
    const actor = requireHuman(request);
    const scope = z.enum(["workspace", "repository"]).parse(request.query.scope);
    const taskId = z.string().uuid().parse(request.query.taskId);
    const path = z.string().min(1).parse(request.query.path);
    const task = await store.getTask(taskId);
    if (!task) throw new StoreError("not_found", "Task was not found.");
    assertTaskAccess(actor, task.id, task.workspaceId);
    if (scope === "repository") {
      await assertTaskRepositoryAccess(store, actor, task.id);
    } else {
      assertSafeWorkspaceFilePath(path, false);
    }
    try {
      return await new WorkspaceFileBrowser({ dataDir: config.dataDir }).read({
        scope,
        workspaceId: actor.workspaceId,
        taskId,
        path,
      });
    } catch {
      throw new StoreError("not_found", "The requested file cannot be displayed.");
    }
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/artifacts", async (request, reply) => {
    const actor = requireActor(request);
    const task = await store.getTask(request.params.id);
    if (!task) throw new StoreError("not_found", "Task was not found.");
    assertTaskAccess(actor, task.id, task.workspaceId);
    const part = await request.file();
    if (!part) return reply.code(400).send({ error: "file_required", message: "Choose a file." });
    const contents = await part.toBuffer();
    if (actor.kind === "session") {
      const parsed = parseMarkdownImport(part.filename, contents.toString("utf8"));
      const document = await store.createWorkspaceDocument({
        workspaceId: actor.workspaceId, name: parsed.filename, content: parsed.content,
        source: `task:${request.params.id}`, uploadedByActorId: actor.actorId,
      });
      await store.createArtifact({
        taskId: request.params.id, actorId: actor.actorId,
        kind: "file", name: parsed.filename, uri: `document:${document.id}`, mediaType: "text/markdown", byteSize: BigInt(parsed.bytes),
        metadata: { title: parsed.title, summary: `${parsed.bytes} bytes Markdown context` },
      });
      const knowledge = knowledgeFor(files, actor.workspaceId);
      await knowledge.writeRaw({
        path: `imports/${document.id}-${safeArtifactFilename(parsed.filename)}`,
        content: parsed.content,
        source: `task:${request.params.id}`,
        metadata: { documentId: document.id, uploadedByActorId: actor.actorId },
      });
      await files.writeDocument(document);
      await writeTaskFileState(store, files, request.params.id);
      return { context: { ...document, kind: "markdown", summary: `${parsed.bytes} bytes Markdown context` } };
    }

    const filename = safeArtifactFilename(part.filename);
    const directory = resolve(config.dataDir, "artifacts", request.params.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, `${randomUUID()}-${filename}`);
    await writeFile(path, contents, { mode: 0o600 });
    const extension = extname(filename).toLowerCase();
    const artifact = await store.createArtifact({
      taskId: request.params.id,
      actorId: actor.actorId,
      sourceRunId: actor.runId,
      kind: extension === ".patch" || extension === ".diff" ? "patch" : extension === ".log" ? "log" : "file",
      name: filename,
      uri: `file:${path}`,
      mediaType: part.mimetype || "application/octet-stream",
      byteSize: BigInt(contents.byteLength),
      sha256: createHash("sha256").update(contents).digest("hex"),
      metadata: { summary: `${contents.byteLength} byte Agent deliverable` },
    });
    await files.writeArtifact(artifact);
    return { artifact: { ...artifact, downloadUrl: `/api/artifacts/${artifact.id}/download` } };
  });

  app.get<{ Params: { id: string } }>("/api/artifacts/:id/download", async (request, reply) => {
    const actor = requireActor(request);
    const rows = await store.sql<Array<{
      workspace_id: string;
      task_id: string;
      conversation_id: string | null;
      source_run_id: string | null;
      name: string;
      uri: string;
      media_type: string | null;
    }>>`
      SELECT a.workspace_id, a.task_id, r.conversation_id, a.source_run_id,
             a.name, a.uri, a.media_type
      FROM artifacts a
      LEFT JOIN runs r ON r.id = a.source_run_id
      WHERE a.id = ${request.params.id}
    `;
    const artifact = rows[0];
    if (!artifact) throw new StoreError("not_found", "Artifact was not found.");
    assertTaskAccess(actor, artifact.task_id, artifact.workspace_id);
    if (artifact.source_run_id && !artifact.conversation_id) {
      throw new StoreError("not_found", "Artifact was not found.");
    }
    if (artifact.conversation_id) {
      await assertSessionConversationAccess(store, actor, artifact.conversation_id);
    }
    let contents: Buffer;
    if (artifact.uri.startsWith("file:")) {
      const root = resolve(config.dataDir, "artifacts");
      const path = resolve(artifact.uri.slice(5));
      if (!path.startsWith(`${root}/`)) throw new StoreError("not_found", "Artifact was not found.");
      contents = await readFile(path);
    } else if (artifact.uri.startsWith("document:")) {
      const documents = await store.sql<Array<{ content: string }>>`
        SELECT content FROM workspace_documents
        WHERE id = ${artifact.uri.slice(9)} AND workspace_id = ${actor.workspaceId}
      `;
      if (!documents[0]) throw new StoreError("not_found", "Artifact was not found.");
      contents = Buffer.from(documents[0].content, "utf8");
    } else {
      throw new StoreError("not_found", "Artifact was not found.");
    }
    reply.header("Content-Disposition", `attachment; filename="${safeArtifactFilename(artifact.name)}"`);
    return reply.type(artifact.media_type ?? "application/octet-stream").send(contents);
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/imports/github", async (request) => {
    const actor = requireHuman(request);
    const body = z.object({ url: z.string().url() }).parse(request.body);
    const repositoryImport = await store.createRepositoryImport(actor.workspaceId, actor.actorId, body.url);
    const name = new URL(repositoryImport.sourceUrl).pathname.split("/").filter(Boolean).at(-1)?.replace(/\.git$/u, "") ?? "repository";
    const completed = await store.completeRepositoryImport(repositoryImport.id, { name });
    await files.writeRepository(completed.repository);
    return { context: { id: completed.repositoryImport.id, name: completed.repository.name, kind: "github", summary: "Repository imported and allowlisted", content: completed.repository.remoteUrl, sourceUrl: completed.repository.remoteUrl, createdAt: completed.repository.createdAt } };
  });

  app.get<{ Querystring: { area?: string } }>("/api/knowledge", async (request) => {
    const actor = requireActor(request);
    const area = z.enum(["raw", "wiki"]).optional().parse(request.query.area);
    return { entries: await knowledgeFor(files, actor.workspaceId).list(area) };
  });

  app.get<{ Querystring: { path?: string } }>("/api/knowledge/file", async (request) => {
    const actor = requireActor(request);
    const path = z.string().min(1).parse(request.query.path);
    return knowledgeFor(files, actor.workspaceId).read(path);
  });

  app.get<{ Querystring: { q?: string; top?: string } }>("/api/knowledge/search", async (request) => {
    const actor = requireActor(request);
    const query = z.string().min(1).parse(request.query.q);
    const topK = z.coerce.number().int().min(1).max(20).default(6).parse(request.query.top);
    return { results: await knowledgeFor(files, actor.workspaceId).search(query, { topK }) };
  });

  app.get<{ Querystring: { q?: string; top?: string; budget?: string } }>("/api/knowledge/retrieve", async (request) => {
    const actor = requireActor(request);
    const query = z.string().min(1).parse(request.query.q);
    const topK = z.coerce.number().int().min(1).max(20).default(6).parse(request.query.top);
    const charBudget = z.coerce.number().int().min(100).max(50_000).default(12_000).parse(request.query.budget);
    return knowledgeFor(files, actor.workspaceId).retrieve(query, { topK, charBudget });
  });

  app.post<{ Params: { area: string } }>("/api/knowledge/:area", async (request) => {
    const actor = requireActor(request);
    const area = z.enum(["raw", "wiki"]).parse(request.params.area);
    const body = z.object({
      path: z.string().min(1),
      content: z.string().min(1).max(2_000_000),
      source: z.string().max(500).optional(),
      metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    }).parse(request.body);
    const knowledge = knowledgeFor(files, actor.workspaceId);
    const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/iu)?.[1];
    const runtimeSecrets = actor.kind === "run" ? [config.mobAiKey, bearer] : [];
    const metadata = {
      ...(body.metadata ?? {}),
      writtenByActorId: actor.actorId,
      ...(actor.kind === "run" ? { sourceRunId: actor.runId } : {}),
    };
    const input = {
      path: actor.kind === "run" ? redactText(body.path, runtimeSecrets) : body.path,
      content: actor.kind === "run" ? redactText(body.content, runtimeSecrets) : body.content,
      source: actor.kind === "run"
        ? redactText(body.source ?? `api:${actor.kind}`, runtimeSecrets)
        : (body.source ?? `api:${actor.kind}`),
      metadata: actor.kind === "run" ? redactValue(metadata, runtimeSecrets) : metadata,
    };
    return area === "raw" ? knowledge.writeRaw(input) : knowledge.writeWiki(input);
  });

  app.post("/api/knowledge/rebuild", async (request) => {
    const actor = requireActor(request);
    return knowledgeFor(files, actor.workspaceId).rebuildIndex();
  });

  app.get("/api/knowledge/lint", async (request) => {
    const actor = requireActor(request);
    return knowledgeFor(files, actor.workspaceId).lint();
  });

  const webRoot = resolve(process.cwd(), "web-dist");
  if (existsSync(webRoot)) {
    await app.register(staticPlugin, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") ? reply.code(404).send({ error: "not_found" }) : reply.sendFile("index.html"));
  }
  return app;
}

function summarizeRunEvent(type: string, payload: Readonly<Record<string, unknown>>): string | null {
  const message = typeof payload.message === "string" ? payload.message : null;
  switch (type) {
    case "runtime.started": return "Starting agent process…";
    case "runtime.ready": return "Agent runtime is ready.";
    case "turn.started": return "Agent is thinking…";
    case "message.delta": return "Agent is responding…";
    case "tool.started": return `Using ${message ?? "a tool"}…`;
    case "tool.completed": return "Tool finished; agent is continuing…";
    case "turn.completed": return "Agent finished its turn.";
    case "error": return message ?? "Agent reported an error.";
    default: return null;
  }
}

function runStatusSummary(status: string): string {
  if (status === "queued") return "Queued for the worker.";
  if (status === "running") return "Agent is working…";
  if (status === "succeeded") return "Agent run succeeded.";
  if (status === "failed") return "Agent run failed.";
  return "Agent run was cancelled.";
}

function connectorCapabilities(driver: "pi" | "omp" | "claude" | "codex" | "hermes" | "deepseek") {
  const duplex = driver === "pi" || driver === "omp" || driver === "hermes";
  return {
    streaming: driver !== "deepseek",
    steer: duplex,
    followUp: driver === "pi" || driver === "omp",
    resume: false,
    nativeCancel: duplex,
  };
}

function taskResolution(task: { status: string; branchName: string | null }): "unreviewed" | "accepted" | "rejected" | "branch_published" {
  if (task.status === "completed" && task.branchName?.startsWith("mob/")) return "branch_published";
  if (task.status === "completed") return "accepted";
  if (task.status === "cancelled") return "rejected";
  return "unreviewed";
}

function safeArtifactFilename(value: string): string {
  const filename = basename(value).replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!filename || filename === "." || filename === "..") {
    throw new StoreError("invalid_artifact_name", "Artifact filename is invalid.");
  }
  return filename.slice(0, 180);
}

function knowledgeFor(files: FileWorkspaceStore, workspaceId: string): WorkspaceKnowledge {
  return new WorkspaceKnowledge({ rootDirectory: resolve(files.workspaceRoot(workspaceId), "knowledge") });
}

function replyConversation(thread: ConversationThread, actors: readonly Actor[]): Record<string, unknown> {
  const actorById = new Map(actors.map((actor) => [actor.id, actor]));
  return {
    ...thread.conversation,
    members: thread.members
      .map((membership) => actorById.get(membership.actorId))
      .filter((actor): actor is Actor => actor !== undefined),
    messages: thread.messages.map((message) => ({
      ...message,
      content: message.body,
      actorName: actorById.get(message.actorId)?.displayName,
      actorKind: actorById.get(message.actorId)?.kind,
      runId: message.sourceRunId,
    })),
    runs: thread.runs.map((run) => ({
      ...run,
      agentId: run.agentActorId,
    })),
  };
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

function requireRun(request: FastifyRequest): Extract<TokenClaims, { kind: "run" }> {
  const actor = requireActor(request);
  if (actor.kind !== "run") throw new StoreError("human_required", "An active Agent run is required.");
  return actor;
}

function requireActiveRun(request: FastifyRequest): ActiveRunAuthorization {
  requireRun(request);
  if (!request.mobActiveRun) {
    throw new StoreError("not_found", "Active Agent run was not found.");
  }
  return request.mobActiveRun;
}

/**
 * A signed run token identifies a run, but completion and lease loss revoke it
 * immediately. Keep this database guard in the shared authentication hook so
 * every Agent route (including messages, delegation, artifacts and knowledge)
 * observes the same active-run boundary.
 */
async function assertActiveRunClaims(
  store: CollaborationStore,
  actor: Extract<TokenClaims, { kind: "run" }>,
): Promise<ActiveRunAuthorization> {
  const rows = await store.sql<Array<{
    task_id: string;
    workspace_id: string;
    agent_actor_id: string;
    conversation_id: string;
    attempt_id: string;
    run_status: string;
    attempt_status: string;
    lease_active: boolean;
  }>>`
    SELECT
      r.task_id,
      r.workspace_id,
      r.agent_actor_id,
      r.conversation_id,
      a.id AS attempt_id,
      r.status AS run_status,
      a.status AS attempt_status,
      (a.lease_expires_at > now()) AS lease_active
    FROM runs r
    JOIN run_attempts a
     ON a.run_id = r.id
     AND a.attempt_number = r.latest_attempt_number
    WHERE r.id = ${actor.runId}
      AND a.id = ${actor.attemptId}
    LIMIT 1
  `;
  const run = rows[0];
  if (
    !run ||
    run.task_id !== actor.taskId ||
    run.workspace_id !== actor.workspaceId ||
    run.agent_actor_id !== actor.actorId ||
    run.attempt_id !== actor.attemptId ||
    run.run_status !== "running" ||
    run.attempt_status !== "running" ||
    run.lease_active !== true
  ) {
    throw new StoreError("not_found", "Active Agent run was not found.");
  }
  return { conversationId: run.conversation_id };
}

function providerProxyBaseUrl(config: AppConfig): string {
  return `http://127.0.0.1:${config.port}/api/provider`;
}

const safeWorkspaceFileRoots = new Set(["documents", "knowledge"]);

function assertSafeWorkspaceFilePath(path: string, allowRoot: boolean): void {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  if (allowRoot && normalized === "") return;
  const root = normalized.split("/")[0];
  if (!root || !safeWorkspaceFileRoots.has(root)) {
    throw new StoreError("not_found", "The requested workspace file is unavailable.");
  }
}

async function assertSessionConversationAccess(
  store: CollaborationStore,
  actor: TokenClaims,
  conversationId: string,
): Promise<void> {
  if (actor.kind !== "session") return;
  if (!(await store.canActorAccessConversation(conversationId, actor.actorId, actor.workspaceId))) {
    throw new StoreError("not_found", "Resource was not found.");
  }
}

async function assertTaskRepositoryAccess(
  store: CollaborationStore,
  actor: Extract<TokenClaims, { kind: "session" }>,
  taskId: string,
): Promise<void> {
  if (!(await store.canActorAccessTaskRepository(taskId, actor.actorId, actor.workspaceId))) {
    throw new StoreError("not_found", "Resource was not found.");
  }
}

function assertWorkspace(actor: TokenClaims, workspaceId: string): void {
  if (actor.workspaceId !== workspaceId) throw new StoreError("not_found", "Resource was not found.");
}

function assertTaskAccess(actor: TokenClaims, taskId: string, workspaceId: string): void {
  assertWorkspace(actor, workspaceId);
  if (actor.kind === "run" && actor.taskId !== taskId) {
    throw new StoreError("not_found", "Resource was not found.");
  }
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
