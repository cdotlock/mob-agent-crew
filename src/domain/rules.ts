import type {
  ActorId,
  ActorKind,
  ActorStatus,
  AttemptStatus,
  DelegationStatus,
  DriverCapabilities,
  LeaseClaim,
  RunStatus,
  TaskStatus,
} from "./model.js";

export const HANDLE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const MAX_HANDLE_LENGTH = 48;

const taskTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  open: ["active", "cancelled"],
  active: ["review_ready", "cancelled"],
  review_ready: ["active", "completed", "cancelled"],
  completed: [],
  cancelled: [],
};

const runTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

const attemptTransitions: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = {
  queued: ["claimed", "cancelled"],
  claimed: ["running", "failed", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

const delegationTransitions: Readonly<Record<DelegationStatus, readonly DelegationStatus[]>> = {
  queued: ["accepted", "rejected", "cancelled"],
  accepted: ["completed", "rejected", "cancelled"],
  completed: [],
  rejected: [],
  cancelled: [],
};

export class DomainRuleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainRuleError";
    this.code = code;
  }
}

export function normalizeHandle(input: string): string {
  const normalized = input.trim().toLowerCase().replace(/^@+/, "");
  if (normalized.length === 0 || normalized.length > MAX_HANDLE_LENGTH || !HANDLE_PATTERN.test(normalized)) {
    throw new DomainRuleError(
      "invalid_handle",
      `Handle must be 1-${MAX_HANDLE_LENGTH} lowercase letters, digits, or single hyphen-separated words.`,
    );
  }
  return normalized;
}

/** Extracts unique, normalized @handles in first-appearance order. */
export function extractMentionHandles(body: string): string[] {
  const handles: string[] = [];
  const seen = new Set<string>();
  const mentionPattern = /(^|[^\p{L}\p{N}_-])@([a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)*)/gu;

  for (const match of body.matchAll(mentionPattern)) {
    const raw = match[2];
    if (raw === undefined) continue;
    const handle = normalizeHandle(raw);
    if (!seen.has(handle)) {
      seen.add(handle);
      handles.push(handle);
    }
  }
  return handles;
}

export function assertTransition<T extends string>(
  entity: string,
  from: T,
  to: T,
  transitions: Readonly<Record<T, readonly T[]>>,
): void {
  if (!transitions[from].includes(to)) {
    throw new DomainRuleError("invalid_transition", `Cannot transition ${entity} from ${from} to ${to}.`);
  }
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  assertTransition("task", from, to, taskTransitions);
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  assertTransition("run", from, to, runTransitions);
}

export function assertAttemptTransition(from: AttemptStatus, to: AttemptStatus): void {
  assertTransition("attempt", from, to, attemptTransitions);
}

export function assertDelegationTransition(from: DelegationStatus, to: DelegationStatus): void {
  assertTransition("delegation", from, to, delegationTransitions);
}

export interface DelegationRuleInput {
  fromActorId: ActorId;
  toActorId: ActorId;
  toActorKind: ActorKind;
  toActorStatus: ActorStatus;
  depth: number;
  maxDepth: number;
  existingRunCount: number;
  runBudget: number;
  deliverable: string;
}

export function assertDelegationAllowed(input: DelegationRuleInput): void {
  if (input.fromActorId === input.toActorId) {
    throw new DomainRuleError("self_delegation", "An actor cannot delegate to itself.");
  }
  if (input.toActorKind !== "agent" || input.toActorStatus !== "active") {
    throw new DomainRuleError("agent_unavailable", "Delegations require an active agent recipient.");
  }
  if (input.depth > input.maxDepth) {
    throw new DomainRuleError("delegation_depth_exceeded", "Task delegation depth has been exhausted.");
  }
  if (input.existingRunCount >= input.runBudget) {
    throw new DomainRuleError("run_budget_exceeded", "Task run budget has been exhausted.");
  }
  if (input.deliverable.trim().length === 0) {
    throw new DomainRuleError("deliverable_required", "A delegation must name a concrete deliverable.");
  }
}

export function assertHumanApproval(actorKind: ActorKind): void {
  if (actorKind !== "human") {
    throw new DomainRuleError("human_approval_required", "Only a human actor may approve publication.");
  }
}

export interface LeaseGuard {
  attemptId: string;
  token: string;
  fence: bigint;
  writerFence: bigint | null;
  expiresAt: Date;
}

export function isLeaseCurrent(
  expected: LeaseGuard,
  presented: Pick<LeaseClaim, "attemptId" | "token" | "fence" | "writerFence">,
  now: Date = new Date(),
): boolean {
  return (
    expected.attemptId === presented.attemptId &&
    expected.token === presented.token &&
    expected.fence === presented.fence &&
    expected.writerFence === presented.writerFence &&
    expected.expiresAt.getTime() > now.getTime()
  );
}

export function leaseExpiry(now: Date, leaseMs: number): Date {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new DomainRuleError("invalid_lease_duration", "Lease duration must be a positive integer.");
  }
  return new Date(now.getTime() + leaseMs);
}

export function normalizeGitHubRepositoryUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new DomainRuleError("invalid_repository_url", "Repository URL must be a valid GitHub URL.");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new DomainRuleError("invalid_repository_url", "Only HTTPS github.com repository URLs are accepted.");
  }
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new DomainRuleError("invalid_repository_url", "GitHub URL must identify exactly one owner/repository.");
  }
  const owner = parts[0];
  const rawRepo = parts[1];
  if (owner === undefined || rawRepo === undefined) {
    throw new DomainRuleError("invalid_repository_url", "GitHub URL must identify exactly one owner/repository.");
  }
  const repo = rawRepo.replace(/\.git$/i, "");
  const segmentPattern = /^[A-Za-z0-9_.-]+$/;
  if (!segmentPattern.test(owner) || !segmentPattern.test(repo) || repo.length === 0) {
    throw new DomainRuleError("invalid_repository_url", "GitHub owner and repository contain invalid characters.");
  }
  return `https://github.com/${owner}/${repo}.git`;
}

export function assertMarkdownDocument(content: string | null, localPath: string | null): void {
  if ((content?.length ?? 0) === 0 && (localPath?.trim().length ?? 0) === 0) {
    throw new DomainRuleError(
      "document_body_required",
      "A Markdown document requires inline content or a local path.",
    );
  }
}

export const DEFAULT_DRIVER_CAPABILITIES: DriverCapabilities = Object.freeze({
  streaming: false,
  steer: false,
  followUp: false,
  resume: false,
  nativeCancel: false,
});
