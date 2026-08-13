import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../../src/db/migrations.js";

describe("database migrations", () => {
  it("are ordered and cover the collaboration aggregate", () => {
    expect(MIGRATIONS.map(({ version }) => version)).toEqual([1, 2]);
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
});
