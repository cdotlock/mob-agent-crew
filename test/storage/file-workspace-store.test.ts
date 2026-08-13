import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  Actor,
  Approval,
  Artifact,
  Delegation,
  Message,
  Repository,
  Run,
  RunAttempt,
  RunEvent,
  Task,
  TaskThread,
  Workspace,
  WorkspaceDocument,
} from "../../src/domain/model.js";
import { FileWorkspaceStore } from "../../src/storage/index.js";

const createdDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(createdDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createStore(): Promise<{ dataDir: string; store: FileWorkspaceStore }> {
  const dataDir = await mkdtemp(join(tmpdir(), "mob-file-store-"));
  createdDirectories.push(dataDir);
  return { dataDir, store: new FileWorkspaceStore({ dataDir }) };
}

const at = new Date("2026-08-13T08:09:10.123Z");
const later = new Date("2026-08-13T08:10:11.456Z");

const workspace: Workspace = {
  id: "workspace-1",
  slug: "crew",
  name: "Mob Crew",
  createdAt: at,
  updatedAt: later,
};

const actor: Actor = {
  id: "actor-1",
  workspaceId: workspace.id,
  kind: "agent",
  handle: "builder",
  displayName: "Builder",
  status: "active",
  createdAt: at,
  updatedAt: later,
};

const repository: Repository = {
  id: "repository-1",
  workspaceId: workspace.id,
  name: "crew",
  kind: "git",
  remoteUrl: "https://github.com/example/crew",
  localPath: null,
  defaultBranch: "main",
  allowlisted: true,
  enabled: true,
  createdByActorId: actor.id,
  createdAt: at,
  updatedAt: later,
};

const task: Task = {
  id: "task-1",
  workspaceId: workspace.id,
  repositoryId: repository.id,
  createdByActorId: actor.id,
  assignedActorId: actor.id,
  title: "Build a page",
  description: "Make it useful.",
  baseRevision: "abc1234",
  branchName: "mob/task-1",
  status: "active",
  maxDelegationDepth: 2,
  runBudget: 5,
  writerFence: 7n,
  createdAt: at,
  updatedAt: later,
};

const message: Message = {
  id: "message-1",
  workspaceId: workspace.id,
  taskId: task.id,
  actorId: actor.id,
  sourceRunId: null,
  kind: "comment",
  body: "Please build it.\n\n- Keep it small\n- Ship the file",
  mentions: [actor.id],
  createdAt: at,
};

const delegation: Delegation = {
  id: "delegation-1",
  workspaceId: workspace.id,
  taskId: task.id,
  fromActorId: actor.id,
  toAgentActorId: actor.id,
  sourceRunId: null,
  parentDelegationId: null,
  intent: "Implement",
  deliverable: "A page",
  depth: 0,
  status: "accepted",
  createdAt: at,
  updatedAt: later,
  completedAt: null,
};

const run: Run = {
  id: "run-1",
  workspaceId: workspace.id,
  taskId: task.id,
  agentActorId: actor.id,
  requestedByActorId: actor.id,
  delegationId: delegation.id,
  status: "running",
  priority: 1,
  writerRequired: true,
  latestAttemptNumber: 1,
  createdAt: at,
  updatedAt: later,
  completedAt: null,
};

const attempt: RunAttempt = {
  id: "attempt-1",
  workspaceId: workspace.id,
  taskId: task.id,
  runId: run.id,
  attemptNumber: 1,
  status: "running",
  workerId: "worker-1",
  leaseToken: "lease-secret",
  fence: 8n,
  writerFence: 7n,
  leaseExpiresAt: later,
  startedAt: at,
  completedAt: null,
  failureCode: null,
  failureMessage: null,
  createdAt: at,
  updatedAt: later,
};

const event: RunEvent = {
  id: "event-1",
  workspaceId: workspace.id,
  taskId: task.id,
  runId: run.id,
  attemptId: attempt.id,
  sequence: 3,
  type: "tool.completed",
  payload: { zeta: 1, alpha: { two: true, one: false } },
  createdAt: later,
};

const artifact: Artifact = {
  id: "artifact-1",
  workspaceId: workspace.id,
  taskId: task.id,
  actorId: actor.id,
  sourceRunId: run.id,
  sourceAttemptId: attempt.id,
  kind: "file",
  name: "index.html",
  uri: "file:/data/artifacts/index.html",
  mediaType: "text/html",
  byteSize: 1234n,
  sha256: "abc",
  metadata: { revision: "abc1234" },
  createdAt: later,
};

const approval: Approval = {
  id: "approval-1",
  workspaceId: workspace.id,
  taskId: task.id,
  requestedByActorId: actor.id,
  decidedByActorId: null,
  kind: "publish_branch",
  status: "pending",
  payload: { branch: "mob/task-1" },
  decisionNote: null,
  createdAt: later,
  decidedAt: null,
};

const document: WorkspaceDocument = {
  id: "document-1",
  workspaceId: workspace.id,
  name: "Guide.md",
  content: "# Guide\n",
  localPath: null,
  source: "upload",
  uploadedByActorId: actor.id,
  createdAt: at,
  updatedAt: later,
};

const thread: TaskThread = {
  task,
  messages: [message],
  delegations: [delegation],
  runs: [run],
  attempts: [attempt],
  events: [event],
  artifacts: [artifact],
  approvals: [approval],
};

describe("FileWorkspaceStore", () => {
  it("writes every state kind to a deterministic layout and reads it back", async () => {
    const { dataDir, store } = await createStore();

    await store.writeWorkspace(workspace);
    await store.writeActor(actor);
    await store.writeRepository(repository);
    await store.writeDocument(document);
    const result = await store.exportTaskThread(thread);

    expect(result.written).toBe(8);
    const root = join(dataDir, "state", "workspaces", workspace.id);
    await expect(readFile(join(root, "workspace.json"), "utf8")).resolves.toContain(
      '"entity": "workspace"',
    );
    await expect(readFile(join(root, "actors", `${actor.id}.json`), "utf8")).resolves.toContain(
      '"displayName": "Builder"',
    );
    await expect(
      readFile(join(root, "repositories", `${repository.id}.json`), "utf8"),
    ).resolves.toContain('"defaultBranch": "main"');
    await expect(
      readFile(join(root, "documents", `${document.id}.json`), "utf8"),
    ).resolves.toContain('"content": "# Guide\\n"');

    const taskRoot = join(root, "tasks", task.id);
    expect(await readdir(taskRoot)).toEqual([
      "approvals",
      "artifacts",
      "delegations",
      "messages",
      "runs",
      "task.json",
    ]);
    await expect(
      readFile(join(taskRoot, "runs", run.id, "attempts", "000001-attempt-1.json"), "utf8"),
    ).resolves.toContain('"writerFence": "7"');
    await expect(
      readFile(join(taskRoot, "runs", run.id, "events", "000000000003-event-1.json"), "utf8"),
    ).resolves.toContain('"alpha"');

    expect(await store.readWorkspace(workspace.id)).toEqual(workspace);
    expect(await store.readActor(workspace.id, actor.id)).toEqual(actor);
    expect(await store.readRepository(workspace.id, repository.id)).toEqual(repository);
    expect(await store.readDocument(workspace.id, document.id)).toEqual(document);
    expect(await store.readTask(workspace.id, task.id)).toEqual(task);
    expect(await store.readMessage(workspace.id, task.id, message.id)).toEqual(message);
    expect(await store.readRun(workspace.id, task.id, run.id)).toEqual(run);
    expect(await store.readAttempt(workspace.id, task.id, run.id, attempt.id)).toEqual({
      ...attempt,
      leaseToken: null,
    });
    expect(await store.readEvent(workspace.id, task.id, run.id, event.id)).toEqual(event);
    expect(await store.readDelegation(workspace.id, task.id, delegation.id)).toEqual(delegation);
    expect(await store.readArtifact(workspace.id, task.id, artifact.id)).toEqual(artifact);
    expect(await store.readApproval(workspace.id, task.id, approval.id)).toEqual(approval);
    expect(await store.readTaskThread(workspace.id, task.id)).toEqual({
      ...thread,
      attempts: [{ ...attempt, leaseToken: null }],
    });
  });

  it("stores messages as readable Markdown with one parseable JSON header", async () => {
    const { dataDir, store } = await createStore();
    const path = await store.writeMessage(message);
    const content = await readFile(path, "utf8");

    expect(content).toMatch(/^<!-- mob-message-meta \{.*\} -->\n\nPlease build it\./);
    expect(content.match(/mob-message-meta/g)).toHaveLength(1);
    expect(content).toContain("- Keep it small");
    await expect(store.readMessageFile(path)).resolves.toEqual(message);

    const directory = join(
      dataDir,
      "state",
      "workspaces",
      workspace.id,
      "tasks",
      task.id,
      "messages",
    );
    expect(await readdir(directory)).toEqual(["1786608550123-message-1.md"]);
  });

  it("uses canonical JSON and leaves no temporary file after an atomic overwrite", async () => {
    const { dataDir, store } = await createStore();
    const firstPath = await store.writeEvent(event);
    const first = await readFile(firstPath, "utf8");

    await store.writeEvent({
      ...event,
      payload: { alpha: { one: false, two: true }, zeta: 1 },
    });
    const second = await readFile(firstPath, "utf8");

    expect(second).toBe(first);
    expect(second.indexOf('"alpha"')).toBeLessThan(second.indexOf('"zeta"'));
    const directory = join(
      dataDir,
      "state",
      "workspaces",
      workspace.id,
      "tasks",
      task.id,
      "runs",
      run.id,
      "events",
    );
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("repairs a task file projection and removes only stale managed state", async () => {
    const { dataDir, store } = await createStore();
    await store.exportTaskThread({
      ...thread,
      messages: [message, { ...message, id: "message-obsolete", createdAt: later }],
    });

    const taskRoot = join(dataDir, "state", "workspaces", workspace.id, "tasks", task.id);
    await writeFile(join(taskRoot, "task.json"), "corrupt", "utf8");
    await mkdir(join(taskRoot, "notes"));
    await writeFile(join(taskRoot, "notes", "keep.txt"), "owned by a person", "utf8");

    const result = await store.repairTaskThread(thread);

    expect(result.written).toBe(8);
    expect(result.removed).toBe(1);
    expect(await store.readTaskThread(workspace.id, task.id)).toEqual({
      ...thread,
      attempts: [{ ...attempt, leaseToken: null }],
    });
    await expect(readFile(join(taskRoot, "notes", "keep.txt"), "utf8")).resolves.toBe(
      "owned by a person",
    );
  });

  it("rejects identifiers that could escape the state root", async () => {
    const { store } = await createStore();

    await expect(store.writeWorkspace({ ...workspace, id: "../outside" })).rejects.toThrow(
      "safe path segment",
    );
    await expect(store.readTaskThread(workspace.id, "task/../../outside")).rejects.toThrow(
      "safe path segment",
    );
  });
});
