import { ILogService } from '#/_base/log/log';
import { SESSION_INDEX_KEY, SESSION_INDEX_SCOPE } from '#/app/workspace/workspaceAlias';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IQueryStore, type WriteOp } from '#/persistence/interface/queryStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { PARENT_SESSION_ID_KEY, type SessionSummary } from './sessionIndex';
import {
  LEGACY_SESSION_INDEX_MANIFEST,
  PARENT_INDEX_NAME,
  SESSION_INDEX_MANIFEST,
  SESSION_SOURCE_ROOT_KEY,
  advanceSessionIndexRevision,
  legacySessionCollection,
  legacySessionCountersCollection,
  legacySessionSourcesCollection,
  legacySessionWorkspaceSourcesCollection,
  recencyColumn,
  sessionCollection,
  sessionCountersCollection,
  sessionSourcesCollection,
  sessionWorkspaceSourcesCollection,
  withRecencyField,
  type SessionSourceFingerprint,
  type SessionSourceRoot,
  type SessionWorkspaceCounts,
  type SessionWorkspaceSource,
} from './sessionIndexModel';
import {
  listSessionIds,
  listWorkspaceIds,
  mapBounded,
  readSessionSummaryResult,
  sessionStateFingerprint,
  summaryEquals,
} from './sessionIndexSource';

const WRITE_CHUNK = 500;
const DEFAULT_SCAN_CONCURRENCY = 16;
const SUMMARY_READ_CONCURRENCY = 8;
const LARGE_METADATA_BYTES = 524_288;
const SHARED_SCAN_REUSE_MS = 30_000;
const FINGERPRINT_REUSE_MS = 30 * 60_000;
const COOPERATIVE_YIELD_BUDGET_MS = 12;
const COOPERATIVE_SCAN_ITEMS = 16;
const scheduleImmediate = setImmediate;

function resolveScanConcurrency(): number {
  const raw = Number(process.env['KIKI_SESSION_INDEX_SCAN_CONCURRENCY']);
  if (Number.isInteger(raw) && raw >= 1 && raw <= 128) return raw;
  return DEFAULT_SCAN_CONCURRENCY;
}

function monotonicMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function createCooperativeYield(): (force?: boolean) => Promise<void> {
  let lastYieldAt = monotonicMs();
  return async (force = false) => {
    const now = monotonicMs();
    if (!force && now - lastYieldAt < COOPERATIVE_YIELD_BUDGET_MS) return;
    await new Promise<void>((resolve) => {
      scheduleImmediate(resolve);
    });
    lastYieldAt = monotonicMs();
  };
}

function isLargeFingerprint(fingerprint: SessionSourceFingerprint): boolean {
  return (
    fingerprint.directSize >= LARGE_METADATA_BYTES ||
    fingerprint.nestedSize >= LARGE_METADATA_BYTES
  );
}

function createLargeReadGate(
  maybeYield: (force?: boolean) => Promise<void>,
): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const run = async (): Promise<T> => {
      await maybeYield(true);
      try {
        return await operation();
      } finally {
        await maybeYield(true);
      }
    };
    const next = tail.then(run, run);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}

export interface SessionIndexProjectorDeps {
  readonly storage: IFileSystemStorageService;
  readonly docs: IAtomicDocumentStore;
  readonly queryStore: IQueryStore;
  readonly log: ILogService;
  readonly sessionsScope: string;
}

export interface ProjectionResult {
  readonly generation: number;
  readonly sessions: number;
}

export interface ReconcileResult {
  readonly sessions: number;
  readonly upserted: number;
  readonly removed: number;
  readonly inventoryRequired?: boolean;
}

export interface AuthoritativeScan {
  readonly summaries: SessionSummary[];
  readonly counts: Map<string, SessionWorkspaceCounts>;
  readonly fingerprints: Map<string, SessionSourceFingerprint>;
  readonly workspaceSources: Map<string, SessionWorkspaceSource>;
  readonly sourceMaxMtimeMs: number;
}

interface ScanSlot {
  readonly promise: Promise<AuthoritativeScan>;
  readonly reusableUntil: number;
  settled: boolean;
}

interface CachedFingerprint {
  readonly fingerprint: SessionSourceFingerprint;
  readonly summary?: SessionSummary;
  readonly summaryResolved?: boolean;
  readonly checkedAt: number;
  readonly sequence: number;
}

export class SessionIndexProjector {
  private scanSlot: ScanSlot | undefined;
  private readonly fingerprintCache = new Map<string, CachedFingerprint>();
  private readonly summaryFingerprintCache = new Map<
    string,
    { readonly fingerprint: SessionSourceFingerprint; readonly summary: SessionSummary }
  >();
  private fingerprintSequence = 0;
  private fingerprintGeneration: number | undefined;
  private fingerprintInvalidationEpoch = 0;
  private fullInvalidationEpoch = 0;
  private readonly keyInvalidationEpochs = new Map<string, number>();

  constructor(private readonly deps: SessionIndexProjectorDeps) {}

  cachedSummaryForFingerprint(
    workspaceId: string,
    sessionId: string,
    fingerprint: SessionSourceFingerprint,
  ): SessionSummary | undefined {
    const key = `${workspaceId}/${sessionId}`;
    const bySummary = this.summaryFingerprintCache.get(key);
    if (bySummary !== undefined && fingerprintEquals(bySummary.fingerprint, fingerprint)) {
      return bySummary.summary;
    }
    const cached = this.fingerprintCache.get(key);
    if (
      cached === undefined ||
      cached.summaryResolved !== true ||
      cached.summary === undefined ||
      !fingerprintEquals(cached.fingerprint, fingerprint)
    ) {
      return undefined;
    }
    return cached.summary;
  }

  rememberSummaryFingerprint(
    workspaceId: string,
    sessionId: string,
    fingerprint: SessionSourceFingerprint,
    summary: SessionSummary,
  ): void {
    const key = `${workspaceId}/${sessionId}`;
    this.summaryFingerprintCache.set(key, { fingerprint, summary });
  }

  invalidateFingerprint(workspaceId?: string, sessionId?: string): void {
    this.fingerprintInvalidationEpoch += 1;
    if (workspaceId === undefined || sessionId === undefined) {
      this.fingerprintCache.clear();
      this.summaryFingerprintCache.clear();
      this.fullInvalidationEpoch = this.fingerprintInvalidationEpoch;
      this.keyInvalidationEpochs.clear();
    } else {
      const key = `${workspaceId}/${sessionId}`;
      this.fingerprintCache.delete(key);
      this.summaryFingerprintCache.delete(key);
      this.keyInvalidationEpochs.set(key, this.fingerprintInvalidationEpoch);
    }
  }

  sharedScan(): Promise<AuthoritativeScan> {
    const slot = this.scanSlot;
    if (slot !== undefined && (!slot.settled || Date.now() < slot.reusableUntil)) {
      return slot.promise;
    }
    return this.startScan();
  }

  private startScan(): Promise<AuthoritativeScan> {
    const slot: ScanSlot = {
      promise: this.scanAuthoritative(),
      reusableUntil: Date.now() + SHARED_SCAN_REUSE_MS,
      settled: false,
    };
    const markSettled = (): void => {
      slot.settled = true;
    };
    void slot.promise.then(markSettled, markSettled);
    this.scanSlot = slot;
    return slot.promise;
  }

  async scan(options?: { fresh?: boolean }): Promise<AuthoritativeScan> {
    const scan = options?.fresh === true ? this.startScan() : this.sharedScan();
    try {
      return await scan;
    } finally {
      if (this.scanSlot?.promise === scan) this.scanSlot = undefined;
    }
  }

  async refreshScan(
    scan: AuthoritativeScan,
    changedSessions: readonly { readonly workspaceId: string; readonly id: string }[],
  ): Promise<{
    readonly scan: AuthoritativeScan;
    readonly failed: readonly { readonly workspaceId: string; readonly id: string }[];
  }> {
    if (changedSessions.length === 0) return { scan, failed: [] };
    const { storage, docs, sessionsScope, log } = this.deps;
    const summariesByKey = new Map<string, SessionSummary>();
    const workspacesBySessionId = new Map<string, Set<string>>();
    for (const summary of scan.summaries) {
      summariesByKey.set(`${summary.workspaceId}\0${summary.id}`, summary);
      let owners = workspacesBySessionId.get(summary.id);
      if (owners === undefined) {
        owners = new Set<string>();
        workspacesBySessionId.set(summary.id, owners);
      }
      owners.add(summary.workspaceId);
    }

    const targets = new Map<string, { readonly workspaceId: string; readonly id: string }>();
    for (const entry of changedSessions) {
      targets.set(`${entry.workspaceId}\0${entry.id}`, entry);
      const existingOwners = workspacesBySessionId.get(entry.id);
      if (existingOwners !== undefined) {
        for (const existingWorkspaceId of existingOwners) {
          if (existingWorkspaceId !== entry.workspaceId) {
            targets.set(`${existingWorkspaceId}\0${entry.id}`, {
              workspaceId: existingWorkspaceId,
              id: entry.id,
            });
          }
        }
      }
    }

    const maybeYield = createCooperativeYield();
    const runLargeRead = createLargeReadGate(maybeYield);
    let readCount = 0;
    const refreshed = await mapBounded([...targets.values()], SUMMARY_READ_CONCURRENCY, async ({ workspaceId, id }) => {
      const fingerprint = await sessionStateFingerprint(storage, sessionsScope, workspaceId, id, log);
      const result = isLargeFingerprint(fingerprint)
        ? await runLargeRead(() => readSessionSummaryResult(docs, sessionsScope, workspaceId, id, log, storage))
        : await readSessionSummaryResult(docs, sessionsScope, workspaceId, id, log, storage);
      readCount += 1;
      await maybeYield(readCount % COOPERATIVE_SCAN_ITEMS === 0);
      return { workspaceId, id, fingerprint, result };
    });

    const counts = new Map(scan.counts);
    const fingerprints = new Map(scan.fingerprints);
    const workspaceSources = new Map(scan.workspaceSources);
    const touchedWorkspaces = new Map<
      string,
      {
        readonly existed: boolean;
        readonly sessionIds: Set<string>;
        readonly activeSessionIds: Set<string>;
        readonly archivedSessionIds: Set<string>;
      }
    >();
    const ensureWorkspace = (workspaceId: string) => {
      let state = touchedWorkspaces.get(workspaceId);
      if (state === undefined) {
        const previous = workspaceSources.get(workspaceId);
        state = {
          existed: previous !== undefined,
          sessionIds: new Set(previous?.sessionIds ?? []),
          activeSessionIds: new Set(previous?.activeSessionIds ?? []),
          archivedSessionIds: new Set(previous?.archivedSessionIds ?? []),
        };
        touchedWorkspaces.set(workspaceId, state);
      }
      return state;
    };

    const failed: { readonly workspaceId: string; readonly id: string }[] = [];
    const foundIds = new Set<string>();
    let sourceMaxMtimeMs = scan.sourceMaxMtimeMs;

    for (const item of refreshed) {
      sourceMaxMtimeMs = Math.max(
        sourceMaxMtimeMs,
        item.fingerprint.directMtimeMs,
        item.fingerprint.nestedMtimeMs,
      );
      if (item.result.kind === 'error') {
        failed.push({ workspaceId: item.workspaceId, id: item.id });
        continue;
      }
      if (item.result.kind === 'found') {
        foundIds.add(item.id);
      }
    }

    for (const item of refreshed) {
      if (item.result.kind === 'error') continue;
      const key = `${item.workspaceId}\0${item.id}`;
      summariesByKey.delete(key);
      const owners = workspacesBySessionId.get(item.id);
      owners?.delete(item.workspaceId);
      const ws = ensureWorkspace(item.workspaceId);
      ws.activeSessionIds.delete(item.id);
      ws.archivedSessionIds.delete(item.id);
      if (item.result.kind === 'found') {
        summariesByKey.set(key, item.result.summary);
        let nextOwners = workspacesBySessionId.get(item.id);
        if (nextOwners === undefined) {
          nextOwners = new Set<string>();
          workspacesBySessionId.set(item.id, nextOwners);
        }
        nextOwners.add(item.workspaceId);
        fingerprints.set(item.id, item.fingerprint);
        ws.sessionIds.add(item.id);
        if (item.result.summary.archived) ws.archivedSessionIds.add(item.id);
        else ws.activeSessionIds.add(item.id);
      } else {
        ws.sessionIds.delete(item.id);
        if (!foundIds.has(item.id) && (owners?.size ?? 0) === 0) {
          fingerprints.delete(item.id);
        }
      }
    }

    for (const [workspaceId, ws] of touchedWorkspaces) {
      if (!ws.existed && ws.sessionIds.size === 0) continue;
      workspaceSources.set(workspaceId, {
        sessionIds: [...ws.sessionIds].toSorted(),
        activeSessionIds: [...ws.activeSessionIds].toSorted(),
        archivedSessionIds: [...ws.archivedSessionIds].toSorted(),
      });
      counts.set(workspaceId, {
        active: ws.activeSessionIds.size,
        archived: ws.archivedSessionIds.size,
      });
    }

    return {
      scan: {
        summaries: [...summariesByKey.values()],
        counts,
        fingerprints,
        workspaceSources,
        sourceMaxMtimeMs,
      },
      failed,
    };
  }

  async project(generation: number, scan: AuthoritativeScan): Promise<ProjectionResult> {
    const { queryStore, log } = this.deps;
    const { summaries, counts, fingerprints, workspaceSources, sourceMaxMtimeMs } = scan;
    const collection = sessionCollection(generation);
    const counters = sessionCountersCollection(generation);
    const sources = sessionSourcesCollection(generation);
    const workspaces = sessionWorkspaceSourcesCollection(generation);
    await advanceSessionIndexRevision(queryStore);
    await Promise.all([
      queryStore.dropCollection(collection),
      queryStore.dropCollection(counters),
      queryStore.dropCollection(sources),
      queryStore.dropCollection(workspaces),
    ]);
    await queryStore.ensureIndex(collection, {
      kind: 'value',
      name: PARENT_INDEX_NAME,
      field: `custom.${PARENT_SESSION_ID_KEY}`,
    });

    function* writes(): Generator<WriteOp> {
      for (const summary of summaries) {
        yield {
          kind: 'put', collection, key: summary.id,
          value: withRecencyField(generation, summary),
          columns: { [recencyColumn(generation)]: summary.updatedAt },
        };
      }
      for (const [sessionId, fingerprint] of fingerprints) {
        yield { kind: 'put', collection: sources, key: sessionId, value: fingerprint };
      }
      for (const [workspaceId, value] of workspaceSources) {
        yield { kind: 'put', collection: workspaces, key: workspaceId, value };
      }
      yield {
        kind: 'put', collection: workspaces, key: SESSION_SOURCE_ROOT_KEY,
        value: { workspaceIds: [...workspaceSources.keys()].toSorted() } satisfies SessionSourceRoot,
      };
      for (const [workspaceId, value] of counts) {
        yield { kind: 'put', collection: counters, key: workspaceId, value };
      }
    }
    await this.batchChunks(writes());
    await queryStore.setCheckpoint(SESSION_INDEX_MANIFEST, { seq: generation, sourceMaxMtimeMs });
    this.fingerprintGeneration = generation;
    this.fingerprintCache.clear();
    this.summaryFingerprintCache.clear();
    for (const summary of summaries) {
      const fingerprint = fingerprints.get(summary.id);
      if (fingerprint !== undefined) {
        this.summaryFingerprintCache.set(`${summary.workspaceId}/${summary.id}`, {
          fingerprint,
          summary,
        });
      }
    }
    log.info('session index generation published', { generation, sessions: summaries.length });
    const legacyManifest = await queryStore.getCheckpoint(LEGACY_SESSION_INDEX_MANIFEST);
    if (legacyManifest !== undefined) {
      try {
        await Promise.all([
          queryStore.dropCollection(legacySessionCollection(legacyManifest.seq)),
          queryStore.dropCollection(legacySessionCountersCollection(legacyManifest.seq)),
          queryStore.dropCollection(legacySessionSourcesCollection(legacyManifest.seq)),
          queryStore.dropCollection(legacySessionWorkspaceSourcesCollection(legacyManifest.seq)),
        ]);
      } catch (error) {
        log.warn('failed to drop legacy session index generation', {
          generation: legacyManifest.seq,
          error: String(error),
        });
      }
    }

    if (generation > 1) {
      const staleCollections = [
        sessionCollection(generation - 1),
        sessionCountersCollection(generation - 1),
        sessionSourcesCollection(generation - 1),
        sessionWorkspaceSourcesCollection(generation - 1),
      ];
      void Promise.all(staleCollections.map((name) => queryStore.dropCollection(name))).catch(
        (error) => {
          log.warn('failed to drop previous session index generation', {
            generation: generation - 1,
            error: String(error),
          });
        },
      );
    }
    return { generation, sessions: summaries.length };
  }

  async planReconcile(
    generation: number,
    options?: { reuseFingerprints?: boolean; changedSessions?: readonly { workspaceId: string; id: string }[] },
  ): Promise<(skip?: { readonly sessionIds?: ReadonlySet<string>; readonly workspaceIds?: ReadonlySet<string> }) => Promise<ReconcileResult>> {
    const { storage, docs, queryStore, log, sessionsScope } = this.deps;
    if (this.fingerprintGeneration !== generation) {
      this.fingerprintCache.clear();
      this.fingerprintGeneration = generation;
    }
    const changed = options?.changedSessions;
    const maybeYield = createCooperativeYield();
    const runLargeRead = createLargeReadGate(maybeYield);
    const nextFingerprintCache = new Map<string, CachedFingerprint>();
    const sequence = ++this.fingerprintSequence;
    const invalidationEpoch = this.fingerprintInvalidationEpoch;
    const checkedAt = Date.now();
    const collection = sessionCollection(generation);
    const counters = sessionCountersCollection(generation);
    const sources = sessionSourcesCollection(generation);
    const workspaces = sessionWorkspaceSourcesCollection(generation);
    const previousRoot = await queryStore.get<SessionSourceRoot>(workspaces, SESSION_SOURCE_ROOT_KEY);
    const previousWorkspaceIds = previousRoot?.workspaceIds ?? [];
    const currentWorkspaceIds = changed === undefined
      ? [...await listWorkspaceIds(storage, sessionsScope, log)].toSorted()
      : [...new Set(changed.map((entry) => entry.workspaceId))].toSorted();
    const currentWorkspaceSessions = new Map<string, readonly string[]>();
    const workspaceTouchedSessions = new Map<string, Set<string>>();
    const touchWorkspaceSessions = (workspaceId: string, ids: readonly string[]): void => {
      let bucket = workspaceTouchedSessions.get(workspaceId);
      if (bucket === undefined) {
        bucket = new Set<string>();
        workspaceTouchedSessions.set(workspaceId, bucket);
      }
      for (const sid of ids) bucket.add(sid);
    };
    const currentSessionOwners = new Map<string, number>();
    for (const workspaceId of currentWorkspaceIds) {
      await maybeYield();
      const sessionIds = changed === undefined
        ? [...await listSessionIds(storage, sessionsScope, workspaceId, log)].toSorted()
        : [...new Set([
          ...((await queryStore.get<SessionWorkspaceSource>(workspaces, workspaceId))?.sessionIds ?? []),
          ...changed.filter((entry) => entry.workspaceId === workspaceId).map((entry) => entry.id),
        ])].toSorted();
      currentWorkspaceSessions.set(workspaceId, sessionIds);
      touchWorkspaceSessions(workspaceId, sessionIds);
      for (const sessionId of sessionIds) {
        currentSessionOwners.set(sessionId, (currentSessionOwners.get(sessionId) ?? 0) + 1);
      }
    }
    const ops: WriteOp[] = [];
    const targetedChanges: {
      readonly workspaceId: string;
      readonly sessionId: string;
      readonly nextSummary: SessionSummary | undefined;
      readonly fingerprint: SessionSourceFingerprint | undefined;
    }[] = [];
    const targetedWorkspaceIds = new Set<string>();
    let upserted = 0;
    let removed = 0;
    let sessions = 0;
    let sourceMaxMtimeMs = (await storage.mtime(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY)) ?? 0;

    for (const workspaceId of currentWorkspaceIds) {
      await maybeYield();
      const sessionIds = currentWorkspaceSessions.get(workspaceId) ?? [];
      const previousWorkspace = await queryStore.get<SessionWorkspaceSource>(workspaces, workspaceId);
      const previousSessionIds = previousWorkspace?.sessionIds ?? [];
      const previousSessionSet = new Set(previousSessionIds);
      const candidates = changed === undefined ? sessionIds : changed.filter((entry) => entry.workspaceId === workspaceId).map((entry) => entry.id);
      const previousFingerprints = await queryStore.getMany<SessionSourceFingerprint>(sources, candidates);
      let fingerprintedCount = 0;
      const fingerprintBySession = new Map<string, SessionSourceFingerprint>();
      const fingerprintEntries = await mapBounded(candidates, resolveScanConcurrency(), async (sessionId) => {
        const key = `${workspaceId}/${sessionId}`;
        const cached = this.fingerprintCache.get(key);
        const reusable = options?.reuseFingerprints === true &&
          cached !== undefined && checkedAt - cached.checkedAt < FINGERPRINT_REUSE_MS &&
          previousSessionSet.has(sessionId) &&
          fingerprintEquals(previousFingerprints.get(sessionId), cached.fingerprint);
        const fingerprint = reusable
          ? cached.fingerprint
          : await sessionStateFingerprint(storage, sessionsScope, workspaceId, sessionId, log);
        const carrySummary =
          cached !== undefined &&
          cached.summaryResolved === true &&
          fingerprintEquals(cached.fingerprint, fingerprint);
        nextFingerprintCache.set(key, {
          fingerprint,
          summary: carrySummary ? cached.summary : undefined,
          summaryResolved: carrySummary ? true : undefined,
          checkedAt: reusable ? cached.checkedAt : checkedAt,
          sequence,
        });
        fingerprintBySession.set(sessionId, fingerprint);
        fingerprintedCount += 1;
        await maybeYield(fingerprintedCount % COOPERATIVE_SCAN_ITEMS === 0);
        return { sessionId, fingerprint };
      });
      const changedCandidates: string[] = [];
      for (const { sessionId, fingerprint } of fingerprintEntries) {
        await maybeYield();
        sourceMaxMtimeMs = Math.max(
          sourceMaxMtimeMs,
          fingerprint.directMtimeMs,
          fingerprint.nestedMtimeMs,
        );
        if (
          !previousSessionSet.has(sessionId) ||
          !fingerprintEquals(previousFingerprints.get(sessionId), fingerprint)
        ) {
          changedCandidates.push(sessionId);
        }
      }
      let summaryReadCount = 0;
      const changedResults = await mapBounded(
        changedCandidates,
        SUMMARY_READ_CONCURRENCY,
        async (sessionId) => {
          const key = `${workspaceId}/${sessionId}`;
          const fingerprint = fingerprintBySession.get(sessionId);
          const cached = this.fingerprintCache.get(key);
          if (
            options?.reuseFingerprints === true &&
            fingerprint !== undefined &&
            cached !== undefined &&
            cached.summaryResolved === true &&
            checkedAt - cached.checkedAt < FINGERPRINT_REUSE_MS &&
            fingerprintEquals(cached.fingerprint, fingerprint)
          ) {
            summaryReadCount += 1;
            await maybeYield(summaryReadCount % COOPERATIVE_SCAN_ITEMS === 0);
            return {
              sessionId,
              result:
                cached.summary !== undefined
                  ? ({ kind: 'found', summary: cached.summary } as const)
                  : ({ kind: 'missing' } as const),
            };
          }
          const result =
            fingerprint !== undefined && isLargeFingerprint(fingerprint)
              ? await runLargeRead(() =>
                  readSessionSummaryResult(docs, sessionsScope, workspaceId, sessionId, log, storage),
                )
              : await readSessionSummaryResult(docs, sessionsScope, workspaceId, sessionId, log, storage);
          summaryReadCount += 1;
          await maybeYield(summaryReadCount % COOPERATIVE_SCAN_ITEMS === 0);
          return { sessionId, result };
        },
      );
      const changedIds: string[] = [];
      const nextSummaries = new Map<string, SessionSummary>();
      for (const entry of changedResults) {
        await maybeYield();
        const key = `${workspaceId}/${entry.sessionId}`;
        if (entry.result.kind === 'error') {
          if (changed !== undefined) throw entry.result.error;
          nextFingerprintCache.delete(key);
          continue;
        }
        changedIds.push(entry.sessionId);
        const existingCache = nextFingerprintCache.get(key);
        if (entry.result.kind === 'found') {
          nextSummaries.set(entry.sessionId, entry.result.summary);
          if (existingCache !== undefined) {
            nextFingerprintCache.set(key, {
              ...existingCache,
              summary: entry.result.summary,
              summaryResolved: true,
            });
          }
        } else if (existingCache !== undefined) {
          nextFingerprintCache.set(key, {
            ...existingCache,
            summary: undefined,
            summaryResolved: true,
          });
        }
      }
      const changedSet = new Set(changedIds);
      const currentSet = new Set(sessionIds);
      const departedIds = previousSessionIds.filter((sessionId) => !currentSet.has(sessionId));
      touchWorkspaceSessions(workspaceId, departedIds);
      const removedIds = departedIds.filter(
        (sessionId) => (currentSessionOwners.get(sessionId) ?? 0) === 0,
      );
      const removedSet = new Set(removedIds);
      if (changed !== undefined) {
        if (changedIds.length > 0) targetedWorkspaceIds.add(workspaceId);
        for (const sessionId of changedIds) {
          targetedChanges.push({
            workspaceId,
            sessionId,
            nextSummary: nextSummaries.get(sessionId),
            fingerprint: fingerprintBySession.get(sessionId),
          });
        }
        continue;
      }
      const affectedIds = [...new Set([...changedIds, ...departedIds])];
      const oldSummaries =
        affectedIds.length === 0
          ? new Map<string, SessionSummary>()
          : await queryStore.getMany<SessionSummary>(collection, affectedIds);
      const activeSessionIds = new Set(previousWorkspace?.activeSessionIds ?? []);
      const archivedSessionIds = new Set(previousWorkspace?.archivedSessionIds ?? []);
      for (const sessionId of departedIds) {
        activeSessionIds.delete(sessionId);
        archivedSessionIds.delete(sessionId);
      }
      for (const sessionId of changedIds) {
        activeSessionIds.delete(sessionId);
        archivedSessionIds.delete(sessionId);
        const summary = nextSummaries.get(sessionId);
        if (summary?.archived === true) archivedSessionIds.add(sessionId);
        else if (summary !== undefined) activeSessionIds.add(sessionId);
      }
      for (const sessionId of affectedIds) {
        await maybeYield();
        const oldSummary = oldSummaries.get(sessionId);
        const nextSummary = nextSummaries.get(sessionId);
        if (nextSummary === undefined) {
          const owners = currentSessionOwners.get(sessionId) ?? 0;
          if (oldSummary !== undefined && (removedSet.has(sessionId) || owners <= 1 && changedSet.has(sessionId))) {
            ops.push({ kind: 'delete', collection, key: sessionId });
            removed += 1;
          }
        } else if (oldSummary === undefined || !summaryEquals(oldSummary, nextSummary)) {
          ops.push({
            kind: 'put',
            collection,
            key: sessionId,
            value: withRecencyField(generation, nextSummary),
            columns: { [recencyColumn(generation)]: nextSummary.updatedAt },
          });
          upserted += 1;
        }
      }
      for (const { sessionId, fingerprint } of fingerprintEntries) {
        await maybeYield();
        if (changedSet.has(sessionId)) {
          ops.push({ kind: 'put', collection: sources, key: sessionId, value: fingerprint });
        }
      }
      for (const sessionId of removedIds) {
        ops.push({ kind: 'delete', collection: sources, key: sessionId });
      }
      const nextWorkspace: SessionWorkspaceSource = {
        sessionIds,
        activeSessionIds: [...activeSessionIds].toSorted(),
        archivedSessionIds: [...archivedSessionIds].toSorted(),
      };
      if (!workspaceSourceEquals(previousWorkspace, nextWorkspace)) {
        ops.push({ kind: 'put', collection: workspaces, key: workspaceId, value: nextWorkspace });
      }
      const currentCount = await queryStore.get<SessionWorkspaceCounts>(counters, workspaceId);
      const count = {
        active: nextWorkspace.activeSessionIds.length,
        archived: nextWorkspace.archivedSessionIds.length,
      };
      if (
        currentCount === undefined ||
        currentCount.active !== count.active ||
        currentCount.archived !== count.archived
      ) {
        ops.push({ kind: 'put', collection: counters, key: workspaceId, value: count });
      }
      sessions += count.active + count.archived;
    }

    const currentWorkspaceSet = new Set(currentWorkspaceIds);
    for (const workspaceId of changed === undefined ? previousWorkspaceIds : []) {
      await maybeYield();
      if (currentWorkspaceSet.has(workspaceId)) continue;
      const previousWorkspace = await queryStore.get<SessionWorkspaceSource>(workspaces, workspaceId);
      const removedIds = (previousWorkspace?.sessionIds ?? []).filter(
        (sessionId) => (currentSessionOwners.get(sessionId) ?? 0) === 0,
      );
      touchWorkspaceSessions(workspaceId, previousWorkspace?.sessionIds ?? []);
      const oldSummaries =
        removedIds.length === 0
          ? new Map<string, SessionSummary>()
          : await queryStore.getMany<SessionSummary>(collection, removedIds);
      for (const sessionId of removedIds) {
        if (oldSummaries.has(sessionId)) {
          ops.push({ kind: 'delete', collection, key: sessionId });
          removed += 1;
        }
        ops.push({ kind: 'delete', collection: sources, key: sessionId });
      }
      ops.push({ kind: 'delete', collection: counters, key: workspaceId });
      ops.push({ kind: 'delete', collection: workspaces, key: workspaceId });
    }
    if (changed === undefined && !sameStrings(previousWorkspaceIds, currentWorkspaceIds)) {
      ops.push({
        kind: 'put',
        collection: workspaces,
        key: SESSION_SOURCE_ROOT_KEY,
        value: { workspaceIds: currentWorkspaceIds } satisfies SessionSourceRoot,
      });
    }

    const retainFingerprints = (
      skipSessionIds?: ReadonlySet<string>,
      skipWorkspaceIds?: ReadonlySet<string>,
    ): void => {
      if (this.fingerprintGeneration !== generation || this.fullInvalidationEpoch > invalidationEpoch) return;
      for (const [key, entry] of nextFingerprintCache) {
        if (skipSessionIds !== undefined || skipWorkspaceIds !== undefined) {
          const slash = key.indexOf('/');
          const workspaceId = slash >= 0 ? key.slice(0, slash) : undefined;
          const sessionId = slash >= 0 ? key.slice(slash + 1) : key;
          if (skipSessionIds?.has(sessionId) || (workspaceId !== undefined && skipWorkspaceIds?.has(workspaceId))) continue;
        }
        if ((this.keyInvalidationEpochs.get(key) ?? 0) > invalidationEpoch) continue;
        if ((this.fingerprintCache.get(key)?.sequence ?? 0) > sequence) continue;
        this.fingerprintCache.set(key, entry);
      }
      if (changed === undefined) {
        for (const [key, entry] of this.fingerprintCache) {
          if (entry.sequence <= sequence && !nextFingerprintCache.has(key)) this.fingerprintCache.delete(key);
        }
      }
    };
    retainFingerprints();
    return async (skip?: { readonly sessionIds?: ReadonlySet<string>; readonly workspaceIds?: ReadonlySet<string> }) => {
      const skipWorkspaceIds = skip?.workspaceIds;
      const effectiveSkipSessionIds = new Set<string>(skip?.sessionIds ?? []);
      if (skipWorkspaceIds !== undefined && skipWorkspaceIds.size > 0) {
        for (const workspaceId of skipWorkspaceIds) {
          const wsSessionIds = workspaceTouchedSessions.get(workspaceId);
          if (wsSessionIds !== undefined) {
            for (const sid of wsSessionIds) effectiveSkipSessionIds.add(sid);
          }
          for (const key of this.fingerprintCache.keys()) {
            if (key.startsWith(`${workspaceId}/`)) this.fingerprintCache.delete(key);
          }
        }
      }
      const commitOps: WriteOp[] = [...ops];
      let commitUpserted = upserted;
      let commitRemoved = removed;
      if (changed !== undefined && targetedChanges.length > 0) {
        const targetedIds = [...new Set(targetedChanges.map((entry) => entry.sessionId))];
        const committedSummaries = await queryStore.getMany<SessionSummary>(collection, targetedIds);
        const wsIds = [...targetedWorkspaceIds].toSorted();
        const committedWorkspaces = await queryStore.getMany<SessionWorkspaceSource>(workspaces, wsIds);
        const workspaceStates = new Map<
          string,
          {
            readonly previous: SessionWorkspaceSource | undefined;
            readonly sessionIds: Set<string>;
            readonly activeSessionIds: Set<string>;
            readonly archivedSessionIds: Set<string>;
          }
        >();
        for (const workspaceId of wsIds) {
          const previous = committedWorkspaces.get(workspaceId);
          workspaceStates.set(workspaceId, {
            previous,
            sessionIds: new Set(previous?.sessionIds ?? []),
            activeSessionIds: new Set(previous?.activeSessionIds ?? []),
            archivedSessionIds: new Set(previous?.archivedSessionIds ?? []),
          });
        }
        const deltaByWorkspace = new Map<string, { active: number; archived: number }>();
        const bump = (workspaceId: string, field: 'active' | 'archived', by: number): void => {
          const entry = deltaByWorkspace.get(workspaceId) ?? { active: 0, archived: 0 };
          entry[field] += by;
          deltaByWorkspace.set(workspaceId, entry);
        };
        for (const entry of targetedChanges) {
          const committed = committedSummaries.get(entry.sessionId);
          if (committed !== undefined && committed.workspaceId !== entry.workspaceId) {
            return { sessions: 0, upserted: 0, removed: 0, inventoryRequired: true };
          }
          const wsState = workspaceStates.get(entry.workspaceId)!;
          if (entry.nextSummary === undefined) {
            if (committed !== undefined) {
              commitOps.push({ kind: 'delete', collection, key: entry.sessionId });
              commitOps.push({ kind: 'delete', collection: sources, key: entry.sessionId });
              commitRemoved += 1;
              bump(entry.workspaceId, committed.archived ? 'archived' : 'active', -1);
            }
            wsState.sessionIds.delete(entry.sessionId);
            wsState.activeSessionIds.delete(entry.sessionId);
            wsState.archivedSessionIds.delete(entry.sessionId);
          } else {
            if (committed === undefined) {
              bump(entry.workspaceId, entry.nextSummary.archived ? 'archived' : 'active', 1);
            } else if (committed.archived !== entry.nextSummary.archived) {
              bump(entry.workspaceId, committed.archived ? 'archived' : 'active', -1);
              bump(entry.workspaceId, entry.nextSummary.archived ? 'archived' : 'active', 1);
            }
            if (committed === undefined || !summaryEquals(committed, entry.nextSummary)) {
              commitOps.push({
                kind: 'put',
                collection,
                key: entry.sessionId,
                value: withRecencyField(generation, entry.nextSummary),
                columns: { [recencyColumn(generation)]: entry.nextSummary.updatedAt },
              });
              commitUpserted += 1;
            }
            if (entry.fingerprint !== undefined) {
              commitOps.push({ kind: 'put', collection: sources, key: entry.sessionId, value: entry.fingerprint });
            }
            wsState.sessionIds.add(entry.sessionId);
            wsState.activeSessionIds.delete(entry.sessionId);
            wsState.archivedSessionIds.delete(entry.sessionId);
            if (entry.nextSummary.archived) wsState.archivedSessionIds.add(entry.sessionId);
            else wsState.activeSessionIds.add(entry.sessionId);
          }
        }
        for (const [workspaceId, wsState] of workspaceStates) {
          const nextWorkspace: SessionWorkspaceSource = {
            sessionIds: [...wsState.sessionIds].toSorted(),
            activeSessionIds: [...wsState.activeSessionIds].toSorted(),
            archivedSessionIds: [...wsState.archivedSessionIds].toSorted(),
          };
          if (!workspaceSourceEquals(wsState.previous, nextWorkspace)) {
            commitOps.push({ kind: 'put', collection: workspaces, key: workspaceId, value: nextWorkspace });
          }
        }
        const nonZeroDeltaWorkspaces = [...deltaByWorkspace.entries()].filter(
          ([, delta]) => delta.active !== 0 || delta.archived !== 0,
        );
        if (nonZeroDeltaWorkspaces.length > 0) {
          const freshCounts = await queryStore.getMany<SessionWorkspaceCounts>(
            counters,
            nonZeroDeltaWorkspaces.map(([workspaceId]) => workspaceId),
          );
          for (const [workspaceId, delta] of nonZeroDeltaWorkspaces) {
            const base = freshCounts.get(workspaceId) ?? { active: 0, archived: 0 };
            const nextCount: SessionWorkspaceCounts = {
              active: Math.max(0, base.active + delta.active),
              archived: Math.max(0, base.archived + delta.archived),
            };
            commitOps.push({ kind: 'put', collection: counters, key: workspaceId, value: nextCount });
          }
        }
        const freshRoot = await queryStore.get<SessionSourceRoot>(workspaces, SESSION_SOURCE_ROOT_KEY);
        const freshRootIds = freshRoot?.workspaceIds ?? [];
        const mergedRootIds = [...new Set([...freshRootIds, ...wsIds])].toSorted();
        if (!sameStrings(freshRootIds, mergedRootIds)) {
          commitOps.push({
            kind: 'put',
            collection: workspaces,
            key: SESSION_SOURCE_ROOT_KEY,
            value: { workspaceIds: mergedRootIds } satisfies SessionSourceRoot,
          });
        }
      }
      const filteredOps =
        effectiveSkipSessionIds.size === 0 &&
        (skipWorkspaceIds === undefined || skipWorkspaceIds.size === 0)
          ? commitOps
          : commitOps.filter((op) => {
              if ((op.collection === collection || op.collection === sources) && effectiveSkipSessionIds.has(op.key)) {
                return false;
              }
              if ((op.collection === workspaces || op.collection === counters) && skipWorkspaceIds?.has(op.key)) {
                return false;
              }
              return true;
            });
      if (filteredOps.length > 0) await advanceSessionIndexRevision(queryStore);
      await this.batchChunks(filteredOps);
      const manifest = await queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
      if (
        manifest?.seq === generation &&
        sourceMaxMtimeMs > (manifest.sourceMaxMtimeMs ?? 0)
      ) {
        await queryStore.setCheckpoint(SESSION_INDEX_MANIFEST, {
          seq: generation,
          sourceMaxMtimeMs,
        });
      }
      retainFingerprints(effectiveSkipSessionIds, skipWorkspaceIds);
      const result = { sessions, upserted: commitUpserted, removed: commitRemoved };
      if (commitUpserted > 0 || commitRemoved > 0) {
        log.info('session index reconciliation repaired drift', { generation, ...result });
      }
      return result;
    };
  }

  private async scanAuthoritative(): Promise<AuthoritativeScan> {
    const { storage, docs, sessionsScope, log } = this.deps;
    const summaries: SessionSummary[] = [];
    const counts = new Map<string, SessionWorkspaceCounts>();
    const fingerprints = new Map<string, SessionSourceFingerprint>();
    const workspaceSources = new Map<string, SessionWorkspaceSource>();
    let sourceMaxMtimeMs = (await storage.mtime(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY)) ?? 0;
    const maybeYield = createCooperativeYield();
    const runLargeRead = createLargeReadGate(maybeYield);
    let scannedCount = 0;
    for (const workspaceId of await listWorkspaceIds(storage, sessionsScope, log)) {
      const sessionIds = [
        ...await listSessionIds(storage, sessionsScope, workspaceId, log),
      ].toSorted();
      const fingerprinted = await mapBounded(sessionIds, resolveScanConcurrency(), async (sessionId) => {
        const fingerprint = await sessionStateFingerprint(
          storage,
          sessionsScope,
          workspaceId,
          sessionId,
          log,
        );
        scannedCount += 1;
        await maybeYield(scannedCount % COOPERATIVE_SCAN_ITEMS === 0);
        return { sessionId, fingerprint };
      });
      let summaryReadCount = 0;
      const found = await mapBounded(
        fingerprinted,
        SUMMARY_READ_CONCURRENCY,
        async ({ sessionId, fingerprint }) => {
          const result = isLargeFingerprint(fingerprint)
            ? await runLargeRead(() =>
                readSessionSummaryResult(docs, sessionsScope, workspaceId, sessionId, log, storage),
              )
            : await readSessionSummaryResult(docs, sessionsScope, workspaceId, sessionId, log, storage);
          summaryReadCount += 1;
          await maybeYield(summaryReadCount % COOPERATIVE_SCAN_ITEMS === 0);
          return { sessionId, fingerprint, result };
        },
      );
      const activeSessionIds: string[] = [];
      const archivedSessionIds: string[] = [];
      for (const item of found) {
        await maybeYield();
        sourceMaxMtimeMs = Math.max(
          sourceMaxMtimeMs,
          item.fingerprint.directMtimeMs,
          item.fingerprint.nestedMtimeMs,
        );
        if (item.result.kind === 'error') continue;
        fingerprints.set(item.sessionId, item.fingerprint);
        if (item.result.kind === 'missing') continue;
        summaries.push(item.result.summary);
        if (item.result.summary.archived) archivedSessionIds.push(item.sessionId);
        else activeSessionIds.push(item.sessionId);
      }
      counts.set(workspaceId, {
        active: activeSessionIds.length,
        archived: archivedSessionIds.length,
      });
      workspaceSources.set(workspaceId, { sessionIds, activeSessionIds, archivedSessionIds });
    }
    return { summaries, counts, fingerprints, workspaceSources, sourceMaxMtimeMs };
  }

  private async batchChunks(ops: Iterable<WriteOp>): Promise<void> {
    const maybeYield = createCooperativeYield();
    let chunk: WriteOp[] = [];
    for (const op of ops) {
      chunk.push(op);
      if ((chunk.length & 15) === 0) await maybeYield();
      if (chunk.length === WRITE_CHUNK) {
        await this.deps.queryStore.batch(chunk);
        chunk = [];
        await maybeYield(true);
      }
    }
    if (chunk.length > 0) await this.deps.queryStore.batch(chunk);
  }
}

export function fingerprintEquals(
  left: SessionSourceFingerprint | undefined,
  right: SessionSourceFingerprint,
): boolean {
  return left?.directMtimeMs === right.directMtimeMs &&
    left.directSize === right.directSize &&
    left.nestedMtimeMs === right.nestedMtimeMs &&
    left.nestedSize === right.nestedSize;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function workspaceSourceEquals(
  left: SessionWorkspaceSource | undefined,
  right: SessionWorkspaceSource,
): boolean {
  return left !== undefined &&
    sameStrings(left.sessionIds, right.sessionIds) &&
    sameStrings(left.activeSessionIds ?? [], right.activeSessionIds) &&
    sameStrings(left.archivedSessionIds ?? [], right.archivedSessionIds);
}
