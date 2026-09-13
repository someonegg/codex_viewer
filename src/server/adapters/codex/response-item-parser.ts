import type { DomainTimelineRecord } from "../../domain/session-domain.js";
import { internalItem } from "./internal-event-parser.js";
import {
  responseDirective,
  type ParsedDirective,
} from "./message-normalizer.js";
import { isObject } from "./rollout-decoder.js";
import type { ToolCall, ToolOutput } from "./tool-normalizer.js";
import {
  parseUserInputQuestions,
  type UserInputRequest,
} from "./user-input-normalizer.js";

export type ParsedResponseItem =
  | { readonly kind: "directive"; readonly value: ParsedDirective }
  | { readonly kind: "timeline"; readonly value: DomainTimelineRecord }
  | { readonly kind: "tool_call"; readonly value: ToolCall }
  | { readonly kind: "tool_output"; readonly value: ToolOutput }
  | { readonly kind: "user_input_request"; readonly value: UserInputRequest }
  | { readonly kind: "ignored" };

export function parseResponseItem(
  ordinal: number,
  timestamp: string | null,
  payload: Record<string, unknown>,
): ParsedResponseItem {
  const type = string(payload.type);
  if (type === "message") {
    const directive = responseDirective(ordinal, timestamp, payload);
    return directive === null
      ? { kind: "ignored" }
      : { kind: "directive", value: directive };
  }
  if (type === "reasoning") {
    return {
      kind: "timeline",
      value: internalItem(ordinal, timestamp, "reasoning"),
    };
  }
  const userInput = userInputRequest(ordinal, timestamp, payload);
  if (userInput !== null) return { kind: "user_input_request", value: userInput };
  const call = toolCall(ordinal, timestamp, payload);
  if (call !== null) return { kind: "tool_call", value: call };
  const output = toolOutput(ordinal, timestamp, payload);
  if (output !== null) return { kind: "tool_output", value: output };
  return {
    kind: "timeline",
    value: internalItem(ordinal, timestamp, type ?? "response_item"),
  };
}

function userInputRequest(
  ordinal: number,
  timestamp: string | null,
  payload: Record<string, unknown>,
): UserInputRequest | null {
  if (payload.type !== "function_call" || payload.name !== "request_user_input") return null;
  const callId = string(payload.call_id);
  if (callId === null) return null;
  const questions = parseUserInputQuestions(payload.arguments);
  return {
    callId,
    ordinal,
    timestamp,
    questions: questions ?? [],
    malformed: questions === null,
  };
}

function toolCall(
  ordinal: number,
  timestamp: string | null,
  payload: Record<string, unknown>,
): ToolCall | null {
  const type = string(payload.type);
  if (type !== "function_call" && type !== "custom_tool_call") return null;
  const callId = string(payload.call_id);
  if (callId === null) return null;
  return {
    callId,
    ordinal,
    timestamp,
    toolName: string(payload.name) ?? (type === "custom_tool_call" ? "custom tool" : "function"),
    input: serializeText(payload.arguments ?? payload.input),
  };
}

function toolOutput(
  ordinal: number,
  timestamp: string | null,
  payload: Record<string, unknown>,
): ToolOutput | null {
  const type = string(payload.type);
  if (type !== "function_call_output" && type !== "custom_tool_call_output") return null;
  const callId = string(payload.call_id);
  if (callId === null) return null;
  return {
    callId,
    ordinal,
    timestamp,
    output: toolOutputText(payload.output),
    failed: payload.success === false || payload.status === "failed",
  };
}

function serializeText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function toolOutputText(value: unknown): string | null {
  if (!Array.isArray(value)) return serializeText(value);
  const parts = value
    .filter(isObject)
    .map((part) => string(part.text) ?? string(part.output_text) ?? serializeText(part))
    .filter((part): part is string => part !== null);
  return parts.length === 0 ? serializeText(value) : parts.join("");
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
