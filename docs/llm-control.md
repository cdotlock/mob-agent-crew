# Mob control protocol for people and LLM agents

This is the operational entrypoint for an LLM, local coding Agent, or person
controlling a Mob environment from another computer. Read this document before
issuing commands.

Every deployed Mob web app also publishes a short, unauthenticated discovery
file at `/llms.txt`. Give `https://your-mob.example/llms.txt` to an external LLM
first; it points here for the complete authenticated control contract.

## Mental model and hard boundaries

Mob is a thin shared environment: **Actors + Files + Commands + Events**. It
stores only the selected harness ID, model ID, skill references and environment
reference for each Agent; it does not implement those systems or copy private
memory. Pi, Oh My Pi, Claude Code, Codex and Hermes are peer CLI connectors
behind the same `AgentDriver` contract. Hermes is not a planner and receives no
orchestration privilege.

Keep these invariants:

- A task owns the repository checkout, guardrails and primary group chat.
- A direct or group conversation owns membership and a separate transcript.
- Sending chat text does not necessarily invoke an Agent. Use an explicit
  invoke command when work should start.
- An active Agent may ask another Agent for a bounded deliverable only through
  `mob delegate`; it must not invoke another vendor CLI directly.
- One task has one writable workspace lease at a time. A human may separately
  approve and publish a reviewed result to a new `mob/` branch; Agents cannot.
- Never put a password, Mob token, provider key or GitHub token in a prompt,
  chat message, command argument, artifact, or workspace file.

## Install or update the external CLI

Requirements: Git, Node.js 22 or newer, and Corepack. Review the installer,
then run it from a trusted checkout:

```bash
git clone https://github.com/cdotlock/mob-agent-crew.git
cd mob-agent-crew
sh scripts/install-cli.sh
```

The installer is idempotent. It keeps a managed checkout at
`~/.local/share/mob-agent-crew-cli`, builds the pinned lockfile, and links only
`~/.local/bin/mob`. It refuses to replace another `mob` executable or overwrite
tracked local edits. Add that bin directory to `PATH` if necessary:

```bash
export PATH="$HOME/.local/bin:$PATH"
mob --help
```

The locations and source ref can be selected without editing the script:

```bash
MOB_CLI_INSTALL_DIR="$HOME/tools/mob-cli" \
MOB_CLI_BIN_DIR="$HOME/bin" \
MOB_CLI_REF="main" \
sh scripts/install-cli.sh
```

Running the same command updates the managed checkout. For a more controlled
installation, set `MOB_CLI_REF` to a reviewed release branch or tag instead of
tracking `main`. This installer follows the selected ref on update; it does not
pin or verify an immutable commit, so it is not a reproducible-build mechanism.

## Login safely

Use standard input so the password is not stored in shell history:

```bash
printf '%s' "$MOB_PASSWORD" | mob login \
  --server https://your-mob.example \
  --email you@example.com \
  --password-stdin
```

An existing scoped token can also arrive on standard input:

```bash
printf '%s' "$MOB_TOKEN" | mob login \
  --server https://your-mob.example \
  --token-stdin
```

The client stores the normalized server URL and scoped session token in
`~/.config/mob/config.json` with mode `0600`. Override the location with
`MOB_CONFIG_PATH`. Use `mob logout` to delete it. Do not read or print that file
inside an LLM session.

## Common remote-control workflow

Discover stable IDs first; do not guess them:

```bash
mob task list
mob task show <task-id>
mob agent list
mob model list
mob conversation list
```

`mob model list` reads the server-side model catalog. It returns public model
metadata and protocol compatibility only; Router credentials remain inside the
control plane.

The task chat is the backward-compatible primary group conversation:

```bash
mob chat send <task-id> "Here is context only; do not start work yet."
mob agent invoke <task-id> @builder "Inspect the failure and implement the smallest safe fix."
```

`agent invoke` selects the Agent explicitly, posts the instruction to the
primary task chat, and returns the queued run. If that task was completed or
cancelled, the command first records a human `request_changes` decision and
retries the invocation once. Save the returned run ID and observe normalized
events:

```bash
mob run status <run-id>
mob run watch <run-id>
mob run steer <run-id> "Prioritize the failing path; leave unrelated files unchanged."
mob run follow-up <run-id> "Now run the focused verification and summarize evidence."
mob run cancel <run-id>
```

`steer` or `follow-up` is accepted only while that run is active on the same
worker and only if its connector implements the capability. A `409` rejection
is a real connector/lifecycle limitation, not permission to start a hidden
second process. `run watch` stops at `succeeded`, `failed`, or `cancelled`.

## Direct and group conversations

Every task has a primary group conversation whose ID equals the task ID. Create
an additional private/direct or group transcript under that task:

```bash
mob conversation create <task-id> --kind direct --member @builder
mob conversation create <task-id> --kind group \
  --title "Release review" --member @builder @reviewer

mob conversation show <conversation-id>
mob conversation send <conversation-id> "Discussion only; do not execute."
mob conversation send <conversation-id> \
  --invoke @reviewer \
  "Review the current patch and return blocking risks."
```

For `direct`, Mob enforces exactly one human and one Agent. For `group`, use
explicit membership. `--invoke` starts exactly one Agent member and records the
trigger message on the run. An Agent run cannot bypass delegation guardrails by
setting `invoke`; it must use `mob delegate`.

Equivalent HTTP operations, for clients that cannot launch the CLI:

```text
GET  /api/conversations
POST /api/conversations
     {"taskId":"<uuid>","kind":"direct|group","title":"optional","members":["@builder"]}
GET  /api/conversations/<conversation-id>
POST /api/conversations/<conversation-id>/messages
     {"content":"...","invoke":true,"agent":"@builder","writerRequired":true}
```

Authenticate HTTP requests with `Authorization: Bearer <scoped-token>`. Never
place the token in a URL. Ordinary messages should omit `invoke` or set it to
`false`.

## Add and define an Agent

An Agent identity is a stable Actor plus a small connector profile. Harnesses,
models and private memory remain implemented by the selected CLI or runtime.
Mob owns a small, file-native shared catalog for reusable Skill instructions,
installed Plugin references, and secret-free Environment profiles. List it
before composing an Agent:

```bash
mob model list
mob capability list
```

The model response includes every Router entry and its supported protocol. A
model is selectable only when that protocol matches the chosen harness; media,
embedding, rerank, Chat, Responses and Messages entries are not silently
treated as interchangeable.

```bash
mob agent add \
  --handle reviewer-two \
  --name "Reviewer Two" \
  --driver deepseek \
  --role "Independent implementation reviewer" \
  --model deepseek-v4-pro \
  --skill mob:repository-knowledge \
  --skill mob:collaboration \
  --plugin mob:deepseek-harness \
  --environment railway:default
mob agent list
```

`mob agent list` reads the canonical `GET /api/agents` composition view. Change
an existing identity by UUID or stable handle:

```bash
mob agent configure @reviewer-two \
  --driver codex \
  --model gpt-5.6-sol \
  --skill mob:repository-knowledge \
  --skill mob:collaboration \
  --environment railway:default
```

`configure` first reads the current Agent and preserves every field not named
on the command. Repeated `--skill` flags replace the complete skill list. Use
the explicit reset flags when that is the intended change:

```bash
mob agent configure <agent-uuid> --default-model
mob agent configure @reviewer-two --clear-skills --clear-plugins --clear-environment
```

`--model` conflicts with `--default-model`; `--skill` conflicts with
`--clear-skills`; `--plugin` conflicts with `--clear-plugins`; and
`--environment` conflicts with `--clear-environment`. Fields not named on
`configure` are preserved.

The environment option accepts a catalog reference such as `railway:default`.
Mob resolves its latest secret-free values for every run, so one catalog edit
updates every Agent that selected it. There is deliberately no CLI flag for
environment values, provider keys, GitHub tokens, passwords, or other secrets.
Control-plane credentials remain outside Agent profiles and catalog files.

The browser's **Add Agent → Capabilities → Add to shared catalog** form writes
stable JSON under the workspace `capabilities/` directory. Equivalent
human-authenticated HTTP operations are:

```text
GET  /api/capabilities/catalog
POST /api/capabilities/catalog/skills
     {"id":"team:review","name":"Team review","instructions":"..."}
POST /api/capabilities/catalog/environments
     {"id":"team:focused","name":"Focused","values":{"LOG_LEVEL":"info"}}
POST /api/capabilities/catalog/plugins
     {"id":"team:tooling","name":"Tooling","compatibleDrivers":["pi"]}
```

Workspace users may register a Plugin reference, but they cannot claim that
executable code is installed. Only control-plane built-ins can be selected as
installed Plugins; ordinary catalog Plugin entries remain visibly unavailable
until the runtime image provides them. Selected Skill and installed Plugin
instructions are added to the bounded run context. Mob never executes code from
a catalog file.

Valid driver IDs are `pi`, `omp`, `claude`, `codex`, `hermes`, and `deepseek`.
The standard
server image contains these CLI executables. `agent add` registers an Actor and
connector profile; an `available` status means that identity is active, not that
Mob has run an end-to-end model health check. Names and roles are user-defined
but must not imply privileges the connector does not have.

### MobAI Router model mapping

All six built-in connectors receive a task-scoped proxy credential in the
environment variable their harness expects. The real `MOB_AI_KEY` stays in the
control plane. They use connector-appropriate Router transports and model aliases:

| Connectors | Router transport | Model variable | Default |
| --- | --- | --- | --- |
| Pi, Oh My Pi, Hermes, DeepSeek Harness | Chat-compatible provider | `MOB_AI_MODEL` | `deepseek-v4-pro` |
| Claude Code | Anthropic-compatible environment aliases | `MOB_AI_CLAUDE_MODEL` | `claude-opus-4-6:free` |
| Codex | OpenAI Responses provider | `MOB_AI_CODEX_MODEL` | `gpt-5.6-sol` |

`MOB_AI_BASE_URL` defaults to `https://ai.mob-ai.cn/api`. Pi and Oh My Pi use
their OpenAI-compatible chat adapters, Hermes uses `chat_completions`, and
DeepSeek Harness receives official `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`
aliases plus a secret-free model patch. Claude Code receives `ANTHROPIC_*`
aliases, and Codex receives an ephemeral custom provider with
`wire_api="responses"`. Do not give every harness the same model name: the
Router aliases and wire protocols are intentionally different.

## Commands available inside an Agent run

Mob injects a short-lived `MOB_RUN_TOKEN` and `MOB_API_URL` into the isolated CLI
process. The token identifies the Agent, workspace, task, run, and exact active
attempt. Every Agent API call rechecks the live attempt and lease; completion,
cancellation, retry, or lease expiry revokes that token. This is still not a
strict one-run data sandbox: knowledge is workspace-scoped, and an Agent
identity can list conversations in which it is a member. Never print or inspect
the credential.

An Agent should use only the following collaboration surface:

```bash
mob context
mob say "Implemented the parser; running the focused test now."
mob delegate @reviewer "Review only the parser diff for correctness" --read-only
mob artifact add ./report.md
mob done "Parser fixed and focused verification passed."
```

Call `mob done` once. Use `mob say` only for meaningful progress. The Agent can
edit its task-scoped checkout directly, but cannot receive SCM write
credentials or approve publication.

## Knowledge, repository Wiki, and files

Mob is the only Wiki service. Before every run, the server updates a clean task
checkout from its allowlisted Git remote, snapshots supported repository
Markdown into `knowledge/raw/repositories/...`, refreshes a deterministic
`knowledge/wiki/repositories/<repo>/index.md`, and retrieves bounded relevant
excerpts with a provenance manifest. A dirty checkout is never reset or
overwritten automatically.

Use the same knowledge surface locally or from an Agent run:

```bash
mob knowledge list --area raw
mob knowledge list --area wiki
mob knowledge search "authentication boundary"
mob knowledge retrieve "current repository architecture"
mob wiki ask "What controls the writable workspace lease?"
mob knowledge read wiki/repositories/<repo>/index.md
mob knowledge add-raw imports/design-brief.md ./design-brief.md
mob knowledge curate decisions/agent-boundary.md ./agent-boundary.md
mob wiki import-dir ./docs --area raw
mob wiki import-dir ./curated-wiki --area wiki
mob knowledge lint
```

`wiki ask` returns a bounded, citation-labelled context assembled from the
workspace files; it does not hide a second model call. `wiki import-dir`
recursively uploads visible `.md` and `.markdown` files in deterministic order,
preserves their relative paths, and never follows hidden entries or symbolic
links. `raw` is immutable source material; `wiki` is curated and replaceable.
If an upload fails, the CLI stops and names the exact file and completed prefix.

Equivalent knowledge discovery operations are:

```text
GET /api/knowledge/query?q=<natural-language-question>&top=6&budget=12000
GET /api/knowledge/file?path=wiki/<cited-path>
```

The web file browser is backed by a read-only, path-contained API. All listings
omit symlinks. Repository listings additionally omit `.git`, `node_modules`,
`.env`, `.env.*`, `.npmrc`, `.pypirc`, `credentials.json`, common credential
directories/files, and private-key extensions. Direct reads reject a symlink in
the root or any requested path segment, then resolve the real path and reject
anything escaping the selected root. A preview containing a NUL byte or invalid
UTF-8 is rejected as non-renderable. Files larger than the 512 KiB preview limit
are truncated and returned with `truncated: true`, not rejected. This is a
convenience viewer, not a general secret scanner or file sandbox:

```text
GET /api/files?scope=repository&taskId=<uuid>&path=docs
GET /api/files/content?scope=repository&taskId=<uuid>&path=docs/architecture.md
GET /api/files?scope=workspace&taskId=<uuid>&path=knowledge/wiki
```

These file endpoints require a human session. Agents should use the
workspace-scoped knowledge endpoints instead; do not attempt to traverse
`/data`. Workspace scope intentionally exposes only `knowledge/` and
`documents/`; private conversation ledgers are not a file-browser surface.
Repository scope also enforces conversation membership for tasks containing
private conversations.

## GitHub access on Railway

For production, the current supported path is a repository-scoped `GH_TOKEN`
set as a masked Railway service variable. Start with read-only Contents access;
add write access only when the human-approved Publish branch action is required.
Do not paste a token into a
task, LLM prompt, repository URL, or shell command. Then open a Railway shell
and verify without printing the credential:

```bash
gh auth status --hostname github.com
```

A signed-in human can check setup without exposing the credential:

```text
GET /api/integrations/github/status
```

The response contains only `configured`, the variable name, and safe setup and
verification commands. It never reads or returns the token file. For a CLI
setup, pass the token on standard input:

```bash
railway variable set GH_TOKEN --stdin --skip-deploys
```

At standard container start the token is copied into a root-only runtime file
and removed from the service environment. Server-side materialization and human-approved
publication use it only with a root-owned control repository. Agent-owned Git
metadata is never reused by the control plane. The token is not embedded in the
remote URL or arguments, and CLI Agent processes run under a different OS UID.
Interactive `gh auth login` is not a production contract.

## Self-iteration workflow

Mob can work on its own allowlisted repository through the same ordinary path;
there is no privileged self-modification mode:

1. A human imports/allowlists the Mob repository in the web UI or
   `POST /api/tasks/<task-id>/imports/github`.
2. A human creates a task against that repository in the web UI or through
   `POST /api/tasks`, then explicitly invokes one Agent.
3. The worker materializes the task checkout and refreshes repository knowledge.
4. Watch the terminal events, steer only when necessary, and ask another Agent
   for a bounded review through delegation.
5. Inspect the changed checkout and artifacts, then explicitly approve or
   request changes.
6. A human may choose **Publish branch** in the web app, or run:

   ```bash
   mob task review <task-id> --accept --note "focused tests passed"
   mob task publish <task-id> --confirm
   ```

   Mob overlays ordinary reviewed files onto a fresh checkout of the exact
   materialized base commit, then pushes a new `mob/<task>` branch. It rejects
   symlinks, special files, secret-shaped filenames, common secret content and
   active Agent runs. PR, merge and deploy remain outside this release.
7. Create the next task from observed evidence; never let an Agent silently
   deploy or rewrite control-plane state.

This loop is intentionally the same as work on every other repository. It makes
Mob useful for modifying and reviewing itself, but it is not yet an end-to-end
self-deployment loop.

The corresponding JSON bodies are intentionally small:

```text
POST /api/tasks/<existing-task-id>/imports/github
     {"url":"https://github.com/cdotlock/mob-agent-crew"}
POST /api/tasks
     {"title":"Improve Mob itself","repository":"<allowlisted-id-or-name>",
      "baseRef":"main","initialMessage":"<current instruction>",
      "agentId":"<optional-agent-uuid>"}
```

## Database file-ledger rebuild

`mob db rebuild` is a local server-administrator command, not a remote Agent or
web operation. Run a read-only validation first:

```bash
mob db rebuild --workspace <workspace-uuid>
```

Apply only with normal work stopped, after backing up PostgreSQL and `/data`:

```bash
mob db rebuild \
  --workspace <workspace-uuid> \
  --apply \
  --confirm <workspace-uuid>
```

Apply uses one transaction and refuses an active queue, attempt, writer lease,
or repository import. Replay is additive: it rebuilds file-backed collaboration
rows but does not delete database-only rows. Agent connector profiles are part
of the file ledger. Authentication records, import queues, leases, provider
keys and session secrets remain operational state and are not reconstructed.
The profile row does not recreate a missing `/data/agents/<actor-id>` provider
home, so retain the full `/data` volume or regenerate those secret-free config
files before starting recovered Agents. Read [File ledger replay](file-replay.md)
before disaster recovery.

## Add another peer CLI connector

Do not add a planner abstraction or vendor behavior to the collaboration core.
Implement the smallest adapter:

1. Add its stable ID to `AgentDriverId` and implement `AgentDriver` under
   `src/agents/`.
2. Declare truthful capabilities: transport, steer, follow-up, cancel, resume,
   sandbox expectation and terminal completion signal.
3. Launch it only through the shared process supervisor with a task checkout,
   isolated home/config/temp directories and an explicit environment allowlist.
   Never inherit the server environment wholesale.
4. Map native stdout/JSON-RPC events into normalized Mob events and recognize a
   real terminal outcome. Preserve unknown native types as diagnostics.
5. Register the connector in `createDefaultAgentDriverRegistry`, add it to the
   human-only Agent creation allowlist, and generate provider config in that
   Agent's own home only when required.
6. Add focused mapping, lifecycle, cancellation and secret-redaction tests.
7. Install the upstream CLI in the runtime image at a reviewed version and
   verify its actual `--help`/protocol. Do not claim support merely because a
   binary exists.

Pi, Oh My Pi, Claude Code, Codex, Hermes, and any future connector remain peers
under these rules.
