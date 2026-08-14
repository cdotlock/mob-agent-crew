import type {
  ModelCapabilities,
  ModelCatalog,
  ModelCatalogEntry,
  ModelProtocol,
} from "../domain/model.js";

const catalogProtocols = new Set<ModelProtocol>([
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
]);

export interface ModelCatalogServiceOptions {
  configuredJson?: string;
  endpoint?: string;
  authorizationToken?: string;
  fallbackModels?: readonly ModelCatalogEntry[];
  ttlMs?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

export class ModelCatalogConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelCatalogConfigError";
  }
}

/**
 * A small read-through cache over MobAI's catalog. It exposes only public model
 * metadata; the optional authorization token is closed over and never returned.
 */
export class ModelCatalogService {
  readonly #configured: readonly ModelCatalogEntry[];
  readonly #endpoint: string | undefined;
  readonly #authorizationToken: string | undefined;
  readonly #fallback: readonly ModelCatalogEntry[];
  readonly #ttlMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;
  #cached: ModelCatalog | undefined;
  #pending: Promise<ModelCatalog> | undefined;

  constructor(options: ModelCatalogServiceOptions = {}) {
    this.#configured = options.configuredJson
      ? parseModelCatalogPayload(parseJson(options.configuredJson))
      : [];
    this.#endpoint = options.endpoint ? safeCatalogEndpoint(options.endpoint) : undefined;
    this.#authorizationToken = options.authorizationToken;
    this.#fallback = normalizeCatalogEntries(options.fallbackModels ?? []);
    this.#ttlMs = Math.max(5_000, options.ttlMs ?? 5 * 60_000);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async get(options: { refresh?: boolean } = {}): Promise<ModelCatalog> {
    const now = this.#now();
    if (
      !options.refresh &&
      this.#cached &&
      this.#cached.expiresAt.getTime() > now.getTime()
    ) {
      return this.#cached;
    }
    if (this.#pending) return this.#pending;
    this.#pending = this.#refresh().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  async #refresh(): Promise<ModelCatalog> {
    const fetchedAt = this.#now();
    let remote: readonly ModelCatalogEntry[] = [];
    const warnings: string[] = [];

    if (this.#endpoint) {
      try {
        const response = await this.#fetch(this.#endpoint, {
          ...(this.#authorizationToken
            ? { headers: { authorization: `Bearer ${this.#authorizationToken}` } }
            : {}),
          signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) {
          warnings.push("model_catalog_remote_unavailable");
        } else {
          remote = parseModelCatalogPayload(await response.json());
        }
      } catch {
        warnings.push("model_catalog_remote_unavailable");
      }
    }

    const merged = mergeCatalogEntries(this.#fallback, remote, this.#configured);
    const source = this.#configured.length > 0 && remote.length > 0
      ? "merged"
      : this.#configured.length > 0
        ? "configured"
        : remote.length > 0
          ? "remote"
          : "fallback";
    const catalog: ModelCatalog = {
      version: 1,
      source,
      fetchedAt,
      expiresAt: new Date(fetchedAt.getTime() + this.#ttlMs),
      stale: warnings.length > 0 && remote.length === 0,
      models: merged,
      warnings,
    };
    this.#cached = catalog;
    return catalog;
  }
}

export function parseModelCatalogPayload(payload: unknown): ModelCatalogEntry[] {
  const records = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : isRecord(payload) && Array.isArray(payload.models)
        ? payload.models
        : null;
  if (!records) {
    throw new ModelCatalogConfigError("Model catalog must be an array or contain a data/models array.");
  }
  return normalizeCatalogEntries(records.map(parseModelRecord).filter(isDefined));
}

function parseModelRecord(value: unknown): ModelCatalogEntry | undefined {
  if (typeof value === "string") {
    const id = normalizedId(value);
    return id ? emptyModel(id) : undefined;
  }
  if (!isRecord(value)) return undefined;
  const id = normalizedId(value.id ?? value.model ?? value.name);
  if (!id) return undefined;
  const name = stringOrNull(value.displayName ?? value.display_name ?? value.name) ?? id;
  const provider = stringOrNull(value.provider ?? value.owned_by ?? value.ownedBy);
  const declaredProtocols = parseProtocols(value.protocols ?? value.protocol);
  const protocols = declaredProtocols.length > 0 ? declaredProtocols : inferMobAiProtocols(id);
  const contextWindow = positiveIntegerOrNull(
    value.contextWindow ?? value.context_window ?? value.max_context_length,
  );
  const rawCapabilities = isRecord(value.capabilities) ? value.capabilities : value;
  const capabilities: ModelCapabilities = {
    ...optionalBoolean("tools", rawCapabilities.tools ?? rawCapabilities.tool_calling),
    ...optionalBoolean("vision", rawCapabilities.vision ?? rawCapabilities.image_input),
    ...optionalBoolean("reasoning", rawCapabilities.reasoning),
  };
  return { id, name, provider, protocols, contextWindow, capabilities };
}

/**
 * MobAI's OpenAI-compatible model listing may omit endpoint metadata. Keep all
 * models visible, but infer only the protocols documented by the public
 * integration contract so media/embedding/rerank models cannot be selected by
 * a coding harness accidentally.
 */
export function inferMobAiProtocols(id: string): ModelProtocol[] {
  const normalized = id.toLowerCase();
  if (
    normalized.startsWith("image-") ||
    normalized.startsWith("video-") ||
    normalized.startsWith("jina-") ||
    normalized.includes("embedding") ||
    normalized.includes("rerank")
  ) return [];
  const protocols = new Set<ModelProtocol>(["openai-chat"]);
  if (normalized.startsWith("claude-")) protocols.add("anthropic-messages");
  if (normalized === "gpt-5.5:free" || normalized === "gpt-5.6-sol") {
    protocols.add("openai-responses");
  }
  return [...protocols];
}

function parseProtocols(value: unknown): ModelProtocol[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const protocols = new Set<ModelProtocol>();
  for (const item of values) {
    if (typeof item !== "string") continue;
    const normalized = normalizeProtocol(item);
    if (normalized) protocols.add(normalized);
  }
  return [...protocols];
}

function normalizeProtocol(value: string): ModelProtocol | null {
  const normalized = value.trim().toLowerCase();
  if (catalogProtocols.has(normalized as ModelProtocol)) return normalized as ModelProtocol;
  if (["openai", "openai-compatible", "chat/completions", "openai-chat-completions"].includes(normalized)) {
    return "openai-chat";
  }
  if (["responses", "openai-responses-api"].includes(normalized)) return "openai-responses";
  if (["anthropic", "messages", "claude"].includes(normalized)) return "anthropic-messages";
  return null;
}

function normalizeCatalogEntries(values: readonly ModelCatalogEntry[]): ModelCatalogEntry[] {
  return mergeCatalogEntries(values).sort((left, right) => left.id.localeCompare(right.id));
}

function mergeCatalogEntries(...groups: readonly (readonly ModelCatalogEntry[])[]): ModelCatalogEntry[] {
  const entries = new Map<string, ModelCatalogEntry>();
  for (const group of groups) {
    for (const value of group) {
      const existing = entries.get(value.id);
      entries.set(value.id, existing ? {
        ...existing,
        ...value,
        name: value.name || existing.name,
        provider: value.provider ?? existing.provider,
        protocols: [...new Set([...existing.protocols, ...value.protocols])],
        contextWindow: value.contextWindow ?? existing.contextWindow,
        capabilities: { ...existing.capabilities, ...value.capabilities },
      } : value);
    }
  }
  return [...entries.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function emptyModel(id: string): ModelCatalogEntry {
  return { id, name: id, provider: null, protocols: [], contextWindow: null, capabilities: {} };
}

function normalizedId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id.length > 0 && id.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u.test(id)
    ? id
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : null;
}

function positiveIntegerOrNull(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function optionalBoolean(key: keyof ModelCapabilities, value: unknown): ModelCapabilities {
  return typeof value === "boolean" ? { [key]: value } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new ModelCatalogConfigError("Configured model catalog JSON is invalid.");
  }
}

function safeCatalogEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ModelCatalogConfigError("Model catalog endpoint must be a valid HTTPS URL.");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new ModelCatalogConfigError("Model catalog endpoint must be a credential-free HTTPS URL.");
  }
  return endpoint.toString();
}
