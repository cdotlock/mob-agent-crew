export type ApiQueryValue = string | number | boolean | null | undefined;
export type ApiQuery =
  | URLSearchParams
  | Record<string, ApiQueryValue | readonly ApiQueryValue[]>;

const schemePattern = /^[a-z][a-z\d+.-]*:/iu;
const controlCharacterPattern = /[\u0000-\u001f\u007f]/u;

function invalidServerUrl(): never {
  throw new Error("Invalid Mob server URL; expected an HTTP(S) URL without credentials or query data");
}

export function normalizeServerUrl(server: string): string {
  const value = server.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidServerUrl();
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return invalidServerUrl();
  }

  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  const normalized = url.toString();
  return url.pathname === "/" ? normalized.slice(0, -1) : normalized;
}

function unsafeApiPath(): never {
  throw new Error("Unsafe API path; expected a relative path without traversal or fragments");
}

function decodeSafeSegment(rawSegment: string): string {
  let decoded = rawSegment;
  for (let index = 0; index < 4; index += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return unsafeApiPath();
    }

    if (
      next === "." ||
      next === ".." ||
      next.includes("/") ||
      next.includes("\\") ||
      controlCharacterPattern.test(next)
    ) {
      return unsafeApiPath();
    }
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function addQueryValue(parameters: URLSearchParams, key: string, value: ApiQueryValue): void {
  if (value === undefined) return;
  parameters.append(key, value === null ? "" : String(value));
}

export function buildApiUrl(server: string, apiPath: string, query?: ApiQuery): string {
  const normalizedServer = normalizeServerUrl(server);
  const value = apiPath.trim();
  if (
    schemePattern.test(value) ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("#") ||
    controlCharacterPattern.test(value)
  ) {
    return unsafeApiPath();
  }

  const queryIndex = value.indexOf("?");
  const rawPath = queryIndex === -1 ? value : value.slice(0, queryIndex);
  const inlineQuery = queryIndex === -1 ? "" : value.slice(queryIndex + 1);
  const segments = rawPath.replace(/^\/+|\/+$/gu, "").split("/").filter(Boolean);
  const safePath = segments.map((segment) => encodeURIComponent(decodeSafeSegment(segment))).join("/");

  const url = new URL(`${normalizedServer}/`);
  const basePath = url.pathname.replace(/\/+$/u, "");
  url.pathname = safePath ? `${basePath}/${safePath}` : basePath || "/";
  url.search = inlineQuery;

  if (query instanceof URLSearchParams) {
    for (const key of new Set(query.keys())) url.searchParams.delete(key);
    for (const [key, value] of query) url.searchParams.append(key, value);
  } else if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.delete(key);
      if (Array.isArray(value)) {
        for (const item of value) addQueryValue(url.searchParams, key, item);
      } else {
        addQueryValue(url.searchParams, key, value as ApiQueryValue);
      }
    }
  }

  return url.toString();
}
