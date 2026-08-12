# Mob Agent Crew repository guidance

## Product boundary

Build a small-team collaboration workspace where humans and CLI-based coding agents work in the same task threads. Collaboration is the product; infrastructure scale is not.

The first release targets one small server, fewer than ten trusted repositories, and low concurrency. Keep the runtime simple: one web/API process, one embedded worker, PostgreSQL, local data storage, and task-scoped Git worktrees.

## Engineering rules

- Prefer a vertical, usable slice over platform abstractions without a caller.
- Keep commits atomic and push after each coherent milestone.
- Do not add Kubernetes, Redis, Temporal, or a workflow-DAG builder.
- Agent CLIs are adapters behind `AgentDriver`; collaboration semantics never depend on one vendor.
- Humans and agents are both actors. Only humans may approve SCM publication.
- Agents collaborate through task messages, explicit delegations, and immutable artifacts. They never invoke another vendor CLI directly.
- One task may have only one writable workspace lease at a time.
- Never put SCM write credentials in an agent subprocess.
- Unknown repositories are rejected; this release supports allowlisted trusted repositories only.

## Commands

```bash
pnpm install
pnpm check
pnpm test
pnpm build
pnpm dev
```

## Code layout

- `src/` — server, database, collaboration core, CLI drivers, and worker
- `web/` — React collaboration UI
- `docs/` — product and architecture decisions
- `test/` — focused behavior tests

