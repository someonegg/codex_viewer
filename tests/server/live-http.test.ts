import { writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveRevision, TimelineCursor } from "../../src/shared/api-contract.js";
import type { SessionDetail } from "../../src/shared/domain.js";
import { LOOPBACK_HOST, type ServerConfig } from "../../src/server/config.js";
import { createApiRouter } from "../../src/server/http/api-router.js";
import { createServer } from "../../src/server/http/create-server.js";
import { SessionLiveService } from "../../src/server/live/session-live-service.js";
import type { SessionReader } from "../../src/server/application/session-reader.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

const SESSION_ID = "abcdefghijklmnopqrstuvwx";
const CURSOR = "opaque.timeline.cursor" as TimelineCursor;
const REVISION = "a".repeat(43) as LiveRevision;
const OTHER_REVISION = "b".repeat(43) as LiveRevision;
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  })));
});

describe("Live update HTTP API", () => {
  it("closes the injected Live service when the API router closes", () => {
    const unavailable = async () => null;
    const sessions = {
      list: vi.fn(),
      getSession: unavailable,
      getItems: unavailable,
      getLiveSession: unavailable,
      getToolDetail: unavailable,
      getDirectiveDetail: unavailable,
      getInteractionSession: unavailable,
      refresh: vi.fn(),
    } satisfies SessionReader;
    const live = new SessionLiveService(sessions);
    const close = vi.spyOn(live, "close");

    createApiRouter({ sessions, live }).close?.();

    expect(close).toHaveBeenCalledOnce();
  });

  it("returns 200, 204, 400, and 404 with no-store semantics", async () => {
    const getLiveSession = vi.fn<SessionReader["getLiveSession"]>()
      .mockResolvedValue(snapshot(false));
    const { base } = await start(getLiveSession, { waitTimeoutMs: 12, probeIntervalMs: 4 });
    const changed = await fetch(url(base, OTHER_REVISION));
    expect(changed.status).toBe(200);
    expect(changed.headers.get("cache-control")).toBe("no-store");
    expect(await changed.json()).toEqual(expect.objectContaining({
      cursor: CURSOR,
      hasMore: false,
      liveRevision: REVISION,
    }));

    expect((await fetch(url(base, REVISION))).status).toBe(204);
    expect((await fetch(`${base}/api/v1/sessions/${SESSION_ID}/live?after=${REVISION}`)).status)
      .toBe(400);
    expect((await fetch(`${base}/api/v1/sessions/${SESSION_ID}/live?cursor=x&after=bad`)).status)
      .toBe(400);
    getLiveSession.mockResolvedValue(null);
    expect((await fetch(url(base, OTHER_REVISION))).status).toBe(404);
  });

  it("returns 429 at capacity and releases the slot when the client disconnects", async () => {
    const getLiveSession = vi.fn<SessionReader["getLiveSession"]>()
      .mockResolvedValue(snapshot(false));
    const { base } = await start(getLiveSession, {
      waitTimeoutMs: 5_000,
      probeIntervalMs: 1_000,
      maxWaiters: 1,
      maxWaitersPerSession: 1,
    });
    const abort = new AbortController();
    const pending = fetch(url(base, REVISION), { signal: abort.signal });
    await vi.waitFor(() => expect(getLiveSession).toHaveBeenCalled());
    const limited = await fetch(url(base, REVISION));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("2");
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    getLiveSession.mockResolvedValue(snapshot(true));
    await vi.waitFor(async () => {
      const recovered = await fetch(url(base, REVISION));
      expect(recovered.status).toBe(200);
    });
  });
});

async function start(
  getLiveSession: SessionReader["getLiveSession"],
  options: ConstructorParameters<typeof SessionLiveService>[1],
) {
  const clientDirectory = await createTempDirectory("codex-live-http-");
  await writeFile(join(clientDirectory, "index.html"), "viewer");
  const unavailable = async () => null;
  const repository = {
    list: vi.fn(),
    getSession: unavailable,
    getItems: unavailable,
    getLiveSession,
    getToolDetail: unavailable,
    getDirectiveDetail: unavailable,
    getInteractionSession: unavailable,
    refresh: vi.fn(),
  } satisfies SessionReader;
  const live = new SessionLiveService(repository, {
    createRevision: () => REVISION,
    ...options,
  });
  const config: ServerConfig = {
    host: LOOPBACK_HOST,
    port: 0,
    codexHome: "/unused",
    clientDirectory,
    tls: { enabled: false },
    interactionEnabled: false,
  };
  const server = createServer(
    config,
    createApiRouter({ sessions: repository, live }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK_HOST, resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://${LOOPBACK_HOST}:${port}` };
}

function url(base: string, after: LiveRevision): string {
  return `${base}/api/v1/sessions/${SESSION_ID}/live?cursor=${encodeURIComponent(CURSOR)}&after=${after}`;
}

function snapshot(hasMore: boolean) {
  return {
    session: SESSION,
    cursor: CURSOR,
    hasMore,
    interactionSession: { archived: false, interaction: null },
  };
}

const SESSION: SessionDetail = {
  id: SESSION_ID,
  origin: {
    sourceType: "test",
    sourceInstanceId: "test",
    agentName: "Test",
    agentVersion: null,
    formatVersion: null,
  },
  title: "Session",
  nickname: null,
  cwd: null,
  createdAt: null,
  updatedAt: null,
  archived: false,
  parentId: null,
  childIds: [],
  agent: null,
  messageCount: 0,
  toolCount: 0,
  warningCount: 0,
  sourceId: "session",
  diagnostics: [],
  itemCount: 0,
};
