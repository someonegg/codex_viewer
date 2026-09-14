import type {
  DomainDiagnostic,
  DomainAgentInteraction,
  DomainDirectiveDetail,
  DomainInternalDetail,
  DomainSession,
  DomainSessionOrigin,
  DomainTimelineRecord,
  DomainToolDetail,
  InteractionBindingAttempt,
  NormalizedSession,
} from "../../domain/session-domain.js";
import {
  normalizeSessionTitle,
  sessionTitleFromMarkdown,
} from "../../domain/session-text.js";
import { MAX_SESSION_DIAGNOSTICS } from "./limits.js";
import {
  internalDetail,
  internalItem,
  internalItemFromPayload,
} from "./internal-event-parser.js";
import {
  eventMessage,
} from "./message-normalizer.js";
import type { SessionMetadata } from "./identity-resolver.js";
import type { RolloutDescriptor } from "./path-policy.js";
import {
  parseResponseItem,
  type ParsedResponseItem,
} from "./response-item-parser.js";
import type { DecodedRecord, DecodedRollout } from "./rollout-decoder.js";
import { isObject } from "./rollout-decoder.js";
import {
  type NormalizedTool,
  normalizeToolCall,
  normalizeToolOutput,
  type ToolCall,
} from "./tool-normalizer.js";
import {
  type NormalizedUserInput,
  normalizeUserInputRequest,
  normalizeUserInputResponse,
  type UserInputRequest,
} from "./user-input-normalizer.js";
import {
  codexBindingAttemptFrom,
  codexInteractionFromBindingAttempt,
} from "./interaction-parser.js";

export interface SessionNormalizer {
  create(descriptor: RolloutDescriptor): SessionNormalizerState;
  append(
    state: SessionNormalizerState,
    records: readonly DecodedRecord[],
    decoderDiagnostics: readonly DomainDiagnostic[],
  ): SessionNormalizerState;
  materialize(
    state: SessionNormalizerState,
    metadata: SessionMetadata,
    origin?: DomainSessionOrigin,
  ): NormalizedSession;
  normalize(
    decoded: DecodedRollout,
    metadata: SessionMetadata,
    origin?: DomainSessionOrigin,
  ): NormalizedSession;
}

export interface SessionNormalizerState {
  readonly descriptor: RolloutDescriptor;
  readonly timeline: readonly DomainTimelineRecord[];
  readonly directiveDetails: ReadonlyMap<string, DomainDirectiveDetail>;
  readonly internalDetails: ReadonlyMap<string, DomainInternalDetail>;
  readonly toolDetails: ReadonlyMap<string, DomainToolDetail>;
  readonly pendingToolCalls: ReadonlyMap<string, ToolCall>;
  readonly pendingUserInputRequests: ReadonlyMap<string, UserInputRequest>;
  readonly decoderDiagnostics: readonly DomainDiagnostic[];
  readonly normalizerDiagnostics: readonly DomainDiagnostic[];
  readonly hasFirstUserMessage: boolean;
  readonly firstUserTitle: string | null;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly bindingAttempt: InteractionBindingAttempt | null;
}

export class DefaultSessionNormalizer implements SessionNormalizer {
  create(descriptor: RolloutDescriptor): SessionNormalizerState {
    return {
      descriptor,
      timeline: [],
      directiveDetails: new Map(),
      internalDetails: new Map(),
      toolDetails: new Map(),
      pendingToolCalls: new Map(),
      pendingUserInputRequests: new Map(),
      decoderDiagnostics: [],
      normalizerDiagnostics: [],
      hasFirstUserMessage: false,
      firstUserTitle: null,
      messageCount: 0,
      toolCount: 0,
      bindingAttempt: null,
    };
  }

  append(
    state: SessionNormalizerState,
    records: readonly DecodedRecord[],
    decoderDiagnostics: readonly DomainDiagnostic[],
  ): SessionNormalizerState {
    const nextDecoderDiagnostics = decoderDiagnostics.slice(0, MAX_SESSION_DIAGNOSTICS);
    const decoderDiagnosticsUnchanged = sameDiagnostics(
      state.decoderDiagnostics,
      nextDecoderDiagnostics,
    );
    if (records.length === 0 && decoderDiagnosticsUnchanged) {
      return state;
    }

    const items: DomainTimelineRecord[] = [];
    const directiveDetails = new Map(state.directiveDetails);
    const internalDetails = new Map(state.internalDetails);
    const toolDetails = new Map(state.toolDetails);
    const pendingToolCalls = new Map(state.pendingToolCalls);
    const pendingUserInputRequests = new Map(state.pendingUserInputRequests);
    const normalizerDiagnostics = [...state.normalizerDiagnostics];
    let bindingAttempt = state.bindingAttempt;
    for (const record of records) {
      const attempt = codexBindingAttemptFrom(record);
      if (
        attempt !== null &&
        (bindingAttempt === null || attempt.ordinal >= bindingAttempt.ordinal)
      ) bindingAttempt = attempt;
      consumeRecord(
        record,
        items,
        directiveDetails,
        internalDetails,
        toolDetails,
        pendingToolCalls,
        pendingUserInputRequests,
        normalizerDiagnostics,
      );
    }

    let hasFirstUserMessage = state.hasFirstUserMessage;
    let firstTitle = state.firstUserTitle;
    let messageCount = state.messageCount;
    let toolCount = state.toolCount;
    for (const item of items) {
      if (item.kind === "message") {
        messageCount += 1;
        if (!hasFirstUserMessage && item.role === "user") {
          hasFirstUserMessage = true;
          firstTitle = sessionTitleFromMarkdown(item.markdown);
        }
      } else if (item.kind === "tool" && item.stage === "call") {
        toolCount += 1;
      }
    }

    return {
      ...state,
      timeline: items.length === 0 ? state.timeline : [...state.timeline, ...items],
      directiveDetails: sameMapEntries(state.directiveDetails, directiveDetails)
        ? state.directiveDetails
        : directiveDetails,
      internalDetails: sameMapEntries(state.internalDetails, internalDetails)
        ? state.internalDetails
        : internalDetails,
      toolDetails: sameMapEntries(state.toolDetails, toolDetails)
        ? state.toolDetails
        : toolDetails,
      pendingToolCalls,
      pendingUserInputRequests,
      decoderDiagnostics: decoderDiagnosticsUnchanged
        ? state.decoderDiagnostics
        : nextDecoderDiagnostics,
      normalizerDiagnostics,
      hasFirstUserMessage,
      firstUserTitle: firstTitle,
      messageCount,
      toolCount,
      bindingAttempt,
    };
  }

  materialize(
    state: SessionNormalizerState,
    metadata: SessionMetadata,
    origin: DomainSessionOrigin = DEFAULT_SESSION_ORIGIN,
  ): NormalizedSession {
    const diagnostics = combinedDiagnostics(state);
    const warningCount = diagnostics.filter(
      (diagnostic) => diagnostic.severity !== "info",
    ).length;
    const title = normalizeSessionTitle(metadata.title) ??
      state.firstUserTitle ??
      "Untitled session";
    const session: DomainSession = {
      id: state.descriptor.id,
      sourceId: metadata.threadId,
      origin,
      title,
      cwd: metadata.cwd,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      archived: metadata.archived,
      parentId: metadata.parentThreadId,
      childIds: [],
      agent: metadata.agent ?? null,
      messageCount: state.messageCount,
      toolCount: state.toolCount,
      warningCount,
      diagnostics,
      itemCount: state.timeline.length,
    };
    return {
      session,
      timeline: state.timeline,
      toolDetails: state.toolDetails,
      directiveDetails: state.directiveDetails,
      internalDetails: state.internalDetails,
      interaction: interaction(state),
    };
  }

  normalize(
    decoded: DecodedRollout,
    metadata: SessionMetadata,
    origin: DomainSessionOrigin = DEFAULT_SESSION_ORIGIN,
  ): NormalizedSession {
    const state = this.append(
      this.create(decoded.descriptor),
      decoded.records,
      decoded.diagnostics,
    );
    return this.materialize(state, metadata, origin);
  }
}

function combinedDiagnostics(
  state: SessionNormalizerState,
): readonly DomainDiagnostic[] {
  const remaining = MAX_SESSION_DIAGNOSTICS - state.decoderDiagnostics.length;
  return [
    ...state.decoderDiagnostics,
    ...state.normalizerDiagnostics.slice(0, remaining),
  ];
}

function sameDiagnostics(
  left: readonly DomainDiagnostic[],
  right: readonly DomainDiagnostic[],
): boolean {
  return left.length === right.length && left.every((item, index) => {
    const candidate = right[index];
    return candidate !== undefined && item.code === candidate.code &&
      item.severity === candidate.severity && item.message === candidate.message &&
      item.ordinal === candidate.ordinal;
  });
}

function sameMapEntries<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of right) {
    if (left.get(key) !== value) return false;
  }
  return true;
}

function interaction(state: SessionNormalizerState): DomainAgentInteraction {
  return codexInteractionFromBindingAttempt(state.bindingAttempt);
}

const DEFAULT_SESSION_ORIGIN: DomainSessionOrigin = {
  sourceType: "test",
  sourceInstanceId: "test",
  agentName: "Test",
  agentVersion: null,
  formatVersion: null,
};

function consumeRecord(
  record: DecodedRecord,
  items: DomainTimelineRecord[],
  directiveDetails: Map<string, DomainDirectiveDetail>,
  internalDetails: Map<string, DomainInternalDetail>,
  toolDetails: Map<string, DomainToolDetail>,
  pendingToolCalls: Map<string, ToolCall>,
  pendingUserInputRequests: Map<string, UserInputRequest>,
  diagnostics: DomainDiagnostic[],
): void {
  const timestamp = string(record.value.timestamp);
  const payload = record.value.payload;
  if (record.value.type === "response_item" && isObject(payload)) {
    consumeParsedResponse(
      parseResponseItem(record.ordinal, timestamp, payload),
      items,
      directiveDetails,
      toolDetails,
      pendingToolCalls,
      pendingUserInputRequests,
      diagnostics,
    );
    const item = items.at(-1);
    if (item?.kind === "internal" && item.ordinal === record.ordinal) {
      addInternalDetail(item, record, internalDetails);
    }
    return;
  }
  if (record.value.type === "event_msg" && isObject(payload)) {
    const message = eventMessage(record.ordinal, timestamp, payload);
    if (message !== null) items.push(message);
    else {
      const item = internalItemFromPayload(record.ordinal, timestamp, payload);
      items.push(item);
      if (item.kind === "internal") {
        addInternalDetail(item, record, internalDetails);
      }
    }
    return;
  }
  if (record.value.type === "session_meta") return;
  if (record.value.type === "turn_context") {
    const item = internalItem(record.ordinal, timestamp, "turn_context");
    items.push(item);
    addInternalDetail(item, record, internalDetails);
    return;
  }
  const eventType = string(record.value.type);
  if (eventType !== null) {
    const item = internalItem(record.ordinal, timestamp, eventType);
    items.push(item);
    addInternalDetail(item, record, internalDetails);
    return;
  }
  appendDiagnostic(diagnostics, {
    code: "unknown_record",
    severity: "info",
    message: "A record without a recognized type was reduced to a safe diagnostic.",
    ordinal: record.ordinal,
  });
}

function addInternalDetail(
  item: Extract<DomainTimelineRecord, { kind: "internal" }>,
  record: DecodedRecord,
  details: Map<string, DomainInternalDetail>,
): void {
  const detail = internalDetail(record.value);
  details.set(item.id, detail);
}

function appendDiagnostic(
  diagnostics: DomainDiagnostic[],
  diagnostic: DomainDiagnostic,
): void {
  if (diagnostics.length < MAX_SESSION_DIAGNOSTICS) {
    diagnostics.push(diagnostic);
  }
}

function consumeParsedResponse(
  parsed: ParsedResponseItem,
  items: DomainTimelineRecord[],
  directiveDetails: Map<string, DomainDirectiveDetail>,
  toolDetails: Map<string, DomainToolDetail>,
  pendingToolCalls: Map<string, ToolCall>,
  pendingUserInputRequests: Map<string, UserInputRequest>,
  diagnostics: DomainDiagnostic[],
): void {
  switch (parsed.kind) {
    case "directive":
      items.push(parsed.value.item);
      if (parsed.value.detail !== null) {
        directiveDetails.set(parsed.value.item.id, parsed.value.detail);
      }
      break;
    case "timeline":
      items.push(parsed.value);
      break;
    case "tool_call":
      pendingToolCalls.set(parsed.value.callId, parsed.value);
      addTool(normalizeToolCall(parsed.value), items, toolDetails);
      break;
    case "tool_output": {
      if (pendingUserInputRequests.delete(parsed.value.callId)) {
        addUserInput(normalizeUserInputResponse(parsed.value), items, diagnostics);
      } else {
        const call = pendingToolCalls.get(parsed.value.callId);
        pendingToolCalls.delete(parsed.value.callId);
        addTool(normalizeToolOutput(parsed.value, call), items, toolDetails);
      }
      break;
    }
    case "user_input_request":
      pendingUserInputRequests.set(parsed.value.callId, parsed.value);
      addUserInput(normalizeUserInputRequest(parsed.value), items, diagnostics);
      break;
    case "ignored":
      break;
  }
}

function addUserInput(
  accumulated: NormalizedUserInput,
  items: DomainTimelineRecord[],
  diagnostics: DomainDiagnostic[],
): void {
  items.push(accumulated.item);
  if (accumulated.malformed) {
    appendDiagnostic(diagnostics, {
      code: "invalid_user_input",
      severity: "warning",
      message: "A request_user_input call or output had an unsupported payload shape.",
      ordinal: accumulated.item.ordinal,
    });
  }
}

function addTool(
  tool: NormalizedTool,
  items: DomainTimelineRecord[],
  details: Map<string, DomainToolDetail>,
): void {
  items.push(tool.item);
  details.set(tool.item.id, tool.detail);
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
