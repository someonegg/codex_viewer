import type {
  ItemPageResponse,
  LiveRevision,
  TimelineCursor,
} from "../../src/shared/api-contract";
import type {
  DirectiveItem as Directive,
  SessionSummary,
  ToolItem as Tool,
} from "../../src/shared/domain";

export const SESSION_ID = "abcdefghijklmnopqrstuvwx";
export const CHILD_ID = "zyxwvutsrqponmlkjihgfedc";
export const TIMELINE_CURSOR = "opaque.timeline.cursor" as TimelineCursor;
export const NEXT_TIMELINE_CURSOR = "opaque.timeline.next" as TimelineCursor;
export const LIVE_REVISION = "opaque.live.revision" as LiveRevision;

export const baseSession: SessionSummary = {
  id: SESSION_ID, title: "Reader work", nickname: null, cwd: "/project/reader",
  origin: {
    sourceType: "codex-jsonl",
    sourceInstanceId: "source-instance",
    agentName: "Codex",
    agentVersion: null,
    formatVersion: null,
  },
  createdAt: "2026-07-28T10:00:00Z", updatedAt: "2026-07-28T11:00:00Z",
  archived: false, parentId: null, childIds: [],
  agent: null,
  messageCount: 2, toolCount: 1, warningCount: 0,
};

export const listBody = {
  sessions: [baseSession],
  projects: [{ project: "/project/reader", count: 1 }],
  total: 1, nextCursor: null,
  diagnostics: [],
};

const sessionDetail = {
  ...baseSession,
  sourceId: "original-session-id",
  diagnostics: [],
  itemCount: 3,
};

export function readContext(
  cursor: TimelineCursor = TIMELINE_CURSOR,
  hasMore = true,
) {
  return {
    cursor,
    session: sessionDetail,
    hasMore,
    liveRevision: LIVE_REVISION,
  };
}

export const toolItem: Tool = {
  kind: "tool", stage: "output", id: "tool-2", ordinal: 2, timestamp: null,
  callId: "call-reader", toolName: "exec",
  status: "completed", preview: "inspect", truncated: false, hasDetail: true,
};

export const directiveItem: Directive = {
  kind: "directive",
  id: "directive-4",
  ordinal: 4,
  timestamp: null,
  summary: "AGENTS.md instructions",
  charCount: 1_892,
  truncated: false,
  hasDetail: true,
};

export const firstPage: ItemPageResponse = {
  ...readContext(),
  interaction: { supported: false },
  liveRevision: LIVE_REVISION,
  items: [
    { kind: "message", id: "message-1", ordinal: 1, timestamp: null, role: "user", phase: null, itemType: null, markdown: "Hello" },
    toolItem,
  ],
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
