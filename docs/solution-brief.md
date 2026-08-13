---
artifact: solution-brief
version: "1.0"
created: 2026-08-13
status: accepted-for-mvp
---

# Solution Brief: Mob Agent Crew

## Problem Recap

A small engineering team uses several capable coding-agent CLIs, but each session is an isolated personal interaction. People cannot see one shared task history, hand work between their own agents, or ask heterogeneous agents to review and build on each other's output without manually copying context.

## Proposed Solution

Build a shared task workspace where humans and agents are both named collaborators. A person creates a repository-backed task and mentions an agent; the agent reads the same thread, works in a task workspace, posts progress and artifacts, and can delegate a bounded subtask to another registered agent. The concrete CLI is an implementation detail behind a common driver contract.

## Key Features

1. **Shared task threads:** Humans and agents post into one auditable conversation with mentions, status, artifacts, and decisions.
2. **Personal and shared agents:** Every agent has an owner, name, role, CLI driver, isolated credential home, and visible availability.
3. **Bounded delegation:** Agents can ask another agent for analysis, implementation, or review through the platform, with depth, concurrency, and budget limits.
4. **Pluggable CLI drivers:** Pi, OMP, Claude Code, Codex, Hermes, and DeepSeek Harness use one capability-aware driver interface; future CLI protocols can be registered without changing collaboration logic.
5. **Safe Git handoff:** Each task owns a branch/worktree and a single writable lease. Humans approve any push or pull request action.

## Success Metrics

| Metric | Current | First-release target | Timeline |
|---|---:|---:|---|
| Tasks using at least two collaborators | 0 | 10 real tasks | First 30 tasks |
| Agent handoffs completed without manual context copy | 0 | >= 80% | First 20 handoffs |
| Review-ready task outcomes accepted by a human | Unknown | >= 50% | First 30 tasks |
| Collaboration-layer failures | n/a | < 10% | First 30 tasks |
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
| Collaboration becomes a noisy chat UI | Medium | Medium | Task-first threads, explicit deliverables, structured artifacts and decisions. |

## Next Steps

1. Implement actor, task, message, delegation, run, and artifact contracts.
2. Run a complete thread using the mock driver and two agents.
3. Add Codex and Claude one-shot drivers, then Pi/OMP duplex drivers.
4. Validate one real repository task with a human-approved patch.
