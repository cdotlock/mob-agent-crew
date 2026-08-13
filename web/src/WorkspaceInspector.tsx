import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from "@phosphor-icons/react/ArrowCounterClockwise";
import { BookOpenTextIcon as BookOpenText } from "@phosphor-icons/react/BookOpenText";
import { CaretRightIcon as CaretRight } from "@phosphor-icons/react/CaretRight";
import { CheckIcon as Check } from "@phosphor-icons/react/Check";
import { CodeIcon as Code } from "@phosphor-icons/react/Code";
import { FileCodeIcon as FileCode } from "@phosphor-icons/react/FileCode";
import { FileIcon as File } from "@phosphor-icons/react/File";
import { FolderIcon as Folder } from "@phosphor-icons/react/Folder";
import { FolderOpenIcon as FolderOpen } from "@phosphor-icons/react/FolderOpen";
import { PaperPlaneRightIcon as PaperPlaneRight } from "@phosphor-icons/react/PaperPlaneRight";
import { RobotIcon as Robot } from "@phosphor-icons/react/Robot";
import { SpinnerGapIcon as SpinnerGap } from "@phosphor-icons/react/SpinnerGap";
import { StopCircleIcon as StopCircle } from "@phosphor-icons/react/StopCircle";
import { TerminalWindowIcon as TerminalWindow } from "@phosphor-icons/react/TerminalWindow";
import { WarningCircleIcon as WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import {
  fetchFile,
  fetchFiles,
  fetchKnowledge,
  fetchKnowledgeFile,
  fetchRunEvents,
  sendRunCommand,
} from "./api.js";
import type {
  AgentProfile,
  AgentRun,
  FileContents,
  FileEntry,
  FileScope,
  KnowledgeEntry,
  RunEvent,
  TaskDetail,
} from "./model.js";

type InspectorTab = "terminal" | "files" | "wiki" | "agent";

const terminalStatuses = new Set(["succeeded", "failed", "cancelled", "skipped"]);

type DemoFile = { scope: FileScope; path: string; language: string; content: string };

const demoFiles: DemoFile[] = [
  {
    scope: "repository",
    path: "README.md",
    language: "markdown",
    content: "# Mob Agent Crew\n\nA small-team workspace where humans and CLI Agents share conversations, task worktrees, files, Wiki context, and observable run events.",
  },
  {
    scope: "repository",
    path: "docs/llm-control.md",
    language: "markdown",
    content: "# LLM control guide\n\nUse `mob login`, `mob conversation send`, and `mob run watch` to control the same workspace from any external CLI.",
  },
  {
    scope: "repository",
    path: "src/agents/registry.ts",
    language: "typescript",
    content: "// Thin connector registry\n// pi · omp · claude · codex · hermes · deepseek\nexport class AgentDriverRegistry { /* connector lookup */ }",
  },
  {
    scope: "workspace",
    path: "state/workspaces/workspace-demo/workspace.json",
    language: "json",
    content: '{\n  "id": "workspace-demo",\n  "name": "Lunaverse engineering",\n  "storage": "canonical file ledger"\n}',
  },
  {
    scope: "workspace",
    path: "state/workspaces/workspace-demo/tasks/task-webhook/messages/001-clock.md",
    language: "markdown",
    content: "<!-- {\"actorId\":\"user-clock\",\"conversationId\":\"task-webhook\"} -->\n@Mira reproduce the flaky webhook retry spec and return fresh evidence.",
  },
  {
    scope: "workspace",
    path: "knowledge/wiki/repositories/mob-agent-crew/index.md",
    language: "markdown",
    content: "# mob-agent-crew\n\nRevision: main@7c9d2a1\n\n## Operating boundary\nMob owns identities, conversations, files, commands, and events. Each external CLI owns its own harness internals.",
  },
];

const demoKnowledge = [
  {
    path: "wiki/repositories/mob-agent-crew/index.md",
    area: "wiki" as const,
    title: "mob-agent-crew repository index",
    revision: "main@7c9d2a1",
    content: demoFiles.find((file) => file.path === "knowledge/wiki/repositories/mob-agent-crew/index.md")!.content,
  },
  {
    path: "raw/repositories/mob-agent-crew/7c9d2a1/README.md",
    area: "raw" as const,
    title: "README.md",
    revision: "main@7c9d2a1",
    content: demoFiles.find((file) => file.path === "README.md")!.content,
  },
];

function demoFileListing(scope: FileScope, directory: string): FileEntry[] {
  const prefix = directory ? `${directory}/` : "";
  const entries = new Map<string, FileEntry>();
  for (const file of demoFiles.filter((entry) => entry.scope === scope && entry.path.startsWith(prefix))) {
    const remainder = file.path.slice(prefix.length);
    const [name, ...rest] = remainder.split("/");
    if (!name) continue;
    const path = `${prefix}${name}`;
    const isDirectory = rest.length > 0;
    entries.set(name, {
      name,
      path,
      kind: isDirectory ? "directory" : "file",
      bytes: isDirectory ? null : file.content.length,
      updatedAt: new Date().toISOString(),
    });
  }
  return [...entries.values()].sort((left, right) => Number(right.kind === "directory") - Number(left.kind === "directory") || left.name.localeCompare(right.name));
}

function demoFileContents(scope: FileScope, path: string): FileContents {
  const file = demoFiles.find((entry) => entry.scope === scope && entry.path === path);
  if (!file) throw new Error("Demo file is unavailable.");
  return { scope, path, name: path.split("/").at(-1) ?? path, bytes: file.content.length, language: file.language, content: file.content, truncated: false };
}

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function clock(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function shortBytes(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.ceil(bytes / 1_024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function eventMessage(event: RunEvent): string {
  const message = typeof event.payload.message === "string" ? event.payload.message : "";
  const nativeType = typeof event.payload.nativeType === "string" ? event.payload.nativeType : "";
  if (event.type === "runtime.started") return "process started";
  if (event.type === "workspace.sync.started") return message || "preparing repository and Wiki";
  if (event.type === "workspace.sync.completed") return message || "repository and Wiki are ready";
  if (event.type === "runtime.ready") {
    const details = [event.payload.provider, event.payload.model]
      .filter((value): value is string => typeof value === "string" && Boolean(value));
    const tools = Array.isArray(event.payload.tools) ? `${event.payload.tools.length} tools` : "";
    const skills = Array.isArray(event.payload.skills) ? `${event.payload.skills.length} skills` : "";
    return ["connector ready", ...details, tools, skills].filter(Boolean).join(" · ");
  }
  if (event.type === "command.accepted") return message || "live instruction accepted";
  if (event.type === "command.rejected") return message || "live instruction rejected";
  if (event.type === "turn.started") return "agent is reasoning";
  if (event.type === "message.delta") return message;
  if (event.type === "message.completed") return message || "response completed";
  if (event.type === "tool.started") return `$ ${message || nativeType || "tool"}`;
  if (event.type === "tool.progress") return message || "tool output received";
  if (event.type === "tool.completed") return `✓ ${message || nativeType || "tool completed"}`;
  if (event.type === "turn.completed") return message || "turn completed";
  if (event.type === "turn.failed" || event.type === "error") return message || "run failed";
  if (event.type === "warning") return message || "runtime warning";
  if (event.type === "process.exited") return "process exited";
  return message || event.type.replaceAll(".", " ");
}

function terminalLines(events: RunEvent[]): Array<{ key: string; time: string; kind: string; text: string }> {
  const lines: Array<{ key: string; time: string; kind: string; text: string }> = [];
  for (const event of events) {
    const text = eventMessage(event);
    if (!text) continue;
    const previous = lines.at(-1);
    if (event.type === "message.delta" && previous?.kind === "message.delta") {
      previous.text += text;
      continue;
    }
    lines.push({ key: `${event.sequence}-${event.type}`, time: clock(event.createdAt), kind: event.type, text });
  }
  return lines.slice(-120);
}

function runLabel(run: AgentRun, agent: AgentProfile | undefined): string {
  return `${agent?.name ?? "Agent"} · attempt ${run.attempt}`;
}

function demoRunEvents(run: AgentRun, agent: AgentProfile | undefined): RunEvent[] {
  const start = new Date(run.startedAt ?? new Date().toISOString()).getTime();
  const at = (offsetSeconds: number) => new Date(start + offsetSeconds * 1_000).toISOString();
  const events: RunEvent[] = [
    { sequence: 1, type: "workspace.sync.started", payload: { message: "preparing the task worktree" }, createdAt: at(0) },
    { sequence: 2, type: "workspace.sync.completed", payload: { message: "repository updated · Wiki context loaded" }, createdAt: at(2) },
    {
      sequence: 3,
      type: "runtime.ready",
      payload: { provider: agent?.driver ?? "CLI", model: "MobAI Router", tools: ["shell", "files", "git"], skills: ["repository knowledge"] },
      createdAt: at(3),
    },
    { sequence: 4, type: "turn.started", payload: {}, createdAt: at(4) },
    { sequence: 5, type: "tool.started", payload: { message: "rg -n \"retryKey\" src test" }, createdAt: at(7) },
    { sequence: 6, type: "tool.completed", payload: { message: "source search · 6 matches" }, createdAt: at(8) },
    { sequence: 7, type: "tool.started", payload: { message: "pnpm test -- retry" }, createdAt: at(18) },
  ];
  if (run.status === "failed") {
    events.push({ sequence: 8, type: "turn.failed", payload: { message: run.summary || "Agent run failed" }, createdAt: at(22) });
    return events;
  }
  if (!terminalStatuses.has(run.status)) {
    events.push({ sequence: 8, type: "tool.progress", payload: { message: "focused suite is still running…" }, createdAt: at(22) });
    return events;
  }
  events.push(
    { sequence: 8, type: "tool.completed", payload: { message: "focused tests · 100 passed" }, createdAt: at(24) },
    { sequence: 9, type: "message.completed", payload: { message: run.summary || "Task completed with reviewable evidence." }, createdAt: at(26) },
    { sequence: 10, type: "turn.completed", payload: { message: "artifact published · writer lease released" }, createdAt: at(27) },
    { sequence: 11, type: "process.exited", payload: {}, createdAt: at(28) },
  );
  return events;
}

function AgentTerminal({ task, agents, demo }: { task: TaskDetail; agents: AgentProfile[]; demo: boolean }) {
  const latestRun = task.runs.at(-1) ?? null;
  const [selectedRunId, setSelectedRunId] = useState<string | null>(latestRun?.id ?? null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [cursor, setCursor] = useState(0);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const selectedRun = task.runs.find((run) => run.id === selectedRunId) ?? latestRun;
  const selectedAgent = selectedRun ? agents.find((agent) => agent.id === selectedRun.agentId) : undefined;
  const lines = useMemo(() => terminalLines(events), [events]);

  useEffect(() => {
    setSelectedRunId(latestRun?.id ?? null);
  }, [task.id, latestRun?.id]);

  useEffect(() => {
    setEvents([]);
    setCursor(0);
    setError(null);
    if (!selectedRunId) {
      setState("idle");
      return;
    }
    if (demo && selectedRun) {
      const demoEvents = demoRunEvents(selectedRun, selectedAgent);
      setEvents(demoEvents);
      setCursor(demoEvents.at(-1)?.sequence ?? 0);
      setState("ready");
      return;
    }
    let stopped = false;
    let nextCursor = 0;
    let inFlight = false;
    const load = async () => {
      if (stopped || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      setState((current) => current === "idle" ? "loading" : current);
      try {
        const page = await fetchRunEvents(selectedRunId, nextCursor);
        if (stopped) return;
        nextCursor = Math.max(nextCursor, page.cursor);
        setCursor(nextCursor);
        setEvents((current) => {
          const known = new Set(current.map((event) => event.sequence));
          return [...current, ...page.events.filter((event) => !known.has(event.sequence))].slice(-600);
        });
        setState("ready");
        setError(null);
      } catch (loadError) {
        if (stopped) return;
        setState("error");
        setError(loadError instanceof Error ? loadError.message : "Run events are unavailable.");
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = selectedRun && terminalStatuses.has(selectedRun.status)
      ? undefined
      : window.setInterval(() => void load(), 1_000);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [demo, selectedAgent?.driver, selectedRun?.status, selectedRunId]);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: "smooth" });
  }, [lines.length, cursor]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selectedRun || terminalStatuses.has(selectedRun.status) || !command.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      if (demo) {
        const sequence = (events.at(-1)?.sequence ?? 0) + 1;
        setEvents((current) => [...current, {
          sequence,
          type: "command.accepted",
          payload: { message: command.trim() },
          createdAt: new Date().toISOString(),
        }]);
      } else {
        await sendRunCommand(selectedRun.id, "steer", command.trim());
      }
      setCommand("");
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "The command was not accepted.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="terminal-panel" aria-label="Agent terminal">
      <div className="terminal-toolbar">
        <span className="terminal-lights"><i /><i /><i /></span>
        {task.runs.length ? (
          <select value={selectedRun?.id ?? ""} onChange={(event) => setSelectedRunId(event.target.value)} aria-label="Choose an Agent run">
            {[...task.runs].reverse().map((run) => (
              <option value={run.id} key={run.id}>{runLabel(run, agents.find((agent) => agent.id === run.agentId))}</option>
            ))}
          </select>
        ) : <span className="terminal-title">No run yet</span>}
        {selectedRun ? <span className={classes("terminal-status", `is-${selectedRun.status}`)}>{selectedRun.status}</span> : null}
      </div>
      <div className="terminal-output" ref={outputRef} role="log" aria-live="off">
        {selectedRun ? (
          <div className="terminal-session-line">
            <span>{clock(selectedRun.startedAt ?? task.updatedAt)}</span>
            <strong>$ mob run {selectedRun.id.slice(0, 8)}</strong>
            <small>{selectedAgent?.driver ?? "agent"} · {selectedAgent?.role ?? selectedRun.role}</small>
          </div>
        ) : null}
        {state === "loading" ? <p className="terminal-placeholder"><SpinnerGap className="spin" /> Connecting to run events…</p> : null}
        {lines.map((line) => (
          <div className={classes("terminal-line", line.kind.includes("error") || line.kind.includes("failed") ? "is-error" : line.kind.startsWith("tool") ? "is-tool" : line.kind.startsWith("message") ? "is-message" : "")} key={line.key}>
            <time>{line.time}</time><span>{line.text}</span>
          </div>
        ))}
        {!selectedRun ? <p className="terminal-placeholder">Send a message to an Agent. Its actual process, tools, output, and exit state will stream here.</p> : null}
        {selectedRun && state === "ready" && !lines.length ? <p className="terminal-placeholder">Run accepted. Waiting for the connector to emit its first event…</p> : null}
      </div>
      {error ? <div className="terminal-error" role="alert"><WarningCircle /> {error}</div> : null}
      <form className="terminal-command" onSubmit={(event) => void submit(event)}>
        <span>›</span>
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder={selectedRun && !terminalStatuses.has(selectedRun.status) ? `Steer @${selectedAgent?.name ?? "agent"} while it works…` : "Start a new instruction from the conversation"}
          disabled={!selectedRun || terminalStatuses.has(selectedRun.status) || sending}
          aria-label="Steer the active Agent run"
        />
        <button type="submit" disabled={!command.trim() || sending || !selectedRun || terminalStatuses.has(selectedRun.status)} aria-label="Send command to active run">
          {sending ? <SpinnerGap className="spin" /> : <PaperPlaneRight weight="fill" />}
        </button>
      </form>
    </section>
  );
}

function FilePreview({ file }: { file: FileContents }) {
  return (
    <div className="file-preview">
      <div className="file-preview-header">
        <span><FileCode /> {file.name}</span><small>{shortBytes(file.bytes)}{file.truncated ? " · preview truncated" : ""}</small>
      </div>
      <pre><code>{file.content || "Empty file"}</code></pre>
    </div>
  );
}

function FileBrowser({ task, demo }: { task: TaskDetail; demo: boolean }) {
  const [scope, setScope] = useState<FileScope>("repository");
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<FileContents | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPath("");
    setSelected(null);
  }, [scope, task.id]);

  useEffect(() => {
    let stopped = false;
    setLoading(true);
    setError(null);
    if (demo) {
      setEntries(demoFileListing(scope, path));
      setLoading(false);
      return () => { stopped = true; };
    }
    void fetchFiles(scope, task.id, path).then((listing) => {
      if (!stopped) setEntries(listing.entries);
    }).catch((loadError: unknown) => {
      if (!stopped) {
        setEntries([]);
        setError(loadError instanceof Error ? loadError.message : "Files are unavailable.");
      }
    }).finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [demo, scope, task.id, path]);

  async function open(entry: FileEntry) {
    if (entry.kind === "directory") {
      setPath(entry.path);
      setSelected(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setSelected(demo ? demoFileContents(scope, entry.path) : await fetchFile(scope, task.id, entry.path));
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "File could not be opened.");
    } finally {
      setLoading(false);
    }
  }

  const breadcrumbs = path ? path.split("/") : [];
  return (
    <section className="files-panel">
      <div className="file-scope-switch" role="tablist" aria-label="File source">
        <button className={scope === "repository" ? "is-active" : ""} onClick={() => setScope("repository")}><Code /> Repository</button>
        <button className={scope === "workspace" ? "is-active" : ""} onClick={() => setScope("workspace")}><FolderOpen /> Workspace</button>
      </div>
      <nav className="file-breadcrumbs" aria-label="File path">
        <button onClick={() => { setPath(""); setSelected(null); }}>{scope === "repository" ? task.repository : "workspace"}</button>
        {breadcrumbs.map((segment, index) => (
          <span key={`${segment}-${index}`}><CaretRight /><button onClick={() => { setPath(breadcrumbs.slice(0, index + 1).join("/")); setSelected(null); }}>{segment}</button></span>
        ))}
      </nav>
      {error ? <div className="panel-error" role="alert"><WarningCircle /><span>{error}<small>{scope === "repository" ? "The checkout appears after this task starts its first Agent run." : "Workspace state may still be initializing."}</small></span></div> : null}
      {selected ? <FilePreview file={selected} /> : (
        <div className="file-list" aria-busy={loading}>
          {loading ? <p className="panel-placeholder"><SpinnerGap className="spin" /> Reading files…</p> : null}
          {!loading && entries.map((entry) => (
            <button key={entry.path} onClick={() => void open(entry)}>
              {entry.kind === "directory" ? <Folder weight="fill" /> : <File />}
              <span>{entry.name}</span><small>{shortBytes(entry.bytes)}</small><CaretRight />
            </button>
          ))}
          {!loading && !entries.length && !error ? <p className="panel-placeholder">This directory is empty.</p> : null}
        </div>
      )}
    </section>
  );
}

function WikiBrowser({ demo }: { demo: boolean }) {
  const [area, setArea] = useState<"wiki" | "raw">("wiki");
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [selected, setSelected] = useState<FileContents | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    setLoading(true);
    setError(null);
    setEntries([]);
    setSelected(null);
    if (demo) {
      setEntries(demoKnowledge.filter((entry) => entry.area === area).map((entry) => ({
        path: entry.path,
        area: entry.area,
        title: entry.title,
        bytes: entry.content.length,
        revision: entry.revision,
        updatedAt: new Date().toISOString(),
      })));
      setLoading(false);
      return () => { stopped = true; };
    }
    void fetchKnowledge(area).then((value) => { if (!stopped) setEntries(value); }).catch((loadError: unknown) => {
      if (!stopped) setError(loadError instanceof Error ? loadError.message : "Wiki is unavailable.");
    }).finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [area, demo]);

  async function open(entry: KnowledgeEntry) {
    setLoading(true);
    setError(null);
    try {
      if (demo) {
        const file = demoKnowledge.find((candidate) => candidate.path === entry.path);
        if (!file) throw new Error("Demo Wiki file is unavailable.");
        setSelected({ scope: "workspace", path: file.path, name: file.path.split("/").at(-1) ?? file.path, bytes: file.content.length, language: "markdown", content: file.content, truncated: false });
      } else {
        setSelected(await fetchKnowledgeFile(entry.path));
      }
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Wiki file could not be opened.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="wiki-panel">
      <div className="file-scope-switch" role="tablist" aria-label="Knowledge area">
        <button className={area === "wiki" ? "is-active" : ""} onClick={() => setArea("wiki")}><BookOpenText /> Wiki</button>
        <button className={area === "raw" ? "is-active" : ""} onClick={() => setArea("raw")}><File /> Sources</button>
      </div>
      {error ? <div className="panel-error" role="alert"><WarningCircle /> {error}</div> : null}
      {selected ? (
        <div className="wiki-reading">
          <button className="back-link" onClick={() => setSelected(null)}>← All {area === "wiki" ? "Wiki" : "sources"}</button>
          <FilePreview file={selected} />
        </div>
      ) : (
        <div className="wiki-list" aria-busy={loading}>
          {loading ? <p className="panel-placeholder"><SpinnerGap className="spin" /> Reading knowledge…</p> : null}
          {!loading && entries.map((entry) => (
            <button key={entry.path} onClick={() => void open(entry)}>
              <BookOpenText /><span><strong>{entry.title || entry.path}</strong><small>{entry.path}</small></span><small>{shortBytes(entry.bytes)}</small><CaretRight />
            </button>
          ))}
          {!loading && !entries.length && !error ? <p className="panel-placeholder">No {area} files yet. Import a repository or add Markdown to create the first one.</p> : null}
        </div>
      )}
    </section>
  );
}

function AgentEnvironment({ task, agents, onDelegate }: { task: TaskDetail; agents: AgentProfile[]; onDelegate: (agentId: string) => void }) {
  const latest = task.runs.at(-1);
  const [agentId, setAgentId] = useState(latest?.agentId ?? task.participantIds[0] ?? agents[0]?.id ?? "");
  const agent = agents.find((entry) => entry.id === agentId) ?? agents[0];

  useEffect(() => {
    if (latest?.agentId) setAgentId(latest.agentId);
  }, [task.id, latest?.agentId]);

  if (!agent) return <p className="panel-placeholder">No Agent has been defined in this workspace.</p>;
  return (
    <section className="agent-environment">
      <select value={agent.id} onChange={(event) => setAgentId(event.target.value)} aria-label="Choose an Agent">
        {agents.map((entry) => <option value={entry.id} key={entry.id}>@{entry.name} · {entry.driver}</option>)}
      </select>
      <div className="agent-hero"><span style={{ "--agent-color": agent.color } as CSSProperties}><Robot weight="duotone" /></span><div><p className="eyebrow">Agent identity</p><h3>{agent.name}</h3><p>{agent.role}</p></div></div>
      <dl className="environment-grid">
        <div><dt>Connector</dt><dd><Code /> {agent.driver}</dd></div>
        <div><dt>Status</dt><dd>{agent.status}</dd></div>
        <div><dt>Environment</dt><dd>{task.repository} · {task.branch}</dd></div>
        <div><dt>Knowledge</dt><dd>Automatic manifest per run</dd></div>
        <div className="wide"><dt>Skills & plugins</dt><dd>Managed by the {agent.driver} CLI. Mob passes files, commands, events, and a task worktree without copying the harness internals.</dd></div>
      </dl>
      <div className="capability-list">{agent.capabilities.map((capability) => <span key={capability}>{capability}</span>)}</div>
      <button className="agent-command-button" onClick={() => onDelegate(agent.id)}><TerminalWindow /> Give @{agent.name} a bounded task</button>
    </section>
  );
}

export function WorkspaceInspector({
  task,
  agents,
  onDelegate,
  source,
}: {
  task: TaskDetail | null;
  agents: AgentProfile[];
  onDelegate: (agentId: string) => void;
  source: "api" | "demo";
}) {
  const [tab, setTab] = useState<InspectorTab>("terminal");
  if (!task) return <aside className="inspector-pane pane"><div className="inspector-empty"><TerminalWindow /><span>Agent work appears here.</span></div></aside>;
  return (
    <aside className="inspector-pane pane work-inspector" aria-label="Agent work, files, and knowledge">
      <header className="work-inspector-header">
        <div><p className="eyebrow">{source === "demo" ? "Demo workspace" : "Live workspace"}</p><h2>{tab === "terminal" ? "Agent terminal" : tab === "files" ? "Files" : tab === "wiki" ? "Wiki" : "Agent"}</h2></div>
        <span className={classes("work-state", source === "demo" && "is-demo")}><i /> {source === "demo" ? "demo preview" : "connected"}</span>
      </header>
      <nav className="inspector-tabs" aria-label="Workspace inspector" role="tablist">
        <button role="tab" aria-controls="workspace-inspector-panel" aria-label="Terminal" aria-selected={tab === "terminal"} className={tab === "terminal" ? "is-active" : ""} onClick={() => setTab("terminal")}><TerminalWindow /><span>Terminal</span></button>
        <button role="tab" aria-controls="workspace-inspector-panel" aria-label="Files" aria-selected={tab === "files"} className={tab === "files" ? "is-active" : ""} onClick={() => setTab("files")}><FolderOpen /><span>Files</span></button>
        <button role="tab" aria-controls="workspace-inspector-panel" aria-label="Wiki" aria-selected={tab === "wiki"} className={tab === "wiki" ? "is-active" : ""} onClick={() => setTab("wiki")}><BookOpenText /><span>Wiki</span></button>
        <button role="tab" aria-controls="workspace-inspector-panel" aria-label="Agent" aria-selected={tab === "agent"} className={tab === "agent" ? "is-active" : ""} onClick={() => setTab("agent")}><Robot /><span>Agent</span></button>
      </nav>
      <div className="work-inspector-body" id="workspace-inspector-panel" role="tabpanel">
        {tab === "terminal" ? <AgentTerminal task={task} agents={agents} demo={source === "demo"} /> : null}
        {tab === "files" ? <FileBrowser task={task} demo={source === "demo"} /> : null}
        {tab === "wiki" ? <WikiBrowser demo={source === "demo"} /> : null}
        {tab === "agent" ? <AgentEnvironment task={task} agents={agents} onDelegate={onDelegate} /> : null}
      </div>
    </aside>
  );
}
