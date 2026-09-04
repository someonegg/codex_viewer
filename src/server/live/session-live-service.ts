import type {
  InteractionResponse,
  SessionLiveQuery,
  SessionLiveResponse,
} from "../../shared/api-contract.js";
import type {
  InteractionSessionSnapshot,
  SessionReader,
} from "../application/session-reader.js";
import type { SessionInteractionService } from "../interaction/interaction-service.js";
import {
  createProcessLiveRevisionFactory,
  type LiveRevisionFactory,
  type LiveRevisionSession,
  withLiveRevision,
} from "./live-revision.js";

export const LIVE_PROBE_INTERVAL_MS = 1_500;
export const LIVE_WAIT_TIMEOUT_MS = 25_000;
export const LIVE_INTERACTION_CACHE_MS = 1_500;
export const MAX_LIVE_WAITERS = 100;
export const MAX_LIVE_WAITERS_PER_SESSION = 10;

export class SessionLiveError extends Error {
  constructor(
    readonly code: "session_not_found" | "live_capacity_exceeded",
    message: string,
  ) {
    super(message);
    this.name = "SessionLiveError";
  }
}

export interface SessionLiveServiceOptions {
  readonly interaction?: Pick<SessionInteractionService, "describeSnapshot">;
  readonly createRevision?: LiveRevisionFactory;
  readonly probeIntervalMs?: number;
  readonly waitTimeoutMs?: number;
  readonly interactionCacheMs?: number;
  readonly maxWaiters?: number;
  readonly maxWaitersPerSession?: number;
  readonly now?: () => number;
}

interface InteractionCacheEntry {
  readonly input: InteractionSessionSnapshot;
  expiresAt: number;
  readonly result: Promise<InteractionResponse>;
}

interface WaiterEntry {
  readonly sessionId: string;
  readonly externalSignal?: AbortSignal;
  readonly externalAbort: () => void;
}

type LiveSessionReader = Pick<
  SessionReader,
  "getLiveSession" | "getInteractionSession"
>;

export class SessionLiveService {
  readonly #createRevision: LiveRevisionFactory;
  readonly #probeIntervalMs: number;
  readonly #waitTimeoutMs: number;
  readonly #interactionCacheMs: number;
  readonly #maxWaiters: number;
  readonly #maxWaitersPerSession: number;
  readonly #now: () => number;
  readonly #waiters = new Map<AbortController, WaiterEntry>();
  readonly #waitersBySession = new Map<string, number>();
  readonly #interactionCache = new Map<string, InteractionCacheEntry>();
  #closed = false;

  constructor(
    private readonly sessions: LiveSessionReader,
    private readonly options: SessionLiveServiceOptions = {},
  ) {
    this.#createRevision = options.createRevision ?? createProcessLiveRevisionFactory();
    this.#probeIntervalMs = options.probeIntervalMs ?? LIVE_PROBE_INTERVAL_MS;
    this.#waitTimeoutMs = options.waitTimeoutMs ?? LIVE_WAIT_TIMEOUT_MS;
    this.#interactionCacheMs = options.interactionCacheMs ?? LIVE_INTERACTION_CACHE_MS;
    this.#maxWaiters = options.maxWaiters ?? MAX_LIVE_WAITERS;
    this.#maxWaitersPerSession = options.maxWaitersPerSession ?? MAX_LIVE_WAITERS_PER_SESSION;
    this.#now = options.now ?? Date.now;
  }

  revision(session: LiveRevisionSession, interaction: InteractionResponse) {
    return this.#createRevision(session, interaction);
  }

  async describe(sessionId: string): Promise<InteractionResponse> {
    const input = await this.sessions.getInteractionSession(sessionId);
    return input === null ? { supported: false } : this.#describeInteraction(sessionId, input);
  }

  async wait(
    sessionId: string,
    query: SessionLiveQuery,
    signal?: AbortSignal,
  ): Promise<SessionLiveResponse | null> {
    this.#throwIfAborted(signal);
    const initial = await this.#probe(sessionId, query);
    if (initial.liveRevision !== query.after || initial.hasMore) return initial;
    if (initial.session.archived) return null;
    const waiter = this.#acquire(sessionId, signal);
    const deadline = this.#now() + this.#waitTimeoutMs;
    try {
      while (true) {
        const remaining = deadline - this.#now();
        if (remaining <= 0) return null;
        await delay(Math.min(this.#probeIntervalMs, remaining), waiter.signal);
        const current = await this.#probe(sessionId, query);
        if (current.liveRevision !== query.after || current.hasMore) return current;
      }
    } finally {
      this.#release(waiter);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.keys()) waiter.abort();
    this.#interactionCache.clear();
  }

  async #probe(sessionId: string, query: SessionLiveQuery): Promise<SessionLiveResponse> {
    this.#throwIfAborted();
    const snapshot = await this.sessions.getLiveSession(sessionId, query.cursor);
    if (snapshot === null) {
      throw new SessionLiveError("session_not_found", "Session not found");
    }
    const interaction = await this.#describeInteraction(sessionId, snapshot.interactionSession);
    return withLiveRevision({
      session: snapshot.session,
      cursor: snapshot.cursor,
      hasMore: snapshot.hasMore,
      interaction,
    }, this.#createRevision);
  }

  #describeInteraction(
    sessionId: string,
    input: InteractionSessionSnapshot,
  ): Promise<InteractionResponse> {
    if (this.options.interaction === undefined) return Promise.resolve({ supported: false });
    const cached = this.#interactionCache.get(sessionId);
    const now = this.#now();
    if (cached !== undefined && cached.expiresAt > now && sameInput(cached.input, input)) {
      return cached.result;
    }
    const result = this.options.interaction.describeSnapshot(sessionId, input)
      .then((value) => value ?? { supported: false as const });
    const entry = { input, expiresAt: Number.POSITIVE_INFINITY, result };
    this.#interactionCache.set(sessionId, entry);
    void result.then(
      () => { entry.expiresAt = this.#now() + this.#interactionCacheMs; },
      () => {
        if (this.#interactionCache.get(sessionId) === entry) this.#interactionCache.delete(sessionId);
      },
    );
    return result;
  }

  #acquire(sessionId: string, signal?: AbortSignal): AbortController {
    this.#throwIfAborted(signal);
    const sessionCount = this.#waitersBySession.get(sessionId) ?? 0;
    if (this.#waiters.size >= this.#maxWaiters || sessionCount >= this.#maxWaitersPerSession) {
      throw new SessionLiveError(
        "live_capacity_exceeded",
        "Too many Live update requests are already waiting",
      );
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort(signal.reason);
    this.#waiters.set(controller, {
      sessionId,
      externalSignal: signal,
      externalAbort: abort,
    });
    this.#waitersBySession.set(sessionId, sessionCount + 1);
    return controller;
  }

  #release(controller: AbortController): void {
    const entry = this.#waiters.get(controller);
    if (entry === undefined) return;
    this.#waiters.delete(controller);
    const { sessionId } = entry;
    const count = (this.#waitersBySession.get(sessionId) ?? 1) - 1;
    if (count === 0) this.#waitersBySession.delete(sessionId);
    else this.#waitersBySession.set(sessionId, count);
    entry.externalSignal?.removeEventListener("abort", entry.externalAbort);
  }

  #throwIfAborted(signal?: AbortSignal): void {
    if (this.#closed || signal?.aborted) throw abortError();
  }
}

function sameInput(left: InteractionSessionSnapshot, right: InteractionSessionSnapshot): boolean {
  return left.archived === right.archived &&
    JSON.stringify(left.interaction) === JSON.stringify(right.interaction);
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(abortError());
    };
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}
