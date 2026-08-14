import { describe, expect, it } from "vitest";
import {
  conversationFirstList,
  repositoryResources,
  resolveSendIntent,
} from "../../web/src/conversation-ui.js";
import type {
  AgentProfile,
  ConversationSummary,
  TaskSummary,
  WorkspaceActor,
} from "../../web/src/model.js";

const now = "2026-08-14T08:00:00.000Z";

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "task-1",
    repositoryId: "repo-1",
    title: "Legacy release room",
    repository: "cdotlock/mob-agent-crew",
    branch: "main",
    status: "open",
    resolution: "unreviewed",
    updatedAt: now,
    unread: 0,
    participantIds: [],
    summary: "",
    ...overrides,
  };
}

function agent(id = "agent-1", handle = "builder"): AgentProfile {
  return {
    id,
    handle,
    name: "Builder",
    initials: "B",
    role: "Engineer",
    owner: "Crew",
    modelId: null,
    effectiveModelId: "default",
    skillRefs: [],
    pluginRefs: [],
    environment: { reference: null, values: {} },
    compatibility: { compatible: true, status: "compatible", driverProtocols: ["openai-chat"], modelProtocols: ["openai-chat"] },
    driver: "pi",
    status: "available",
    capabilities: [],
    currentTaskId: null,
    color: "#8c7cf5",
  };
}

function conversation(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: "chat-1",
    taskId: null,
    activeRepositoryId: null,
    kind: "group",
    title: "Team room",
    isPrimary: false,
    updatedAt: now,
    members: [],
    lastMessage: null,
    ...overrides,
  };
}

describe("conversation-first UI rules", () => {
  it("projects legacy task threads as ordinary groups without requiring a separate task section", () => {
    const chats = conversationFirstList([], [task()]);
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ kind: "group", title: "Legacy release room", activeRepositoryId: "repo-1" });
  });

  it("lists repositories independently from whether the current chat uses them", () => {
    expect(repositoryResources([
      task(),
      task({ id: "task-2", repositoryId: "repo-1", title: "Another run" }),
      task({ id: "task-3", repositoryId: "repo-2", repository: "cdotlock/mob-sandbox", branch: "develop" }),
    ])).toEqual([
      { id: "repo-1", name: "cdotlock/mob-agent-crew", remoteUrl: null, defaultBranch: "main", enabled: true },
      { id: "repo-2", name: "cdotlock/mob-sandbox", remoteUrl: null, defaultBranch: "develop", enabled: true },
    ]);
  });

  it("wakes an Agent DM but keeps a human DM as ordinary chat", () => {
    const builder = agent();
    const agentMember: WorkspaceActor = { id: builder.id, handle: builder.handle, name: builder.name, initials: builder.initials, kind: "agent" };
    const humanMember: WorkspaceActor = { id: "human-2", handle: "rydia", name: "Rydia", initials: "R", kind: "human" };
    expect(resolveSendIntent("direct", "hello", [agentMember], [builder])).toEqual({ mode: "wake", wakeAgentIds: [builder.id] });
    expect(resolveSendIntent("direct", "hello", [humanMember], [builder])).toEqual({ mode: "chat", wakeAgentIds: [] });
  });

  it("only treats an Agent mention as work in a group", () => {
    const builder = agent();
    const members: WorkspaceActor[] = [{ id: builder.id, handle: builder.handle, name: builder.name, initials: builder.initials, kind: "agent" }];
    expect(resolveSendIntent("group", "anyone around?", members, [builder]).mode).toBe("chat");
    expect(resolveSendIntent("group", "@builder please inspect this", members, [builder])).toEqual({ mode: "wake", wakeAgentIds: [builder.id] });
  });
});
