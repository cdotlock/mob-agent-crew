import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type {
  Actor,
  AgentProfile,
  Approval,
  Artifact,
  Conversation,
  ConversationMembership,
  ConversationThread,
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
import { normalizeAgentComposition } from "../domain/agent-composition.js";

const SCHEMA_VERSION = 1;
const MESSAGE_HEADER_PREFIX = "<!-- mob-message-meta ";
const MESSAGE_HEADER_SUFFIX = " -->";

type StoredEntity =
  | "workspace"
  | "actor"
  | "agent_profile"
  | "repository"
  | "task"
  | "conversation"
  | "conversation_membership"
  | "message"
  | "run"
  | "attempt"
  | "event"
  | "delegation"
  | "artifact"
  | "approval"
  | "document";

interface EntityEnvelope<T> {
  schemaVersion: typeof SCHEMA_VERSION;
  entity: StoredEntity;
  data: T;
}

export interface FileWorkspaceStoreOptions {
  dataDir: string;
}

export interface TaskThreadExportResult {
  root: string;
  written: number;
  paths: string[];
}

export interface TaskThreadRepairResult extends TaskThreadExportResult {
  removed: number;
}

export class FileWorkspaceStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FileWorkspaceStoreError";
  }
}

/**
 * A small, dependency-free durable file ledger for collaboration state.
 *
 * It deliberately persists only domain records. Agent runtimes, models, skills,
 * and memory remain opaque inputs owned by their respective tools.
 */
export class FileWorkspaceStore {
  readonly stateRoot: string;

  constructor(options: FileWorkspaceStoreOptions) {
    if (!options.dataDir.trim()) {
      throw new FileWorkspaceStoreError("dataDir must not be empty");
    }
    this.stateRoot = resolve(options.dataDir, "state", "workspaces");
  }

  workspaceRoot(workspaceId: string): string {
    return safeJoin(this.stateRoot, safeSegment(workspaceId, "workspaceId"));
  }

  taskRoot(workspaceId: string, taskId: string): string {
    return safeJoin(
      this.workspaceRoot(workspaceId),
      "tasks",
      safeSegment(taskId, "taskId"),
    );
  }

  conversationRoot(workspaceId: string, conversationId: string): string {
    return safeJoin(
      this.workspaceRoot(workspaceId),
      "conversations",
      safeSegment(conversationId, "conversationId"),
    );
  }

  async writeWorkspace(value: Workspace): Promise<string> {
    return this.#writeJson(
      "workspace",
      value,
      safeJoin(this.workspaceRoot(value.id), "workspace.json"),
    );
  }

  async writeActor(value: Actor): Promise<string> {
    return this.#writeJson(
      "actor",
      value,
      safeJoin(
        this.workspaceRoot(value.workspaceId),
        "actors",
        `${safeSegment(value.id, "actorId")}.json`,
      ),
    );
  }

  async writeAgentProfile(value: AgentProfile): Promise<string> {
    const safeValue = { ...value, ...normalizeAgentComposition(value) };
    return this.#writeJson(
      "agent_profile",
      safeValue,
      safeJoin(
        this.workspaceRoot(value.workspaceId),
        "agents",
        safeSegment(value.actorId, "actorId"),
        "profile.json",
      ),
    );
  }

  async writeRepository(value: Repository): Promise<string> {
    return this.#writeJson(
      "repository",
      value,
      safeJoin(
        this.workspaceRoot(value.workspaceId),
        "repositories",
        `${safeSegment(value.id, "repositoryId")}.json`,
      ),
    );
  }

  async writeDocument(value: WorkspaceDocument): Promise<string> {
    return this.#writeJson(
      "document",
      value,
      safeJoin(
        this.workspaceRoot(value.workspaceId),
        "documents",
        `${safeSegment(value.id, "documentId")}.json`,
      ),
    );
  }

  async writeTask(value: Task): Promise<string> {
    return this.#writeJson(
      "task",
      value,
      safeJoin(this.taskRoot(value.workspaceId, value.id), "task.json"),
    );
  }

  async writeConversation(value: Conversation): Promise<string> {
    const canonical = await this.#writeJson(
      "conversation",
      value,
      safeJoin(
        this.conversationRoot(value.workspaceId, value.id),
        "conversation.json",
      ),
    );
    if (!value.taskId) return canonical;
    return this.#writeJson(
      "conversation",
      value,
      safeJoin(
        this.taskRoot(value.workspaceId, value.taskId),
        "conversations",
        safeSegment(value.id, "conversationId"),
        "conversation.json",
      ),
    );
  }

  async writeConversationMembership(
    workspaceId: string,
    taskId: string | null,
    value: ConversationMembership,
  ): Promise<string> {
    if (value.workspaceId !== workspaceId) {
      throw new FileWorkspaceStoreError("Conversation membership belongs to another workspace");
    }
    const canonical = await this.#writeJson(
      "conversation_membership",
      value,
      safeJoin(
        this.conversationRoot(workspaceId, value.conversationId),
        "members",
        `${safeSegment(value.actorId, "actorId")}.json`,
      ),
    );
    if (!taskId) return canonical;
    return this.#writeJson(
      "conversation_membership",
      value,
      safeJoin(
        this.taskRoot(workspaceId, taskId),
        "conversations",
        safeSegment(value.conversationId, "conversationId"),
        "members",
        `${safeSegment(value.actorId, "actorId")}.json`,
      ),
    );
  }

  async writeMessage(value: Message): Promise<string> {
    const canonicalPath = safeJoin(
      this.conversationRoot(value.workspaceId, value.conversationId),
      "messages",
      messageFilename(value),
    );
    const { body, ...metadata } = value;
    const envelope: EntityEnvelope<typeof metadata> = {
      schemaVersion: SCHEMA_VERSION,
      entity: "message",
      data: metadata,
    };
    const header = `${MESSAGE_HEADER_PREFIX}${stableJson(envelope)}${MESSAGE_HEADER_SUFFIX}`;
    const content = `${header}\n\n${body}`;
    await atomicWrite(canonicalPath, content);
    if (!value.taskId) return canonicalPath;
    const legacyPath = safeJoin(
      this.taskRoot(value.workspaceId, value.taskId),
      "messages",
      messageFilename(value),
    );
    await atomicWrite(legacyPath, content);
    return legacyPath;
  }

  async writeRun(value: Run): Promise<string> {
    return this.#writeJson(
      "run",
      value,
      safeJoin(
        this.#runRoot(value.workspaceId, value.taskId, value.id),
        "run.json",
      ),
    );
  }

  async writeAttempt(value: RunAttempt): Promise<string> {
    // Lease tokens are operational secrets, not user-owned workspace state.
    const safeValue = { ...value, leaseToken: null };
    return this.#writeJson(
      "attempt",
      safeValue,
      safeJoin(
        this.#runRoot(value.workspaceId, value.taskId, value.runId),
        "attempts",
        attemptFilename(value),
      ),
    );
  }

  async writeEvent(value: RunEvent): Promise<string> {
    return this.#writeJson(
      "event",
      value,
      safeJoin(
        this.#runRoot(value.workspaceId, value.taskId, value.runId),
        "events",
        eventFilename(value),
      ),
    );
  }

  async writeDelegation(value: Delegation): Promise<string> {
    return this.#writeJson(
      "delegation",
      value,
      safeJoin(
        this.taskRoot(value.workspaceId, value.taskId),
        "delegations",
        `${safeSegment(value.id, "delegationId")}.json`,
      ),
    );
  }

  async writeArtifact(value: Artifact): Promise<string> {
    return this.#writeJson(
      "artifact",
      value,
      safeJoin(
        this.taskRoot(value.workspaceId, value.taskId),
        "artifacts",
        `${safeSegment(value.id, "artifactId")}.json`,
      ),
    );
  }

  async writeApproval(value: Approval): Promise<string> {
    return this.#writeJson(
      "approval",
      value,
      safeJoin(
        this.taskRoot(value.workspaceId, value.taskId),
        "approvals",
        `${safeSegment(value.id, "approvalId")}.json`,
      ),
    );
  }

  async readWorkspace(workspaceId: string): Promise<Workspace | null> {
    return this.#readJson(
      "workspace",
      safeJoin(this.workspaceRoot(workspaceId), "workspace.json"),
    );
  }

  async readActor(workspaceId: string, actorId: string): Promise<Actor | null> {
    return this.#readJson(
      "actor",
      safeJoin(
        this.workspaceRoot(workspaceId),
        "actors",
        `${safeSegment(actorId, "actorId")}.json`,
      ),
    );
  }

  async readRepository(workspaceId: string, repositoryId: string): Promise<Repository | null> {
    return this.#readJson(
      "repository",
      safeJoin(
        this.workspaceRoot(workspaceId),
        "repositories",
        `${safeSegment(repositoryId, "repositoryId")}.json`,
      ),
    );
  }

  async readDocument(workspaceId: string, documentId: string): Promise<WorkspaceDocument | null> {
    return this.#readJson(
      "document",
      safeJoin(
        this.workspaceRoot(workspaceId),
        "documents",
        `${safeSegment(documentId, "documentId")}.json`,
      ),
    );
  }

  async readAgentProfile(workspaceId: string, actorId: string): Promise<AgentProfile | null> {
    const profile = await this.#readJson<AgentProfile>(
      "agent_profile",
      safeJoin(
        this.workspaceRoot(workspaceId),
        "agents",
        safeSegment(actorId, "actorId"),
        "profile.json",
      ),
    );
    return profile ? { ...profile, ...normalizeAgentComposition(profile) } : null;
  }

  async readTask(workspaceId: string, taskId: string): Promise<Task | null> {
    return this.#readJson(
      "task",
      safeJoin(this.taskRoot(workspaceId, taskId), "task.json"),
    );
  }

  async readConversation(
    workspaceId: string,
    taskId: string,
    conversationId: string,
  ): Promise<Conversation | null> {
    const legacy = await this.#readJson<Conversation>(
      "conversation",
      safeJoin(
        this.taskRoot(workspaceId, taskId),
        "conversations",
        safeSegment(conversationId, "conversationId"),
        "conversation.json",
      ),
    );
    return legacy ?? this.readWorkspaceConversation(workspaceId, conversationId);
  }

  async readWorkspaceConversation(
    workspaceId: string,
    conversationId: string,
  ): Promise<Conversation | null> {
    return this.#readJson(
      "conversation",
      safeJoin(
        this.conversationRoot(workspaceId, conversationId),
        "conversation.json",
      ),
    );
  }

  async readWorkspaceConversationMemberships(
    workspaceId: string,
    conversationId: string,
  ): Promise<ConversationMembership[]> {
    return this.#readJsonDirectory<ConversationMembership>(
      "conversation_membership",
      safeJoin(this.conversationRoot(workspaceId, conversationId), "members"),
    );
  }

  async readWorkspaceConversationMessages(
    workspaceId: string,
    conversationId: string,
  ): Promise<Message[]> {
    return this.#readMessages(
      safeJoin(this.conversationRoot(workspaceId, conversationId), "messages"),
    );
  }

  async readConversationMemberships(
    workspaceId: string,
    taskId: string,
    conversationId: string,
  ): Promise<ConversationMembership[]> {
    return this.#readJsonDirectory<ConversationMembership>(
      "conversation_membership",
      safeJoin(
        this.taskRoot(workspaceId, taskId),
        "conversations",
        safeSegment(conversationId, "conversationId"),
        "members",
      ),
    );
  }

  async readMessage(workspaceId: string, taskId: string, messageId: string): Promise<Message | null> {
    safeSegment(messageId, "messageId");
    return findUniqueEntity(
      await this.#readMessages(safeJoin(this.taskRoot(workspaceId, taskId), "messages")),
      messageId,
      "message",
    );
  }

  async readRun(workspaceId: string, taskId: string, runId: string): Promise<Run | null> {
    return this.#readJson(
      "run",
      safeJoin(this.#runRoot(workspaceId, taskId, runId), "run.json"),
    );
  }

  async readAttempt(
    workspaceId: string,
    taskId: string,
    runId: string,
    attemptId: string,
  ): Promise<RunAttempt | null> {
    safeSegment(attemptId, "attemptId");
    return findUniqueEntity(
      await this.#readJsonDirectory<RunAttempt>(
        "attempt",
        safeJoin(this.#runRoot(workspaceId, taskId, runId), "attempts"),
      ),
      attemptId,
      "attempt",
    );
  }

  async readEvent(
    workspaceId: string,
    taskId: string,
    runId: string,
    eventId: string,
  ): Promise<RunEvent | null> {
    safeSegment(eventId, "eventId");
    return findUniqueEntity(
      await this.#readJsonDirectory<RunEvent>(
        "event",
        safeJoin(this.#runRoot(workspaceId, taskId, runId), "events"),
      ),
      eventId,
      "event",
    );
  }

  async readDelegation(
    workspaceId: string,
    taskId: string,
    delegationId: string,
  ): Promise<Delegation | null> {
    return this.#readJson(
      "delegation",
      safeJoin(
        this.taskRoot(workspaceId, taskId),
        "delegations",
        `${safeSegment(delegationId, "delegationId")}.json`,
      ),
    );
  }

  async readArtifact(
    workspaceId: string,
    taskId: string,
    artifactId: string,
  ): Promise<Artifact | null> {
    return this.#readJson(
      "artifact",
      safeJoin(
        this.taskRoot(workspaceId, taskId),
        "artifacts",
        `${safeSegment(artifactId, "artifactId")}.json`,
      ),
    );
  }

  async readApproval(
    workspaceId: string,
    taskId: string,
    approvalId: string,
  ): Promise<Approval | null> {
    return this.#readJson(
      "approval",
      safeJoin(
        this.taskRoot(workspaceId, taskId),
        "approvals",
        `${safeSegment(approvalId, "approvalId")}.json`,
      ),
    );
  }

  async readMessageFile(path: string): Promise<Message> {
    const resolvedPath = resolve(path);
    assertWithin(this.stateRoot, resolvedPath);
    let source: string;
    try {
      source = await readFile(resolvedPath, "utf8");
    } catch (error) {
      throw fileError(`Cannot read message file ${resolvedPath}`, error);
    }
    const firstLineEnd = source.indexOf("\n");
    if (firstLineEnd < 0 || source.slice(firstLineEnd, firstLineEnd + 2) !== "\n\n") {
      throw new FileWorkspaceStoreError(`Invalid message header in ${resolvedPath}`);
    }
    const header = source.slice(0, firstLineEnd);
    if (!header.startsWith(MESSAGE_HEADER_PREFIX) || !header.endsWith(MESSAGE_HEADER_SUFFIX)) {
      throw new FileWorkspaceStoreError(`Invalid message header in ${resolvedPath}`);
    }
    const json = header.slice(MESSAGE_HEADER_PREFIX.length, -MESSAGE_HEADER_SUFFIX.length);
    const envelope = parseEnvelope<Omit<Message, "body">>(json, "message", resolvedPath);
    return reviveEntity("message", { ...envelope.data, body: source.slice(firstLineEnd + 2) });
  }

  async exportTaskThread(thread: TaskThread): Promise<TaskThreadExportResult> {
    validateThread(thread);
    const writers: Array<() => Promise<string>> = [
      () => this.writeTask(thread.task),
      ...thread.conversations.map((value) => () => this.writeConversation(value)),
      ...thread.conversationMemberships.map((value) => () =>
        this.writeConversationMembership(thread.task.workspaceId, thread.task.id, value)),
      ...thread.messages.map((value) => () => this.writeMessage(value)),
      ...thread.delegations.map((value) => () => this.writeDelegation(value)),
      ...thread.runs.map((value) => () => this.writeRun(value)),
      ...thread.attempts.map((value) => () => this.writeAttempt(value)),
      ...thread.events.map((value) => () => this.writeEvent(value)),
      ...thread.artifacts.map((value) => () => this.writeArtifact(value)),
      ...thread.approvals.map((value) => () => this.writeApproval(value)),
    ];
    const paths: string[] = [];
    for (let offset = 0; offset < writers.length; offset += 24) {
      const batch = writers.slice(offset, offset + 24);
      paths.push(...await Promise.all(batch.map((write) => write())));
    }
    return {
      root: this.taskRoot(thread.task.workspaceId, thread.task.id),
      written: paths.length,
      paths: paths.sort(),
    };
  }

  async exportConversationThread(thread: ConversationThread): Promise<TaskThreadExportResult> {
    const conversation = thread.conversation;
    if (
      thread.members.some((member) =>
        member.workspaceId !== conversation.workspaceId ||
        member.conversationId !== conversation.id) ||
      thread.messages.some((message) =>
        message.workspaceId !== conversation.workspaceId ||
        message.conversationId !== conversation.id)
    ) {
      throw new FileWorkspaceStoreError("ConversationThread contains a record from another conversation");
    }
    const writers: Array<() => Promise<string>> = [
      () => this.writeConversation(conversation),
      ...thread.members.map((value) => () =>
        this.writeConversationMembership(conversation.workspaceId, conversation.taskId, value)),
      ...thread.messages.map((value) => () => this.writeMessage(value)),
    ];
    const paths: string[] = [];
    for (let offset = 0; offset < writers.length; offset += 24) {
      paths.push(...await Promise.all(writers.slice(offset, offset + 24).map((write) => write())));
    }
    return {
      root: this.conversationRoot(conversation.workspaceId, conversation.id),
      written: paths.length,
      paths: paths.sort(),
    };
  }

  async repairConversationThread(thread: ConversationThread): Promise<TaskThreadRepairResult> {
    const exported = await this.exportConversationThread(thread);
    const canonicalPaths = [
      safeJoin(exported.root, "conversation.json"),
      ...thread.members.map((member) => safeJoin(
        exported.root,
        "members",
        `${safeSegment(member.actorId, "actorId")}.json`,
      )),
      ...thread.messages.map((message) => safeJoin(exported.root, "messages", messageFilename(message))),
    ];
    const expected = new Set(canonicalPaths.map((path) => resolve(path)));
    const managedRoots = [safeJoin(exported.root, "members"), safeJoin(exported.root, "messages")];
    let removed = 0;
    for (const directory of managedRoots) {
      removed += await pruneUnexpectedFiles(directory, expected, managedRoots);
    }
    return { ...exported, removed };
  }

  async readConversationThread(
    workspaceId: string,
    conversationId: string,
  ): Promise<ConversationThread | null> {
    const conversation = await this.readWorkspaceConversation(workspaceId, conversationId);
    if (!conversation) return null;
    const [members, messages] = await Promise.all([
      this.readWorkspaceConversationMemberships(workspaceId, conversationId),
      this.readWorkspaceConversationMessages(workspaceId, conversationId),
    ]);
    members.sort((left, right) => left.actorId.localeCompare(right.actorId));
    messages.sort(compareCreated);
    return { conversation, members, messages, runs: [] };
  }

  /** Repairs the canonical file projection and prunes stale files in store-owned directories. */
  async repairTaskThread(thread: TaskThread): Promise<TaskThreadRepairResult> {
    const exported = await this.exportTaskThread(thread);
    const expected = new Set(exported.paths.map((path) => resolve(path)));
    const managedRoots = [
      safeJoin(exported.root, "messages"),
      safeJoin(exported.root, "conversations"),
      safeJoin(exported.root, "delegations"),
      safeJoin(exported.root, "runs"),
      safeJoin(exported.root, "artifacts"),
      safeJoin(exported.root, "approvals"),
    ];
    let removed = 0;
    for (const directory of managedRoots) {
      removed += await pruneUnexpectedFiles(directory, expected, managedRoots);
    }
    return { ...exported, removed };
  }

  async readTaskThread(workspaceId: string, taskId: string): Promise<TaskThread | null> {
    const task = await this.readTask(workspaceId, taskId);
    if (!task) return null;
    const root = this.taskRoot(workspaceId, taskId);
    const conversations: Conversation[] = [];
    const conversationMemberships: ConversationMembership[] = [];
    for (const conversationId of await directoryNames(safeJoin(root, "conversations"))) {
      safeSegment(conversationId, "conversationId");
      const conversation = await this.readConversation(workspaceId, taskId, conversationId);
      if (!conversation) continue;
      conversations.push(conversation);
      conversationMemberships.push(
        ...(await this.readConversationMemberships(workspaceId, taskId, conversationId)),
      );
    }
    const messages = await this.#readMessages(safeJoin(root, "messages"));
    const delegations = await this.#readJsonDirectory<Delegation>(
      "delegation",
      safeJoin(root, "delegations"),
    );
    const artifacts = await this.#readJsonDirectory<Artifact>(
      "artifact",
      safeJoin(root, "artifacts"),
    );
    const approvals = await this.#readJsonDirectory<Approval>(
      "approval",
      safeJoin(root, "approvals"),
    );

    const runs: Run[] = [];
    const attempts: RunAttempt[] = [];
    const events: RunEvent[] = [];
    for (const runDirectory of await directoryNames(safeJoin(root, "runs"))) {
      safeSegment(runDirectory, "runId");
      const runRoot = safeJoin(root, "runs", runDirectory);
      const run = await this.#readJson<Run>("run", safeJoin(runRoot, "run.json"));
      if (!run) continue;
      runs.push(run);
      attempts.push(
        ...(await this.#readJsonDirectory<RunAttempt>(
          "attempt",
          safeJoin(runRoot, "attempts"),
        )),
      );
      events.push(
        ...(await this.#readJsonDirectory<RunEvent>("event", safeJoin(runRoot, "events"))),
      );
    }

    messages.sort(compareCreated);
    conversations.sort(compareCreated);
    conversationMemberships.sort((left, right) =>
      left.conversationId === right.conversationId
        ? left.actorId.localeCompare(right.actorId)
        : left.conversationId.localeCompare(right.conversationId),
    );
    delegations.sort(compareCreated);
    runs.sort(compareCreated);
    attempts.sort((left, right) =>
      left.runId === right.runId
        ? left.attemptNumber - right.attemptNumber
        : left.runId.localeCompare(right.runId),
    );
    events.sort((left, right) =>
      left.runId === right.runId
        ? left.sequence - right.sequence
        : left.runId.localeCompare(right.runId),
    );
    artifacts.sort(compareCreated);
    approvals.sort(compareCreated);

    return {
      task,
      conversations,
      conversationMemberships,
      messages,
      delegations,
      runs,
      attempts,
      events,
      artifacts,
      approvals,
    };
  }

  #runRoot(workspaceId: string, taskId: string, runId: string): string {
    return safeJoin(
      this.taskRoot(workspaceId, taskId),
      "runs",
      safeSegment(runId, "runId"),
    );
  }

  async #writeJson<T>(entity: StoredEntity, value: T, path: string): Promise<string> {
    const envelope: EntityEnvelope<T> = { schemaVersion: SCHEMA_VERSION, entity, data: value };
    await atomicWrite(path, `${stableJson(envelope, 2)}\n`);
    return path;
  }

  async #readJson<T>(entity: StoredEntity, path: string): Promise<T | null> {
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw fileError(`Cannot read ${entity} file ${path}`, error);
    }
    const envelope = parseEnvelope<T>(source, entity, path);
    return reviveEntity(entity, envelope.data);
  }

  async #readJsonDirectory<T>(entity: StoredEntity, directory: string): Promise<T[]> {
    const values: T[] = [];
    for (const filename of await fileNames(directory, ".json")) {
      const value = await this.#readJson<T>(entity, safeJoin(directory, filename));
      if (value) values.push(value);
    }
    return values;
  }

  async #readMessages(directory: string): Promise<Message[]> {
    const messages: Message[] = [];
    for (const filename of await fileNames(directory, ".md")) {
      messages.push(await this.readMessageFile(safeJoin(directory, filename)));
    }
    return messages;
  }
}

function messageFilename(value: Message): string {
  const time = checkedDate(value.createdAt, "message.createdAt").getTime().toString().padStart(13, "0");
  return `${time}-${safeSegment(value.id, "messageId")}.md`;
}

function attemptFilename(value: RunAttempt): string {
  return `${sequencePart(value.attemptNumber, 6, "attemptNumber")}-${safeSegment(value.id, "attemptId")}.json`;
}

function eventFilename(value: RunEvent): string {
  return `${sequencePart(value.sequence, 12, "eventSequence")}-${safeSegment(value.id, "eventId")}.json`;
}

function sequencePart(value: number, width: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new FileWorkspaceStoreError(`${label} must be a non-negative safe integer`);
  }
  return value.toString().padStart(width, "0");
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === "." || value === "..") {
    throw new FileWorkspaceStoreError(`${label} must be a safe path segment`);
  }
  return value;
}

function safeJoin(root: string, ...segments: string[]): string {
  const path = resolve(root, ...segments);
  assertWithin(root, path);
  return path;
}

function assertWithin(root: string, path: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new FileWorkspaceStoreError(`Path escapes state root: ${path}`);
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    if (await readFile(path, "utf8") === content) return;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw fileError(`Cannot compare existing file ${path}`, error);
    }
  }
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw fileError(`Cannot atomically write ${path}`, error);
  }
}

function stableJson(value: unknown, indentation?: number): string {
  return JSON.stringify(canonicalValue(value, new Set()), null, indentation);
}

function canonicalValue(value: unknown, ancestors: Set<object>): unknown {
  if (value instanceof Date) return checkedDate(value, "date").toISOString();
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) throw new FileWorkspaceStoreError("Cannot store a circular value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) =>
        typeof entry === "undefined" || typeof entry === "function" || typeof entry === "symbol"
          ? null
          : canonicalValue(entry, ancestors),
      );
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (typeof entry === "undefined" || typeof entry === "function" || typeof entry === "symbol") {
        continue;
      }
      result[key] = canonicalValue(entry, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function parseEnvelope<T>(source: string, entity: StoredEntity, path: string): EntityEnvelope<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw fileError(`Invalid JSON in ${path}`, error);
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== SCHEMA_VERSION || parsed.entity !== entity || !("data" in parsed)) {
    throw new FileWorkspaceStoreError(`Invalid ${entity} envelope in ${path}`);
  }
  return parsed as unknown as EntityEnvelope<T>;
}

const DATE_FIELDS: Record<StoredEntity, readonly string[]> = {
  workspace: ["createdAt", "updatedAt"],
  actor: ["createdAt", "updatedAt"],
  agent_profile: ["createdAt", "updatedAt"],
  repository: ["createdAt", "updatedAt"],
  task: ["createdAt", "updatedAt"],
  conversation: ["createdAt", "updatedAt"],
  conversation_membership: ["joinedAt"],
  message: ["createdAt"],
  run: ["createdAt", "updatedAt", "completedAt"],
  attempt: ["leaseExpiresAt", "startedAt", "completedAt", "createdAt", "updatedAt"],
  event: ["createdAt"],
  delegation: ["createdAt", "updatedAt", "completedAt"],
  artifact: ["createdAt"],
  approval: ["createdAt", "decidedAt"],
  document: ["createdAt", "updatedAt"],
};

const BIGINT_FIELDS: Partial<Record<StoredEntity, readonly string[]>> = {
  task: ["writerFence"],
  attempt: ["fence", "writerFence"],
  artifact: ["byteSize"],
};

function reviveEntity<T>(entity: StoredEntity, input: T): T {
  if (!isRecord(input)) {
    throw new FileWorkspaceStoreError(`Stored ${entity} data must be an object`);
  }
  const value = { ...input } as Record<string, unknown>;
  if (entity === "task") {
    value.executionConversationId ??= null;
    value.isExecution ??= false;
  } else if (entity === "conversation") {
    value.activeRepositoryId ??= null;
  } else if (entity === "run") {
    value.waitForRunId ??= null;
  }
  for (const field of DATE_FIELDS[entity]) {
    const stored = value[field];
    if (stored === null || typeof stored === "undefined") continue;
    if (typeof stored !== "string") {
      throw new FileWorkspaceStoreError(`${entity}.${field} must be an ISO date string`);
    }
    value[field] = checkedDate(new Date(stored), `${entity}.${field}`);
  }
  for (const field of BIGINT_FIELDS[entity] ?? []) {
    const stored = value[field];
    if (stored === null || typeof stored === "undefined") continue;
    if (typeof stored !== "string" || !/^-?\d+$/.test(stored)) {
      throw new FileWorkspaceStoreError(`${entity}.${field} must be an integer string`);
    }
    value[field] = BigInt(stored);
  }
  return value as T;
}

function checkedDate(value: Date, label: string): Date {
  if (Number.isNaN(value.getTime())) {
    throw new FileWorkspaceStoreError(`${label} must be a valid date`);
  }
  return value;
}

function validateThread(thread: TaskThread): void {
  const { workspaceId, id: taskId } = thread.task;
  const records: Array<{ workspaceId: string; taskId?: string | null }> = [
    ...thread.conversations,
    ...thread.messages,
    ...thread.delegations,
    ...thread.runs,
    ...thread.attempts,
    ...thread.events,
    ...thread.artifacts,
    ...thread.approvals,
  ];
  if (records.some((record) => record.workspaceId !== workspaceId || record.taskId !== taskId)) {
    throw new FileWorkspaceStoreError("TaskThread contains a record from another workspace or task");
  }
  const conversationIds = new Set(thread.conversations.map((conversation) => conversation.id));
  if (thread.conversationMemberships.some((membership) =>
    membership.workspaceId !== workspaceId || !conversationIds.has(membership.conversationId))) {
    throw new FileWorkspaceStoreError("TaskThread contains a membership from another conversation");
  }
}

async function fileNames(directory: string, suffix: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw fileError(`Cannot list ${directory}`, error);
  }
}

async function directoryNames(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw fileError(`Cannot list ${directory}`, error);
  }
}

async function pruneUnexpectedFiles(
  directory: string,
  expected: ReadonlySet<string>,
  managedRoots: readonly string[],
): Promise<number> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return 0;
    throw fileError(`Cannot inspect ${directory}`, error);
  }
  let removed = 0;
  for (const entry of entries) {
    const path = safeJoin(directory, entry.name);
    if (entry.isDirectory()) {
      const expectedBelow = [...expected].some((expectedPath) => expectedPath.startsWith(`${path}${sep}`));
      if (
        managedRoots.includes(resolve(directory)) ||
        managedRoots.includes(resolve(path)) ||
        expectedBelow
      ) {
        removed += await pruneUnexpectedFiles(path, expected, managedRoots);
      }
      continue;
    }
    const information = await lstat(path);
    if ((information.isFile() || information.isSymbolicLink()) && !expected.has(resolve(path))) {
      await unlink(path);
      removed += 1;
    }
  }
  return removed;
}

function compareCreated(left: { id: string; createdAt: Date }, right: { id: string; createdAt: Date }): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id);
}

function findUniqueEntity<T extends { id: string }>(
  values: readonly T[],
  id: string,
  entity: StoredEntity,
): T | null {
  const matches = values.filter((value) => value.id === id);
  if (matches.length > 1) {
    throw new FileWorkspaceStoreError(`Multiple ${entity} files contain id ${id}`);
  }
  return matches[0] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function fileError(message: string, cause: unknown): FileWorkspaceStoreError {
  return new FileWorkspaceStoreError(message, { cause });
}
