import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import {
  DEFAULT_DRIVER_CAPABILITIES,
  DomainRuleError,
  assertDelegationAllowed,
  assertHumanApproval,
  assertMarkdownDocument,
  assertRunTransition,
  extractMentionHandles,
  leaseExpiry,
  normalizeGitHubRepositoryUrl,
  normalizeHandle,
} from "../domain/rules.js";
import type {
  Actor,
  ActorId,
  AgentProfile,
  Approval,
  ApprovalKind,
  ApprovalStatus,
  Artifact,
  ArtifactKind,
  Delegation,
  DriverCapabilities,
  LeaseClaim,
  Message,
  MessageKind,
  Repository,
  RepositoryImport,
  RepositoryKind,
  Run,
  RunAttempt,
  RunEvent,
  RunStatus,
  Task,
  TaskThread,
  UserAuthRecord,
  Workspace,
  WorkspaceDocument,
} from "../domain/model.js";
import type { DatabaseClient } from "./client.js";
import type { DbRow } from "./rows.js";
import {
  mapActor,
  mapAgentProfile,
  mapApproval,
  mapArtifact,
  mapDelegation,
  mapMessage,
  mapRepository,
  mapRepositoryImport,
  mapRun,
  mapRunAttempt,
  mapRunEvent,
  mapTask,
  mapUserAuthRecord,
  mapWorkspace,
  mapWorkspaceDocument,
} from "./rows.js";

type QueryClient = postgres.Sql | postgres.TransactionSql;

class LeaseLostError extends Error {
  constructor() {
    super("The run lease is no longer current.");
    this.name = "LeaseLostError";
  }
}

export class StoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

function one(rows: readonly DbRow[], entity: string): DbRow {
  const row = rows[0];
  if (row === undefined) throw new StoreError("not_found", `${entity} was not found.`);
  return row;
}

function optionalOne(rows: readonly DbRow[]): DbRow | undefined {
  return rows[0];
}

async function requireActor(
  sql: QueryClient,
  workspaceId: string,
  actorId: string,
): Promise<Actor> {
  const rows = await sql<DbRow[]>`
    SELECT * FROM actors
    WHERE workspace_id = ${workspaceId} AND id = ${actorId}
  `;
  const actor = mapActor(one(rows, "Actor"));
  if (actor.status !== "active") throw new StoreError("actor_disabled", "Actor is disabled.");
  return actor;
}

export interface QueueRunInput {
  taskId: string;
  agentActorId: string;
  requestedByActorId: string;
  delegationId?: string | null;
  priority?: number;
  writerRequired?: boolean;
}

interface InsertQueuedRunInput extends QueueRunInput {
  workspaceId: string;
}

async function insertQueuedRun(
  sql: QueryClient,
  input: InsertQueuedRunInput,
): Promise<{ run: Run; attempt: RunAttempt }> {
  const runId = randomUUID();
  const attemptId = randomUUID();
  const delegationId = input.delegationId ?? null;
  const priority = input.priority ?? 0;
  const writerRequired = input.writerRequired ?? true;

  const runRows = await sql<DbRow[]>`
    INSERT INTO runs (
      id, workspace_id, task_id, agent_actor_id, requested_by_actor_id,
      delegation_id, priority, writer_required
    ) VALUES (
      ${runId}, ${input.workspaceId}, ${input.taskId}, ${input.agentActorId},
      ${input.requestedByActorId}, ${delegationId}, ${priority}, ${writerRequired}
    )
    RETURNING *
  `;
  const attemptRows = await sql<DbRow[]>`
    INSERT INTO run_attempts (
      id, workspace_id, task_id, run_id, attempt_number
    ) VALUES (
      ${attemptId}, ${input.workspaceId}, ${input.taskId}, ${runId}, 1
    )
    RETURNING *
  `;
  return { run: mapRun(one(runRows, "Run")), attempt: mapRunAttempt(one(attemptRows, "Run attempt")) };
}

export interface BootstrapWorkspaceInput {
  slug: string;
  name: string;
  owner: {
    handle: string;
    displayName: string;
    provider: string;
    subject: string;
    email?: string | null;
    passwordHash?: string | null;
  };
}

export interface BootstrapWorkspaceResult {
  workspace: Workspace;
  owner: Actor;
  auth: UserAuthRecord;
}

export interface CreateActorInput {
  workspaceId: string;
  kind: Actor["kind"];
  handle: string;
  displayName: string;
}

export interface CreateAgentProfileInput {
  workspaceId: string;
  actorId: string;
  ownerActorId: string;
  driver: string;
  home: string;
  role?: string;
  capabilities?: DriverCapabilities;
  maxConcurrentRuns?: number;
}

export interface CreateWorkspaceDocumentInput {
  workspaceId: string;
  name: string;
  content?: string | null;
  localPath?: string | null;
  source: string;
  uploadedByActorId: string;
}

export interface CreateRepositoryInput {
  workspaceId: string;
  name: string;
  kind: RepositoryKind;
  remoteUrl?: string | null;
  localPath?: string | null;
  defaultBranch?: string;
  allowlisted?: boolean;
  createdByActorId: string;
}

export interface CompleteRepositoryImportInput {
  name: string;
  defaultBranch?: string;
}

export interface CreateTaskInput {
  workspaceId: string;
  repositoryId: string;
  createdByActorId: string;
  assignedActorId?: string | null;
  title: string;
  description?: string;
  baseRevision: string;
  branchName?: string | null;
  maxDelegationDepth?: number;
  runBudget?: number;
}

export interface CreateMessageInput {
  taskId: string;
  actorId: string;
  body: string;
  kind?: MessageKind;
  sourceRunId?: string | null;
  enqueueMentionedAgents?: boolean;
}

export interface CreateMessageResult {
  message: Message;
  queuedRuns: Run[];
}

export interface CreateDelegationInput {
  taskId: string;
  fromActorId: string;
  toAgentActorId: string;
  sourceRunId: string;
  parentDelegationId?: string | null;
  intent: string;
  deliverable: string;
  priority?: number;
  writerRequired?: boolean;
}

export interface CreateDelegationResult {
  delegation: Delegation;
  run: Run;
  attempt: RunAttempt;
}

export interface CancelRunInput {
  runId: string;
  requestedByActorId: string;
  reason?: string;
}

export interface CreateArtifactInput {
  taskId: string;
  actorId: string;
  sourceRunId?: string | null;
  sourceAttemptId?: string | null;
  kind: ArtifactKind;
  name: string;
  uri: string;
  mediaType?: string | null;
  byteSize?: bigint | null;
  sha256?: string | null;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface RequestApprovalInput {
  taskId: string;
  requestedByActorId: string;
  kind: ApprovalKind;
  payload?: Readonly<Record<string, unknown>>;
}

export interface DecideApprovalInput {
  approvalId: string;
  decidedByActorId: string;
  decision: Extract<ApprovalStatus, "approved" | "rejected">;
  note?: string | null;
}

export interface AppendRunEventInput {
  claim: LeaseClaim;
  type: string;
  payload?: Readonly<Record<string, unknown>>;
  now?: Date;
}

export interface CompleteAttemptInput {
  claim: LeaseClaim;
  status: Extract<RunStatus, "succeeded" | "failed" | "cancelled">;
  failureCode?: string | null;
  failureMessage?: string | null;
  now?: Date;
}

export class CollaborationStore {
  readonly sql: DatabaseClient;

  constructor(sql: DatabaseClient) {
    this.sql = sql;
  }

  async bootstrap(input: BootstrapWorkspaceInput): Promise<BootstrapWorkspaceResult> {
    const slug = normalizeHandle(input.slug);
    const handle = normalizeHandle(input.owner.handle);
    return this.sql.begin(async (tx) => {
      const workspaceRows = await tx<DbRow[]>`
        INSERT INTO workspaces (id, slug, name)
        VALUES (${randomUUID()}, ${slug}, ${input.name.trim()})
        RETURNING *
      `;
      const workspace = mapWorkspace(one(workspaceRows, "Workspace"));
      const actorRows = await tx<DbRow[]>`
        INSERT INTO actors (id, workspace_id, kind, handle, display_name)
        VALUES (${randomUUID()}, ${workspace.id}, 'human', ${handle}, ${input.owner.displayName.trim()})
        RETURNING *
      `;
      const owner = mapActor(one(actorRows, "Owner actor"));
      const authRows = await tx<DbRow[]>`
        INSERT INTO user_auth_records (
          id, workspace_id, actor_id, provider, subject, email, password_hash
        ) VALUES (
          ${randomUUID()}, ${workspace.id}, ${owner.id}, ${input.owner.provider.trim()},
          ${input.owner.subject.trim()}, ${input.owner.email ?? null}, ${input.owner.passwordHash ?? null}
        )
        RETURNING *
      `;
      return { workspace, owner, auth: mapUserAuthRecord(one(authRows, "User auth record")) };
    });
  }

  async getWorkspaceBySlug(slug: string): Promise<Workspace | null> {
    const rows = await this.sql<DbRow[]>`SELECT * FROM workspaces WHERE slug = ${normalizeHandle(slug)}`;
    const row = optionalOne(rows);
    return row === undefined ? null : mapWorkspace(row);
  }

  async createActor(input: CreateActorInput): Promise<Actor> {
    const rows = await this.sql<DbRow[]>`
      INSERT INTO actors (id, workspace_id, kind, handle, display_name)
      VALUES (
        ${randomUUID()}, ${input.workspaceId}, ${input.kind},
        ${normalizeHandle(input.handle)}, ${input.displayName.trim()}
      )
      RETURNING *
    `;
    return mapActor(one(rows, "Actor"));
  }

  async listActors(workspaceId: string): Promise<Actor[]> {
    const rows = await this.sql<DbRow[]>`
      SELECT * FROM actors WHERE workspace_id = ${workspaceId} ORDER BY handle
    `;
    return rows.map(mapActor);
  }

  async createAgentProfile(input: CreateAgentProfileInput): Promise<AgentProfile> {
    const capabilities = input.capabilities ?? DEFAULT_DRIVER_CAPABILITIES;
    const rows = await this.sql<DbRow[]>`
      INSERT INTO agent_profiles (
        actor_id, workspace_id, owner_actor_id, driver, home, role,
        capabilities, max_concurrent_runs
      ) VALUES (
        ${input.actorId}, ${input.workspaceId}, ${input.ownerActorId}, ${input.driver.trim()},
        ${input.home.trim()}, ${input.role?.trim() ?? ''}, ${JSON.stringify(capabilities)}::jsonb,
        ${input.maxConcurrentRuns ?? 1}
      )
      RETURNING *
    `;
    return mapAgentProfile(one(rows, "Agent profile"));
  }

  async createWorkspaceDocument(input: CreateWorkspaceDocumentInput): Promise<WorkspaceDocument> {
    const content = input.content ?? null;
    const localPath = input.localPath?.trim() ?? null;
    assertMarkdownDocument(content, localPath);
    await requireActor(this.sql, input.workspaceId, input.uploadedByActorId);
    const rows = await this.sql<DbRow[]>`
      INSERT INTO workspace_documents (
        id, workspace_id, name, content, local_path, source, uploaded_by_actor_id
      ) VALUES (
        ${randomUUID()}, ${input.workspaceId}, ${input.name.trim()}, ${content}, ${localPath},
        ${input.source.trim()}, ${input.uploadedByActorId}
      )
      RETURNING *
    `;
    return mapWorkspaceDocument(one(rows, "Workspace document"));
  }

  async listWorkspaceDocuments(workspaceId: string): Promise<WorkspaceDocument[]> {
    const rows = await this.sql<DbRow[]>`
      SELECT * FROM workspace_documents
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC, id DESC
    `;
    return rows.map(mapWorkspaceDocument);
  }

  async createRepository(input: CreateRepositoryInput): Promise<Repository> {
    await requireActor(this.sql, input.workspaceId, input.createdByActorId);
    const remoteUrl = input.remoteUrl?.trim() ?? null;
    const localPath = input.localPath?.trim() ?? null;
    if (input.kind === "git" && remoteUrl === null) {
      throw new StoreError("remote_url_required", "A Git repository requires a remote URL.");
    }
    if (input.kind === "local" && localPath === null) {
      throw new StoreError("local_path_required", "A local repository requires a local path.");
    }
    const rows = await this.sql<DbRow[]>`
      INSERT INTO repositories (
        id, workspace_id, name, kind, remote_url, local_path, default_branch,
        allowlisted, created_by_actor_id
      ) VALUES (
        ${randomUUID()}, ${input.workspaceId}, ${input.name.trim()}, ${input.kind},
        ${remoteUrl}, ${localPath}, ${input.defaultBranch?.trim() ?? 'main'},
        ${input.allowlisted ?? true}, ${input.createdByActorId}
      )
      RETURNING *
    `;
    return mapRepository(one(rows, "Repository"));
  }

  async listRepositories(workspaceId: string): Promise<Repository[]> {
    const rows = await this.sql<DbRow[]>`
      SELECT * FROM repositories
      WHERE workspace_id = ${workspaceId}
      ORDER BY name, id
    `;
    return rows.map(mapRepository);
  }

  async createRepositoryImport(
    workspaceId: string,
    requestedByActorId: string,
    sourceUrl: string,
  ): Promise<RepositoryImport> {
    await requireActor(this.sql, workspaceId, requestedByActorId);
    const canonicalUrl = normalizeGitHubRepositoryUrl(sourceUrl);
    const rows = await this.sql<DbRow[]>`
      INSERT INTO repository_imports (id, workspace_id, source_url, requested_by_actor_id)
      VALUES (${randomUUID()}, ${workspaceId}, ${canonicalUrl}, ${requestedByActorId})
      RETURNING *
    `;
    return mapRepositoryImport(one(rows, "Repository import"));
  }

  async completeRepositoryImport(
    importId: string,
    input: CompleteRepositoryImportInput,
  ): Promise<{ repositoryImport: RepositoryImport; repository: Repository }> {
    return this.sql.begin(async (tx) => {
      const importRows = await tx<DbRow[]>`
        SELECT * FROM repository_imports WHERE id = ${importId} FOR UPDATE
      `;
      const repositoryImport = mapRepositoryImport(one(importRows, "Repository import"));
      if (repositoryImport.status !== "pending") {
        throw new StoreError("import_already_decided", "Repository import is no longer pending.");
      }
      const existingRows = await tx<DbRow[]>`
        SELECT * FROM repositories
        WHERE workspace_id = ${repositoryImport.workspaceId}
          AND remote_url = ${repositoryImport.sourceUrl}
      `;
      let repository: Repository;
      const existing = optionalOne(existingRows);
      if (existing !== undefined) {
        repository = mapRepository(existing);
      } else {
        const repositoryRows = await tx<DbRow[]>`
          INSERT INTO repositories (
            id, workspace_id, name, kind, remote_url, default_branch,
            allowlisted, created_by_actor_id
          ) VALUES (
            ${randomUUID()}, ${repositoryImport.workspaceId}, ${input.name.trim()}, 'git',
            ${repositoryImport.sourceUrl}, ${input.defaultBranch?.trim() ?? 'main'}, true,
            ${repositoryImport.requestedByActorId}
          )
          RETURNING *
        `;
        repository = mapRepository(one(repositoryRows, "Repository"));
      }
      const completedRows = await tx<DbRow[]>`
        UPDATE repository_imports
        SET status = 'imported', repository_id = ${repository.id}, completed_at = now()
        WHERE id = ${repositoryImport.id}
        RETURNING *
      `;
      return {
        repositoryImport: mapRepositoryImport(one(completedRows, "Repository import")),
        repository,
      };
    });
  }

  async failRepositoryImport(importId: string, failureMessage: string): Promise<RepositoryImport> {
    const rows = await this.sql<DbRow[]>`
      UPDATE repository_imports
      SET status = 'failed', failure_message = ${failureMessage}, completed_at = now()
      WHERE id = ${importId} AND status = 'pending'
      RETURNING *
    `;
    return mapRepositoryImport(one(rows, "Pending repository import"));
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    return this.sql.begin(async (tx) => {
      await requireActor(tx, input.workspaceId, input.createdByActorId);
      if (input.assignedActorId !== undefined && input.assignedActorId !== null) {
        await requireActor(tx, input.workspaceId, input.assignedActorId);
      }
      const repositoryRows = await tx<DbRow[]>`
        SELECT * FROM repositories
        WHERE workspace_id = ${input.workspaceId} AND id = ${input.repositoryId}
        FOR SHARE
      `;
      const repository = mapRepository(one(repositoryRows, "Repository"));
      if (!repository.allowlisted || !repository.enabled) {
        throw new StoreError("repository_not_allowlisted", "Repository is not enabled on the workspace allowlist.");
      }
      const rows = await tx<DbRow[]>`
        INSERT INTO tasks (
          id, workspace_id, repository_id, created_by_actor_id, assigned_actor_id,
          title, description, base_revision, branch_name, max_delegation_depth, run_budget
        ) VALUES (
          ${randomUUID()}, ${input.workspaceId}, ${input.repositoryId}, ${input.createdByActorId},
          ${input.assignedActorId ?? null}, ${input.title.trim()}, ${input.description ?? ''},
          ${input.baseRevision.trim()}, ${input.branchName?.trim() ?? null},
          ${input.maxDelegationDepth ?? 2}, ${input.runBudget ?? 8}
        )
        RETURNING *
      `;
      return mapTask(one(rows, "Task"));
    });
  }

  async getTask(taskId: string): Promise<Task | null> {
    const rows = await this.sql<DbRow[]>`SELECT * FROM tasks WHERE id = ${taskId}`;
    const row = optionalOne(rows);
    return row === undefined ? null : mapTask(row);
  }

  async listTasks(workspaceId: string, limit = 100): Promise<Task[]> {
    const rows = await this.sql<DbRow[]>`
      SELECT * FROM tasks
      WHERE workspace_id = ${workspaceId}
      ORDER BY updated_at DESC, id DESC
      LIMIT ${Math.max(1, Math.min(limit, 500))}
    `;
    return rows.map(mapTask);
  }

  async getTaskThread(taskId: string): Promise<TaskThread> {
    return this.sql.begin(async (tx) => {
      const taskRows = await tx<DbRow[]>`SELECT * FROM tasks WHERE id = ${taskId}`;
      const task = mapTask(one(taskRows, "Task"));
      const messageRows = await tx<DbRow[]>`
        SELECT m.*, COALESCE(array_agg(mm.actor_id ORDER BY mm.actor_id)
          FILTER (WHERE mm.actor_id IS NOT NULL), '{}') AS mention_actor_ids
        FROM messages m
        LEFT JOIN message_mentions mm ON mm.message_id = m.id
        WHERE m.task_id = ${taskId}
        GROUP BY m.id
        ORDER BY m.created_at, m.id
      `;
      const delegationRows = await tx<DbRow[]>`
        SELECT * FROM delegations WHERE task_id = ${taskId} ORDER BY created_at, id
      `;
      const runRows = await tx<DbRow[]>`
        SELECT * FROM runs WHERE task_id = ${taskId} ORDER BY created_at, id
      `;
      const attemptRows = await tx<DbRow[]>`
        SELECT * FROM run_attempts WHERE task_id = ${taskId} ORDER BY created_at, id
      `;
      const eventRows = await tx<DbRow[]>`
        SELECT * FROM run_events WHERE task_id = ${taskId} ORDER BY created_at, id
      `;
      const artifactRows = await tx<DbRow[]>`
        SELECT * FROM artifacts WHERE task_id = ${taskId} ORDER BY created_at, id
      `;
      const approvalRows = await tx<DbRow[]>`
        SELECT * FROM approvals WHERE task_id = ${taskId} ORDER BY created_at, id
      `;
      return {
        task,
        messages: messageRows.map((row) => {
          const raw = row.mention_actor_ids;
          return mapMessage(row, Array.isArray(raw) ? raw.map(String) : []);
        }),
        delegations: delegationRows.map(mapDelegation),
        runs: runRows.map(mapRun),
        attempts: attemptRows.map(mapRunAttempt),
        events: eventRows.map(mapRunEvent),
        artifacts: artifactRows.map(mapArtifact),
        approvals: approvalRows.map(mapApproval),
      };
    });
  }

  /** Alias kept intentionally terse for API route callers. */
  async thread(taskId: string): Promise<TaskThread> {
    return this.getTaskThread(taskId);
  }

  async createMessage(input: CreateMessageInput): Promise<CreateMessageResult> {
    if (input.body.trim().length === 0) throw new DomainRuleError("message_body_required", "Message body is required.");
    return this.sql.begin(async (tx) => {
      const taskRows = await tx<DbRow[]>`SELECT * FROM tasks WHERE id = ${input.taskId} FOR UPDATE`;
      const task = mapTask(one(taskRows, "Task"));
      await requireActor(tx, task.workspaceId, input.actorId);

      const handles = extractMentionHandles(input.body);
      const mentionedActors: Actor[] = [];
      if (handles.length > 0) {
        const actorRows = await tx<DbRow[]>`
          SELECT * FROM actors
          WHERE workspace_id = ${task.workspaceId}
            AND status = 'active'
            AND handle = ANY(${tx.array(handles)})
        `;
        mentionedActors.push(...actorRows.map(mapActor));
        const found = new Set(mentionedActors.map((actor) => actor.handle));
        const unknown = handles.filter((handle) => !found.has(handle));
        if (unknown.length > 0) {
          throw new StoreError("unknown_mention", `Unknown or disabled actor mention: @${unknown.join(", @")}.`);
        }
      }

      const messageRows = await tx<DbRow[]>`
        INSERT INTO messages (
          id, workspace_id, task_id, actor_id, source_run_id, kind, body
        ) VALUES (
          ${randomUUID()}, ${task.workspaceId}, ${task.id}, ${input.actorId},
          ${input.sourceRunId ?? null}, ${input.kind ?? 'comment'}, ${input.body}
        )
        RETURNING *
      `;
      const messageRow = one(messageRows, "Message");
      for (const actor of mentionedActors) {
        await tx`
          INSERT INTO message_mentions (workspace_id, message_id, actor_id)
          VALUES (${task.workspaceId}, ${String(messageRow.id)}, ${actor.id})
        `;
      }

      const queuedRuns: Run[] = [];
      if (input.enqueueMentionedAgents ?? true) {
        const agentActors = mentionedActors.filter((actor) => actor.kind === "agent");
        const existingRunRows = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM runs WHERE task_id = ${task.id}
        `;
        let runCount = Number(existingRunRows[0]?.count ?? "0");
        for (const agent of agentActors) {
          if (runCount >= task.runBudget) {
            throw new StoreError("run_budget_exceeded", "Task run budget has been exhausted.");
          }
          const queued = await insertQueuedRun(tx, {
            workspaceId: task.workspaceId,
            taskId: task.id,
            agentActorId: agent.id,
            requestedByActorId: input.actorId,
          });
          queuedRuns.push(queued.run);
          runCount += 1;
        }
      }

      if (queuedRuns.length > 0 && task.status === "open") {
        await tx`
          UPDATE tasks SET status = 'active', updated_at = now()
          WHERE id = ${task.id}
        `;
      }
      return {
        message: mapMessage(messageRow, mentionedActors.map((actor) => actor.id)),
        queuedRuns,
      };
    });
  }

  async queueRun(input: QueueRunInput): Promise<{ run: Run; attempt: RunAttempt }> {
    return this.sql.begin(async (tx) => {
      const taskRows = await tx<DbRow[]>`SELECT * FROM tasks WHERE id = ${input.taskId} FOR UPDATE`;
      const task = mapTask(one(taskRows, "Task"));
      const agent = await requireActor(tx, task.workspaceId, input.agentActorId);
      await requireActor(tx, task.workspaceId, input.requestedByActorId);
      if (agent.kind !== "agent") throw new StoreError("agent_required", "Run recipient must be an agent.");
      const countRows = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM runs WHERE task_id = ${task.id}
      `;
      if (Number(countRows[0]?.count ?? "0") >= task.runBudget) {
        throw new StoreError("run_budget_exceeded", "Task run budget has been exhausted.");
      }
      return insertQueuedRun(tx, {
        ...input,
        workspaceId: task.workspaceId,
      });
    });
  }

  async createDelegation(input: CreateDelegationInput): Promise<CreateDelegationResult> {
    return this.sql.begin(async (tx) => {
      const taskRows = await tx<DbRow[]>`SELECT * FROM tasks WHERE id = ${input.taskId} FOR UPDATE`;
      const task = mapTask(one(taskRows, "Task"));
      const fromActor = await requireActor(tx, task.workspaceId, input.fromActorId);
      const toActor = await requireActor(tx, task.workspaceId, input.toAgentActorId);
      const sourceRunRows = await tx<DbRow[]>`
        SELECT * FROM runs
        WHERE id = ${input.sourceRunId} AND task_id = ${task.id} AND agent_actor_id = ${fromActor.id}
        FOR SHARE
      `;
      one(sourceRunRows, "Source run");

      let depth = 1;
      const parentDelegationId = input.parentDelegationId ?? null;
      if (parentDelegationId !== null) {
        const parentRows = await tx<DbRow[]>`
          SELECT * FROM delegations
          WHERE id = ${parentDelegationId} AND task_id = ${task.id}
          FOR SHARE
        `;
        depth = mapDelegation(one(parentRows, "Parent delegation")).depth + 1;
      }
      const runCountRows = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM runs WHERE task_id = ${task.id}
      `;
      assertDelegationAllowed({
        fromActorId: fromActor.id,
        toActorId: toActor.id,
        toActorKind: toActor.kind,
        toActorStatus: toActor.status,
        depth,
        maxDepth: task.maxDelegationDepth,
        existingRunCount: Number(runCountRows[0]?.count ?? "0"),
        runBudget: task.runBudget,
        deliverable: input.deliverable,
      });

      const delegationRows = await tx<DbRow[]>`
        INSERT INTO delegations (
          id, workspace_id, task_id, from_actor_id, to_agent_actor_id,
          source_run_id, parent_delegation_id, intent, deliverable, depth
        ) VALUES (
          ${randomUUID()}, ${task.workspaceId}, ${task.id}, ${fromActor.id}, ${toActor.id},
          ${input.sourceRunId}, ${parentDelegationId}, ${input.intent.trim()},
          ${input.deliverable.trim()}, ${depth}
        )
        RETURNING *
      `;
      const delegation = mapDelegation(one(delegationRows, "Delegation"));
      const queued = await insertQueuedRun(tx, {
        workspaceId: task.workspaceId,
        taskId: task.id,
        agentActorId: toActor.id,
        requestedByActorId: fromActor.id,
        delegationId: delegation.id,
        priority: input.priority ?? 0,
        writerRequired: input.writerRequired ?? true,
      });
      return { delegation, ...queued };
    });
  }

  async cancelRun(input: CancelRunInput): Promise<Run> {
    return this.sql.begin(async (tx) => {
      const runRows = await tx<DbRow[]>`SELECT * FROM runs WHERE id = ${input.runId} FOR UPDATE`;
      const run = mapRun(one(runRows, "Run"));
      await requireActor(tx, run.workspaceId, input.requestedByActorId);
      assertRunTransition(run.status, "cancelled");
      const updatedRows = await tx<DbRow[]>`
        UPDATE runs
        SET status = 'cancelled', completed_at = now(), updated_at = now()
        WHERE id = ${run.id}
        RETURNING *
      `;
      await tx`
        UPDATE run_attempts
        SET status = 'cancelled', completed_at = now(), updated_at = now(),
            lease_expires_at = NULL,
            failure_message = COALESCE(${input.reason ?? null}, failure_message)
        WHERE run_id = ${run.id} AND status IN ('queued', 'claimed', 'running')
      `;
      await tx`DELETE FROM task_writer_leases WHERE attempt_id IN (
        SELECT id FROM run_attempts WHERE run_id = ${run.id}
      )`;
      return mapRun(one(updatedRows, "Run"));
    });
  }

  async claimNextRun(workerId: string, leaseMs = 60_000, now = new Date()): Promise<LeaseClaim | null> {
    const expiresAt = leaseExpiry(now, leaseMs);
    try {
      return await this.sql.begin(async (tx) => {
        const candidateRows = await tx<DbRow[]>`
        SELECT
          a.id AS attempt_id,
          a.workspace_id,
          a.task_id,
          a.run_id,
          a.attempt_number,
          r.agent_actor_id,
          r.writer_required
        FROM run_attempts a
        JOIN runs r ON r.id = a.run_id
        LEFT JOIN task_writer_leases wl
          ON wl.task_id = a.task_id AND wl.expires_at > ${now}
        WHERE r.status IN ('queued', 'running')
          AND (
            a.status = 'queued'
            OR (a.status IN ('claimed', 'running') AND a.lease_expires_at <= ${now})
          )
          AND (NOT r.writer_required OR wl.task_id IS NULL OR wl.attempt_id = a.id)
        ORDER BY r.priority DESC, a.created_at, a.id
        FOR UPDATE OF a SKIP LOCKED
        LIMIT 1
        `;
        const candidate = optionalOne(candidateRows);
        if (candidate === undefined) return null;

        const attemptId = String(candidate.attempt_id);
        const taskId = String(candidate.task_id);
        const runId = String(candidate.run_id);
        const workspaceId = String(candidate.workspace_id);
        const writer = Boolean(candidate.writer_required);
        const token = randomUUID();
        const attemptFenceRows = await tx<{ fence: string }[]>`
        UPDATE run_attempts
        SET status = 'claimed', worker_id = ${workerId}, lease_token = ${token},
            fence = fence + 1, lease_expires_at = ${expiresAt}, updated_at = ${now}
        WHERE id = ${attemptId}
        RETURNING fence::text AS fence
        `;
        const fenceRow = attemptFenceRows[0];
        if (fenceRow === undefined) throw new LeaseLostError();
        const fence = BigInt(fenceRow.fence);

        let writerFence: bigint | null = null;
        if (writer) {
          const taskFenceRows = await tx<{ writer_fence: string }[]>`
          UPDATE tasks
          SET writer_fence = writer_fence + 1, updated_at = ${now}
          WHERE id = ${taskId}
          RETURNING writer_fence::text AS writer_fence
          `;
          const taskFenceRow = taskFenceRows[0];
          if (taskFenceRow === undefined) throw new LeaseLostError();
          writerFence = BigInt(taskFenceRow.writer_fence);
          const writerRows = await tx<{ writer_fence: string }[]>`
          INSERT INTO task_writer_leases (
            workspace_id, task_id, attempt_id, lease_token, writer_fence, expires_at, updated_at
          ) VALUES (
            ${workspaceId}, ${taskId}, ${attemptId}, ${token}, ${writerFence.toString()},
            ${expiresAt}, ${now}
          )
          ON CONFLICT (task_id) DO UPDATE SET
            attempt_id = EXCLUDED.attempt_id,
            lease_token = EXCLUDED.lease_token,
            writer_fence = EXCLUDED.writer_fence,
            expires_at = EXCLUDED.expires_at,
            updated_at = EXCLUDED.updated_at
          WHERE task_writer_leases.expires_at <= ${now}
             OR task_writer_leases.attempt_id = EXCLUDED.attempt_id
          RETURNING writer_fence::text AS writer_fence
          `;
          if (writerRows.length === 0) {
            // A concurrent claimant obtained this task's single writer lease.
            // Throwing rolls back the attempt and fence increments atomically.
            throw new LeaseLostError();
          }
        }
        await tx`
        UPDATE run_attempts SET writer_fence = ${writerFence?.toString() ?? null}
        WHERE id = ${attemptId}
        `;
        await tx`
        UPDATE runs SET status = 'running', updated_at = ${now}
        WHERE id = ${runId} AND status = 'queued'
        `;
        return {
          attemptId,
          runId,
          taskId,
          workspaceId,
          agentActorId: String(candidate.agent_actor_id),
          workerId,
          token,
          fence,
          writerFence,
          expiresAt,
          writer,
          attemptNumber: Number(candidate.attempt_number),
        };
      });
    } catch (error) {
      if (error instanceof LeaseLostError) return null;
      throw error;
    }
  }

  async renewLease(claim: LeaseClaim, leaseMs = 60_000, now = new Date()): Promise<LeaseClaim | null> {
    const expiresAt = leaseExpiry(now, leaseMs);
    try {
      return await this.sql.begin(async (tx) => {
        const attemptRows = await tx<DbRow[]>`
        UPDATE run_attempts
        SET lease_expires_at = ${expiresAt}, updated_at = ${now}
        WHERE id = ${claim.attemptId}
          AND lease_token = ${claim.token}
          AND fence = ${claim.fence.toString()}
          AND worker_id = ${claim.workerId}
          AND lease_expires_at > ${now}
          AND status IN ('claimed', 'running')
        RETURNING *
        `;
        if (attemptRows.length === 0) throw new LeaseLostError();
        if (claim.writer) {
          const writerRows = await tx<DbRow[]>`
          UPDATE task_writer_leases
          SET expires_at = ${expiresAt}, updated_at = ${now}
          WHERE task_id = ${claim.taskId}
            AND attempt_id = ${claim.attemptId}
            AND lease_token = ${claim.token}
            AND writer_fence = ${claim.writerFence?.toString() ?? null}
            AND expires_at > ${now}
          RETURNING task_id
          `;
          if (writerRows.length === 0) throw new LeaseLostError();
        }
        return { ...claim, expiresAt };
      });
    } catch (error) {
      if (error instanceof LeaseLostError) return null;
      throw error;
    }
  }

  async markAttemptRunning(claim: LeaseClaim, now = new Date()): Promise<RunAttempt> {
    const rows = await this.sql<DbRow[]>`
      UPDATE run_attempts a
      SET status = 'running', started_at = COALESCE(started_at, ${now}), updated_at = ${now}
      WHERE a.id = ${claim.attemptId}
        AND a.lease_token = ${claim.token}
        AND a.fence = ${claim.fence.toString()}
        AND a.lease_expires_at > ${now}
        AND a.status = 'claimed'
        AND (
          a.writer_fence IS NULL
          OR EXISTS (
            SELECT 1 FROM task_writer_leases wl
            WHERE wl.task_id = a.task_id
              AND wl.attempt_id = a.id
              AND wl.lease_token = a.lease_token
              AND wl.writer_fence = a.writer_fence
              AND wl.expires_at > ${now}
          )
        )
      RETURNING a.*
    `;
    return mapRunAttempt(one(rows, "Current run attempt lease"));
  }

  async appendRunEvent(input: AppendRunEventInput): Promise<RunEvent> {
    const now = input.now ?? new Date();
    return this.sql.begin(async (tx) => {
      const guardRows = await tx<DbRow[]>`
        SELECT id FROM run_attempts
        WHERE id = ${input.claim.attemptId}
          AND lease_token = ${input.claim.token}
          AND fence = ${input.claim.fence.toString()}
          AND lease_expires_at > ${now}
        FOR UPDATE
      `;
      one(guardRows, "Current run attempt lease");
      const sequenceRows = await tx<{ sequence: number }[]>`
        SELECT COALESCE(max(sequence), 0) + 1 AS sequence
        FROM run_events WHERE attempt_id = ${input.claim.attemptId}
      `;
      const sequence = Number(sequenceRows[0]?.sequence ?? 1);
      const rows = await tx<DbRow[]>`
        INSERT INTO run_events (
          id, workspace_id, task_id, run_id, attempt_id, sequence, type, payload, created_at
        ) VALUES (
          ${randomUUID()}, ${input.claim.workspaceId}, ${input.claim.taskId}, ${input.claim.runId},
          ${input.claim.attemptId}, ${sequence}, ${input.type.trim()},
          ${JSON.stringify(input.payload ?? {})}::jsonb, ${now}
        )
        RETURNING *
      `;
      return mapRunEvent(one(rows, "Run event"));
    });
  }

  async completeAttempt(input: CompleteAttemptInput): Promise<{ run: Run; attempt: RunAttempt }> {
    const now = input.now ?? new Date();
    return this.sql.begin(async (tx) => {
      const attemptRows = await tx<DbRow[]>`
        UPDATE run_attempts a
        SET status = ${input.status}, completed_at = ${now}, updated_at = ${now},
            lease_expires_at = NULL, failure_code = ${input.failureCode ?? null},
            failure_message = ${input.failureMessage ?? null}
        WHERE a.id = ${input.claim.attemptId}
          AND a.lease_token = ${input.claim.token}
          AND a.fence = ${input.claim.fence.toString()}
          AND a.lease_expires_at > ${now}
          AND a.status IN ('claimed', 'running')
          AND (
            a.writer_fence IS NULL
            OR EXISTS (
              SELECT 1 FROM task_writer_leases wl
              WHERE wl.task_id = a.task_id
                AND wl.attempt_id = a.id
                AND wl.lease_token = a.lease_token
                AND wl.writer_fence = a.writer_fence
                AND wl.expires_at > ${now}
            )
          )
        RETURNING a.*
      `;
      const attempt = mapRunAttempt(one(attemptRows, "Current run attempt lease"));
      await tx`DELETE FROM task_writer_leases
        WHERE task_id = ${input.claim.taskId}
          AND attempt_id = ${input.claim.attemptId}
          AND lease_token = ${input.claim.token}`;
      const runRows = await tx<DbRow[]>`
        UPDATE runs
        SET status = ${input.status}, completed_at = ${now}, updated_at = ${now}
        WHERE id = ${input.claim.runId} AND status IN ('queued', 'running')
        RETURNING *
      `;
      return { run: mapRun(one(runRows, "Run")), attempt };
    });
  }

  async createArtifact(input: CreateArtifactInput): Promise<Artifact> {
    const taskRows = await this.sql<DbRow[]>`SELECT * FROM tasks WHERE id = ${input.taskId}`;
    const task = mapTask(one(taskRows, "Task"));
    await requireActor(this.sql, task.workspaceId, input.actorId);
    const rows = await this.sql<DbRow[]>`
      INSERT INTO artifacts (
        id, workspace_id, task_id, actor_id, source_run_id, source_attempt_id,
        kind, name, uri, media_type, byte_size, sha256, metadata
      ) VALUES (
        ${randomUUID()}, ${task.workspaceId}, ${task.id}, ${input.actorId},
        ${input.sourceRunId ?? null}, ${input.sourceAttemptId ?? null}, ${input.kind},
        ${input.name.trim()}, ${input.uri.trim()}, ${input.mediaType ?? null},
        ${input.byteSize?.toString() ?? null}, ${input.sha256 ?? null},
        ${JSON.stringify(input.metadata ?? {})}::jsonb
      )
      RETURNING *
    `;
    return mapArtifact(one(rows, "Artifact"));
  }

  async requestApproval(input: RequestApprovalInput): Promise<Approval> {
    const taskRows = await this.sql<DbRow[]>`SELECT * FROM tasks WHERE id = ${input.taskId}`;
    const task = mapTask(one(taskRows, "Task"));
    await requireActor(this.sql, task.workspaceId, input.requestedByActorId);
    const rows = await this.sql<DbRow[]>`
      INSERT INTO approvals (
        id, workspace_id, task_id, requested_by_actor_id, kind, payload
      ) VALUES (
        ${randomUUID()}, ${task.workspaceId}, ${task.id}, ${input.requestedByActorId},
        ${input.kind}, ${JSON.stringify(input.payload ?? {})}::jsonb
      )
      RETURNING *
    `;
    return mapApproval(one(rows, "Approval"));
  }

  async decideApproval(input: DecideApprovalInput): Promise<Approval> {
    return this.sql.begin(async (tx) => {
      const approvalRows = await tx<DbRow[]>`
        SELECT * FROM approvals WHERE id = ${input.approvalId} FOR UPDATE
      `;
      const approval = mapApproval(one(approvalRows, "Approval"));
      if (approval.status !== "pending") throw new StoreError("approval_decided", "Approval is no longer pending.");
      const actor = await requireActor(tx, approval.workspaceId, input.decidedByActorId);
      assertHumanApproval(actor.kind);
      const rows = await tx<DbRow[]>`
        UPDATE approvals
        SET status = ${input.decision}, decided_by_actor_id = ${actor.id},
            decision_note = ${input.note ?? null}, decided_at = now()
        WHERE id = ${approval.id}
        RETURNING *
      `;
      return mapApproval(one(rows, "Approval"));
    });
  }
}

export function createCollaborationStore(sql: DatabaseClient): CollaborationStore {
  return new CollaborationStore(sql);
}
