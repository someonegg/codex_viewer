import { appendFile, cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCodexSessionReadService,
} from "../../src/server/create-session-read-service.js";
import type {
  SessionSource,
  SourceSessionEntry,
} from "../../src/server/source/session-source.js";
import {
  SessionReadService,
  MAX_ITEM_PAGE_BYTES,
} from "../../src/server/application/session-read-service.js";
import type {
  DomainTimelineRecord,
  NormalizedSession,
} from "../../src/server/domain/session-domain.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

async function fixtureRepository() {
  const home = await createTempDirectory("codex-repository-");
  await cp(resolve("tests/fixtures/codex-home"), home, { recursive: true });
  return { home, repository: await createCodexSessionReadService(home) };
}

async function basicFixtureSession() {
  const { home, repository } = await fixtureRepository();
  const catalogSessions = (await repository.list({})).sessions;
  const session = catalogSessions.find(({ title }) => title === "Synthetic trace");
  if (session === undefined) throw new Error("Expected the basic fixture session");
  const rollout = join(
    home,
    "sessions/2026/07/28/rollout-2026-07-28T10-00-00-basic-session.jsonl",
  );
  return { catalogSessions, home, repository, rollout, session };
}

describe("SessionReadService", () => {
  it("coalesces concurrent refreshes, reuses a fresh snapshot, and permits a forced refresh", async () => {
    let discoveries = 0;
    let now = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const source: SessionSource = {
      descriptor: {
        sourceType: "test",
        instanceKey: "test",
        sourceInstanceId: "test",
        displayName: "Test",
      },
      async refresh() {
        discoveries += 1;
        await gate;
        return { signature: "empty", sessions: [], diagnostics: [] };
      },
    };
    const repository = new SessionReadService(
      [source],
      undefined,
      () => now,
    );

    const firstList = repository.list({});
    const secondList = repository.list({});
    release();
    expect((await firstList).nextCursor).toBeNull();
    expect((await secondList).sessions).toEqual([]);
    expect(discoveries).toBe(1);
    await repository.list({});
    expect(discoveries).toBe(1);
    now = 1_499;
    await repository.list({});
    expect(discoveries).toBe(1);
    now = 1_500;
    await repository.list({});
    expect(discoveries).toBe(2);
    await expect(repository.refresh()).resolves.toBeUndefined();
    expect(discoveries).toBe(3);
  });

  it("uses session-index nicknames without invalidating list or timeline cursors", async () => {
    const { home, repository } = await fixtureRepository();
    const baseline = await repository.list({ limit: 1 });
    const expectedSecondId = (await repository.list({})).sessions[1]!.id;
    const basic = (await repository.list({})).sessions.find(
      ({ title }) => title === "Synthetic trace",
    )!;
    const firstItems = await repository.getItems(basic.id, { limit: 1 });

    await writeFile(join(home, "session_index.jsonl"), [
      JSON.stringify({ id: "basic-session", thread_name: "Old nickname" }),
      JSON.stringify({ id: "basic-session", thread_name: "Current nickname" }),
      JSON.stringify({ id: "basic-session", thread_name: "  " }),
      "{incomplete",
    ].join("\n"));
    await repository.refresh();

    const continuation = await repository.list({
      limit: 1,
      cursor: baseline.nextCursor!,
    });
    expect(continuation.sessions[0]!.id).toBe(expectedSecondId);
    const renamed = (await repository.list({})).sessions.find(
      ({ id }) => id === basic.id,
    );
    expect(renamed).toMatchObject({
      title: "Synthetic trace",
      nickname: "Current nickname",
    });

    const detail = await repository.getSession(basic.id);
    expect(detail?.session).toMatchObject({
      title: "Synthetic trace",
      nickname: "Current nickname",
    });
    const continuedItems = await repository.getItems(basic.id, {
      cursor: firstItems!.cursor,
      limit: 1,
    });
    expect(continuedItems?.session).toMatchObject({
      title: "Synthetic trace",
      nickname: "Current nickname",
    });
    const live = await repository.getLiveSession(basic.id, firstItems!.cursor);
    expect(live?.session).toMatchObject({
      title: "Synthetic trace",
      nickname: "Current nickname",
    });
  });

  it("keeps catalog contents stable when only source diagnostics change", async () => {
    let signature = "warning";
    let diagnostics = [{
      code: "temporary_source_warning",
      severity: "warning" as const,
      message: "temporarily unavailable",
      ordinal: null,
    }];
    const source: SessionSource = {
      ...staticSource("diagnostics", []),
      async refresh() {
        return {
          signature,
          sessions: [sourceEntry(
            "stable",
            normalizedSession("stable", "Stable", "/project", []),
          )],
          diagnostics,
        };
      },
    };
    const repository = new SessionReadService([source]);
    const first = await repository.list({});
    expect(first.diagnostics).toEqual(diagnostics);
    first.diagnostics[0]!.message = "mutated response";
    expect(diagnostics[0]!.message).toBe("temporarily unavailable");

    signature = "recovered";
    diagnostics = [];
    await repository.refresh();

    const recovered = await repository.list({});
    expect(recovered.sessions).toEqual(first.sessions);
    expect(recovered.diagnostics).toEqual([]);
  });

  it("returns catalog diagnostics independently of list filters and without source paths", async () => {
    const source = {
      ...staticSource("catalog-diagnostics", []),
      async refresh() {
        const duplicate = sourceEntry(
          "duplicate",
          normalizedSession("duplicate", "Duplicate", "/project/a", []),
        );
        return {
          signature: "catalog-diagnostics",
          sessions: [duplicate, duplicate],
          diagnostics: [
            {
              code: "session_root_unreadable",
              severity: "warning" as const,
              message: "A configured session root could not be read.",
              ordinal: null,
            },
            {
              code: "rollout_unavailable",
              severity: "warning" as const,
              message: "A session rollout is temporarily unavailable.",
              ordinal: null,
            },
          ],
        };
      },
    };
    const sessions = new SessionReadService([source]);

    const result = await sessions.list({
      project: "/project/missing",
      from: "2026-06-01T00:00:00.000Z",
      limit: 1,
    });

    expect(result.sessions).toEqual([]);
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "session_root_unreadable",
      "rollout_unavailable",
      "duplicate_source_session_id",
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain("/private/");
  });

  it("computes project facets before applying the selected project", async () => {
    const archived = normalizedSession(
      "archived",
      "Archived",
      "/project/archived",
      [],
      "2026-04-01T00:00:00.000Z",
    );
    const sessions = new SessionReadService([staticSource("facets", [
      sourceEntry(
        "a",
        normalizedSession("a", "Project A", "/project/a", [], "2026-02-01T00:00:00.000Z"),
      ),
      sourceEntry(
        "b",
        normalizedSession("b", "Project B", "/project/b", [], "2026-03-01T00:00:00.000Z"),
      ),
      sourceEntry(
        "outside-date",
        normalizedSession("outside-date", "Old", "/project/old", [], "2025-03-01T00:00:00.000Z"),
      ),
      sourceEntry("archived", {
        ...archived,
        session: { ...archived.session, archived: true },
      }),
    ])]);
    const range = {
      project: "/project/a",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-12-31T23:59:59.999Z",
    } as const;

    const selectedProject = await sessions.list(range);
    expect(selectedProject.sessions.map(({ cwd }) => cwd)).toEqual(["/project/a"]);
    expect(selectedProject.total).toBe(1);
    expect(selectedProject.projects).toEqual([
      { project: "/project/a", count: 1 },
      { project: "/project/archived", count: 1 },
      { project: "/project/b", count: 1 },
    ]);

    const archivedProject = await sessions.list({
      ...range,
      project: "/project/archived",
    });
    expect(archivedProject.sessions).toHaveLength(1);
    expect(archivedProject.sessions[0]?.archived).toBe(true);
    expect(archivedProject.projects).toEqual([
      { project: "/project/a", count: 1 },
      { project: "/project/archived", count: 1 },
      { project: "/project/b", count: 1 },
    ]);
  });

  it("publishes linked summaries and pages timeline details", async () => {
    const { catalogSessions, repository, session: parent } = await basicFixtureSession();
    const child = catalogSessions.find((session) => session.cwd === "/synthetic/child")!;
    expect(child.parentId).toBe(parent.id);
    expect(parent.childIds).toContain(child.id);

    const page = await repository.getItems(parent.id, {
      limit: 2,
    });
    expect(page?.hasMore).toBe(true);
    await expect(repository.getItems(parent.id, {
      cursor: page!.cursor,
      limit: 2,
    })).resolves.not.toBeNull();
    const allItems = await repository.getItems(parent.id, {
      limit: 200,
    });
    const directive = allItems!.items.find((item) => item.id === "directive-4")!;
    expect(JSON.stringify(allItems)).not.toContain("DIRECTIVE_DETAIL_CANARY");
    expect(await repository.getDirectiveDetail(parent.id, directive.id, {
      cursor: allItems!.cursor,
    })).toEqual(expect.objectContaining({
      itemId: directive.id,
      text: expect.stringContaining("DIRECTIVE_DETAIL_CANARY"),
      truncated: false,
    }));
  });

  it("keeps confirmed timeline and detail cursors valid after append", async () => {
    const { repository, rollout, session } = await basicFixtureSession();
    const page = await repository.getItems(session.id, { limit: 2 });
    const allItems = await repository.getItems(session.id, { limit: 200 });
    const directive = allItems!.items.find((item) => item.id === "directive-4")!;
    const previous = await readFile(rollout, "utf8");
    await writeFile(
      rollout,
      `${previous}{"timestamp":"2026-07-28T10:00:10.000Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"final","content":[{"type":"output_text","text":"Appended revision"}]}}\n`,
    );
    await repository.refresh();
    const second = await repository.getItems(session.id, {
      cursor: page!.cursor,
      limit: 2,
    });
    expect(second!.session.messageCount)
      .toBe(session.messageCount);
    expect(second!.hasMore).toBe(true);
    await expect(repository.getItems(session.id, {
      cursor: page!.cursor,
    })).resolves.not.toBeNull();
    await expect(repository.getDirectiveDetail(session.id, directive.id, {
      cursor: allItems!.cursor,
    })).resolves.toEqual(expect.objectContaining({ itemId: directive.id }));
  });

  it("invalidates confirmed cursors after rollout replacement", async () => {
    const { repository, rollout, session } = await basicFixtureSession();
    const page = await repository.getItems(session.id, { limit: 2 });
    const replacement = `${rollout}.replacement`;
    await writeFile(
      replacement,
      '{"timestamp":"2026-07-28T13:00:00.000Z","type":"session_meta","payload":{"id":"basic-session","title":"Replacement trace"}}\n' +
      '{"timestamp":"2026-07-28T13:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"replacement"}]}}\n',
    );
    await rename(replacement, rollout);
    await repository.refresh();
    const third = await repository.getSession(session.id);
    expect(third!.session.title).toBe("Replacement trace");
    expect(third!.session.messageCount).toBe(0);
    await expect(repository.getItems(session.id, {
      cursor: page!.cursor,
    })).rejects.toMatchObject({
      code: "timeline_changed",
    });
  });

  it("keeps a loaded call prefix stable when an output is appended", async () => {
    const home = await createTempDirectory("codex-tool-append-");
    const directory = join(home, "sessions");
    await mkdir(directory, { recursive: true });
    const rollout = join(directory, "rollout-tool-append.jsonl");
    await writeFile(
      rollout,
      '{"timestamp":"2026-07-28T10:00:00Z","type":"session_meta","payload":{"id":"tool-append","title":"Tool append"}}\n' +
      '{"timestamp":"2026-07-28T10:00:01Z","type":"response_item","payload":{"type":"function_call","name":"inspect","arguments":"input","call_id":"stable-call"}}\n',
    );
    const repository = await createCodexSessionReadService(home);
    const listed = await repository.list({});
    const sessionId = listed.sessions[0]!.id;
    const callPage = await repository.getItems(sessionId, {
      limit: 1,
    });
    const call = callPage!.items[0]!;
    expect(call).toMatchObject({
      kind: "tool",
      stage: "call",
      callId: "stable-call",
    });
    const callDetailBefore = await repository.getToolDetail(sessionId, call.id, {
      cursor: callPage!.cursor,
    });

    await appendFile(
      rollout,
      '{"timestamp":"2026-07-28T10:00:02Z","type":"response_item","payload":{"type":"function_call_output","call_id":"stable-call","output":"result"}}\n',
    );
    await repository.refresh();

    const continuation = await repository.getItems(sessionId, {
      cursor: callPage!.cursor,
      limit: 1,
    });
    expect(continuation!.items).toEqual([
      expect.objectContaining({
        kind: "tool",
        stage: "output",
        callId: "stable-call",
        status: "completed",
        preview: "result",
      }),
    ]);
    expect(continuation!.session).toMatchObject({
      toolCount: 1,
      itemCount: 2,
    });
    const callDetailAfter = await repository.getToolDetail(sessionId, call.id, {
      cursor: callPage!.cursor,
    });
    expect({
      input: callDetailAfter!.input,
      output: callDetailAfter!.output,
      truncated: callDetailAfter!.truncated,
    }).toEqual({
      input: callDetailBefore!.input,
      output: callDetailBefore!.output,
      truncated: callDetailBefore!.truncated,
    });
    expect(callDetailAfter).toMatchObject({
      input: "input",
      output: null,
      truncated: false,
    });
  });

  it("does not revise a session until an appended JSONL tail is terminated", async () => {
    const home = await createTempDirectory("codex-silent-tail-");
    const directory = join(home, "sessions");
    await mkdir(directory, { recursive: true });
    const rollout = join(directory, "rollout-silent-tail.jsonl");
    await writeFile(
      rollout,
      '{"timestamp":"2026-07-28T10:00:00Z","type":"session_meta","payload":{"id":"silent-tail","title":"Silent tail"}}\n',
    );
    const repository = await createCodexSessionReadService(home);
    const sessionId = (await repository.list({})).sessions[0]!.id;
    const before = await repository.getSession(sessionId);
    const beforePage = await repository.getItems(sessionId, {});

    await appendFile(
      rollout,
      '{"timestamp":"2026-07-28T10:00:01Z","type":"response_item","payload":{"type":"function_call","name":"pending","arguments":"input","call_id":"tail-call"}}',
    );
    await repository.refresh();
    const pending = await repository.getSession(sessionId);
    expect(pending!.session).toEqual(before!.session);
    await expect(repository.getItems(sessionId, { cursor: beforePage!.cursor }))
      .resolves.toEqual(expect.objectContaining({ items: [] }));

    await appendFile(rollout, "\n");
    await repository.refresh();
    const committed = await repository.getSession(sessionId);
    expect(committed!.session).toMatchObject({ toolCount: 1, itemCount: 1 });
    await expect(repository.getItems(sessionId, { cursor: beforePage!.cursor }))
      .resolves.toEqual(expect.objectContaining({
        items: [expect.objectContaining({ kind: "tool" })],
      }));
  });

  it("keeps session A reader requests valid while only session B changes", async () => {
    const sessionA = normalizedSession("session-a", "Session A", null, [
      {
        kind: "message",
        id: "message-1",
        ordinal: 1,
        timestamp: null,
        role: "user",
        phase: null,
        itemType: null,
        markdown: "first",
      },
      {
        kind: "directive",
        id: "directive-2",
        ordinal: 2,
        timestamp: null,
        summary: "detail",
        charCount: 6,
        truncated: false,
        hasDetail: true,
      },
      {
        kind: "message",
        id: "message-3",
        ordinal: 3,
        timestamp: null,
        role: "assistant",
        phase: "final",
        itemType: null,
        markdown: "later",
      },
    ]);
    let sessionAWithDetail: NormalizedSession = {
      ...sessionA,
      directiveDetails: new Map([[
        "directive-2",
        { text: "secret", truncated: false },
      ]]),
    };
    let sourceSignature = "initial";
    let sessionB = normalizedSession("session-b", "Session B", null, []);
    const source: SessionSource = {
      ...staticSource("mutable", []),
      async refresh() {
        return {
          signature: sourceSignature,
          sessions: [
            sourceEntry("session-a", sessionAWithDetail),
            sourceEntry("session-b", sessionB),
          ],
          diagnostics: [],
        };
      },
    };
    const repository = new SessionReadService([source]);
    const list = await repository.list({});
    const sessionAId = list.sessions.find((session) => session.title === "Session A")!.id;
    const first = await repository.getItems(sessionAId, {
      limit: 2,
    });
    const directive = first!.items.find((item) => item.kind === "directive")!;

    for (const change of ["changed-once", "changed-twice"]) {
      sourceSignature = `session-b-${change}`;
      sessionB = normalizedSession("session-b", `Session B ${change}`, null, []);
      await repository.refresh();
      expect((await repository.getSession(sessionAId))?.session.title)
        .toBe("Session A");
    }

    await expect(repository.getItems(sessionAId, {
      cursor: first!.cursor,
      limit: 2,
    })).resolves.toEqual(expect.objectContaining({
      items: [expect.objectContaining({ id: "message-3" })],
    }));
    await expect(repository.getDirectiveDetail(sessionAId, directive.id, {
      cursor: first!.cursor,
    })).resolves.toEqual(expect.objectContaining({ text: "secret" }));

    const currentList = await repository.list({});
    const sessionBId = currentList.sessions.find(
      (session) => session.title === "Session B changed-twice",
    )!.id;
    const sessionBPage = await repository.getItems(sessionBId, {});
    sessionAWithDetail = {
      ...sessionAWithDetail,
      session: { ...sessionAWithDetail.session, title: "Session A changed" },
    };
    sourceSignature = "session-a-changed";
    await repository.refresh();

    await expect(repository.getItems(sessionAId, {
      cursor: first!.cursor,
      limit: 2,
    })).resolves.toEqual(expect.objectContaining({
      session: expect.objectContaining({ title: "Session A changed" }),
    }));
    await expect(repository.getItems(sessionBId, {
      cursor: sessionBPage!.cursor,
      limit: 2,
    })).resolves.toEqual(expect.objectContaining({ items: [] }));
  });

  it("keeps a parent revision stable when source child enumeration order changes", async () => {
    let sourceSignature = "children-z-a";
    let childIds = ["child-z", "child-a"];
    const source: SessionSource = {
      ...staticSource("reordered-children", []),
      async refresh() {
        return {
          signature: sourceSignature,
          sessions: [
            sourceEntry(
              "parent",
              normalizedSession("parent", "Parent", null, []),
            ),
            ...childIds.map((childId) =>
              sourceEntry(
                childId,
                normalizedSession(childId, childId, null, []),
                "parent",
              )
            ),
          ],
          diagnostics: [],
        };
      },
    };
    const repository = new SessionReadService([source]);
    const firstList = await repository.list({});
    const parentId = firstList.sessions.find(
      (session) => session.title === "Parent",
    )!.id;
    const first = await repository.getSession(parentId);

    expect(first?.session.childIds).toEqual(
      [...first!.session.childIds].sort(),
    );

    sourceSignature = "children-a-z";
    childIds = [...childIds].reverse();
    await repository.refresh();
    const second = await repository.getSession(parentId);

    expect(second?.session.childIds).toEqual(first?.session.childIds);
  });

  it("returns every timeline event type in one unfiltered view", async () => {
    const { repository } = await fixtureRepository();
    const list = await repository.list({});
    const session = list.sessions.find((session) => session.title === "Synthetic trace")!;
    const page = await repository.getItems(session.id, {
      limit: 200,
    });
    expect(new Set(page?.items.map((item) => item.kind))).toEqual(new Set([
      "message",
      "directive",
      "tool",
      "token",
      "internal",
    ]));
    expect(page?.items.find((item) =>
      item.kind === "internal" && item.eventType === "reasoning"
    )).toEqual(
      expect.objectContaining({
        id: "internal-6",
        summary: "REASONING_SUMMARY_CANARY",
      }),
    );
  });

  it("accepts item pages up to 300 entries", async () => {
    const { repository } = await fixtureRepository();
    const list = await repository.list({});
    const session = list.sessions.find((session) => session.title === "Synthetic trace")!;
    await expect(repository.getItems(session.id, {
      limit: 300,
    }))
      .resolves.not.toBeNull();
    await expect(repository.getItems(session.id, {
      limit: 301,
    }))
      .rejects.toMatchObject({ code: "invalid_query" });
  });

  it("defaults timeline pages to 100 entries", async () => {
    const timeline: DomainTimelineRecord[] = Array.from(
      { length: 101 },
      (_, index) => ({
        kind: "message",
        id: `message-${index + 1}`,
        ordinal: index + 1,
        timestamp: "2026-07-28T00:00:00Z",
        role: "assistant",
        phase: "commentary",
        itemType: null,
        markdown: `Message ${index + 1}`,
      }),
    );
    const repository = new SessionReadService(
      [staticSource("timeline-default", [
        sourceEntry(
          "timeline-default",
          normalizedSession("timeline-default", "Timeline default", null, timeline),
        ),
      ])],
    );
    const session = (await repository.list({})).sessions[0]!;
    const page = await repository.getItems(session.id, {});

    expect(page?.items).toHaveLength(100);
    expect(page?.hasMore).toBe(true);
  });

  it("discovers an archived root created after repository startup", async () => {
    const home = await createTempDirectory("codex-late-archive-");
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(
      join(home, "sessions/rollout-active.jsonl"),
      '{"timestamp":"2026-07-28T10:00:00.000Z","type":"session_meta","payload":{"id":"active-session","title":"Active trace"}}\n',
    );
    const repository = await createCodexSessionReadService(home);
    expect((await repository.list({})).sessions).toHaveLength(1);

    await mkdir(join(home, "archived_sessions"), { recursive: true });
    await writeFile(
      join(home, "archived_sessions/rollout-archived.jsonl"),
      '{"timestamp":"2026-07-20T10:00:00.000Z","type":"session_meta","payload":{"id":"archived-session","title":"Late archive"}}\n',
    );
    await repository.refresh();

    const sessions = await repository.list({});
    expect(sessions.sessions).toHaveLength(2);
    expect(sessions.sessions.find(({ archived }) => archived)?.title).toBe("Late archive");
  });

  it("keeps a native Codex session identity stable when its rollout moves", async () => {
    const { home, repository } = await fixtureRepository();
    const before = await repository.list({});
    const session = before.sessions.find(
      (session) => session.title === "Synthetic trace",
    )!;
    const original = join(
      home,
      "sessions/2026/07/28/rollout-2026-07-28T10-00-00-basic-session.jsonl",
    );
    const archiveDirectory = join(home, "archived_sessions/reorganized");
    await mkdir(archiveDirectory, { recursive: true });
    await rename(original, join(archiveDirectory, "rollout-moved-basic-session.jsonl"));

    await repository.refresh();
    const after = await repository.list({});
    const moved = after.sessions.find(
      (session) => session.title === "Synthetic trace",
    )!;
    expect(moved.id).toBe(session.id);
    expect(moved.archived).toBe(true);
  });

  it("compares time filters as instants and rejects an inverted range", async () => {
    const { repository } = await fixtureRepository();
    const equivalentOffset = await repository.list({
      from: "2026-07-28T05:00:00-05:00",
      to: "2026-07-28T13:00:00Z",
    });
    expect(equivalentOffset.sessions.some(
      (session) => session.title === "Synthetic trace",
    )).toBe(true);

    await expect(repository.list({
      from: "2026-07-29T00:00:00Z",
      to: "2026-07-28T00:00:00Z",
    })).rejects.toMatchObject({ code: "invalid_query" });
  });

  it("defaults catalog pages to 100 entries and accepts up to 300", async () => {
    const entries = Array.from({ length: 305 }, (_, index) =>
      sourceEntry(
        `thread-${index}`,
        normalizedSession(
          `thread-${index}`,
          `Session ${String(index).padStart(3, "0")}`,
          "/synthetic/large-catalog",
          [],
          new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        ),
      )
    );
    const repository = new SessionReadService(
      [staticSource("large", entries)],
    );

    const first = await repository.list({});
    expect(first).toMatchObject({ total: 305 });
    expect(first.nextCursor).not.toBeNull();
    expect(first.sessions).toHaveLength(100);
    const second = await repository.list({
      cursor: first.nextCursor!,
      limit: 300,
    });
    expect(second).toMatchObject({ total: 305, nextCursor: null });
    expect(second.sessions).toHaveLength(205);
    expect(new Set([...first.sessions, ...second.sessions].map((session) => session.id)).size)
      .toBe(305);
    await expect(repository.list({ limit: 301 }))
      .rejects.toMatchObject({ code: "invalid_query" });
  });

  it("bounds a page of individually valid long messages by response bytes", async () => {
    const longText = "x".repeat(1_000_000);
    const timeline: DomainTimelineRecord[] = Array.from(
      { length: 10 },
      (_, index) => ({
        kind: "message",
        id: `message-${index + 1}`,
        ordinal: index + 1,
        timestamp: "2026-07-28T00:00:00Z",
        role: "assistant",
        phase: "commentary",
        itemType: null,
        markdown: longText,
      }),
    );
    const repository = new SessionReadService(
      [staticSource("long", [
        sourceEntry(
          "long-session",
          normalizedSession("long-session", "Long session", null, timeline),
        ),
      ])],
    );

    const list = await repository.list({});
    const page = await repository.getItems(list.sessions[0]!.id, {
      limit: 200,
    });
    expect(page?.hasMore).toBe(true);
    expect(page?.cursor).toEqual(expect.any(String));
    expect(Buffer.byteLength(JSON.stringify(page?.items), "utf8"))
      .toBeLessThanOrEqual(MAX_ITEM_PAGE_BYTES + 2);
  });
});

const TEST_ORIGIN = {
  sourceType: "test",
  sourceInstanceId: "test-source",
  agentName: "Test",
  agentVersion: null,
  formatVersion: null,
} as const;

function normalizedSession(
  id: string,
  title: string,
  cwd: string | null,
  timeline: readonly DomainTimelineRecord[],
  timestamp = "2026-01-01T00:00:00Z",
): NormalizedSession {
  return {
    session: {
      id,
      sourceId: id,
      origin: TEST_ORIGIN,
      title,
      cwd,
      createdAt: timestamp,
      updatedAt: timestamp,
      archived: false,
      parentId: null,
      childIds: [],
      agent: null,
      messageCount: timeline.filter((item) => item.kind === "message").length,
      toolCount: timeline.filter(
        (item) => item.kind === "tool" && item.stage === "call",
      ).length,
      warningCount: 0,
      diagnostics: [],
      itemCount: timeline.length,
    },
    timeline,
    toolDetails: new Map(),
    directiveDetails: new Map(),
  };
}

function sourceEntry(
  localId: string,
  normalized: NormalizedSession,
  parentNativeSessionId: string | null = null,
): SourceSessionEntry {
  return {
    localId,
    nativeSessionId: localId,
    parentNativeSessionId,
    origin: TEST_ORIGIN,
    normalized,
  };
}

function staticSource(
  key: string,
  sessions: readonly SourceSessionEntry[],
): SessionSource {
  return {
    descriptor: {
      sourceType: "test",
      instanceKey: key,
      sourceInstanceId: key,
      displayName: "Test",
    },
    async refresh() {
      return { signature: key, sessions, diagnostics: [] };
    },
  };
}
