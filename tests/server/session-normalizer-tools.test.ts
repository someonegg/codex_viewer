import { describe, expect, it } from "vitest";
import {
  MAX_DIRECTIVE_CHARS,
  MAX_TOOL_DETAIL_CHARS,
} from "../../src/server/adapters/codex/limits.js";
import { MAX_PREVIEW_CHARS } from "../../src/server/domain/session-text.js";
import {
  normalizeFixture,
  normalizeRecords,
} from "./session-normalizer.fixtures.js";

describe("tool normalization", () => {
  it("emits append-stable call and output items with public call IDs", async () => {
    const normalized = await normalizeFixture("rollout-2026-07-28T10-00-00-basic-session.jsonl");
    const tools = normalized.timeline.filter((item) => item.kind === "tool");
    expect(tools.map((item) => [
      item.stage,
      item.callId,
      item.toolName,
      item.stage === "output" ? item.status : null,
    ])).toEqual([
      ["call", "call-complete", "inspect_widget", null],
      ["output", "call-complete", "inspect_widget", "completed"],
      ["call", "call-pending", "pending_widget", null],
      ["call", "custom-string", "custom_string", null],
      ["output", "custom-string", "custom_string", "completed"],
      ["call", "custom-array", "custom_array", null],
      ["output", "custom-array", "custom_array", "completed"],
    ]);
    expect(normalized.toolDetails.get("tool-7")).toMatchObject({
      input: '{"id":"sample"}',
      output: null,
    });
    expect(normalized.toolDetails.get("tool-8")?.output).toBe("synthetic result");
    expect(normalized.toolDetails.get("tool-13")?.output).toBe("string-shaped output");
    expect(normalized.toolDetails.get("tool-15")?.output).toBe("array shaped output");
    expect(normalized.session.toolCount).toBe(4);
  });

  it("truncates oversized synthetic tool input and output before retaining detail", async () => {
    const oversized = "x".repeat(MAX_TOOL_DETAIL_CHARS + 32);
    const normalized = normalizeRecords("oversized-tool-session", [
        {
          ordinal: 1,
          value: {
            type: "response_item",
            payload: { type: "function_call", name: "bounded", call_id: "big", arguments: oversized },
          },
        },
        {
          ordinal: 2,
          value: {
            type: "response_item",
            payload: { type: "function_call_output", call_id: "big", output: oversized },
          },
        },
        {
          ordinal: 3,
          value: {
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: oversized }],
            },
          },
        },
        {
          ordinal: 4,
          value: {
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: oversized }],
            },
          },
        },
    ]);
    const callDetail = normalized.toolDetails.get("tool-1");
    const outputDetail = normalized.toolDetails.get("tool-2");
    const call = normalized.timeline.find((item) => item.id === "tool-1");
    const output = normalized.timeline.find((item) => item.id === "tool-2");
    const directiveItem = normalized.timeline.find((item) => item.id === "directive-3");
    expect(call?.kind === "tool" ? call.preview : null).toHaveLength(MAX_PREVIEW_CHARS);
    expect(output?.kind === "tool" ? output.preview : null).toHaveLength(MAX_PREVIEW_CHARS);
    expect(callDetail?.input).toHaveLength(MAX_TOOL_DETAIL_CHARS);
    expect(callDetail?.output).toBeNull();
    expect(outputDetail?.input).toHaveLength(MAX_TOOL_DETAIL_CHARS);
    expect(outputDetail?.output).toHaveLength(MAX_TOOL_DETAIL_CHARS);
    expect(callDetail?.truncated).toBe(true);
    expect(outputDetail?.truncated).toBe(true);
    const directive = normalized.directiveDetails.get("directive-3");
    expect(directiveItem?.kind === "directive" && directiveItem.hasDetail
      ? directiveItem.summary
      : null)
      .toHaveLength(MAX_PREVIEW_CHARS);
    expect(directive?.text).toHaveLength(MAX_DIRECTIVE_CHARS);
    expect(directive?.truncated).toBe(true);
  });

  it("does not rewrite an existing call when its output arrives", () => {
    const call = toolCall(1, "append", "inspect", "input");
    const before = normalizeRecords("before-output", [call]);
    const after = normalizeRecords("after-output", [
      call,
      toolOutput(2, "append", "result"),
    ]);

    expect(after.timeline[0]).toEqual(before.timeline[0]);
    expect(after.toolDetails.get("tool-1"))
      .toEqual(before.toolDetails.get("tool-1"));
    expect(after.timeline[1]).toMatchObject({
      kind: "tool",
      stage: "output",
      callId: "append",
      status: "completed",
    });
  });

  it("consumes a pending call after its first output", () => {
    const normalized = normalizeRecords("duplicate-tool-output", [
      toolCall(1, "duplicate", "inspect", "input"),
      toolOutput(2, "duplicate", "first result"),
      toolOutput(3, "duplicate", "second result"),
    ]);

    expect(normalized.timeline[1]).toMatchObject({
      kind: "tool",
      stage: "output",
      toolName: "inspect",
    });
    expect(normalized.toolDetails.get("tool-2")).toMatchObject({
      input: "input",
      output: "first result",
    });
    expect(normalized.timeline[2]).toMatchObject({
      kind: "tool",
      stage: "output",
      toolName: "unknown tool",
    });
    expect(normalized.toolDetails.get("tool-3")).toMatchObject({
      input: null,
      output: "second result",
    });
  });

  it("does not report detail truncation when only the preview is truncated", () => {
    const input = "x".repeat(MAX_PREVIEW_CHARS + 1);
    const normalized = normalizeRecords("preview-only-truncation", [
      toolCall(1, "preview", "inspect", input),
    ]);
    const item = normalized.timeline[0];
    const detail = normalized.toolDetails.get("tool-1");

    expect(item).toMatchObject({
      kind: "tool",
      stage: "call",
      preview: "x".repeat(MAX_PREVIEW_CHARS),
      charCount: MAX_PREVIEW_CHARS + 1,
    });
    expect(detail).toEqual({
      input,
      output: null,
      truncated: false,
    });
  });

  it("uses code-unit preview boundaries without an ellipsis or split surrogate", () => {
    const exact = "x".repeat(MAX_PREVIEW_CHARS);
    const split = `${"x".repeat(MAX_PREVIEW_CHARS - 1)}😀`;
    const normalized = normalizeRecords("preview-code-units", [
      toolCall(1, "exact", "inspect", exact),
      toolCall(2, "split", "inspect", split),
    ]);
    const tools = normalized.timeline.filter((item) => item.kind === "tool");

    expect(tools[0]?.preview).toBe(exact);
    expect(tools[1]?.preview).toBe("x".repeat(MAX_PREVIEW_CHARS - 1));
    expect(tools[1]?.preview).not.toContain("…");
  });

  it("reports original call and matched or unmatched output code-unit totals", () => {
    const normalized = normalizeRecords("tool-char-counts", [
      toolCall(1, "matched", "inspect", "abc"),
      toolOutput(2, "matched", "de"),
      toolOutput(3, "unmatched", "xyz"),
      toolCall(4, "empty", "inspect", ""),
    ]);
    const tools = normalized.timeline.filter((item) => item.kind === "tool");

    expect(tools.map((item) => item.charCount)).toEqual([3, 5, 3, 0]);
  });
});

function toolCall(ordinal: number, callId: string, name: string, input: string) {
  return {
    ordinal,
    value: {
      type: "response_item",
      payload: { type: "function_call", call_id: callId, name, arguments: input },
    },
  };
}

function toolOutput(
  ordinal: number,
  callId: string,
  output: string | null,
  failed = false,
) {
  return {
    ordinal,
    value: {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: callId,
        output,
        status: failed ? "failed" : undefined,
      },
    },
  };
}
