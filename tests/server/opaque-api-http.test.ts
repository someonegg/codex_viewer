import { cp, readFile, rename, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOOPBACK_HOST, type ServerConfig } from "../../src/server/config.js";
import { createCodexSessionReadService } from "../../src/server/create-session-read-service.js";
import { createApiRouter } from "../../src/server/http/api-router.js";
import { createServer } from "../../src/server/http/create-server.js";
import { SessionLiveService } from "../../src/server/live/session-live-service.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((done) => server.close(() => done()))));
});

async function startApi(existingHome?: string) {
  const home = existingHome ?? await createTempDirectory("codex-opaque-api-");
  if (existingHome === undefined) {
    await cp(resolve("tests/fixtures/codex-home"), home, { recursive: true });
  }
  const clientDirectory = await createTempDirectory("codex-opaque-client-");
  await Promise.all([
    writeFile(join(clientDirectory, "index.html"), "<h1>sessions</h1>"),
    writeFile(join(clientDirectory, "session.html"), "<h1>session reader</h1>"),
  ]);
  const repository = await createCodexSessionReadService(home);
  const config: ServerConfig = {
    host: LOOPBACK_HOST,
    port: 0,
    codexHome: home,
    clientDirectory,
    tls: { enabled: false },
    interactionEnabled: false,
  };
  const live = new SessionLiveService(repository, {
      probeIntervalMs: 5,
      waitTimeoutMs: 15,
  });
  const server = createServer(
    config,
    createApiRouter({ sessions: repository, live }),
  );
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, LOOPBACK_HOST, done));
  const { port } = server.address() as AddressInfo;
  return { base: `http://${LOOPBACK_HOST}:${port}`, home, repository };
}

describe("opaque cursor API", () => {
  it("serves internal JSON only from its cursor-bound detail endpoint", async () => {
    const { base } = await startApi();
    const list = await fetch(`${base}/api/v1/sessions`).then((response) => response.json());
    const sessionId = list.sessions.find(
      (session: { title: string }) => session.title === "Synthetic trace",
    ).id;
    const page = await fetch(`${base}/api/v1/sessions/${sessionId}/items?limit=300`)
      .then((response) => response.json());
    expect(JSON.stringify(page)).not.toContain("REASONING_CANARY_NEVER_RENDER");

    const detail = await fetch(
      `${base}/api/v1/sessions/${sessionId}/items/internal-6/internal?cursor=${encodeURIComponent(page.cursor)}`,
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      itemId: "internal-6",
      json: expect.stringContaining("REASONING_CANARY_NEVER_RENDER"),
      truncated: false,
    });
    const wrongKind = await fetch(
      `${base}/api/v1/sessions/${sessionId}/items/directive-4/internal?cursor=${encodeURIComponent(page.cursor)}`,
    );
    expect(wrongKind.status).toBe(404);
    expect(await wrongKind.json()).toMatchObject({ error: { code: "internal_not_found" } });
  });

  it("classifies structurally valid cursors from another service instance as recoverable", async () => {
    const firstServer = await startApi();
    const list = await fetch(`${firstServer.base}/api/v1/sessions?limit=1`)
      .then((response) => response.json());
    const sessionId = list.sessions[0].id;
    const page = await fetch(
      `${firstServer.base}/api/v1/sessions/${sessionId}/items?limit=1`,
    ).then((response) => response.json());
    const confirmed = await fetch(
      `${firstServer.base}/api/v1/sessions/${sessionId}/items?limit=300`,
    ).then((response) => response.json());

    const restarted = await startApi(firstServer.home);
    const staleList = await fetch(
      `${restarted.base}/api/v1/sessions?limit=1&cursor=${encodeURIComponent(list.nextCursor)}`,
    );
    expect(staleList.status).toBe(409);
    expect(await staleList.json()).toMatchObject({
      error: { code: "stale_list_cursor" },
    });

    const staleTimeline = await fetch(
      `${restarted.base}/api/v1/sessions/${sessionId}/items?cursor=${encodeURIComponent(page.cursor)}`,
    );
    expect(staleTimeline.status).toBe(409);
    expect(await staleTimeline.json()).toMatchObject({
      error: { code: "timeline_changed" },
    });
    const staleDetail = await fetch(
      `${restarted.base}/api/v1/sessions/${sessionId}/items/directive-4/directive?cursor=${encodeURIComponent(confirmed.cursor)}`,
    );
    expect(staleDetail.status).toBe(409);
    expect(await staleDetail.json()).toMatchObject({
      error: { code: "timeline_changed" },
    });

    expect((await fetch(
      `${restarted.base}/api/v1/sessions?cursor=not-a-cursor`,
    )).status).toBe(400);
    expect((await fetch(
      `${restarted.base}/api/v1/sessions/${sessionId}/items?cursor=not-a-cursor`,
    )).status).toBe(400);
  });

  it("pages lists with a filter-bound cursor and rejects a stale list", async () => {
    const { base, home } = await startApi();
    const head = await fetch(
      `${base}/api/v1/sessions?limit=1`,
      { method: "HEAD" },
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toEqual(expect.any(String));
    expect(await head.text()).toBe("");
    const first = await fetch(`${base}/api/v1/sessions?limit=1`)
      .then((response) => response.json());
    expect(first).toEqual(expect.objectContaining({
      total: 4,
      nextCursor: expect.any(String),
    }));
    expect(Object.keys(first).sort()).toEqual([
      "diagnostics",
      "nextCursor",
      "projects",
      "sessions",
      "total",
    ]);
    expect(first.sessions[0]).toEqual(expect.objectContaining({ id: expect.any(String) }));
    expect(first.sessions[0]).not.toHaveProperty("session");
    const second = await fetch(
      `${base}/api/v1/sessions?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
    ).then((response) => response.json());
    expect(second.sessions[0].id).not.toBe(first.sessions[0].id);

    const wrongFilters = await fetch(
      `${base}/api/v1/sessions?project=${encodeURIComponent("/wrong")}&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    expect(wrongFilters.status).toBe(400);

    const rollout = join(
      home,
      "sessions/2026/07/28/rollout-2026-07-28T10-00-00-basic-session.jsonl",
    );
    await writeFile(
      rollout,
      `${await readFile(rollout, "utf8")}{"timestamp":"2026-08-01T00:00:00Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"new tail"}]}}\n`,
    );
    await fetch(`${base}/api/v1/sessions?limit=1&fresh=true`);
    const stale = await fetch(
      `${base}/api/v1/sessions?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "stale_list_cursor" } });
    expect((await fetch(`${base}/api/v1/sessions?fresh=true&cursor=x`)).status).toBe(400);
  });

  it("opens through items, keeps an empty incremental cursor stable, and bounds lazy detail", async () => {
    const { base, home } = await startApi();
    await writeFile(
      join(home, "session_index.jsonl"),
      `${JSON.stringify({ id: "basic-session", thread_name: "Current nickname" })}\n`,
    );
    const list = await fetch(`${base}/api/v1/sessions?fresh=true`)
      .then((response) => response.json());
    const sessionId = list.sessions.find(
      (session: { title: string }) => session.title === "Synthetic trace",
    ).id;
    expect(list.sessions.find((session: { id: string }) => session.id === sessionId))
      .toMatchObject({ title: "Synthetic trace", nickname: "Current nickname" });

    const metadata = await fetch(`${base}/api/v1/sessions/${sessionId}`)
      .then((response) => response.json());
    expect(metadata.session.title).toBe("Synthetic trace");
    expect(metadata.session.nickname).toBe("Current nickname");
    expect(metadata).not.toHaveProperty("revisionSession");

    const first = await fetch(`${base}/api/v1/sessions/${sessionId}/items?limit=1`)
      .then((response) => response.json());
    expect(first).toEqual(expect.objectContaining({
      session: expect.objectContaining({
        title: "Synthetic trace",
        nickname: "Current nickname",
      }),
      interaction: { supported: false },
      items: expect.any(Array),
      cursor: expect.any(String),
      hasMore: true,
      liveRevision: expect.any(String),
    }));
    expect(first).not.toHaveProperty("revisionSession");
    const unconfirmed = await fetch(
      `${base}/api/v1/sessions/${sessionId}/items/directive-4/directive?cursor=${encodeURIComponent(first.cursor)}`,
    );
    expect(unconfirmed.status).toBe(400);

    const rest = await fetch(
      `${base}/api/v1/sessions/${sessionId}/items?limit=300&cursor=${encodeURIComponent(first.cursor)}`,
    ).then((response) => response.json());
    const tail = rest.hasMore
      ? await fetch(`${base}/api/v1/sessions/${sessionId}/items?limit=300&cursor=${encodeURIComponent(rest.cursor)}`)
          .then((response) => response.json())
      : rest;
    const empty = await fetch(
      `${base}/api/v1/sessions/${sessionId}/items?cursor=${encodeURIComponent(tail.cursor)}`,
    ).then((response) => response.json());
    expect(empty.items).toEqual([]);
    expect(empty.cursor).toBe(tail.cursor);

    const detail = await fetch(
      `${base}/api/v1/sessions/${sessionId}/items/directive-4/directive?cursor=${encodeURIComponent(tail.cursor)}`,
    ).then((response) => response.json());
    expect(detail).toEqual({
      itemId: "directive-4",
      text: expect.stringContaining("DIRECTIVE_DETAIL_CANARY"),
      truncated: false,
    });
  });

  it("long-polls without advancing the timeline cursor and detects appended backlog", async () => {
    const { base, home, repository } = await startApi();
    const list = await fetch(`${base}/api/v1/sessions`).then((response) => response.json());
    const sessionId = list.sessions.find(
      (session: { title: string }) => session.title === "Synthetic trace",
    ).id;
    const page = await fetch(`${base}/api/v1/sessions/${sessionId}/items?limit=300`)
      .then((response) => response.json());
    const query = `cursor=${encodeURIComponent(page.cursor)}&after=${encodeURIComponent(page.liveRevision)}`;

    const unchanged = await fetch(`${base}/api/v1/sessions/${sessionId}/live?${query}`);
    expect(unchanged.status).toBe(204);
    expect(unchanged.headers.get("cache-control")).toBe("no-store");

    const rollout = join(
      home,
      "sessions/2026/07/28/rollout-2026-07-28T10-00-00-basic-session.jsonl",
    );
    await writeFile(
      rollout,
      `${await readFile(rollout, "utf8")}{"timestamp":"2026-08-01T00:00:00Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"live append"}]}}\n`,
    );
    await repository.refresh();
    const changed = await fetch(`${base}/api/v1/sessions/${sessionId}/live?${query}`);
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual(expect.objectContaining({
      cursor: page.cursor,
      hasMore: true,
      liveRevision: expect.not.stringMatching(page.liveRevision),
    }));

    expect((await fetch(
      `${base}/api/v1/sessions/${sessionId}/live?cursor=bad&after=${"a".repeat(43)}`,
    )).status).toBe(400);
    expect((await fetch(
      `${base}/api/v1/sessions/${sessionId}/live?cursor=${encodeURIComponent(page.cursor)}&after=bad`,
    )).status).toBe(400);
  });

  it("accepts append-only continuation and reports timeline_changed after replacement", async () => {
    const { base, home, repository } = await startApi();
    const list = await fetch(`${base}/api/v1/sessions`)
      .then((response) => response.json());
    const sessionId = list.sessions.find(
      (session: { title: string }) => session.title === "Synthetic trace",
    ).id;
    const page = await fetch(`${base}/api/v1/sessions/${sessionId}/items?limit=2`)
      .then((response) => response.json());
    const rollout = join(
      home,
      "sessions/2026/07/28/rollout-2026-07-28T10-00-00-basic-session.jsonl",
    );
    await writeFile(
      rollout,
      `${await readFile(rollout, "utf8")}{"timestamp":"2026-08-01T00:00:00Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"append"}]}}\n`,
    );
    await repository.refresh();
    expect((await fetch(
      `${base}/api/v1/sessions/${sessionId}/items?limit=2&cursor=${encodeURIComponent(page.cursor)}`,
    )).status).toBe(200);

    const replacement = `${rollout}.replacement`;
    await writeFile(
      replacement,
      '{"timestamp":"2026-08-01T01:00:00Z","type":"session_meta","payload":{"id":"basic-session","title":"Replacement"}}\n' +
        '{"timestamp":"2026-08-01T01:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"replacement"}]}}\n',
    );
    await rename(replacement, rollout);
    await repository.refresh();
    const changed = await fetch(
      `${base}/api/v1/sessions/${sessionId}/items?cursor=${encodeURIComponent(page.cursor)}`,
    );
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: { code: "timeline_changed" } });
    const liveChanged = await fetch(
      `${base}/api/v1/sessions/${sessionId}/live?cursor=${encodeURIComponent(page.cursor)}&after=${encodeURIComponent(page.liveRevision)}`,
    );
    expect(liveChanged.status).toBe(409);
    expect(await liveChanged.json()).toMatchObject({ error: { code: "timeline_changed" } });
  });
});
