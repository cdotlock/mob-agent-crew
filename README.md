# Mob Agent Crew

Mob Agent Crew is a small-team collaboration workspace where people and coding agents share tasks, messages, delegations, artifacts, and approvals.

The platform treats Claude Code, Codex, Pi, Oh My Pi, and future terminal agents as replaceable CLI runtimes. Every agent receives the same collaboration surface through the `mob` CLI:

```text
Human @mentions Agent A
  -> Agent A reads the task thread with `mob context`
  -> Agent A posts findings with `mob say`
  -> Agent A delegates a bounded subtask with `mob delegate @agent-b`
  -> Agent B replies in the same task
  -> a human reviews the diff and approves publication
```

## First-release boundary

- One small server and PostgreSQL
- Fewer than ten allowlisted, trusted repositories
- One embedded worker by default; one active CLI process at a time
- Task-scoped Git worktrees and one writable lease per task
- Simple browser UI for task threads, agent roster, live run events, and artifacts
- No Kubernetes, Redis, shared writable agent directories, automatic merge, or hostile-code security claim

See [the solution brief](docs/solution-brief.md) and [architecture](docs/architecture.md).

## Development

The application is being built as one TypeScript package with a Fastify API and a Vite/React frontend.

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres
pnpm db:migrate
pnpm dev
```

Use a deterministic mock agent while developing:

```bash
MOB_ENABLE_MOCK_DRIVER=true pnpm dev
```

## Deployment shape

The same image supports both the single-process first release and a later split deployment:

```bash
mob start     # API + embedded worker (default)
mob serve     # API only
mob worker    # worker only
```

On Railway, start with one `mob start` service, one PostgreSQL service, and a persistent `/data` volume. Scale vertically first. When concurrency becomes real, move artifacts to object storage and run `mob worker` as separate replicas.

