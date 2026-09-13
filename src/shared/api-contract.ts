import type {
  Diagnostic,
  ItemId,
  SessionDetail,
  SessionSummary,
  TimelineItem,
} from "./domain.js";

export const MAX_INTERACTION_MESSAGE_BYTES = 64 * 1024;
export const MAX_INTERACTION_KEY_SEQUENCE_LENGTH = 64;

export const INTERACTION_KEYS = [
  "enter",
  "up",
  "down",
  "left",
  "right",
  "interrupt",
  "plan",
] as const;

export type InteractionKey = typeof INTERACTION_KEYS[number];

declare const listCursorBrand: unique symbol;
export type ListCursor = string & { readonly [listCursorBrand]: true };
declare const timelineCursorBrand: unique symbol;
export type TimelineCursor = string & { readonly [timelineCursorBrand]: true };
declare const liveRevisionBrand: unique symbol;
export type LiveRevision = string & { readonly [liveRevisionBrand]: true };

export interface ApiError {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}

export interface SessionListQuery {
  project?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: ListCursor;
  fresh?: boolean;
}

export interface ProjectFacet {
  project: string;
  count: number;
}

export interface SessionListResponse {
  sessions: SessionSummary[];
  projects: ProjectFacet[];
  total: number;
  nextCursor: ListCursor | null;
  diagnostics: Diagnostic[];
}

export interface SessionDetailResponse {
  session: SessionDetail;
  interaction: InteractionResponse;
  liveRevision: LiveRevision;
}

export interface ItemPageQuery {
  limit?: number;
  cursor?: TimelineCursor;
}

export interface ItemPageResponse {
  session: SessionDetail;
  cursor: TimelineCursor;
  hasMore: boolean;
  items: TimelineItem[];
  interaction: InteractionResponse;
  liveRevision: LiveRevision;
}

export interface SessionLiveQuery {
  cursor: TimelineCursor;
  after: LiveRevision;
}

export interface SessionLiveResponse {
  session: SessionDetail;
  cursor: TimelineCursor;
  hasMore: boolean;
  interaction: InteractionResponse;
  liveRevision: LiveRevision;
}

export interface ToolDetailResponse {
  itemId: ItemId;
  input: string | null;
  output: string | null;
  truncated: boolean;
}

export interface ToolDetailQuery {
  cursor: TimelineCursor;
}

export interface DirectiveDetailResponse {
  itemId: ItemId;
  text: string;
  truncated: boolean;
}

export interface DirectiveDetailQuery {
  cursor: TimelineCursor;
}

export interface InternalDetailResponse {
  itemId: ItemId;
  json: string;
  truncated: boolean;
}

export interface InternalDetailQuery {
  cursor: TimelineCursor;
}

export type InteractionState =
  | "unbound"
  | "disconnected"
  | "connected";

export type InteractionResponse =
  | { supported: false }
  | {
      supported: true;
      state: InteractionState;
      activation: string;
    };

export interface TerminalPreviewResponse {
  content: string;
  truncated: boolean;
  capturedAt: string;
}
