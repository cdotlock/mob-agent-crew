---
artifact: acceptance-criteria
version: "1.0"
created: 2026-08-13
status: accepted-for-mvp
---

# Acceptance Criteria: Human-Agent Task Collaboration

## Story Context

As a member of a small engineering team, I can create a repository-backed task, mention one of our registered agents, observe its work, let that agent delegate a bounded subtask to another agent, and review the combined result without copying context between CLI sessions.

## Happy Path

### AC-1: Human starts an agent collaboration

**Given** a team member, an allowlisted repository, and an available agent

**When** the member creates a task and mentions that agent

**Then** the task thread records the human message, creates one queued run, and shows the selected agent as assigned.

### AC-2: Agent delegates to another agent

**Given** an active agent run with remaining delegation budget

**When** it calls `mob delegate` with another available agent and a concrete deliverable

**Then** the delegation appears in the same task thread and the receiving agent gets the task context, prior messages, revision, and explicit artifacts.

### AC-3: Human reviews one combined result

**Given** all required runs have completed

**When** the task reaches review-ready

**Then** the member can read the collaboration transcript, inspect agent outputs and the platform-generated diff, and accept or reject the result.

## Edge Cases

### AC-4: Driver lacks an interactive capability

**Given** a Codex or other one-shot driver that cannot steer an active process

**When** a member sends a follow-up during its run

**Then** the UI explains that the message is queued for a new continuation rather than claiming it changed the active turn.

### AC-5: Delegation loop is attempted

**Given** the task has reached its configured delegation depth or run budget

**When** an agent attempts another delegation

**Then** the platform rejects it, records the reason, and keeps the current task controllable by a human.

## Error States

### AC-6: Agent process exits unexpectedly

**Given** an active run

**When** its CLI process exits without a terminal success event

**Then** the run is marked failed, the workspace lease is released, logs remain visible, and a human may retry it as a new attempt.

### AC-7: Repository is not allowlisted

**Given** a repository that an administrator has not registered

**When** a user tries to create a task for it

**Then** the task is rejected before any clone, command, credential, or agent process is started.

## Non-Functional Criteria

### AC-8: Identity and approval integrity

**Given** any message, delegation, artifact, or publication request

**When** it is persisted

**Then** its human or agent actor, source run, timestamp, and task are auditable, and no agent credential can approve an SCM write.

### AC-9: Small-server usability

**Given** one application process, PostgreSQL, fewer than ten repositories, and one active run

**When** a normal task is executed

**Then** the platform needs no Redis, Kubernetes, external workflow engine, or manually synchronized CLI session.

