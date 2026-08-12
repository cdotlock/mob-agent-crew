import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../../src/db/migrations.js";

describe("database migrations", () => {
  it("are ordered and cover the collaboration aggregate", () => {
    expect(MIGRATIONS.map(({ version }) => version)).toEqual([1]);
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

  it("enforces one writer lease per task", () => {
    const sql = MIGRATIONS[0]?.sql ?? "";
    expect(sql).toMatch(/task_id uuid PRIMARY KEY/);
    expect(sql).toContain("writer_fence");
  });
});
