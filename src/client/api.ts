import { buildApiUrl, normalizeServerUrl, type ApiQuery } from "./url.js";

export type MobApiClientOptions = {
  server: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit;
};

export type MobApiRequestOptions = {
  method?: string;
  query?: ApiQuery;
  body?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
};

type MobApiErrorOptions = {
  status?: number;
  code?: string;
  method: string;
  path: string;
};

export class MobApiError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  readonly method: string;
  readonly path: string;

  constructor(message: string, options: MobApiErrorOptions) {
    super(message);
    this.name = "MobApiError";
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.method = options.method;
    this.path = options.path;
  }
}

function redactErrorText(value: string, token: string | undefined): string {
  let result = value;
  if (token) result = result.split(token).join("[REDACTED]");
  return result
    .replace(/\bBearer\s+[^\s"'<>]+/giu, "Bearer [REDACTED]")
    .replace(/([?&](?:access_)?token=)[^&\s]+/giu, "$1[REDACTED]");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown transport error";
}

function isFormData(value: unknown): value is FormData {
  return typeof FormData !== "undefined" && value instanceof FormData;
}

async function httpErrorDetail(response: Response): Promise<{ code?: string; detail?: string }> {
  let text: string;
  try {
    text = (await response.text()).trim();
  } catch {
    return {};
  }
  if (!text) return {};

  if (response.headers.get("content-type")?.toLowerCase().includes("json")) {
    try {
      const value = JSON.parse(text) as unknown;
      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const code = typeof record.error === "string" ? record.error : undefined;
        const detail =
          typeof record.message === "string"
            ? record.message
            : typeof record.error_description === "string"
              ? record.error_description
              : undefined;
        return {
          ...(code ? { code } : {}),
          ...(detail ? { detail: detail.slice(0, 500) } : {}),
        };
      }
    } catch {
      return { detail: "The server returned an invalid JSON error response" };
    }
  }
  return { detail: text.slice(0, 500) };
}

export class MobApiClient {
  readonly server: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #headers: Headers;

  constructor(options: MobApiClientOptions) {
    this.server = normalizeServerUrl(options.server);
    if (
      options.token !== undefined &&
      (!options.token || options.token.trim() !== options.token || /[\u0000-\u001f\u007f]/u.test(options.token))
    ) {
      throw new Error("Invalid Mob API token");
    }
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#headers = new Headers(options.headers);
  }

  async response(apiPath: string, options: MobApiRequestOptions = {}): Promise<Response> {
    const url = buildApiUrl(this.server, apiPath, options.query);
    const parsedUrl = new URL(url);
    const path = redactErrorText(parsedUrl.pathname, this.#token);
    const requestMethod = (options.method ?? "GET").toUpperCase();
    const method = redactErrorText(requestMethod, this.#token);
    const headers = new Headers(this.#headers);
    for (const [name, value] of new Headers(options.headers)) headers.set(name, value);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    if (this.#token) headers.set("authorization", `Bearer ${this.#token}`);

    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      if (isFormData(options.body)) {
        body = options.body;
        headers.delete("content-type");
      } else {
        try {
          body = JSON.stringify(options.body);
        } catch (error) {
          throw new MobApiError(
            `Mob API ${method} ${path} could not encode its JSON body: ${redactErrorText(errorMessage(error), this.#token)}`,
            { method, path, code: "invalid_request_body" },
          );
        }
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
      }
    }

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: requestMethod,
        headers,
        ...(body === undefined ? {} : { body }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      throw new MobApiError(
        `Mob API ${method} ${path} request failed: ${redactErrorText(errorMessage(error), this.#token)}`,
        { method, path, code: "transport_error" },
      );
    }

    if (!response.ok) {
      const { code, detail } = await httpErrorDetail(response);
      const safeCode = code ? redactErrorText(code, this.#token).slice(0, 100) : undefined;
      const statusLabel = response.statusText
        ? `${response.status} ${redactErrorText(response.statusText, this.#token)}`
        : String(response.status);
      const detailSuffix = detail
        ? `: ${redactErrorText(detail, this.#token)}`
        : "";
      throw new MobApiError(
        `Mob API ${method} ${path} failed (${statusLabel})${detailSuffix}`,
        {
          method,
          path,
          status: response.status,
          ...(safeCode ? { code: safeCode } : {}),
        },
      );
    }

    return response;
  }

  async request<T = unknown>(apiPath: string, options: MobApiRequestOptions = {}): Promise<T> {
    const response = await this.response(apiPath, options);
    if (response.status === 204 || response.status === 205) return undefined as T;

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("json")) {
      try {
        return (await response.json()) as T;
      } catch {
        const path = redactErrorText(
          new URL(buildApiUrl(this.server, apiPath, options.query)).pathname,
          this.#token,
        );
        const method = redactErrorText((options.method ?? "GET").toUpperCase(), this.#token);
        throw new MobApiError(`Mob API response for ${path} was not valid JSON`, {
          method,
          path,
          status: response.status,
          code: "invalid_response",
        });
      }
    }
    return (await response.text()) as T;
  }
}
