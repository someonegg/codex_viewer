import { describe, expect, it } from "vitest";
import { normalizeRecords } from "./session-normalizer.fixtures.js";

describe("internal event normalization", () => {
  it("labels completed item subtypes safely and keeps formatted details out of timeline items", () => {
    const normalized = normalizeRecords("internal-subtypes", [
      { ordinal: 1, value: { type: "event_msg", payload: {
        type: "item_completed", item: { type: "Extension", value: "secret" },
      } } },
      { ordinal: 2, value: { type: "event_msg", payload: {
        type: "item_completed", item: { type: "Bad type/?", value: 2 },
      } } },
      { ordinal: 3, value: { type: "event_msg", payload: {
        type: "item_completed", item: { value: 3 },
      } } },
    ]);

    expect(normalized.timeline.map((item) => item.kind === "internal" && item.eventType))
      .toEqual([
        "item_completed.Extension",
        "item_completed.Bad_type__",
        "item_completed",
      ]);
    expect(JSON.stringify(normalized.timeline)).not.toContain("secret");
    expect(normalized.internalDetails.get("internal-1")).toEqual({
      json: JSON.stringify({
        type: "event_msg",
        payload: { type: "item_completed", item: { type: "Extension", value: "secret" } },
      }, null, 2),
      truncated: false,
    });
  });

  it("truncates formatted JSON by JavaScript code units", () => {
    const normalized = normalizeRecords("internal-truncation", [{
      ordinal: 1,
      value: { type: "world_state", payload: { text: "😀".repeat(200_000) } },
    }]);
    const detail = normalized.internalDetails.get("internal-1")!;

    expect(detail.json).toHaveLength(255_999);
    expect(detail.json.charCodeAt(detail.json.length - 1)).not.toBe(0xd83d);
    expect(detail.truncated).toBe(true);
    expect(normalized.timeline[0]).not.toHaveProperty("truncated");
  });

  it("shows turn context safely and retains allowlisted total and last token usage", () => {
    const normalized = normalizeRecords("internal-detail-session", [
        {
          ordinal: 1,
          value: {
            timestamp: "2026-07-28T20:00:00Z",
            type: "turn_context",
            payload: {
              cwd: "/TURN_CONTEXT_MUST_NOT_RENDER",
              model: "MODEL_MUST_NOT_RENDER",
            },
          },
        },
        {
          ordinal: 2,
          value: {
            timestamp: "2026-07-28T20:00:01Z",
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: {
                  total_tokens: 12_345,
                  input_tokens: 10_000,
                  cached_input_tokens: 4_000,
                  cache_write_input_tokens: 500,
                  output_tokens: 2_000,
                  reasoning_output_tokens: 345,
                  UNKNOWN_TOKEN_FIELD_MUST_NOT_RENDER: 99,
                },
                last_token_usage: {
                  total_tokens: 678,
                  input_tokens: 500,
                  cached_input_tokens: 100,
                  cache_write_input_tokens: -1,
                  output_tokens: 150,
                  reasoning_output_tokens: "28",
                },
              },
              rate_limits: { secret: "RATE_LIMIT_MUST_NOT_RENDER" },
            },
          },
        },
        {
          ordinal: 3,
          value: {
            type: "event_msg",
            payload: { type: "token_count", rate_limits: { used_percent: 25 } },
          },
        },
    ]);
  
    expect(normalized.timeline).toEqual([
      {
        kind: "internal",
        id: "internal-1",
        ordinal: 1,
        timestamp: "2026-07-28T20:00:00Z",
        eventType: "turn_context",
      },
      {
        kind: "token",
        id: "token-2",
        ordinal: 2,
        timestamp: "2026-07-28T20:00:01Z",
        tokenUsage: {
          total: {
            totalTokens: 12_345,
            inputTokens: 10_000,
            cachedInputTokens: 4_000,
            cacheWriteInputTokens: 500,
            outputTokens: 2_000,
            reasoningOutputTokens: 345,
          },
          last: {
            totalTokens: 678,
            inputTokens: 500,
            cachedInputTokens: 100,
            cacheWriteInputTokens: null,
            outputTokens: 150,
            reasoningOutputTokens: null,
          },
        },
      },
      {
        kind: "token",
        id: "token-3",
        ordinal: 3,
        timestamp: null,
        tokenUsage: {
          total: null,
          last: null,
        },
      },
    ]);
    const serialized = JSON.stringify(normalized.timeline);
    expect(serialized).not.toContain("TURN_CONTEXT_MUST_NOT_RENDER");
    expect(serialized).not.toContain("MODEL_MUST_NOT_RENDER");
    expect(serialized).not.toContain("UNKNOWN_TOKEN_FIELD_MUST_NOT_RENDER");
    expect(serialized).not.toContain("RATE_LIMIT_MUST_NOT_RENDER");
    expect(normalized.internalDetails.get("internal-1")?.json)
      .toContain("TURN_CONTEXT_MUST_NOT_RENDER");
  });
});
