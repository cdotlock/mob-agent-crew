import { describe, expect, it } from "vitest";
import { normalizeBootstrap, normalizeTaskDetail } from "../../web/src/api.js";
import type { TaskSummary } from "../../web/src/model.js";

const fallback: TaskSummary = {
  id: "task-1",
  title: "Test task",
  repository: "mob-agent-crew",
  branch: "main",
  status: "open",
  resolution: "unreviewed",
  updatedAt: "2026-08-13T00:00:00.000Z",
  unread: 0,
  participantIds: [],
  summary: "",
};

describe("task API normalization", () => {
  it("preserves the stable Agent handle used by @mentions", () => {
    const bootstrap = normalizeBootstrap({
      workspace: { id: "workspace-1", name: "Mob" },
      currentUser: { id: "human-1", name: "Clock" },
      agents: [{
        id: "agent-1",
        handle: "claude-smoke",
        name: "Claude Code",
        driver: "claude",
      }],
      tasks: [],
    });

    expect(bootstrap.agents[0]).toMatchObject({
      handle: "claude-smoke",
      name: "Claude Code",
    });
  });

  it("surfaces active tasks and live run and artifact metadata", () => {
    const detail = normalizeTaskDetail({
      id: "task-1",
      status: "active",
      runs: [{
        id: "run-1",
        agentId: "builder",
        status: "running",
        startedAt: "2026-08-13T00:01:00.000Z",
        summary: "Using a tool…",
      }],
      artifacts: [{
        id: "artifact-1",
        name: "snake.html",
        downloadUrl: "/api/artifacts/artifact-1/download",
      }],
    }, fallback);

    expect(detail.status).toBe("running");
    expect(detail.runs[0]).toMatchObject({
      status: "running",
      startedAt: "2026-08-13T00:01:00.000Z",
      summary: "Using a tool…",
    });
    expect(detail.artifacts[0]?.downloadUrl).toBe("/api/artifacts/artifact-1/download");
  });
});
