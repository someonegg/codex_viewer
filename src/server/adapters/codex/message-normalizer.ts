import type {
  DomainDirectiveDetail,
  DomainDirectiveRecord,
  DomainMessageRecord,
} from "../../domain/session-domain.js";
import {
  MAX_PREVIEW_CHARS,
  truncateText,
} from "../../domain/session-text.js";
import {
  MAX_DIRECTIVE_CHARS,
  MAX_INLINE_DIRECTIVE_CHARS,
  MAX_MESSAGE_CHARS,
} from "./limits.js";
import { isObject } from "./rollout-decoder.js";

export interface ParsedDirective {
  readonly item: DomainDirectiveRecord;
  readonly detail: DomainDirectiveDetail | null;
}

export function responseDirective(
  ordinal: number,
  timestamp: string | null,
  payload: Record<string, unknown>,
): ParsedDirective | null {
  const role = payload.role;
  if (role !== "user" && role !== "assistant" && role !== "developer") return null;
  const text = contentText(payload.content);
  if (text === null) return null;
  const id = `directive-${ordinal}`;
  if (text.length <= MAX_INLINE_DIRECTIVE_CHARS) {
    return {
      item: {
        kind: "directive",
        id,
        ordinal,
        timestamp,
        text,
        hasDetail: false,
      },
      detail: null,
    };
  }
  const detail = truncateText(text, MAX_DIRECTIVE_CHARS);
  return {
    item: {
      kind: "directive",
      id,
      ordinal,
      timestamp,
      summary: directiveSummary(text),
      charCount: text.length,
      hasDetail: true,
    },
    detail,
  };
}

export function eventMessage(
  ordinal: number,
  timestamp: string | null,
  payload: Record<string, unknown>,
): DomainMessageRecord | null {
  const type = string(payload.type);
  if (type === "user_message" || type === "agent_message") {
    const markdown = string(payload.message);
    if (markdown === null) return null;
    const role = type === "user_message" ? "user" : "assistant";
    const phase = type === "agent_message" ? normalizePhase(payload.phase) : null;
    return messageItem(ordinal, timestamp, role, phase, null, markdown);
  }
  if (type !== "item_completed" || !isObject(payload.item)) return null;
  const item = payload.item;
  const itemType = string(item.type);
  if (itemType === "UserMessage") {
    const markdown = itemContentText(item.content, "text");
    return markdown === null
      ? null
      : messageItem(ordinal, timestamp, "user", null, null, markdown);
  }
  if (itemType === "AgentMessage") {
    const markdown = itemContentText(item.content, "Text");
    return markdown === null
      ? null
      : messageItem(
        ordinal,
        timestamp,
        "assistant",
        normalizePhase(item.phase),
        null,
        markdown,
      );
  }
  if (itemType !== "Plan") return null;
  const markdown = string(item.text);
  return markdown === null
    ? null
    : messageItem(ordinal, timestamp, "assistant", "final", itemType, markdown);
}

function messageItem(
  ordinal: number,
  timestamp: string | null,
  role: "user" | "assistant",
  phase: "commentary" | "final" | null,
  itemType: string | null,
  markdown: string,
): DomainMessageRecord {
  return {
    kind: "message",
    id: `message-${ordinal}`,
    ordinal,
    timestamp,
    role,
    phase,
    itemType: itemType === null
      ? null
      : truncateText(itemType, MAX_MESSAGE_CHARS).text,
    markdown: truncateText(markdown, MAX_MESSAGE_CHARS).text,
  };
}

function directiveSummary(value: string): string {
  const firstLine = value.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return truncateText(firstLine ?? "Directive", MAX_PREVIEW_CHARS).text;
}

function contentText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const text = value
    .filter(isObject)
    .filter((part) => ["input_text", "output_text", "text"].includes(string(part.type) ?? ""))
    .map((part) => string(part.text))
    .filter((part): part is string => part !== null)
    .join("\n\n");
  return text.length === 0 ? null : text;
}

function itemContentText(value: unknown, acceptedType: "text" | "Text"): string | null {
  if (!Array.isArray(value)) return null;
  const text = value
    .filter(isObject)
    .filter((part) => part.type === acceptedType)
    .map((part) => string(part.text))
    .filter((part): part is string => part !== null)
    .join("\n\n");
  return text.length === 0 ? null : text;
}

function normalizePhase(value: unknown): "commentary" | "final" | null {
  if (value === "commentary") return "commentary";
  if (value === "final" || value === "final_answer") return "final";
  return null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
