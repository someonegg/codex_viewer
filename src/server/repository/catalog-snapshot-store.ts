import type {
  DomainDiagnostic,
  DomainSessionId,
  NormalizedSession,
} from "../domain/session-domain.js";
import {
  encodeStringTuple,
  opaqueIdForParts,
} from "../security/opaque-id.js";
import type {
  SessionSource,
  SessionSourceDescriptor,
  SessionSourceSnapshot,
  SourceSessionEntry,
} from "../source/session-source.js";
import { RefreshCoordinator } from "./refresh-coordinator.js";
import {
  TimelinePrefixRegistry,
  type TimelinePrefixIndexBuilder,
  type IndexedSession,
} from "./timeline-prefix-registry.js";

export const DEFAULT_CATALOG_FRESHNESS_MS = 1_500;
export const MAX_CATALOG_DIAGNOSTICS = 50;

export interface CatalogSnapshot {
  readonly signature: string;
  readonly diagnostics: readonly DomainDiagnostic[];
  readonly sessions: ReadonlyMap<DomainSessionId, IndexedSession>;
  readonly orderedIds: readonly DomainSessionId[];
}

export interface CatalogSnapshotStoreDependencies {
  readonly timelinePrefixIndexBuilder?: TimelinePrefixIndexBuilder;
}

export class CatalogSnapshotStore {
  readonly #coordinator = new RefreshCoordinator<CatalogSnapshot>();
  readonly #prefixes: TimelinePrefixRegistry;
  readonly #sources: readonly SessionSource[];
  #snapshot: CatalogSnapshot | null = null;
  #aggregate: AggregateState | null = null;
  #lastDiscoveryAt = Number.NEGATIVE_INFINITY;

  constructor(
    sources: readonly SessionSource[],
    private readonly freshnessMs = DEFAULT_CATALOG_FRESHNESS_MS,
    private readonly now: () => number = performance.now.bind(performance),
    dependencies: CatalogSnapshotStoreDependencies = {},
  ) {
    assertUniqueSources(sources);
    this.#sources = [...sources];
    this.#prefixes = new TimelinePrefixRegistry(
      dependencies.timelinePrefixIndexBuilder,
    );
  }

  async current(): Promise<CatalogSnapshot> {
    const snapshot = this.#snapshot;
    if (snapshot !== null && this.now() - this.#lastDiscoveryAt < this.freshnessMs) {
      return snapshot;
    }
    return this.#coordinator.run(() => this.#discover());
  }

  async refresh(): Promise<CatalogSnapshot> {
    return this.#coordinator.run(() => this.#discover());
  }

  async #discover(): Promise<CatalogSnapshot> {
    const snapshot = await this.#rebuild();
    this.#lastDiscoveryAt = this.now();
    return snapshot;
  }

  async #rebuild(): Promise<CatalogSnapshot> {
    const loadedSources = await Promise.all(
      this.#sources.map(async (source) => ({
        descriptor: source.descriptor,
        snapshot: await source.refresh(),
      })),
    );
    const signature = aggregateSignature(loadedSources);
    const previous = this.#snapshot;
    if (previous?.signature === signature) return previous;

    const sourceDiagnostics: DomainDiagnostic[] = [];
    for (const { snapshot } of loadedSources) {
      if (sourceDiagnostics.length >= MAX_CATALOG_DIAGNOSTICS) break;
      for (const item of snapshot.diagnostics) {
        if (sourceDiagnostics.length >= MAX_CATALOG_DIAGNOSTICS) break;
        sourceDiagnostics.push({ ...item });
      }
    }
    const linked = linkRelationships(
      loadedSources,
      this.#aggregate,
      MAX_CATALOG_DIAGNOSTICS - sourceDiagnostics.length,
    );
    const diagnostics = [...sourceDiagnostics, ...linked.diagnostics];
    const normalizedSessions = linked.sessions;
    const orderedIds = [...normalizedSessions.values()]
      .sort(compareSessions)
      .map((session) => session.session.id);
    const preparedPrefixes = this.#prefixes.prepare(
      normalizedSessions,
      linked.dirtyIds,
    );
    const snapshot: CatalogSnapshot = {
      signature,
      diagnostics,
      sessions: preparedPrefixes.sessions,
      orderedIds,
    };
    preparedPrefixes.commit();
    this.#aggregate = {
      inputs: linked.inputs,
      nativeBuckets: linked.nativeBuckets,
      parentNativeDependents: linked.parentNativeDependents,
      resolvedParents: linked.resolvedParents,
      sessions: normalizedSessions,
    };
    this.#snapshot = snapshot;
    return snapshot;
  }
}

interface LoadedSource {
  readonly descriptor: SessionSourceDescriptor;
  readonly snapshot: SessionSourceSnapshot;
}

interface PendingSession {
  readonly descriptor: SessionSourceDescriptor;
  readonly id: DomainSessionId;
  readonly nativeSessionId: string | null;
  readonly parentNativeSessionId: string | null;
  readonly origin: SourceSessionEntry["origin"];
  readonly normalized: NormalizedSession;
}

interface AggregateState {
  readonly inputs: ReadonlyMap<DomainSessionId, PendingSession>;
  readonly nativeBuckets: ReadonlyMap<string, readonly DomainSessionId[]>;
  readonly parentNativeDependents: ReadonlyMap<
    string,
    ReadonlySet<DomainSessionId>
  >;
  readonly resolvedParents: ReadonlyMap<DomainSessionId, DomainSessionId | null>;
  readonly sessions: ReadonlyMap<DomainSessionId, NormalizedSession>;
}

interface LinkedSessions {
  readonly sessions: Map<DomainSessionId, NormalizedSession>;
  readonly diagnostics: readonly DomainDiagnostic[];
  readonly dirtyIds: ReadonlySet<DomainSessionId>;
  readonly inputs: ReadonlyMap<DomainSessionId, PendingSession>;
  readonly nativeBuckets: ReadonlyMap<string, readonly DomainSessionId[]>;
  readonly parentNativeDependents: ReadonlyMap<
    string,
    ReadonlySet<DomainSessionId>
  >;
  readonly resolvedParents: ReadonlyMap<DomainSessionId, DomainSessionId | null>;
}

function assertUniqueSources(sources: readonly SessionSource[]): void {
  const keys = new Set<string>();
  for (const source of sources) {
    const key = source.descriptor.instanceKey;
    if (keys.has(key)) {
      throw new Error(`Duplicate session source instance key: ${key}`);
    }
    keys.add(key);
  }
}

function aggregateSignature(sources: readonly LoadedSource[]): string {
  return JSON.stringify(
    [...sources]
      .sort((left, right) =>
        left.descriptor.instanceKey.localeCompare(
          right.descriptor.instanceKey,
        )
      )
      .map(({ descriptor, snapshot }) => ({
        source: descriptor.instanceKey,
        signature: snapshot.signature,
      })),
  );
}

function linkRelationships(
  sources: readonly LoadedSource[],
  previous: AggregateState | null,
  diagnosticLimit: number,
): LinkedSessions {
  const diagnostics: DomainDiagnostic[] = [];
  const inputs = new Map<DomainSessionId, PendingSession>();
  const nativeBuckets = new Map<string, DomainSessionId[]>();
  const parentNativeDependents = new Map<string, Set<DomainSessionId>>();
  for (const { descriptor, snapshot } of sources) {
    const localIds = new Set<string>();
    for (const entry of snapshot.sessions) {
      if (localIds.has(entry.localId)) {
        if (diagnostics.length < diagnosticLimit) {
          diagnostics.push({
            code: "duplicate_source_session_id",
            severity: "error",
            message: "A source returned duplicate stable session identities.",
            ordinal: null,
          });
        }
        continue;
      }
      localIds.add(entry.localId);
      const id = opaqueIdForParts(descriptor.instanceKey, entry.localId);
      const input: PendingSession = {
        descriptor,
        id,
        nativeSessionId: entry.nativeSessionId,
        parentNativeSessionId: entry.parentNativeSessionId,
        origin: entry.origin,
        normalized: entry.normalized,
      };
      inputs.set(id, input);
      if (entry.nativeSessionId !== null) {
        const nativeKey = identityKey(
          descriptor.instanceKey,
          entry.nativeSessionId,
        );
        const bucket = nativeBuckets.get(nativeKey);
        if (bucket === undefined) nativeBuckets.set(nativeKey, [id]);
        else bucket.push(id);
      }
      if (entry.parentNativeSessionId !== null) {
        const parentKey = identityKey(
          descriptor.instanceKey,
          entry.parentNativeSessionId,
        );
        const dependents = parentNativeDependents.get(parentKey);
        if (dependents === undefined) {
          parentNativeDependents.set(parentKey, new Set([id]));
        } else {
          dependents.add(id);
        }
      }
    }
  }

  const resolvedParents = new Map<DomainSessionId, DomainSessionId | null>();
  const children = new Map<DomainSessionId, DomainSessionId[]>();
  for (const item of inputs.values()) {
    const parentId = item.parentNativeSessionId === null
      ? null
      : uniqueIdentity(
        nativeBuckets.get(
          identityKey(
            item.descriptor.instanceKey,
            item.parentNativeSessionId,
          ),
        ),
      );
    resolvedParents.set(item.id, parentId);
    if (parentId !== null) {
      const childIds = children.get(parentId);
      if (childIds === undefined) children.set(parentId, [item.id]);
      else childIds.push(item.id);
    }
  }

  const dirtyIds = findDirtyIds(
    inputs,
    nativeBuckets,
    parentNativeDependents,
    resolvedParents,
    previous,
  );
  const sessions = new Map<DomainSessionId, NormalizedSession>();
  for (const [id, item] of inputs) {
    const cached = previous?.sessions.get(id);
    if (cached !== undefined && !dirtyIds.has(id)) {
      sessions.set(id, cached);
      continue;
    }
    const source = item.normalized.session;
    sessions.set(id, {
      session: {
        ...source,
        id,
        sourceId: item.nativeSessionId,
        origin: {
          ...item.origin,
          sourceType: item.descriptor.sourceType,
          sourceInstanceId: item.descriptor.sourceInstanceId,
          agentName: item.descriptor.displayName,
        },
        parentId: resolvedParents.get(id) ?? null,
        childIds: [...(children.get(id) ?? [])].sort(compareCodeUnits),
      },
      timeline: item.normalized.timeline,
      toolDetails: item.normalized.toolDetails,
      directiveDetails: item.normalized.directiveDetails,
      internalDetails: item.normalized.internalDetails,
      interaction: item.normalized.interaction ?? null,
    });
  }
  return {
    sessions,
    diagnostics,
    dirtyIds,
    inputs,
    nativeBuckets,
    parentNativeDependents,
    resolvedParents,
  };
}

function findDirtyIds(
  inputs: ReadonlyMap<DomainSessionId, PendingSession>,
  nativeBuckets: ReadonlyMap<string, readonly DomainSessionId[]>,
  parentNativeDependents: ReadonlyMap<
    string,
    ReadonlySet<DomainSessionId>
  >,
  resolvedParents: ReadonlyMap<DomainSessionId, DomainSessionId | null>,
  previous: AggregateState | null,
): Set<DomainSessionId> {
  const dirty = new Set<DomainSessionId>();
  if (previous === null) {
    for (const id of inputs.keys()) dirty.add(id);
    return dirty;
  }

  for (const [id, input] of inputs) {
    const oldInput = previous.inputs.get(id);
    // SourceSessionEntry wrappers may be rebuilt on every refresh. The Codex
    // adapter reuses unchanged immutable NormalizedSession objects, so identity
    // is only a safe optimization hint: a new object means "recompute", never
    // that the public revision must change. The final-view digest decides that.
    if (oldInput === undefined || !sameSourceInput(oldInput, input)) {
      dirty.add(id);
    }
    const oldParent = previous.resolvedParents.get(id) ?? null;
    const newParent = resolvedParents.get(id) ?? null;
    if (oldInput === undefined || oldParent !== newParent) {
      dirty.add(id);
      if (oldParent !== null && inputs.has(oldParent)) dirty.add(oldParent);
      if (newParent !== null) dirty.add(newParent);
    }
  }
  for (const [id] of previous.inputs) {
    if (inputs.has(id)) continue;
    const oldParent = previous.resolvedParents.get(id) ?? null;
    if (oldParent !== null && inputs.has(oldParent)) dirty.add(oldParent);
  }

  const identityKeys = new Set([
    ...previous.nativeBuckets.keys(),
    ...nativeBuckets.keys(),
  ]);
  for (const key of identityKeys) {
    if (
      uniqueIdentity(previous.nativeBuckets.get(key)) ===
        uniqueIdentity(nativeBuckets.get(key))
    ) {
      continue;
    }
    const dependents = new Set([
      ...(previous.parentNativeDependents.get(key) ?? []),
      ...(parentNativeDependents.get(key) ?? []),
    ]);
    for (const id of dependents) {
      if (!inputs.has(id)) continue;
      dirty.add(id);
      const oldParent = previous.resolvedParents.get(id) ?? null;
      const newParent = resolvedParents.get(id) ?? null;
      if (oldParent !== null && inputs.has(oldParent)) dirty.add(oldParent);
      if (newParent !== null) dirty.add(newParent);
    }
  }
  return dirty;
}

function sameSourceInput(
  left: PendingSession,
  right: PendingSession,
): boolean {
  return left.normalized === right.normalized &&
    left.nativeSessionId === right.nativeSessionId &&
    left.parentNativeSessionId === right.parentNativeSessionId &&
    sameOrigin(left.origin, right.origin) &&
    left.descriptor.sourceType === right.descriptor.sourceType &&
    left.descriptor.sourceInstanceId === right.descriptor.sourceInstanceId &&
    left.descriptor.displayName === right.descriptor.displayName;
}

function sameOrigin(
  left: SourceSessionEntry["origin"],
  right: SourceSessionEntry["origin"],
): boolean {
  return left.sourceType === right.sourceType &&
    left.sourceInstanceId === right.sourceInstanceId &&
    left.agentName === right.agentName &&
    left.agentVersion === right.agentVersion &&
    left.formatVersion === right.formatVersion;
}

function uniqueIdentity(
  bucket: readonly DomainSessionId[] | undefined,
): DomainSessionId | null {
  return bucket?.length === 1 ? bucket[0]! : null;
}

function identityKey(sourceKey: string, nativeId: string): string {
  return encodeStringTuple(sourceKey, nativeId);
}

function compareSessions(left: NormalizedSession, right: NormalizedSession): number {
  return (right.session.updatedAt ?? right.session.createdAt ?? "")
    .localeCompare(left.session.updatedAt ?? left.session.createdAt ?? "") ||
    left.session.title.localeCompare(right.session.title) ||
    compareCodeUnits(left.session.id, right.session.id);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
