import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionApiMapper } from "../../src/server/api/session-api-mapper.js";
import type {
  DomainSession,
  DomainTimelineRecord,
  NormalizedSession,
} from "../../src/server/domain/session-domain.js";
import {
  CatalogSnapshotStore,
  MAX_CATALOG_DIAGNOSTICS,
  type CatalogSnapshot,
} from "../../src/server/repository/catalog-snapshot-store.js";
import {
  RepositoryQueryError,
  SessionQueries,
} from "../../src/server/repository/session-queries.js";
import { deriveTimelinePrefixIndex } from "../../src/server/repository/timeline-prefix-index.js";
import type {
  SessionSource,
  SourceSessionEntry,
} from "../../src/server/source/session-source.js";

const session: DomainSession = {
  id: "session-one",
  sourceId: "private-source-id",
  origin: {
    sourceType: "test",
    sourceInstanceId: "test-source",
    agentName: "Test Agent",
    agentVersion: "1.0.0",
    formatVersion: null,
  },
  title: "Session one",
  cwd: "/project",
  createdAt: "2026-07-28T00:00:00Z",
  updatedAt: "2026-07-28T01:00:00Z",
  archived: false,
  parentId: null,
  childIds: ["child"],
  agent: { taskName: "task", nickname: null, role: "worker" },
  messageCount: 1,
  toolCount: 0,
  warningCount: 1,
  diagnostics: [{
    code: "partial",
    severity: "warning",
    message: "Partial",
    ordinal: 2,
  }],
  itemCount: 1,
};

const timeline: readonly DomainTimelineRecord[] = [{
  kind: "token",
  id: "token-1",
  ordinal: 1,
  timestamp: null,
  tokenUsage: {
    total: {
      totalTokens: 10,
      inputTokens: 8,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: 2,
      reasoningOutputTokens: null,
    },
    last: null,
  },
}];

const normalized: NormalizedSession = {
  session,
  timeline,
  toolDetails: new Map(),
  directiveDetails: new Map(),
};

describe("server architecture boundaries", () => {
  it("keeps generic server modules independent from the Codex adapter", async () => {
    const genericDirectories = [
      "application",
      "api",
      "domain",
      "http",
      "repository",
      "security",
      "source",
    ];
    const files = (
      await Promise.all(
        genericDirectories.map((directory) =>
          typescriptFiles(resolve("src/server", directory))
        ),
      )
    ).flat();

    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(
        /(?:from\s+|import\s*\()["'][^"']*adapters\/codex/,
      );
    }
  });

  it("keeps repository queries independent from API contracts and mapping", async () => {
    const repositoryFiles = await typescriptFiles(resolve("src/server/repository"));
    for (const file of repositoryFiles) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(/shared\/api-contract|server\/api|SessionApiMapper/);
    }

    const application = await readFile(
      resolve("src/server/application/session-read-service.ts"),
      "utf8",
    );
    expect(application).toContain("SessionApiMapper");
    expect(application).toContain("CatalogSnapshotStore");
    expect(application).toContain("SessionQueries");
  });

  it("maps domain values exactly without leaking private summary fields or mutable references", () => {
    const mapper = new SessionApiMapper();
    const queries = new SessionQueries();
    const read = queries.session(snapshotOf(normalized), "session-one")!;
    const detail = mapper.detail(read);
    const summary = mapper.summary(session);
    const item = mapper.timelineItem(timeline[0]!);
    const catalogDiagnostic = {
      code: "catalog_warning",
      severity: "warning" as const,
      message: "Catalog warning",
      ordinal: null,
    };
    const catalog = mapper.list(
      queries.list(snapshotOf(normalized), {}),
      [catalogDiagnostic],
    );

    expect(summary).toEqual({
      id: "session-one",
      origin: {
        sourceType: "test",
        sourceInstanceId: "test-source",
        agentName: "Test Agent",
        agentVersion: "1.0.0",
        formatVersion: null,
      },
      title: "Session one",
      nickname: null,
      cwd: "/project",
      createdAt: "2026-07-28T00:00:00Z",
      updatedAt: "2026-07-28T01:00:00Z",
      archived: false,
      parentId: null,
      childIds: ["child"],
      agent: { taskName: "task", nickname: null, role: "worker" },
      messageCount: 1,
      toolCount: 0,
      warningCount: 1,
    });
    expect(summary).not.toHaveProperty("sourceId");
    expect(detail).toEqual({
      session: {
        ...summary,
        sourceId: "private-source-id",
        diagnostics: [{
          code: "partial",
          severity: "warning",
          message: "Partial",
          ordinal: 2,
        }],
        itemCount: 1,
      },
    });
    expect(catalog.diagnostics).toEqual([catalogDiagnostic]);

    summary.childIds.push("mutated");
    detail.session.diagnostics[0]!.message = "mutated";
    catalog.diagnostics[0]!.message = "mutated";
    if (item.kind === "token" && item.tokenUsage.total) {
      item.tokenUsage.total.totalTokens = 99;
    }
    expect(session.childIds).toEqual(["child"]);
    expect(session.diagnostics[0]!.message).toBe("Partial");
    expect(catalogDiagnostic.message).toBe("Catalog warning");
    expect(
      timeline[0]?.kind === "token"
        ? timeline[0].tokenUsage.total?.totalTokens
        : null,
    ).toBe(10);
  });

  it("limits catalog diagnostics while preserving their order", async () => {
    const diagnostics = Array.from(
      { length: MAX_CATALOG_DIAGNOSTICS + 1 },
      (_, index) => ({
        code: `catalog_warning_${index + 1}`,
        severity: "warning" as const,
        message: `Catalog warning ${index + 1}`,
        ordinal: null,
      }),
    );
    const source = {
      ...testSource("catalog-diagnostics", []),
      async refresh() {
        return {
          signature: "catalog-diagnostics",
          sessions: [],
          diagnostics,
        };
      },
    };

    const snapshot = await new CatalogSnapshotStore([source]).current();

    expect(snapshot.diagnostics).toEqual(
      diagnostics.slice(0, MAX_CATALOG_DIAGNOSTICS),
    );
  });

  it("rejects a cursor after its confirmed timeline prefix changes", () => {
    const queries = new SessionQueries();
    const first = queries.items(snapshotOf(normalized), session.id, {})!;
    const changed: NormalizedSession = {
      ...normalized,
      timeline: [{ ...timeline[0]!, timestamp: "2026-07-28T02:00:00Z" }],
    };

    expect(() => queries.items(snapshotOf(changed), session.id, {
      cursor: first.context.cursor,
    })).toThrowError(expect.objectContaining<Partial<RepositoryQueryError>>({
      code: "timeline_changed",
    }));
  });

  it("rejects duplicate source instances and propagates source invariant failures", async () => {
    const source = {
      descriptor: {
        sourceType: "test",
        instanceKey: "test-source",
        sourceInstanceId: "test-source",
        displayName: "Test",
      },
      refresh: vi.fn(async () => {
        throw new Error("source invariant");
      }),
    };
    expect(() => new CatalogSnapshotStore([source, source])).toThrow(
      "Duplicate session source instance key",
    );
    await expect(new CatalogSnapshotStore([source]).current()).rejects.toThrow(
      "source invariant",
    );
  });

  it("namespaces source identities, links parents locally, and ignores source order", async () => {
    const sourceA = testSource("source-a", [
      sourceEntry("parent", null, "Source A parent"),
      sourceEntry("child-z", "parent", "Source A child Z"),
      sourceEntry("child-a", "parent", "Source A child A"),
    ]);
    const sourceAWithReorderedEntries = testSource("source-a", [
      sourceEntry("parent", null, "Source A parent"),
      sourceEntry("child-a", "parent", "Source A child A"),
      sourceEntry("child-z", "parent", "Source A child Z"),
    ]);
    const sourceB = testSource("source-b", [
      sourceEntry("parent", null, "Source B parent"),
      sourceEntry("child", "missing-in-source-b", "Source B child"),
    ]);
    const first = await new CatalogSnapshotStore([sourceA, sourceB]).current();
    const reordered = await new CatalogSnapshotStore([sourceB, sourceA]).current();
    const reorderedEntries = await new CatalogSnapshotStore([
      sourceAWithReorderedEntries,
      sourceB,
    ]).current();

    expect(first.signature).toBe(reordered.signature);
    expect(first.signature).toBe(reorderedEntries.signature);
    expect(first.orderedIds).toEqual(reordered.orderedIds);
    const queries = new SessionQueries();
    expect(queries.list(first, {}).sessions)
      .toEqual(queries.list(reordered, {}).sessions);
    expect([...first.sessions.keys()].sort()).toEqual(
      [...reordered.sessions.keys()].sort(),
    );
    const byTitle = new Map(
      [...first.sessions.values()].map(({ normalized: value }) => [
        value.session.title,
        value.session,
      ]),
    );
    expect(byTitle.get("Source A parent")?.id)
      .not.toBe(byTitle.get("Source B parent")?.id);
    expect(byTitle.get("Source A child A")?.parentId)
      .toBe(byTitle.get("Source A parent")?.id);
    expect(byTitle.get("Source A child Z")?.parentId)
      .toBe(byTitle.get("Source A parent")?.id);
    expect(byTitle.get("Source B child")?.parentId).toBeNull();
    const parent = byTitle.get("Source A parent")!;
    expect(parent.childIds).toEqual([...parent.childIds].sort());
    expect(parent.childIds).toEqual(
      [...reorderedEntries.sessions.values()]
        .find(({ normalized: value }) => value.session.title === "Source A parent")!
        .normalized.session.childIds,
    );
  });

  it("uses session ID as the final tie-breaker across source registration order", async () => {
    const sourceA = testSource("tie-a", [sourceEntry("same", null, "Tie")]);
    const sourceB = testSource("tie-b", [sourceEntry("same", null, "Tie")]);
    const first = await new CatalogSnapshotStore([sourceA, sourceB]).current();
    const reversed = await new CatalogSnapshotStore([sourceB, sourceA]).current();

    expect(first.orderedIds).toEqual(reversed.orderedIds);
    const queries = new SessionQueries();
    const firstResult = queries.list(first, {});
    const reversedResult = queries.list(reversed, {});
    expect(firstResult.sessions.map(({ id }) => id)).toEqual(
      reversedResult.sessions.map(({ id }) => id),
    );
    expect(firstResult.total).toBe(reversedResult.total);
  });
});

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return typescriptFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return files.flat();
}

function snapshotOf(value: NormalizedSession): CatalogSnapshot {
  const timelinePrefixIndex = deriveTimelinePrefixIndex(value, Buffer.alloc(32, 7));
  return {
    signature: "snapshot",
    diagnostics: [],
    sessions: new Map([[
      value.session.id,
      {
        normalized: value,
        timelinePrefixIndex,
      },
    ]]),
    orderedIds: [value.session.id],
  };
}

function sourceEntry(
  nativeSessionId: string,
  parentNativeSessionId: string | null,
  title: string,
): SourceSessionEntry {
  const origin = {
    sourceType: "test",
    sourceInstanceId: "replaced-by-source",
    agentName: "Test",
    agentVersion: null,
    formatVersion: null,
  };
  return {
    localId: nativeSessionId,
    nativeSessionId,
    parentNativeSessionId,
    origin,
    normalized: {
      ...normalized,
      session: {
        ...normalized.session,
        id: nativeSessionId,
        sourceId: nativeSessionId,
        origin,
        title,
        parentId: parentNativeSessionId,
        childIds: [],
      },
    },
  };
}

function testSource(
  instanceKey: string,
  sessions: readonly SourceSessionEntry[],
): SessionSource {
  return {
    descriptor: {
      sourceType: "test",
      instanceKey,
      sourceInstanceId: instanceKey,
      displayName: "Test",
    },
    async refresh() {
      return { signature: "stable", sessions, diagnostics: [] };
    },
  };
}
