import { describe, expect, it } from "vitest";
import { taskRepositoryContext } from "../../src/worker/repository-context.js";

describe("task repository runtime context", () => {
  it("treats an explicit null repository as a valid scratch conversation", () => {
    expect(taskRepositoryContext({
      repositoryId: null,
      name: null,
      remoteUrl: null,
      baseRevision: null,
      allowlisted: null,
      enabled: null,
    })).toEqual({ kind: "scratch" });
  });

  it("projects an enabled allowlisted repository into Git runtime context", () => {
    expect(taskRepositoryContext({
      repositoryId: "repository-1",
      name: " mob-agent-crew ",
      remoteUrl: " https://github.com/cdotlock/mob-agent-crew.git ",
      baseRevision: " main ",
      allowlisted: true,
      enabled: true,
    })).toEqual({
      kind: "git",
      repositoryId: "repository-1",
      name: "mob-agent-crew",
      remoteUrl: "https://github.com/cdotlock/mob-agent-crew.git",
      baseRevision: "main",
    });
  });

  it("keeps the existing trust gate when a repository is selected", () => {
    expect(() => taskRepositoryContext({
      repositoryId: "repository-1",
      name: "disabled",
      remoteUrl: "https://github.com/example/disabled.git",
      baseRevision: "main",
      allowlisted: false,
      enabled: true,
    })).toThrow("enabled allowlisted Git remote");
  });
});
