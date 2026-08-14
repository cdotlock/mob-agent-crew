import type postgres from "postgres";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "collaboration_core",
    sql: String.raw`
CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (
    length(slug) <= 48 AND slug ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
  ),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE actors (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('human', 'agent')),
  handle text NOT NULL CHECK (
    length(handle) <= 48 AND handle ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
  ),
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, handle),
  UNIQUE (workspace_id, id)
);

CREATE TABLE user_auth_records (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  provider text NOT NULL CHECK (length(btrim(provider)) > 0),
  subject text NOT NULL CHECK (length(btrim(subject)) > 0),
  email text,
  password_hash text,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES actors(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (provider, subject),
  UNIQUE (workspace_id, id)
);

CREATE TABLE agent_profiles (
  actor_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_actor_id uuid NOT NULL,
  driver text NOT NULL CHECK (length(btrim(driver)) > 0),
  home text NOT NULL CHECK (length(btrim(home)) > 0),
  role text NOT NULL DEFAULT '',
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  max_concurrent_runs integer NOT NULL DEFAULT 1 CHECK (max_concurrent_runs BETWEEN 1 AND 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES actors(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, owner_actor_id) REFERENCES actors(workspace_id, id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, actor_id)
);

CREATE TABLE workspace_documents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  content text,
  local_path text,
  source text NOT NULL CHECK (length(btrim(source)) > 0),
  uploaded_by_actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, uploaded_by_actor_id) REFERENCES actors(workspace_id, id) ON DELETE RESTRICT,
  CHECK (coalesce(length(content), 0) > 0 OR coalesce(length(btrim(local_path)), 0) > 0),
  UNIQUE (workspace_id, id)
);

CREATE TABLE repositories (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  kind text NOT NULL CHECK (kind IN ('git', 'local')),
  remote_url text,
  local_path text,
  default_branch text NOT NULL DEFAULT 'main',
  allowlisted boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  created_by_actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, created_by_actor_id) REFERENCES actors(workspace_id, id) ON DELETE RESTRICT,
  CHECK ((kind = 'git' AND remote_url IS NOT NULL) OR (kind = 'local' AND local_path IS NOT NULL)),
  UNIQUE (workspace_id, id)
);
CREATE UNIQUE INDEX repositories_workspace_remote_url_idx
  ON repositories (workspace_id, remote_url) WHERE remote_url IS NOT NULL;
CREATE UNIQUE INDEX repositories_workspace_local_path_idx
  ON repositories (workspace_id, local_path) WHERE local_path IS NOT NULL;

CREATE TABLE repository_imports (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_url text NOT NULL CHECK (source_url ~ '^https://github\.com/[^/]+/[^/]+\.git$'),
  requested_by_actor_id uuid NOT NULL,
  repository_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'imported', 'rejected', 'failed')),
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (workspace_id, requested_by_actor_id) REFERENCES actors(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, repository_id) REFERENCES repositories(workspace_id, id)
    ON DELETE SET NULL (repository_id),
  UNIQUE (workspace_id, id)
);
CREATE UNIQUE INDEX repository_imports_pending_url_idx
  ON repository_imports (workspace_id, source_url) WHERE status = 'pending';

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL,
  created_by_actor_id uuid NOT NULL,
  assigned_actor_id uuid,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  description text NOT NULL DEFAULT '',
  base_revision text NOT NULL CHECK (length(btrim(base_revision)) > 0),
  branch_name text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'active', 'review_ready', 'completed', 'cancelled')),
  max_delegation_depth integer NOT NULL DEFAULT 2 CHECK (max_delegation_depth BETWEEN 0 AND 8),
  run_budget integer NOT NULL DEFAULT 8 CHECK (run_budget BETWEEN 1 AND 100),
  writer_fence bigint NOT NULL DEFAULT 0 CHECK (writer_fence >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, repository_id) REFERENCES repositories(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_actor_id) REFERENCES actors(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, assigned_actor_id) REFERENCES actors(workspace_id, id)
    ON DELETE SET NULL (assigned_actor_id),
  UNIQUE (workspace_id, id)
);

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  source_run_id uuid,
  kind text NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment', 'progress', 'result', 'system')),
  body text NOT NULL CHECK (length(btrim(body)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, actor_id) REFERENCES actors(workspace_id, id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, id)
);

CREATE TABLE message_mentions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, actor_id),
  FOREIGN KEY (workspace_id, message_id) REFERENCES messages(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, actor_id) REFERENCES actors(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE delegations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  from_actor_id uuid NOT NULL,
  to_agent_actor_id uuid NOT NULL,
  source_run_id uuid,
  parent_delegation_id uuid,
  intent text NOT NULL CHECK (length(btrim(intent)) > 0),
  deliverable text NOT NULL CHECK (length(btrim(deliverable)) > 0),
  depth integer NOT NULL CHECK (depth BETWEEN 1 AND 8),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'accepted', 'completed', 'rejected', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, from_actor_id) REFERENCES actors(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, to_agent_actor_id) REFERENCES actors(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, parent_delegation_id) REFERENCES delegations(workspace_id, id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, id)
);

CREATE TABLE runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  agent_actor_id uuid NOT NULL,
  requested_by_actor_id uuid NOT NULL,
  delegation_id uuid,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN -1000 AND 1000),
  writer_required boolean NOT NULL DEFAULT true,
  latest_attempt_number integer NOT NULL DEFAULT 1 CHECK (latest_attempt_number >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_actor_id) REFERENCES actors(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, requested_by_actor_id) REFERENCES actors(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, delegation_id) REFERENCES delegations(workspace_id, id)
    ON DELETE SET NULL (delegation_id),
  UNIQUE (workspace_id, id)
);
ALTER TABLE messages ADD CONSTRAINT messages_source_run_fk
  FOREIGN KEY (workspace_id, source_run_id) REFERENCES runs(workspace_id, id)
    ON DELETE SET NULL (source_run_id);
ALTER TABLE delegations ADD CONSTRAINT delegations_source_run_fk
  FOREIGN KEY (workspace_id, source_run_id) REFERENCES runs(workspace_id, id)
    ON DELETE SET NULL (source_run_id);

CREATE TABLE run_attempts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number >= 1),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'claimed', 'running', 'succeeded', 'failed', 'cancelled')),
  worker_id text,
  lease_token uuid,
  fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
  writer_fence bigint CHECK (writer_fence IS NULL OR writer_fence > 0),
  lease_expires_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (run_id, attempt_number),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, task_id, id)
);

CREATE TABLE task_writer_leases (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL UNIQUE,
  lease_token uuid NOT NULL,
  writer_fence bigint NOT NULL CHECK (writer_fence > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, task_id, attempt_id) REFERENCES run_attempts(workspace_id, task_id, id) ON DELETE CASCADE
);

CREATE TABLE run_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  type text NOT NULL CHECK (length(btrim(type)) > 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, attempt_id) REFERENCES run_attempts(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (attempt_id, sequence),
  UNIQUE (workspace_id, id)
);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  source_run_id uuid,
  source_attempt_id uuid,
  kind text NOT NULL CHECK (kind IN ('file', 'patch', 'commit', 'test_report', 'log', 'summary')),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  uri text NOT NULL CHECK (length(btrim(uri)) > 0),
  media_type text,
  byte_size bigint CHECK (byte_size IS NULL OR byte_size >= 0),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, actor_id) REFERENCES actors(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, source_run_id) REFERENCES runs(workspace_id, id)
    ON DELETE SET NULL (source_run_id),
  FOREIGN KEY (workspace_id, source_attempt_id) REFERENCES run_attempts(workspace_id, id)
    ON DELETE SET NULL (source_attempt_id),
  UNIQUE (workspace_id, id)
);

CREATE TABLE approvals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  requested_by_actor_id uuid NOT NULL,
  decided_by_actor_id uuid,
  kind text NOT NULL CHECK (kind IN ('publish_branch', 'create_change_request', 'merge_change_request')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, requested_by_actor_id) REFERENCES actors(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, decided_by_actor_id) REFERENCES actors(workspace_id, id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, id)
);

CREATE INDEX tasks_workspace_status_idx ON tasks (workspace_id, status, updated_at DESC);
CREATE INDEX messages_task_created_idx ON messages (task_id, created_at, id);
CREATE INDEX delegations_task_created_idx ON delegations (task_id, created_at, id);
CREATE INDEX runs_queue_idx ON runs (workspace_id, status, priority DESC, created_at);
CREATE INDEX attempts_claim_idx ON run_attempts (workspace_id, status, lease_expires_at, created_at);
CREATE INDEX events_run_sequence_idx ON run_events (run_id, sequence);
CREATE INDEX artifacts_task_created_idx ON artifacts (task_id, created_at, id);
CREATE INDEX approvals_task_status_idx ON approvals (task_id, status, created_at);

CREATE FUNCTION mob_assert_actor_roles() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject_kind text;
DECLARE owner_kind text;
BEGIN
  IF TG_TABLE_NAME = 'user_auth_records' THEN
    SELECT kind INTO subject_kind FROM actors WHERE id = NEW.actor_id AND workspace_id = NEW.workspace_id;
    IF subject_kind <> 'human' THEN RAISE EXCEPTION 'user auth record requires a human actor'; END IF;
  ELSIF TG_TABLE_NAME = 'agent_profiles' THEN
    SELECT kind INTO subject_kind FROM actors WHERE id = NEW.actor_id AND workspace_id = NEW.workspace_id;
    SELECT kind INTO owner_kind FROM actors WHERE id = NEW.owner_actor_id AND workspace_id = NEW.workspace_id;
    IF subject_kind <> 'agent' OR owner_kind <> 'human' THEN
      RAISE EXCEPTION 'agent profile requires an agent actor and human owner';
    END IF;
  ELSIF TG_TABLE_NAME = 'delegations' THEN
    SELECT kind INTO subject_kind FROM actors WHERE id = NEW.to_agent_actor_id AND workspace_id = NEW.workspace_id;
    IF subject_kind <> 'agent' THEN RAISE EXCEPTION 'delegation recipient must be an agent'; END IF;
  ELSIF TG_TABLE_NAME = 'approvals' AND NEW.decided_by_actor_id IS NOT NULL THEN
    SELECT kind INTO subject_kind FROM actors WHERE id = NEW.decided_by_actor_id AND workspace_id = NEW.workspace_id;
    IF subject_kind <> 'human' THEN RAISE EXCEPTION 'approval decision requires a human actor'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_auth_actor_role BEFORE INSERT OR UPDATE ON user_auth_records
  FOR EACH ROW EXECUTE FUNCTION mob_assert_actor_roles();
CREATE TRIGGER agent_profile_actor_roles BEFORE INSERT OR UPDATE ON agent_profiles
  FOR EACH ROW EXECUTE FUNCTION mob_assert_actor_roles();
CREATE TRIGGER delegation_agent_role BEFORE INSERT OR UPDATE ON delegations
  FOR EACH ROW EXECUTE FUNCTION mob_assert_actor_roles();
CREATE TRIGGER approval_human_role BEFORE INSERT OR UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION mob_assert_actor_roles();
`,
  },
  {
    version: 2,
    name: "lightweight_conversations",
    sql: String.raw`
CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('direct', 'group')),
  title text CHECK (title IS NULL OR length(btrim(title)) > 0),
  created_by_actor_id uuid NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, created_by_actor_id) REFERENCES actors(workspace_id, id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, id),
  CHECK (NOT is_primary OR kind = 'group')
);
CREATE UNIQUE INDEX conversations_task_primary_idx
  ON conversations (task_id) WHERE is_primary;
CREATE INDEX conversations_workspace_updated_idx
  ON conversations (workspace_id, updated_at DESC, id DESC);

CREATE TABLE conversation_memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, actor_id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, actor_id) REFERENCES actors(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX conversation_memberships_actor_idx
  ON conversation_memberships (workspace_id, actor_id, joined_at DESC);

-- A task's primary conversation deliberately reuses the task UUID. This gives
-- legacy task threads a deterministic projection without adding another lookup.
INSERT INTO conversations (
  id, workspace_id, task_id, kind, title, created_by_actor_id, is_primary,
  created_at, updated_at
)
SELECT
  id, workspace_id, id, 'group', title, created_by_actor_id, true,
  created_at, updated_at
FROM tasks;

INSERT INTO conversation_memberships (workspace_id, conversation_id, actor_id, joined_at)
SELECT participants.workspace_id, participants.task_id, participants.actor_id, min(participants.joined_at)
FROM (
  SELECT workspace_id, id AS task_id, created_by_actor_id AS actor_id, created_at AS joined_at FROM tasks
  UNION ALL
  SELECT workspace_id, id, assigned_actor_id, created_at FROM tasks WHERE assigned_actor_id IS NOT NULL
  UNION ALL
  SELECT workspace_id, task_id, actor_id, created_at FROM messages
  UNION ALL
  SELECT mm.workspace_id, m.task_id, mm.actor_id, mm.created_at
    FROM message_mentions mm JOIN messages m ON m.id = mm.message_id
  UNION ALL
  SELECT workspace_id, task_id, agent_actor_id, created_at FROM runs
  UNION ALL
  SELECT workspace_id, task_id, requested_by_actor_id, created_at FROM runs
) AS participants
GROUP BY participants.workspace_id, participants.task_id, participants.actor_id;

ALTER TABLE messages ADD COLUMN conversation_id uuid;
UPDATE messages SET conversation_id = task_id;
ALTER TABLE messages ALTER COLUMN conversation_id SET NOT NULL;
ALTER TABLE messages ADD CONSTRAINT messages_conversation_fk
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE CASCADE;
CREATE INDEX messages_conversation_created_idx
  ON messages (conversation_id, created_at, id);

ALTER TABLE runs ADD COLUMN conversation_id uuid;
UPDATE runs SET conversation_id = task_id;
ALTER TABLE runs ALTER COLUMN conversation_id SET NOT NULL;
ALTER TABLE runs ADD CONSTRAINT runs_conversation_fk
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE runs ADD COLUMN trigger_message_id uuid;
UPDATE runs r
SET trigger_message_id = (
  SELECT m.id
  FROM messages m
  WHERE m.task_id = r.task_id AND m.created_at <= r.created_at
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT 1
);
ALTER TABLE runs ADD CONSTRAINT runs_trigger_message_fk
  FOREIGN KEY (workspace_id, trigger_message_id) REFERENCES messages(workspace_id, id)
    ON DELETE SET NULL (trigger_message_id);
CREATE INDEX runs_conversation_created_idx
  ON runs (conversation_id, created_at, id);

-- Keep v1 INSERT statements valid during a one-process Railway rollout and a
-- rollback. Old binaries do not know the new conversation columns, so the
-- database supplies the task's deterministic primary conversation.
CREATE FUNCTION mob_create_primary_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO conversations (
    id, workspace_id, task_id, kind, title, created_by_actor_id, is_primary,
    created_at, updated_at
  ) VALUES (
    NEW.id, NEW.workspace_id, NEW.id, 'group', NEW.title,
    NEW.created_by_actor_id, true, NEW.created_at, NEW.updated_at
  ) ON CONFLICT (id) DO NOTHING;
  INSERT INTO conversation_memberships (workspace_id, conversation_id, actor_id, joined_at)
  VALUES (NEW.workspace_id, NEW.id, NEW.created_by_actor_id, NEW.created_at)
  ON CONFLICT DO NOTHING;
  IF NEW.assigned_actor_id IS NOT NULL THEN
    INSERT INTO conversation_memberships (workspace_id, conversation_id, actor_id, joined_at)
    VALUES (NEW.workspace_id, NEW.id, NEW.assigned_actor_id, NEW.created_at)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER task_primary_conversation
  AFTER INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION mob_create_primary_conversation();

CREATE FUNCTION mob_default_conversation_columns() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.conversation_id IS NULL THEN NEW.conversation_id := NEW.task_id; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER message_default_conversation
  BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION mob_default_conversation_columns();
CREATE TRIGGER run_default_conversation
  BEFORE INSERT ON runs FOR EACH ROW EXECUTE FUNCTION mob_default_conversation_columns();

CREATE FUNCTION mob_join_primary_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.conversation_id = NEW.task_id THEN
    INSERT INTO conversation_memberships (workspace_id, conversation_id, actor_id)
    VALUES (NEW.workspace_id, NEW.conversation_id, NEW.actor_id)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER message_join_primary_conversation
  AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION mob_join_primary_conversation();

CREATE FUNCTION mob_join_primary_run_actors() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.conversation_id = NEW.task_id THEN
    INSERT INTO conversation_memberships (workspace_id, conversation_id, actor_id)
    VALUES
      (NEW.workspace_id, NEW.conversation_id, NEW.agent_actor_id),
      (NEW.workspace_id, NEW.conversation_id, NEW.requested_by_actor_id)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER run_join_primary_conversation
  AFTER INSERT ON runs FOR EACH ROW EXECUTE FUNCTION mob_join_primary_run_actors();
`,
  },
  {
    version: 3,
    name: "agent_composition_metadata",
    sql: String.raw`
ALTER TABLE agent_profiles
  ADD COLUMN model_id text,
  ADD COLUMN skill_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN environment jsonb NOT NULL DEFAULT '{"reference":null,"values":{}}'::jsonb;

ALTER TABLE agent_profiles
  ADD CONSTRAINT agent_profiles_model_id_shape CHECK (
    model_id IS NULL OR (
      length(model_id) BETWEEN 1 AND 128
      AND model_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]*$'
    )
  ),
  ADD CONSTRAINT agent_profiles_skill_refs_array CHECK (jsonb_typeof(skill_refs) = 'array'),
  ADD CONSTRAINT agent_profiles_environment_object CHECK (jsonb_typeof(environment) = 'object');
`,
  },
] as const;

export type MigrationClient = Pick<postgres.Sql, "unsafe" | "begin">;

export async function migrateDatabase(sql: postgres.Sql): Promise<void> {
  await sql.begin(async (tx) => {
    // Serializes boot-time migrations across Railway control-plane replicas.
    await tx`SELECT pg_advisory_xact_lock(514509012320260813)`;
    await tx.unsafe(
      `CREATE TABLE IF NOT EXISTS mob_schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`,
    );

    const applied = await tx<{ version: number }[]>`SELECT version FROM mob_schema_migrations`;
    const appliedVersions = new Set(applied.map((row) => row.version));

    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) continue;
      await tx.unsafe(migration.sql, [], { prepare: false });
      await tx`
        INSERT INTO mob_schema_migrations (version, name)
        VALUES (${migration.version}, ${migration.name})
      `;
    }
  });
}
