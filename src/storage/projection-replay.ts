import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type postgres from "postgres";
import type { DatabaseClient } from "../db/client.js";
import type {
  Actor,
  AgentProfile,
  Approval,
  Artifact,
  Conversation,
  ConversationMembership,
  Delegation,
  Message,
  Repository,
  Run,
  RunAttempt,
  RunEvent,
  Task,
  TaskThread,
  Workspace,
  WorkspaceDocument,
} from "../domain/model.js";
import type { FileWorkspaceStore } from "./file-workspace-store.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const REPLAY_ENTITY_NAMES = [
  "workspaces",
  "actors",
  "agent_profiles",
  "repositories",
  "workspace_documents",
  "tasks",
  "conversations",
  "conversation_memberships",
  "messages",
  "message_mentions",
  "delegations",
  "runs",
  "run_attempts",
  "run_events",
  "artifacts",
  "approvals",
] as const;

export type ReplayEntityName = (typeof REPLAY_ENTITY_NAMES)[number];

export interface FileWorkspaceSnapshot {
  workspace: Workspace;
  actors: Actor[];
  agentProfiles: AgentProfile[];
  repositories: Repository[];
  documents: WorkspaceDocument[];
  threads: TaskThread[];
}

export interface ProjectionReplayIssue {
  code: string;
  path: string;
  message: string;
}

export type ProjectionReplayCounts = Record<ReplayEntityName, number>;

export interface ProjectionReplayOperationalCounts {
  activeRuns: number;
  activeAttempts: number;
  activeWriterLeases: number;
  pendingRepositoryImports: number;
  authRecords: number;
  agentProfiles: number;
}

export interface ProjectionReplayDifference {
  missingFromDatabase: ProjectionReplayCounts;
  databaseOnly: ProjectionReplayCounts;
}

export interface ProjectionReplayReport {
  mode: "dry-run" | "apply";
  workspaceId: string;
  valid: boolean;
  applied: boolean;
  fileCounts: ProjectionReplayCounts;
  databaseCounts: ProjectionReplayCounts;
  difference: ProjectionReplayDifference;
  operational: ProjectionReplayOperationalCounts;
  issues: ProjectionReplayIssue[];
  warnings: string[];
}

export interface ReplayWorkspaceProjectionOptions {
  sql: DatabaseClient;
  files: FileWorkspaceStore;
  workspaceId: string;
  apply?: boolean;
  confirmation?: string;
}

export class ProjectionReplayError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProjectionReplayError";
    this.code = code;
  }
}

/**
 * Validates or replays the file-backed collaboration state into PostgreSQL.
 *
 * Dry-run is the default. Apply mode only upserts file-backed rows; it never
 * truncates operational credentials, connector configuration, queues or leases.
 */
export async function replayWorkspaceProjection(
  options: ReplayWorkspaceProjectionOptions,
): Promise<ProjectionReplayReport> {
  const snapshot = await loadFileWorkspaceSnapshot(options.files, options.workspaceId);
  const issues = validateFileWorkspaceSnapshot(snapshot);
  const fileCounts = countFileWorkspaceSnapshot(snapshot);
  const beforeCounts = await readDatabaseCounts(options.sql, options.workspaceId);
  const beforeOperational = await readOperationalCounts(options.sql, options.workspaceId);
  const warnings = replayWarnings(beforeCounts, fileCounts, beforeOperational);

  if (!options.apply) {
    return report(
      "dry-run",
      options.workspaceId,
      false,
      fileCounts,
      beforeCounts,
      beforeOperational,
      issues,
      warnings,
    );
  }

  if (options.confirmation !== options.workspaceId) {
    throw new ProjectionReplayError(
      "confirmation_required",
      `Apply mode requires --confirm ${options.workspaceId}`,
    );
  }
  if (issues.length > 0) {
    throw new ProjectionReplayError(
      "invalid_file_ledger",
      `File ledger validation failed with ${issues.length} issue(s); run the dry-run for details.`,
    );
  }

  await options.sql.begin(async (tx) => {
    // One replay at a time, even if multiple one-shot Railway jobs are started.
    await tx.unsafe("SET LOCAL lock_timeout = '5s'");
    await tx.unsafe("SELECT pg_advisory_xact_lock(514509012320260814)");
    // The normal API does not use the advisory lock. Table locks close that race
    // for this short small-workspace recovery transaction.
    await tx.unsafe(`LOCK TABLE
      workspaces, actors, user_auth_records, agent_profiles, workspace_documents,
      repositories, repository_imports, tasks, conversations,
      conversation_memberships, messages, message_mentions,
      delegations, runs, run_attempts, task_writer_leases, run_events, artifacts,
      approvals IN SHARE ROW EXCLUSIVE MODE`);

    const active = await readOperationalCounts(tx, options.workspaceId);
    if (
      active.activeRuns > 0 ||
      active.activeAttempts > 0 ||
      active.activeWriterLeases > 0 ||
      active.pendingRepositoryImports > 0
    ) {
      throw new ProjectionReplayError(
        "workspace_busy",
        "Projection replay requires an idle workspace: finish or cancel active runs/imports and release writer leases first.",
      );
    }
    await applySnapshot(tx, snapshot);
  });

  const afterCounts = await readDatabaseCounts(options.sql, options.workspaceId);
  const afterOperational = await readOperationalCounts(options.sql, options.workspaceId);
  return report(
    "apply",
    options.workspaceId,
    true,
    fileCounts,
    afterCounts,
    afterOperational,
    [],
    replayWarnings(afterCounts, fileCounts, afterOperational),
  );
}

export async function loadFileWorkspaceSnapshot(
  files: FileWorkspaceStore,
  workspaceId: string,
): Promise<FileWorkspaceSnapshot> {
  const workspace = await files.readWorkspace(workspaceId);
  if (!workspace) {
    throw new ProjectionReplayError(
      "workspace_file_missing",
      `No workspace.json exists for ${workspaceId} under ${files.stateRoot}.`,
    );
  }
  const root = files.workspaceRoot(workspaceId);
  const actorIds = await regularEntryIds(join(root, "actors"), ".json", "file");
  const repositoryIds = await regularEntryIds(join(root, "repositories"), ".json", "file");
  const agentActorIds = await regularEntryIds(join(root, "agents"), "", "directory");
  const documentIds = await regularEntryIds(join(root, "documents"), ".json", "file");
  const taskIds = await regularEntryIds(join(root, "tasks"), "", "directory");

  const actors = await readRequired(actorIds, (id) => files.readActor(workspaceId, id), "actor");
  const repositories = await readRequired(
    repositoryIds,
    (id) => files.readRepository(workspaceId, id),
    "repository",
  );
  const agentProfiles = await readRequired(
    agentActorIds,
    (id) => files.readAgentProfile(workspaceId, id),
    "agent profile",
  );
  const documents = await readRequired(
    documentIds,
    (id) => files.readDocument(workspaceId, id),
    "document",
  );
  const threads = await readRequired(
    taskIds,
    (id) => files.readTaskThread(workspaceId, id),
    "task thread",
  );

  return {
    workspace,
    actors: actors.sort(compareId),
    agentProfiles: agentProfiles.sort((left, right) => left.actorId.localeCompare(right.actorId)),
    repositories: repositories.sort(compareId),
    documents: documents.sort(compareId),
    threads: threads.sort((left, right) => left.task.id.localeCompare(right.task.id)),
  };
}

export function countFileWorkspaceSnapshot(snapshot: FileWorkspaceSnapshot): ProjectionReplayCounts {
  const messages = snapshot.threads.flatMap((thread) => thread.messages);
  return {
    workspaces: 1,
    actors: snapshot.actors.length,
    agent_profiles: snapshot.agentProfiles.length,
    repositories: snapshot.repositories.length,
    workspace_documents: snapshot.documents.length,
    tasks: snapshot.threads.length,
    conversations: snapshot.threads.reduce((total, thread) => total + thread.conversations.length, 0),
    conversation_memberships: snapshot.threads.reduce(
      (total, thread) => total + thread.conversationMemberships.length,
      0,
    ),
    messages: messages.length,
    message_mentions: messages.reduce((total, message) => total + message.mentions.length, 0),
    delegations: snapshot.threads.reduce((total, thread) => total + thread.delegations.length, 0),
    runs: snapshot.threads.reduce((total, thread) => total + thread.runs.length, 0),
    run_attempts: snapshot.threads.reduce((total, thread) => total + thread.attempts.length, 0),
    run_events: snapshot.threads.reduce((total, thread) => total + thread.events.length, 0),
    artifacts: snapshot.threads.reduce((total, thread) => total + thread.artifacts.length, 0),
    approvals: snapshot.threads.reduce((total, thread) => total + thread.approvals.length, 0),
  };
}

export function validateFileWorkspaceSnapshot(
  snapshot: FileWorkspaceSnapshot,
): ProjectionReplayIssue[] {
  const issues: ProjectionReplayIssue[] = [];
  const workspaceId = snapshot.workspace.id;
  checkUuid(issues, workspaceId, "workspace.id");

  const actors = indexed(snapshot.actors, "actors", issues);
  const agentProfiles = new Map<string, AgentProfile>();
  for (const profile of snapshot.agentProfiles) {
    if (agentProfiles.has(profile.actorId)) {
      issue(issues, "duplicate_id", `agentProfiles/${profile.actorId}`, profile.actorId);
    } else {
      agentProfiles.set(profile.actorId, profile);
    }
    checkUuid(issues, profile.actorId, `agentProfiles/${profile.actorId}.actorId`);
    checkWorkspace(issues, profile.workspaceId, workspaceId, `agentProfiles/${profile.actorId}`);
    reference(issues, actors, profile.actorId, `agentProfiles/${profile.actorId}.actorId`);
    reference(issues, actors, profile.ownerActorId, `agentProfiles/${profile.actorId}.ownerActorId`);
  }
  const repositories = indexed(snapshot.repositories, "repositories", issues);
  const documents = indexed(snapshot.documents, "documents", issues);
  const tasks = indexed(snapshot.threads.map((thread) => thread.task), "tasks", issues);
  const conversations = indexed(
    snapshot.threads.flatMap((thread) => thread.conversations),
    "conversations",
    issues,
  );
  const conversationMemberships = snapshot.threads.flatMap(
    (thread) => thread.conversationMemberships,
  );
  const messages = indexed(snapshot.threads.flatMap((thread) => thread.messages), "messages", issues);
  const delegations = indexed(
    snapshot.threads.flatMap((thread) => thread.delegations),
    "delegations",
    issues,
  );
  const runs = indexed(snapshot.threads.flatMap((thread) => thread.runs), "runs", issues);
  const attempts = indexed(snapshot.threads.flatMap((thread) => thread.attempts), "attempts", issues);
  const events = indexed(snapshot.threads.flatMap((thread) => thread.events), "events", issues);
  const artifacts = indexed(snapshot.threads.flatMap((thread) => thread.artifacts), "artifacts", issues);
  const approvals = indexed(snapshot.threads.flatMap((thread) => thread.approvals), "approvals", issues);

  for (const [collection, values] of [
    ["actors", snapshot.actors],
    ["repositories", snapshot.repositories],
    ["documents", snapshot.documents],
    ["tasks", [...tasks.values()]],
    ["conversations", [...conversations.values()]],
    ["messages", [...messages.values()]],
    ["delegations", [...delegations.values()]],
    ["runs", [...runs.values()]],
    ["attempts", [...attempts.values()]],
    ["events", [...events.values()]],
    ["artifacts", [...artifacts.values()]],
    ["approvals", [...approvals.values()]],
  ] as const) {
    for (const value of values) {
      checkUuid(issues, value.id, `${collection}/${value.id}.id`);
      checkWorkspace(issues, value.workspaceId, workspaceId, `${collection}/${value.id}`);
    }
  }

  for (const repository of repositories.values()) {
    reference(issues, actors, repository.createdByActorId, `repositories/${repository.id}.createdByActorId`);
  }
  for (const document of documents.values()) {
    reference(issues, actors, document.uploadedByActorId, `documents/${document.id}.uploadedByActorId`);
  }
  for (const task of tasks.values()) {
    reference(issues, repositories, task.repositoryId, `tasks/${task.id}.repositoryId`);
    reference(issues, actors, task.createdByActorId, `tasks/${task.id}.createdByActorId`);
    if (task.assignedActorId) reference(issues, actors, task.assignedActorId, `tasks/${task.id}.assignedActorId`);
  }
  const membershipKeys = new Set<string>();
  for (const conversation of conversations.values()) {
    reference(issues, tasks, conversation.taskId, `conversations/${conversation.id}.taskId`);
    reference(
      issues,
      actors,
      conversation.createdByActorId,
      `conversations/${conversation.id}.createdByActorId`,
    );
  }
  for (const membership of conversationMemberships) {
    checkWorkspace(
      issues,
      membership.workspaceId,
      workspaceId,
      `conversationMemberships/${membership.conversationId}/${membership.actorId}`,
    );
    reference(
      issues,
      conversations,
      membership.conversationId,
      `conversationMemberships/${membership.conversationId}.conversationId`,
    );
    reference(
      issues,
      actors,
      membership.actorId,
      `conversationMemberships/${membership.conversationId}.actorId`,
    );
    const key = `${membership.conversationId}:${membership.actorId}`;
    if (membershipKeys.has(key)) {
      issue(issues, "duplicate_membership", `conversationMemberships/${key}`, key);
    }
    membershipKeys.add(key);
  }
  for (const message of messages.values()) {
    reference(issues, tasks, message.taskId, `messages/${message.id}.taskId`);
    const conversation = reference(
      issues,
      conversations,
      message.conversationId,
      `messages/${message.id}.conversationId`,
    );
    if (conversation && conversation.taskId !== message.taskId) {
      issue(issues, "task_mismatch", `messages/${message.id}.conversationId`, message.conversationId);
    }
    reference(issues, actors, message.actorId, `messages/${message.id}.actorId`);
    if (message.sourceRunId) reference(issues, runs, message.sourceRunId, `messages/${message.id}.sourceRunId`);
    const uniqueMentions = new Set<string>();
    for (const actorId of message.mentions) {
      reference(issues, actors, actorId, `messages/${message.id}.mentions`);
      if (uniqueMentions.has(actorId)) issue(issues, "duplicate_mention", `messages/${message.id}.mentions`, actorId);
      uniqueMentions.add(actorId);
    }
  }
  for (const delegation of delegations.values()) {
    reference(issues, tasks, delegation.taskId, `delegations/${delegation.id}.taskId`);
    reference(issues, actors, delegation.fromActorId, `delegations/${delegation.id}.fromActorId`);
    reference(issues, actors, delegation.toAgentActorId, `delegations/${delegation.id}.toAgentActorId`);
    if (delegation.sourceRunId) reference(issues, runs, delegation.sourceRunId, `delegations/${delegation.id}.sourceRunId`);
    if (delegation.parentDelegationId) reference(issues, delegations, delegation.parentDelegationId, `delegations/${delegation.id}.parentDelegationId`);
  }
  for (const run of runs.values()) {
    reference(issues, tasks, run.taskId, `runs/${run.id}.taskId`);
    const conversation = reference(
      issues,
      conversations,
      run.conversationId,
      `runs/${run.id}.conversationId`,
    );
    if (conversation && conversation.taskId !== run.taskId) {
      issue(issues, "task_mismatch", `runs/${run.id}.conversationId`, run.conversationId);
    }
    if (run.triggerMessageId) {
      const trigger = reference(
        issues,
        messages,
        run.triggerMessageId,
        `runs/${run.id}.triggerMessageId`,
      );
      if (trigger && trigger.conversationId !== run.conversationId) {
        issue(issues, "conversation_mismatch", `runs/${run.id}.triggerMessageId`, run.triggerMessageId);
      }
    }
    reference(issues, actors, run.agentActorId, `runs/${run.id}.agentActorId`);
    reference(issues, actors, run.requestedByActorId, `runs/${run.id}.requestedByActorId`);
    if (run.delegationId) reference(issues, delegations, run.delegationId, `runs/${run.id}.delegationId`);
  }
  for (const attempt of attempts.values()) {
    reference(issues, tasks, attempt.taskId, `attempts/${attempt.id}.taskId`);
    const run = reference(issues, runs, attempt.runId, `attempts/${attempt.id}.runId`);
    if (run && run.taskId !== attempt.taskId) issue(issues, "task_mismatch", `attempts/${attempt.id}.taskId`, attempt.taskId);
  }
  for (const event of events.values()) {
    reference(issues, tasks, event.taskId, `events/${event.id}.taskId`);
    const run = reference(issues, runs, event.runId, `events/${event.id}.runId`);
    const attempt = reference(issues, attempts, event.attemptId, `events/${event.id}.attemptId`);
    if (run && run.taskId !== event.taskId) issue(issues, "task_mismatch", `events/${event.id}.taskId`, event.taskId);
    if (attempt && (attempt.runId !== event.runId || attempt.taskId !== event.taskId)) {
      issue(issues, "attempt_mismatch", `events/${event.id}.attemptId`, event.attemptId);
    }
  }
  for (const artifact of artifacts.values()) {
    reference(issues, tasks, artifact.taskId, `artifacts/${artifact.id}.taskId`);
    reference(issues, actors, artifact.actorId, `artifacts/${artifact.id}.actorId`);
    if (artifact.sourceRunId) reference(issues, runs, artifact.sourceRunId, `artifacts/${artifact.id}.sourceRunId`);
    if (artifact.sourceAttemptId) reference(issues, attempts, artifact.sourceAttemptId, `artifacts/${artifact.id}.sourceAttemptId`);
  }
  for (const approval of approvals.values()) {
    reference(issues, tasks, approval.taskId, `approvals/${approval.id}.taskId`);
    reference(issues, actors, approval.requestedByActorId, `approvals/${approval.id}.requestedByActorId`);
    if (approval.decidedByActorId) reference(issues, actors, approval.decidedByActorId, `approvals/${approval.id}.decidedByActorId`);
  }

  return issues.sort((left, right) =>
    left.path === right.path ? left.code.localeCompare(right.code) : left.path.localeCompare(right.path),
  );
}

type ReplaySql = Pick<DatabaseClient, "unsafe">;

async function readDatabaseCounts(sql: ReplaySql, workspaceId: string): Promise<ProjectionReplayCounts> {
  const rows = await sql.unsafe<Array<{ entity: ReplayEntityName; count: string }>>(
    `SELECT 'workspaces' AS entity, count(*)::text AS count FROM workspaces WHERE id = $1
     UNION ALL SELECT 'actors', count(*)::text FROM actors WHERE workspace_id = $1
     UNION ALL SELECT 'agent_profiles', count(*)::text FROM agent_profiles WHERE workspace_id = $1
     UNION ALL SELECT 'repositories', count(*)::text FROM repositories WHERE workspace_id = $1
     UNION ALL SELECT 'workspace_documents', count(*)::text FROM workspace_documents WHERE workspace_id = $1
     UNION ALL SELECT 'tasks', count(*)::text FROM tasks WHERE workspace_id = $1
     UNION ALL SELECT 'conversations', count(*)::text FROM conversations WHERE workspace_id = $1
     UNION ALL SELECT 'conversation_memberships', count(*)::text FROM conversation_memberships WHERE workspace_id = $1
     UNION ALL SELECT 'messages', count(*)::text FROM messages WHERE workspace_id = $1
     UNION ALL SELECT 'message_mentions', count(*)::text FROM message_mentions WHERE workspace_id = $1
     UNION ALL SELECT 'delegations', count(*)::text FROM delegations WHERE workspace_id = $1
     UNION ALL SELECT 'runs', count(*)::text FROM runs WHERE workspace_id = $1
     UNION ALL SELECT 'run_attempts', count(*)::text FROM run_attempts WHERE workspace_id = $1
     UNION ALL SELECT 'run_events', count(*)::text FROM run_events WHERE workspace_id = $1
     UNION ALL SELECT 'artifacts', count(*)::text FROM artifacts WHERE workspace_id = $1
     UNION ALL SELECT 'approvals', count(*)::text FROM approvals WHERE workspace_id = $1`,
    [workspaceId],
  );
  const counts = emptyCounts();
  for (const row of rows) counts[row.entity] = Number(row.count);
  return counts;
}

async function readOperationalCounts(
  sql: ReplaySql,
  workspaceId: string,
): Promise<ProjectionReplayOperationalCounts> {
  const rows = await sql.unsafe<Array<Record<string, string>>>(
    `SELECT
       (SELECT count(*) FROM runs WHERE workspace_id = $1 AND status IN ('queued', 'running'))::text AS active_runs,
       (SELECT count(*) FROM run_attempts WHERE workspace_id = $1 AND status IN ('claimed', 'running'))::text AS active_attempts,
       (SELECT count(*) FROM task_writer_leases WHERE workspace_id = $1 AND expires_at > now())::text AS active_writer_leases,
       (SELECT count(*) FROM repository_imports WHERE workspace_id = $1 AND status = 'pending')::text AS pending_repository_imports,
       (SELECT count(*) FROM user_auth_records WHERE workspace_id = $1)::text AS auth_records,
       (SELECT count(*) FROM agent_profiles WHERE workspace_id = $1)::text AS agent_profiles`,
    [workspaceId],
  );
  const row = rows[0] ?? {};
  return {
    activeRuns: Number(row.active_runs ?? 0),
    activeAttempts: Number(row.active_attempts ?? 0),
    activeWriterLeases: Number(row.active_writer_leases ?? 0),
    pendingRepositoryImports: Number(row.pending_repository_imports ?? 0),
    authRecords: Number(row.auth_records ?? 0),
    agentProfiles: Number(row.agent_profiles ?? 0),
  };
}

async function applySnapshot(sql: ReplaySql, snapshot: FileWorkspaceSnapshot): Promise<void> {
  const rows = replayRows(snapshot);
  await upsertRows(sql, WORKSPACES, rows.workspaces);
  await upsertRows(sql, ACTORS, rows.actors);
  await upsertRows(sql, AGENT_PROFILES, rows.agent_profiles);
  await upsertRows(sql, REPOSITORIES, rows.repositories);
  await upsertRows(sql, DOCUMENTS, rows.workspace_documents);
  await upsertRows(sql, TASKS, rows.tasks);
  await upsertRows(sql, CONVERSATIONS, rows.conversations);
  await upsertRows(sql, CONVERSATION_MEMBERSHIPS, rows.conversation_memberships);

  // Delegations and runs reference each other; runs can also reference the
  // message that triggered them while messages can reference a source run.
  // Insert those nullable edges last after every identity exists.
  await upsertRows(sql, DELEGATIONS, rows.delegations.map((row) => ({
    ...row,
    source_run_id: null,
    parent_delegation_id: null,
  })));
  await upsertRows(sql, RUNS, rows.runs.map((row) => ({
    ...row,
    delegation_id: null,
    trigger_message_id: null,
  })));
  await updateNullableEdges(sql, "delegations", rows.delegations, [
    ["source_run_id", "uuid"],
    ["parent_delegation_id", "uuid"],
  ]);
  await upsertRows(sql, MESSAGES, rows.messages);
  await updateNullableEdges(sql, "runs", rows.runs, [
    ["delegation_id", "uuid"],
    ["trigger_message_id", "uuid"],
  ]);

  await upsertRows(sql, ATTEMPTS, rows.run_attempts);
  await upsertRows(sql, MENTIONS, rows.message_mentions);
  await upsertRows(sql, EVENTS, rows.run_events);
  await upsertRows(sql, ARTIFACTS, rows.artifacts);
  await upsertRows(sql, APPROVALS, rows.approvals);
}

interface ReplayRows {
  workspaces: Record<string, unknown>[];
  actors: Record<string, unknown>[];
  agent_profiles: Record<string, unknown>[];
  repositories: Record<string, unknown>[];
  workspace_documents: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  conversations: Record<string, unknown>[];
  conversation_memberships: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  message_mentions: Record<string, unknown>[];
  delegations: Record<string, unknown>[];
  runs: Record<string, unknown>[];
  run_attempts: Record<string, unknown>[];
  run_events: Record<string, unknown>[];
  artifacts: Record<string, unknown>[];
  approvals: Record<string, unknown>[];
}

function replayRows(snapshot: FileWorkspaceSnapshot): ReplayRows {
  const messages = snapshot.threads.flatMap((thread) => thread.messages);
  const runs = snapshot.threads.flatMap((thread) => thread.runs);
  const attempts = snapshot.threads.flatMap((thread) => thread.attempts);
  const recoverableRunIds = new Set(
    runs.filter((run) => run.status === "queued" || run.status === "running").map((run) => run.id),
  );
  const latestAttemptByRun = new Map(runs.map((run) => [run.id, run.latestAttemptNumber]));

  return {
    workspaces: [{
      id: snapshot.workspace.id,
      slug: snapshot.workspace.slug,
      name: snapshot.workspace.name,
      created_at: iso(snapshot.workspace.createdAt),
      updated_at: iso(snapshot.workspace.updatedAt),
    }],
    actors: snapshot.actors.map((actor) => ({
      id: actor.id,
      workspace_id: actor.workspaceId,
      kind: actor.kind,
      handle: actor.handle,
      display_name: actor.displayName,
      status: actor.status,
      created_at: iso(actor.createdAt),
      updated_at: iso(actor.updatedAt),
    })),
    agent_profiles: snapshot.agentProfiles.map((profile) => ({
      actor_id: profile.actorId,
      workspace_id: profile.workspaceId,
      owner_actor_id: profile.ownerActorId,
      driver: profile.driver,
      home: profile.home,
      role: profile.role,
      capabilities: profile.capabilities,
      max_concurrent_runs: profile.maxConcurrentRuns,
      created_at: iso(profile.createdAt),
      updated_at: iso(profile.updatedAt),
    })),
    repositories: snapshot.repositories.map((repository) => ({
      id: repository.id,
      workspace_id: repository.workspaceId,
      name: repository.name,
      kind: repository.kind,
      remote_url: repository.remoteUrl,
      local_path: repository.localPath,
      default_branch: repository.defaultBranch,
      allowlisted: repository.allowlisted,
      enabled: repository.enabled,
      created_by_actor_id: repository.createdByActorId,
      created_at: iso(repository.createdAt),
      updated_at: iso(repository.updatedAt),
    })),
    workspace_documents: snapshot.documents.map((document) => ({
      id: document.id,
      workspace_id: document.workspaceId,
      name: document.name,
      content: document.content,
      local_path: document.localPath,
      source: document.source,
      uploaded_by_actor_id: document.uploadedByActorId,
      created_at: iso(document.createdAt),
      updated_at: iso(document.updatedAt),
    })),
    tasks: snapshot.threads.map(({ task }) => ({
      id: task.id,
      workspace_id: task.workspaceId,
      repository_id: task.repositoryId,
      created_by_actor_id: task.createdByActorId,
      assigned_actor_id: task.assignedActorId,
      title: task.title,
      description: task.description,
      base_revision: task.baseRevision,
      branch_name: task.branchName,
      status: task.status,
      max_delegation_depth: task.maxDelegationDepth,
      run_budget: task.runBudget,
      writer_fence: task.writerFence.toString(),
      created_at: iso(task.createdAt),
      updated_at: iso(task.updatedAt),
    })),
    conversations: snapshot.threads.flatMap((thread) => thread.conversations).map(
      (conversation: Conversation) => ({
        id: conversation.id,
        workspace_id: conversation.workspaceId,
        task_id: conversation.taskId,
        kind: conversation.kind,
        title: conversation.title,
        created_by_actor_id: conversation.createdByActorId,
        is_primary: conversation.isPrimary,
        created_at: iso(conversation.createdAt),
        updated_at: iso(conversation.updatedAt),
      }),
    ),
    conversation_memberships: snapshot.threads
      .flatMap((thread) => thread.conversationMemberships)
      .map((membership: ConversationMembership) => ({
        workspace_id: membership.workspaceId,
        conversation_id: membership.conversationId,
        actor_id: membership.actorId,
        joined_at: iso(membership.joinedAt),
      })),
    messages: messages.map((message) => ({
      id: message.id,
      workspace_id: message.workspaceId,
      task_id: message.taskId,
      conversation_id: message.conversationId,
      actor_id: message.actorId,
      source_run_id: message.sourceRunId,
      kind: message.kind,
      body: message.body,
      created_at: iso(message.createdAt),
    })),
    message_mentions: messages.flatMap((message) => message.mentions.map((actorId) => ({
      workspace_id: message.workspaceId,
      message_id: message.id,
      actor_id: actorId,
      created_at: iso(message.createdAt),
    }))),
    delegations: snapshot.threads.flatMap((thread) => thread.delegations).map((delegation) => ({
      id: delegation.id,
      workspace_id: delegation.workspaceId,
      task_id: delegation.taskId,
      from_actor_id: delegation.fromActorId,
      to_agent_actor_id: delegation.toAgentActorId,
      source_run_id: delegation.sourceRunId,
      parent_delegation_id: delegation.parentDelegationId,
      intent: delegation.intent,
      deliverable: delegation.deliverable,
      depth: delegation.depth,
      status: delegation.status,
      created_at: iso(delegation.createdAt),
      updated_at: iso(delegation.updatedAt),
      completed_at: nullableIso(delegation.completedAt),
    })),
    runs: runs.map((run) => ({
      id: run.id,
      workspace_id: run.workspaceId,
      task_id: run.taskId,
      conversation_id: run.conversationId,
      trigger_message_id: run.triggerMessageId,
      agent_actor_id: run.agentActorId,
      requested_by_actor_id: run.requestedByActorId,
      delegation_id: run.delegationId,
      status: recoverableRunIds.has(run.id) ? "queued" : run.status,
      priority: run.priority,
      writer_required: run.writerRequired,
      latest_attempt_number: run.latestAttemptNumber,
      created_at: iso(run.createdAt),
      updated_at: iso(run.updatedAt),
      completed_at: recoverableRunIds.has(run.id) ? null : nullableIso(run.completedAt),
    })),
    run_attempts: attempts.map((attempt) => {
      const interrupted = recoverableRunIds.has(attempt.runId) &&
        (attempt.status === "claimed" || attempt.status === "running");
      const isLatest = latestAttemptByRun.get(attempt.runId) === attempt.attemptNumber;
      return {
        id: attempt.id,
        workspace_id: attempt.workspaceId,
        task_id: attempt.taskId,
        run_id: attempt.runId,
        attempt_number: attempt.attemptNumber,
        status: interrupted ? (isLatest ? "queued" : "failed") : attempt.status,
        worker_id: null,
        lease_token: null,
        fence: attempt.fence.toString(),
        writer_fence: null,
        lease_expires_at: null,
        started_at: interrupted && isLatest ? null : nullableIso(attempt.startedAt),
        completed_at: interrupted && !isLatest ? iso(attempt.updatedAt) : nullableIso(attempt.completedAt),
        failure_code: interrupted && !isLatest ? "replay_interrupted" : attempt.failureCode,
        failure_message: interrupted && !isLatest
          ? "Interrupted non-latest attempt recovered from the file ledger."
          : attempt.failureMessage,
        created_at: iso(attempt.createdAt),
        updated_at: iso(attempt.updatedAt),
      };
    }),
    run_events: snapshot.threads.flatMap((thread) => thread.events).map((event) => ({
      id: event.id,
      workspace_id: event.workspaceId,
      task_id: event.taskId,
      run_id: event.runId,
      attempt_id: event.attemptId,
      sequence: event.sequence,
      type: event.type,
      payload: event.payload,
      created_at: iso(event.createdAt),
    })),
    artifacts: snapshot.threads.flatMap((thread) => thread.artifacts).map((artifact) => ({
      id: artifact.id,
      workspace_id: artifact.workspaceId,
      task_id: artifact.taskId,
      actor_id: artifact.actorId,
      source_run_id: artifact.sourceRunId,
      source_attempt_id: artifact.sourceAttemptId,
      kind: artifact.kind,
      name: artifact.name,
      uri: artifact.uri,
      media_type: artifact.mediaType,
      byte_size: artifact.byteSize?.toString() ?? null,
      sha256: artifact.sha256,
      metadata: artifact.metadata,
      created_at: iso(artifact.createdAt),
    })),
    approvals: snapshot.threads.flatMap((thread) => thread.approvals).map((approval) => ({
      id: approval.id,
      workspace_id: approval.workspaceId,
      task_id: approval.taskId,
      requested_by_actor_id: approval.requestedByActorId,
      decided_by_actor_id: approval.decidedByActorId,
      kind: approval.kind,
      status: approval.status,
      payload: approval.payload,
      decision_note: approval.decisionNote,
      created_at: iso(approval.createdAt),
      decided_at: nullableIso(approval.decidedAt),
    })),
  };
}

interface ColumnSpec {
  name: string;
  type: string;
}

interface UpsertSpec {
  table: ReplayEntityName;
  columns: ColumnSpec[];
  conflict: string[];
  immutable?: string[];
  expressions?: Record<string, string>;
  doNothing?: boolean;
}

const columns = (source: string): ColumnSpec[] => source.split(/\s*,\s*/u).map((entry) => {
  const [name, ...type] = entry.trim().split(/\s+/u);
  if (!name || type.length === 0) throw new Error(`Invalid replay column: ${entry}`);
  return { name, type: type.join(" ") };
});

const WORKSPACES = spec("workspaces", "id uuid, slug text, name text, created_at timestamptz, updated_at timestamptz", ["id"]);
const ACTORS = spec("actors", "id uuid, workspace_id uuid, kind text, handle text, display_name text, status text, created_at timestamptz, updated_at timestamptz", ["id"], ["workspace_id", "kind"]);
const AGENT_PROFILES = spec("agent_profiles", "actor_id uuid, workspace_id uuid, owner_actor_id uuid, driver text, home text, role text, capabilities jsonb, max_concurrent_runs integer, created_at timestamptz, updated_at timestamptz", ["actor_id"], ["workspace_id"]);
const REPOSITORIES = spec("repositories", "id uuid, workspace_id uuid, name text, kind text, remote_url text, local_path text, default_branch text, allowlisted boolean, enabled boolean, created_by_actor_id uuid, created_at timestamptz, updated_at timestamptz", ["id"], ["workspace_id"]);
const DOCUMENTS = spec("workspace_documents", "id uuid, workspace_id uuid, name text, content text, local_path text, source text, uploaded_by_actor_id uuid, created_at timestamptz, updated_at timestamptz", ["id"], ["workspace_id"]);
const TASKS = spec("tasks", "id uuid, workspace_id uuid, repository_id uuid, created_by_actor_id uuid, assigned_actor_id uuid, title text, description text, base_revision text, branch_name text, status text, max_delegation_depth integer, run_budget integer, writer_fence bigint, created_at timestamptz, updated_at timestamptz", ["id"], ["workspace_id"], { writer_fence: "GREATEST(tasks.writer_fence, EXCLUDED.writer_fence)" });
const CONVERSATIONS = spec("conversations", "id uuid, workspace_id uuid, task_id uuid, kind text, title text, created_by_actor_id uuid, is_primary boolean, created_at timestamptz, updated_at timestamptz", ["id"], ["workspace_id", "task_id"]);
const CONVERSATION_MEMBERSHIPS = spec("conversation_memberships", "workspace_id uuid, conversation_id uuid, actor_id uuid, joined_at timestamptz", ["conversation_id", "actor_id"], [], {}, true);
const MESSAGES = spec("messages", "id uuid, workspace_id uuid, task_id uuid, conversation_id uuid, actor_id uuid, source_run_id uuid, kind text, body text, created_at timestamptz", ["id"], ["workspace_id", "task_id", "conversation_id"]);
const MENTIONS = spec("message_mentions", "workspace_id uuid, message_id uuid, actor_id uuid, created_at timestamptz", ["message_id", "actor_id"], [], {}, true);
const DELEGATIONS = spec("delegations", "id uuid, workspace_id uuid, task_id uuid, from_actor_id uuid, to_agent_actor_id uuid, source_run_id uuid, parent_delegation_id uuid, intent text, deliverable text, depth integer, status text, created_at timestamptz, updated_at timestamptz, completed_at timestamptz", ["id"], ["workspace_id", "task_id"]);
const RUNS = spec("runs", "id uuid, workspace_id uuid, task_id uuid, conversation_id uuid, trigger_message_id uuid, agent_actor_id uuid, requested_by_actor_id uuid, delegation_id uuid, status text, priority integer, writer_required boolean, latest_attempt_number integer, created_at timestamptz, updated_at timestamptz, completed_at timestamptz", ["id"], ["workspace_id", "task_id", "conversation_id", "status", "completed_at"]);
const ATTEMPTS = spec("run_attempts", "id uuid, workspace_id uuid, task_id uuid, run_id uuid, attempt_number integer, status text, worker_id text, lease_token uuid, fence bigint, writer_fence bigint, lease_expires_at timestamptz, started_at timestamptz, completed_at timestamptz, failure_code text, failure_message text, created_at timestamptz, updated_at timestamptz", ["id"], ["workspace_id", "task_id", "run_id", "status", "worker_id", "lease_token", "fence", "writer_fence", "lease_expires_at", "started_at", "completed_at", "failure_code", "failure_message"]);
const EVENTS = spec("run_events", "id uuid, workspace_id uuid, task_id uuid, run_id uuid, attempt_id uuid, sequence integer, type text, payload jsonb, created_at timestamptz", ["id"], ["workspace_id", "task_id", "run_id", "attempt_id"]);
const ARTIFACTS = spec("artifacts", "id uuid, workspace_id uuid, task_id uuid, actor_id uuid, source_run_id uuid, source_attempt_id uuid, kind text, name text, uri text, media_type text, byte_size bigint, sha256 text, metadata jsonb, created_at timestamptz", ["id"], ["workspace_id", "task_id"]);
const APPROVALS = spec("approvals", "id uuid, workspace_id uuid, task_id uuid, requested_by_actor_id uuid, decided_by_actor_id uuid, kind text, status text, payload jsonb, decision_note text, created_at timestamptz, decided_at timestamptz", ["id"], ["workspace_id", "task_id"]);

function spec(
  table: ReplayEntityName,
  source: string,
  conflict: string[],
  immutable: string[] = [],
  expressions: Record<string, string> = {},
  doNothing = false,
): UpsertSpec {
  return { table, columns: columns(source), conflict, immutable, expressions, doNothing };
}

async function upsertRows(sql: ReplaySql, value: UpsertSpec, rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  const names = value.columns.map((column) => column.name);
  const input = value.columns.map((column) => `${column.name} ${column.type}`).join(", ");
  const updates = names
    .filter((name) => !value.conflict.includes(name) && !(value.immutable ?? []).includes(name))
    .map((name) => `${name} = ${value.expressions?.[name] ?? `EXCLUDED.${name}`}`)
    .join(", ");
  const conflict = value.doNothing
    ? `ON CONFLICT (${value.conflict.join(", ")}) DO NOTHING`
    : `ON CONFLICT (${value.conflict.join(", ")}) DO UPDATE SET ${updates}`;
  await sql.unsafe(
    `INSERT INTO ${value.table} (${names.join(", ")})
     SELECT ${names.join(", ")} FROM jsonb_to_recordset($1::jsonb) AS input(${input})
     ${conflict}`,
    [jsonParameter(rows)],
  );
}

async function updateNullableEdges(
  sql: ReplaySql,
  table: "delegations" | "runs",
  rows: Record<string, unknown>[],
  edges: Array<[string, string]>,
): Promise<void> {
  if (rows.length === 0) return;
  const edgeNames = edges.map(([name]) => name);
  const fields = ["id", ...edgeNames];
  const input = ["id uuid", ...edges.map(([name, type]) => `${name} ${type}`)].join(", ");
  await sql.unsafe(
    `UPDATE ${table} AS target SET ${edgeNames.map((name) => `${name} = input.${name}`).join(", ")}
     FROM jsonb_to_recordset($1::jsonb) AS input(${input})
     WHERE target.id = input.id`,
    [jsonParameter(rows.map((row) => Object.fromEntries(fields.map((field) => [field, row[field]]))))],
  );
}

function report(
  mode: "dry-run" | "apply",
  workspaceId: string,
  applied: boolean,
  fileCounts: ProjectionReplayCounts,
  databaseCounts: ProjectionReplayCounts,
  operational: ProjectionReplayOperationalCounts,
  issues: ProjectionReplayIssue[],
  warnings: string[],
): ProjectionReplayReport {
  return {
    mode,
    workspaceId,
    valid: issues.length === 0,
    applied,
    fileCounts,
    databaseCounts,
    difference: difference(fileCounts, databaseCounts),
    operational,
    issues,
    warnings,
  };
}

function difference(
  files: ProjectionReplayCounts,
  database: ProjectionReplayCounts,
): ProjectionReplayDifference {
  const missingFromDatabase = emptyCounts();
  const databaseOnly = emptyCounts();
  for (const entity of REPLAY_ENTITY_NAMES) {
    missingFromDatabase[entity] = Math.max(0, files[entity] - database[entity]);
    databaseOnly[entity] = Math.max(0, database[entity] - files[entity]);
  }
  return { missingFromDatabase, databaseOnly };
}

function replayWarnings(
  database: ProjectionReplayCounts,
  files: ProjectionReplayCounts,
  operational: ProjectionReplayOperationalCounts,
): string[] {
  const warnings = [
    "Replay is additive: database-only rows are reported but not deleted.",
    "Auth records, repository-import queue rows and writer leases are operational and are never reconstructed from workspace files.",
    "Recovered running work is re-queued with no worker or lease because lease secrets are intentionally absent from files.",
  ];
  if (REPLAY_ENTITY_NAMES.some((entity) => database[entity] > files[entity])) {
    warnings.push("Some database tables contain more workspace rows than the file ledger; apply mode will preserve those extra rows.");
  }
  if (
    operational.activeRuns > 0 ||
    operational.activeAttempts > 0 ||
    operational.activeWriterLeases > 0 ||
    operational.pendingRepositoryImports > 0
  ) {
    warnings.push("The workspace is busy; apply mode will refuse until active runs, imports and writer leases are settled.");
  }
  return warnings;
}

function emptyCounts(): ProjectionReplayCounts {
  return Object.fromEntries(REPLAY_ENTITY_NAMES.map((entity) => [entity, 0])) as ProjectionReplayCounts;
}

function indexed<T extends { id: string }>(
  values: T[],
  path: string,
  issues: ProjectionReplayIssue[],
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.id)) issue(issues, "duplicate_id", `${path}/${value.id}`, value.id);
    else result.set(value.id, value);
  }
  return result;
}

function reference<T>(
  issues: ProjectionReplayIssue[],
  values: Map<string, T>,
  id: string,
  path: string,
): T | undefined {
  const value = values.get(id);
  if (!value) issue(issues, "missing_reference", path, id);
  return value;
}

function checkWorkspace(
  issues: ProjectionReplayIssue[],
  actual: string,
  expected: string,
  path: string,
): void {
  if (actual !== expected) issue(issues, "workspace_mismatch", `${path}.workspaceId`, actual);
}

function checkUuid(issues: ProjectionReplayIssue[], value: string, path: string): void {
  if (!UUID_PATTERN.test(value)) issue(issues, "invalid_uuid", path, value);
}

function issue(issues: ProjectionReplayIssue[], code: string, path: string, value: string): void {
  issues.push({ code, path, message: `${path} references invalid value '${value}'.` });
}

async function regularEntryIds(
  directory: string,
  suffix: string,
  expected: "file" | "directory",
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new ProjectionReplayError("symlink_rejected", `Replay refuses symbolic link ${join(directory, entry.name)}.`);
    }
    if (expected === "file" && entry.isFile() && entry.name.endsWith(suffix)) {
      ids.push(entry.name.slice(0, -suffix.length));
    }
    if (expected === "directory" && entry.isDirectory()) ids.push(entry.name);
  }
  return ids.sort();
}

async function readRequired<T>(
  ids: string[],
  read: (id: string) => Promise<T | null>,
  label: string,
): Promise<T[]> {
  const values: T[] = [];
  for (const id of ids) {
    const value = await read(id);
    if (!value) throw new ProjectionReplayError("entity_file_missing", `${label} ${id} could not be read.`);
    values.push(value);
  }
  return values;
}

function compareId(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}

function iso(value: Date): string {
  return value.toISOString();
}

function nullableIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function jsonParameter(value: Record<string, unknown>[]): postgres.JSONValue {
  // postgres.js must receive an array/object here. Passing a pre-stringified
  // value causes $1::jsonb to become a JSON string, which recordset rejects.
  return JSON.parse(JSON.stringify(value, (_key, current: unknown) =>
    typeof current === "bigint" ? current.toString() : current,
  )) as postgres.JSONValue;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
