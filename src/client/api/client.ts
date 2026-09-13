import type {
  ApiError,
  DirectiveDetailQuery,
  DirectiveDetailResponse,
  InteractionKey,
  InternalDetailQuery,
  InternalDetailResponse,
  ItemPageQuery,
  ItemPageResponse,
  SessionLiveQuery,
  SessionLiveResponse,
  SessionListQuery,
  SessionListResponse,
  ToolDetailQuery,
  ToolDetailResponse,
  TerminalPreviewResponse,
} from "../../shared/api-contract";

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

async function request<T>(
  path: string,
  signal?: AbortSignal,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { Accept: "application/json", ...init.headers },
    signal,
  });
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // The API normally returns JSON, but the client still fails safely if a proxy does not.
    }
    const apiError = parseApiError(body);
    throw new ApiClientError(
      response.status,
      apiError?.code ?? "request_failed",
      apiError?.message ?? `Request failed (${response.status})`,
    );
  }
  return response.status === 204
    ? undefined as T
    : response.json() as Promise<T>;
}

function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, signal, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function parseApiError(value: unknown): ApiError["error"] | null {
  if (typeof value !== "object" || value === null || !("error" in value)) return null;
  const error = value.error;
  if (typeof error !== "object" || error === null) return null;
  if (!("code" in error) || typeof error.code !== "string") return null;
  if (!("message" in error) || typeof error.message !== "string") return null;
  return { code: error.code, message: error.message };
}

function queryString(values: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const api = {
  sessions: (query: SessionListQuery, signal?: AbortSignal) =>
    request<SessionListResponse>(
      `/api/v1/sessions${queryString({
        project: query.project,
        from: query.from,
        to: query.to,
        limit: query.limit,
        cursor: query.cursor,
        fresh: query.fresh,
      })}`,
      signal,
    ),
  items: (id: string, query: ItemPageQuery, signal?: AbortSignal) =>
    request<ItemPageResponse>(
      `/api/v1/sessions/${encodeURIComponent(id)}/items${queryString({
        limit: query.limit,
        cursor: query.cursor,
      })}`,
      signal,
    ),
  live: (id: string, query: SessionLiveQuery, signal?: AbortSignal) =>
    request<SessionLiveResponse | null>(
      `/api/v1/sessions/${encodeURIComponent(id)}/live${queryString({
        cursor: query.cursor,
        after: query.after,
      })}`,
      signal,
    ).then((value) => value ?? null),
  tool: (
    sessionId: string,
    itemId: string,
    query: ToolDetailQuery,
    signal?: AbortSignal,
  ) =>
    request<ToolDetailResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(itemId)}/tool${queryString({ cursor: query.cursor })}`,
      signal,
    ),
  directive: (
    sessionId: string,
    itemId: string,
    query: DirectiveDetailQuery,
    signal?: AbortSignal,
  ) =>
    request<DirectiveDetailResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(itemId)}/directive${queryString({ cursor: query.cursor })}`,
      signal,
    ),
  internal: (
    sessionId: string,
    itemId: string,
    query: InternalDetailQuery,
    signal?: AbortSignal,
  ) =>
    request<InternalDetailResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(itemId)}/internal${queryString({ cursor: query.cursor })}`,
      signal,
    ),
  sendMessage: (sessionId: string, message: string, signal?: AbortSignal) =>
    postJson<void>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      { message },
      signal,
    ),
  sendKeys: (
    sessionId: string,
    keys: readonly InteractionKey[],
    signal?: AbortSignal,
  ) =>
    postJson<void>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/keys`,
      { keys },
      signal,
    ),
  terminalPreview: (sessionId: string, signal?: AbortSignal) =>
    request<TerminalPreviewResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/terminal-preview`,
      signal,
    ),
};
