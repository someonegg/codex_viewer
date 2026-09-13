import type {
  DomainInternalDetail,
  DomainInternalEventRecord,
  DomainTokenRecord,
  DomainTokenUsageCounters,
} from "../../domain/session-domain.js";
import { MAX_PREVIEW_CHARS, truncateText } from "../../domain/session-text.js";
import { MAX_INTERNAL_DETAIL_BYTES } from "./limits.js";
import { isObject } from "./rollout-decoder.js";

export function internalItem(
  ordinal: number,
  timestamp: string | null,
  eventType: string,
): DomainInternalEventRecord {
  const safeType = truncateText(eventType.replaceAll(/[^A-Za-z0-9_.:-]/g, "_"), 80).text;
  return {
    kind: "internal",
    id: `internal-${ordinal}`,
    ordinal,
    timestamp,
    eventType: safeType,
    summary: truncateText(`Internal event: ${safeType}`, MAX_PREVIEW_CHARS).text,
    truncated: false,
  };
}

export function internalDetail(value: Record<string, unknown>): DomainInternalDetail {
  const json = JSON.stringify(value, null, 2);
  const bytes = Buffer.from(json, "utf8");
  if (bytes.byteLength <= MAX_INTERNAL_DETAIL_BYTES) return { json, truncated: false };
  let end = MAX_INTERNAL_DETAIL_BYTES;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      return { json: decoder.decode(bytes.subarray(0, end)), truncated: true };
    } catch {
      end -= 1;
    }
  }
  return { json: "", truncated: true };
}

export function internalItemFromPayload(
  ordinal: number,
  timestamp: string | null,
  payload: Record<string, unknown>,
): DomainInternalEventRecord | DomainTokenRecord {
  const eventType = string(payload.type) ?? "event";
  if (eventType !== "token_count") {
    const subtype = eventType === "item_completed" && isObject(payload.item)
      ? string(payload.item.type)
      : null;
    return internalItem(
      ordinal,
      timestamp,
      subtype === null ? eventType : `${eventType}.${subtype}`,
    );
  }
  const info = isObject(payload.info) ? payload.info : null;
  return {
    kind: "token",
    id: `token-${ordinal}`,
    ordinal,
    timestamp,
    tokenUsage: {
      total: tokenUsageCounters(info?.total_token_usage),
      last: tokenUsageCounters(info?.last_token_usage),
    },
  };
}

function tokenUsageCounters(value: unknown): DomainTokenUsageCounters | null {
  if (!isObject(value)) return null;
  const counters: DomainTokenUsageCounters = {
    totalTokens: tokenCount(value.total_tokens),
    inputTokens: tokenCount(value.input_tokens),
    cachedInputTokens: tokenCount(value.cached_input_tokens),
    cacheWriteInputTokens: tokenCount(value.cache_write_input_tokens),
    outputTokens: tokenCount(value.output_tokens),
    reasoningOutputTokens: tokenCount(value.reasoning_output_tokens),
  };
  return Object.values(counters).some((count) => count !== null) ? counters : null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
