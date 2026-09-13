import { describe, expect, it } from "vitest";
import {
  MAX_INLINE_DIRECTIVE_CHARS,
} from "../../src/server/adapters/codex/limits.js";
import { normalizeRecords } from "./session-normalizer.fixtures.js";

describe("message and directive normalization", () => {
  it("keeps explicit metadata titles ahead of Markdown user headings", () => {
    const normalized = normalizeRecords("metadata-title", [{
      ordinal: 1,
      value: {
        type: "event_msg",
        payload: { type: "user_message", message: "# Markdown title" },
      },
    }], { title: "Metadata title" });

    expect(normalized.session.title).toBe("Metadata title");
  });

  it("keeps response messages as directives and emits event messages without matching", () => {
    const normalized = normalizeRecords("message-source-session", [
      {
        ordinal: 1,
        value: {
          type: "response_item",
          payload: {
            type: "message", role: "user",
            content: [{ type: "input_text", text: "Actual user" }],
          },
        },
      },
      {
        ordinal: 2,
        value: {
          type: "event_msg",
          payload: { type: "user_message", message: "Actual user" },
        },
      },
      {
        ordinal: 3,
        value: {
          type: "response_item",
          payload: {
            type: "message", role: "assistant", phase: "commentary",
            content: [{ type: "output_text", text: "Canonical assistant" }],
          },
        },
      },
      {
        ordinal: 4,
        value: {
          type: "event_msg",
          payload: {
            type: "agent_message",
            phase: "commentary",
            message: "Canonical assistant",
          },
        },
      },
    ]);

    expect(normalized.timeline.map((item) => [item.ordinal, item.kind])).toEqual([
      [1, "directive"],
      [2, "message"],
      [3, "directive"],
      [4, "message"],
    ]);
    expect(normalized.timeline[0]).toEqual(expect.objectContaining({
      hasDetail: false,
      text: "Actual user",
      charCount: 11,
    }));
    expect(normalized.directiveDetails.has("directive-1")).toBe(false);
    expect(normalized.session).toEqual(expect.objectContaining({
      title: "Actual user",
      messageCount: 2,
    }));
    expect(normalized.timeline.filter((item) => item.kind === "message"))
      .toEqual([
        expect.objectContaining({ role: "user", markdown: "Actual user" }),
        expect.objectContaining({
          role: "assistant",
          phase: "commentary",
          markdown: "Canonical assistant",
        }),
      ]);
  });

  it("accepts only allowlisted message content parts and does not guess string content", () => {
    const normalized = normalizeRecords("strict-message-content-session", [
        {
          ordinal: 1,
          value: {
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: "STRING_CONTENT_MUST_NOT_RENDER",
            },
          },
        },
        {
          ordinal: 2,
          value: {
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [
                { type: "image_url", text: "NON_TEXT_PART_MUST_NOT_RENDER" },
                { type: "output_text", text: "Allowed assistant text" },
              ],
            },
          },
        },
    ]);
  
    expect(normalized.timeline).toEqual([
      expect.objectContaining({
        kind: "directive",
        ordinal: 2,
        hasDetail: false,
        text: "Allowed assistant text",
      }),
    ]);
    expect(normalized.directiveDetails.has("directive-2")).toBe(false);
    expect(JSON.stringify(normalized)).not.toContain("STRING_CONTENT_MUST_NOT_RENDER");
    expect(JSON.stringify(normalized)).not.toContain("NON_TEXT_PART_MUST_NOT_RENDER");
  });

  it("inlines 500 characters and retains 501 characters as lazy detail", () => {
    const inlineText = "i".repeat(MAX_INLINE_DIRECTIVE_CHARS);
    const lazyText = "l".repeat(MAX_INLINE_DIRECTIVE_CHARS + 1);
    const normalized = normalizeRecords("directive-boundaries", [
      responseMessage(1, inlineText),
      responseMessage(2, lazyText),
    ]);

    expect(normalized.timeline[0]).toEqual(expect.objectContaining({
      kind: "directive",
      hasDetail: false,
      text: inlineText,
      charCount: MAX_INLINE_DIRECTIVE_CHARS,
    }));
    expect(normalized.directiveDetails.has("directive-1")).toBe(false);
    expect(normalized.timeline[1]).toEqual(expect.objectContaining({
      kind: "directive",
      hasDetail: true,
      summary: "l".repeat(240),
      charCount: MAX_INLINE_DIRECTIVE_CHARS + 1,
      truncated: false,
    }));
    expect(normalized.timeline[1]).not.toHaveProperty("text");
    expect(normalized.directiveDetails.get("directive-2")).toEqual({
      text: lazyText,
      truncated: false,
    });
  });

  it("emits a completed UserMessage and uses it for the title", () => {
    const normalized = normalizeRecords("completed-user-message", [
      completedItem(1, {
        type: "UserMessage",
        content: [
          { type: "text", text: "First user line" },
          { type: "image", text: "NON_TEXT_MUST_NOT_RENDER" },
          { type: "text", text: "Second user paragraph" },
          { type: "Text", text: "WRONG_CASE_MUST_NOT_RENDER" },
        ],
      }),
    ]);

    expect(normalized.timeline).toEqual([expect.objectContaining({
      kind: "message",
      role: "user",
      phase: null,
      itemType: null,
      markdown: "First user line\n\nSecond user paragraph",
    })]);
    expect(normalized.session).toEqual(expect.objectContaining({
      title: "First user line",
      messageCount: 1,
    }));
    expect(JSON.stringify(normalized)).not.toContain("NON_TEXT_MUST_NOT_RENDER");
    expect(JSON.stringify(normalized)).not.toContain("WRONG_CASE_MUST_NOT_RENDER");
  });

  it.each([
    ["commentary", "commentary"],
    ["final", "final"],
    ["final_answer", "final"],
    [undefined, null],
  ] as const)("normalizes completed AgentMessage phase %s", (phase, expectedPhase) => {
    const normalized = normalizeRecords(`completed-agent-${phase ?? "missing"}`, [
      completedItem(1, {
        type: "AgentMessage",
        ...(phase === undefined ? {} : { phase }),
        content: [
          { type: "Text", text: "First assistant paragraph" },
          { type: "text", text: "WRONG_CASE_MUST_NOT_RENDER" },
          { type: "Text", text: "Second assistant paragraph" },
        ],
      }),
    ]);

    expect(normalized.timeline).toEqual([expect.objectContaining({
      kind: "message",
      role: "assistant",
      phase: expectedPhase,
      itemType: null,
      markdown: "First assistant paragraph\n\nSecond assistant paragraph",
    })]);
    expect(JSON.stringify(normalized)).not.toContain("WRONG_CASE_MUST_NOT_RENDER");
  });

  it("keeps completed Plan text as a typed assistant final message", () => {
    const normalized = normalizeRecords("completed-item-session", [{
      ordinal: 1,
      value: {
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: "Plan", text: "# Plan\n\n- First step" },
        },
      },
    }]);

    expect(normalized.timeline).toEqual([expect.objectContaining({
      kind: "message",
      role: "assistant",
      phase: "final",
      itemType: "Plan",
      markdown: "# Plan\n\n- First step",
    })]);
  });

  it("reduces empty, non-text, and unknown completed items to safe internals", () => {
    const normalized = normalizeRecords("invalid-completed-items", [
      completedItem(1, { type: "UserMessage", content: [] }),
      completedItem(2, {
        type: "AgentMessage",
        content: [{ type: "Image", text: "AGENT_PAYLOAD_MUST_NOT_RENDER" }],
      }),
      completedItem(3, {
        type: "Reasoning",
        text: "REASONING_PAYLOAD_MUST_NOT_RENDER",
      }),
      completedItem(4, {
        type: "UnknownCompletion",
        text: "UNKNOWN_PAYLOAD_MUST_NOT_RENDER",
      }),
      completedItem(5, { type: "Plan", text: "" }),
      completedItem(6, {
        type: "ReviewMode",
        text: "REVIEW_PAYLOAD_MUST_NOT_RENDER",
      }),
      completedItem(7, {
        type: "Extension",
        text: "EXTENSION_PAYLOAD_MUST_NOT_RENDER",
      }),
    ]);

    const subtypes = [
      "UserMessage",
      "AgentMessage",
      "Reasoning",
      "UnknownCompletion",
      "Plan",
      "ReviewMode",
      "Extension",
    ];
    expect(normalized.timeline).toEqual(subtypes.map((subtype, index) => ({
      kind: "internal",
      id: `internal-${index + 1}`,
      ordinal: index + 1,
      timestamp: null,
      eventType: `item_completed.${subtype}`,
      summary: `Internal event: item_completed.${subtype}`,
      truncated: false,
    })));
    expect(normalized.session.messageCount).toBe(0);
    const serialized = JSON.stringify(normalized.timeline);
    expect(serialized).not.toContain("AGENT_PAYLOAD_MUST_NOT_RENDER");
    expect(serialized).not.toContain("REASONING_PAYLOAD_MUST_NOT_RENDER");
    expect(serialized).not.toContain("UNKNOWN_PAYLOAD_MUST_NOT_RENDER");
    expect(serialized).not.toContain("REVIEW_PAYLOAD_MUST_NOT_RENDER");
    expect(serialized).not.toContain("EXTENSION_PAYLOAD_MUST_NOT_RENDER");
  });

  it("does not turn arbitrary completed items with text fields into messages", () => {
    const normalized = normalizeRecords("strict-completed-plan", [
      completedItem(1, { type: "FileChange", text: "SECRET_PATCH" }),
      completedItem(2, { type: "CommandExecution", text: "SECRET_OUTPUT" }),
    ]);

    expect(normalized.timeline.every((item) => item.kind === "internal")).toBe(true);
    expect(JSON.stringify(normalized)).not.toContain("SECRET_PATCH");
    expect(JSON.stringify(normalized)).not.toContain("SECRET_OUTPUT");
  });
});

function responseMessage(ordinal: number, text: string) {
  return {
    ordinal,
    value: {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    },
  };
}

function completedItem(ordinal: number, item: Record<string, unknown>) {
  return {
    ordinal,
    value: {
      type: "event_msg",
      payload: { type: "item_completed", item },
    },
  };
}
