export type TaskStatus =
  | "open"
  | "queued"
  | "running"
  | "review_ready"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskResolution = "unreviewed" | "accepted" | "rejected" | "pr_created";

export type AgentStatus = "available" | "working" | "reviewing" | "offline" | "error";

export type RunStatus =
  | "queued"
  | "provisioning"
  | "running"
  | "publishing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

export type ActorKind = "human" | "agent" | "system";

export type ArtifactKind = "patch" | "diff" | "report" | "plan" | "log" | "file";

export interface CurrentUser {
  id: string;
  name: string;
  initials: string;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  environment: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  initials: string;
  role: string;
  owner: string;
  driver: string;
  status: AgentStatus;
  capabilities: string[];
  currentTaskId: string | null;
  color: string;
}

export interface TaskSummary {
  id: string;
  title: string;
  repository: string;
  branch: string;
  status: TaskStatus;
  resolution: TaskResolution;
  updatedAt: string;
  unread: number;
  participantIds: string[];
  summary: string;
}

export interface ThreadMessage {
  id: string;
  actorId: string;
  actorName: string;
  actorKind: ActorKind;
  actorInitials: string;
  content: string;
  createdAt: string;
  runId: string | null;
  artifactIds: string[];
  delivery: "pending" | "sent" | "failed";
}

export interface AgentRun {
  id: string;
  agentId: string;
  role: string;
  status: RunStatus;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  summary: string;
  parentRunId: string | null;
}

export interface Artifact {
  id: string;
  name: string;
  kind: ArtifactKind;
  summary: string;
  producerAgentId: string;
  createdAt: string;
  revision: string;
  content: string;
  language: string;
}

export interface TaskDetail extends TaskSummary {
  description: string;
  baseRef: string;
  messages: ThreadMessage[];
  runs: AgentRun[];
  artifacts: Artifact[];
  maxDelegationDepth: number;
  delegationDepth: number;
  budgetUsed: number;
  budgetLimit: number;
}

export interface BootstrapData {
  workspace: WorkspaceInfo;
  currentUser: CurrentUser;
  tasks: TaskSummary[];
  agents: AgentProfile[];
}

export interface NewTaskInput {
  title: string;
  repository: string;
  baseRef: string;
  initialMessage: string;
  agentId: string;
}

export interface DelegationInput {
  agentId: string;
  deliverable: string;
}

export interface ImportedContext {
  id: string;
  name: string;
  kind: "markdown" | "github";
  summary: string;
  content: string;
  sourceUrl: string | null;
  createdAt: string;
}
