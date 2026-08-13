# File ledger replay

Mob workspace files can rebuild the PostgreSQL collaboration projection after a
database loss or repair missing projection rows. Replay is an explicit local
administrator operation; it is not exposed through the web API or to an Agent
run token.

## Validate first

The command is read-only unless `--apply` is present:

```bash
mob db rebuild --workspace <workspace-uuid>
```

It reads `/data/state/workspaces/<workspace-uuid>`, validates IDs and references,
and compares file record counts with PostgreSQL. Invalid files are listed and no
database writes occur. The dry-run expects the current schema; if needed, run
`mob db migrate` explicitly first.

## Apply

Stop normal work for the workspace, then repeat with an exact confirmation:

```bash
mob db rebuild \
  --workspace <workspace-uuid> \
  --apply \
  --confirm <workspace-uuid>
```

Apply first brings the schema current, then runs replay in one transaction. It
holds table locks during the replay and refuses to start while there are
queued/running runs, claimed/running attempts, active writer leases or pending
repository imports. File-backed rows are upserted in foreign-key order. Existing
run/attempt status and lease fields are preserved; file values are used for
those fields only when the corresponding projection row is missing.

If a fresh database is being recovered from files that captured running work,
the latest interrupted attempt is re-queued without a worker or lease. Older
interrupted attempts are marked failed in the projection. Lease tokens cannot be
recovered because they are intentionally never written to workspace files.

## Deliberate limits

- Replay is additive. Database-only rows are reported but are not automatically
  deleted.
- `user_auth_records`, `repository_imports`, `task_writer_leases` and
  `mob_schema_migrations` are operational control-plane state. Replay never
  deletes or rewrites them. Agent identities and connector profiles are restored
  from the file ledger.
- Restoring a connector profile row does not regenerate a missing
  `/data/agents/<actor-id>` provider home. Preserve the complete `/data` volume
  for a database-only recovery, or regenerate those secret-free provider files
  from the MobAI environment configuration before executing recovered Agents.
- On a completely empty database, collaboration history is restored, but an
  administrator must separately restore account authentication before people
  can log in.
- Provider keys and the session-signing secret remain environment variables and
  are not part of the file ledger.

These constraints make the first recovery path safe for the single-server,
small-team deployment. Exact pruning or automatic replay must not be added until
operational state has its own backup and restore contract.
