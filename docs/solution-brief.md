---
artifact: solution-brief
version: "1.0"
created: 2026-08-13
status: accepted-for-mvp
---

# Solution Brief: Mob Agent Crew

## Problem Recap

A small team uses several capable agent CLIs, but each session is an isolated
personal interaction. People cannot talk to named Agent employees in one shared
place, see what they are doing, interrupt them naturally, or hand work between
heterogeneous Agents without manually copying context. Coding tools that force
people to choose a repository and create a Task before talking also break the
normal collaboration flow.

## Proposed Solution

Build a conversation-first workspace where humans and Agents are named
collaborators. A person opens a direct chat or group, talks normally, and wakes
an employee through direct membership or an `@mention`. That Agent reads the
conversation and chooses whether to reply, clarify, or begin longer work. A
repository is selected only when needed; Mob then creates the isolated worktree
automatically. The concrete Agent CLI remains an implementation detail behind a
common driver contract.

## Key Features

1. **Direct and group chats:** Every conversation uses one auditable transcript; direct messages wake the employee, group messages wake only mentioned Agents.
2. **Agent employees:** Every Agent has an owner, name, role, CLI driver, configurable capabilities, isolated credential home, and visible availability/work status.
3. **Bounded delegation:** Agents can ask another agent for analysis, implementation, or review through the platform, with depth, concurrency, and budget limits.
4. **Pluggable CLI drivers:** Pi, OMP, Claude Code, Codex, Hermes, and DeepSeek Harness use one capability-aware driver interface; future CLI protocols can be registered without changing collaboration logic.
5. **Repository-on-demand work:** Repositories are an independent list; an execution selects one and receives an isolated worktree plus one writable lease. Humans approve any push or pull request action.

## Success Metrics

| Metric | Current | First-release target | Timeline |
|---|---:|---:|---|
| Conversations using at least two collaborators | 0 | 10 real conversations | First 30 conversations |
| Agent handoffs completed without manual context copy | 0 | >= 80% | First 20 handoffs |
| Repository work outcomes accepted by a human | Unknown | >= 50% | First 30 work runs |
| Collaboration-layer failures | n/a | < 10% | First 30 work runs |
| Unauthorized SCM writes | 0 | 0 | Ongoing |

## Trade-offs Considered

| What We're Not Doing | Why |
|---|---|
| Kubernetes or a general compute cluster | Fewer than ten repositories and low concurrency do not justify it. |
| Arbitrary visual DAG builder | Mentions and three simple handoff intents cover the first collaboration jobs. |
| Shared simultaneous editing | A single writer lease keeps Git state understandable; reviewers receive snapshots/artifacts. |
| Untrusted public repositories | A normal small server process is not a hostile-code sandbox. |
| Automatic push, merge, or deploy | Publication stays a human capability until trust is earned. |
| Forking either Trellis project | Their repo context and worktree ideas are useful, but neither supplies the multi-user human-agent collaboration model. |

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Agent-to-agent loops waste time and tokens | Medium | High | Maximum delegation depth, task budget, no self-delegation, visible cancel. |
| Different CLIs expose different controls | High | Medium | Capability negotiation; never fake steer/resume support. |
| Personal CLI credentials leak across agents | Medium | High | Per-agent home directories, environment allowlists, no secrets in DB events. |
| Collaboration becomes a noisy chat UI | Medium | Medium | Direct/group membership, mention-based wake-up, named employees, structured work events and artifacts. |

## Next Steps

1. Implement actor, conversation, message, hidden execution, delegation, run, and artifact contracts.
2. Run a complete direct/group conversation using the mock driver and two Agents.
3. Add Codex and Claude one-shot drivers, then Pi/OMP duplex drivers.
4. Validate chat-to-repository selection, automatic worktree creation, live intervention, and one human-approved patch.
