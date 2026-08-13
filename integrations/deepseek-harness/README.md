# Mob Agent Crew plugin for DeepSeek Harness

This directory is an installable DeepSeek Harness bundle, using the official Cordis plugin format from `deepseek-ai/deepseek-harness`. It exposes Mob as eight model tools, one on-demand `mob-agent-crew` skill, and a read-only `/mob` human command. Every operation delegates to the installed `mob` CLI except `mob_files`, which uses Mob's documented read-only file API.

It does not copy the Mob server, scheduler, database, Agent drivers or collaboration rules into Harness, and it does not place the repository in the model prompt. Harness initially sees only normal tool schemas and the skill catalog summary; the detailed skill body is loaded on demand.

## Compatibility

The package follows the DeepSeek Harness developer-preview bundle contract verified against official repository commit `47f943859bef60e4160492346772ded9b24f765a` (2026-08-13):

- `package.json` declares `dsh.bundle.patch`.
- `cordis.patch.yml` inserts a normal Cordis plugin row.
- `index.js` exports `apply`, `inject` and a Schemastery `Config`.
- the plugin contributes through `ctx.tools`, `ctx.skills` and `ctx.commands`.

DeepSeek Harness is still a developer preview and declares compatibility-breaking changes possible. This package peers against the `0.1.0-rc.6` DSH service packages; revalidate before upgrading across a later preview line.

## Install

Install and authenticate the external Mob CLI first from this trusted checkout:

```bash
sh scripts/install-cli.sh
mob --help

printf '%s' "$MOB_PASSWORD" | mob login \
  --server https://your-mob.example \
  --email you@example.com \
  --password-stdin
```

Then pack and install this bundle into an existing DeepSeek Harness profile. A tarball is the reliable source-checkout path: it materializes the package's declared runtime dependency next to the plugin. Installing the source directory directly uses a `link:`; that development form requires dependencies to have already been installed inside this plugin directory.

```bash
npm pack ./integrations/deepseek-harness
dsh plugin --profile web add ./mob-agent-crew-dsh-plugin-0.1.0.tgz
dsh --profile web --dump-config
dsh web
```

For one-shot use, install it into the `headless` profile instead:

```bash
dsh plugin --profile headless add ./mob-agent-crew-dsh-plugin-0.1.0.tgz
dsh --profile headless "List my Mob tasks"
```

Remove it with:

```bash
dsh plugin --profile web remove mob-agent-crew-dsh-plugin
```

## File API setup

Mob's file browser requires a human session, so `mob_files` does not reuse a short-lived Agent run token and never accepts a token in model-visible arguments. The tool is registered only when the API is configured. Set the token only in the environment and configure the base URL in the profile's later `cordis.patch.yml` layer:

```bash
export MOB_DSH_TOKEN='your-scoped-session-token'
```

```yaml
- id: mob-agent-crew
  config:
    executable: mob
    timeoutMs: 30000
    maxOutputBytes: 1048576
    fileApiBaseUrl: https://your-mob.example
    fileApiTokenEnv: MOB_DSH_TOKEN
    allowInsecureFileApi: false
```

A later patch replaces the row's complete config, so restate every field as shown. HTTPS is required except for loopback HTTP; `allowInsecureFileApi: true` is an explicit deployment override for a trusted private network.

If this Harness runs inside a Mob Agent run, do not configure the human file API. Use the task checkout through Harness filesystem tools and use `mob_collaborate` for context, progress, delegation, artifacts and completion.

## Exposed surfaces

| Surface | Tool | Backing operation |
| --- | --- | --- |
| Tasks, run/artifact summaries | `mob_task` | `mob task list/show` |
| Task and conversation messages | `mob_chat` | `mob chat send`, `mob conversation send`, `mob agent invoke` |
| Direct/group conversations | `mob_conversation` | `mob conversation list/show/create` |
| Agent discovery/invocation | `mob_agent` | `mob agent list/invoke` |
| Run observation/control | `mob_run` | `mob run status/steer/follow-up/cancel` |
| Raw knowledge and Wiki | `mob_knowledge` | `mob knowledge ...` |
| In-run collaboration/delegation/artifacts | `mob_collaborate` | `mob context/say/delegate/artifact add/done` |
| Contained file listing/preview | `mob_files` | `GET /api/files[/content]` |

The `/mob` UI command intentionally exposes only read-only discovery. The plugin intentionally omits human review/publication, Agent registration, repository import, auth, server/worker startup and database operations.

## Security model

- CLI execution uses argument arrays with `shell: false`; model text is never evaluated as a shell command.
- The child receives a fixed environment allowlist. Provider keys and SCM credentials are not inherited; only Mob config paths or the active short-lived Mob run credential are forwarded when present.
- stdout/stderr and HTTP responses are bounded; timeouts and Harness cancellation terminate work.
- knowledge/artifact file uploads resolve real paths and reject anything outside the current Harness session workspace.
- file API credentials stay in an environment variable named by config and are sent only as an Authorization header. They are not read from or written to the plugin manifest, skill, prompt or tool arguments.
- installing any third-party DSH bundle executes trusted package code in the Harness host process. Pin and review Git sources; prefer a built npm package or tarball when distributing beyond a trusted checkout.
- a globally installed npm package is not automatically a profile sibling. DSH resolves out-of-tree bundles from the profile's managed dependencies; install this tarball with `dsh plugin` instead of relying on a global install plus a bare-name patch.

## Verify

```bash
node --test integrations/deepseek-harness/test/*.test.mjs
(cd integrations/deepseek-harness && npm pack --dry-run)
```
