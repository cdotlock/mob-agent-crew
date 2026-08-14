---
artifact: acceptance-criteria
version: "1.0"
created: 2026-08-13
status: accepted-for-mvp
---

# Acceptance Criteria: Human-Agent Conversation and Work

## Story Context

As a member of a small team, I can start a direct or group chat without choosing
a repository, talk to named Agent employees, let an Agent answer or begin work,
observe and interrupt that work, switch to the needed repository when it becomes
relevant, and review a combined result without copying context between CLI
sessions.

## Happy Path

### AC-1: Human starts a conversation

**Given** a team member and an available Agent

**When** the member creates a direct chat with that Agent, or creates a group
and explicitly mentions it

**Then** the conversation is created without a Task or repository requirement,
the message wakes exactly the intended employee, and the Agent may reply,
clarify, or begin longer work from the same transcript.

### AC-2: Ordinary group chat stays ordinary

**Given** a group containing humans and Agents

**When** a human sends a message without an Agent `@mention`

**Then** the message is recorded for the group and no Agent run is started.

### AC-3: Repository work begins on demand

**Given** a conversation that started in scratch and an allowlisted repository

**When** the human selects that repository, or names its GitHub root URL in the
message that requests concrete work

**Then** Mob updates the trusted clone, creates an isolated execution worktree,
shows the live Agent process, and preserves the same conversation history.

### AC-4: Agent delegates to another agent

**Given** an active agent run with remaining delegation budget

**When** it calls `mob delegate` with another available agent and a concrete deliverable

**Then** the delegation appears in the same conversation and the receiving Agent
gets the relevant transcript, selected repository revision, and explicit
artifacts.

### AC-5: Human reviews one combined result

**Given** all required runs have completed

**When** repository work reaches review-ready

**Then** the member can read the collaboration transcript, inspect agent outputs and the platform-generated diff, and accept or reject the result.

## Edge Cases

### AC-6: Driver lacks an interactive capability

**Given** a Codex or other one-shot driver that cannot steer an active process

**When** a member sends a follow-up during its run

**Then** the chat remains usable and the UI explains whether the message became
live steering or a queued continuation instead of claiming it changed the
active process.

### AC-7: Delegation loop is attempted

**Given** the hidden execution scope has reached its configured delegation depth or run budget

**When** an agent attempts another delegation

**Then** the platform rejects it, records the reason, and keeps the conversation controllable by a human.

## Error States

### AC-8: Agent process exits unexpectedly

**Given** an active run

**When** its CLI process exits without a terminal success event

**Then** the run is marked failed, the workspace lease is released, logs remain visible, and a human may retry it as a new attempt.

### AC-9: Repository is not allowlisted

**Given** a repository that an administrator has not registered

**When** a user tries to select or import it for Agent work

**Then** execution is rejected before any untrusted clone, credential, or Agent process is started, while the conversation remains usable.

## Non-Functional Criteria

### AC-10: Identity and approval integrity

**Given** any message, delegation, artifact, or publication request

**When** it is persisted

**Then** its human or Agent actor, conversation, source run, timestamp, and hidden
execution scope where applicable are auditable, and no Agent credential can
approve an SCM write.

### AC-11: Small-server usability

**Given** one application process, PostgreSQL, fewer than ten repositories, and one active run

**When** a normal conversation wakes one Agent and optionally enters repository work

**Then** the platform needs no Redis, Kubernetes, external workflow engine, or manually synchronized CLI session.
