import type {
  DirectiveDetailQuery,
  DirectiveDetailResponse,
  ItemPageQuery,
  ItemPageResponse,
  SessionDetailResponse,
  SessionListQuery,
  SessionListResponse,
  TimelineCursor,
  ToolDetailQuery,
  ToolDetailResponse,
  InternalDetailQuery,
  InternalDetailResponse,
} from "../../shared/api-contract.js";
import type { SessionId } from "../../shared/domain.js";
import type { DomainAgentInteraction } from "../domain/session-domain.js";

export interface SessionReader {
  list(query: SessionListQuery): Promise<SessionListResponse>;
  getSession(id: SessionId): Promise<SessionReadDetailResponse | null>;
  getItems(id: SessionId, query: ItemPageQuery): Promise<SessionItemPageResponse | null>;
  getLiveSession(id: SessionId, cursor: TimelineCursor): Promise<LiveSessionSnapshot | null>;
  getToolDetail(
    id: SessionId,
    itemId: string,
    query: ToolDetailQuery,
  ): Promise<ToolDetailResponse | null>;
  getDirectiveDetail(
    id: SessionId,
    itemId: string,
    query: DirectiveDetailQuery,
  ): Promise<DirectiveDetailResponse | null>;
  getInternalDetail(
    id: SessionId,
    itemId: string,
    query: InternalDetailQuery,
  ): Promise<InternalDetailResponse | null>;
  refresh(): Promise<void>;
  getInteractionSession(id: SessionId): Promise<InteractionSessionSnapshot | null>;
}

export type SessionReadDetailResponse = Omit<
  SessionDetailResponse,
  "interaction" | "liveRevision"
>;

export type SessionItemPageResponse = Omit<
  ItemPageResponse,
  "interaction" | "liveRevision"
>;

export interface LiveSessionSnapshot {
  readonly session: SessionDetailResponse["session"];
  readonly cursor: TimelineCursor;
  readonly hasMore: boolean;
  readonly interactionSession: InteractionSessionSnapshot;
}

export interface InteractionSessionSnapshot {
  readonly archived: boolean;
  readonly interaction: DomainAgentInteraction | null;
}
