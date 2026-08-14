import type {
  AgentProfile,
  ConversationSummary,
  TaskSummary,
  WorkspaceActor,
} from "./model.js";

export interface RepositoryResource {
  id: string;
  name: string;
  remoteUrl: string | null;
  defaultBranch: string;
  enabled: boolean;
}

export interface SendIntent {
  wakeAgentIds: string[];
  mode: "chat" | "wake";
}

export function conversationFirstList(
  conversations: ConversationSummary[],
  tasks: TaskSummary[],
): ConversationSummary[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const known = new Set(conversations.map((conversation) => conversation.id));
  const legacyFallbacks = (conversations.length ? [] : tasks)
    .filter((task) => !known.has(task.id))
    .map((task): ConversationSummary => ({
      id: task.id,
      taskId: task.id,
      activeRepositoryId: task.repositoryId ?? null,
      kind: "group",
      title: task.title,
      isPrimary: true,
      updatedAt: task.updatedAt,
      members: [],
      lastMessage: null,
    }));

  return [...conversations, ...legacyFallbacks]
    .map((conversation) => conversation.isPrimary
      ? { ...conversation, kind: "group" as const, title: conversation.title?.trim() || (conversation.taskId ? taskById.get(conversation.taskId)?.title : null) || "Group chat" }
      : conversation)
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

export function repositoryResources(tasks: TaskSummary[]): RepositoryResource[] {
  const repositories = new Map<string, RepositoryResource>();
  for (const task of tasks) {
    if (!task.repository || task.repository === "No repository" || task.repository === "Unknown repository") continue;
    const id = task.repositoryId || task.repository;
    if (!repositories.has(id)) repositories.set(id, { id, name: task.repository, remoteUrl: null, defaultBranch: task.branch || "main", enabled: true });
  }
  return [...repositories.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function isMentioned(content: string, handle: string): boolean {
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)@${escaped}(?=\\s|$|[.,!?;:])`, "iu").test(content);
}

export function resolveSendIntent(
  kind: ConversationSummary["kind"],
  content: string,
  members: WorkspaceActor[],
  agents: AgentProfile[],
): SendIntent {
  const agentIds = new Set(agents.map((agent) => agent.id));
  const memberAgents = members.filter((member) => member.kind === "agent" && agentIds.has(member.id));
  if (kind === "direct") {
    return memberAgents.length === 1
      ? { mode: "wake", wakeAgentIds: [memberAgents[0]!.id] }
      : { mode: "chat", wakeAgentIds: [] };
  }
  const invoked = memberAgents.filter((member) => isMentioned(content, member.handle)).map((member) => member.id);
  return invoked.length ? { mode: "wake", wakeAgentIds: invoked } : { mode: "chat", wakeAgentIds: [] };
}
