import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";

export type KnowledgeArea = "raw" | "wiki";

export interface WorkspaceKnowledgeOptions {
  /** One platform-owned directory for one workspace. */
  readonly rootDirectory: string;
  readonly maxDocumentBytes?: number;
}

export interface WriteKnowledgeInput {
  /** Path relative to the selected area, for example `research/brief.md`. */
  readonly path: string;
  readonly content: string;
  readonly source?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface KnowledgeDocument {
  readonly path: string;
  readonly area: KnowledgeArea;
  readonly content: string;
  readonly bytes: number;
  readonly revision: string;
  readonly updatedAt: string;
}

export interface KnowledgeEntry extends Omit<KnowledgeDocument, "content"> {
  readonly title: string;
}

export interface KnowledgeSearchResult {
  readonly path: string;
  readonly area: KnowledgeArea;
  readonly title: string;
  readonly revision: string;
  readonly excerpt: string;
  readonly reason: string;
  readonly score: number;
}

export interface KnowledgeSearchOptions {
  readonly topK?: number;
}

export interface KnowledgeRetrieveOptions extends KnowledgeSearchOptions {
  /** Maximum number of characters in the assembled context string. */
  readonly charBudget?: number;
}

export interface KnowledgeContextManifestEntry {
  readonly path: string;
  readonly revision: string;
  readonly reason: string;
  readonly excerptCharacters: number;
}

export interface KnowledgeContextManifest {
  readonly version: 1;
  readonly id: string;
  readonly query: string;
  readonly indexRevision: string;
  readonly topK: number;
  readonly charBudget: number;
  readonly characters: number;
  readonly entries: readonly KnowledgeContextManifestEntry[];
}

export interface KnowledgeRetrieval {
  readonly context: string;
  readonly items: readonly KnowledgeSearchResult[];
  readonly manifest: KnowledgeContextManifest;
  readonly manifestPath: string;
}

export interface KnowledgeIndexSummary {
  readonly revision: string;
  readonly documents: number;
  readonly path: string;
}

export interface KnowledgeLintIssue {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface KnowledgeLintReport {
  readonly ok: boolean;
  readonly checked: number;
  readonly issues: readonly KnowledgeLintIssue[];
}

interface IndexedDocument extends KnowledgeEntry {
  readonly normalizedTitle: string;
  readonly normalizedBody: string;
  readonly body: string;
}

interface StoredIndex {
  readonly version: 1;
  readonly revision: string;
  readonly sourceSignature: string;
  readonly documents: readonly IndexedDocument[];
}

interface WalkedFile {
  readonly area: KnowledgeArea;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

const INDEX_VERSION = 1 as const;
const DEFAULT_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TOP_K = 6;
const DEFAULT_CHAR_BUDGET = 12_000;
const INDEX_PATH = "cache/knowledge-index.json";
const CATALOG_PATH = "manifests/catalog.json";

/**
 * Filesystem knowledge for a single workspace.
 *
 * `raw/` is append-only, `wiki/` is curated and mutable, `cache/` can always be
 * deleted and rebuilt, and `manifests/` records provenance and retrieval inputs.
 */
export class WorkspaceKnowledge {
  readonly rootDirectory: string;
  readonly #maxDocumentBytes: number;

  constructor(options: WorkspaceKnowledgeOptions) {
    this.rootDirectory = resolve(options.rootDirectory);
    this.#maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
    if (!Number.isSafeInteger(this.#maxDocumentBytes) || this.#maxDocumentBytes <= 0) {
      throw new Error("maxDocumentBytes must be a positive integer");
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    await this.#assertRootIsDirectory();
    const managedDirectories = [
      "raw",
      "wiki",
      "cache",
      "manifests",
      "manifests/documents",
      "manifests/contexts",
    ];
    for (const directory of managedDirectories) {
      const path = resolve(this.rootDirectory, directory);
      await mkdir(path, { recursive: true, mode: 0o700 });
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`Managed knowledge directory must not be a symlink: ${directory}`);
      }
    }
  }

  /** Writes an immutable source document. Retrying identical content is idempotent. */
  async writeRaw(input: WriteKnowledgeInput): Promise<KnowledgeDocument> {
    return this.#writeDocument("raw", input, true);
  }

  /** Writes or replaces a curated wiki document atomically. */
  async writeWiki(input: WriteKnowledgeInput): Promise<KnowledgeDocument> {
    return this.#writeDocument("wiki", input, false);
  }

  async list(area?: KnowledgeArea): Promise<readonly KnowledgeEntry[]> {
    await this.initialize();
    const files = await this.#walkSources(area);
    const entries = await Promise.all(files.map((file) => this.#readEntry(file)));
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }

  /** Reads `raw/...` or `wiki/...`; absolute paths and traversal are rejected. */
  async read(path: string): Promise<KnowledgeDocument> {
    await this.initialize();
    const { area, relativePath } = splitKnowledgePath(path);
    const absolutePath = await this.#safeExistingPath(area, relativePath);
    const info = await stat(absolutePath);
    if (!info.isFile()) throw new Error(`Knowledge path is not a file: ${path}`);
    if (info.size > this.#maxDocumentBytes) throw new Error(`Knowledge document exceeds ${this.#maxDocumentBytes} bytes`);
    const content = await readUtf8(absolutePath);
    return {
      path: `${area}/${relativePath}`,
      area,
      content,
      bytes: info.size,
      revision: sha256(content),
      updatedAt: info.mtime.toISOString(),
    };
  }

  async search(query: string, options: KnowledgeSearchOptions = {}): Promise<readonly KnowledgeSearchResult[]> {
    const cleanQuery = normalizeQuery(query);
    const topK = positiveInteger(options.topK ?? DEFAULT_TOP_K, "topK");
    const index = await this.#loadCurrentIndex();
    const queryTerms = unique(tokenize(cleanQuery));
    if (queryTerms.length === 0) return [];

    return index.documents
      .map((document) => scoreDocument(document, cleanQuery, queryTerms))
      .filter((result): result is KnowledgeSearchResult => result !== null)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, topK);
  }

  async retrieve(query: string, options: KnowledgeRetrieveOptions = {}): Promise<KnowledgeRetrieval> {
    const topK = positiveInteger(options.topK ?? DEFAULT_TOP_K, "topK");
    const charBudget = positiveInteger(options.charBudget ?? DEFAULT_CHAR_BUDGET, "charBudget");
    const [results, index] = await Promise.all([
      this.search(query, { topK }),
      this.#loadCurrentIndex(),
    ]);

    const included: KnowledgeSearchResult[] = [];
    let context = "";
    for (const result of results) {
      const prefix = context.length === 0 ? `## ${result.path}\n` : `\n\n## ${result.path}\n`;
      const remaining = charBudget - context.length - prefix.length;
      if (remaining <= 0) break;
      const excerpt = truncate(result.excerpt, remaining);
      if (!excerpt) break;
      context += `${prefix}${excerpt}`;
      included.push({ ...result, excerpt });
    }

    const manifestSeed = JSON.stringify({
      query: normalizeQuery(query),
      indexRevision: index.revision,
      topK,
      charBudget,
      entries: included.map(({ path, revision }) => ({ path, revision })),
    });
    const id = sha256(manifestSeed).slice(0, 24);
    const manifest: KnowledgeContextManifest = {
      version: 1,
      id,
      query: normalizeQuery(query),
      indexRevision: index.revision,
      topK,
      charBudget,
      characters: context.length,
      entries: included.map((item) => ({
        path: item.path,
        revision: item.revision,
        reason: item.reason,
        excerptCharacters: item.excerpt.length,
      })),
    };
    const manifestPath = `manifests/contexts/${id}.json`;
    await this.#writeJsonAtomic(resolve(this.rootDirectory, manifestPath), manifest);
    return { context, items: included, manifest, manifestPath };
  }

  async rebuildIndex(): Promise<KnowledgeIndexSummary> {
    await this.initialize();
    const files = await this.#walkSources();
    const documents = await Promise.all(files.map((file) => this.#indexFile(file)));
    documents.sort((left, right) => left.path.localeCompare(right.path));
    const sourceSignature = signatureForFiles(files);
    const revision = sha256(
      documents.map((document) => `${document.path}\0${document.revision}`).join("\n"),
    );
    const index: StoredIndex = { version: INDEX_VERSION, revision, sourceSignature, documents };
    await this.#writeJsonAtomic(resolve(this.rootDirectory, INDEX_PATH), index);
    await this.#writeJsonAtomic(resolve(this.rootDirectory, CATALOG_PATH), {
      version: 1,
      revision,
      documents: documents.map(({ path, area, title, bytes, revision: documentRevision, updatedAt }) => ({
        path,
        area,
        title,
        bytes,
        revision: documentRevision,
        updatedAt,
      })),
    });
    return { revision, documents: documents.length, path: INDEX_PATH };
  }

  async lint(): Promise<KnowledgeLintReport> {
    await this.initialize();
    const issues: KnowledgeLintIssue[] = [];
    let checked = 0;
    for (const area of ["raw", "wiki"] as const) {
      const root = resolve(this.rootDirectory, area);
      await walkTree(root, async (absolutePath, relativePath, type) => {
        const path = `${area}/${relativePath}`;
        if (type === "symlink") {
          issues.push({ severity: "error", code: "symlink", path, message: "Symlinks are not allowed in knowledge sources" });
          return;
        }
        if (type !== "file") return;
        checked += 1;
        if (!isMarkdown(relativePath)) {
          issues.push({ severity: "error", code: "unsupported_file", path, message: "Knowledge sources must be Markdown files" });
          return;
        }
        const info = await stat(absolutePath);
        if (info.size > this.#maxDocumentBytes) {
          issues.push({ severity: "error", code: "too_large", path, message: `Document exceeds ${this.#maxDocumentBytes} bytes` });
          return;
        }
        try {
          const content = await readUtf8(absolutePath);
          if (content.trim().length === 0) {
            issues.push({ severity: "warning", code: "empty", path, message: "Document is empty" });
          }
        } catch {
          issues.push({ severity: "error", code: "invalid_utf8", path, message: "Document is not valid UTF-8" });
        }
      });
    }
    issues.sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code));
    return { ok: !issues.some((issue) => issue.severity === "error"), checked, issues };
  }

  async #writeDocument(area: KnowledgeArea, input: WriteKnowledgeInput, immutable: boolean): Promise<KnowledgeDocument> {
    await this.initialize();
    const relativePath = safeRelativeMarkdownPath(input.path);
    const content = normalizeMarkdown(input.content);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes === 0) throw new Error("Knowledge document is empty");
    if (bytes > this.#maxDocumentBytes) throw new Error(`Knowledge document exceeds ${this.#maxDocumentBytes} bytes`);

    const absolutePath = this.#pathInside(area, relativePath);
    await this.#ensureSafeParent(area, dirname(relativePath));
    if (immutable) {
      try {
        await writeFile(absolutePath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        const existing = await readUtf8(await this.#safeExistingPath(area, relativePath));
        if (existing !== content) throw new Error(`Raw knowledge is immutable: raw/${relativePath}`);
      }
    } else {
      await this.#writeTextAtomic(absolutePath, content);
    }

    const document = await this.read(`${area}/${relativePath}`);
    const documentManifestPath = resolve(
      this.rootDirectory,
      "manifests/documents",
      `${sha256(document.path).slice(0, 32)}.json`,
    );
    await this.#writeJsonAtomic(documentManifestPath, {
      version: 1,
      path: document.path,
      revision: document.revision,
      bytes: document.bytes,
      source: input.source ?? null,
      metadata: input.metadata ?? {},
    });
    await rm(resolve(this.rootDirectory, INDEX_PATH), { force: true });
    return document;
  }

  async #loadCurrentIndex(): Promise<StoredIndex> {
    await this.initialize();
    const files = await this.#walkSources();
    const sourceSignature = signatureForFiles(files);
    try {
      const parsed = JSON.parse(await readFile(resolve(this.rootDirectory, INDEX_PATH), "utf8")) as Partial<StoredIndex>;
      if (
        parsed.version === INDEX_VERSION &&
        parsed.sourceSignature === sourceSignature &&
        typeof parsed.revision === "string" &&
        Array.isArray(parsed.documents)
      ) {
        return parsed as StoredIndex;
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
    }
    await this.rebuildIndex();
    return JSON.parse(await readFile(resolve(this.rootDirectory, INDEX_PATH), "utf8")) as StoredIndex;
  }

  async #walkSources(area?: KnowledgeArea): Promise<WalkedFile[]> {
    const files: WalkedFile[] = [];
    for (const currentArea of area ? [area] : (["raw", "wiki"] as const)) {
      const areaRoot = resolve(this.rootDirectory, currentArea);
      await walkTree(areaRoot, async (absolutePath, relativePath, type) => {
        if (type === "symlink") throw new Error(`Symlinks are not allowed in knowledge sources: ${currentArea}/${relativePath}`);
        if (type !== "file" || !isMarkdown(relativePath)) return;
        const info = await stat(absolutePath);
        if (info.size > this.#maxDocumentBytes) throw new Error(`Knowledge document exceeds ${this.#maxDocumentBytes} bytes: ${currentArea}/${relativePath}`);
        files.push({ area: currentArea, relativePath, absolutePath, bytes: info.size, mtimeMs: info.mtimeMs });
      });
    }
    return files.sort((left, right) => `${left.area}/${left.relativePath}`.localeCompare(`${right.area}/${right.relativePath}`));
  }

  async #readEntry(file: WalkedFile): Promise<KnowledgeEntry> {
    const document = await this.read(`${file.area}/${file.relativePath}`);
    return { ...withoutContent(document), title: markdownTitle(document.content, file.relativePath) };
  }

  async #indexFile(file: WalkedFile): Promise<IndexedDocument> {
    const document = await this.read(`${file.area}/${file.relativePath}`);
    const title = markdownTitle(document.content, file.relativePath);
    return {
      ...withoutContent(document),
      title,
      body: document.content,
      normalizedTitle: normalizeForSearch(title),
      normalizedBody: normalizeForSearch(document.content),
    };
  }

  #pathInside(area: KnowledgeArea, relativePath: string): string {
    const areaRoot = resolve(this.rootDirectory, area);
    const candidate = resolve(areaRoot, relativePath);
    if (candidate !== areaRoot && !candidate.startsWith(`${areaRoot}${sep}`)) {
      throw new Error("Knowledge path escapes its managed directory");
    }
    return candidate;
  }

  async #safeExistingPath(area: KnowledgeArea, relativePath: string): Promise<string> {
    const candidate = this.#pathInside(area, safeRelativeMarkdownPath(relativePath));
    const areaRoot = await realpath(resolve(this.rootDirectory, area));
    const resolved = await realpath(candidate);
    if (resolved !== areaRoot && !resolved.startsWith(`${areaRoot}${sep}`)) {
      throw new Error("Knowledge path resolves outside its managed directory");
    }
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) throw new Error("Symlinks are not allowed in knowledge sources");
    return candidate;
  }

  async #ensureSafeParent(area: KnowledgeArea, relativeParent: string): Promise<void> {
    const areaRoot = resolve(this.rootDirectory, area);
    if (relativeParent === ".") return;
    let current = areaRoot;
    for (const segment of relativeParent.split("/")) {
      current = resolve(current, segment);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new Error(`Unsafe knowledge directory: ${area}/${relativeParent}`);
        }
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
        await mkdir(current, { mode: 0o700 });
      }
    }
  }

  async #assertRootIsDirectory(): Promise<void> {
    const info = await lstat(this.rootDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Knowledge root must be a real directory, not a symlink");
    }
  }

  async #writeJsonAtomic(path: string, value: unknown): Promise<void> {
    await this.#writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  async #writeTextAtomic(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  }
}

function splitKnowledgePath(path: string): { area: KnowledgeArea; relativePath: string } {
  const normalized = path.replaceAll("\\", "/");
  const slash = normalized.indexOf("/");
  const area = normalized.slice(0, slash);
  if (area !== "raw" && area !== "wiki") throw new Error("Knowledge path must start with raw/ or wiki/");
  return { area, relativePath: safeRelativeMarkdownPath(normalized.slice(slash + 1)) };
}

function safeRelativeMarkdownPath(path: string): string {
  const value = path.trim();
  if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || !isMarkdown(value)) {
    throw new Error("Knowledge path must be a relative Markdown path");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new Error("Knowledge path contains an unsafe segment");
  }
  return segments.join("/");
}

function isMarkdown(path: string): boolean {
  return [".md", ".markdown"].includes(extname(path).toLowerCase());
}

function normalizeMarkdown(content: string): string {
  return content.replaceAll("\r\n", "\n").replaceAll("\0", "").trim();
}

function normalizeQuery(query: string): string {
  const clean = normalizeForSearch(query).trim();
  if (!clean) throw new Error("Knowledge query is empty");
  return clean;
}

function normalizeForSearch(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replaceAll(/\s+/gu, " ");
}

function tokenize(value: string): string[] {
  const tokens = value.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const result: string[] = [];
  for (const token of tokens) {
    const latin = token.match(/[a-z\d][a-z\d_-]*/giu) ?? [];
    result.push(...latin.map((part) => part.toLocaleLowerCase()).filter((part) => part.length >= 2));
    const han = [...token.matchAll(/[\p{Script=Han}]+/gu)].flatMap((match) => cjkGrams(match[0] ?? ""));
    result.push(...han);
  }
  return result;
}

function cjkGrams(value: string): string[] {
  const characters = [...value];
  const grams: string[] = [];
  for (let size = 1; size <= Math.min(3, characters.length); size += 1) {
    for (let index = 0; index <= characters.length - size; index += 1) {
      grams.push(characters.slice(index, index + size).join(""));
    }
  }
  return grams;
}

function scoreDocument(document: IndexedDocument, query: string, terms: readonly string[]): KnowledgeSearchResult | null {
  const matched = terms.filter((term) => document.normalizedTitle.includes(term) || document.normalizedBody.includes(term));
  if (matched.length === 0) return null;
  const titleHits = matched.filter((term) => document.normalizedTitle.includes(term));
  const bodyHits = matched.filter((term) => document.normalizedBody.includes(term));
  const exactTitle = document.normalizedTitle.includes(query) ? 40 : 0;
  const exactBody = document.normalizedBody.includes(query) ? 12 : 0;
  const coverage = matched.length / terms.length;
  const score = Math.round((exactTitle + exactBody + titleHits.length * 10 + bodyHits.length * 3 + coverage * 20) * 100) / 100;
  const firstTerm = matched.find((term) => document.normalizedBody.includes(term)) ?? matched[0] ?? query;
  return {
    path: document.path,
    area: document.area,
    title: document.title,
    revision: document.revision,
    excerpt: excerptAround(document.body, firstTerm),
    reason: `${titleHits.length > 0 ? "title and content" : "content"} matched: ${matched.slice(0, 6).join(", ")}`,
    score,
  };
}

function excerptAround(content: string, term: string, limit = 900): string {
  const normalized = normalizeForSearch(content);
  const position = normalized.indexOf(term);
  const start = Math.max(0, position < 0 ? 0 : position - Math.floor(limit / 3));
  const end = Math.min(content.length, start + limit);
  let excerpt = content.slice(start, end).trim();
  if (start > 0) excerpt = `…${excerpt}`;
  if (end < content.length) excerpt = `${excerpt}…`;
  return excerpt;
}

function markdownTitle(content: string, path: string): string {
  return content.match(/^#\s+(.+)$/mu)?.[1]?.trim() || basename(path, extname(path)).replaceAll(/[-_]+/gu, " ");
}

function truncate(value: string, limit: number): string {
  if (limit <= 0) return "";
  if (value.length <= limit) return value;
  if (limit === 1) return "…";
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

function signatureForFiles(files: readonly WalkedFile[]): string {
  return sha256(files.map((file) => `${file.area}/${file.relativePath}\0${file.bytes}\0${file.mtimeMs}`).join("\n"));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function withoutContent(document: KnowledgeDocument): Omit<KnowledgeDocument, "content"> {
  const { content: _content, ...entry } = document;
  return entry;
}

async function readUtf8(path: string): Promise<string> {
  const bytes = await readFile(path);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function walkTree(
  root: string,
  visit: (absolutePath: string, relativePath: string, type: "file" | "directory" | "symlink") => Promise<void>,
): Promise<void> {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        await visit(absolutePath, relativePath, "symlink");
      } else if (entry.isDirectory()) {
        await visit(absolutePath, relativePath, "directory");
        pending.push(absolutePath);
      } else if (entry.isFile()) {
        await visit(absolutePath, relativePath, "file");
      }
    }
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
