export type SessionId = string;
export type ItemId = string;

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  ordinal: number | null;
}

export interface AgentIdentity {
  taskName: string | null;
  nickname: string | null;
  role: string | null;
}

export interface SessionOrigin {
  sourceType: string;
  sourceInstanceId: string;
  agentName: string;
  agentVersion: string | null;
  formatVersion: string | null;
}

export interface SessionSummary {
  id: SessionId;
  origin: SessionOrigin;
  title: string;
  nickname: string | null;
  cwd: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  archived: boolean;
  parentId: SessionId | null;
  childIds: SessionId[];
  agent: AgentIdentity | null;
  messageCount: number;
  toolCount: number;
  warningCount: number;
}

export interface SessionDetail extends SessionSummary {
  sourceId: string | null;
  diagnostics: Diagnostic[];
  itemCount: number;
}

interface TimelineItemBase {
  id: ItemId;
  ordinal: number;
  timestamp: string | null;
}

export interface MessageItem extends TimelineItemBase {
  kind: "message";
  role: "user" | "assistant";
  phase: "commentary" | "final" | null;
  itemType: string | null;
  markdown: string;
}

interface DirectiveItemBase extends TimelineItemBase {
  kind: "directive";
}

export interface InlineDirectiveItem extends DirectiveItemBase {
  hasDetail: false;
  text: string;
}

export interface LazyDirectiveItem extends DirectiveItemBase {
  hasDetail: true;
  summary: string;
  charCount: number;
}

export type DirectiveItem = InlineDirectiveItem | LazyDirectiveItem;

interface ToolItemBase extends TimelineItemBase {
  kind: "tool";
  callId: string;
  toolName: string;
  preview: string | null;
  charCount: number;
  hasDetail: boolean;
}

export interface ToolCallItem extends ToolItemBase {
  stage: "call";
}

export interface ToolOutputItem extends ToolItemBase {
  stage: "output";
  status: "completed" | "failed";
}

export type ToolItem = ToolCallItem | ToolOutputItem;

export interface UserInputOption {
  label: string;
  description: string;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: UserInputOption[];
}

export interface UserInputAnswer {
  questionId: string;
  answers: string[];
}

interface UserInputItemBase extends TimelineItemBase {
  kind: "user_input";
  callId: string;
}

export interface UserInputRequestItem extends UserInputItemBase {
  stage: "request";
  questions: UserInputQuestion[];
}

export interface AnsweredUserInputItem extends UserInputItemBase {
  stage: "response";
  outcome: "answered";
  answers: UserInputAnswer[];
}

export interface AbortedUserInputItem extends UserInputItemBase {
  stage: "response";
  outcome: "aborted";
}

export interface UnavailableUserInputItem extends UserInputItemBase {
  stage: "response";
  outcome: "unavailable";
  summary: string;
}

export type UserInputItem =
  | UserInputRequestItem
  | AnsweredUserInputItem
  | AbortedUserInputItem
  | UnavailableUserInputItem;

export interface TokenUsageCounters {
  totalTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
}

export interface TokenItem extends TimelineItemBase {
  kind: "token";
  tokenUsage: {
    total: TokenUsageCounters | null;
    last: TokenUsageCounters | null;
  };
}

export interface InternalEventItem extends TimelineItemBase {
  kind: "internal";
  eventType: string;
}

export type TimelineItem =
  | MessageItem
  | DirectiveItem
  | ToolItem
  | UserInputItem
  | TokenItem
  | InternalEventItem;
