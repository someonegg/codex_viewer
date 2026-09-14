import { describe, expect, it } from "vitest";
import {
  filterVisibleTimelineItems,
  type TimelineVisibility,
} from "../../src/client/state/timeline-visibility";
import type { TimelineItem } from "../../src/shared/domain";

const SHOW_ALL: TimelineVisibility = {
  directive: true,
  tools: true,
  token: true,
  internal: true,
};

describe("timeline visibility", () => {
  it("hides an inline directive matching a message up to two raw items before or after it", () => {
    const backward = [message(1, "same"), internal(2), directive(3, "same")];
    const forward = [directive(1, "same"), internal(2), message(3, "same")];

    expect(ids(filterVisibleTimelineItems(backward, SHOW_ALL))).toEqual([
      "message-1",
      "internal-2",
    ]);
    expect(ids(filterVisibleTimelineItems(forward, SHOW_ALL))).toEqual([
      "internal-2",
      "message-3",
    ]);
  });

  it("uses raw timeline positions rather than collapsing hidden technical events", () => {
    const items = [
      directive(1, "same"),
      internal(2),
      internal(3),
      message(4, "same"),
    ];
    const messagesAndDirectivesOnly = { ...SHOW_ALL, internal: false };

    expect(ids(filterVisibleTimelineItems(items, messagesAndDirectivesOnly))).toEqual([
      "directive-1",
      "message-4",
    ]);
  });

  it("keeps non-exact matches and lazy directives", () => {
    const items: TimelineItem[] = [
      directive(1, "same "),
      message(2, "same"),
      {
        kind: "directive",
        id: "directive-3",
        ordinal: 3,
        timestamp: null,
        hasDetail: true,
        summary: "same",
        charCount: 1_001,
      },
      message(4, "same"),
    ];

    expect(ids(filterVisibleTimelineItems(items, SHOW_ALL))).toEqual([
      "directive-1",
      "message-2",
      "directive-3",
      "message-4",
    ]);
  });

  it("always shows user input records without a technical-event toggle", () => {
    const hiddenTechnicalEvents: TimelineVisibility = {
      directive: false,
      tools: false,
      token: false,
      internal: false,
    };
    const item: TimelineItem = {
      kind: "user_input",
      stage: "request",
      id: "user-input-1",
      ordinal: 1,
      timestamp: null,
      callId: "call-1",
      questions: [],
    };

    expect(filterVisibleTimelineItems([item], hiddenTechnicalEvents)).toEqual([item]);
  });
});

function directive(ordinal: number, text: string): TimelineItem {
  return {
    kind: "directive",
    id: `directive-${ordinal}`,
    ordinal,
    timestamp: null,
    hasDetail: false,
    text,
  };
}

function message(ordinal: number, markdown: string): TimelineItem {
  return {
    kind: "message",
    id: `message-${ordinal}`,
    ordinal,
    timestamp: null,
    role: "user",
    phase: null,
    itemType: null,
    markdown,
  };
}

function internal(ordinal: number): TimelineItem {
  return {
    kind: "internal",
    id: `internal-${ordinal}`,
    ordinal,
    timestamp: null,
    eventType: "test",
  };
}

function ids(items: TimelineItem[]): string[] {
  return items.map((item) => item.id);
}
