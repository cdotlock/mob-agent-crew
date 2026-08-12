export type WorkspaceId = string;
export type ActorId = string;
export type UserAuthRecordId = string;
export type RepositoryId = string;
export type TaskId = string;
export type MessageId = string;
export type DelegationId = string;
export type RunId = string;
export type RunAttemptId = string;
export type RunEventId = string;
export type ArtifactId = string;
export type ApprovalId = string;
export type WorkspaceDocumentId = string;
export type RepositoryImportId = string;

export type ActorKind = "human" | "agent";
export type ActorStatus = "active" | "disabled";
export type RepositoryKind = "git" | "local";
export type TaskStatus =
  | "open"
  | "active"
  | "review_ready"
  | "completed"
  | "cancelled";
export type MessageKind = "comment" | "progress" | "result" | "system";
export type DelegationStatus =
  | "queued"
  | "accepted"
  | "completed"
  | "rejected"
  | "cancelled";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type AttemptStatus = "queued" | "claimed" | "running" | "succeeded" | "failed" | "cancelled";
export type ArtifactKind = "file" | "patch" | "commit" | "test_report" | "log" | "summary";
export type ApprovalKind = "publish_branch" | "create_change_request" | "merge_change_request";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";
export type RepositoryImportStatus = "pending" | "imported" | "rejected" | "failed";

export interface Workspace {
  id: WorkspaceId;
  slug: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceDocument {
  id: WorkspaceDocumentId;
  workspaceId: WorkspaceId;
  name: string;
  content: string | null;
  localPath: string | null;
  source: string;
  uploadedByActorId: ActorId;
  createdAt: Date;
  updatedAt: Date;
}

export interface Actor {
  id: ActorId;
  workspaceId: WorkspaceId;
  kind: ActorKind;
  handle: string;
  displayName: string;
  status: ActorStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserAuthRecord {
  id: UserAuthRecordId;
  workspaceId: WorkspaceId;
  actorId: ActorId;
  provider: string;
  subject: string;
  email: string | null;
  passwordHash: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DriverCapabilities {
  streaming: boolean;
  steer: boolean;
  followUp: boolean;
  resume: boolean;
  nativeCancel: boolean;
}

export interface AgentProfile {
  actorId: ActorId;
  workspaceId: WorkspaceId;
  ownerActorId: ActorId;
  driver: string;
  home: string;
  role: string;
  capabilities: DriverCapabilities;
  maxConcurrentRuns: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Repository {
  id: RepositoryId;
  workspaceId: WorkspaceId;
  name: string;
  kind: RepositoryKind;
  remoteUrl: string | null;
  localPath: string | null;
  defaultBranch: string;
  allowlisted: boolean;
  enabled: boolean;
  createdByActorId: ActorId;
  createdAt: Date;
  updatedAt: Date;
}

export interface RepositoryImport {
  id: RepositoryImportId;
  workspaceId: WorkspaceId;
  sourceUrl: string;
  requestedByActorId: ActorId;
  repositoryId: RepositoryId | null;
  status: RepositoryImportStatus;
  failureMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface Task {
  id: TaskId;
  workspaceId: WorkspaceId;
  repositoryId: RepositoryId;
  createdByActorId: ActorId;
  assignedActorId: ActorId | null;
  title: string;
  description: string;
  baseRevision: string;
  branchName: string | null;
  status: TaskStatus;
  maxDelegationDepth: number;
  runBudget: number;
  writerFence: bigint;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: MessageId;
  workspaceId: WorkspaceId;
  taskId: TaskId;
  actorId: ActorId;
  sourceRunId: RunId | null;
  kind: MessageKind;
  body: string;
  mentions: ActorId[];
  createdAt: Date;
}

export interface Delegation {
  id: DelegationId;
  workspaceId: WorkspaceId;
  taskId: TaskId;
  fromActorId: ActorId;
  toAgentActorId: ActorId;
  sourceRunId: RunId | null;
  parentDelegationId: DelegationId | null;
  intent: string;
  deliverable: string;
  depth: number;
  status: DelegationStatus;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface Run {
  id: RunId;
  workspaceId: WorkspaceId;
  taskId: TaskId;
  agentActorId: ActorId;
  requestedByActorId: ActorId;
  delegationId: DelegationId | null;
  status: RunStatus;
  priority: number;
  writerRequired: boolean;
  latestAttemptNumber: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface RunAttempt {
  id: RunAttemptId;
  workspaceId: WorkspaceId;
  taskId: TaskId;
  runId: RunId;
  attemptNumber: number;
  status: AttemptStatus;
  workerId: string | null;
  leaseToken: string | null;
  fence: bigint;
  writerFence: bigint | null;
  leaseExpiresAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LeaseClaim {
  attemptId: RunAttemptId;
  runId: RunId;
  taskId: TaskId;
  workspaceId: WorkspaceId;
  agentActorId: ActorId;
  workerId: string;
  token: string;
  fence: bigint;
  writerFence: bigint | null;
  expiresAt: Date;
  writer: boolean;
  attemptNumber: number;
}

export interface RunEvent {
  id: RunEventId;
  workspaceId: WorkspaceId;
  taskId: TaskId;
  runId: RunId;
  attemptId: RunAttemptId;
  sequence: number;
  type: string;
  payload: Readonly<Record<string, unknown>>;
  createdAt: Date;
}

export interface Artifact {
  id: ArtifactId;
  workspaceId: WorkspaceId;
  taskId: TaskId;
  actorId: ActorId;
  sourceRunId: RunId | null;
  sourceAttemptId: RunAttemptId | null;
  kind: ArtifactKind;
  name: string;
  uri: string;
  mediaType: string | null;
  byteSize: bigint | null;
  sha256: string | null;
  metadata: Readonly<Record<string, unknown>>;
  createdAt: Date;
}

export interface Approval {
  id: ApprovalId;
  workspaceId: WorkspaceId;
  taskId: TaskId;
  requestedByActorId: ActorId;
  decidedByActorId: ActorId | null;
  kind: ApprovalKind;
  status: ApprovalStatus;
  payload: Readonly<Record<string, unknown>>;
  decisionNote: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

export interface TaskThread {
  task: Task;
  messages: Message[];
  delegations: Delegation[];
  runs: Run[];
  attempts: RunAttempt[];
  events: RunEvent[];
  artifacts: Artifact[];
  approvals: Approval[];
}
