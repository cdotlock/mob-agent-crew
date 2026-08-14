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
import { normalizeAgentComposition } from "../domain/agent-composition.js";
import type {
  Actor,
  ActorId,
  AgentProfile,
  Approval,
  ApprovalKind,
  ApprovalStatus,
  Artifact,
  ArtifactKind,
  Conversation,
  ConversationKind,
  ConversationMembership,
  ConversationThread,
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
  mapConversation,
  mapConversationMembership,
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
  conversationId?: string;
  triggerMessageId?: string | null;
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
  let conversationId = input.conversationId;
  if (conversationId === undefined) {
    const conversationRows = await sql<DbRow[]>`
      SELECT * FROM conversations
      WHERE task_id = ${input.taskId} AND is_primary
    `;
    conversationId = String(one(conversationRows, "Primary conversation").id);
  }

  const runRows = await sql<DbRow[]>`
    INSERT INTO runs (
      id, workspace_id, task_id, agent_actor_id, requested_by_actor_id,
      conversation_id, trigger_message_id, delegation_id, priority, writer_required
    ) VALUES (
      ${runId}, ${input.workspaceId}, ${input.taskId}, ${input.agentActorId},
      ${input.requestedByActorId}, ${conversationId}, ${input.triggerMessageId ?? null},
      ${delegationId}, ${priority}, ${writerRequired}
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
  modelId?: string | null;
  skillRefs?: readonly string[];
  environment?: AgentProfile["environment"] | null;
}

export interface UpdateAgentDefinitionInput {
  workspaceId: string;
  actorId: string;
  displayName: string;
  driver: string;
  role: string;
  capabilities: DriverCapabilities;
  modelId?: string | null;
  skillRefs?: readonly string[];
  environment?: AgentProfile["environment"] | null;
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
  conversationId?: string;
  actorId: string;
  body: string;
  kind?: MessageKind;
  sourceRunId?: string | null;
  enqueueMentionedAgents?: boolean;
  invokeAgentActorId?: string | null;
  writerRequired?: boolean;
}

export interface CreateMessageResult {
  message: Message;
  queuedRuns: Run[];
}

export interface CreateConversationInput {
  workspaceId: string;
  taskId: string;
  createdByActorId: string;
  kind: ConversationKind;
  title?: string | null;
  memberActorIds: readonly string[];
}

export interface ConversationSummary {
  conversation: Conversation;
  memberActorIds: string[];
  lastMessage: Message | null;
}

export interface CreateConversationMessageInput {
  conversationId: string;
  actorId: string;
  body: string;
  kind?: MessageKind;
  sourceRunId?: string | null;
  invokeAgentActorId?: string | null;
  writerRequired?: boolean;
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

export interface ReviewTaskInput {
  taskId: string;
  decidedByActorId: string;
  decision: "accept" | "reject" | "request_changes";
}

export interface PublishTaskInput {
  taskId: string;
  approvedByActorId: string;
  branchName: string;
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
    const composition = normalizeAgentComposition(input);
    const rows = await this.sql<DbRow[]>`
      INSERT INTO agent_profiles (
        actor_id, workspace_id, owner_actor_id, driver, home, role,
        model_id, skill_refs, environment, capabilities, max_concurrent_runs
      ) VALUES (
        ${input.actorId}, ${input.workspaceId}, ${input.ownerActorId}, ${input.driver.trim()},
        ${input.home.trim()}, ${input.role?.trim() ?? ''}, ${composition.modelId},
        ${JSON.stringify(composition.skillRefs)}::jsonb,
        ${JSON.stringify(composition.environment)}::jsonb,
        ${JSON.stringify(capabilities)}::jsonb,
        ${input.maxConcurrentRuns ?? 1}
      )
      RETURNING *
    `;
    return mapAgentProfile(one(rows, "Agent profile"));
  }

  async listAgentProfiles(workspaceId: string): Promise<AgentProfile[]> {
    const rows = await this.sql<DbRow[]>`
      SELECT * FROM agent_profiles WHERE workspace_id = ${workspaceId} ORDER BY actor_id
    `;
    return rows.map(mapAgentProfile);
  }

  async updateAgentDefinition(input: UpdateAgentDefinitionInput): Promise<{ actor: Actor; profile: AgentProfile }> {
    const composition = normalizeAgentComposition(input);
    const displayName = input.displayName.trim();
    const role = input.role.trim();
    const driver = input.driver.trim();
    if (!displayName || !driver) throw new StoreError("invalid_agent_definition", "Agent name and harness are required.");
    return this.sql.begin(async (tx) => {
      const actorRows = await tx<DbRow[]>`
        UPDATE actors
        SET display_name = ${displayName}, updated_at = now()
        WHERE id = ${input.actorId}
          AND workspace_id = ${input.workspaceId}
          AND kind = 'agent'
        RETURNING *
      `;
      const actor = actorRows[0];
      if (!actor) throw new StoreError("agent_not_found", "Agent was not found.");
      const profileRows = await tx<DbRow[]>`
        UPDATE agent_profiles
        SET driver = ${driver}, role = ${role}, model_id = ${composition.modelId},
            skill_refs = ${JSON.stringify(composition.skillRefs)}::jsonb,
            environment = ${JSON.stringify(composition.environment)}::jsonb,
            capabilities = ${JSON.stringify(input.capabilities)}::jsonb,
            updated_at = now()
        WHERE actor_id = ${input.actorId} AND workspace_id = ${input.workspaceId}
        RETURNING *
      `;
      const profile = profileRows[0];
      if (!profile) throw new StoreError("agent_profile_not_found", "Agent profile was not found.");
      return { actor: mapActor(actor), profile: mapAgentProfile(profile) };
    });
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
      const task = mapTask(one(rows, "Task"));
      await tx`
        INSERT INTO conversations (
          id, workspace_id, task_id, kind, title, created_by_actor_id, is_primary
        ) VALUES (
          ${task.id}, ${task.workspaceId}, ${task.id}, 'group', ${task.title},
          ${task.createdByActorId}, true
        )
        ON CONFLICT (id) DO NOTHING
      `;
      const initialMembers = [task.createdByActorId, task.assignedActorId]
        .filter((actorId): actorId is string => actorId !== null);
      for (const actorId of new Set(initialMembers)) {
        await tx`
            INSERT INTO conversation_memberships (workspace_id, conversation_id, actor_id)
            VALUES (${task.workspaceId}, ${task.id}, ${actorId})
            ON CONFLICT DO NOTHING
        `;
      }
      return task;
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

  async createConversation(input: CreateConversationInput): Promise<ConversationThread> {
    const memberActorIds = [...new Set([input.createdByActorId, ...input.memberActorIds])];
    if (input.kind === "direct" && memberActorIds.length !== 2) {
      throw new StoreError("direct_members_required", "A direct conversation must have exactly two members.");
    }
    if (memberActorIds.length === 0) {
      throw new StoreError("conversation_members_required", "A conversation needs at least one member.");
    }
    const title = input.title?.trim() || null;
    return this.sql.begin(async (tx) => {
      const taskRows = await tx<DbRow[]>`
        SELECT * FROM tasks
        WHERE id = ${input.taskId} AND workspace_id = ${input.workspaceId}
        FOR SHARE
      `;
      one(taskRows, "Task");
      const memberActors: Actor[] = [];
      for (const actorId of memberActorIds) {
        memberActors.push(await requireActor(tx, input.workspaceId, actorId));
      }
      if (
        input.kind === "direct" &&
        (memberActors.filter((actor) => actor.kind === "human").length !== 1 ||
          memberActors.filter((actor) => actor.kind === "agent").length !== 1)
      ) {
        throw new StoreError(
          "direct_human_agent_required",
          "A direct conversation requires exactly one human and one Agent.",
        );
      }
      const conversationRows = await tx<DbRow[]>`
        INSERT INTO conversations (
          id, workspace_id, task_id, kind, title, created_by_actor_id
        ) VALUES (
          ${randomUUID()}, ${input.workspaceId}, ${input.taskId}, ${input.kind},
          ${title}, ${input.createdByActorId}
        )
        RETURNING *
      `;
      const conversation = mapConversation(one(conversationRows, "Conversation"));
      const members: ConversationMembership[] = [];
      for (const actorId of memberActorIds) {
        const membershipRows = await tx<DbRow[]>`
          INSERT INTO conversation_memberships (workspace_id, conversation_id, actor_id)
          VALUES (${input.workspaceId}, ${conversation.id}, ${actorId})
          RETURNING *
        `;
        members.push(mapConversationMembership(one(membershipRows, "Conversation membership")));
      }
      return { conversation, members, messages: [], runs: [] };
    });
  }

  async canActorAccessConversation(
    conversationId: string,
    actorId: string,
    workspaceId: string,
  ): Promise<boolean> {
    const rows = await this.sql<Array<{ allowed: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM conversations c
        JOIN actors a
          ON a.workspace_id = c.workspace_id
         AND a.id = ${actorId}
         AND a.status = 'active'
        LEFT JOIN conversation_memberships mine
          ON mine.conversation_id = c.id
         AND mine.workspace_id = c.workspace_id
         AND mine.actor_id = a.id
        WHERE c.id = ${conversationId}
          AND c.workspace_id = ${workspaceId}
          AND (c.is_primary OR mine.actor_id IS NOT NULL)
      ) AS allowed
    `;
    return rows[0]?.allowed === true;
  }

  async canActorAccessTaskRepository(
    taskId: string,
    actorId: string,
    workspaceId: string,
  ): Promise<boolean> {
    const rows = await this.sql<Array<{ allowed: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM tasks t
        JOIN actors a
          ON a.workspace_id = t.workspace_id
         AND a.id = ${actorId}
         AND a.status = 'active'
        WHERE t.id = ${taskId}
          AND t.workspace_id = ${workspaceId}
          AND NOT EXISTS (
            SELECT 1
            FROM conversations private_conversation
            WHERE private_conversation.task_id = t.id
              AND NOT private_conversation.is_primary
              AND NOT EXISTS (
                SELECT 1
                FROM conversation_memberships mine
                WHERE mine.conversation_id = private_conversation.id
                  AND mine.actor_id = a.id
              )
          )
      ) AS allowed
    `;
    return rows[0]?.allowed === true;
  }

  async listConversations(
    workspaceId: string,
    actorId: string,
    includePrimary = false,
  ): Promise<ConversationSummary[]> {
    await requireActor(this.sql, workspaceId, actorId);
    const conversationRows = await this.sql<DbRow[]>`
      SELECT c.*
      FROM conversations c
      LEFT JOIN conversation_memberships mine
        ON mine.conversation_id = c.id
       AND mine.workspace_id = c.workspace_id
       AND mine.actor_id = ${actorId}
      WHERE c.workspace_id = ${workspaceId}
        AND (mine.actor_id IS NOT NULL OR (${includePrimary} AND c.is_primary))
      ORDER BY c.updated_at DESC, c.id DESC
    `;
    if (conversationRows.length === 0) return [];
    const conversationIds = conversationRows.map((row) => String(row.id));
    const [membershipRows, lastMessageRows] = await Promise.all([
      this.sql<DbRow[]>`
        SELECT * FROM conversation_memberships
        WHERE conversation_id = ANY(${this.sql.array(conversationIds)}::uuid[])
        ORDER BY joined_at, actor_id
      `,
      this.sql<DbRow[]>`
        SELECT DISTINCT ON (conversation_id) *
        FROM messages
        WHERE conversation_id = ANY(${this.sql.array(conversationIds)}::uuid[])
        ORDER BY conversation_id, created_at DESC, id DESC
      `,
    ]);
    return conversationRows.map((row) => {
      const conversation = mapConversation(row);
      const lastMessageRow = lastMessageRows.find(
        (messageRow) => String(messageRow.conversation_id) === conversation.id,
      );
      return {
        conversation,
        memberActorIds: membershipRows
          .filter((membershipRow) => String(membershipRow.conversation_id) === conversation.id)
          .map((membershipRow) => String(membershipRow.actor_id)),
        lastMessage: lastMessageRow ? mapMessage(lastMessageRow) : null,
      };
    });
  }

  async getConversationThread(
    conversationId: string,
    actorId: string,
    includePrimary = false,
  ): Promise<ConversationThread> {
    return this.sql.begin(async (tx) => {
      const conversationRows = await tx<DbRow[]>`
        SELECT c.*
        FROM conversations c
        LEFT JOIN conversation_memberships mine
          ON mine.conversation_id = c.id
         AND mine.workspace_id = c.workspace_id
         AND mine.actor_id = ${actorId}
        WHERE c.id = ${conversationId}
          AND (mine.actor_id IS NOT NULL OR (${includePrimary} AND c.is_primary))
      `;
      const conversation = mapConversation(one(conversationRows, "Conversation"));
      const [membershipRows, messageRows, runRows] = await Promise.all([
        tx<DbRow[]>`
          SELECT * FROM conversation_memberships
          WHERE conversation_id = ${conversation.id}
          ORDER BY joined_at, actor_id
        `,
        tx<DbRow[]>`
          SELECT m.*, COALESCE(array_agg(mm.actor_id ORDER BY mm.actor_id)
            FILTER (WHERE mm.actor_id IS NOT NULL), '{}') AS mention_actor_ids
          FROM messages m
          LEFT JOIN message_mentions mm ON mm.message_id = m.id
          WHERE m.conversation_id = ${conversation.id}
          GROUP BY m.id
          ORDER BY m.created_at, m.id
        `,
        tx<DbRow[]>`
          SELECT * FROM runs
          WHERE conversation_id = ${conversation.id}
          ORDER BY created_at, id
        `,
      ]);
      return {
        conversation,
        members: membershipRows.map(mapConversationMembership),
        messages: messageRows.map((row) => {
          const raw = row.mention_actor_ids;
          return mapMessage(row, Array.isArray(raw) ? raw.map(String) : []);
        }),
        runs: runRows.map(mapRun),
      };
    });
  }

  async getTaskThread(taskId: string): Promise<TaskThread> {
    return this.sql.begin(async (tx) => {
      const taskRows = await tx<DbRow[]>`SELECT * FROM tasks WHERE id = ${taskId}`;
      const task = mapTask(one(taskRows, "Task"));
      const conversationRows = await tx<DbRow[]>`
        SELECT * FROM conversations WHERE task_id = ${taskId} ORDER BY created_at, id
      `;
      const membershipRows = await tx<DbRow[]>`
        SELECT cm.*
        FROM conversation_memberships cm
        JOIN conversations c ON c.id = cm.conversation_id
        WHERE c.task_id = ${taskId}
        ORDER BY cm.joined_at, cm.actor_id
      `;
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
        conversations: conversationRows.map(mapConversation),
        conversationMemberships: membershipRows.map(mapConversationMembership),
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

      let conversationRows: DbRow[];
      if (input.sourceRunId) {
        const sourceRunRows = await tx<DbRow[]>`
          SELECT * FROM runs
          WHERE id = ${input.sourceRunId} AND task_id = ${task.id}
            AND agent_actor_id = ${input.actorId}
          FOR SHARE
        `;
        const sourceRun = mapRun(one(sourceRunRows, "Source run"));
        if (input.conversationId && input.conversationId !== sourceRun.conversationId) {
          throw new StoreError("conversation_mismatch", "The source run belongs to another conversation.");
        }
        conversationRows = await tx<DbRow[]>`
          SELECT * FROM conversations WHERE id = ${sourceRun.conversationId}
        `;
      } else if (input.conversationId) {
        conversationRows = await tx<DbRow[]>`
          SELECT * FROM conversations
          WHERE id = ${input.conversationId} AND task_id = ${task.id}
        `;
      } else {
        conversationRows = await tx<DbRow[]>`
          SELECT * FROM conversations WHERE task_id = ${task.id} AND is_primary
        `;
      }
      const conversation = mapConversation(one(conversationRows, "Conversation"));
      if (conversation.workspaceId !== task.workspaceId || conversation.taskId !== task.id) {
        throw new StoreError("not_found", "Conversation was not found.");
      }
      const memberRows = await tx<DbRow[]>`
        SELECT * FROM conversation_memberships
        WHERE conversation_id = ${conversation.id} AND actor_id = ${input.actorId}
      `;
      if (memberRows.length === 0) {
        if (input.sourceRunId) {
          // A delegated Agent may contribute to its parent conversation without
          // becoming a permanent member of a two-person direct chat.
        } else if (!conversation.isPrimary) {
          throw new StoreError("conversation_membership_required", "You are not a member of this conversation.");
        } else {
          await tx`
            INSERT INTO conversation_memberships (workspace_id, conversation_id, actor_id)
            VALUES (${task.workspaceId}, ${conversation.id}, ${input.actorId})
            ON CONFLICT DO NOTHING
          `;
        }
      }

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
        if (!conversation.isPrimary) {
          const mentionedMemberRows = await tx<Array<{ actor_id: string }>>`
            SELECT actor_id FROM conversation_memberships
            WHERE conversation_id = ${conversation.id}
              AND actor_id = ANY(${tx.array(mentionedActors.map((actor) => actor.id))}::uuid[])
          `;
          const memberIds = new Set(mentionedMemberRows.map((row) => row.actor_id));
          const outsideMembers = mentionedActors.filter((actor) => !memberIds.has(actor.id));
          if (outsideMembers.length > 0) {
            throw new StoreError(
              "conversation_member_required",
              `Mentioned actor is not in this conversation: @${outsideMembers.map((actor) => actor.handle).join(", @")}.`,
            );
          }
        }
      }

      const messageRows = await tx<DbRow[]>`
        INSERT INTO messages (
          id, workspace_id, task_id, conversation_id, actor_id, source_run_id, kind, body
        ) VALUES (
          ${randomUUID()}, ${task.workspaceId}, ${task.id}, ${conversation.id}, ${input.actorId},
          ${input.sourceRunId ?? null}, ${input.kind ?? 'comment'}, ${input.body}
        )
        RETURNING *
      `;
      const messageRow = one(messageRows, "Message");
      for (const actor of mentionedActors) {
        if (conversation.isPrimary) {
          await tx`
            INSERT INTO conversation_memberships (workspace_id, conversation_id, actor_id)
            VALUES (${task.workspaceId}, ${conversation.id}, ${actor.id})
            ON CONFLICT DO NOTHING
          `;
        }
        await tx`
          INSERT INTO message_mentions (workspace_id, message_id, actor_id)
          VALUES (${task.workspaceId}, ${String(messageRow.id)}, ${actor.id})
        `;
      }

      const queuedRuns: Run[] = [];
      const invokedAgent = input.invokeAgentActorId
        ? await requireActor(tx, task.workspaceId, input.invokeAgentActorId)
        : null;
      if (invokedAgent && invokedAgent.kind !== "agent") {
        throw new StoreError("agent_required", "Conversation invocation requires an Agent member.");
      }
      if (invokedAgent) {
        const invokedMembershipRows = await tx<DbRow[]>`
          SELECT * FROM conversation_memberships
          WHERE conversation_id = ${conversation.id} AND actor_id = ${invokedAgent.id}
        `;
        if (invokedMembershipRows.length === 0) {
          if (!conversation.isPrimary) {
            throw new StoreError("conversation_member_required", "Invoked Agent is not a member of this conversation.");
          }
          await tx`
            INSERT INTO conversation_memberships (workspace_id, conversation_id, actor_id)
            VALUES (${task.workspaceId}, ${conversation.id}, ${invokedAgent.id})
            ON CONFLICT DO NOTHING
          `;
        }
      }
      const agentActors = invokedAgent
        ? [invokedAgent]
        : (input.enqueueMentionedAgents ?? true)
          ? mentionedActors.filter((actor) => actor.kind === "agent")
          : [];
      if (agentActors.length > 0) {
        if (task.status === "completed" || task.status === "cancelled") {
          throw new StoreError("task_closed", "Request changes before starting another Agent run.");
        }
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
            conversationId: conversation.id,
            triggerMessageId: String(messageRow.id),
            agentActorId: agent.id,
            requestedByActorId: input.actorId,
            ...(input.writerRequired !== undefined
              ? { writerRequired: input.writerRequired }
              : {}),
          });
          queuedRuns.push(queued.run);
          runCount += 1;
        }
      }

      if (queuedRuns.length > 0 && task.status !== "active") {
        await tx`
          UPDATE tasks SET status = 'active', updated_at = now()
          WHERE id = ${task.id}
        `;
      }
      await tx`UPDATE conversations SET updated_at = now() WHERE id = ${conversation.id}`;
      return {
        message: mapMessage(messageRow, mentionedActors.map((actor) => actor.id)),
        queuedRuns,
      };
    });
  }

  async createConversationMessage(
    input: CreateConversationMessageInput,
  ): Promise<CreateMessageResult> {
    const conversationRows = await this.sql<DbRow[]>`
      SELECT * FROM conversations WHERE id = ${input.conversationId}
    `;
    const conversation = mapConversation(one(conversationRows, "Conversation"));
    return this.createMessage({
      taskId: conversation.taskId,
      conversationId: conversation.id,
      actorId: input.actorId,
      body: input.body,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.sourceRunId !== undefined ? { sourceRunId: input.sourceRunId } : {}),
      enqueueMentionedAgents: false,
      ...(input.invokeAgentActorId !== undefined
        ? { invokeAgentActorId: input.invokeAgentActorId }
        : {}),
      ...(input.writerRequired !== undefined ? { writerRequired: input.writerRequired } : {}),
    });
  }

  async queueRun(input: QueueRunInput): Promise<{ run: Run; attempt: RunAttempt }> {
    return this.sql.begin(async (tx) => {
      const taskRows = await tx<DbRow[]>`SELECT * FROM tasks WHERE id = ${input.taskId} FOR UPDATE`;
      const task = mapTask(one(taskRows, "Task"));
      if (task.status === "completed" || task.status === "cancelled") {
        throw new StoreError("task_closed", "Request changes before starting another Agent run.");
      }
      const agent = await requireActor(tx, task.workspaceId, input.agentActorId);
      await requireActor(tx, task.workspaceId, input.requestedByActorId);
      if (agent.kind !== "agent") throw new StoreError("agent_required", "Run recipient must be an agent.");
      const conversationRows = input.conversationId
        ? await tx<DbRow[]>`
            SELECT * FROM conversations
            WHERE id = ${input.conversationId} AND task_id = ${task.id}
          `
        : await tx<DbRow[]>`
            SELECT * FROM conversations WHERE task_id = ${task.id} AND is_primary
          `;
      const conversation = mapConversation(one(conversationRows, "Conversation"));
      if (input.conversationId) {
        const membershipRows = await tx<Array<{ actor_id: string }>>`
          SELECT actor_id FROM conversation_memberships
          WHERE conversation_id = ${conversation.id}
            AND actor_id = ANY(${tx.array([input.requestedByActorId, agent.id])}::uuid[])
        `;
        const memberIds = new Set(membershipRows.map((row) => row.actor_id));
        if (!memberIds.has(input.requestedByActorId) || !memberIds.has(agent.id)) {
          throw new StoreError("conversation_membership_required", "Run participants must belong to the conversation.");
        }
      } else {
        for (const actorId of new Set([input.requestedByActorId, agent.id])) {
          await tx`
            INSERT INTO conversation_memberships (workspace_id, conversation_id, actor_id)
            VALUES (${task.workspaceId}, ${conversation.id}, ${actorId})
            ON CONFLICT DO NOTHING
          `;
        }
      }
      if (input.triggerMessageId) {
        const triggerRows = await tx<DbRow[]>`
          SELECT * FROM messages
          WHERE id = ${input.triggerMessageId} AND conversation_id = ${conversation.id}
        `;
        one(triggerRows, "Trigger message");
      }
      const countRows = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM runs WHERE task_id = ${task.id}
      `;
      if (Number(countRows[0]?.count ?? "0") >= task.runBudget) {
        throw new StoreError("run_budget_exceeded", "Task run budget has been exhausted.");
      }
      const queued = await insertQueuedRun(tx, {
        ...input,
        workspaceId: task.workspaceId,
        conversationId: conversation.id,
      });
      if (task.status !== "active") {
        await tx`UPDATE tasks SET status = 'active', updated_at = now() WHERE id = ${task.id}`;
      }
      return queued;
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
      const sourceRun = mapRun(one(sourceRunRows, "Source run"));

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
        conversationId: sourceRun.conversationId,
        triggerMessageId: sourceRun.triggerMessageId,
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
      if (run.status !== "queued" && run.status !== "running") return run;
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
      await tx`
        UPDATE tasks
        SET status = 'open', updated_at = now()
        WHERE id = ${run.taskId}
          AND status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM runs
            WHERE task_id = ${run.taskId} AND status IN ('queued', 'running')
          )
      `;
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
        FROM run_events WHERE run_id = ${input.claim.runId}
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
      const nextTaskStatus = input.status === "succeeded" ? "review_ready" : "open";
      await tx`
        UPDATE tasks
        SET status = ${nextTaskStatus}, updated_at = ${now}
        WHERE id = ${input.claim.taskId}
          AND status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM runs
            WHERE task_id = ${input.claim.taskId}
              AND id <> ${input.claim.runId}
              AND status IN ('queued', 'running')
          )
      `;
      return { run: mapRun(one(runRows, "Run")), attempt };
    });
  }

  async reviewTask(input: ReviewTaskInput): Promise<Task> {
    return this.sql.begin(async (tx) => {
      const taskRows = await tx<DbRow[]>`
        SELECT * FROM tasks WHERE id = ${input.taskId} FOR UPDATE
      `;
      const task = mapTask(one(taskRows, "Task"));
      const actor = await requireActor(tx, task.workspaceId, input.decidedByActorId);
      assertHumanApproval(actor.kind);
      const activeRows = await tx<Array<{ count: string }>>`
        SELECT count(*)::text AS count
        FROM runs
        WHERE task_id = ${task.id} AND status IN ('queued', 'running')
      `;
      if (Number(activeRows[0]?.count ?? "0") > 0) {
        throw new StoreError("task_busy", "Finish or cancel active Agent runs before reviewing this task.");
      }
      const allowed = input.decision === "request_changes"
        ? ["review_ready", "completed", "cancelled"]
        : ["review_ready"];
      if (!allowed.includes(task.status)) {
        throw new StoreError("review_not_ready", "This task is not ready for a human review decision.");
      }
      const nextStatus = input.decision === "accept"
        ? "completed"
        : input.decision === "reject"
          ? "cancelled"
          : "open";
      const updatedRows = await tx<DbRow[]>`
        UPDATE tasks
        SET status = ${nextStatus}, updated_at = now()
        WHERE id = ${task.id}
        RETURNING *
      `;
      return mapTask(one(updatedRows, "Task"));
    });
  }

  async withTaskPublicationLock<T>(
    input: PublishTaskInput,
    publish: (context: { task: Task; repository: Repository }) => Promise<T>,
  ): Promise<{ task: Task; repository: Repository; result: T }> {
    return this.sql.begin(async (tx) => {
      // queueRun/createMessage also lock this row. Keeping it locked through
      // the small-team push closes the race where a new Agent writer starts
      // between the idle check and SCM publication.
      const taskRows = await tx<DbRow[]>`
        SELECT * FROM tasks WHERE id = ${input.taskId} FOR UPDATE
      `;
      const task = mapTask(one(taskRows, "Task"));
      const actor = await requireActor(tx, task.workspaceId, input.approvedByActorId);
      assertHumanApproval(actor.kind);
      if (task.status !== "completed") {
        throw new StoreError("human_review_required", "Accept the task result before publishing a branch.");
      }
      const repositoryRows = await tx<DbRow[]>`
        SELECT * FROM repositories
        WHERE id = ${task.repositoryId} AND workspace_id = ${task.workspaceId}
        FOR SHARE
      `;
      const repository = mapRepository(one(repositoryRows, "Repository"));
      if (
        repository.kind !== "git" ||
        !repository.remoteUrl ||
        !repository.allowlisted ||
        !repository.enabled
      ) {
        throw new StoreError(
          "repository_not_allowlisted",
          "Publication requires an enabled, allowlisted Git repository.",
        );
      }
      const busyRows = await tx<Array<{ active_runs: string; writer_leases: string }>>`
        SELECT
          (SELECT count(*) FROM runs
           WHERE task_id = ${task.id} AND status IN ('queued', 'running'))::text AS active_runs,
          (SELECT count(*) FROM task_writer_leases
           WHERE task_id = ${task.id} AND expires_at > now())::text AS writer_leases
      `;
      const busy = busyRows[0];
      if (Number(busy?.active_runs ?? "0") > 0 || Number(busy?.writer_leases ?? "0") > 0) {
        throw new StoreError(
          "task_busy",
          "Finish or cancel active Agent runs and release the writer lease before publishing.",
        );
      }
      const result = await publish({ task, repository });
      const updatedRows = await tx<DbRow[]>`
        UPDATE tasks
        SET branch_name = ${input.branchName}, updated_at = now()
        WHERE id = ${task.id}
        RETURNING *
      `;
      return {
        task: mapTask(one(updatedRows, "Task")),
        repository,
        result,
      };
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
