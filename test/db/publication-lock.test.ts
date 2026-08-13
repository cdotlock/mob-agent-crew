import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../../src/db/client.js";
import { CollaborationStore } from "../../src/db/store.js";

const now = new Date("2026-08-13T00:00:00.000Z");
const taskRow = {
  id: "11111111-1111-4111-8111-111111111111",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  repository_id: "33333333-3333-4333-8333-333333333333",
  created_by_actor_id: "44444444-4444-4444-8444-444444444444",
  assigned_actor_id: null,
  title: "Reviewed task",
  description: "",
  base_revision: "main",
  branch_name: null,
  status: "completed",
  max_delegation_depth: 2,
  run_budget: 8,
  writer_fence: "1",
  created_at: now,
  updated_at: now,
};
const actorRow = {
  id: taskRow.created_by_actor_id,
  workspace_id: taskRow.workspace_id,
  kind: "human",
  handle: "clock",
  display_name: "Clock",
  status: "active",
  created_at: now,
  updated_at: now,
};
const repositoryRow = {
  id: taskRow.repository_id,
  workspace_id: taskRow.workspace_id,
  name: "repository",
  kind: "git",
  remote_url: "https://github.com/example/repository",
  local_path: null,
  default_branch: "main",
  allowlisted: true,
  enabled: true,
  created_by_actor_id: actorRow.id,
  created_at: now,
  updated_at: now,
};

describe("task publication lock", () => {
  it("holds the task gate through an idle, human-approved publication", async () => {
    const store = new CollaborationStore(fakeDatabase());
    const publish = vi.fn(async () => ({ commit: "a".repeat(40) }));

    const result = await store.withTaskPublicationLock({
      taskId: taskRow.id,
      approvedByActorId: actorRow.id,
      branchName: "mob/11111111",
    }, publish);

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ status: "completed" }),
      repository: expect.objectContaining({ allowlisted: true }),
    }));
    expect(result.task.branchName).toBe("mob/11111111");
    expect(result.result.commit).toBe("a".repeat(40));
  });

  it("never calls SCM publication for an Agent approver", async () => {
    const store = new CollaborationStore(fakeDatabase({ actorKind: "agent" }));
    const publish = vi.fn(async () => ({ commit: "a".repeat(40) }));

    await expect(store.withTaskPublicationLock({
      taskId: taskRow.id,
      approvedByActorId: actorRow.id,
      branchName: "mob/11111111",
    }, publish)).rejects.toThrow("Only a human actor may approve publication");
    expect(publish).not.toHaveBeenCalled();
  });

  it("never calls SCM publication while a run or writer lease is active", async () => {
    const store = new CollaborationStore(fakeDatabase({ activeRuns: 1, writerLeases: 1 }));
    const publish = vi.fn(async () => ({ commit: "a".repeat(40) }));

    await expect(store.withTaskPublicationLock({
      taskId: taskRow.id,
      approvedByActorId: actorRow.id,
      branchName: "mob/11111111",
    }, publish)).rejects.toThrow("Finish or cancel active Agent runs");
    expect(publish).not.toHaveBeenCalled();
  });
});

function fakeDatabase(options: {
  actorKind?: "human" | "agent";
  activeRuns?: number;
  writerLeases?: number;
} = {}): DatabaseClient {
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?").replace(/\s+/gu, " ").trim();
    if (query.includes("SELECT * FROM tasks WHERE id")) return [taskRow];
    if (query.includes("SELECT * FROM actors")) return [{ ...actorRow, kind: options.actorKind ?? "human" }];
    if (query.includes("SELECT * FROM repositories")) return [repositoryRow];
    if (query.includes("AS active_runs")) {
      return [{
        active_runs: String(options.activeRuns ?? 0),
        writer_leases: String(options.writerLeases ?? 0),
      }];
    }
    if (query.includes("UPDATE tasks") && query.includes("branch_name")) {
      return [{ ...taskRow, branch_name: values[0] }];
    }
    throw new Error(`Unexpected publication-lock query: ${query}`);
  }) as unknown as DatabaseClient;
  Object.assign(sql, {
    begin: async <T>(callback: (transaction: DatabaseClient) => Promise<T>) => callback(sql),
  });
  return sql;
}
