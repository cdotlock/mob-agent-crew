import type {
  ActorKind,
  AgentProfile,
  AgentRun,
  AgentStatus,
  Artifact,
  ArtifactKind,
  BootstrapData,
  DelegationInput,
  ImportedContext,
  NewTaskInput,
  RunStatus,
  TaskDetail,
  TaskResolution,
  TaskStatus,
  TaskSummary,
  ThreadMessage,
} from "./model.js";

type JsonRecord = Record<string, unknown>;

const palette = ["#9d8cff", "#5bb8ff", "#45d8a4", "#ffaf5e", "#f47bb5"];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function unbox(value: unknown): JsonRecord {
  const root = object(value);
  return isRecord(root.data) ? root.data : root;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(source: JsonRecord, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback;
}

function number(source: JsonRecord, keys: string[], fallback = 0): number {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return fallback;
}

function stringArray(value: unknown): string[] {
  return array(value)
    .map((item) => {
      if (typeof item === "string") return item;
      const entry = object(item);
      return text(entry, ["id", "agentId", "agent_id", "artifactId", "artifact_id"]);
    })
    .filter(Boolean);
}

function initials(name: string): string {
  const value = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return value || "?";
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  if (typeof value !== "string") return fallback;
  const normalized = value.toLowerCase().replace(/[\s-]+/g, "_");
  return values.includes(normalized as T) ? (normalized as T) : fallback;
}

const taskStatuses = [
  "open",
  "queued",
  "running",
  "review_ready",
  "completed",
  "failed",
  "cancelled",
] as const;

const resolutions = ["unreviewed", "accepted", "rejected", "pr_created"] as const;
const agentStatuses = ["available", "working", "reviewing", "offline", "error"] as const;
const runStatuses = [
  "queued",
  "provisioning",
  "running",
  "publishing",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
] as const;
const actorKinds = ["human", "agent", "system"] as const;
const artifactKinds = ["patch", "diff", "report", "plan", "log", "file"] as const;

function normalizeTaskStatus(value: unknown): TaskStatus {
  const aliases: Record<string, TaskStatus> = {
    review: "review_ready",
    ready_for_review: "review_ready",
    done: "completed",
    success: "completed",
    succeeded: "completed",
    canceled: "cancelled",
  };
  if (typeof value === "string") {
    const normalized = value.toLowerCase().replace(/[\s-]+/g, "_");
    if (aliases[normalized]) return aliases[normalized];
  }
  return enumValue<TaskStatus>(value, taskStatuses, "open");
}

function normalizeTask(value: unknown, index = 0): TaskSummary {
  const item = object(value);
  const participants = item.participantIds ?? item.participant_ids ?? item.participants ?? [];
  return {
    id: text(item, ["id", "taskId", "task_id"], `task-${index + 1}`),
    title: text(item, ["title", "name", "subject"], "Untitled collaboration"),
    repository: text(item, ["repository", "repo", "repositoryName", "repository_name"], "No repository"),
    branch: text(item, ["branch", "baseRef", "base_ref"], "main"),
    status: normalizeTaskStatus(item.status),
    resolution: enumValue<TaskResolution>(item.resolution, resolutions, "unreviewed"),
    updatedAt: text(
      item,
      ["updatedAt", "updated_at", "lastActivityAt", "last_activity_at", "createdAt", "created_at"],
      new Date().toISOString(),
    ),
    unread: number(item, ["unread", "unreadCount", "unread_count"]),
    participantIds: stringArray(participants),
    summary: text(item, ["summary", "description", "latestMessage", "latest_message"]),
  };
}

function normalizeCapabilities(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  const values = object(value);
  return Object.entries(values)
    .filter(([, enabled]) => enabled === true)
    .map(([name]) => name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase());
}

function normalizeAgent(value: unknown, index = 0): AgentProfile {
  const item = object(value);
  const profile = object(item.profile);
  const source = { ...profile, ...item };
  const name = text(source, ["name", "displayName", "display_name"], `Agent ${index + 1}`);
  const driverValue = source.driver;
  const driver = isRecord(driverValue)
    ? text(driverValue, ["name", "id"], "Unknown driver")
    : text(source, ["driver", "driverId", "driver_id", "runtime"], "Unknown driver");
  return {
    id: text(source, ["id", "agentId", "agent_id"], `agent-${index + 1}`),
    name,
    initials: text(source, ["initials"], initials(name)),
    role: text(source, ["role", "description"], "Crew member"),
    owner: text(source, ["owner", "ownerName", "owner_name"], "Shared crew"),
    driver,
    status: enumValue<AgentStatus>(source.status, agentStatuses, "available"),
    capabilities: normalizeCapabilities(source.capabilities),
    currentTaskId: text(source, ["currentTaskId", "current_task_id"]) || null,
    color: text(source, ["color", "accent"], palette[index % palette.length] ?? "#9d8cff"),
  };
}

function normalizeMessage(value: unknown, index = 0): ThreadMessage {
  const item = object(value);
  const actor = object(item.actor);
  const actorName = text(actor, ["name", "displayName", "display_name"], text(item, ["actorName", "actor_name", "author"], "Unknown"));
  return {
    id: text(item, ["id", "messageId", "message_id"], `message-${index + 1}`),
    actorId: text(actor, ["id"], text(item, ["actorId", "actor_id", "authorId", "author_id"], "unknown")),
    actorName,
    actorKind: enumValue<ActorKind>(actor.kind ?? item.actorKind ?? item.actor_kind, actorKinds, "system"),
    actorInitials: text(actor, ["initials"], initials(actorName)),
    content: text(item, ["content", "text", "body", "message"]),
    createdAt: text(item, ["createdAt", "created_at", "timestamp"], new Date().toISOString()),
    runId: text(item, ["runId", "run_id"]) || null,
    artifactIds: stringArray(item.artifactIds ?? item.artifact_ids ?? item.artifacts),
    delivery: enumValue<"pending" | "sent" | "failed">(
      item.delivery,
      ["pending", "sent", "failed"],
      "sent",
    ),
  };
}

function normalizeRun(value: unknown, index = 0): AgentRun {
  const item = object(value);
  const statusAliases: Record<string, RunStatus> = { success: "succeeded", completed: "succeeded", canceled: "cancelled" };
  const rawStatus = text(item, ["status"]);
  const normalizedStatus = rawStatus.toLowerCase().replace(/[\s-]+/g, "_");
  return {
    id: text(item, ["id", "runId", "run_id"], `run-${index + 1}`),
    agentId: text(item, ["agentId", "agent_id", "actorId", "actor_id"], "unknown-agent"),
    role: text(item, ["role", "intent", "label"], "Agent run"),
    status: statusAliases[normalizedStatus] ?? enumValue<RunStatus>(item.status, runStatuses, "queued"),
    attempt: Math.max(1, number(item, ["attempt", "attemptNumber", "attempt_number"], 1)),
    startedAt: text(item, ["startedAt", "started_at"]) || null,
    finishedAt: text(item, ["finishedAt", "finished_at", "completedAt", "completed_at"]) || null,
    summary: text(item, ["summary", "result", "errorMessage", "error_message"]),
    parentRunId: text(item, ["parentRunId", "parent_run_id"]) || null,
  };
}

function normalizeArtifact(value: unknown, index = 0): Artifact {
  const item = object(value);
  const name = text(item, ["name", "filename", "title"], `artifact-${index + 1}`);
  let kind = enumValue<ArtifactKind>(item.kind ?? item.type, artifactKinds, "file");
  if (kind === "file" && /\.patch$|\.diff$/i.test(name)) kind = "patch";
  return {
    id: text(item, ["id", "artifactId", "artifact_id"], `artifact-${index + 1}`),
    name,
    kind,
    summary: text(item, ["summary", "description", "sizeLabel", "size_label"]),
    producerAgentId: text(item, ["producerAgentId", "producer_agent_id", "agentId", "agent_id"], "unknown-agent"),
    createdAt: text(item, ["createdAt", "created_at"], new Date().toISOString()),
    revision: text(item, ["revision", "baseRevision", "base_revision", "sha"], "unversioned"),
    content: text(item, ["content", "preview", "text"]),
    language: text(item, ["language", "format"], kind === "patch" || kind === "diff" ? "diff" : "text"),
  };
}

export function normalizeBootstrap(value: unknown): BootstrapData {
  const root = unbox(value);
  const workspace = object(root.workspace);
  const user = object(root.currentUser ?? root.current_user ?? root.user);
  const userName = text(user, ["name", "displayName", "display_name"], "You");
  return {
    workspace: {
      id: text(workspace, ["id"], "workspace"),
      name: text(workspace, ["name"], text(root, ["workspaceName", "workspace_name"], "Mob Agent Crew")),
      environment: text(workspace, ["environment"], text(root, ["environment"], "Connected")),
    },
    currentUser: {
      id: text(user, ["id"], "current-user"),
      name: userName,
      initials: text(user, ["initials"], initials(userName)),
    },
    tasks: array(root.tasks).map(normalizeTask),
    agents: array(root.agents).map(normalizeAgent),
  };
}

export function normalizeTaskDetail(value: unknown, fallback: TaskSummary): TaskDetail {
  const root = unbox(value);
  const taskRoot = isRecord(root.task) ? root.task : root;
  const summary = normalizeTask(taskRoot);
  const merged: TaskSummary = {
    ...fallback,
    ...summary,
    id: summary.id.startsWith("task-") && !text(taskRoot, ["id"]) ? fallback.id : summary.id,
    title: summary.title === "Untitled collaboration" ? fallback.title : summary.title,
    repository: summary.repository === "No repository" ? fallback.repository : summary.repository,
  };
  return {
    ...merged,
    description: text(taskRoot, ["description", "prompt", "initialMessage", "initial_message"], fallback.summary),
    baseRef: text(taskRoot, ["baseRef", "base_ref", "revision", "sha"], `${merged.branch}@HEAD`),
    messages: array(taskRoot.messages ?? root.messages).map(normalizeMessage),
    runs: array(taskRoot.runs ?? root.runs).map(normalizeRun),
    artifacts: array(taskRoot.artifacts ?? root.artifacts).map(normalizeArtifact),
    maxDelegationDepth: number(taskRoot, ["maxDelegationDepth", "max_delegation_depth"], 2),
    delegationDepth: number(taskRoot, ["delegationDepth", "delegation_depth"], 0),
    budgetUsed: number(taskRoot, ["budgetUsed", "budget_used", "cost"], 0),
    budgetLimit: number(taskRoot, ["budgetLimit", "budget_limit"], 5),
  };
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body && !isFormData ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = object(await response.json());
      detail = text(body, ["message", "error", "detail"], detail);
    } catch {
      // Keep the HTTP status text when the server does not return JSON.
    }
    throw new ApiError(detail || `Request failed with ${response.status}`, response.status);
  }
  if (response.status === 204) return {};
  return response.json();
}

export async function fetchBootstrap(): Promise<BootstrapData> {
  return normalizeBootstrap(await request("/api/bootstrap"));
}

export async function createSession(email: string, password: string): Promise<void> {
  await request("/api/session", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function fetchTask(task: TaskSummary): Promise<TaskDetail> {
  return normalizeTaskDetail(await request(`/api/tasks/${encodeURIComponent(task.id)}`), task);
}

export async function createTask(input: NewTaskInput): Promise<TaskDetail> {
  const fallback: TaskSummary = {
    id: `task-${crypto.randomUUID()}`,
    title: input.title,
    repository: input.repository,
    branch: input.baseRef || "main",
    status: "queued",
    resolution: "unreviewed",
    updatedAt: new Date().toISOString(),
    unread: 0,
    participantIds: input.agentId ? [input.agentId] : [],
    summary: input.initialMessage,
  };
  const value = await request("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: input.title,
      repository: input.repository,
      baseRef: input.baseRef,
      initialMessage: input.initialMessage,
      agentId: input.agentId,
    }),
  });
  return normalizeTaskDetail(value, fallback);
}

export async function postMessage(taskId: string, content: string): Promise<ThreadMessage> {
  const value = await request(`/api/tasks/${encodeURIComponent(taskId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
  const root = unbox(value);
  return normalizeMessage(root.message ?? root);
}

export async function postDelegation(taskId: string, input: DelegationInput): Promise<AgentRun | null> {
  const value = await request(`/api/tasks/${encodeURIComponent(taskId)}/delegations`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  const root = unbox(value);
  const run = root.run ?? root;
  return Object.keys(object(run)).length ? normalizeRun(run) : null;
}

export async function cancelRun(runId: string): Promise<void> {
  await request(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
}

export async function retryRun(runId: string): Promise<AgentRun | null> {
  const value = await request(`/api/runs/${encodeURIComponent(runId)}/retry`, { method: "POST" });
  const root = unbox(value);
  const run = root.run ?? root;
  return Object.keys(object(run)).length ? normalizeRun(run) : null;
}

export async function reviewTask(
  taskId: string,
  decision: "accept" | "reject" | "request_changes",
  note = "",
): Promise<void> {
  await request(`/api/tasks/${encodeURIComponent(taskId)}/reviews`, {
    method: "POST",
    body: JSON.stringify({ decision, note }),
  });
}

function normalizeImportedContext(value: unknown, fallback: Partial<ImportedContext>): ImportedContext {
  const root = unbox(value);
  const context = isRecord(root.context) ? root.context : root;
  return {
    id: text(context, ["id", "artifactId", "artifact_id"], fallback.id ?? `context-${crypto.randomUUID()}`),
    name: text(context, ["name", "title", "filename"], fallback.name ?? "Imported context"),
    kind: text(context, ["kind", "type"], fallback.kind ?? "markdown") === "github" ? "github" : "markdown",
    summary: text(context, ["summary", "description"], fallback.summary ?? "Added to the shared task context"),
    content: text(context, ["content", "text", "preview"], fallback.content ?? ""),
    sourceUrl: text(context, ["sourceUrl", "source_url", "url"], fallback.sourceUrl ?? "") || null,
    createdAt: text(context, ["createdAt", "created_at"], fallback.createdAt ?? new Date().toISOString()),
  };
}

export async function uploadMarkdown(taskId: string, file: File): Promise<ImportedContext> {
  const body = new FormData();
  body.append("file", file, file.name);
  body.append("kind", "context");
  const value = await request(`/api/tasks/${encodeURIComponent(taskId)}/artifacts`, {
    method: "POST",
    body,
  });
  return normalizeImportedContext(value, {
    name: file.name,
    kind: "markdown",
    summary: "Markdown context uploaded",
  });
}

export async function importGithubUrl(taskId: string, url: string): Promise<ImportedContext> {
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url)) {
    throw new Error("Use a GitHub repository root URL: https://github.com/owner/repo");
  }
  const value = await request(`/api/tasks/${encodeURIComponent(taskId)}/imports/github`, {
    method: "POST",
    body: JSON.stringify({ url }),
  });
  return normalizeImportedContext(value, {
    name: url.replace(/^https?:\/\/github\.com\//, ""),
    kind: "github",
    summary: "GitHub context imported",
    sourceUrl: url,
  });
}
