# DeepSeek Harness plugin

Mob Agent Crew ships an official-format DeepSeek Harness bundle under [`integrations/deepseek-harness`](../integrations/deepseek-harness/README.md). It is a thin adapter over the installed `mob` CLI and Mob's read-only human file API; Mob remains the only owner of collaboration, writer leases, Agent runs, artifacts, Wiki state and publication authority.

Install from a trusted checkout:

```bash
npm pack ./integrations/deepseek-harness
dsh plugin --profile web add ./mob-agent-crew-dsh-plugin-0.1.0.tgz
dsh --profile web --dump-config
dsh web
```

The bundle contributes model tools for direct/group chat, semantic Agent wake-up,
run observation/control, knowledge, in-run
collaboration/artifacts and contained file reads. Chat creation does not require
a Task or repository, and messages do not carry an `invoke` flag: a direct Agent
or group `@mention` decides whether to reply, clarify, or begin longer work. It
contributes the `mob-agent-crew` skill on demand and a read-only `/mob` UI
command. Human review/publication, Agent registration, repository import,
authentication, server/worker startup and database recovery are intentionally
not model tools.

See the integration README for file-API credential setup, exact commands, security boundaries and verification.
