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
    itemId: string,
    result: ToolDetailResult,
  ): ToolDetailResponse {
    return {
      itemId,
      input: result.detail.input,
      output: result.detail.output,
      truncated: result.detail.truncated,
    };
  }

  directiveDetail(
    itemId: string,
    result: DirectiveDetailResult,
  ): DirectiveDetailResponse {
    return {
      itemId,
      text: result.detail.text,
      truncated: result.detail.truncated,
    };
  }

  internalDetail(
    itemId: string,
    result: InternalDetailResult,
  ): InternalDetailResponse {
    return {
      itemId,
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
    if (item.kind === "user_input") {
      if (item.stage === "request") {
        return {
          ...item,
          questions: item.questions.map((question) => ({
            ...question,
            options: question.options.map((option) => ({ ...option })),
          })),
        };
      }
      return item.outcome === "answered"
        ? {
            ...item,
            answers: item.answers.map((answer) => ({
              ...answer,
              answers: [...answer.answers],
            })),
          }
        : { ...item };
    }
    if (item.kind !== "token") return { ...item };
    return {
      ...item,
      tokenUsage: {
        total: item.tokenUsage.total === null ? null : { ...item.tokenUsage.total },
        last: item.tokenUsage.last === null ? null : { ...item.tokenUsage.last },
      },
    };
  }

  diagnostic(item: DomainDiagnostic): Diagnostic {
    return { ...item };
  }
}
