# Mob Agent Crew

Mob Agent Crew is a small-team, file-native environment where people and coding
agents share tasks, messages, delegations, artifacts, knowledge, and observable
runs.

Mob does not own an agent's harness, model, skills, or private memory. Pi, Oh My
Pi, Claude Code, Codex, Hermes, DeepSeek Harness, and future local or cloud
agents are opaque participants connected to the same Actor + Files + Commands +
Events protocol.

The platform treats Claude Code, Codex, Pi, Oh My Pi, Hermes, DeepSeek Harness,
and future terminal agents as replaceable CLI runtimes. Every agent receives
the same collaboration surface through the `mob` CLI:

```text
Human @mentions Agent A
  -> Agent A reads the task thread with `mob context`
  -> Agent A posts findings with `mob say`
  -> Agent A delegates a bounded subtask with `mob delegate @agent-b`
  -> Agent B replies in the same task
  -> a human reviews the diff and separately approves a new mob/ branch
```

All built-in CLIs use MobAI Router, but not through one forced wire format: Pi,
Oh My Pi, Hermes, and DeepSeek Harness use the chat model (`MOB_AI_MODEL`);
Claude Code uses the Anthropic alias (`MOB_AI_CLAUDE_MODEL`); Codex uses the
Responses model (`MOB_AI_CODEX_MODEL`).

Mob is also packaged as an installable DeepSeek Harness bundle. It exposes the
same task, conversation, run, knowledge, file, delegation, and artifact
surfaces as thin tools instead of copying Mob's orchestration into the harness.
See [the DeepSeek Harness plugin guide](docs/deepseek-harness-plugin.md).

## First-release boundary

- One small server and PostgreSQL
- Fewer than ten allowlisted, trusted repositories
- One embedded worker by default; one active CLI process at a time
- Root-only control repositories plus isolated task-scoped Agent working copies
- One writable lease per task and human-only publication
- Simple browser UI for task threads, agent roster, live run events, and artifacts
- No Kubernetes, Redis, shared writable agent directories, automatic merge, or hostile multi-tenant security claim

## Use the environment from another computer

The same `mob` executable can be a server command, an in-run collaboration tool,
or an external client. Passwords and tokens do not need to appear in shell
history:

```bash
printf '%s' "$MOB_PASSWORD" | mob login \
  --server https://your-mob.example \
  --email you@example.com \
  --password-stdin

mob task list
mob chat send <task-id> "@builder inspect this repository"
mob agent invoke <task-id> reviewer "review Builder's result"
mob run watch <run-id>
```

The client stores only the server URL and scoped session token in
`~/.config/mob/config.json` with mode `0600` (or at `MOB_CONFIG_PATH`).

Install the external CLI without root from a trusted checkout:

```bash
git clone https://github.com/cdotlock/mob-agent-crew.git
cd mob-agent-crew
sh scripts/install-cli.sh
```

For direct/group chats, live steering, Agent definition, GitHub access,
self-iteration, file browsing, and the exact HTTP contracts, give
[the Mob control protocol](docs/llm-control.md) to the controlling LLM.

## Built-in file knowledge

Mob includes the useful file protocol from the former MobWiki direction without
running a separate MobWiki service:

```bash
mob knowledge add-raw imports/brief.md ./brief.md
mob knowledge curate architecture/decision.md ./decision.md
mob knowledge search "writer lease"
mob knowledge lint
```

Workspace knowledge is stored under `/data/state/workspaces/<id>/knowledge`:
immutable source Markdown in `raw/`, curated Markdown in `wiki/`, disposable
search data in `cache/`, and exact retrieval provenance in `manifests/`. Before a
run starts, Mob automatically selects a bounded set of relevant excerpts and
records the context manifest.

All collaboration state is also projected to readable, stable files under
`/data/state/workspaces/<id>/`. PostgreSQL remains the live queue, lease,
session and API projection. A guarded, additive replay can validate or rebuild
file-backed collaboration rows, including Agent connector profile rows, with
`mob db rebuild`; operational auth and lease state remains
database/environment-owned. Provider homes under `/data/agents` still belong to
the volume and must be retained or regenerated. See
[the replay runbook](docs/file-replay.md) and
[ADR-001](docs/adr/001-file-native-agent-environment.md).

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
