import type {
  DomainToolDetail as NormalizedToolDetail,
  DomainToolRecord as ToolItem,
} from "../../domain/session-domain.js";
import {
  MAX_PREVIEW_CHARS,
  truncateText,
} from "../../domain/session-text.js";
import { MAX_TOOL_DETAIL_CHARS } from "./limits.js";

export interface ToolCall {
  callId: string;
  ordinal: number;
  timestamp: string | null;
  toolName: string;
  input: string | null;
}

export interface ToolOutput {
  callId: string;
  ordinal: number;
  timestamp: string | null;
  output: string | null;
  failed: boolean;
}

export interface NormalizedTool {
  item: ToolItem;
  detail: NormalizedToolDetail;
}

export function normalizeToolCall(call: ToolCall): NormalizedTool {
  const input = truncateNullable(call.input);
  const preview = previewText(call.input);
  const detailTruncated = input.truncated;
  return {
    item: {
      kind: "tool",
      stage: "call",
      id: `tool-${call.ordinal}`,
      ordinal: call.ordinal,
      timestamp: call.timestamp,
      callId: call.callId,
      toolName: call.toolName,
      preview: preview.text,
      charCount: call.input?.length ?? 0,
      hasDetail: call.input !== null,
    },
    detail: { input: input.text, output: null, truncated: detailTruncated },
  };
}

export function normalizeToolOutput(
  output: ToolOutput,
  call: ToolCall | undefined,
): NormalizedTool {
  const input = truncateNullable(call?.input ?? null);
  const result = truncateNullable(output.output);
  const preview = previewText(
    output.output !== null && output.output.length > 0
      ? output.output
      : call?.input ?? null,
  );
  const detailTruncated = input.truncated || result.truncated;
  return {
    item: {
      kind: "tool",
      stage: "output",
      id: `tool-${output.ordinal}`,
      ordinal: output.ordinal,
      timestamp: output.timestamp,
      callId: output.callId,
      toolName: call?.toolName ?? "unknown tool",
      status: output.failed ? "failed" : "completed",
      preview: preview.text,
      charCount: (call?.input?.length ?? 0) + (output.output?.length ?? 0),
      hasDetail: (call?.input !== null && call?.input !== undefined) ||
        output.output !== null,
    },
    detail: {
      input: input.text,
      output: result.text,
      truncated: detailTruncated,
    },
  };
}

function previewText(value: string | null): { text: string | null; truncated: boolean } {
  return value === null
    ? { text: null, truncated: false }
    : truncateText(value, MAX_PREVIEW_CHARS);
}

function truncateNullable(value: string | null): { text: string | null; truncated: boolean } {
  if (value === null) return { text: null, truncated: false };
  const result = truncateText(value, MAX_TOOL_DETAIL_CHARS);
  return { text: result.text, truncated: result.truncated };
}
