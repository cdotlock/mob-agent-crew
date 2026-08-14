import { describe, expect, it } from "vitest";
import type { DatabaseClient } from "../../src/db/client.js";
import { CollaborationStore } from "../../src/db/store.js";
import type { LeaseClaim } from "../../src/domain/model.js";

const now = new Date("2026-08-14T00:00:00.000Z");

describe("conversation-first execution projection", () => {
  it("returns a successful scratch execution to open instead of review_ready", async () => {
    const queries: string[] = [];
    const claim: LeaseClaim = {
      attemptId: "11111111-1111-4111-8111-111111111111",
      runId: "22222222-2222-4222-8222-222222222222",
      taskId: "33333333-3333-4333-8333-333333333333",
      workspaceId: "44444444-4444-4444-8444-444444444444",
      agentActorId: "55555555-5555-4555-8555-555555555555",
      workerId: "worker-1",
      token: "66666666-6666-4666-8666-666666666666",
      fence: 1n,
      writerFence: null,
      expiresAt: new Date(now.getTime() + 60_000),
      writer: false,
      attemptNumber: 1,
    };
    const sql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?").replace(/\s+/gu, " ").trim();
      queries.push(query);
      if (query.startsWith("UPDATE run_attempts")) return [attemptRow(claim)];
      if (query.startsWith("DELETE FROM task_writer_leases")) return [];
      if (query.startsWith("UPDATE runs")) return [runRow(claim)];
      if (query.startsWith("UPDATE tasks")) return [];
      throw new Error(`Unexpected query: ${query}`);
    }) as unknown as DatabaseClient;
    Object.assign(sql, {
      begin: async <T>(callback: (transaction: DatabaseClient) => Promise<T>) => callback(sql),
    });

    await new CollaborationStore(sql).completeAttempt({ claim, status: "succeeded", now });

    expect(queries.find((query) => query.startsWith("UPDATE tasks"))).toContain(
      "WHEN is_execution AND repository_id IS NULL THEN 'open'",
    );
  });

  it("does not claim a queued follow-up until its predecessor is terminal", async () => {
    const queries: string[] = [];
    const sql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?").replace(/\s+/gu, " ").trim();
      queries.push(query);
      if (query.startsWith("SELECT a.id AS attempt_id")) return [];
      throw new Error(`Unexpected query: ${query}`);
    }) as unknown as DatabaseClient;
    Object.assign(sql, {
      begin: async <T>(callback: (transaction: DatabaseClient) => Promise<T>) => callback(sql),
    });

    expect(await new CollaborationStore(sql).claimNextRun("worker-1", 60_000, now)).toBeNull();
    expect(queries[0]).toContain("r.wait_for_run_id IS NULL");
    expect(queries[0]).toContain("predecessor.status IN ('succeeded', 'failed', 'cancelled')");
  });
});

function attemptRow(claim: LeaseClaim) {
  return {
    id: claim.attemptId,
    workspace_id: claim.workspaceId,
    task_id: claim.taskId,
    run_id: claim.runId,
    attempt_number: 1,
    status: "succeeded",
    worker_id: claim.workerId,
    lease_token: claim.token,
    fence: "1",
    writer_fence: null,
    lease_expires_at: null,
    started_at: now,
    completed_at: now,
    failure_code: null,
    failure_message: null,
    created_at: now,
    updated_at: now,
  };
}

function runRow(claim: LeaseClaim) {
  return {
    id: claim.runId,
    workspace_id: claim.workspaceId,
    task_id: claim.taskId,
    conversation_id: "77777777-7777-4777-8777-777777777777",
    trigger_message_id: null,
    wait_for_run_id: null,
    agent_actor_id: claim.agentActorId,
    requested_by_actor_id: "88888888-8888-4888-8888-888888888888",
    delegation_id: null,
    status: "succeeded",
    priority: 0,
    writer_required: false,
    latest_attempt_number: 1,
    created_at: now,
    updated_at: now,
    completed_at: now,
  };
}
