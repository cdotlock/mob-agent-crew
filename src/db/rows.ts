import type {
  Actor,
  AgentProfile,
  Approval,
  Artifact,
  Conversation,
  ConversationMembership,
  Delegation,
  DriverCapabilities,
  Message,
  Repository,
  RepositoryImport,
  Run,
  RunAttempt,
  RunEvent,
  Task,
  UserAuthRecord,
  Workspace,
  WorkspaceDocument,
} from "../domain/model.js";
import { normalizeAgentComposition } from "../domain/agent-composition.js";

export type DbRow = Record<string, unknown>;

function value(row: DbRow, key: string): unknown {
  return row[key];
}

function stringValue(row: DbRow, key: string): string {
  return String(value(row, key));
}

function nullableString(row: DbRow, key: string): string | null {
  const current = value(row, key);
  return current === null || current === undefined ? null : String(current);
}

function dateValue(row: DbRow, key: string): Date {
  const current = value(row, key);
  return current instanceof Date ? current : new Date(String(current));
}

function nullableDate(row: DbRow, key: string): Date | null {
  const current = value(row, key);
  return current === null || current === undefined
    ? null
    : current instanceof Date
      ? current
      : new Date(String(current));
}

function numberValue(row: DbRow, key: string): number {
  return Number(value(row, key));
}

function bigintValue(row: DbRow, key: string): bigint {
  return BigInt(String(value(row, key)));
}

function nullableBigint(row: DbRow, key: string): bigint | null {
  const current = value(row, key);
  return current === null || current === undefined ? null : BigInt(String(current));
}

function booleanValue(row: DbRow, key: string): boolean {
  return Boolean(value(row, key));
}

function objectValue(row: DbRow, key: string): Readonly<Record<string, unknown>> {
  const current = value(row, key);
  if (typeof current === "string") return JSON.parse(current) as Record<string, unknown>;
  return (current ?? {}) as Record<string, unknown>;
}

export function mapWorkspace(row: DbRow): Workspace {
  return {
    id: stringValue(row, "id"),
    slug: stringValue(row, "slug"),
    name: stringValue(row, "name"),
    createdAt: dateValue(row, "created_at"),
    updatedAt: dateValue(row, "updated_at"),
  };
}

export function mapActor(row: DbRow): Actor {
  return {
    id: stringValue(row, "id"),
    workspaceId: stringValue(row, "workspace_id"),
    kind: stringValue(row, "kind") as Actor["kind"],
    handle: stringValue(row, "handle"),
    displayName: stringValue(row, "display_name"),
    status: stringValue(row, "status") as Actor["status"],
    createdAt: dateValue(row, "created_at"),
    updatedAt: dateValue(row, "updated_at"),
  };
}

export function mapUserAuthRecord(row: DbRow): UserAuthRecord {
  return {
    id: stringValue(row, "id"),
    workspaceId: stringValue(row, "workspace_id"),
    actorId: stringValue(row, "actor_id"),
    provider: stringValue(row, "provider"),
    subject: stringValue(row, "subject"),
    email: nullableString(row, "email"),
    passwordHash: nullableString(row, "password_hash"),
    lastLoginAt: nullableDate(row, "last_login_at"),
    createdAt: dateValue(row, "created_at"),
    updatedAt: dateValue(row, "updated_at"),
  };
}

export function mapAgentProfile(row: DbRow): AgentProfile {
  const composition = normalizeAgentComposition({
    modelId: nullableString(row, "model_id"),
    skillRefs: arrayValue(row, "skill_refs"),
    pluginRefs: arrayValue(row, "plugin_refs"),
    environment: objectValue(row, "environment"),
  });
  return {
    actorId: stringValue(row, "actor_id"),
    workspaceId: stringValue(row, "workspace_id"),
    ownerActorId: stringValue(row, "owner_actor_id"),
    driver: stringValue(row, "driver"),
    home: stringValue(row, "home"),
    role: stringValue(row, "role"),
    ...composition,
    capabilities: objectValue(row, "capabilities") as unknown as DriverCapabilities,
    maxConcurrentRuns: numberValue(row, "max_concurrent_runs"),
    createdAt: dateValue(row, "created_at"),
    updatedAt: dateValue(row, "updated_at"),
  };
}

function arrayValue(row: DbRow, key: string): string[] {
  const current = value(row, key);
  if (current === null || current === undefined) return [];
  const parsed = typeof current === "string" ? JSON.parse(current) as unknown : current;
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

export function mapWorkspaceDocument(row: DbRow): WorkspaceDocument {
  return {
    id: stringValue(row, "id"),
    workspaceId: stringValue(row, "workspace_id"),
    name: stringValue(row, "name"),
    content: nullableString(row, "content"),
    localPath: nullableString(row, "local_path"),
    source: stringValue(row, "source"),
    uploadedByActorId: stringValue(row, "uploaded_by_actor_id"),
    createdAt: dateValue(row, "created_at"),
    updatedAt: dateValue(row, "updated_at"),
  };
}

export function mapRepository(row: DbRow): Repository {
  return {
    id: stringValue(row, "id"),
    workspaceId: stringValue(row, "workspace_id"),
    name: stringValue(row, "name"),
    kind: stringValue(row, "kind") as Repository["kind"],
    remoteUrl: nullableString(row, "remote_url"),
    localPath: nullableString(row, "local_path"),
    defaultBranch: stringValue(row, "default_branch"),
    allowlisted: booleanValue(row, "allowlisted"),
    enabled: booleanValue(row, "enabled"),
    createdByActorId: stringValue(row, "created_by_actor_id"),
    createdAt: dateValue(row, "created_at"),
    updatedAt: dateValue(row, "updated_at"),
  };
}

export function mapRepositoryImport(row: DbRow): RepositoryImport {
  return {
    id: stringValue(row, "id"),
    workspaceId: stringValue(row, "workspace_id"),
    sourceUrl: stringValue(row, "source_url"),
    requestedByActorId: stringValue(row, "requested_by_actor_id"),
    repositoryId: nullableString(row, "repository_id"),
    status: stringValue(row, "status") as RepositoryImport["status"],
    failureMessage: nullableString(row, "failure_message"),
    createdAt: dateValue(row, "created_at"),
    completedAt: nullableDate(row, "completed_at"),
  };
}

export function mapTask(row: DbRow): Task {
  return {
    id: stringValue(row, "id"),
    workspaceId: stringValue(row, "workspace_id"),
    repositoryId: nullableString(row, "repository_id"),
    executionConversationId: nullableString(row, "execution_conversation_id"),
    isExecution: booleanValue(row, "is_execution"),
    createdByActorId: stringValue(row, "created_by_actor_id"),
    assignedActorId: nullableString(row, "assigned_actor_id"),
    title: stringValue(row, "title"),
    description: stringValue(row, "description"),
    baseRevision: stringValue(row, "base_revision"),
    branchName: nullableString(row, "branch_name"),
    status: stringValue(row, "status") as Task["status"],
    maxDelegationDepth: numberValue(row, "max_delegation_depth"),
    runBudget: numberValue(row, "run_budget"),
    writerFence: bigintValue(row, "writer_fence"),
    createdAt: dateValue(row, "created_at"),
    updatedAt: dateValue(row, "updated_at"),
  };
}

export function mapMessage(row: DbRow, mentions: string[] = []): Message {
  return {
    id: stringValue(row, "id"),
    workspaceId: stringValue(row, "workspace_id"),
    taskId: nullableString(row, "task_id"),
    conversationId: stringValue(row, "conversation_id"),
    actorId: stringValue(row, "actor_id"),
    sourceRunId: nullableString(row, "source_run_id"),
    kind: stringValue(row, "kind") as Message["kind"],
    body: stringValue(row, "body"),
    mentions,
    createdAt: dateValue(row, "created_at"),
  };
}

export function mapConversation(row: DbRow): Conversation {
  return {
    id: stringValue(row, "id"),
    workspaceId: stringValue(row, "workspace_id"),
    taskId: nullableString(row, "task_id"),
    activeRepositoryId: nullableString(row, "active_repository_id"),
    kind: stringValue(row, "kind") as Conversation["kind"],
    title: nullableString(row, "title"),
    createdByActorId: stringValue(row, "created_by_actor_id"),
    isPrimary: booleanValue(row, "is_primary"),
    createdAt: dateValue(row, "created_at"),
    updatedAt: dateValue(row, "updated_at"),
  };
}

export function mapConversationMembership(row: DbRow): ConversationMembership {
  return {
    workspaceId: stringValue(row, "workspace_id"),
    conversationId: stringValue(row, "conversation_id"),
    actorId: stringValue(row, "actor_id"),
    joinedAt: dateValue(row, "joined_at"),
  };
}

export function mapDelegation(row: DbRow): Delegation {
  return {
    id: stringValue(row, "id"),
    workspaceId: stringValue(row, "workspace_id"),
    taskId: stringValue(row, "task_id"),
    fromActorId: stringValue(row, "from_actor_id"),
    toAgentActorId: stringValue(row, "to_agent_actor_id"),
    sourceRunId: nullableString(row, "source_run_id"),
    parentDelegationId: nullableString(row, "parent_delegation_id"),
    intent: stringValue(row, "intent"),
    deliverable: stringValue(row, "deliverable"),
    depth: numberValue(row, "depth"),
    status: stringValue(row, "status") as Delegation["status"],
    createdAt: dateValue(row, "created_at"),
    updatedAt: dateValue(row, "updated_at"),
    completedAt: nullableDate(row, "completed_at"),
  };
}

export function mapRun(row: DbRow): Run {
  return {
    id: stringValue(row, "id"),
    workspaceId: stringValue(row, "workspace_id"),
    taskId: stringValue(row, "task_id"),
    conversationId: stringValue(row, "conversation_id"),
    triggerMessageId: nullableString(row, "trigger_message_id"),
    waitForRunId: nullableString(row, "wait_for_run_id"),
    agentActorId: stringValue(row, "agent_actor_id"),
    requestedByActorId: stringValue(row, "requested_by_actor_id"),
    delegationId: nullableString(row, "delegation_id"),
    status: stringValue(row, "status") as Run["status"],
    priority: numberValue(row, "priority"),
    writerRequired: booleanValue(row, "writer_required"),
    latestAttemptNumber: numberValue(row, "latest_attempt_number"),
    createdAt: dateValue(row, "created_at"),
    updatedAt: dateValue(row, "updated_at"),
    completedAt: nullableDate(row, "completed_at"),
  };
}

export function mapRunAttempt(row: DbRow): RunAttempt {
  return {
    id: stringValue(row, "id"),
    workspaceId: stringValue(row, "workspace_id"),
    taskId: stringValue(row, "task_id"),
    runId: stringValue(row, "run_id"),
    attemptNumber: numberValue(row, "attempt_number"),
    status: stringValue(row, "status") as RunAttempt["status"],
    workerId: nullableString(row, "worker_id"),
    leaseToken: nullableString(row, "lease_token"),
    fence: bigintValue(row, "fence"),
    writerFence: nullableBigint(row, "writer_fence"),
    leaseExpiresAt: nullableDate(row, "lease_expires_at"),
    startedAt: nullableDate(row, "started_at"),
    completedAt: nullableDate(row, "completed_at"),
    failureCode: nullableString(row, "failure_code"),
    failureMessage: nullableString(row, "failure_message"),
    createdAt: dateValue(row, "created_at"),
    updatedAt: dateValue(row, "updated_at"),
  };
}

export function mapRunEvent(row: DbRow): RunEvent {
  return {
    id: stringValue(row, "id"),
    workspaceId: stringValue(row, "workspace_id"),
    taskId: stringValue(row, "task_id"),
    runId: stringValue(row, "run_id"),
    attemptId: stringValue(row, "attempt_id"),
    sequence: numberValue(row, "sequence"),
    type: stringValue(row, "type"),
    payload: objectValue(row, "payload"),
    createdAt: dateValue(row, "created_at"),
  };
}

export function mapArtifact(row: DbRow): Artifact {
  return {
    id: stringValue(row, "id"),
    workspaceId: stringValue(row, "workspace_id"),
    taskId: stringValue(row, "task_id"),
    actorId: stringValue(row, "actor_id"),
    sourceRunId: nullableString(row, "source_run_id"),
    sourceAttemptId: nullableString(row, "source_attempt_id"),
    kind: stringValue(row, "kind") as Artifact["kind"],
    name: stringValue(row, "name"),
    uri: stringValue(row, "uri"),
    mediaType: nullableString(row, "media_type"),
    byteSize: nullableBigint(row, "byte_size"),
    sha256: nullableString(row, "sha256"),
    metadata: objectValue(row, "metadata"),
    createdAt: dateValue(row, "created_at"),
  };
}

export function mapApproval(row: DbRow): Approval {
  return {
    id: stringValue(row, "id"),
    workspaceId: stringValue(row, "workspace_id"),
    taskId: stringValue(row, "task_id"),
    requestedByActorId: stringValue(row, "requested_by_actor_id"),
    decidedByActorId: nullableString(row, "decided_by_actor_id"),
    kind: stringValue(row, "kind") as Approval["kind"],
    status: stringValue(row, "status") as Approval["status"],
    payload: objectValue(row, "payload"),
    decisionNote: nullableString(row, "decision_note"),
    createdAt: dateValue(row, "created_at"),
    decidedAt: nullableDate(row, "decided_at"),
  };
}
