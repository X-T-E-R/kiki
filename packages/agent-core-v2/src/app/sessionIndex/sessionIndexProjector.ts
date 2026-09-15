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
  legacySessionCollection,
  legacySessionCountersCollection,
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
  readSessionSummary,
  readSessionSummaryResult,
  sessionStateFingerprint,
  summaryEquals,
} from './sessionIndexSource';

const WRITE_CHUNK = 500;
const SCAN_CONCURRENCY = 16;
const SHARED_SCAN_REUSE_MS = 30_000;

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

export class SessionIndexProjector {
  private scanSlot: ScanSlot | undefined;

  constructor(private readonly deps: SessionIndexProjectorDeps) {}

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

  async project(generation: number, scan: AuthoritativeScan): Promise<ProjectionResult> {
    const { queryStore, log } = this.deps;
    const { summaries, counts, fingerprints, workspaceSources, sourceMaxMtimeMs } = scan;
    const collection = sessionCollection(generation);
    const counters = sessionCountersCollection(generation);
    const sources = sessionSourcesCollection(generation);
    const workspaces = sessionWorkspaceSourcesCollection(generation);
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

    const ops: WriteOp[] = summaries.map((summary) => ({
      kind: 'put',
      collection,
      key: summary.id,
      value: withRecencyField(generation, summary),
      columns: { [recencyColumn(generation)]: summary.updatedAt },
    }));
    for (const [sessionId, fingerprint] of fingerprints) {
      ops.push({ kind: 'put', collection: sources, key: sessionId, value: fingerprint });
    }
    for (const [workspaceId, value] of workspaceSources) {
      ops.push({ kind: 'put', collection: workspaces, key: workspaceId, value });
    }
    ops.push({
      kind: 'put',
      collection: workspaces,
      key: SESSION_SOURCE_ROOT_KEY,
      value: { workspaceIds: [...workspaceSources.keys()].toSorted() } satisfies SessionSourceRoot,
    });
    for (const [workspaceId, value] of counts) {
      ops.push({ kind: 'put', collection: counters, key: workspaceId, value });
    }
    await this.batchChunks(ops);
    await queryStore.setCheckpoint(SESSION_INDEX_MANIFEST, { seq: generation, sourceMaxMtimeMs });
    log.info('session index generation published', { generation, sessions: summaries.length });
    const legacyManifest = await queryStore.getCheckpoint(LEGACY_SESSION_INDEX_MANIFEST);
    if (legacyManifest !== undefined) {
      try {
        await Promise.all([
          queryStore.dropCollection(legacySessionCollection(legacyManifest.seq)),
          queryStore.dropCollection(legacySessionCountersCollection(legacyManifest.seq)),
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

  async reconcile(generation: number): Promise<ReconcileResult> {
    const { storage, docs, queryStore, log, sessionsScope } = this.deps;
    const collection = sessionCollection(generation);
    const counters = sessionCountersCollection(generation);
    const sources = sessionSourcesCollection(generation);
    const workspaces = sessionWorkspaceSourcesCollection(generation);
    const currentWorkspaceIds = [...await listWorkspaceIds(storage, sessionsScope, log)].toSorted();
    const currentWorkspaceSessions = new Map<string, readonly string[]>();
    const currentSessionOwners = new Map<string, number>();
    for (const workspaceId of currentWorkspaceIds) {
      const sessionIds = [
        ...await listSessionIds(storage, sessionsScope, workspaceId, log),
      ].toSorted();
      currentWorkspaceSessions.set(workspaceId, sessionIds);
      for (const sessionId of sessionIds) {
        currentSessionOwners.set(sessionId, (currentSessionOwners.get(sessionId) ?? 0) + 1);
      }
    }
    const previousRoot = await queryStore.get<SessionSourceRoot>(workspaces, SESSION_SOURCE_ROOT_KEY);
    const previousWorkspaceIds = previousRoot?.workspaceIds ?? [];
    const ops: WriteOp[] = [];
    let upserted = 0;
    let removed = 0;
    let sessions = 0;
    let sourceMaxMtimeMs = (await storage.mtime(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY)) ?? 0;

    for (const workspaceId of currentWorkspaceIds) {
      const sessionIds = currentWorkspaceSessions.get(workspaceId) ?? [];
      const previousWorkspace = await queryStore.get<SessionWorkspaceSource>(workspaces, workspaceId);
      const previousSessionIds = previousWorkspace?.sessionIds ?? [];
      const previousSessionSet = new Set(previousSessionIds);
      const previousFingerprints = await queryStore.getMany<SessionSourceFingerprint>(sources, sessionIds);
      const fingerprintEntries = await mapBounded(sessionIds, SCAN_CONCURRENCY, async (sessionId) => ({
        sessionId,
        fingerprint: await sessionStateFingerprint(storage, sessionsScope, workspaceId, sessionId, log),
      }));
      const changedCandidates: string[] = [];
      for (const { sessionId, fingerprint } of fingerprintEntries) {
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
      const changedResults = await mapBounded(
        changedCandidates,
        SCAN_CONCURRENCY,
        async (sessionId) => ({
          sessionId,
          result: await readSessionSummaryResult(docs, sessionsScope, workspaceId, sessionId),
        }),
      );
      const changedIds: string[] = [];
      const nextSummaries = new Map<string, SessionSummary>();
      for (const entry of changedResults) {
        if (entry.result.kind === 'error') continue;
        changedIds.push(entry.sessionId);
        if (entry.result.kind === 'found') {
          nextSummaries.set(entry.sessionId, entry.result.summary);
        }
      }
      const changedSet = new Set(changedIds);
      const currentSet = new Set(sessionIds);
      const departedIds = previousSessionIds.filter((sessionId) => !currentSet.has(sessionId));
      const removedIds = departedIds.filter(
        (sessionId) => (currentSessionOwners.get(sessionId) ?? 0) === 0,
      );
      const removedSet = new Set(removedIds);
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
      const count = {
        active: nextWorkspace.activeSessionIds.length,
        archived: nextWorkspace.archivedSessionIds.length,
      };
      const currentCount = await queryStore.get<SessionWorkspaceCounts>(counters, workspaceId);
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
    for (const workspaceId of previousWorkspaceIds) {
      if (currentWorkspaceSet.has(workspaceId)) continue;
      const previousWorkspace = await queryStore.get<SessionWorkspaceSource>(workspaces, workspaceId);
      const removedIds = (previousWorkspace?.sessionIds ?? []).filter(
        (sessionId) => (currentSessionOwners.get(sessionId) ?? 0) === 0,
      );
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
    if (!sameStrings(previousWorkspaceIds, currentWorkspaceIds)) {
      ops.push({
        kind: 'put',
        collection: workspaces,
        key: SESSION_SOURCE_ROOT_KEY,
        value: { workspaceIds: currentWorkspaceIds } satisfies SessionSourceRoot,
      });
    }

    await this.batchChunks(ops);
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
    const result = { sessions, upserted, removed };
    if (upserted > 0 || removed > 0) {
      log.info('session index reconciliation repaired drift', { generation, ...result });
    }
    return result;
  }

  private async scanAuthoritative(): Promise<AuthoritativeScan> {
    const { storage, docs, sessionsScope, log } = this.deps;
    const summaries: SessionSummary[] = [];
    const counts = new Map<string, SessionWorkspaceCounts>();
    const fingerprints = new Map<string, SessionSourceFingerprint>();
    const workspaceSources = new Map<string, SessionWorkspaceSource>();
    let sourceMaxMtimeMs = (await storage.mtime(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY)) ?? 0;
    for (const workspaceId of await listWorkspaceIds(storage, sessionsScope, log)) {
      const sessionIds = [
        ...await listSessionIds(storage, sessionsScope, workspaceId, log),
      ].toSorted();
      const found = await mapBounded(sessionIds, SCAN_CONCURRENCY, async (sessionId) => {
        const fingerprint = await sessionStateFingerprint(
          storage,
          sessionsScope,
          workspaceId,
          sessionId,
          log,
        );
        const summary = await readSessionSummary(docs, sessionsScope, workspaceId, sessionId);
        return { sessionId, fingerprint, summary };
      });
      const activeSessionIds: string[] = [];
      const archivedSessionIds: string[] = [];
      for (const item of found) {
        fingerprints.set(item.sessionId, item.fingerprint);
        sourceMaxMtimeMs = Math.max(
          sourceMaxMtimeMs,
          item.fingerprint.directMtimeMs,
          item.fingerprint.nestedMtimeMs,
        );
        if (item.summary === undefined) continue;
        summaries.push(item.summary);
        if (item.summary.archived) archivedSessionIds.push(item.sessionId);
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

  private async batchChunks(ops: readonly WriteOp[]): Promise<void> {
    for (let start = 0; start < ops.length; start += WRITE_CHUNK) {
      await this.deps.queryStore.batch(ops.slice(start, start + WRITE_CHUNK));
    }
  }
}

function fingerprintEquals(
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
