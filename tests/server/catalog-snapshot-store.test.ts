import { describe, expect, it } from "vitest";
import type {
  DomainSessionId,
  DomainTimelineRecord,
  NormalizedSession,
} from "../../src/server/domain/session-domain.js";
import {
  CatalogSnapshotStore,
  type CatalogSnapshot,
} from "../../src/server/repository/catalog-snapshot-store.js";
import { deriveTimelinePrefixIndex } from "../../src/server/repository/timeline-prefix-index.js";
import type {
  SessionSource,
  SourceSessionEntry,
} from "../../src/server/source/session-source.js";

describe("CatalogSnapshotStore incremental derivation", () => {
  it("rebuilds timeline-prefix state only for changed source inputs", async () => {
    const stable = normalizedSession("stable", "Stable");
    let changed = normalizedSession("changed", "Changed");
    let signature = "initial";
    let entries = [
      sourceEntry("stable", stable),
      sourceEntry("changed", changed),
    ];
    const prefixCalls: string[] = [];
    const store = new CatalogSnapshotStore(
      [mutableSource(() => ({ signature, entries }))],
      0,
      () => 0,
      {
        timelinePrefixIndexBuilder(normalized, prefixKey) {
          prefixCalls.push(normalized.session.sourceId!);
          return deriveTimelinePrefixIndex(normalized, prefixKey);
        },
      },
    );

    const first = await store.current();
    const stableId = idByTitle(first, "Stable");
    const changedId = idByTitle(first, "Changed");
    const firstStable = first.sessions.get(stableId)!;
    const firstChanged = first.sessions.get(changedId)!;
    expect(prefixCalls).toHaveLength(2);

    changed = withMessage(changed, "appended");
    entries = [
      // The source wrapper objects are deliberately recreated.
      sourceEntry("stable", stable),
      sourceEntry("changed", changed),
    ];
    signature = "append";
    const second = await store.refresh();

    expect(prefixCalls).toHaveLength(3);
    expect(prefixCalls.at(-1)).toBe("changed");
    expect(second.sessions.get(stableId)!.normalized)
      .toBe(firstStable.normalized);
    expect(second.sessions.get(stableId)!.timelinePrefixIndex)
      .toBe(firstStable.timelinePrefixIndex);
    expect(second.sessions.get(changedId)!.timelinePrefixIndex)
      .not.toBe(firstChanged.timelinePrefixIndex);
  });

  it("reuses the prefix index for a fresh normalized object with the same timeline references", async () => {
    let normalized = normalizedSession("session", "Same");
    let signature = "first";
    let prefixCalls = 0;
    const store = new CatalogSnapshotStore(
      [mutableSource(() => ({
        signature,
        entries: [sourceEntry("session", normalized)],
      }))],
      0,
      () => 0,
      {
        timelinePrefixIndexBuilder(value, prefixKey) {
          prefixCalls += 1;
          return deriveTimelinePrefixIndex(value, prefixKey);
        },
      },
    );
    const first = await store.current();
    const id = idByTitle(first, "Same");

    normalized = {
      ...normalized,
      session: { ...normalized.session },
    };
    signature = "fresh-object";
    const second = await store.refresh();

    expect(prefixCalls).toBe(1);
    expect(second.sessions.get(id)!.normalized)
      .not.toBe(first.sessions.get(id)!.normalized);
    expect(second.sessions.get(id)!.timelinePrefixIndex)
      .toBe(first.sessions.get(id)!.timelinePrefixIndex);
    expect(prefixAtEnd(second, id)).toBe(prefixAtEnd(first, id));
  });

  it("updates only the affected relationship closure when a child is reparented or deleted", async () => {
    const parentOne = normalizedSession("p1", "Parent one");
    const parentTwo = normalizedSession("p2", "Parent two");
    const child = normalizedSession("child", "Child");
    let signature = "initial";
    let entries = [
      sourceEntry("p1", parentOne, "native-p1"),
      sourceEntry("p2", parentTwo, "native-p2"),
      sourceEntry("child", child, "native-child", "native-p1"),
    ];
    const store = new CatalogSnapshotStore(
      [mutableSource(() => ({ signature, entries }))],
      0,
      () => 0,
    );
    let snapshot = await store.current();
    const p1Id = idByTitle(snapshot, "Parent one");
    const p2Id = idByTitle(snapshot, "Parent two");
    const childId = idByTitle(snapshot, "Child");
    expect(snapshot.sessions.get(childId)!.normalized.session.parentId).toBe(p1Id);
    expect(snapshot.sessions.get(p1Id)!.normalized.session.childIds).toEqual([childId]);

    const beforeReparent = normalizedReferences(snapshot);
    entries = [
      sourceEntry("p1", parentOne, "native-p1"),
      sourceEntry("p2", parentTwo, "native-p2"),
      sourceEntry("child", child, "native-child", "native-p2"),
    ];
    signature = "reparent";
    snapshot = await store.refresh();
    expect(snapshot.sessions.get(childId)!.normalized.session.parentId).toBe(p2Id);
    expect(snapshot.sessions.get(p1Id)!.normalized.session.childIds).toEqual([]);
    expect(snapshot.sessions.get(p2Id)!.normalized.session.childIds).toEqual([childId]);
    expectChanged(snapshot, beforeReparent, [p1Id, p2Id, childId]);

    const beforeDelete = normalizedReferences(snapshot);
    entries = entries.filter((entry) => entry.localId !== "child");
    signature = "delete-child";
    snapshot = await store.refresh();
    expect(snapshot.sessions.get(p2Id)!.normalized.session.childIds).toEqual([]);
    expectChanged(snapshot, beforeDelete, [p2Id]);
    expect(snapshot.sessions.get(p1Id)!.normalized).toBe(beforeDelete.get(p1Id));
  });

  it("relinks a child when its missing parent appears, disappears, and reappears", async () => {
    const child = normalizedSession("child", "Child");
    const parent = normalizedSession("parent", "Parent");
    let signature = "child-before-parent";
    let entries = [
      sourceEntry("child", child, "native-child", "native-parent"),
    ];
    const store = new CatalogSnapshotStore(
      [mutableSource(() => ({ signature, entries }))],
      0,
      () => 0,
    );
    let snapshot = await store.current();
    const childId = idByTitle(snapshot, "Child");
    expect(snapshot.sessions.get(childId)!.normalized.session.parentId).toBeNull();

    entries = [
      ...entries,
      sourceEntry("parent", parent, "native-parent"),
    ];
    signature = "parent-appears";
    snapshot = await store.refresh();
    const parentId = idByTitle(snapshot, "Parent");
    const firstParent = snapshot.sessions.get(parentId)!.normalized;
    expect(snapshot.sessions.get(childId)!.normalized.session.parentId).toBe(parentId);
    expect(snapshot.sessions.get(parentId)!.normalized.session.childIds).toEqual([childId]);

    entries = entries.filter((entry) => entry.localId !== "parent");
    signature = "parent-deleted";
    snapshot = await store.refresh();
    expect(snapshot.sessions.get(childId)!.normalized.session.parentId).toBeNull();

    entries = [
      ...entries,
      sourceEntry("parent", parent, "native-parent"),
    ];
    signature = "parent-reappears";
    snapshot = await store.refresh();
    expect(snapshot.sessions.get(parentId)!.normalized).not.toBe(firstParent);
    expect(snapshot.sessions.get(childId)!.normalized.session.parentId).toBe(parentId);
  });

  it("unlinks and recovers a child when its native parent identity becomes ambiguous", async () => {
    const child = normalizedSession("child", "Child");
    const parent = normalizedSession("parent", "Parent");
    const duplicateParent = normalizedSession("duplicate", "Duplicate parent");
    let signature = "native-unique";
    let entries = [
      sourceEntry("child", child, "native-child", "native-parent"),
      sourceEntry("parent", parent, "native-parent"),
    ];
    const store = new CatalogSnapshotStore(
      [mutableSource(() => ({ signature, entries }))],
      0,
      () => 0,
    );
    let snapshot = await store.current();
    const childId = idByTitle(snapshot, "Child");
    const parentId = idByTitle(snapshot, "Parent");
    expect(snapshot.sessions.get(childId)!.normalized.session.parentId).toBe(parentId);

    entries = [
      ...entries,
      sourceEntry("duplicate", duplicateParent, "native-parent"),
    ];
    signature = "native-duplicate";
    snapshot = await store.refresh();
    const duplicateId = idByTitle(snapshot, "Duplicate parent");
    expect(snapshot.sessions.get(childId)!.normalized.session.parentId).toBeNull();
    expect(snapshot.sessions.get(parentId)!.normalized.session.childIds).toEqual([]);

    const beforeRecovery = normalizedReferences(snapshot);
    entries = entries.filter((entry) => entry.localId !== "duplicate");
    signature = "native-unique-again";
    snapshot = await store.refresh();
    expect(snapshot.sessions.get(duplicateId)).toBeUndefined();
    expect(snapshot.sessions.get(childId)!.normalized.session.parentId).toBe(parentId);
    expect(snapshot.sessions.get(parentId)!.normalized.session.childIds).toEqual([childId]);
    expectChanged(snapshot, beforeRecovery, [childId, parentId]);
  });

  it("does not commit timeline-prefix state after a failed rebuild", async () => {
    let left = normalizedSession("left", "Left");
    let right = normalizedSession("right", "Right");
    let signature = "initial";
    let failPrefix = false;
    const prefixCalls: string[] = [];
    const store = new CatalogSnapshotStore(
      [mutableSource(() => ({
        signature,
        entries: [
          sourceEntry("left", left),
          sourceEntry("right", right),
        ],
      }))],
      0,
      () => 0,
      {
        timelinePrefixIndexBuilder(normalized, prefixKey) {
          prefixCalls.push(normalized.session.sourceId!);
          if (failPrefix && normalized.session.sourceId === "right") {
            throw new Error("prefix failed");
          }
          return deriveTimelinePrefixIndex(normalized, prefixKey);
        },
      },
    );
    const initial = await store.current();
    const leftId = idByTitle(initial, "Left");
    const rightId = idByTitle(initial, "Right");

    left = withMessage(left, "left changed");
    right = withMessage(right, "right changed");
    signature = "prefix-failure";
    failPrefix = true;
    await expect(store.refresh()).rejects.toThrow("prefix failed");
    failPrefix = false;
    const recovered = await store.refresh();

    expect(prefixCalls.filter((id) => id === "right")).toHaveLength(3);
    expect(recovered.sessions.get(leftId)!.normalized.session.messageCount).toBe(1);
    expect(recovered.sessions.get(rightId)!.normalized.session.messageCount).toBe(1);
  });

  it("retains the published aggregate state when relationship linking fails", async () => {
    const normalized = normalizedSession("session", "Session");
    let state: "initial" | "broken" | "recovered" = "initial";
    let prefixCalls = 0;
    const source: SessionSource = {
      descriptor: {
        sourceType: "test",
        instanceKey: "relationship-failure",
        sourceInstanceId: "relationship-failure",
        displayName: "Test",
      },
      async refresh() {
        const entry = sourceEntry("session", normalized);
        if (state === "broken") {
          Object.defineProperty(entry, "parentNativeSessionId", {
            get() {
              throw new Error("relationship failed");
            },
          });
        }
        return {
          signature: state,
          sessions: [entry],
          diagnostics: [],
        };
      },
    };
    const store = new CatalogSnapshotStore(
      [source],
      0,
      () => 0,
      {
        timelinePrefixIndexBuilder(value, prefixKey) {
          prefixCalls += 1;
          return deriveTimelinePrefixIndex(value, prefixKey);
        },
      },
    );
    const initial = await store.current();
    const id = idByTitle(initial, "Session");

    state = "broken";
    await expect(store.refresh()).rejects.toThrow("relationship failed");
    state = "recovered";
    const recovered = await store.refresh();

    expect(prefixCalls).toBe(1);
    expect(recovered.sessions.get(id)!.normalized)
      .toBe(initial.sessions.get(id)!.normalized);
    expect(recovered.sessions.get(id)!.timelinePrefixIndex)
      .toBe(initial.sessions.get(id)!.timelinePrefixIndex);
  });
});

const TEST_ORIGIN = {
  sourceType: "test",
  sourceInstanceId: "test",
  agentName: "Test",
  agentVersion: null,
  formatVersion: null,
} as const;

function mutableSource(
  state: () => {
    signature: string;
    entries: readonly SourceSessionEntry[];
  },
): SessionSource {
  return {
    descriptor: {
      sourceType: "test",
      instanceKey: "test",
      sourceInstanceId: "test",
      displayName: "Test",
    },
    async refresh() {
      const current = state();
      return {
        signature: current.signature,
        sessions: current.entries.map((entry) => ({ ...entry })),
        diagnostics: [],
      };
    },
  };
}

function sourceEntry(
  localId: string,
  normalized: NormalizedSession,
  nativeSessionId = localId,
  parentNativeSessionId: string | null = null,
): SourceSessionEntry {
  return {
    localId,
    nativeSessionId,
    parentNativeSessionId,
    origin: TEST_ORIGIN,
    normalized,
  };
}

function normalizedSession(id: string, title: string): NormalizedSession {
  return {
    session: {
      id,
      sourceId: id,
      origin: TEST_ORIGIN,
      title,
      cwd: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      archived: false,
      parentId: null,
      childIds: [],
      agent: null,
      messageCount: 0,
      toolCount: 0,
      warningCount: 0,
      diagnostics: [],
      itemCount: 0,
    },
    timeline: [],
    toolDetails: new Map(),
    directiveDetails: new Map(),
    internalDetails: new Map(),
  };
}

function withMessage(
  normalized: NormalizedSession,
  markdown: string,
): NormalizedSession {
  const timeline: DomainTimelineRecord[] = [
    ...normalized.timeline,
    {
      kind: "message",
      id: `message-${normalized.timeline.length + 1}`,
      ordinal: normalized.timeline.length + 1,
      timestamp: null,
      role: "assistant",
      phase: "final",
      itemType: null,
      markdown,
    },
  ];
  return {
    ...normalized,
    session: {
      ...normalized.session,
      messageCount: timeline.length,
      itemCount: timeline.length,
    },
    timeline,
  };
}

function idByTitle(snapshot: CatalogSnapshot, title: string): DomainSessionId {
  const matches = [...snapshot.sessions].filter(
    ([, value]) => value.normalized.session.title === title,
  );
  if (matches.length !== 1) {
    throw new Error(`Expected one session titled ${title}, found ${matches.length}`);
  }
  return matches[0]![0];
}

function normalizedReferences(
  snapshot: CatalogSnapshot,
): Map<string, NormalizedSession> {
  return new Map(
    [...snapshot.sessions].map(([id, value]) => [id, value.normalized]),
  );
}

function expectChanged(
  snapshot: CatalogSnapshot,
  before: ReadonlyMap<string, NormalizedSession>,
  ids: readonly string[],
): void {
  for (const id of ids) {
    expect(snapshot.sessions.get(id)!.normalized).not.toBe(before.get(id));
  }
}

function prefixAtEnd(snapshot: CatalogSnapshot, id: DomainSessionId): string {
  const indexed = snapshot.sessions.get(id)!;
  return indexed.timelinePrefixIndex.boundaryAtOrBefore(
    indexed.normalized.timeline,
    Number.MAX_SAFE_INTEGER,
  ).timelinePrefixRevision;
}
