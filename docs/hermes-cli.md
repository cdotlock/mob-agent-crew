# Hermes CLI connector

Hermes is one peer CLI adapter in Mob Agent Crew, at the same level as Pi,
Oh My Pi, Claude Code, and Codex. It is not Mob's planner, model layer, or
orchestrator, and it receives no special delegation privilege.

## Pinned runtime

The Railway image installs:

- `hermes-agent==0.19.0` from the PyPI wheel, verified with SHA-256
  `bd0bac012aee38a60894781f4597dc29ee7bedb3448540249921f10d3bef327f`;
- Claude Code `2.1.220` from the official npm package;
- Codex CLI `0.143.0` through OpenAI's official signed installer;
- GitHub CLI `2.94.0` from its immutable official release, checksum verified.

The Hermes source archive is intentionally not used. The connector needs the
published Python package and starts its documented TUI gateway with:

```text
hermes-python -I -u -m tui_gateway.entry
```

For a standalone fire-and-forget shell call, Hermes also documents
`hermes -z "<prompt>"` (final text only) and `hermes chat -q "<prompt>"`
(non-interactive transcript). Mob uses the gateway instead because one-shot
stdout cannot provide the required tool events, steer, and protocol cancel.

Hermes explicitly documents that it does **not** implement `--mode rpc`.

## Wire contract

The connector speaks JSON-RPC 2.0 over LF-delimited stdio:

1. wait for `gateway.ready`;
2. call `session.create` with the task worktree as `cwd`;
3. call `prompt.submit`;
4. stream `message.delta`, `tool.start`, `tool.progress`, and `tool.complete`;
5. treat `message.complete` as the terminal turn event;
6. map Mob steer to `session.steer` and cancellation to
   `session.interrupt`, with process-group termination as the fallback.

Follow-up and session resume are not advertised yet. A Mob run currently ends
on its first terminal event, so claiming multi-turn follow-up would be false.
Approval, clarification, sudo, or secret prompts also fail closed because the
worker has no interactive response bridge. Headless tasks run with Hermes'
documented `HERMES_YOLO_MODE=1`; Hermes' hardline deny floor still applies,
and Mob's task worktree plus one-writer lease remain the outer boundary.

## MobAI Router

Each agent profile receives a secret-free Hermes `config.yaml`:

```yaml
model:
  provider: mob-ai
  default: deepseek-v4-pro
providers:
  mob-ai:
    api: https://ai.mob-ai.cn/api/v1
    key_env: MOB_AI_KEY
    transport: chat_completions
    default_model: deepseek-v4-pro
    extra_headers:
      User-Agent: mob-agent-crew/0.1
```

The key exists only in the subprocess environment. Hermes officially supports
named custom OpenAI-compatible providers using `api`, `key_env`, and
`transport: chat_completions`.

The other built-in harnesses use the same Router key with their own native
contracts. Pi and Oh My Pi share the `MOB_AI_MODEL` chat model (default
`deepseek-v4-pro`). Claude Code receives the Anthropic-compatible alias from
`MOB_AI_CLAUDE_MODEL` (default `claude-opus-4-6:free`). Codex uses a custom
Responses provider and `MOB_AI_CODEX_MODEL` (default `gpt-5.6-sol`). Hermes is
not promoted above those connectors by this routing choice.

## Authentication boundary

`gh`, `claude`, `codex`, and `hermes` are available in the server image. The
verified repository-authentication path is a masked Railway `GH_TOKEN`, which
the control plane copies into root-only runtime storage and uses through GitHub
CLI's credential helper. Interactive `gh auth login` is not a supported
production contract. Agent subprocesses run under another UID and do not
receive SCM credentials. A human may separately approve publishing a reviewed
task to a new `mob/` branch.

## Official sources

- Hermes repository: <https://github.com/NousResearch/hermes-agent>
- Hermes programmatic protocols: <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/programmatic-integration.md>
- Hermes CLI commands: <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/cli-commands.md>
- Hermes provider configuration: <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/integrations/providers.md>
- Hermes 0.19.0 package metadata: <https://pypi.org/project/hermes-agent/0.19.0/>
- Hermes source-archive packaging report: <https://github.com/NousResearch/hermes-agent/issues/68311>
- Claude Code setup: <https://code.claude.com/docs/en/setup>
- Claude Code 2.1.220: <https://github.com/anthropics/claude-code/releases/tag/v2.1.220>
- Codex installer: <https://github.com/openai/codex/blob/main/scripts/install/install.sh>
- Codex 0.143.0: <https://github.com/openai/codex/releases/tag/rust-v0.143.0>
- GitHub CLI Linux installation: <https://github.com/cli/cli/blob/trunk/docs/install_linux.md>
- GitHub CLI 2.94.0: <https://github.com/cli/cli/releases/tag/v2.94.0>
