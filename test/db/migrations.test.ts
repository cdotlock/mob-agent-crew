import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../../src/db/migrations.js";

describe("database migrations", () => {
  it("are ordered and cover the collaboration aggregate", () => {
    expect(MIGRATIONS.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5]);
    const sql = MIGRATIONS[0]?.sql ?? "";
    for (const table of [
      "workspaces",
      "actors",
      "user_auth_records",
      "agent_profiles",
      "workspace_documents",
      "repositories",
      "repository_imports",
      "tasks",
      "messages",
      "delegations",
      "runs",
      "run_attempts",
      "run_events",
      "artifacts",
      "approvals",
      "task_writer_leases",
    ]) {
      expect(sql).toContain(`CREATE TABLE ${table}`);
    }
  });

  it("adds direct and group conversations without replacing task threads", () => {
    const sql = MIGRATIONS[1]?.sql ?? "";
    expect(sql).toContain("CREATE TABLE conversations");
    expect(sql).toContain("CREATE TABLE conversation_memberships");
    expect(sql).toContain("kind IN ('direct', 'group')");
    expect(sql).toContain("SELECT\n  id, workspace_id, id, 'group'");
    expect(sql).toContain("UPDATE messages SET conversation_id = task_id");
    expect(sql).toContain("ALTER TABLE runs ADD COLUMN trigger_message_id uuid");
    expect(sql).toContain("CREATE TRIGGER task_primary_conversation");
    expect(sql).toContain("CREATE TRIGGER message_default_conversation");
    expect(sql).toContain("CREATE TRIGGER run_default_conversation");
  });

  it("enforces one writer lease per task", () => {
    const sql = MIGRATIONS[0]?.sql ?? "";
    expect(sql).toMatch(/task_id uuid PRIMARY KEY/);
    expect(sql).toContain("writer_fence");
  });

  it("adds secret-free Agent composition metadata without replacing the harness driver", () => {
    const sql = MIGRATIONS[2]?.sql ?? "";
    expect(sql).toContain("ADD COLUMN model_id text");
    expect(sql).toContain("ADD COLUMN skill_refs jsonb NOT NULL DEFAULT '[]'::jsonb");
    expect(sql).toContain("ADD COLUMN environment jsonb NOT NULL");
    expect(sql).toContain("jsonb_typeof(skill_refs) = 'array'");
    expect(sql).not.toContain("DROP COLUMN driver");
  });

  it("adds shared plugin references without replacing harness ownership", () => {
    const sql = MIGRATIONS[3]?.sql ?? "";
    expect(sql).toContain("ADD COLUMN plugin_refs jsonb NOT NULL DEFAULT '[]'::jsonb");
    expect(sql).toContain("jsonb_typeof(plugin_refs) = 'array'");
    expect(sql).not.toContain("DROP COLUMN driver");
  });

  it("makes chat workspace-first and keeps Tasks as hidden execution contexts", () => {
    const sql = MIGRATIONS[4]?.sql ?? "";
    expect(sql).toContain("ALTER COLUMN task_id DROP NOT NULL");
    expect(sql).toContain("ALTER COLUMN repository_id DROP NOT NULL");
    expect(sql).toContain("ADD COLUMN active_repository_id uuid");
    expect(sql).toContain("ADD COLUMN execution_conversation_id uuid");
    expect(sql).toContain("ADD COLUMN is_execution boolean");
    expect(sql).toContain("ADD COLUMN wait_for_run_id uuid");
    expect(sql).toContain("IF NEW.is_execution THEN RETURN NEW");
  });
});
