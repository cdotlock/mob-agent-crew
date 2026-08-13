import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from "@phosphor-icons/react/ArrowCounterClockwise";
import { ArrowRightIcon as ArrowRight } from "@phosphor-icons/react/ArrowRight";
import { AtIcon as At } from "@phosphor-icons/react/At";
import { CaretDownIcon as CaretDown } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon as CaretRight } from "@phosphor-icons/react/CaretRight";
import { ChatCircleDotsIcon as ChatCircleDots } from "@phosphor-icons/react/ChatCircleDots";
import { CheckIcon as Check } from "@phosphor-icons/react/Check";
import { CheckCircleIcon as CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { CircleIcon as Circle } from "@phosphor-icons/react/Circle";
import { CodeIcon as Code } from "@phosphor-icons/react/Code";
import { DotsThreeIcon as DotsThree } from "@phosphor-icons/react/DotsThree";
import { FileCodeIcon as FileCode } from "@phosphor-icons/react/FileCode";
import { FileMdIcon as FileMd } from "@phosphor-icons/react/FileMd";
import { GitBranchIcon as GitBranch } from "@phosphor-icons/react/GitBranch";
import { GithubLogoIcon as GithubLogo } from "@phosphor-icons/react/GithubLogo";
import { HashIcon as Hash } from "@phosphor-icons/react/Hash";
import { LinkSimpleIcon as LinkSimple } from "@phosphor-icons/react/LinkSimple";
import { ListBulletsIcon as ListBullets } from "@phosphor-icons/react/ListBullets";
import { MagnifyingGlassIcon as MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import { PaperPlaneRightIcon as PaperPlaneRight } from "@phosphor-icons/react/PaperPlaneRight";
import { PaperclipIcon as Paperclip } from "@phosphor-icons/react/Paperclip";
import { PlusIcon as Plus } from "@phosphor-icons/react/Plus";
import { ShieldCheckIcon as ShieldCheck } from "@phosphor-icons/react/ShieldCheck";
import { SidebarSimpleIcon as SidebarSimple } from "@phosphor-icons/react/SidebarSimple";
import { SpinnerGapIcon as SpinnerGap } from "@phosphor-icons/react/SpinnerGap";
import { StopCircleIcon as StopCircle } from "@phosphor-icons/react/StopCircle";
import { UploadSimpleIcon as UploadSimple } from "@phosphor-icons/react/UploadSimple";
import { UsersThreeIcon as UsersThree } from "@phosphor-icons/react/UsersThree";
import { WarningCircleIcon as WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { WifiHighIcon as WifiHigh } from "@phosphor-icons/react/WifiHigh";
import { WifiSlashIcon as WifiSlash } from "@phosphor-icons/react/WifiSlash";
import { XIcon as X } from "@phosphor-icons/react/X";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import {
  cancelRun,
  createAgent,
  createConversation,
  createSession,
  createTask,
  fetchBootstrap,
  fetchConversation,
  fetchConversations,
  fetchTask,
  importGithubUrl,
  postDelegation,
  postConversationMessage,
  postMessage,
  publishTask,
  retryRun,
  reviewTask,
  uploadMarkdown,
} from "./api.js";
import { ApiError } from "./api.js";
import {
  createDemoDetail,
  demoBootstrap,
  getDemoTask,
} from "./demo.js";
import { WorkspaceInspector } from "./WorkspaceInspector.js";

const allowDemoFallback = import.meta.env.DEV;
import type {
  AgentProfile,
  AgentRun,
  Artifact,
  BootstrapData,
  ConversationDetail,
  ConversationSummary,
  ImportedContext,
  NewAgentInput,
  NewConversationInput,
  NewTaskInput,
  TaskDetail,
  TaskStatus,
  TaskSummary,
  ThreadMessage,
} from "./model.js";

type LoadState = "loading" | "ready" | "error";
type MobilePane = "tasks" | "thread" | "crew";
type ModalKind = "new-task" | "new-conversation" | "new-agent" | "delegate" | "github" | null;
type AuthState = "login" | "signing-in" | "authenticated";

const taskStatusCopy: Record<TaskStatus, string> = {
  open: "Open",
  queued: "Queued",
  running: "In progress",
  review_ready: "Ready for review",
  completed: "Completed",
  failed: "Needs attention",
  cancelled: "Cancelled",
};

const terminalRunStatuses = new Set(["succeeded", "failed", "cancelled", "skipped"]);

function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "untitled-task";
}

function primaryConversationFor(task: TaskSummary): ConversationSummary {
  return {
    id: task.id,
    taskId: task.id,
    kind: "group",
    title: task.title,
    isPrimary: true,
    updatedAt: task.updatedAt,
    members: [],
    lastMessage: null,
  };
}

function conversationTitle(conversation: ConversationSummary, currentUserId: string): string {
  if (conversation.title?.trim()) return conversation.title;
  if (conversation.kind === "direct") {
    return conversation.members.find((member) => member.id !== currentUserId)?.name ?? "Direct chat";
  }
  return "Group chat";
}

function relativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "just now";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function absoluteTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function runDuration(run: AgentRun): string {
  if (!run.startedAt) return "Waiting";
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
  const start = new Date(run.startedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function statusTone(status: string): string {
  if (["running", "working", "provisioning", "publishing"].includes(status)) return "active";
  if (["review_ready", "reviewing", "queued"].includes(status)) return "review";
  if (["completed", "succeeded", "accepted", "available"].includes(status)) return "success";
  if (["failed", "error", "rejected"].includes(status)) return "danger";
  return "muted";
}

function actorColor(actorId: string, agents: AgentProfile[]): string {
  return agents.find((agent) => agent.id === actorId)?.color ?? "#687386";
}

function renderMessageContent(content: string) {
  const parts = content.split(/(@[A-Za-z0-9_-]+)/g);
  return parts.map((part, index) =>
    part.startsWith("@") ? (
      <span className="mention" key={`${part}-${index}`}>
        {part}
      </span>
    ) : (
      <span key={`${part}-${index}`}>{part}</span>
    ),
  );
}

function visibleMessageContent(message: ThreadMessage): string {
  if (message.actorKind !== "agent") return message.content;
  return message.content
    .split("\n")
    .filter((line) => line.trim().toLowerCase() !== "mob done")
    .join("\n")
    .trim();
}

function Avatar({
  initials,
  color,
  size = "medium",
  status,
}: {
  initials: string;
  color: string;
  size?: "small" | "medium" | "large";
  status?: AgentProfile["status"];
}) {
  return (
    <span className={classNames("avatar", `avatar-${size}`)} style={{ "--avatar-color": color } as CSSProperties}>
      {initials}
      {status ? <span className={classNames("presence-dot", `presence-${status}`)} aria-label={status} /> : null}
    </span>
  );
}

function StatusPill({ status, label }: { status: string; label?: string }) {
  return (
    <span className={classNames("status-pill", `tone-${statusTone(status)}`)}>
      <span className="status-dot" aria-hidden="true" />
      {label ?? status.replaceAll("_", " ")}
    </span>
  );
}

function AppLoading() {
  return (
    <div className="app-loading" aria-live="polite" aria-busy="true">
      <div className="loading-brand"><span className="brand-mark"><UsersThree weight="bold" /></span> Mob Agent Crew</div>
      <div className="loading-grid">
        <div className="loading-panel">
          {Array.from({ length: 6 }, (_, index) => <span className="skeleton skeleton-row" key={index} />)}
        </div>
        <div className="loading-panel loading-main">
          <span className="skeleton skeleton-title" />
          {Array.from({ length: 4 }, (_, index) => <span className="skeleton skeleton-message" key={index} />)}
        </div>
        <div className="loading-panel">
          {Array.from({ length: 5 }, (_, index) => <span className="skeleton skeleton-row" key={index} />)}
        </div>
      </div>
    </div>
  );
}

function FatalError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main className="fatal-state">
      <span className="fatal-icon"><WarningCircle weight="duotone" /></span>
      <p className="eyebrow">Workspace unavailable</p>
      <h1>We couldn’t open this crew.</h1>
      <p>{message}</p>
      <button className="primary-button" onClick={onRetry}><ArrowCounterClockwise /> Try again</button>
    </main>
  );
}

function TaskSidebar({
  bootstrap,
  tasks,
  conversations,
  selectedTaskId,
  selectedConversationId,
  search,
  source,
  onSearch,
  onSelect,
  onSelectConversation,
  onNewTask,
  onNewConversation,
  onNewAgent,
  onReconnect,
}: {
  bootstrap: BootstrapData;
  tasks: TaskSummary[];
  conversations: ConversationSummary[];
  selectedTaskId: string | null;
  selectedConversationId: string | null;
  search: string;
  source: "api" | "demo";
  onSearch: (value: string) => void;
  onSelect: (taskId: string) => void;
  onSelectConversation: (conversation: ConversationSummary) => void;
  onNewTask: () => void;
  onNewConversation: () => void;
  onNewAgent: () => void;
  onReconnect: () => void;
}) {
  return (
    <aside className="task-sidebar pane" aria-label="Task channels">
      <div className="workspace-heading">
        <div>
          <p className="workspace-kicker">Workspace</p>
          <h1>{bootstrap.workspace.name}</h1>
        </div>
        <button className="icon-button" aria-label="Workspace menu"><CaretDown /></button>
      </div>

      <button className="new-task-button" onClick={onNewTask}>
        <Plus weight="bold" /> New task
        <span className="key-hint">N</span>
      </button>

      <div className="sidebar-create-actions" aria-label="Workspace creation actions">
        <button onClick={onNewConversation}><ChatCircleDots /><span>New chat</span></button>
        <button onClick={onNewAgent}><Plus /><span>Add Agent</span></button>
      </div>

      <label className="sidebar-search">
        <MagnifyingGlass aria-hidden="true" />
        <span className="sr-only">Search task channels</span>
        <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search tasks" />
      </label>

      <div className="channel-heading">
        <span>Primary groups</span>
        <span>{tasks.length}</span>
      </div>

      <nav className="task-list" aria-label="Task channels">
        {tasks.length ? tasks.map((task) => (
          <button
            className={classNames("task-item", task.id === selectedTaskId && selectedConversationId === task.id && "is-selected")}
            key={task.id}
            onClick={() => onSelect(task.id)}
            aria-current={task.id === selectedTaskId && selectedConversationId === task.id ? "page" : undefined}
          >
            <span className={classNames("task-state-icon", `tone-${statusTone(task.status)}`)}>
              {task.status === "review_ready" ? <CheckCircle weight="fill" /> : <Hash weight="bold" />}
            </span>
            <span className="task-item-copy">
              <span className="task-item-line">
                <strong>{slug(task.title)}</strong>
                <time dateTime={task.updatedAt}>{relativeTime(task.updatedAt)}</time>
              </span>
              <span className="task-item-summary"><span className="conversation-kind">group</span>{task.summary || task.repository}</span>
            </span>
            {task.unread > 0 ? <span className="unread-count" aria-label={`${task.unread} unread`}>{task.unread}</span> : null}
          </button>
        )) : (
          <div className="sidebar-empty">
            <ChatCircleDots />
            <strong>No matching tasks</strong>
            <span>Try another search or start a task.</span>
          </div>
        )}
        {conversations.length ? (
          <>
            <div className="channel-heading chat-heading"><span>Direct & group</span><span>{conversations.length}</span></div>
            {conversations.map((conversation) => {
              const label = conversationTitle(conversation, bootstrap.currentUser.id);
              const lastMessage = conversation.lastMessage?.content;
              return (
                <button
                  className={classNames("task-item conversation-item", selectedConversationId === conversation.id && "is-selected")}
                  key={conversation.id}
                  onClick={() => onSelectConversation(conversation)}
                  aria-current={selectedConversationId === conversation.id ? "page" : undefined}
                >
                  <span className="task-state-icon conversation-icon">
                    {conversation.kind === "direct" ? <ChatCircleDots weight="bold" /> : <UsersThree weight="bold" />}
                  </span>
                  <span className="task-item-copy">
                    <span className="task-item-line">
                      <strong>{label}</strong>
                      <time dateTime={conversation.updatedAt}>{relativeTime(conversation.updatedAt)}</time>
                    </span>
                    <span className="task-item-summary"><span className="conversation-kind">{conversation.kind}</span>{lastMessage || "No messages yet"}</span>
                  </span>
                </button>
              );
            })}
          </>
        ) : null}
      </nav>

      <div className="sidebar-footer">
        <button className="connection-row" onClick={source === "demo" ? onReconnect : undefined}>
          {source === "api" ? <WifiHigh className="connection-live" /> : <WifiSlash className="connection-demo" />}
          <span>
            <strong>{source === "api" ? "Live workspace" : "Demo fallback"}</strong>
            <small>{source === "api" ? bootstrap.workspace.environment : "API unavailable · reconnect"}</small>
          </span>
          {source === "demo" ? <ArrowCounterClockwise /> : null}
        </button>
        <div className="current-user">
          <Avatar initials={bootstrap.currentUser.initials} color="#7c68ee" size="small" />
          <span><strong>{bootstrap.currentUser.name}</strong><small>Human collaborator</small></span>
          <button className="icon-button" aria-label="Account menu"><DotsThree /></button>
        </div>
      </div>
    </aside>
  );
}

function MessageItem({
  message,
  agents,
  artifacts,
  onOpenArtifact,
}: {
  message: ThreadMessage;
  agents: AgentProfile[];
  artifacts: Artifact[];
  onOpenArtifact: (artifactId: string) => void;
}) {
  const visibleContent = visibleMessageContent(message);
  const linkedArtifacts = message.artifactIds
    .map((id) => artifacts.find((artifact) => artifact.id === id))
    .filter((artifact): artifact is Artifact => Boolean(artifact));
  if (message.actorKind === "system") {
    return (
      <article className="system-message">
        <span className="system-line" />
        <ShieldCheck weight="duotone" />
        {visibleContent ? <p>{renderMessageContent(visibleContent)}</p> : null}
        <time title={absoluteTime(message.createdAt)}>{relativeTime(message.createdAt)}</time>
      </article>
    );
  }
  return (
    <article className="thread-message">
      <Avatar initials={message.actorInitials} color={message.actorKind === "human" ? "#7c68ee" : actorColor(message.actorId, agents)} />
      <div className="message-body">
        <div className="message-meta">
          <strong>{message.actorName}</strong>
          <span className="actor-kind">{message.actorKind}</span>
          <time dateTime={message.createdAt} title={absoluteTime(message.createdAt)}>{relativeTime(message.createdAt)}</time>
          {message.delivery === "pending" ? <SpinnerGap className="spin" aria-label="Sending" /> : null}
          {message.delivery === "failed" ? <WarningCircle className="error-icon" aria-label="Failed to send" /> : null}
        </div>
        {visibleContent ? <p>{renderMessageContent(visibleContent)}</p> : null}
        {linkedArtifacts.length ? (
          <div className="message-artifacts">
            {linkedArtifacts.map((artifact) => (
              <button key={artifact.id} className="artifact-chip" onClick={() => onOpenArtifact(artifact.id)}>
                {artifact.kind === "patch" || artifact.kind === "diff" ? <FileCode /> : <FileMd />}
                <span><strong>{artifact.name}</strong><small>{artifact.summary}</small></span>
                <CaretRight />
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function Composer({
  task,
  agents,
  runAgents,
  conversationKind,
  value,
  busy,
  onChange,
  onSend,
  onRunAgent,
  onUpload,
  onOpenGithub,
}: {
  task: TaskDetail;
  agents: AgentProfile[];
  runAgents: AgentProfile[];
  conversationKind: ConversationSummary["kind"];
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onRunAgent: (agentId: string) => void;
  onUpload: (file: File) => void;
  onOpenGithub: () => void;
}) {
  const uploadRef = useRef<HTMLInputElement>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [runAgentId, setRunAgentId] = useState(runAgents[0]?.id ?? "");
  const mentionMatch = value.match(/(?:^|\s)@([\w-]*)$/);
  const mentionQuery = mentionMatch?.[1]?.toLowerCase() ?? null;
  const matches = mentionQuery === null
    ? []
    : agents.filter((agent) => agent.name.toLowerCase().startsWith(mentionQuery)).slice(0, 5);

  useEffect(() => setMentionIndex(0), [mentionQuery]);
  useEffect(() => {
    if (!runAgents.some((agent) => agent.id === runAgentId)) setRunAgentId(runAgents[0]?.id ?? "");
  }, [runAgentId, runAgents]);

  function insertMention(agent: AgentProfile) {
    const start = mentionMatch?.index ?? value.length;
    const leading = value.slice(0, start);
    const separator = value[start] === " " ? " " : "";
    onChange(`${leading}${separator}@${agent.name} `);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (matches.length && ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) {
      if (event.key === "Escape") {
        onChange(`${value} `);
        event.preventDefault();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setMentionIndex((current) => (current + direction + matches.length) % matches.length);
        event.preventDefault();
        return;
      }
      if (event.key === "Enter") {
        const agent = matches[mentionIndex];
        if (agent) insertMention(agent);
        event.preventDefault();
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSend();
    }
  }

  return (
    <div className="composer-wrap">
      {matches.length ? (
        <div className="mention-menu" role="listbox" aria-label="Mention an agent">
          <p>Bring an agent into this task</p>
          {matches.map((agent, index) => (
            <button
              key={agent.id}
              className={classNames("mention-option", index === mentionIndex && "is-active")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insertMention(agent)}
              role="option"
              aria-selected={index === mentionIndex}
            >
              <Avatar initials={agent.initials} color={agent.color} size="small" status={agent.status} />
              <span><strong>@{agent.name}</strong><small>{agent.role} · {agent.driver}</small></span>
              <StatusPill status={agent.status} />
            </button>
          ))}
        </div>
      ) : null}
      <div className="composer" aria-label={`Message #${slug(task.title)}`}>
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Message ${conversationKind === "direct" ? "this direct chat" : `#${slug(task.title)}`} · sending does not run an Agent`}
          rows={3}
          disabled={busy}
          aria-label="Message the task thread"
        />
        <div className="composer-toolbar">
          <div className="composer-tools">
            <input
              ref={uploadRef}
              type="file"
              accept=".md,text/markdown,text/plain"
              className="visually-hidden-input"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onUpload(file);
                event.currentTarget.value = "";
              }}
            />
            <button className="composer-tool" onClick={() => uploadRef.current?.click()} aria-label="Upload Markdown context" title="Upload Markdown context">
              <Paperclip />
            </button>
            <button className="composer-tool" onClick={onOpenGithub} aria-label="Import GitHub URL" title="Import GitHub URL">
              <GithubLogo />
            </button>
            <button className="composer-tool" onClick={() => onChange(`${value}${value && !value.endsWith(" ") ? " " : ""}@`)} aria-label="Mention an agent" title="Mention an agent">
              <At />
            </button>
            <span className="composer-hint">Chat only · ⌘↵ to send</span>
          </div>
          <div className="composer-submit-actions">
            {runAgents.length ? (
              <div className="run-agent-control">
                {runAgents.length > 1 ? (
                  <select value={runAgentId} onChange={(event) => setRunAgentId(event.target.value)} aria-label="Agent to run">
                    {runAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                  </select>
                ) : null}
                <button className="run-agent-button" onClick={() => onRunAgent(runAgentId)} disabled={!value.trim() || busy || !runAgentId} aria-label={`Run ${runAgents.find((agent) => agent.id === runAgentId)?.name ?? "Agent"} with this instruction`}>
                  {busy ? <SpinnerGap className="spin" /> : <Code />}
                  <span>{runAgents.length === 1 ? `Run ${runAgents[0]?.name}` : "Run"}</span>
                </button>
              </div>
            ) : null}
            <button className="send-button" onClick={onSend} disabled={!value.trim() || busy} aria-label="Send chat message without running an Agent" title="Send chat only">
              {busy ? <SpinnerGap className="spin" /> : <PaperPlaneRight weight="fill" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ThreadPane({
  task,
  conversation,
  agents,
  loading,
  error,
  composer,
  actionBusy,
  actionError,
  onComposerChange,
  onSend,
  onRunAgent,
  onUpload,
  onOpenGithub,
  onOpenArtifact,
  onRetryLoad,
  onOpenDelegate,
  onReview,
  onPublish,
}: {
  task: TaskDetail | null;
  conversation: ConversationSummary | null;
  agents: AgentProfile[];
  loading: boolean;
  error: string | null;
  composer: string;
  actionBusy: boolean;
  actionError: string | null;
  onComposerChange: (value: string) => void;
  onSend: () => void;
  onRunAgent: (agentId: string) => void;
  onUpload: (file: File) => void;
  onOpenGithub: () => void;
  onOpenArtifact: (artifactId: string) => void;
  onRetryLoad: () => void;
  onOpenDelegate: () => void;
  onReview: (decision: "accept" | "reject" | "request_changes") => void;
  onPublish: () => void;
}) {
  if (loading) {
    return (
      <main className="thread-pane pane" id="main-content" aria-live="polite" aria-busy="true">
        <div className="thread-loading">
          <span className="skeleton skeleton-title" />
          {Array.from({ length: 4 }, (_, index) => <span className="skeleton skeleton-message" key={index} />)}
        </div>
      </main>
    );
  }
  if (error || !task) {
    return (
      <main className="thread-pane pane" id="main-content">
        <div className="thread-empty">
          <WarningCircle weight="duotone" />
          <h2>{error ? "Couldn’t open this task" : "Choose a task channel"}</h2>
          <p>{error ?? "Select a task to see its shared conversation and artifacts."}</p>
          {error ? <button className="secondary-button" onClick={onRetryLoad}><ArrowCounterClockwise /> Retry</button> : null}
        </div>
      </main>
    );
  }
  const conversationAgentIds = new Set(conversation?.members.filter((member) => member.kind === "agent").map((member) => member.id) ?? []);
  const participants = conversationAgentIds.size
    ? agents.filter((agent) => conversationAgentIds.has(agent.id))
    : agents.filter((agent) => task.participantIds.includes(agent.id));
  const runnableAgents = participants.length ? participants : conversation?.isPrimary ? agents : [];
  const activeTitle = conversation && !conversation.isPrimary
    ? conversation.title?.trim() || conversation.members.find((member) => member.kind === "agent")?.name || "Group chat"
    : slug(task.title);
  const conversationLabel = conversation?.kind === "direct" ? "Direct chat" : conversation?.isPrimary ? "Primary group" : "Group chat";
  const activeRun = [...task.runs].reverse().find((run) => !terminalRunStatuses.has(run.status));
  const activeAgent = activeRun ? agents.find((agent) => agent.id === activeRun.agentId) : null;
  return (
    <main className="thread-pane pane" id="main-content">
      <header className="thread-header">
        <div className="thread-title-row">
          <span className="channel-icon">{conversation?.kind === "direct" ? <ChatCircleDots weight="bold" /> : conversation?.isPrimary ? <Hash weight="bold" /> : <UsersThree weight="bold" />}</span>
          <div className="thread-title">
            <h2>{activeTitle}</h2>
            <p>{conversationLabel} · {task.title}</p>
          </div>
          <StatusPill status={task.status} label={taskStatusCopy[task.status]} />
        </div>
        <div className="thread-actions">
          <div className="participant-stack" aria-label={`${participants.length} participating agents`}>
            {participants.slice(0, 4).map((agent) => <Avatar key={agent.id} initials={agent.initials} color={agent.color} size="small" />)}
          </div>
          <button className="secondary-button compact-button" onClick={onOpenDelegate}><UsersThree /> Delegate</button>
          <button className="icon-button" aria-label="Task menu"><DotsThree /></button>
        </div>
      </header>

      <div className="task-context-strip">
        <span><GithubLogo /> {task.repository}</span>
        <span><GitBranch /> {task.baseRef}</span>
        <span><ShieldCheck /> private workspaces</span>
      </div>

      {actionError ? <div className="inline-alert" role="alert"><WarningCircle /> <span>{actionError}</span></div> : null}

      {activeRun ? (
        <div className="run-live-banner" role="status" aria-live="polite">
          <SpinnerGap className="spin" />
          <span>
            <strong>{activeAgent?.name ?? "Agent"} is {activeRun.status === "queued" ? "queued" : "working"}</strong>
            <small>{activeRun.summary || "Preparing the task…"}</small>
          </span>
          <time>{runDuration(activeRun)}</time>
        </div>
      ) : null}

      <section className="thread-scroll" aria-label="Shared task thread">
        <div className="thread-intro">
          <span className="intro-icon"><Hash weight="bold" /></span>
          <div>
            <p className="eyebrow">{conversationLabel}</p>
            <h3>{activeTitle}</h3>
            <p>{conversation?.isPrimary || !conversation ? task.description : `A task-scoped ${conversation.kind} transcript. Chat stays chat until you explicitly run an Agent.`}</p>
            <div className="intro-badges">
              <span><GitBranch /> {task.baseRef}</span>
              <span><UsersThree /> {participants.length || task.participantIds.length} agents</span>
              <span><ShieldCheck /> one writer lease</span>
            </div>
          </div>
        </div>

        <div className="date-divider"><span>Shared activity</span></div>

        {task.messages.length ? task.messages.map((message) => (
          <MessageItem key={message.id} message={message} agents={agents} artifacts={task.artifacts} onOpenArtifact={onOpenArtifact} />
        )) : (
          <div className="messages-empty">
            <ChatCircleDots />
            <h3>Start the shared thread</h3>
            <p>Mention an agent, attach Markdown, or import a GitHub issue to provide the first concrete deliverable.</p>
          </div>
        )}
      </section>

      {task.status === "review_ready" ? (
        <div className="review-bar">
          <div className="review-copy"><CheckCircle weight="duotone" /><span><strong>Combined result ready</strong><small>Review the patch and fresh test evidence before publication.</small></span></div>
          <div className="review-actions">
            <button className="ghost-button" onClick={() => onReview("request_changes")} disabled={actionBusy}>Request changes</button>
            <button className="primary-button" onClick={() => onReview("accept")} disabled={actionBusy}>{actionBusy ? <SpinnerGap className="spin" /> : <Check />} Approve result</button>
          </div>
        </div>
      ) : null}

      {task.status === "completed" && task.resolution === "accepted" && !task.branch.startsWith("mob/") ? (
        <div className="review-bar">
          <div className="review-copy"><ShieldCheck weight="duotone" /><span><strong>Result accepted</strong><small>SCM publication is still separate and requires your confirmation.</small></span></div>
          <div className="review-actions">
            <button className="primary-button" onClick={onPublish} disabled={actionBusy}>{actionBusy ? <SpinnerGap className="spin" /> : <GitBranch />} Publish branch</button>
          </div>
        </div>
      ) : null}

      <Composer
        task={task}
        agents={conversation && !conversation.isPrimary ? runnableAgents : agents}
        runAgents={runnableAgents}
        conversationKind={conversation?.kind ?? "group"}
        value={composer}
        busy={actionBusy}
        onChange={onComposerChange}
        onSend={onSend}
        onRunAgent={onRunAgent}
        onUpload={onUpload}
        onOpenGithub={onOpenGithub}
      />
    </main>
  );
}

function RunTimeline({
  task,
  agents,
  busyRunId,
  onCancel,
  onRetry,
}: {
  task: TaskDetail;
  agents: AgentProfile[];
  busyRunId: string | null;
  onCancel: (runId: string) => void;
  onRetry: (runId: string) => void;
}) {
  return (
    <section className="inspector-section">
      <div className="inspector-heading"><span>Run timeline</span><small>{task.runs.length}</small></div>
      {task.runs.length ? (
        <ol className="run-timeline">
          {[...task.runs].reverse().map((run) => {
            const agent = agents.find((entry) => entry.id === run.agentId);
            const isActive = !terminalRunStatuses.has(run.status);
            return (
              <li key={run.id} className={classNames("run-item", `run-${statusTone(run.status)}`)}>
                <span className="timeline-rail"><span className="run-marker">{run.status === "succeeded" ? <Check /> : run.status === "failed" ? <X /> : isActive ? <SpinnerGap className="spin" /> : <Circle weight="fill" />}</span></span>
                <div className="run-copy">
                  <div className="run-title"><strong>{run.role}</strong><span>{runDuration(run)}</span></div>
                  <p>{agent?.name ?? "Unknown agent"} · attempt {run.attempt}</p>
                  <small>{run.summary || run.status.replaceAll("_", " ")}</small>
                  {isActive ? (
                    <button className="inline-action danger-action" disabled={busyRunId === run.id} onClick={() => onCancel(run.id)}>
                      {busyRunId === run.id ? <SpinnerGap className="spin" /> : <StopCircle />} Cancel run
                    </button>
                  ) : null}
                  {run.status === "failed" ? (
                    <button className="inline-action" disabled={busyRunId === run.id} onClick={() => onRetry(run.id)}>
                      {busyRunId === run.id ? <SpinnerGap className="spin" /> : <ArrowCounterClockwise />} Retry as attempt {run.attempt + 1}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : <p className="section-empty">Mention an agent to create the first run.</p>}
    </section>
  );
}

function ArtifactCard({
  artifact,
  agent,
  expanded,
  onToggle,
}: {
  artifact: Artifact;
  agent: AgentProfile | undefined;
  expanded: boolean;
  onToggle: () => void;
}) {
  const isCode = artifact.kind === "patch" || artifact.kind === "diff" || artifact.kind === "log";
  return (
    <article className={classNames("artifact-card", expanded && "is-expanded")} id={`artifact-${artifact.id}`}>
      <button className="artifact-card-header" onClick={onToggle} aria-expanded={expanded}>
        <span className={classNames("artifact-type", artifact.kind === "patch" || artifact.kind === "diff" ? "artifact-patch" : "artifact-doc")}>
          {artifact.kind === "patch" || artifact.kind === "diff" ? <FileCode /> : <FileMd />}
        </span>
        <span className="artifact-title"><strong>{artifact.name}</strong><small>{artifact.summary}</small></span>
        <CaretRight className="artifact-caret" />
      </button>
      <div className="artifact-meta"><span>{agent?.name ?? "Agent"}</span><span>{artifact.revision}</span><time>{relativeTime(artifact.createdAt)}</time></div>
      {artifact.downloadUrl ? <a className="artifact-download" href={artifact.downloadUrl}><ArrowRight /> Download file</a> : null}
      {expanded ? (
        <pre className={classNames("artifact-preview", isCode && "code-preview")}>
          {artifact.content.split("\n").map((line, index) => (
            <code className={classNames(line.startsWith("+") && !line.startsWith("+++") && "diff-add", line.startsWith("-") && !line.startsWith("---") && "diff-remove")} key={index}>{line || " "}</code>
          ))}
        </pre>
      ) : null}
    </article>
  );
}

function AgentRoster({ agents, task, onDelegate }: { agents: AgentProfile[]; task: TaskDetail; onDelegate: (agentId: string) => void }) {
  const sortedAgents = [...agents].sort((a, b) => {
    const aParticipates = task.participantIds.includes(a.id) ? 0 : 1;
    const bParticipates = task.participantIds.includes(b.id) ? 0 : 1;
    return aParticipates - bParticipates || a.name.localeCompare(b.name);
  });
  return (
    <section className="inspector-section agent-roster">
      <div className="inspector-heading"><span>Agents</span><small>{agents.filter((agent) => agent.status !== "offline").length} online</small></div>
      <div className="agent-list">
        {sortedAgents.map((agent) => {
          const participates = task.participantIds.includes(agent.id);
          return (
            <article className={classNames("agent-card", participates && "is-participant")} key={agent.id}>
              <div className="agent-card-top">
                <Avatar initials={agent.initials} color={agent.color} status={agent.status} />
                <div className="agent-identity"><strong>{agent.name}</strong><span>{agent.role}</span></div>
                {!participates && agent.status !== "offline" ? <button className="agent-add" onClick={() => onDelegate(agent.id)} aria-label={`Delegate to ${agent.name}`}><Plus /></button> : null}
              </div>
              <dl className="agent-facts">
                <div><dt>Owner</dt><dd>{agent.owner}</dd></div>
                <div><dt>Driver</dt><dd><Code /> {agent.driver}</dd></div>
              </dl>
              <div className="capability-list" aria-label={`${agent.name} capabilities`}>
                {agent.capabilities.length ? agent.capabilities.map((capability) => <span key={capability}>{capability}</span>) : <span>one-shot</span>}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function InspectorPane({
  task,
  agents,
  expandedArtifactId,
  busyRunId,
  onOpenArtifact,
  onCancel,
  onRetry,
  onDelegate,
}: {
  task: TaskDetail | null;
  agents: AgentProfile[];
  expandedArtifactId: string | null;
  busyRunId: string | null;
  onOpenArtifact: (artifactId: string) => void;
  onCancel: (runId: string) => void;
  onRetry: (runId: string) => void;
  onDelegate: (agentId: string) => void;
}) {
  if (!task) {
    return <aside className="inspector-pane pane"><div className="inspector-empty"><SidebarSimple /><span>Task context appears here.</span></div></aside>;
  }
  return (
    <aside className="inspector-pane pane" aria-label="Task crew and artifacts">
      <header className="inspector-header">
        <div><p className="eyebrow">Shared context</p><h2>Crew & output</h2></div>
        <span className="lease-badge"><ShieldCheck /> isolated</span>
      </header>

      <div className="inspector-scroll">
        <AgentRoster agents={agents} task={task} onDelegate={onDelegate} />
        <RunTimeline task={task} agents={agents} busyRunId={busyRunId} onCancel={onCancel} onRetry={onRetry} />
        <section className="inspector-section">
          <div className="inspector-heading"><span>Artifacts</span><small>{task.artifacts.length}</small></div>
          <div className="artifact-list">
            {task.artifacts.length ? task.artifacts.map((artifact) => (
              <ArtifactCard
                key={artifact.id}
                artifact={artifact}
                agent={agents.find((agent) => agent.id === artifact.producerAgentId)}
                expanded={expandedArtifactId === artifact.id}
                onToggle={() => onOpenArtifact(artifact.id)}
              />
            )) : <p className="section-empty">Published Markdown, patches, and test reports appear here.</p>}
          </div>
        </section>
        <section className="inspector-section budget-section">
          <div className="inspector-heading"><span>Task guardrails</span><small>${task.budgetUsed.toFixed(2)} / ${task.budgetLimit.toFixed(2)}</small></div>
          <div className="budget-track"><span style={{ width: `${Math.min(100, task.budgetLimit ? (task.budgetUsed / task.budgetLimit) * 100 : 0)}%` }} /></div>
          <div className="guardrail-grid"><span><ShieldCheck /> Writer lease</span><strong>1 at a time</strong><span><UsersThree /> Delegation depth</span><strong>{task.delegationDepth} / {task.maxDelegationDepth}</strong></div>
        </section>
      </div>
    </aside>
  );
}

function Modal({ title, description, onClose, children }: { title: string; description: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    <div className="modal-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-description">
        <header className="modal-header"><div><p className="eyebrow">Mob Agent Crew</p><h2 id="modal-title">{title}</h2><p id="modal-description">{description}</p></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X /></button></header>
        {children}
      </section>
    </div>
  );
}

function NewTaskModal({ agents, busy, error, onClose, onSubmit }: { agents: AgentProfile[]; busy: boolean; error: string | null; onClose: () => void; onSubmit: (input: NewTaskInput) => void }) {
  const [form, setForm] = useState<NewTaskInput>({ title: "", repository: "", baseRef: "main", initialMessage: "", agentId: agents[0]?.id ?? "" });
  return (
    <Modal title="Start a task channel" description="Create one shared place for the problem, agent handoffs, patches, and human decisions." onClose={onClose}>
      <form className="modal-form" onSubmit={(event) => { event.preventDefault(); onSubmit(form); }}>
        {error ? <div className="inline-alert" role="alert"><WarningCircle /> {error}</div> : null}
        <label><span>Task title</span><input autoFocus required value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Fix flaky webhook retry spec" /></label>
        <div className="form-row">
          <label><span>Repository</span><input required value={form.repository} onChange={(event) => setForm({ ...form, repository: event.target.value })} placeholder="owner/repository" /></label>
          <label><span>Base ref</span><input required value={form.baseRef} onChange={(event) => setForm({ ...form, baseRef: event.target.value })} placeholder="main" /></label>
        </div>
        <label><span>Start with agent</span><select value={form.agentId} onChange={(event) => setForm({ ...form, agentId: event.target.value })}>{agents.map((agent) => <option key={agent.id} value={agent.id}>@{agent.name} · {agent.driver}</option>)}</select></label>
        <label><span>First message</span><textarea required rows={5} value={form.initialMessage} onChange={(event) => setForm({ ...form, initialMessage: event.target.value })} placeholder="Describe the deliverable, constraints, and how we will verify it." /></label>
        <div className="modal-note"><ShieldCheck /> Agents get isolated writable workspaces. Handoffs share revisions, messages, and explicit artifacts.</div>
        <footer className="modal-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? <SpinnerGap className="spin" /> : <ArrowRight />} Create task</button></footer>
      </form>
    </Modal>
  );
}

function DelegateModal({ agents, initialAgentId, busy, error, onClose, onSubmit }: { agents: AgentProfile[]; initialAgentId: string; busy: boolean; error: string | null; onClose: () => void; onSubmit: (input: { agentId: string; deliverable: string }) => void }) {
  const [agentId, setAgentId] = useState(initialAgentId || agents[0]?.id || "");
  const [deliverable, setDeliverable] = useState("");
  const agent = agents.find((entry) => entry.id === agentId);
  return (
    <Modal title="Delegate a bounded handoff" description="The receiving agent gets this thread, an immutable revision, and explicit artifacts — never another agent’s writable directory." onClose={onClose}>
      <form className="modal-form" onSubmit={(event) => { event.preventDefault(); onSubmit({ agentId, deliverable }); }}>
        {error ? <div className="inline-alert" role="alert"><WarningCircle /> {error}</div> : null}
        <label><span>Receiving agent</span><select autoFocus value={agentId} onChange={(event) => setAgentId(event.target.value)}>{agents.filter((entry) => entry.status !== "offline").map((entry) => <option key={entry.id} value={entry.id}>@{entry.name} · {entry.role} · {entry.driver}</option>)}</select></label>
        {agent ? <div className="selected-agent"><Avatar initials={agent.initials} color={agent.color} status={agent.status} /><span><strong>{agent.name}</strong><small>{agent.owner} · {agent.capabilities.join(" · ") || "one-shot"}</small></span></div> : null}
        <label><span>Concrete deliverable</span><textarea required rows={5} value={deliverable} onChange={(event) => setDeliverable(event.target.value)} placeholder="Review the proposed patch for concurrency regressions and publish findings.md with P0–P2 severity." /></label>
        <footer className="modal-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !agentId || !deliverable.trim()}>{busy ? <SpinnerGap className="spin" /> : <UsersThree />} Delegate</button></footer>
      </form>
    </Modal>
  );
}

function GithubModal({ busy, error, onClose, onSubmit }: { busy: boolean; error: string | null; onClose: () => void; onSubmit: (url: string) => void }) {
  const [url, setUrl] = useState("");
  const valid = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.trim());
  return (
    <Modal title="Import a GitHub repository" description="Paste one repository root URL. The server stores the repository reference as shared task context." onClose={onClose}>
      <form className="modal-form" onSubmit={(event) => { event.preventDefault(); if (valid) onSubmit(url.trim()); }}>
        {error ? <div className="inline-alert" role="alert"><WarningCircle /> {error}</div> : null}
        <label><span>Repository root URL</span><div className="url-input"><GithubLogo /><input autoFocus required type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/owner/repo" /></div><small>Use exactly https://github.com/owner/repo — nested issue, PR, commit, and file URLs are not accepted.</small></label>
        <div className="modal-note"><LinkSimple /> Imported content is task context, not a live editable mirror.</div>
        <footer className="modal-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !valid}>{busy ? <SpinnerGap className="spin" /> : <UploadSimple />} Import context</button></footer>
      </form>
    </Modal>
  );
}

function NewConversationModal({
  tasks,
  agents,
  initialTaskId,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  tasks: TaskSummary[];
  agents: AgentProfile[];
  initialTaskId: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: NewConversationInput) => void;
}) {
  const [kind, setKind] = useState<NewConversationInput["kind"]>("direct");
  const [taskId, setTaskId] = useState(initialTaskId || tasks[0]?.id || "");
  const [title, setTitle] = useState("");
  const [members, setMembers] = useState<string[]>(agents[0]?.id ? [agents[0].id] : []);
  const valid = Boolean(taskId && members.length && (kind === "group" ? title.trim() : members.length === 1));

  function chooseKind(next: NewConversationInput["kind"]) {
    setKind(next);
    if (next === "direct" && members.length > 1) setMembers(members.slice(0, 1));
  }

  function toggleMember(agentId: string) {
    if (kind === "direct") {
      setMembers([agentId]);
      return;
    }
    setMembers((current) => current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId]);
  }

  return (
    <Modal title="Create a conversation" description="Chats share a task environment, but messages do not run an Agent until you press Run." onClose={onClose}>
      <form className="modal-form" onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSubmit({ taskId, kind, title: kind === "group" ? title.trim() : null, members });
      }}>
        {error ? <div className="inline-alert" role="alert"><WarningCircle /> {error}</div> : null}
        <fieldset className="conversation-kind-picker">
          <legend>Conversation type</legend>
          <button type="button" className={kind === "direct" ? "is-selected" : ""} onClick={() => chooseKind("direct")} aria-pressed={kind === "direct"}><ChatCircleDots /><span><strong>Direct</strong><small>One human + one Agent</small></span></button>
          <button type="button" className={kind === "group" ? "is-selected" : ""} onClick={() => chooseKind("group")} aria-pressed={kind === "group"}><UsersThree /><span><strong>Group</strong><small>Named room with Agents</small></span></button>
        </fieldset>
        <label><span>Task environment</span><select value={taskId} onChange={(event) => setTaskId(event.target.value)}>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title} · {task.repository}</option>)}</select></label>
        {kind === "group" ? <label><span>Group name</span><input autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Release review" /></label> : null}
        <fieldset className="conversation-members">
          <legend>{kind === "direct" ? "Agent" : "Agent members"}</legend>
          {agents.map((agent) => {
            const checked = members.includes(agent.id);
            return (
              <label key={agent.id} className={checked ? "is-selected" : ""}>
                <input type={kind === "direct" ? "radio" : "checkbox"} name="conversation-agent" checked={checked} onChange={() => toggleMember(agent.id)} />
                <Avatar initials={agent.initials} color={agent.color} size="small" status={agent.status} />
                <span><strong>{agent.name}</strong><small>{agent.role} · {agent.driver}</small></span>
              </label>
            );
          })}
        </fieldset>
        <div className="modal-note"><ShieldCheck /> The task owns repository access and run guardrails; this conversation owns only its members and transcript.</div>
        <footer className="modal-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !valid}>{busy ? <SpinnerGap className="spin" /> : <ChatCircleDots />} Create chat</button></footer>
      </form>
    </Modal>
  );
}

function NewAgentModal({ busy, error, onClose, onSubmit }: { busy: boolean; error: string | null; onClose: () => void; onSubmit: (input: NewAgentInput) => void }) {
  const [form, setForm] = useState<NewAgentInput>({ handle: "", name: "", driver: "pi", role: "Coding agent" });
  const handleValid = /^[a-z][a-z0-9_-]{1,31}$/.test(form.handle);
  return (
    <Modal title="Add an Agent identity" description="Give one installed CLI connector a stable workspace identity. Harness, model, skills, and memory remain owned by that CLI." onClose={onClose}>
      <form className="modal-form" onSubmit={(event) => { event.preventDefault(); if (handleValid) onSubmit(form); }}>
        {error ? <div className="inline-alert" role="alert"><WarningCircle /> {error}</div> : null}
        <div className="form-row">
          <label><span>Handle</span><input autoFocus required value={form.handle} onChange={(event) => setForm({ ...form, handle: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })} placeholder="researcher" aria-invalid={Boolean(form.handle) && !handleValid} /><small>2–32 lowercase letters, numbers, _ or -</small></label>
          <label><span>Display name</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Researcher" /></label>
        </div>
        <label><span>CLI connector</span><select value={form.driver} onChange={(event) => setForm({ ...form, driver: event.target.value as NewAgentInput["driver"] })}>
          <option value="pi">Pi</option><option value="omp">Oh My Pi</option><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="hermes">Hermes</option><option value="deepseek">DeepSeek Harness</option>
        </select></label>
        <label><span>Role</span><input required value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })} placeholder="Repository research and documentation" /></label>
        <div className="selected-agent agent-definition-preview"><span className="agent-definition-mark"><Code /></span><span><strong>@{form.handle || "handle"} · {form.driver}</strong><small>Thin connector only · no planner privilege · no Mob-owned model layer</small></span></div>
        <footer className="modal-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !handleValid || !form.name.trim() || !form.role.trim()}>{busy ? <SpinnerGap className="spin" /> : <Plus />} Add Agent</button></footer>
      </form>
    </Modal>
  );
}

function MobileNavigation({ active, onChange }: { active: MobilePane; onChange: (pane: MobilePane) => void }) {
  return (
    <nav className="mobile-nav" aria-label="Workspace sections">
      <button className={active === "tasks" ? "is-active" : ""} onClick={() => onChange("tasks")}><ListBullets /><span>Tasks</span></button>
      <button className={active === "thread" ? "is-active" : ""} onClick={() => onChange("thread")}><ChatCircleDots /><span>Thread</span></button>
      <button className={active === "crew" ? "is-active" : ""} onClick={() => onChange("crew")}><UsersThree /><span>Crew</span></button>
    </nav>
  );
}

function LoginScreen({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onSubmit: (email: string, password: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <main className="login-screen">
      <section className="login-story" aria-label="Product overview">
        <div className="login-brand"><span className="brand-mark"><UsersThree weight="bold" /></span><strong>Mob Agent Crew</strong></div>
        <div className="login-story-copy">
          <p className="eyebrow">One task. One shared history.</p>
          <h1>Work with every coding agent in the same room.</h1>
          <p>Create a task channel, bring in the right agent with an @mention, and review every handoff, patch, and decision without copying context between terminals.</p>
          <div className="login-proof">
            <span><ChatCircleDots /><strong>Shared threads</strong><small>People and agents write to one auditable task history.</small></span>
            <span><ShieldCheck /><strong>Isolated workspaces</strong><small>Agents exchange revisions and artifacts, not writable directories.</small></span>
            <span><FileCode /><strong>Reviewable output</strong><small>Diffs and test evidence stay attached to the conversation.</small></span>
          </div>
        </div>
        <p className="login-footnote">Private workspace preview · built for small engineering teams</p>
      </section>
      <section className="login-entry">
        <form className="login-card" onSubmit={(event) => { event.preventDefault(); onSubmit(email.trim(), password); }}>
          <div className="login-card-icon"><UsersThree weight="duotone" /></div>
          <p className="eyebrow">Welcome back</p>
          <h2>Sign in to your workspace</h2>
          <p>Use your Mob Agent Crew account. Your session belongs to this workspace.</p>
          {error ? <div className="inline-alert login-alert" role="alert"><WarningCircle /> {error}</div> : null}
          <label><span>Email</span><input autoFocus required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" /></label>
          <label><span>Password</span><input required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" /></label>
          <button className="primary-button login-button" disabled={busy || !email.trim() || !password}>{busy ? <SpinnerGap className="spin" /> : <ArrowRight />} Continue to workspace</button>
          <small className="login-privacy"><ShieldCheck /> Credentials are sent only to your Mob Agent Crew server.</small>
        </form>
      </section>
    </main>
  );
}

export function App() {
  const [authState, setAuthState] = useState<AuthState>(() => sessionStorage.getItem("mob-authenticated") === "true" ? "authenticated" : "login");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [source, setSource] = useState<"api" | "demo">("api");
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Record<string, TaskDetail>>({});
  const [conversationCache, setConversationCache] = useState<Record<string, ConversationDetail>>({});
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [composer, setComposer] = useState("");
  const [mobilePane, setMobilePane] = useState<MobilePane>("thread");
  const [modal, setModal] = useState<ModalKind>(null);
  const [delegateAgentId, setDelegateAgentId] = useState("");
  const [modalBusy, setModalBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const [expandedArtifactId, setExpandedArtifactId] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);

  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const taskDetail = selectedTaskId ? detailCache[selectedTaskId] ?? null : null;
  const agents = bootstrap?.agents ?? [];
  const selectedConversation = conversations.find((conversation) => conversation.id === selectedConversationId)
    ?? (selectedTask ? primaryConversationFor(selectedTask) : null);
  const selectedConversationDetail = selectedConversationId ? conversationCache[selectedConversationId] ?? null : null;
  const detail = taskDetail && selectedConversation && !selectedConversation.isPrimary && selectedConversationDetail
    ? {
        ...taskDetail,
        messages: selectedConversationDetail.messages,
        runs: selectedConversationDetail.runs,
        participantIds: selectedConversationDetail.members.filter((member) => member.kind === "agent").map((member) => member.id),
      }
    : taskDetail;

  const filteredTasks = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return tasks;
    return tasks.filter((task) => `${task.title} ${task.repository} ${task.summary}`.toLowerCase().includes(query));
  }, [search, tasks]);

  const filteredConversations = useMemo(() => {
    const query = search.trim().toLowerCase();
    return conversations.filter((conversation) => {
      if (conversation.isPrimary) return false;
      if (!query) return true;
      const members = conversation.members.map((member) => `${member.name} ${member.handle}`).join(" ");
      return `${conversation.title ?? ""} ${conversation.kind} ${members} ${conversation.lastMessage?.content ?? ""}`.toLowerCase().includes(query);
    });
  }, [conversations, search]);

  const loadBootstrap = useCallback(async () => {
    setLoadState("loading");
    setFatalError(null);
    try {
      const live = await fetchBootstrap();
      let liveConversations: ConversationSummary[];
      try {
        liveConversations = await fetchConversations();
      } catch {
        liveConversations = live.tasks.map(primaryConversationFor);
      }
      setBootstrap(live);
      setTasks(live.tasks);
      setConversations(liveConversations);
      setSource("api");
      setSelectedTaskId((current) => current && live.tasks.some((task) => task.id === current) ? current : live.tasks[0]?.id ?? null);
      setSelectedConversationId((current) => current && liveConversations.some((conversation) => conversation.id === current)
        ? current
        : liveConversations.find((conversation) => conversation.isPrimary)?.id ?? live.tasks[0]?.id ?? null);
      setLoadState("ready");
    } catch (error) {
      if (!allowDemoFallback) {
        setFatalError(error instanceof Error ? error.message : "The workspace API is unavailable.");
        setLoadState("error");
        return;
      }
      try {
        const fallback = structuredClone(demoBootstrap);
        setBootstrap(fallback);
        setTasks(fallback.tasks);
        setConversations(fallback.tasks.map(primaryConversationFor));
        setSource("demo");
        setSelectedTaskId((current) => current && fallback.tasks.some((task) => task.id === current) ? current : fallback.tasks[0]?.id ?? null);
        setSelectedConversationId((current) => current && fallback.tasks.some((task) => task.id === current) ? current : fallback.tasks[0]?.id ?? null);
        setLoadState("ready");
      } catch {
        setFatalError(error instanceof Error ? error.message : "Unknown workspace error");
        setLoadState("error");
      }
    }
  }, []);

  useEffect(() => {
    if (authState === "authenticated") void loadBootstrap();
  }, [authState, loadBootstrap]);

  const loadTask = useCallback(async (task: TaskSummary, force = false) => {
    if (!force && detailCache[task.id]) return;
    setDetailLoading(true);
    setDetailError(null);
    setExpandedArtifactId(null);
    try {
      const next = source === "demo" ? getDemoTask(task.id) : await fetchTask(task);
      if (!next) throw new Error("This task has no detail payload yet.");
      setDetailCache((current) => ({ ...current, [task.id]: next }));
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "Unable to load the task thread.");
    } finally {
      setDetailLoading(false);
    }
  }, [detailCache, source]);

  useEffect(() => {
    if (selectedTask) void loadTask(selectedTask);
  }, [selectedTask?.id, source]);

  useEffect(() => {
    if (!selectedConversation || selectedConversation.isPrimary || source !== "api") return;
    let stopped = false;
    setConversationLoading(true);
    setConversationError(null);
    void fetchConversation(selectedConversation.id)
      .then((next) => {
        if (!stopped) setConversationCache((current) => ({ ...current, [next.id]: next }));
      })
      .catch((error: unknown) => {
        if (!stopped) setConversationError(error instanceof Error ? error.message : "Unable to load this conversation.");
      })
      .finally(() => { if (!stopped) setConversationLoading(false); });
    return () => { stopped = true; };
  }, [selectedConversation?.id, selectedConversation?.isPrimary, source]);

  useEffect(() => {
    if (source !== "api" || !selectedTask) return;
    let stopped = false;
    let inFlight = false;
    const task = selectedTask;
    const conversationId = selectedConversation && !selectedConversation.isPrimary ? selectedConversation.id : null;
    const refresh = async () => {
      if (stopped || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const [next, nextConversation] = await Promise.all([
          fetchTask(task),
          conversationId ? fetchConversation(conversationId) : Promise.resolve(null),
        ]);
        if (stopped) return;
        setDetailCache((current) => ({ ...current, [task.id]: next }));
        if (nextConversation) setConversationCache((current) => ({ ...current, [nextConversation.id]: nextConversation }));
        setTasks((current) => current.map((item) => item.id === task.id ? {
          ...item,
          status: next.status,
          resolution: next.resolution,
          updatedAt: next.updatedAt,
          summary: next.messages.at(-1)?.content ?? item.summary,
        } : item));
      } catch {
        // Keep the last good task snapshot; explicit actions still surface request errors.
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2_500);
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [source, selectedTask?.id, selectedConversation?.id, selectedConversation?.isPrimary]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "n" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const target = event.target as HTMLElement | null;
        if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
        event.preventDefault();
        setModal("new-task");
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => () => { if (noticeTimer.current) window.clearTimeout(noticeTimer.current); }, []);

  function updateDetail(taskId: string, updater: (value: TaskDetail) => TaskDetail) {
    setDetailCache((current) => {
      const existing = current[taskId];
      if (!existing) return current;
      return { ...current, [taskId]: updater(existing) };
    });
  }

  function updateActiveTranscript(updater: (value: { messages: ThreadMessage[]; runs: AgentRun[] }) => { messages: ThreadMessage[]; runs: AgentRun[] }) {
    if (selectedConversation && !selectedConversation.isPrimary) {
      setConversationCache((current) => {
        const existing = current[selectedConversation.id];
        if (!existing) return current;
        return { ...current, [selectedConversation.id]: { ...existing, ...updater(existing) } };
      });
      return;
    }
    if (detail) updateDetail(detail.id, (current) => ({ ...current, ...updater(current) }));
  }

  function updateTaskSummary(taskId: string, patch: Partial<TaskSummary>) {
    setTasks((current) => current.map((task) => task.id === taskId ? { ...task, ...patch } : task));
  }

  function selectTask(taskId: string) {
    setSelectedTaskId(taskId);
    setSelectedConversationId(conversations.find((conversation) => conversation.taskId === taskId && conversation.isPrimary)?.id ?? taskId);
    setMobilePane("thread");
    setComposer("");
    setActionError(null);
  }

  function selectConversation(conversation: ConversationSummary) {
    setSelectedTaskId(conversation.taskId);
    setSelectedConversationId(conversation.id);
    setMobilePane("thread");
    setComposer("");
    setActionError(null);
  }

  async function submitComposer(invoke: boolean, agentId?: string) {
    if (!detail || !bootstrap || !composer.trim() || actionBusy) return;
    if (invoke && !selectedConversation) {
      setActionError("Choose a conversation before running an Agent.");
      return;
    }
    const content = composer.trim();
    const optimisticId = `message-${crypto.randomUUID()}`;
    const optimistic: ThreadMessage = {
      id: optimisticId,
      actorId: bootstrap.currentUser.id,
      actorName: bootstrap.currentUser.name,
      actorKind: "human",
      actorInitials: bootstrap.currentUser.initials,
      content,
      createdAt: new Date().toISOString(),
      runId: null,
      artifactIds: [],
      delivery: source === "api" ? "pending" : "sent",
    };
    setComposer("");
    setActionBusy(true);
    setActionError(null);
    updateActiveTranscript((current) => ({ ...current, messages: [...current.messages, optimistic] }));
    updateTaskSummary(detail.id, { updatedAt: optimistic.createdAt, summary: content });
    if (selectedConversation) {
      setConversations((current) => current.map((conversation) => conversation.id === selectedConversation.id
        ? { ...conversation, updatedAt: optimistic.createdAt, lastMessage: optimistic }
        : conversation));
    }
    try {
      if (source === "api") {
        if (selectedConversation) {
          const result = await postConversationMessage(selectedConversation.id, content, invoke
            ? { invoke: true, ...(agentId ? { agent: agentId } : {}) }
            : { invoke: false });
          updateActiveTranscript((current) => ({
            messages: current.messages.map((message) => message.id === optimisticId ? { ...result.message, actorName: optimistic.actorName, actorInitials: optimistic.actorInitials, actorKind: "human" } : message),
            runs: [...current.runs, ...result.runs],
          }));
          if (selectedConversation.isPrimary) {
            const refreshed = await fetchTask(detail);
            setDetailCache((current) => ({ ...current, [detail.id]: refreshed }));
          } else {
            const refreshed = await fetchConversation(selectedConversation.id);
            setConversationCache((current) => ({ ...current, [refreshed.id]: refreshed }));
          }
        } else {
          if (invoke) throw new Error("This server does not expose explicit conversation runs yet.");
          const saved = await postMessage(detail.id, content);
          updateActiveTranscript((current) => ({ ...current, messages: current.messages.map((message) => message.id === optimisticId ? saved : message) }));
        }
      } else if (invoke && agentId) {
        const agent = agents.find((entry) => entry.id === agentId);
        const run: AgentRun = {
          id: `run-${crypto.randomUUID()}`,
          agentId,
          role: "Explicit chat run",
          status: "queued",
          attempt: 1,
          startedAt: null,
          finishedAt: null,
          summary: content,
          parentRunId: null,
        };
        updateActiveTranscript((current) => ({
          messages: current.messages.map((message) => message.id === optimisticId ? { ...message, delivery: "sent" } : message),
          runs: [...current.runs, run],
        }));
        setActionError(agent ? `${agent.name} was queued from the explicit Run action (demo).` : null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Message failed to send.";
      setActionError(message);
      updateActiveTranscript((current) => ({ ...current, messages: current.messages.map((entry) => entry.id === optimisticId ? { ...entry, delivery: "failed" } : entry) }));
      setComposer(content);
    } finally {
      setActionBusy(false);
    }
  }

  async function handleSend() {
    await submitComposer(false);
  }

  async function handleRunAgent(agentId: string) {
    await submitComposer(true, agentId);
  }

  function openDelegate(agentId = "") {
    setDelegateAgentId(agentId);
    setModalError(null);
    setModal("delegate");
  }

  async function handleDelegate(input: { agentId: string; deliverable: string }) {
    if (!detail) return;
    setModalBusy(true);
    setModalError(null);
    try {
      const agent = agents.find((entry) => entry.id === input.agentId);
      let run: AgentRun | null = null;
      if (source === "api") run = await postDelegation(detail.id, input);
      if (!run) {
        run = {
          id: `run-${crypto.randomUUID()}`,
          agentId: input.agentId,
          role: "Delegated handoff",
          status: "queued",
          attempt: 1,
          startedAt: null,
          finishedAt: null,
          summary: input.deliverable,
          parentRunId: detail.runs.at(-1)?.id ?? null,
        };
      }
      const system: ThreadMessage = {
        id: `message-${crypto.randomUUID()}`,
        actorId: "system",
        actorName: "Crew control",
        actorKind: "system",
        actorInitials: "CC",
        content: `Delegated to @${agent?.name ?? "agent"}: ${input.deliverable}`,
        createdAt: new Date().toISOString(),
        runId: run.id,
        artifactIds: [],
        delivery: "sent",
      };
      updateDetail(detail.id, (current) => ({
        ...current,
        participantIds: current.participantIds.includes(input.agentId) ? current.participantIds : [...current.participantIds, input.agentId],
        delegationDepth: Math.min(current.maxDelegationDepth, current.delegationDepth + 1),
        runs: [...current.runs, run!],
        messages: [...current.messages, system],
        status: "running",
      }));
      updateTaskSummary(detail.id, { status: "running", updatedAt: system.createdAt });
      setModal(null);
    } catch (error) {
      setModalError(error instanceof Error ? error.message : "Delegation could not be created.");
    } finally {
      setModalBusy(false);
    }
  }

  async function handleCreateTask(input: NewTaskInput) {
    setModalBusy(true);
    setModalError(null);
    try {
      let created: TaskDetail;
      if (source === "api") {
        created = await createTask(input);
      } else {
        const agent = agents.find((entry) => entry.id === input.agentId);
        const summary: TaskSummary = {
          id: `task-${crypto.randomUUID()}`,
          title: input.title,
          repository: input.repository,
          branch: input.baseRef,
          status: "queued",
          resolution: "unreviewed",
          updatedAt: new Date().toISOString(),
          unread: 0,
          participantIds: input.agentId ? [input.agentId] : [],
          summary: input.initialMessage,
        };
        created = createDemoDetail(summary, `@${agent?.name ?? "agent"} ${input.initialMessage}`);
        if (agent) {
          created.runs = [{ id: `run-${crypto.randomUUID()}`, agentId: agent.id, role: "Initial assignment", status: "queued", attempt: 1, startedAt: null, finishedAt: null, summary: input.initialMessage, parentRunId: null }];
        }
      }
      setTasks((current) => [created, ...current]);
      const primary = primaryConversationFor(created);
      setConversations((current) => [primary, ...current]);
      setDetailCache((current) => ({ ...current, [created.id]: created }));
      setSelectedTaskId(created.id);
      setSelectedConversationId(primary.id);
      setModal(null);
      setMobilePane("thread");
    } catch (error) {
      setModalError(error instanceof Error ? error.message : "Task could not be created.");
    } finally {
      setModalBusy(false);
    }
  }

  async function handleCreateConversation(input: NewConversationInput) {
    setModalBusy(true);
    setModalError(null);
    try {
      if (source !== "api") throw new Error("Connect the server to create direct and group conversations.");
      const created = await createConversation(input);
      setConversations((current) => [created, ...current]);
      setConversationCache((current) => ({ ...current, [created.id]: created }));
      setSelectedTaskId(created.taskId);
      setSelectedConversationId(created.id);
      setModal(null);
      setMobilePane("thread");
    } catch (error) {
      setModalError(error instanceof Error ? error.message : "Conversation could not be created.");
    } finally {
      setModalBusy(false);
    }
  }

  async function handleCreateAgent(input: NewAgentInput) {
    setModalBusy(true);
    setModalError(null);
    try {
      if (source !== "api") throw new Error("Connect the server to add an Agent identity.");
      await createAgent(input);
      const live = await fetchBootstrap();
      setBootstrap(live);
      setTasks(live.tasks);
      setModal(null);
    } catch (error) {
      setModalError(error instanceof Error ? error.message : "Agent could not be added.");
    } finally {
      setModalBusy(false);
    }
  }

  function importedContextToArtifact(context: ImportedContext, producerAgentId: string): Artifact {
    return {
      id: context.id,
      name: context.name,
      kind: "file",
      summary: context.summary,
      producerAgentId,
      createdAt: context.createdAt,
      revision: detail?.baseRef ?? "task-context",
      content: context.content,
      language: context.kind === "markdown" ? "markdown" : "text",
      downloadUrl: null,
    };
  }

  function addImportedContext(context: ImportedContext) {
    if (!detail || !bootstrap) return;
    const artifact = importedContextToArtifact(context, bootstrap.currentUser.id);
    const system: ThreadMessage = {
      id: `message-${crypto.randomUUID()}`,
      actorId: "system",
      actorName: "Crew control",
      actorKind: "system",
      actorInitials: "CC",
      content: `${context.kind === "github" ? "GitHub context" : "Markdown context"} added by ${bootstrap.currentUser.name}: ${context.name}`,
      createdAt: context.createdAt,
      runId: null,
      artifactIds: [artifact.id],
      delivery: "sent",
    };
    updateDetail(detail.id, (current) => ({ ...current, artifacts: [...current.artifacts, artifact], messages: [...current.messages, system] }));
    setExpandedArtifactId(artifact.id);
  }

  async function handleUpload(file: File) {
    if (!detail || !bootstrap) return;
    if (!/\.md$/i.test(file.name)) {
      setActionError("Only .md files can be added as task context in this release.");
      return;
    }
    if (file.size > 1_048_576) {
      setActionError("Markdown context must be 1 MB or smaller.");
      return;
    }
    setActionBusy(true);
    setActionError(null);
    try {
      const context = source === "api"
        ? await uploadMarkdown(detail.id, file)
        : { id: `context-${crypto.randomUUID()}`, name: file.name, kind: "markdown" as const, summary: `${Math.max(1, Math.ceil(file.size / 1024))} KB Markdown context`, content: await file.text(), sourceUrl: null, createdAt: new Date().toISOString() };
      addImportedContext(context);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Markdown upload failed.");
    } finally {
      setActionBusy(false);
    }
  }

  async function handleGithubImport(url: string) {
    if (!detail) return;
    setModalBusy(true);
    setModalError(null);
    try {
      const context = source === "api"
        ? await importGithubUrl(detail.id, url)
        : { id: `context-${crypto.randomUUID()}`, name: url.replace("https://github.com/", ""), kind: "github" as const, summary: "GitHub link imported into shared context", content: `Source: ${url}\n\nDemo fallback stores the URL. A connected server resolves metadata and a normalized text snapshot.`, sourceUrl: url, createdAt: new Date().toISOString() };
      addImportedContext(context);
      setModal(null);
    } catch (error) {
      setModalError(error instanceof Error ? error.message : "GitHub context import failed.");
    } finally {
      setModalBusy(false);
    }
  }

  async function handleCancelRun(runId: string) {
    if (!detail) return;
    setBusyRunId(runId);
    setActionError(null);
    try {
      if (source === "api") await cancelRun(runId);
      updateDetail(detail.id, (current) => ({ ...current, runs: current.runs.map((run) => run.id === runId ? { ...run, status: "cancelled", finishedAt: new Date().toISOString() } : run) }));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Run could not be cancelled.");
    } finally {
      setBusyRunId(null);
    }
  }

  async function handleRetryRun(runId: string) {
    if (!detail) return;
    const failed = detail.runs.find((run) => run.id === runId);
    if (!failed) return;
    setBusyRunId(runId);
    setActionError(null);
    try {
      const retried = source === "api" ? await retryRun(runId) : null;
      const next: AgentRun = retried ?? { ...failed, id: `run-${crypto.randomUUID()}`, status: "queued", attempt: failed.attempt + 1, startedAt: null, finishedAt: null, parentRunId: failed.id, summary: "Queued as a clean attempt; prior logs remain available." };
      updateDetail(detail.id, (current) => ({ ...current, runs: [...current.runs, next], status: "running" }));
      updateTaskSummary(detail.id, { status: "running", updatedAt: new Date().toISOString() });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Run could not be retried.");
    } finally {
      setBusyRunId(null);
    }
  }

  async function handleReview(decision: "accept" | "reject" | "request_changes") {
    if (!detail || !bootstrap) return;
    setActionBusy(true);
    setActionError(null);
    try {
      if (source === "api") await reviewTask(detail.id, decision);
      const accepted = decision === "accept";
      const now = new Date().toISOString();
      const system: ThreadMessage = {
        id: `message-${crypto.randomUUID()}`,
        actorId: "system",
        actorName: "Crew control",
        actorKind: "system",
        actorInitials: "CC",
        content: accepted ? `${bootstrap.currentUser.name} approved the combined result. Publication still requires a separate human action.` : `${bootstrap.currentUser.name} requested changes. The task is open for a bounded follow-up.`,
        createdAt: now,
        runId: null,
        artifactIds: [],
        delivery: "sent",
      };
      updateDetail(detail.id, (current) => ({ ...current, status: accepted ? "completed" : "open", resolution: accepted ? "accepted" : "unreviewed", messages: [...current.messages, system] }));
      updateTaskSummary(detail.id, { status: accepted ? "completed" : "open", resolution: accepted ? "accepted" : "unreviewed", updatedAt: now });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Review decision could not be saved.");
    } finally {
      setActionBusy(false);
    }
  }

  async function handlePublish() {
    if (!detail || !bootstrap || actionBusy) return;
    if (!window.confirm("Publish the accepted task changes to a new mob/ branch on GitHub?")) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const published = source === "api"
        ? await publishTask(detail.id)
        : { branch: `mob/${detail.id.slice(0, 8)}`, commit: "demo0000", changedFiles: ["README.md"] };
      const now = new Date().toISOString();
      const system: ThreadMessage = {
        id: `message-${crypto.randomUUID()}`,
        actorId: "system",
        actorName: "Crew control",
        actorKind: "system",
        actorInitials: "CC",
        content: `${bootstrap.currentUser.name} published ${published.branch} at ${published.commit.slice(0, 8)} (${published.changedFiles.length} files).`,
        createdAt: now,
        runId: null,
        artifactIds: [],
        delivery: "sent",
      };
      updateDetail(detail.id, (current) => ({
        ...current,
        baseRef: published.branch,
        resolution: "branch_published",
        messages: [...current.messages, system],
      }));
      updateTaskSummary(detail.id, {
        branch: published.branch,
        resolution: "branch_published",
        updatedAt: now,
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The branch could not be published.");
    } finally {
      setActionBusy(false);
    }
  }

  function handleOpenArtifact(artifactId: string) {
    setExpandedArtifactId((current) => current === artifactId ? null : artifactId);
    setMobilePane("crew");
    window.setTimeout(() => document.getElementById(`artifact-${artifactId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
  }

  async function handleLogin(email: string, password: string) {
    setAuthState("signing-in");
    setLoginError(null);
    try {
      await createSession(email, password);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setLoginError("The email or password is incorrect.");
        setAuthState("login");
        return;
      }
      if (!allowDemoFallback) {
        setLoginError(
          error instanceof ApiError && error.status >= 500
            ? "The workspace server is unavailable. Retry shortly."
            : error instanceof Error
              ? error.message
              : "The workspace server is unavailable.",
        );
        setAuthState("login");
        return;
      }
      // Local Vite development can open a clearly labelled demo without an API.
      // Production never crosses this boundary: connectivity failures stay visible.
    }
    sessionStorage.setItem("mob-authenticated", "true");
    sessionStorage.setItem("mob-account-email", email);
    setAuthState("authenticated");
  }

  if (authState !== "authenticated") {
    return <LoginScreen busy={authState === "signing-in"} error={loginError} onSubmit={(email, password) => void handleLogin(email, password)} />;
  }

  if (loadState === "loading") return <AppLoading />;
  if (loadState === "error" || !bootstrap) return <FatalError message={fatalError ?? "The workspace could not be initialized."} onRetry={() => void loadBootstrap()} />;

  return (
    <div className={classNames("app-shell", `mobile-pane-${mobilePane}`)}>
      <a className="skip-link" href="#main-content">Skip to task thread</a>
      <header className="global-bar">
        <div className="brand"><span className="brand-mark"><UsersThree weight="bold" /></span><strong>Mob Agent Crew</strong><span className="product-badge">Preview</span></div>
        <div className="global-search"><MagnifyingGlass /><span>Search this workspace</span><kbd>⌘ K</kbd></div>
        <div className="global-meta"><span className={classNames("live-indicator", source === "demo" && "is-demo")}><span />{source === "api" ? "Connected" : "Demo"}</span><button className="icon-button" aria-label="Help"><ShieldCheck /></button><Avatar initials={bootstrap.currentUser.initials} color="#7c68ee" size="small" /></div>
      </header>
      <div className="workspace-grid">
        <TaskSidebar
          bootstrap={bootstrap}
          tasks={filteredTasks}
          conversations={filteredConversations}
          selectedTaskId={selectedTaskId}
          selectedConversationId={selectedConversationId}
          search={search}
          source={source}
          onSearch={setSearch}
          onSelect={selectTask}
          onSelectConversation={selectConversation}
          onNewTask={() => { setModalError(null); setModal("new-task"); }}
          onNewConversation={() => { setModalError(null); setModal("new-conversation"); }}
          onNewAgent={() => { setModalError(null); setModal("new-agent"); }}
          onReconnect={() => void loadBootstrap()}
        />
        <ThreadPane
          task={detail}
          conversation={selectedConversation}
          agents={agents}
          loading={detailLoading || conversationLoading}
          error={detailError ?? conversationError}
          composer={composer}
          actionBusy={actionBusy}
          actionError={actionError}
          onComposerChange={setComposer}
          onSend={() => void handleSend()}
          onRunAgent={(agentId) => void handleRunAgent(agentId)}
          onUpload={(file) => void handleUpload(file)}
          onOpenGithub={() => { setModalError(null); setModal("github"); }}
          onOpenArtifact={handleOpenArtifact}
          onRetryLoad={() => selectedTask && void loadTask(selectedTask, true)}
          onOpenDelegate={() => openDelegate()}
          onReview={(decision) => void handleReview(decision)}
          onPublish={() => void handlePublish()}
        />
        <WorkspaceInspector task={detail} agents={agents} onDelegate={openDelegate} source={source} />
      </div>
      <MobileNavigation active={mobilePane} onChange={setMobilePane} />

      {modal === "new-task" ? <NewTaskModal agents={agents} busy={modalBusy} error={modalError} onClose={() => setModal(null)} onSubmit={(input) => void handleCreateTask(input)} /> : null}
      {modal === "new-conversation" ? <NewConversationModal tasks={tasks} agents={agents} initialTaskId={selectedTaskId ?? ""} busy={modalBusy} error={modalError} onClose={() => setModal(null)} onSubmit={(input) => void handleCreateConversation(input)} /> : null}
      {modal === "new-agent" ? <NewAgentModal busy={modalBusy} error={modalError} onClose={() => setModal(null)} onSubmit={(input) => void handleCreateAgent(input)} /> : null}
      {modal === "delegate" ? <DelegateModal agents={agents} initialAgentId={delegateAgentId} busy={modalBusy} error={modalError} onClose={() => setModal(null)} onSubmit={(input) => void handleDelegate(input)} /> : null}
      {modal === "github" ? <GithubModal busy={modalBusy} error={modalError} onClose={() => setModal(null)} onSubmit={(url) => void handleGithubImport(url)} /> : null}
    </div>
  );
}
