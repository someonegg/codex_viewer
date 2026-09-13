import type { ServerResponse } from "node:http";
import type {
  DirectiveDetailQuery,
  ItemPageQuery,
  InternalDetailQuery,
  SessionListQuery,
  TimelineCursor,
  ToolDetailQuery,
} from "../../shared/api-contract.js";
import type { SessionReader } from "../application/session-reader.js";
import type { SessionInteractionService } from "../interaction/interaction-service.js";
import { withLiveRevision } from "../live/live-revision.js";
import type { SessionLiveService } from "../live/session-live-service.js";
import { RepositoryQueryError } from "../repository/session-queries.js";
import type { ApiRouteHandler } from "./api-route-handler.js";
import { sendJson } from "./router.js";

const SESSION_ROOT = "/api/v1/sessions";

type InteractionReader = Pick<SessionInteractionService, "describe">;

export function createSessionReadRoutes(dependencies: {
  readonly sessions: SessionReader;
  readonly live: SessionLiveService;
  readonly interaction?: InteractionReader;
}): ApiRouteHandler {
  return {
    matches: () => true,
    async handle(request, response, url) {
      const headOnly = request.method === "HEAD";
      const readMethod = request.method === "GET" || headOnly;
      if (url.pathname === SESSION_ROOT) {
        if (!readMethod) return false;
        sendJson(
          response,
          200,
          await dependencies.sessions.list(parseListQuery(url.searchParams)),
          headOnly,
        );
        return true;
      }
      if (!url.pathname.startsWith(`${SESSION_ROOT}/`)) {
        return notFound(response, headOnly);
      }
      const [id = "", ...segments] = url.pathname
        .slice(SESSION_ROOT.length + 1)
        .split("/");
      if (!isOpaqueId(id)) return notFound(response, headOnly);
      const itemId = segments[1] ?? "";

      if (segments.length === 0) {
        if (!readMethod) return false;
        if ([...url.searchParams].length > 0) {
          invalid("session metadata does not accept query parameters");
        }
        const result = await dependencies.sessions.getSession(id);
        if (result === null) {
          return notFound(response, headOnly, "session_not_found");
        }
        const interaction = await describeInteraction(dependencies.interaction, id);
        sendJson(response, 200, withLiveRevision({
          ...result,
          interaction,
        }, dependencies.live.revision.bind(dependencies.live)), headOnly);
        return true;
      }
      if (segments.length === 1 && segments[0] === "items") {
        if (!readMethod) return false;
        const result = await dependencies.sessions.getItems(
          id,
          parseItemQuery(url.searchParams),
        );
        if (result === null) {
          return notFound(response, headOnly, "session_not_found");
        }
        const interaction = await describeInteraction(dependencies.interaction, id);
        sendJson(response, 200, withLiveRevision({
          ...result,
          interaction,
        }, dependencies.live.revision.bind(dependencies.live)), headOnly);
        return true;
      }
      if (
        segments.length === 3 &&
        segments[0] === "items" &&
        isItemId(itemId) &&
        segments[2] === "tool"
      ) {
        if (!readMethod) return false;
        const result = await dependencies.sessions.getToolDetail(
          id,
          itemId,
          parseToolQuery(url.searchParams),
        );
        if (result === null) {
          return notFound(response, headOnly, "tool_not_found");
        }
        sendJson(response, 200, result, headOnly);
        return true;
      }
      if (
        segments.length === 3 &&
        segments[0] === "items" &&
        isItemId(itemId) &&
        segments[2] === "internal"
      ) {
        if (!readMethod) return false;
        const result = await dependencies.sessions.getInternalDetail(
          id,
          itemId,
          parseInternalQuery(url.searchParams),
        );
        if (result === null) {
          return notFound(response, headOnly, "internal_not_found");
        }
        sendJson(response, 200, result, headOnly);
        return true;
      }
      if (
        segments.length === 3 &&
        segments[0] === "items" &&
        isItemId(itemId) &&
        segments[2] === "directive"
      ) {
        if (!readMethod) return false;
        const result = await dependencies.sessions.getDirectiveDetail(
          id,
          itemId,
          parseDirectiveQuery(url.searchParams),
        );
        if (result === null) {
          return notFound(response, headOnly, "directive_not_found");
        }
        sendJson(response, 200, result, headOnly);
        return true;
      }
      return notFound(response, headOnly);
    },
    mapError(error, request, response) {
      if (!(error instanceof RepositoryQueryError)) return false;
      const status = error.code === "stale_list_cursor" ||
          error.code === "timeline_changed"
        ? 409
        : 400;
      sendJson(response, status, {
        error: { code: error.code, message: error.message },
      }, request.method === "HEAD");
      return true;
    },
  };
}

async function describeInteraction(
  interaction: InteractionReader | undefined,
  sessionId: string,
) {
  if (interaction === undefined) return { supported: false as const };
  return await interaction.describe(sessionId) ?? { supported: false as const };
}

function parseListQuery(params: URLSearchParams): SessionListQuery {
  only(params, ["project", "from", "to", "limit", "cursor", "fresh"]);
  const query: SessionListQuery = {};
  const project = optional(params, "project");
  const from = optional(params, "from");
  const to = optional(params, "to");
  const limit = optional(params, "limit");
  const cursor = optional(params, "cursor");
  const fresh = optional(params, "fresh");
  if (project !== undefined) query.project = project;
  if (from !== undefined) query.from = from;
  if (to !== undefined) query.to = to;
  if (limit !== undefined) query.limit = integer(limit, "limit");
  if (cursor !== undefined) {
    query.cursor = cursor as import("../../shared/api-contract.js").ListCursor;
  }
  if (fresh !== undefined) {
    if (fresh !== "true") invalid("fresh must be true when provided");
    query.fresh = true;
  }
  if (query.fresh && query.cursor !== undefined) {
    invalid("fresh cannot be used with cursor");
  }
  return query;
}

function parseItemQuery(params: URLSearchParams): ItemPageQuery {
  only(params, ["limit", "cursor"]);
  const query: ItemPageQuery = {};
  const cursor = optional(params, "cursor");
  if (cursor !== undefined) query.cursor = cursor as TimelineCursor;
  const limit = optional(params, "limit");
  if (limit !== undefined) query.limit = integer(limit, "limit");
  return query;
}

function parseToolQuery(params: URLSearchParams): ToolDetailQuery {
  only(params, ["cursor"]);
  return { cursor: requiredCursor(params, "tool detail") };
}

function parseDirectiveQuery(params: URLSearchParams): DirectiveDetailQuery {
  only(params, ["cursor"]);
  return { cursor: requiredCursor(params, "directive detail") };
}

function parseInternalQuery(params: URLSearchParams): InternalDetailQuery {
  only(params, ["cursor"]);
  return { cursor: requiredCursor(params, "internal detail") };
}

function requiredCursor(params: URLSearchParams, resource: string): TimelineCursor {
  const cursor = optional(params, "cursor");
  if (cursor === undefined) invalid(`cursor is required for ${resource}`);
  return cursor as TimelineCursor;
}

function optional(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  if (values.length > 1) invalid(`${name} must appear once`);
  return values[0];
}

function only(params: URLSearchParams, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  for (const name of params.keys()) {
    if (!accepted.has(name)) invalid(`${name} is not supported`);
  }
}

function integer(value: string, name: string): number {
  if (!/^\d+$/.test(value)) invalid(`${name} must be an integer`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    invalid(`${name} is outside the supported range`);
  }
  return result;
}

function invalid(message: string): never {
  throw new RepositoryQueryError("invalid_query", message);
}

function isOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,100}$/.test(value);
}

function isItemId(value: string): boolean {
  return /^(?:message|directive|tool|token|internal)-\d+$/.test(value);
}

function notFound(
  response: ServerResponse,
  headOnly: boolean,
  code = "not_found",
): true {
  sendJson(
    response,
    404,
    { error: { code, message: "API resource not found" } },
    headOnly,
  );
  return true;
}
