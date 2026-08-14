import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from "@phosphor-icons/react/ArrowCounterClockwise";
import { BookOpenTextIcon as BookOpenText } from "@phosphor-icons/react/BookOpenText";
import { CaretRightIcon as CaretRight } from "@phosphor-icons/react/CaretRight";
import { FileIcon as File } from "@phosphor-icons/react/File";
import { MagnifyingGlassIcon as MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import { NotePencilIcon as NotePencil } from "@phosphor-icons/react/NotePencil";
import { PlusIcon as Plus } from "@phosphor-icons/react/Plus";
import { RobotIcon as Robot } from "@phosphor-icons/react/Robot";
import { SpinnerGapIcon as SpinnerGap } from "@phosphor-icons/react/SpinnerGap";
import { UploadSimpleIcon as UploadSimple } from "@phosphor-icons/react/UploadSimple";
import { WarningCircleIcon as WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { XIcon as X } from "@phosphor-icons/react/X";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchKnowledge,
  fetchKnowledgeFile,
  queryKnowledge,
  rebuildKnowledge,
  writeKnowledge,
} from "./api.js";
import type {
  AgentProfile,
  FileContents,
  KnowledgeEntry,
  KnowledgeQueryResult,
} from "./model.js";

type KnowledgeArea = "wiki" | "raw";
type ViewState = "browse" | "edit";

function bytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${Math.ceil(value / 1_024)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function defaultKnowledgePath(fileName: string, area: KnowledgeArea): string {
  const safe = fileName
    .toLowerCase()
    .replace(/\.markdown$/u, ".md")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return area === "wiki" ? `notes/${safe || "untitled.md"}` : `imports/${safe || "source.md"}`;
}

export function WikiWorkspace({
  agents,
  onClose,
  onAskAgent,
}: {
  agents: AgentProfile[];
  onClose: () => void;
  onAskAgent: (agentId: string, question: string, retrieval: KnowledgeQueryResult) => Promise<void>;
}) {
  const uploadRef = useRef<HTMLInputElement>(null);
  const [area, setArea] = useState<KnowledgeArea>("wiki");
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [selected, setSelected] = useState<FileContents | null>(null);
  const [view, setView] = useState<ViewState>("browse");
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<KnowledgeQueryResult | null>(null);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const visibleEntries = useMemo(
    () => entries.filter((entry) => entry.area === area),
    [area, entries],
  );

  useEffect(() => {
    if (!agents.some((agent) => agent.id === agentId)) setAgentId(agents[0]?.id ?? "");
  }, [agentId, agents]);

  useEffect(() => {
    let stopped = false;
    setLoading(true);
    setError(null);
    void fetchKnowledge(area).then((value) => {
      if (!stopped) setEntries(value);
    }).catch((loadError: unknown) => {
      if (!stopped) setError(loadError instanceof Error ? loadError.message : "Wiki is unavailable.");
    }).finally(() => {
      if (!stopped) setLoading(false);
    });
    return () => { stopped = true; };
  }, [area]);

  async function openEntry(entry: KnowledgeEntry) {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const file = await fetchKnowledgeFile(entry.path);
      setSelected(file);
      setPath(entry.path.replace(/^(?:wiki|raw)\//u, ""));
      setContent(file.content);
      setView("browse");
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "The Wiki page could not be opened.");
    } finally {
      setLoading(false);
    }
  }

  async function askWiki() {
    const clean = question.trim();
    if (!clean || working) return;
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      setAnswer(await queryKnowledge(clean));
    } catch (queryError) {
      setError(queryError instanceof Error ? queryError.message : "The Wiki could not answer this query.");
    } finally {
      setWorking(false);
    }
  }

  async function askAgent() {
    if (!agentId || !question.trim() || working) return;
    setWorking(true);
    setError(null);
    try {
      const retrieval = !answer || answer.question !== question.trim()
        ? await queryKnowledge(question.trim())
        : answer;
      setAnswer(retrieval);
      await onAskAgent(agentId, question.trim(), retrieval);
      const agent = agents.find((entry) => entry.id === agentId);
      setNotice(`${agent?.name ?? "Agent"} is working with the cited Wiki context. Follow the live run in the right-hand Terminal.`);
    } catch (askError) {
      setError(askError instanceof Error ? askError.message : "The Agent could not be started.");
    } finally {
      setWorking(false);
    }
  }

  function startPage() {
    setSelected(null);
    setPath(area === "wiki" ? "notes/untitled.md" : "imports/source.md");
    setContent("");
    setView("edit");
    setError(null);
    setNotice(null);
  }

  async function savePage() {
    if (!path.trim() || !content.trim() || working) return;
    setWorking(true);
    setError(null);
    try {
      const saved = await writeKnowledge(area, path.trim(), content);
      const next = await fetchKnowledge(area);
      setEntries(next);
      setSelected(saved);
      setPath(saved.path.replace(/^(?:wiki|raw)\//u, ""));
      setView("browse");
      setNotice(area === "wiki" ? "Wiki page saved." : "Immutable source imported.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The Wiki page could not be saved.");
    } finally {
      setWorking(false);
    }
  }

  async function importMarkdown(file: File) {
    setPath(defaultKnowledgePath(file.name, area));
    setContent(await file.text());
    setSelected(null);
    setView("edit");
    setNotice(`Ready to import ${file.name}. Review the path and content, then save.`);
  }

  async function reindex() {
    setWorking(true);
    setError(null);
    try {
      const result = await rebuildKnowledge();
      setEntries(await fetchKnowledge(area));
      setNotice(`Wiki index rebuilt from ${result.documents} Markdown files.`);
    } catch (rebuildError) {
      setError(rebuildError instanceof Error ? rebuildError.message : "The Wiki index could not be rebuilt.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="wiki-workspace" aria-label="Wiki workspace">
      <header className="wiki-workspace-header">
        <div>
          <p className="eyebrow">On-demand knowledge mode</p>
          <h1><BookOpenText weight="duotone" /> Workspace Wiki</h1>
          <p>Ask, inspect, and maintain the Markdown knowledge shared by every Agent.</p>
        </div>
        <div className="wiki-workspace-actions">
          <input
            ref={uploadRef}
            className="visually-hidden-input"
            type="file"
            accept=".md,.markdown,text/markdown,text/plain"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importMarkdown(file);
              event.currentTarget.value = "";
            }}
          />
          <button className="secondary-button" onClick={() => uploadRef.current?.click()}><UploadSimple /> Import Markdown</button>
          <button className="secondary-button" onClick={startPage}><Plus /> New page</button>
          <button className="icon-button" onClick={onClose} aria-label="Close Wiki mode"><X /></button>
        </div>
      </header>

      <div className="wiki-workspace-grid">
        <aside className="wiki-library">
          <div className="wiki-area-switch" aria-label="Knowledge area">
            <button aria-pressed={area === "wiki"} className={area === "wiki" ? "is-active" : ""} onClick={() => { setArea("wiki"); setSelected(null); setView("browse"); }}><BookOpenText /> Curated</button>
            <button aria-pressed={area === "raw"} className={area === "raw" ? "is-active" : ""} onClick={() => { setArea("raw"); setSelected(null); setView("browse"); }}><File /> Sources</button>
          </div>
          <div className="wiki-library-meta"><span>{visibleEntries.length} files</span><button onClick={() => void reindex()} disabled={working} title="Rebuild search index"><ArrowCounterClockwise className={working ? "spin" : ""} /> Reindex</button></div>
          <div className="wiki-library-list" aria-busy={loading}>
            {loading ? <p className="panel-placeholder"><SpinnerGap className="spin" /> Reading files…</p> : null}
            {!loading && visibleEntries.map((entry) => (
              <button key={entry.path} className={selected?.path === entry.path ? "is-active" : ""} onClick={() => void openEntry(entry)}>
                <BookOpenText /><span><strong>{entry.title || entry.path}</strong><small>{entry.path}</small></span><small>{bytes(entry.bytes)}</small><CaretRight />
              </button>
            ))}
            {!loading && !visibleEntries.length ? <p className="panel-placeholder">No {area === "wiki" ? "curated pages" : "source documents"} yet.</p> : null}
          </div>
        </aside>

        <main className="wiki-stage" id="wiki-main-content" tabIndex={-1}>
          <section className="wiki-query-card">
            <div className="wiki-query-heading"><span><MagnifyingGlass /></span><div><h2>Ask the Wiki</h2><p>Retrieval is file-backed and citation-bound. Choose any Agent only when you need synthesis or action.</p></div></div>
            <textarea value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} placeholder="例如：我们的 Agent 运行和发布边界是什么？" />
            <div className="wiki-query-actions">
              <button className="secondary-button" disabled={!question.trim() || working} onClick={() => void askWiki()}>{working ? <SpinnerGap className="spin" /> : <MagnifyingGlass />} Find context</button>
              <div className="wiki-agent-ask">
                <select value={agentId} onChange={(event) => setAgentId(event.target.value)} aria-label="Agent for Wiki question">
                  {agents.map((agent) => <option value={agent.id} key={agent.id}>@{agent.handle} · {agent.driver}</option>)}
                </select>
                <button className="primary-button" disabled={!agentId || !question.trim() || working} onClick={() => void askAgent()}><Robot /> Ask Agent</button>
              </div>
            </div>
          </section>

          {error ? <div className="inline-alert" role="alert"><WarningCircle /> {error}</div> : null}
          {notice ? <div className="wiki-notice" role="status">{notice}</div> : null}

          {answer ? (
            <section className="wiki-answer-card">
              <div className="wiki-card-title"><div><p className="eyebrow">Relevant context</p><h2>{answer.citations.length} cited files</h2></div><small>Index {answer.indexRevision.slice(0, 8)}</small></div>
              {answer.citations.length ? answer.citations.map((citation, index) => (
                <article key={`${citation.path}-${index}`}>
                  <button onClick={() => {
                    const entry = entries.find((candidate) => candidate.path === citation.path);
                    if (entry) void openEntry(entry);
                  }}><span>[{index + 1}]</span><strong>{citation.title || citation.path}</strong><small>{citation.path}</small></button>
                  <p>{citation.excerpt}</p>
                  <small>{citation.reason} · {citation.revision.slice(0, 8)}</small>
                </article>
              )) : <p className="panel-placeholder">No matching Wiki files were found. Import or curate a Markdown page first.</p>}
            </section>
          ) : null}

          {view === "edit" ? (
            <section className="wiki-editor-card">
              <div className="wiki-card-title"><div><p className="eyebrow">{area === "wiki" ? "Curated knowledge" : "Immutable source"}</p><h2><NotePencil /> {selected ? "Edit page" : "Add Markdown"}</h2></div></div>
              <label><span>Path</span><div className="wiki-path-field"><span>{area}/</span><input value={path} onChange={(event) => setPath(event.target.value)} placeholder="notes/page.md" /></div></label>
              <label><span>Markdown</span><textarea value={content} onChange={(event) => setContent(event.target.value)} rows={18} placeholder="# Page title" /></label>
              <div className="modal-actions"><button className="ghost-button" onClick={() => setView("browse")}>Cancel</button><button className="primary-button" disabled={!path.trim() || !content.trim() || working} onClick={() => void savePage()}>{working ? <SpinnerGap className="spin" /> : <NotePencil />} Save</button></div>
            </section>
          ) : selected ? (
            <section className="wiki-document-card">
              <div className="wiki-card-title"><div><p className="eyebrow">{selected.path}</p><h2>{selected.name}</h2></div>{area === "wiki" ? <button className="secondary-button" onClick={() => setView("edit")}><NotePencil /> Edit</button> : null}</div>
              <pre><code>{selected.content}</code></pre>
            </section>
          ) : !answer ? (
            <section className="wiki-empty-state"><BookOpenText weight="duotone" /><h2>The Wiki opens only when you need it.</h2><p>Ask a question above, select a page on the left, or import the former MobWiki Markdown collection.</p></section>
          ) : null}
        </main>
      </div>
    </section>
  );
}
