import type {
  DirectiveDetailResponse,
  ItemPageResponse,
  InternalDetailResponse,
  ListCursor,
  SessionDetailResponse,
  SessionListResponse,
  TimelineCursor,
  ToolDetailResponse,
} from "../../shared/api-contract.js";
import type {
  Diagnostic,
  SessionDetail,
  SessionSummary,
  TimelineItem,
} from "../../shared/domain.js";
import type {
  DomainDiagnostic,
  DomainSession,
  DomainTimelineRecord,
} from "../domain/session-domain.js";
import type {
  DirectiveDetailResult,
  ItemPageResult,
  InternalDetailResult,
  SessionListResult,
  ToolDetailResult,
} from "../repository/session-queries.js";

export type SessionNicknameResolver = (session: DomainSession) => string | null;

export class SessionApiMapper {
  constructor(
    private readonly resolveNickname: SessionNicknameResolver = () => null,
  ) {}

  list(
    result: SessionListResult,
    diagnostics: readonly DomainDiagnostic[],
  ): SessionListResponse {
    return {
      sessions: result.sessions.map((session) => this.summary(session)),
      projects: result.projects.map((facet) => ({ ...facet })),
      total: result.total,
      nextCursor: result.nextCursor as ListCursor | null,
      diagnostics: diagnostics.map((item) => this.diagnostic(item)),
    };
  }

  detail(result: DomainSession): Omit<SessionDetailResponse, "interaction" | "liveRevision"> {
    return { session: this.sessionDetail(result) };
  }

  itemPage(result: ItemPageResult): Omit<ItemPageResponse, "interaction" | "liveRevision"> {
    return {
      session: this.sessionDetail(result.context.session),
      cursor: result.context.cursor as TimelineCursor,
      hasMore: result.context.hasMore,
      items: result.items.map((item) => this.timelineItem(item)),
    };
  }

  toolDetail(
    result: ToolDetailResult,
  ): ToolDetailResponse {
    return {
      input: result.detail.input,
      output: result.detail.output,
      truncated: result.detail.truncated,
    };
  }

  directiveDetail(
    result: DirectiveDetailResult,
  ): DirectiveDetailResponse {
    return {
      text: result.detail.text,
      truncated: result.detail.truncated,
    };
  }

  internalDetail(
    result: InternalDetailResult,
  ): InternalDetailResponse {
    return {
      json: result.detail.json,
      truncated: result.detail.truncated,
    };
  }

  summary(session: DomainSession): SessionSummary {
    return {
      id: session.id,
      origin: { ...session.origin },
      title: session.title,
      nickname: this.resolveNickname(session),
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      archived: session.archived,
      parentId: session.parentId,
      childIds: [...session.childIds],
      agent: session.agent === null ? null : { ...session.agent },
      messageCount: session.messageCount,
      toolCount: session.toolCount,
      warningCount: session.warningCount,
    };
  }

  sessionDetail(session: DomainSession): SessionDetail {
    return {
      ...this.summary(session),
      sourceId: session.sourceId,
      diagnostics: session.diagnostics.map((item) => this.diagnostic(item)),
      itemCount: session.itemCount,
    };
  }

  timelineItem(item: DomainTimelineRecord): TimelineItem {
    const base = { id: item.id, ordinal: item.ordinal, timestamp: item.timestamp };
    switch (item.kind) {
      case "message":
        return {
          ...base,
          kind: "message",
          role: item.role,
          phase: item.phase,
          itemType: item.itemType,
          markdown: item.markdown,
        };
      case "directive":
        return item.hasDetail
          ? {
              ...base,
              kind: "directive",
              hasDetail: true,
              summary: item.summary,
              charCount: item.charCount,
            }
          : { ...base, kind: "directive", hasDetail: false, text: item.text };
      case "tool": {
        const tool = {
          ...base,
          kind: "tool" as const,
          callId: item.callId,
          toolName: item.toolName,
          preview: item.preview,
          charCount: item.charCount,
          hasDetail: item.hasDetail,
        };
        return item.stage === "call"
          ? { ...tool, stage: "call" }
          : { ...tool, stage: "output", status: item.status };
      }
      case "user_input":
        if (item.stage === "request") {
          return {
            ...base,
            kind: "user_input",
            stage: "request",
            callId: item.callId,
            questions: item.questions.map((question) => ({
              id: question.id,
              header: question.header,
              question: question.question,
              options: question.options.map((option) => ({
                label: option.label,
                description: option.description,
              })),
            })),
          };
        }
        if (item.outcome === "answered") {
          return {
            ...base,
            kind: "user_input",
            stage: "response",
            callId: item.callId,
            outcome: "answered",
            answers: item.answers.map((answer) => ({
              questionId: answer.questionId,
              answers: [...answer.answers],
            })),
          };
        }
        return item.outcome === "unavailable"
          ? {
              ...base,
              kind: "user_input",
              stage: "response",
              callId: item.callId,
              outcome: "unavailable",
              summary: item.summary,
            }
          : {
              ...base,
              kind: "user_input",
              stage: "response",
              callId: item.callId,
              outcome: "aborted",
            };
      case "token":
        return {
          ...base,
          kind: "token",
          tokenUsage: {
            total: item.tokenUsage.total === null ? null : { ...item.tokenUsage.total },
            last: item.tokenUsage.last === null ? null : { ...item.tokenUsage.last },
          },
        };
      case "internal":
        return { ...base, kind: "internal", eventType: item.eventType };
    }
  }

  diagnostic(item: DomainDiagnostic): Diagnostic {
    return { ...item };
  }
}
