import { describe, expect, it } from "vitest";
import type { DatabaseClient } from "../../src/db/client.js";
import { CollaborationStore } from "../../src/db/store.js";
import type { RunStatus } from "../../src/domain/model.js";

const now = new Date("2026-08-13T00:00:00.000Z");
const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const actorId = "55555555-5555-4555-8555-555555555555";

describe("run cancellation", () => {
  for (const status of ["succeeded", "failed", "cancelled"] satisfies RunStatus[]) {
    it(`returns an already ${status} run without rewriting its terminal state`, async () => {
      const database = fakeDatabase(status);
      const store = new CollaborationStore(database.sql);

      const run = await store.cancelRun({ runId, requestedByActorId: actorId });

      expect(run.status).toBe(status);
      expect(database.queries.some((query) => query.startsWith("UPDATE runs"))).toBe(false);
      expect(database.queries.some((query) => query.startsWith("UPDATE run_attempts"))).toBe(false);
    });
  }

  for (const status of ["queued", "running"] satisfies RunStatus[]) {
    it(`cancels an active ${status} run`, async () => {
      const database = fakeDatabase(status);
      const store = new CollaborationStore(database.sql);

      const run = await store.cancelRun({ runId, requestedByActorId: actorId });

      expect(run.status).toBe("cancelled");
      expect(database.queries.some((query) => query.startsWith("UPDATE runs"))).toBe(true);
      expect(database.queries.some((query) => query.startsWith("UPDATE run_attempts"))).toBe(true);
    });
  }
});

function fakeDatabase(status: RunStatus): { sql: DatabaseClient; queries: string[] } {
  const queries: string[] = [];
  const runRow = {
    id: runId,
    workspace_id: workspaceId,
    task_id: taskId,
    conversation_id: conversationId,
    trigger_message_id: null,
    agent_actor_id: "66666666-6666-4666-8666-666666666666",
    requested_by_actor_id: actorId,
    delegation_id: null,
    status,
    priority: 0,
    writer_required: true,
    latest_attempt_number: 1,
    created_at: now,
    updated_at: now,
    completed_at: ["succeeded", "failed", "cancelled"].includes(status) ? now : null,
  };
  const actorRow = {
    id: actorId,
    workspace_id: workspaceId,
    kind: "human",
    handle: "clock",
    display_name: "Clock",
    status: "active",
    created_at: now,
    updated_at: now,
  };
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join("?").replace(/\s+/gu, " ").trim();
    queries.push(query);
    if (query.startsWith("SELECT * FROM runs")) return [runRow];
    if (query.startsWith("SELECT * FROM actors")) return [actorRow];
    if (query.startsWith("UPDATE runs")) return [{ ...runRow, status: "cancelled", completed_at: now }];
    if (
      query.startsWith("UPDATE run_attempts") ||
      query.startsWith("DELETE FROM task_writer_leases") ||
      query.startsWith("UPDATE tasks")
    ) return [];
    throw new Error(`Unexpected cancel-run query: ${query}`);
  }) as unknown as DatabaseClient;
  Object.assign(sql, {
    begin: async <T>(callback: (transaction: DatabaseClient) => Promise<T>) => callback(sql),
  });
  return { sql, queries };
}
