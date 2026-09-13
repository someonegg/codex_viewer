import { describe, expect, it } from "vitest";
import type { NormalizedSession } from "../../src/server/domain/session-domain.js";
import {
  deriveTimelinePrefixIndex,
  extendsTimelinePrefix,
  extendTimelinePrefixIndex,
} from "../../src/server/repository/timeline-prefix-index.js";
import {
  TimelinePrefixRegistry,
  type TimelinePrefixIndexBuilder,
} from "../../src/server/repository/timeline-prefix-registry.js";

describe("timeline prefix index", () => {
  it("retains old prefix tokens after append and rejects a rewritten prefix", () => {
    const original = normalized(["one", "two"]);
    const appended = normalized(["one", "two", "three"]);
    const rewritten = normalized(["changed", "two", "three"]);
    const key = Buffer.alloc(32, 7);
    const before = deriveTimelinePrefixIndex(original, key);
    const after = deriveTimelinePrefixIndex(appended, key);
    const changed = deriveTimelinePrefixIndex(rewritten, key);
    const boundary = before.boundaryAt(original.timeline, 2)!;

    expect(before.byteLength).toBe(72);
    expect(after.matches(appended.timeline, boundary, boundary.timelinePrefixRevision)).toBe(true);
    expect(changed.matches(rewritten.timeline, boundary, boundary.timelinePrefixRevision)).toBe(false);
  });

  it("requires strictly increasing positive ordinals", () => {
    const original = normalized(["one", "two"]);
    const value = {
      ...original,
      timeline: original.timeline.map((item, index) =>
        index === 1 ? { ...item, ordinal: 1 } : item),
    };
    expect(() => deriveTimelinePrefixIndex(value, Buffer.alloc(32)))
      .toThrow("Timeline ordinals must be strictly increasing");
  });

  it("extends from the prior tail state while preserving every old boundary", () => {
    const original = normalized(["one", "two"]);
    const appended = appendMessage(original, "three");
    const key = Buffer.alloc(32, 7);
    const before = deriveTimelinePrefixIndex(original, key);
    const after = extendTimelinePrefixIndex(before, original, appended, key);
    const fullyRebuilt = deriveTimelinePrefixIndex(appended, key);

    expect(extendsTimelinePrefix(original, appended)).toBe(true);
    expect(after.byteLength).toBe(fullyRebuilt.byteLength);
    for (const ordinal of [0, 1, 2, 3]) {
      expect(after.boundaryAt(appended.timeline, ordinal))
        .toEqual(fullyRebuilt.boundaryAt(appended.timeline, ordinal));
    }
    const oldBoundary = before.boundaryAt(original.timeline, 2)!;
    expect(after.matches(
      appended.timeline,
      oldBoundary,
      oldBoundary.timelinePrefixRevision,
    )).toBe(true);
  });

  it("only offers an append checkpoint for reference-continuous prefixes", () => {
    const key = Buffer.alloc(32, 9);
    const modes: string[] = [];
    const registry = new TimelinePrefixRegistry(trackedBuilder(modes), key);
    const original = normalized(["one"]);
    const first = registry.prepare(new Map([["session-id", original]]));
    first.commit();
    const firstIndexed = first.sessions.get("session-id")!;

    const metadataOnly = {
      ...original,
      session: { ...original.session, title: "Renamed" },
    };
    const second = registry.prepare(
      new Map([["session-id", metadataOnly]]),
      new Set(["session-id"]),
    );
    second.commit();
    expect(second.sessions.get("session-id")!.normalized).toBe(metadataOnly);
    expect(second.sessions.get("session-id")!.timelinePrefixIndex)
      .toBe(firstIndexed.timelinePrefixIndex);

    const appended = appendMessage(metadataOnly, "two");
    const third = registry.prepare(
      new Map([["session-id", appended]]),
      new Set(["session-id"]),
    );
    third.commit();
    const oldBoundary = firstIndexed.timelinePrefixIndex.boundaryAt(
      original.timeline,
      1,
    )!;
    expect(third.sessions.get("session-id")!.timelinePrefixIndex.matches(
      appended.timeline,
      oldBoundary,
      oldBoundary.timelinePrefixRevision,
    )).toBe(true);

    const rewritten = {
      ...appended,
      timeline: [{ ...appended.timeline[0]!, markdown: "changed" }, appended.timeline[1]!],
    } as NormalizedSession;
    const fourth = registry.prepare(
      new Map([["session-id", rewritten]]),
      new Set(["session-id"]),
    );
    expect(modes).toEqual(["full", "append", "full"]);
    expect(fourth.sessions.get("session-id")!.timelinePrefixIndex.matches(
      rewritten.timeline,
      oldBoundary,
      oldBoundary.timelinePrefixRevision,
    )).toBe(false);
  });

  it("forces a full rebuild when an old detail reference changes", () => {
    for (const detailKind of ["tool", "directive", "internal"] as const) {
      const original = normalizedWithDetails();
      const replaced = replaceDetail(original, detailKind);
      const modes: string[] = [];
      const registry = new TimelinePrefixRegistry(
        trackedBuilder(modes),
        Buffer.alloc(32, 5),
      );
      const first = registry.prepare(new Map([["session-id", original]]));
      first.commit();
      const firstIndex = first.sessions.get("session-id")!.timelinePrefixIndex;
      const changedOrdinal = detailKind === "tool" ? 1 : detailKind === "directive" ? 2 : 3;
      const oldBoundary = firstIndex.boundaryAt(
        original.timeline,
        changedOrdinal,
      )!;
      const second = registry.prepare(
        new Map([["session-id", replaced]]),
        new Set(["session-id"]),
      );
      const secondIndex = second.sessions.get("session-id")!.timelinePrefixIndex;

      expect(extendsTimelinePrefix(original, replaced)).toBe(false);
      expect(modes).toEqual(["full", "full"]);
      expect(secondIndex.matches(
        replaced.timeline,
        oldBoundary,
        oldBoundary.timelinePrefixRevision,
      )).toBe(false);
      expect(firstIndex.matches(
        original.timeline,
        oldBoundary,
        oldBoundary.timelinePrefixRevision,
      )).toBe(true);
    }
  });
});

function trackedBuilder(modes: string[]): TimelinePrefixIndexBuilder {
  return (value, prefixKey, previous) => {
    const append = previous !== undefined &&
      extendsTimelinePrefix(previous.normalized, value) &&
      previous.normalized.timeline.length < value.timeline.length;
    modes.push(append ? "append" : "full");
    return append
      ? extendTimelinePrefixIndex(
        previous.timelinePrefixIndex,
        previous.normalized,
        value,
        prefixKey,
        true,
      )
      : deriveTimelinePrefixIndex(value, prefixKey);
  };
}

function replaceDetail(
  original: NormalizedSession,
  detailKind: "tool" | "directive" | "internal",
): NormalizedSession {
  if (detailKind === "tool") {
    const toolDetails = new Map(original.toolDetails);
    toolDetails.set("tool-1", {
      input: "changed",
      output: null,
      truncated: false,
    });
    return { ...original, toolDetails };
  }
  if (detailKind === "directive") {
    const directiveDetails = new Map(original.directiveDetails);
    directiveDetails.set("directive-2", {
      text: "changed",
      truncated: false,
    });
    return { ...original, directiveDetails };
  }
  const internalDetails = new Map(original.internalDetails);
  internalDetails.set("internal-3", { json: "changed", truncated: false });
  return { ...original, internalDetails };
}

function appendMessage(
  value: NormalizedSession,
  markdown: string,
): NormalizedSession {
  const ordinal = value.timeline.length + 1;
  return {
    ...value,
    session: {
      ...value.session,
      messageCount: value.session.messageCount + 1,
      itemCount: value.session.itemCount + 1,
    },
    timeline: [
      ...value.timeline,
      {
        kind: "message",
        id: `message-${ordinal}`,
        ordinal,
        timestamp: null,
        role: "assistant",
        phase: null,
        itemType: null,
        markdown,
      },
    ],
  };
}

function normalizedWithDetails(): NormalizedSession {
  const value = normalized([]);
  return {
    ...value,
    session: { ...value.session, toolCount: 1, itemCount: 3 },
    timeline: [
      {
        kind: "tool",
        id: "tool-1",
        ordinal: 1,
        timestamp: null,
        stage: "call",
        callId: "call",
        toolName: "inspect",
        preview: "input",
        truncated: false,
        hasDetail: true,
      },
      {
        kind: "directive",
        id: "directive-2",
        ordinal: 2,
        timestamp: null,
        summary: "directive",
        charCount: 9,
        truncated: false,
        hasDetail: true,
      },
      {
        kind: "internal",
        id: "internal-3",
        ordinal: 3,
        timestamp: null,
        eventType: "reasoning",
        summary: "Internal event: reasoning",
        truncated: false,
      },
    ],
    toolDetails: new Map([["tool-1", {
      input: "input",
      output: null,
      truncated: false,
    }]]),
    directiveDetails: new Map([["directive-2", {
      text: "directive",
      truncated: false,
    }]]),
    internalDetails: new Map([["internal-3", {
      json: "{\n  \"type\": \"reasoning\"\n}",
      truncated: false,
    }]]),
  };
}

function normalized(markdown: string[]): NormalizedSession {
  return {
    session: {
      id: "session-id",
      sourceId: "source",
      origin: {
        sourceType: "test",
        sourceInstanceId: "test",
        agentName: "test",
        agentVersion: null,
        formatVersion: null,
      },
      title: "Session",
      cwd: null,
      createdAt: null,
      updatedAt: null,
      archived: false,
      parentId: null,
      childIds: [],
      agent: null,
      messageCount: markdown.length,
      toolCount: 0,
      warningCount: 0,
      diagnostics: [],
      itemCount: markdown.length,
    },
    timeline: markdown.map((text, index) => ({
      kind: "message" as const,
      id: `message-${index + 1}`,
      ordinal: index + 1,
      timestamp: null,
      role: "assistant" as const,
      phase: null,
      itemType: null,
      markdown: text,
    })),
    toolDetails: new Map(),
    directiveDetails: new Map(),
    internalDetails: new Map(),
    interaction: null,
  };
}
