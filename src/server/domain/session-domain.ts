import type { InteractionKey } from "../../shared/api-contract.js";

export type DomainSessionId = string;
export type DomainItemId = string;

export type DomainDiagnosticSeverity = "info" | "warning" | "error";

export interface DomainDiagnostic {
  readonly code: string;
  readonly severity: DomainDiagnosticSeverity;
  readonly message: string;
  readonly ordinal: number | null;
}

export interface DomainAgentIdentity {
  readonly taskName: string | null;
  readonly nickname: string | null;
  readonly role: string | null;
}

export interface DomainSessionOrigin {
  readonly sourceType: string;
  readonly sourceInstanceId: string;
  readonly agentName: string;
  readonly agentVersion: string | null;
  readonly formatVersion: string | null;
}

export type InteractionBindingAttempt =
  | {
      readonly ordinal: number;
      readonly valid: true;
      readonly socketPath: string;
      readonly paneId: string;
    }
  | {
      readonly ordinal: number;
      readonly valid: false;
    };

export type TmuxKey =
  | "Enter"
  | "Up"
  | "Down"
  | "Left"
  | "Right"
  | "C-c"
  | "BTab";

export type InteractionKeyBindings = Readonly<Record<InteractionKey, TmuxKey>>;

export interface DomainAgentInteraction {
  readonly activation: string;
  readonly bindingAttempt: InteractionBindingAttempt | null;
  readonly keyBindings: InteractionKeyBindings;
}

export interface DomainSession {
  readonly id: DomainSessionId;
  readonly sourceId: string | null;
  readonly origin: DomainSessionOrigin;
  readonly title: string;
  readonly cwd: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly archived: boolean;
  readonly parentId: DomainSessionId | null;
  readonly childIds: readonly DomainSessionId[];
  readonly agent: DomainAgentIdentity | null;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly warningCount: number;
  readonly diagnostics: readonly DomainDiagnostic[];
  readonly itemCount: number;
}

interface DomainTimelineRecordBase {
  readonly id: DomainItemId;
  readonly ordinal: number;
  readonly timestamp: string | null;
}

export interface DomainMessageRecord extends DomainTimelineRecordBase {
  readonly kind: "message";
  readonly role: "user" | "assistant";
  readonly phase: "commentary" | "final" | null;
  readonly itemType: string | null;
  readonly markdown: string;
}

interface DomainDirectiveRecordBase extends DomainTimelineRecordBase {
  readonly kind: "directive";
  readonly charCount: number;
}

export interface DomainInlineDirectiveRecord extends DomainDirectiveRecordBase {
  readonly hasDetail: false;
  readonly text: string;
}

export interface DomainLazyDirectiveRecord extends DomainDirectiveRecordBase {
  readonly hasDetail: true;
  readonly summary: string;
  readonly truncated: boolean;
}

export type DomainDirectiveRecord =
  | DomainInlineDirectiveRecord
  | DomainLazyDirectiveRecord;

interface DomainToolRecordBase extends DomainTimelineRecordBase {
  readonly kind: "tool";
  readonly callId: string;
  readonly toolName: string;
  readonly preview: string | null;
  readonly truncated: boolean;
  readonly hasDetail: boolean;
}

export interface DomainToolCallRecord extends DomainToolRecordBase {
  readonly stage: "call";
}

export interface DomainToolOutputRecord extends DomainToolRecordBase {
  readonly stage: "output";
  readonly status: "completed" | "failed";
}

export type DomainToolRecord = DomainToolCallRecord | DomainToolOutputRecord;

export interface DomainUserInputOption {
  readonly label: string;
  readonly description: string;
}

export interface DomainUserInputQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly DomainUserInputOption[];
}

export interface DomainUserInputAnswer {
  readonly questionId: string;
  readonly answers: readonly string[];
}

interface DomainUserInputRecordBase extends DomainTimelineRecordBase {
  readonly kind: "user_input";
  readonly callId: string;
}

export interface DomainUserInputRequestRecord extends DomainUserInputRecordBase {
  readonly stage: "request";
  readonly questions: readonly DomainUserInputQuestion[];
}

export interface DomainAnsweredUserInputRecord extends DomainUserInputRecordBase {
  readonly stage: "response";
  readonly outcome: "answered";
  readonly answers: readonly DomainUserInputAnswer[];
}

export interface DomainAbortedUserInputRecord extends DomainUserInputRecordBase {
  readonly stage: "response";
  readonly outcome: "aborted";
}

export interface DomainUnavailableUserInputRecord extends DomainUserInputRecordBase {
  readonly stage: "response";
  readonly outcome: "unavailable";
  readonly summary: string;
}

export type DomainUserInputRecord =
  | DomainUserInputRequestRecord
  | DomainAnsweredUserInputRecord
  | DomainAbortedUserInputRecord
  | DomainUnavailableUserInputRecord;

export interface DomainTokenUsageCounters {
  readonly totalTokens: number | null;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningOutputTokens: number | null;
}

export interface DomainTokenRecord extends DomainTimelineRecordBase {
  readonly kind: "token";
  readonly tokenUsage: {
    readonly total: DomainTokenUsageCounters | null;
    readonly last: DomainTokenUsageCounters | null;
  };
}

export interface DomainInternalEventRecord extends DomainTimelineRecordBase {
  readonly kind: "internal";
  readonly eventType: string;
  readonly summary: string;
  readonly truncated: boolean;
}

export type DomainTimelineRecord =
  | DomainMessageRecord
  | DomainDirectiveRecord
  | DomainToolRecord
  | DomainUserInputRecord
  | DomainTokenRecord
  | DomainInternalEventRecord;

export interface DomainToolDetail {
  readonly input: string | null;
  readonly output: string | null;
  readonly truncated: boolean;
}

export interface DomainDirectiveDetail {
  readonly text: string;
  readonly truncated: boolean;
}

export interface DomainInternalDetail {
  readonly json: string;
  readonly truncated: boolean;
}

export interface NormalizedSession {
  readonly session: DomainSession;
  readonly timeline: readonly DomainTimelineRecord[];
  readonly toolDetails: ReadonlyMap<DomainItemId, DomainToolDetail>;
  readonly directiveDetails: ReadonlyMap<DomainItemId, DomainDirectiveDetail>;
  readonly internalDetails: ReadonlyMap<DomainItemId, DomainInternalDetail>;
  readonly interaction?: DomainAgentInteraction | null;
}
