---
artifact: adr
version: "1.0"
created: 2026-08-13
status: accepted
---

# ADR-001: File-native agent environment

## Status

Accepted

**Date:** 2026-08-13  
**Deciders:** Clock

## Context

Mob Agent Crew began as a shared web workspace backed primarily by PostgreSQL,
with Pi and Oh My Pi running as built-in CLI drivers. The product now needs to
serve the same work to people, cloud agents, local agents, and arbitrary future
CLI tools without becoming another agent framework.

The important product is the environment around agents: durable work files,
stable identities, direct/group conversations, execution commands, observable
events, artifacts,
permissions, and shared knowledge. Harness configuration, model routing, skills,
and private memory belong to the connected agent or its operator. Encoding those
concepts in Mob would make the abstraction thicker, couple collaboration to
vendor behavior, and create competing sources of truth.

The separate MobWiki experiment validated useful file conventions, but keeping
it as another service or repository would split the environment. Its useful
behavior must become an ordinary local knowledge directory in Mob.

## Decision

We will build Mob as a thin, file-native agent environment around four protocol
primitives:

1. **Actors** — stable identities for people and agents. An agent is opaque to
   Mob; it has an ID, name, ownership and access policy, not a platform-owned
   harness or model definition.
2. **Files** — conversations, messages, tasks, run records, events, artifacts
   and knowledge are stored under the workspace data directory in documented,
   human-readable formats.
3. **Commands** — clients may post messages, select a repository, delegate to an
   actor, steer or cancel work and publish results through one small
   authenticated API and the `mob` CLI. A direct message or group `@mention`
   wakes an Agent; there is no separate user-facing invoke command.
4. **Events** — connected executors report normalized lifecycle and activity
   events so the web UI and CLI can observe the same work.

PostgreSQL remains a disposable projection and coordination component for
authentication, indexes, idempotency, queues and leases. It is not the long-term
authority for user-owned work. Migration will be staged: first every current
record is exported and every new mutation is durably written to files; then the
database projection is proven rebuildable from those files before file authority
is declared complete.

Mob will include a workspace-local knowledge area with immutable `raw/` inputs,
curated Markdown in `wiki/`, a rebuildable search cache and per-run context
manifests. It will not depend on or deploy the separate MobWiki runtime.

Existing Pi, OMP, Claude Code and Codex drivers remain compatibility connectors.
They do not define the domain model, and we will not expand Mob into a harness or
model catalog. Local or remote executors will eventually connect through the same
claim/event/result protocol without requiring inbound access to the user's
machine.

Conversation is independent of execution. Creating a direct or group chat does
not create a repository-backed Task. Repositories are selected from a workspace
list only when needed, and Mob creates a hidden execution record and isolated
worktree at that point. Legacy task records remain internal coordination and
publication state rather than the product's navigation model.

## Consequences

### Positive

- Work remains inspectable, portable and recoverable without a proprietary UI.
- The web app, `mob` CLI and external agents share one protocol and one history.
- Any current or future agent can participate without Mob understanding its
  model, skills, memory implementation or internal session protocol.
- Knowledge becomes part of the same environment and can be selected into run
  context with exact file and revision evidence.
- PostgreSQL can continue to provide simple, mature concurrency without becoming
  the owner of user content.

### Negative

- File and projection consistency needs an explicit commit/replay boundary during
  migration.
- A single writable data volume remains the authority node; horizontal API
  replicas cannot independently write workspace files.
- Agents must not receive direct write access to control-plane files. All identity,
  command and event writes still pass through authenticated Mob operations.
- Rebuild, compaction and schema migration tooling become necessary as the file
  protocol evolves.

### Neutral

- Secrets, password hashes and short-lived tokens are operational credentials,
  not user-owned workspace content; they remain outside readable workspace files.
- Runtime-specific connectors may still require internal configuration, but that
  configuration is not exposed as the product's Agent abstraction.

## Alternatives Considered

### Model every agent as harness + model + skills + memory

Rejected. It turns Mob into an agent framework, duplicates configuration already
owned by each CLI, and couples collaboration to concepts that differ across
vendors.

### Keep MobWiki as a separate Git-backed service

Rejected. Its useful artifact is the file protocol, not the Python/MCP/viewer
runtime. A second service and synchronization boundary make the environment less
reliable and harder to understand.

### Keep PostgreSQL as the sole authority

Rejected. It prevents agents and people from directly inspecting, moving and
versioning their complete work history as files.

### Use only files and remove PostgreSQL immediately

Rejected for the migration. Reimplementing sessions, queue claims, leases,
idempotency and concurrent indexes with ad-hoc file locks would add complexity
without improving the user-owned data model.

### Adopt the Mob Sandbox control plane

Rejected for the core environment. SSH attach and localhost forwarding are useful
future connector ideas, but Daytona, root operators, Traefik tunnels and related
services are too heavy for the current small trusted deployment.

## References

- [Mob Agent Crew architecture](../architecture.md)
- [MobWiki](https://github.com/cdotlock/mob-wiki)
- [Mob Sandbox](https://github.com/cdotlock/mob-sandbox)
