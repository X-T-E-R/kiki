import { ILogService } from '#/_base/log/log';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IQueryStore, type WriteOp } from '#/persistence/interface/queryStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { PARENT_SESSION_ID_KEY, type SessionSummary } from './sessionIndex';
import {
  PARENT_INDEX_NAME,
  SESSION_INDEX_MANIFEST,
  recencyColumn,
  sessionCollection,
  sessionCountersCollection,
  withRecencyField,
  type SessionWorkspaceCounts,
} from './sessionIndexModel';
import {
  listSessionIds,
  listWorkspaceIds,
  mapBounded,
  readSessionSummary,
  reconcileSessionSummary,
  summaryEquals,
} from './sessionIndexSource';

const WRITE_CHUNK = 500;
const SCAN_CONCURRENCY = 16;
const SHARED_SCAN_REUSE_MS = 30_000;

export interface SessionIndexProjectorDeps {
  readonly storage: IFileSystemStorageService;
  readonly docs: IAtomicDocumentStore;
  readonly appendLog: IAppendLogStore;
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

/** One consistent pass over the authoritative session metadata set. */
export interface AuthoritativeScan {
  readonly summaries: SessionSummary[];
  readonly counts: Map<string, { active: number; archived: number }>;
}

interface ScanSlot {
  readonly promise: Promise<AuthoritativeScan>;
  readonly reusableUntil: number;
  settled: boolean;
}

export class SessionIndexProjector {
  private scanSlot: ScanSlot | undefined;

  constructor(private readonly deps: SessionIndexProjectorDeps) {}

  /**
   * The projection's scan: joins a running shared scan, reuses one that
   * settled within the reuse window, or starts a fresh one. The projection
   * publishes a point-in-time derived model by design, so a just-finished
   * snapshot is safe for it (the mirror queue and reconciliation heal the
   * gap) — and this is what keeps a fast first read + kicked projection
   * from scanning the directory tree twice.
   */
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
    const collection = sessionCollection(generation);
    const counters = sessionCountersCollection(generation);
    await queryStore.dropCollection(collection);
    await queryStore.dropCollection(counters);
    await queryStore.ensureIndex(collection, {
      kind: 'value',
      name: PARENT_INDEX_NAME,
      field: `custom.${PARENT_SESSION_ID_KEY}`,
    });

    await this.batchChunks(
      scan.summaries.map((summary) => ({
        kind: 'put' as const,
        collection,
        key: summary.id,
        value: withRecencyField(generation, summary),
        columns: { [recencyColumn(generation)]: summary.updatedAt },
      })),
    );
    await this.writeCounters(counters, scan.counts);
    await queryStore.setCheckpoint(SESSION_INDEX_MANIFEST, { seq: generation });
    log.info('session index generation published', {
      generation,
      sessions: scan.summaries.length,
    });

    if (generation > 1) {
      const staleSession = sessionCollection(generation - 1);
      const staleCounters = sessionCountersCollection(generation - 1);
      void queryStore
        .dropCollection(staleSession)
        .then(() => queryStore.dropCollection(staleCounters))
        .catch((error) => {
          log.warn('failed to drop previous session index generation', {
            generation: generation - 1,
            error: String(error),
          });
        });
    }
    return { generation, sessions: scan.summaries.length };
  }

  /** Re-scan the authoritative set and repair the published generation. */
  async reconcile(generation: number): Promise<ReconcileResult> {
    const { queryStore, log } = this.deps;
    const collection = sessionCollection(generation);
    const counters = sessionCountersCollection(generation);
    const { summaries, counts } = await this.scanAuthoritative(true);
    const authoritativeIds = new Set(summaries.map((s) => s.id));

    const storedKeys = await queryStore.listKeys(collection);
    const stored = await queryStore.getMany<SessionSummary>(
      collection,
      summaries.map((s) => s.id),
    );

    const upserts: WriteOp[] = [];
    for (const summary of summaries) {
      const existing = stored.get(summary.id);
      if (existing === undefined || !summaryEquals(existing, summary)) {
        upserts.push({
          kind: 'put',
          collection,
          key: summary.id,
          value: withRecencyField(generation, summary),
          columns: { [recencyColumn(generation)]: summary.updatedAt },
        });
      }
    }
    const removals: WriteOp[] = storedKeys
      .filter((key) => !authoritativeIds.has(key))
      .map((key) => ({ kind: 'delete' as const, collection, key }));

    await this.batchChunks([...upserts, ...removals]);
    await this.writeCounters(counters, counts);
    const result = { sessions: summaries.length, upserted: upserts.length, removed: removals.length };
    if (result.upserted > 0 || result.removed > 0) {
      log.info('session index reconciliation repaired drift', { generation, ...result });
    }
    return result;
  }

  private async scanAuthoritative(recoverUsage = false): Promise<AuthoritativeScan> {
    const { storage, docs, appendLog, sessionsScope } = this.deps;
    const summaries: SessionSummary[] = [];
    const counts = new Map<string, { active: number; archived: number }>();
    for (const workspaceId of await listWorkspaceIds(storage, sessionsScope)) {
      const sessionIds = await listSessionIds(storage, sessionsScope, workspaceId);
      const found = await mapBounded(sessionIds, SCAN_CONCURRENCY, (sessionId) =>
        recoverUsage
          ? reconcileSessionSummary(docs, appendLog, sessionsScope, workspaceId, sessionId)
          : readSessionSummary(docs, sessionsScope, workspaceId, sessionId),
      );
      const entry = counts.get(workspaceId) ?? { active: 0, archived: 0 };
      for (const summary of found) {
        summaries.push(summary);
        if (summary.archived) entry.archived += 1;
        else entry.active += 1;
      }
      counts.set(workspaceId, entry);
    }
    return { summaries, counts };
  }

  private async writeCounters(
    counters: string,
    counts: Map<string, { active: number; archived: number }>,
  ): Promise<void> {
    const { queryStore } = this.deps;
    const existingKeys = await queryStore.listKeys(counters);
    const existing = await queryStore.getMany<SessionWorkspaceCounts>(counters, existingKeys);
    const ops: WriteOp[] = [];
    for (const [workspaceId, value] of counts) {
      const current = existing.get(workspaceId);
      if (current?.active === value.active && current.archived === value.archived) continue;
      ops.push({
        kind: 'put',
        collection: counters,
        key: workspaceId,
        value: { active: value.active, archived: value.archived } satisfies SessionWorkspaceCounts,
      });
    }
    for (const key of existingKeys) {
      if (!counts.has(key)) ops.push({ kind: 'delete', collection: counters, key });
    }
    await this.batchChunks(ops);
  }

  private async batchChunks(ops: readonly WriteOp[]): Promise<void> {
    for (let start = 0; start < ops.length; start += WRITE_CHUNK) {
      await this.deps.queryStore.batch(ops.slice(start, start + WRITE_CHUNK));
    }
  }
}
