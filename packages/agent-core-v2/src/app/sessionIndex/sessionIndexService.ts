import { join, relative, sep } from 'node:path';

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { abortable as abortableWithSignal } from '#/_base/utils/abort';
import { IntervalTimer, TimeoutTimer } from '#/_base/utils/timer';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { IFlagService } from '#/app/flag/flag';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import {
  IQueryStore,
  isQueryStoreBusy,
  type Checkpoint,
  type ColumnBounds,
  type Page,
  type QueryFilter,
} from '#/persistence/interface/queryStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import {
  CHILD_SESSION_KIND,
  CHILD_SESSION_KIND_KEY,
  ISessionIndex,
  ISessionIndexMirror,
  PARENT_SESSION_ID_KEY,
  type SessionCountQuery,
  type SessionIndexStatus,
  type SessionIndexState,
  type SessionListQuery,
  type SessionSummary,
} from './sessionIndex';
import {
  PARENT_INDEX_NAME,
  SESSION_INDEX_MANIFEST,
  SESSION_INDEX_REVISION,
  advanceSessionIndexRevision,
  recencyColumn,
  sessionCollection,
  sessionCountersCollection,
  stripRecencyField,
  type SessionWorkspaceCounts,
} from './sessionIndexModel';
import { SessionIndexBuildingError, SessionIndexReconcilePendingError } from './errors';
import { isSessionIndexResourceExhaustionError } from './sessionIndexMirrorService';
import { readSessionArchiveFamily } from './sessionArchiveFamily';
import { SessionIndexProjector } from './sessionIndexProjector';
import {
  listSessionIds,
  listWorkspaceIds,
  mapBounded,
  probeSessionSummaryResult,
  readSessionSummaryResult,
  summaryMatchesChildOf,
} from './sessionIndexSource';

const READ_MODEL_FLAG = 'persistence_minidb_readmodel';
const RECONCILE_INTERVAL_MS = 10 * 60_000;
const WATCH_BATCH_MS = 1_000;
const WATCH_BATCH_SIZE = 16;
const POINT_PROBE_CONCURRENCY = 16;
const WATCH_PENDING_LIMIT = 1024;
const RECONCILE_MAX_ATTEMPTS = 2;
const RECONCILE_RETRY_BASE_MS = 5_000;
const RECONCILE_RETRY_MAX_MS = 60_000;
const DEGRADED_RETRY_MS = 5_000;
const RECOVERY_MAX_ATTEMPTS = 3;
const RECOVERY_COOLDOWN_MS = 60_000;
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

class AuthoritativeReadFailure extends Error {
  constructor(cause: unknown) { super('authoritative metadata read failed', { cause }); }
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true && error === signal.reason) return true;
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || (error as { code?: unknown }).code === 'ABORT_ERR';
}

function isResourceExhaustionError(error: unknown): boolean {
  return isSessionIndexResourceExhaustionError(error);
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return signal === undefined ? promise : abortableWithSignal(promise, signal);
}

function canonicalOrder(a: Pick<SessionSummary, 'updatedAt' | 'id'>, b: Pick<SessionSummary, 'updatedAt' | 'id'>): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function isSessionSummaryShape(value: unknown): value is SessionSummary {
  if (value === null || typeof value !== 'object') return false;
  const summary = value as Record<string, unknown>;
  return (
    typeof summary['id'] === 'string' &&
    typeof summary['workspaceId'] === 'string' &&
    typeof summary['createdAt'] === 'number' &&
    typeof summary['updatedAt'] === 'number' &&
    typeof summary['archived'] === 'boolean'
  );
}

function sessionIndexStatusEquals(a: SessionIndexStatus, b: SessionIndexStatus): boolean {
  return (
    a.source === b.source &&
    a.state === b.state &&
    a.generation === b.generation &&
    a.reason === b.reason &&
    a.degradedCount === b.degradedCount
  );
}

export class FileSessionIndex extends Disposable implements ISessionIndex {
  declare readonly _serviceBrand: undefined;

  private state: SessionIndexState = 'uninitialized';
  private generation: number | undefined;
  private statusReason: string | undefined;
  private degradedCount = 0;
  private readModelRevision = 0;
  private nextPrepareRetryAt = 0;
  private recoveryRequired = false;
  private recoveryAttempts = 0;
  private readonly recoveryTimer = this._register(new TimeoutTimer());
  private prepareFlight: Promise<SessionIndexStatus> | undefined;
  private projectFlight: Promise<boolean> | undefined;
  private catchUpFlight: Promise<boolean> | undefined;
  private reconcileFlight: Promise<void> | undefined;
  private disposeFlight: Promise<void> | undefined;
  private reconcileRequest = 0;
  private forcedReconcileRequest = 0;
  private reuseReconcileFingerprints = true;
  private activeReconcileRequest = 0;
  private activeReconcileReuseFingerprints = true;
  private nextReconcileRetryAt = 0;
  private reconcileRetryDelayMs = RECONCILE_RETRY_BASE_MS;
  private readonly reconcileRetryTimer = this._register(new TimeoutTimer());
  private readonly authoritativeFlights = new Map<string, Promise<readonly SessionSummary[]>>();
  private readonly authoritativePointFlights = new Map<string, Promise<SessionSummary | undefined>>();
  private readonly statusEmitter = this._register(new Emitter<SessionIndexStatus>());
  readonly onDidChangeStatus = this.statusEmitter.event;
  private publishedStatus: SessionIndexStatus = {
    source: 'read-model',
    state: 'uninitialized',
    degradedCount: 0,
  };
  private readonly reconcileTimer = this._register(new IntervalTimer({ unref: true }));
  private readonly watchDebounce = this._register(new TimeoutTimer());
  private readonly watchedSessions = new Map<string, { workspaceId: string; id: string }>();
  private watchInventory = false;
  private watchScheduled = false;
  private watchFlight: Promise<void> | undefined;
  private watchRetryDelayMs = WATCH_BATCH_MS;
  private watchStarted = false;
  private readonly projector: SessionIndexProjector;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IQueryStore private readonly queryStore: IQueryStore,
    @IFlagService private readonly flags: IFlagService,
    @ISessionIndexMirror private readonly mirror: ISessionIndexMirror,
    @ILogService private readonly log: ILogService,
    @IHostFsWatchService private readonly fsWatch: IHostFsWatchService,
  ) {
    super();
    this.projector = new SessionIndexProjector({
      storage,
      docs,
      queryStore,
      log,
      sessionsScope: bootstrap.scope('sessions'),
    });
    this._register(mirror.onDidChange(({ id, workspaceId }) => {
      this.projector.invalidateFingerprint(workspaceId, id);
    }));
  }

  override dispose(): Promise<void> {
    this.disposeFlight ??= this.disposeIndex();
    return this.disposeFlight;
  }

  private async disposeIndex(): Promise<void> {
    try {
      await super.dispose();
    } finally {
      await Promise.allSettled([
        this.prepareFlight,
        this.projectFlight,
        this.catchUpFlight,
        this.reconcileFlight,
        this.watchFlight,
      ]);
    }
  }

  /** The reconcile loop runs only while the read model is in play — starting
   *  it unconditionally would spin an interval for every flag-off host. */
  private ensureReconcileTimer(): void {
    if (this._store.isDisposed) return;
    if (!this.reconcileTimer.isSet()) {
      this.reconcileTimer.cancelAndSet(() => void this.tick(), RECONCILE_INTERVAL_MS);
    }
    if (this.watchStarted) return;
    this.watchStarted = true;
    const root = join(this.bootstrap.homeDir, this.bootstrap.scope('sessions'));
    try {
      const watch = this._register(this.fsWatch.watch(root, {
        ignored: (path) => {
          const entry = relative(root, path);
          if (entry.startsWith('..')) return true;
          const parts = entry === '' ? [] : entry.split(sep);
          if (parts.length <= 2) return false;
          if (parts.length === 3) return parts[2] !== 'session-meta' && parts[2] !== 'state.json';
          return parts.length !== 4 || parts[2] !== 'session-meta' || parts[3] !== 'state.json';
        },
      }));
      this._register(watch.onDidChange((change) => {
        const path = relative(root, change.path);
        if (path.startsWith('..')) return;
        const parts = path === '' ? [] : path.split(sep);
        if (parts.length >= 2 && (change.kind === 'directory' || parts.at(-1) === 'state.json')) {
          this.projector.invalidateFingerprint(parts[0], parts[1]);
          this.watchedSessions.set(`${parts[0]}/${parts[1]}`, { workspaceId: parts[0]!, id: parts[1]! });
          if (parts.length === 2 && (change.action === 'created' || change.action === 'deleted')) this.watchInventory = true;
        } else if (change.kind === 'directory') {
          this.projector.invalidateFingerprint();
          this.watchInventory = true;
        } else {
          return;
        }
        if (this.watchedSessions.size > WATCH_PENDING_LIMIT) {
          this.watchInventory = true;
          this.watchedSessions.clear();
        }
        this.scheduleWatchedReconcile();
      }));
      void watch.ready.catch((error: unknown) => {
        this.log.warn('session index watch failed; relying on periodic reconciliation', { error: String(error) });
      });
    } catch (error) {
      this.log.warn('session index watch failed; relying on periodic reconciliation', { error: String(error) });
    }
  }

  private scheduleWatchedReconcile(): void {
    if (this._store.isDisposed || this.watchScheduled || this.watchFlight !== undefined || !this.readModelEnabled()) return;
    if (!this.watchInventory && this.watchedSessions.size === 0) return;
    this.watchScheduled = true;
    this.watchDebounce.cancelAndSet(() => {
      this.watchScheduled = false;
      this.watchFlight = this.reconcileWatched().catch((error: unknown) => {
        if (isResourceExhaustionError(error)) {
          if (this.watchRetryDelayMs < RECONCILE_RETRY_MAX_MS) {
            this.log.warn('session index watched reconciliation paused after resource exhaustion', { error: String(error) });
          }
          this.watchRetryDelayMs = RECONCILE_RETRY_MAX_MS;
          const retryAt = Date.now() + RECONCILE_RETRY_MAX_MS;
          this.nextReconcileRetryAt = Math.max(this.nextReconcileRetryAt, retryAt);
          this.resourceExhaustionCooldownUntil = Math.max(this.resourceExhaustionCooldownUntil, retryAt);
          return;
        }
        if (this.watchRetryDelayMs === WATCH_BATCH_MS && !(error instanceof SessionIndexReconcilePendingError)) {
          this.log.warn('session index watched reconciliation failed', { error: String(error) });
        }
        this.watchRetryDelayMs = error instanceof SessionIndexReconcilePendingError && error.details?.['reason'] === 'concurrent_changes'
          ? WATCH_BATCH_MS
          : Math.min(Math.max(RECONCILE_RETRY_BASE_MS, this.watchRetryDelayMs * 2), RECONCILE_RETRY_MAX_MS);
      }).finally(() => {
        this.watchFlight = undefined;
        this.scheduleWatchedReconcile();
      });
    }, Math.max(
      this.watchedSessions.size > 0 ? this.watchRetryDelayMs : Math.max(this.watchRetryDelayMs, this.nextReconcileRetryAt - Date.now()),
      this.activeResourceExhaustionCooldownUntil() - Date.now(),
    ));
  }

  private async reconcileWatched(): Promise<void> {
    if (this._store.isDisposed || !this.readModelEnabled()) return;
    if (this.reconcileFlight !== undefined) {
      await this.reconcileFlight;
      return;
    }
    if (this.watchInventory && this.watchedSessions.size === 0) {
      this.watchInventory = false;
      try {
        await this.reconcileNow({ reuseFingerprints: true });
      } catch (error) {
        this.watchInventory = true;
        throw error;
      }
    } else {
      const entries = [...this.watchedSessions.entries()].slice(0, WATCH_BATCH_SIZE);
      const requeue = (subset: readonly (readonly [string, { workspaceId: string; id: string }])[]): void => {
        for (const [key, value] of subset) this.watchedSessions.set(key, value);
        if (this.watchedSessions.size > WATCH_PENDING_LIMIT) {
          this.watchInventory = true;
          this.watchedSessions.clear();
        }
      };
      for (const [key] of entries) this.watchedSessions.delete(key);
      if (!this.recoveryRequired && this.mirror.dirtyEpoch() === undefined) {
        try {
          await this.mirror.drain();
        } catch (error) {
          requeue(entries);
          throw error;
        }
      }
      const runBatch = async (
        batch: readonly (readonly [string, { workspaceId: string; id: string }])[],
        allowRetrySplit: boolean,
      ): Promise<void> => {
        if (batch.length === 0) return;
        const batchIds = new Set(batch.map(([, value]) => value.id));
        const conflictedIds = new Set<string>();
        const subscription = this.mirror.onDidChange(({ id }) => {
          if (batchIds.has(id)) conflictedIds.add(id);
        });
        let splitClean: (readonly [string, { workspaceId: string; id: string }])[] | undefined;
        try {
          this.checkReconcileActive(0);
          const manifest = await this.queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
          if (manifest === undefined || this.recoveryRequired || this.mirror.dirtyEpoch() !== undefined) {
            throw new SessionIndexReconcilePendingError('uninitialized', 0);
          }
          const commit = await this.projector.planReconcile(manifest.seq, { reuseFingerprints: true, changedSessions: batch.map(([, value]) => value) });
          this.checkReconcileActive(0);
          await this.mirror.runExclusive(async () => {
            this.checkReconcileActive(0);
            const current = await this.queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
            if (current?.seq !== manifest.seq || this.recoveryRequired || this.mirror.dirtyEpoch() !== undefined) {
              throw new SessionIndexReconcilePendingError('concurrent_changes', 1);
            }
            if (conflictedIds.size > 0) {
              for (const [, value] of batch) this.projector.invalidateFingerprint(value.workspaceId, value.id);
              const conflicted = batch.filter(([, value]) => conflictedIds.has(value.id));
              requeue(conflicted);
              const clean = batch.filter(([, value]) => !conflictedIds.has(value.id));
              if (allowRetrySplit && clean.length > 0) {
                splitClean = clean;
              } else if (clean.length > 0) {
                requeue(clean);
              }
              return;
            }
            const result = await commit();
            if (result.inventoryRequired === true) this.watchInventory = true;
          });
        } catch (error) {
          for (const [, value] of batch) this.projector.invalidateFingerprint(value.workspaceId, value.id);
          requeue(batch);
          throw error;
        } finally {
          subscription.dispose();
        }
        if (splitClean !== undefined) {
          await runBatch(splitClean, false);
        }
      };
      await runBatch(entries, true);
    }
    this.recoveryAttempts = 0;
    this.watchRetryDelayMs = WATCH_BATCH_MS;
  }

  async prepare(options?: { deadlineMs?: number }): Promise<SessionIndexStatus> {
    if (this._store.isDisposed || !this.readModelEnabled()) return this.status();
    if (this.recoveryRequired && (this.recoveryAttempts >= RECOVERY_MAX_ATTEMPTS || Date.now() < this.activeResourceExhaustionCooldownUntil())) {
      return this.status();
    }
    if (!this.recoveryRequired && this.mirror.dirtyEpoch() !== undefined) {
      if (Date.now() < this.activeResourceExhaustionCooldownUntil()) return this.status();
      await this.ensureDirtyCatchUp();
      return this.status();
    }
    this.prepareFlight ??= this.doPrepare(options?.deadlineMs).finally(() => {
      this.prepareFlight = undefined;
    });
    return this.prepareFlight;
  }

  status(): SessionIndexStatus {
    const readModelEnabled = this.readModelEnabled();
    return {
      source: readModelEnabled ? 'read-model' : 'authoritative',
      state: readModelEnabled ? this.state : 'uninitialized',
      generation: this.generation,
      reason: this.statusReason,
      degradedCount: this.degradedCount,
    };
  }

  private emitStatusIfChanged(): void {
    const status = this.status();
    if (sessionIndexStatusEquals(status, this.publishedStatus)) return;
    this.publishedStatus = status;
    this.statusEmitter.fire(status);
  }

  private async doPrepare(deadlineMs?: number): Promise<SessionIndexStatus> {
    if (this.state === 'ready') {
      if (this.mirror.dirtyEpoch() !== undefined) await this.ensureDirtyCatchUp();
      else await this.mirror.drain();
      return this.status();
    }
    this.state = 'preparing';
    this.emitStatusIfChanged();
    let attemptedRecovery = false;
    try {
      if (this.recoveryRequired) {
        attemptedRecovery = true;
        this.recoveryAttempts++;
        this.recoveryTimer.cancel();
        this.log.info('session index recovery started', { attempt: this.recoveryAttempts });
        await this.projectFlight?.catch(() => false);
        await this.mirror.runExclusive(async () => { await this.queryStore.recover?.(); });
        const rebuilt = await this.ensureProjection(true);
        if (!rebuilt) throw new Error('session index recovery projection failed');
        await this.mirror.drain();
        this.recoveryRequired = false;
        this.recoveryAttempts = 0;
        this.nextPrepareRetryAt = 0;
        this.markReady();
        this.log.info('session index recovery completed', { generation: this.generation });
        return this.status();
      }
      const manifest = await this.queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
      if (manifest === undefined) {
        const projection = this.ensureProjection();
        if (deadlineMs === undefined) {
          await projection;
        } else {
          await Promise.race([
            projection,
            new Promise((resolve) => {
              setTimeout(resolve, deadlineMs);
            }),
          ]);
        }
      } else {
        this.generation = manifest.seq;
        await this.ensureSchema(manifest.seq);
        if (!this._store.isDisposed) {
          this.reconcileRetryTimer.cancelAndSet(() => {
            void this.reconcileNow({ reuseFingerprints: true }).catch((error: unknown) => {
              this.log.warn('session index startup reconciliation failed', { error: String(error) });
            });
          }, 0);
        }
      }
      const published = await this.queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
      if (published !== undefined) {
        this.generation = published.seq;
        this.markReady();
        await this.mirror.drain();
      }
    } catch (error) {
      if (
        attemptedRecovery &&
        error instanceof SessionIndexReconcilePendingError &&
        error.details?.['reason'] === 'concurrent_changes'
      ) {
        this.recoveryAttempts = Math.max(0, this.recoveryAttempts - 1);
      }
      this.markDegraded('prepare failed', error);
    }
    return this.status();
  }

  private projectionRetryAt = 0;
  private resourceExhaustionCooldownUntil = 0;

  private activeResourceExhaustionCooldownUntil(): number {
    return Math.max(
      this.resourceExhaustionCooldownUntil,
      this.mirror.resourceExhaustionCooldownUntil?.() ?? 0,
    );
  }

  private ensureProjection(fresh = false): Promise<boolean> {
    if (
      this.projectFlight === undefined &&
      (Date.now() < this.projectionRetryAt || Date.now() < this.activeResourceExhaustionCooldownUntil())
    ) {
      return Promise.resolve(false);
    }
    this.projectFlight ??= this.runProjection(fresh).finally(() => {
      this.projectFlight = undefined;
    });
    return this.projectFlight;
  }

  private async runProjection(fresh: boolean): Promise<boolean> {
    let projected = false;
    try {
      let scanFresh = fresh;
      let conflicts = 0;
      while (!projected) {
        this.checkReconcileActive(conflicts);
        const baseline = await this.mirror.runExclusive(async () => ({
          epoch: this.mirror.epoch(),
          generation: (await this.queryStore.getCheckpoint(SESSION_INDEX_MANIFEST))?.seq,
          revision: (await this.queryStore.getCheckpoint(SESSION_INDEX_REVISION))?.seq,
        }));
        const scan = await this.projector.scan({ fresh: scanFresh });
        const result = await this.mirror.runExclusive(async () => {
          const manifest = await this.queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
          const revision = await this.queryStore.getCheckpoint(SESSION_INDEX_REVISION);
          if (this.mirror.epoch() !== baseline.epoch || manifest?.seq !== baseline.generation || revision?.seq !== baseline.revision) return undefined;
          const next = (manifest?.seq ?? 0) + 1;
          return this.projector.project(next, scan);
        });
        if (result === undefined) {
          if (++conflicts >= RECONCILE_MAX_ATTEMPTS) {
            this.projectionRetryAt = Date.now() + DEGRADED_RETRY_MS;
            throw new SessionIndexReconcilePendingError('concurrent_changes', conflicts, DEGRADED_RETRY_MS);
          }
          scanFresh = true;
          continue;
        }
        this.generation = result.generation;
        this.markReady(true);
        projected = true;
      }
    } catch (error) {
      if (this.recoveryRequired) throw error;
      const resourceExhausted = isResourceExhaustionError(error);
      if (resourceExhausted) {
        this.resourceExhaustionCooldownUntil = Math.max(
          this.resourceExhaustionCooldownUntil,
          Date.now() + RECONCILE_RETRY_MAX_MS,
        );
      }
      const published = await this.queryStore
        .getCheckpoint(SESSION_INDEX_MANIFEST)
        .catch(() => undefined);
      if (published !== undefined) {
        this.generation = published.seq;
        this.markReady(false);
        this.log.warn('session index re-projection failed; staying on the previous generation', {
          generation: published.seq,
          error: String(error),
        });
      } else {
        this.markDegraded('projection failed', error);
      }
    }
    if (this.state === 'ready' && Date.now() >= this.activeResourceExhaustionCooldownUntil()) await this.mirror.drain();
    return projected;
  }

  private ensureDirtyCatchUp(): Promise<boolean> {
    if (this.catchUpFlight === undefined && Date.now() < this.activeResourceExhaustionCooldownUntil()) {
      return Promise.resolve(false);
    }
    this.catchUpFlight ??= this.runDirtyCatchUp().finally(() => {
      this.catchUpFlight = undefined;
    });
    return this.catchUpFlight;
  }

  private async runDirtyCatchUp(): Promise<boolean> {
    if (!this.readModelEnabled()) return false;
    if (this.mirror.dirtyEpoch() === undefined) return true;
    if (Date.now() < this.activeResourceExhaustionCooldownUntil()) return false;
    const projection = this.projectFlight;
    if (projection !== undefined) await projection.catch(() => false);
    if (!this.readModelEnabled()) return false;
    if (Date.now() < this.activeResourceExhaustionCooldownUntil()) return false;
    const dirty = this.mirror.dirtyEpoch();
    if (dirty === undefined) return true;
    const projected = await this.ensureProjection(true).catch(() => false);
    if (!projected || !this.readModelEnabled()) return false;
    this.mirror.settleDirty(dirty);
    return this.mirror.dirtyEpoch() === undefined;
  }

  /** Reconciles a stable authoritative snapshot. Rejects with a retryable
   *  session.index_building error while concurrent changes require a deferred pass. */
  reconcileNow(options?: { reuseFingerprints?: boolean }): Promise<void> {
    if (this._store.isDisposed) return Promise.reject(new SessionIndexReconcilePendingError('disposed', 0));
    if (!this.readModelEnabled()) return Promise.resolve();
    const wantsForced = options?.reuseFingerprints !== true;
    if (this.reconcileFlight !== undefined) {
      const covered = !wantsForced ||
        !this.activeReconcileReuseFingerprints ||
        this.forcedReconcileRequest > this.activeReconcileRequest;
      if (!covered) {
        this.reconcileRequest += 1;
        this.forcedReconcileRequest = this.reconcileRequest;
        this.reuseReconcileFingerprints = false;
      }
      return this.reconcileFlight;
    }
    const retryUntil = options?.reuseFingerprints === true
      ? Math.max(this.nextReconcileRetryAt, this.activeResourceExhaustionCooldownUntil())
      : this.nextReconcileRetryAt;
    const retryAfterMs = retryUntil - Date.now();
    if (retryAfterMs > 0) return Promise.reject(new SessionIndexReconcilePendingError('concurrent_changes', 0, retryAfterMs));
    this.reconcileRequest += 1;
    if (wantsForced) {
      this.forcedReconcileRequest = this.reconcileRequest;
    }
    this.reuseReconcileFingerprints &&= !wantsForced;
    this.activeReconcileRequest = this.reconcileRequest;
    this.activeReconcileReuseFingerprints = this.reuseReconcileFingerprints;
    this.reconcileRetryTimer.cancel();
    this.reconcileFlight = this.runReconcile().finally(() => {
      this.reconcileFlight = undefined;
    });
    return this.reconcileFlight;
  }

  private checkReconcileActive(attempts: number): void {
    if (this._store.isDisposed) throw new SessionIndexReconcilePendingError('disposed', attempts);
    if (!this.readModelEnabled()) throw new SessionIndexReconcilePendingError('disabled', attempts);
  }

  private async runReconcile(): Promise<void> {
    let reuseAttemptFingerprints = this.reuseReconcileFingerprints;
    for (let attempt = 0; attempt < RECONCILE_MAX_ATTEMPTS; attempt++) {
      this.checkReconcileActive(attempt);
      const request = this.reconcileRequest;
      const reuseFingerprints = reuseAttemptFingerprints;
      this.activeReconcileRequest = request;
      this.activeReconcileReuseFingerprints = reuseFingerprints;
      const mutated = new Map<string, string | undefined>();
      const subscription = this.mirror.onDidChange(({ id, workspaceId }) => mutated.set(id, workspaceId));
      let committed = false;
      let wipeAllFingerprints = true;
      try {
        const baseline = await this.mirror.runExclusive(async () => ({
          epoch: this.mirror.epoch(),
          generation: (await this.queryStore.getCheckpoint(SESSION_INDEX_MANIFEST))?.seq,
          revision: (await this.queryStore.getCheckpoint(SESSION_INDEX_REVISION))?.seq,
        }));
        this.checkReconcileActive(attempt);
        if (baseline.generation === undefined) throw new SessionIndexReconcilePendingError('uninitialized', attempt);
        const commit = await this.projector.planReconcile(baseline.generation, { reuseFingerprints });
        this.checkReconcileActive(attempt + 1);
        committed = await this.mirror.runExclusive(async () => {
          this.checkReconcileActive(attempt + 1);
          const manifest = await this.queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
          const revision = await this.queryStore.getCheckpoint(SESSION_INDEX_REVISION);
          const knownMutationsOnly = [...mutated.values()].every(workspaceId => workspaceId !== undefined);
          if (manifest?.seq !== baseline.generation) {
            wipeAllFingerprints = true;
            return false;
          }
          if (this.mirror.epoch() !== baseline.epoch || revision?.seq !== baseline.revision) {
            const canMergeClean =
              attempt === RECONCILE_MAX_ATTEMPTS - 1 &&
              reuseFingerprints &&
              mutated.size > 0 &&
              knownMutationsOnly &&
              this.forcedReconcileRequest < request &&
              request === this.reconcileRequest;
            if (canMergeClean) {
              const skipSessionIds = new Set<string>();
              const skipWorkspaceIds = new Set<string>();
              for (const [id, workspaceId] of mutated) {
                skipSessionIds.add(id);
                if (workspaceId !== undefined) {
                  skipWorkspaceIds.add(workspaceId);
                  this.projector.invalidateFingerprint(workspaceId, id);
                  this.watchedSessions.set(`${workspaceId}\0${id}`, { workspaceId, id });
                }
              }
              await commit({ sessionIds: skipSessionIds, workspaceIds: skipWorkspaceIds });
              this.generation = baseline.generation;
              if (skipWorkspaceIds.size > 0) this.watchInventory = true;
              this.scheduleWatchedReconcile();
              return true;
            }
            wipeAllFingerprints = mutated.size === 0 || !knownMutationsOnly || this.forcedReconcileRequest > request;
            return false;
          }
          if (request !== this.reconcileRequest) {
            wipeAllFingerprints = !knownMutationsOnly || this.forcedReconcileRequest > request;
            return false;
          }
          await commit();
          this.generation = baseline.generation;
          return true;
        });
      } catch (error) {
        if (isResourceExhaustionError(error)) {
          const retryAt = Date.now() + RECONCILE_RETRY_MAX_MS;
          this.nextReconcileRetryAt = Math.max(this.nextReconcileRetryAt, retryAt);
          this.resourceExhaustionCooldownUntil = Math.max(this.resourceExhaustionCooldownUntil, retryAt);
          this.reconcileRetryDelayMs = RECONCILE_RETRY_MAX_MS;
          this.reconcileRetryTimer.cancel();
        }
        throw error;
      } finally {
        subscription.dispose();
        if (!committed) {
          if (wipeAllFingerprints || this.forcedReconcileRequest > request) {
            this.projector.invalidateFingerprint();
            reuseAttemptFingerprints = false;
          } else {
            for (const [id, workspaceId] of mutated) {
              if (workspaceId !== undefined) this.projector.invalidateFingerprint(workspaceId, id);
            }
            reuseAttemptFingerprints = true;
          }
        } else if (request !== this.reconcileRequest) {
          if (this.forcedReconcileRequest > request) {
            this.projector.invalidateFingerprint();
            reuseAttemptFingerprints = false;
          } else {
            reuseAttemptFingerprints = true;
          }
        }
      }
      if (committed) {
        if (request === this.reconcileRequest) {
          this.recoveryAttempts = 0;
          this.reuseReconcileFingerprints = true;
          this.nextReconcileRetryAt = 0;
          this.resourceExhaustionCooldownUntil = 0;
          this.mirror.clearResourceExhaustionCooldown?.();
          this.reconcileRetryDelayMs = RECONCILE_RETRY_BASE_MS;
          this.reconcileRetryTimer.cancel();
          return;
        }
        attempt = -1;
      }
    }
    const delay = this.reconcileRetryDelayMs;
    this.nextReconcileRetryAt = Date.now() + delay;
    this.reconcileRetryDelayMs = Math.min(delay * 2, RECONCILE_RETRY_MAX_MS);
    this.reconcileRetryTimer.cancelAndSet(() => {
      void this.reconcileNow({ reuseFingerprints: true }).catch((error: unknown) => {
        this.log.warn('session index deferred reconciliation incomplete', { error: String(error) });
      });
    }, delay);
    throw new SessionIndexReconcilePendingError('concurrent_changes', RECONCILE_MAX_ATTEMPTS, delay);
  }

  /** Explicitly retry an exhausted recovery or project a fresh generation (single-flight). */
  async reprojectNow(): Promise<void> {
    if (this._store.isDisposed || !this.readModelEnabled()) return;
    this.projectionRetryAt = 0;
    if (this.recoveryRequired) {
      this.recoveryAttempts = 0;
      this.nextPrepareRetryAt = 0;
      this.resourceExhaustionCooldownUntil = 0;
      this.mirror.clearResourceExhaustionCooldown?.();
      await this.prepare();
      return;
    }
    this.resourceExhaustionCooldownUntil = 0;
    this.mirror.clearResourceExhaustionCooldown?.();
    await this.ensureProjection();
  }

  /** Test hook: stop the background reconcile loop, so measurement windows
   *  contain only the operations under test. */
  stopReconcileLoop(): void {
    this.reconcileTimer.cancel();
  }

  private async tick(): Promise<void> {
    if (!this.readModelEnabled()) return;
    if (this.state === 'degraded') {
      this.kickPrepare();
      return;
    }
    if (this.state !== 'ready') return;
    if (Date.now() < this.activeResourceExhaustionCooldownUntil()) return;
    try {
      const manifest = await this.queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
      if (manifest === undefined) {
        this.markDegraded('published generation lost');
        void this.prepare();
        return;
      }
      await this.reconcileNow({ reuseFingerprints: true });
    } catch (error) {
      this.log.warn('session index reconciliation failed', { error: String(error) });
    }
  }

  private markReady(clearExhaustionCooldown = false): void {
    if (this.recoveryRequired) return;
    this.recoveryAttempts = 0;
    if (clearExhaustionCooldown) {
      this.resourceExhaustionCooldownUntil = 0;
      this.mirror.clearResourceExhaustionCooldown?.();
    }
    this.state = 'ready';
    this.statusReason = undefined;
    this.ensureReconcileTimer();
    this.scheduleWatchedReconcile();
    this.emitStatusIfChanged();
  }

  private markDegraded(reason: string, error?: unknown): void {
    this.readModelRevision += 1;
    this.state = 'degraded';
    this.statusReason = reason;
    this.degradedCount += 1;
    this.recoveryRequired = true;
    const exhausted = this.recoveryAttempts >= RECOVERY_MAX_ATTEMPTS;
    const resourceExhausted = isResourceExhaustionError(error);
    const retryDelay = exhausted || resourceExhausted ? RECOVERY_COOLDOWN_MS : DEGRADED_RETRY_MS;
    if (exhausted) this.statusReason = `${reason}; automatic recovery exhausted; next read can retry after ${RECOVERY_COOLDOWN_MS}ms cooldown`;
    const retryAt = Date.now() + retryDelay;
    this.nextPrepareRetryAt = retryAt;
    if (resourceExhausted) this.resourceExhaustionCooldownUntil = Math.max(this.resourceExhaustionCooldownUntil, retryAt);
    if (!exhausted) this.recoveryTimer.cancelAndSet(() => this.kickPrepare(), retryDelay);
    else this.log.error('session index automatic recovery exhausted; waiting for read after cooldown', {
      attempts: this.recoveryAttempts,
      retryAfterMs: RECOVERY_COOLDOWN_MS,
      error: String(error),
    });
    this.ensureReconcileTimer();
    this.emitStatusIfChanged();
    const detail =
      error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
    this.log.warn('session index read model degraded; list/count fail closed until rebuilt', {
      reason,
      ...(detail !== undefined ? { error: detail } : {}),
      degradedCount: this.degradedCount,
    });
  }

  private async ensureSchema(generation: number): Promise<void> {
    await this.queryStore.ensureIndex(sessionCollection(generation), {
      kind: 'value',
      name: PARENT_INDEX_NAME,
      field: `custom.${PARENT_SESSION_ID_KEY}`,
    });
  }

  async get(id: string, workspaceId?: string, signal?: AbortSignal): Promise<SessionSummary | undefined> {
    signal?.throwIfAborted();
    return this.withPointReadModel(
      (generation) => this.getFromReadModel(generation, id, undefined, workspaceId, signal, true),
      () => abortable(this.getLegacy(id, workspaceId === undefined ? undefined : [workspaceId]), signal),
      signal,
    );
  }

  archiveFamily(id: string, excludedIds: readonly string[]): Promise<SessionSummary[]> {
    return readSessionArchiveFamily(this.storage, this.docs, this.sessionsScope, id, excludedIds, this.log, {
      get: (workspaceId, sessionId, fingerprint) =>
        this.projector.cachedSummaryForFingerprint(workspaceId, sessionId, fingerprint),
      set: (workspaceId, sessionId, fingerprint, summary) =>
        this.projector.rememberSummaryFingerprint(workspaceId, sessionId, fingerprint, summary),
    });
  }

  async listRecent(query: SessionListQuery): Promise<Page<SessionSummary>> {
    return this.withReadyReadModel(
      (generation) => this.listRecentFromReadModel(generation, query),
      () => this.listLegacy(query),
    );
  }

  async count(query: SessionCountQuery): Promise<number> {
    return this.withReadyReadModel(
      (generation) => this.countFromReadModel(generation, query),
      () => this.countLegacy(query),
    );
  }

  async remove(id: string): Promise<void> {
    await this.mirror.runExclusive(async () => {
      this.mirror.invalidate(id);
      try {
        if (!this.readModelEnabled()) return;
        const manifest = await this.queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
        if (manifest === undefined) return;
        this.generation = manifest.seq;
        await this.removeFromReadModel(manifest.seq, id);
      } finally {
        this.acknowledgePendingId(id);
      }
    });
  }

  private async withPointReadModel<T>(
    op: (generation: number) => Promise<T>,
    legacy: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const readRevision = this.readModelRevision;
    signal?.throwIfAborted();
    if (!this.readModelEnabled()) return legacy();
    if (this.mirror.dirtyEpoch() !== undefined) {
      void this.ensureDirtyCatchUp().catch(() => false);
      return legacy();
    }
    if (this.state !== 'ready') {
      if (this.state !== 'preparing' && Date.now() >= this.nextPrepareRetryAt) this.kickPrepare(true);
      return legacy();
    }
    let manifest: Checkpoint | undefined;
    try {
      manifest = await this.queryStore.getCheckpoint(SESSION_INDEX_MANIFEST, signal, { priority: true });
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      if (isQueryStoreBusy(error) || readRevision !== this.readModelRevision) return legacy();
      this.markDegraded('read model read failed', error);
      this.kickPrepare();
      return legacy();
    }
    if (manifest === undefined) {
      if (readRevision !== this.readModelRevision) return legacy();
      this.markDegraded('published generation lost');
      this.kickPrepare();
      return legacy();
    }
    if (readRevision !== this.readModelRevision) return legacy();
    this.generation = manifest.seq;
    let result: T;
    try {
      result = await op(manifest.seq);
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      if (error instanceof AuthoritativeReadFailure) throw error.cause;
      if (isQueryStoreBusy(error) || readRevision !== this.readModelRevision) return legacy();
      this.markDegraded('read model read failed', error);
      this.kickPrepare();
      return legacy();
    }
    return readRevision === this.readModelRevision ? result : legacy();
  }

  private async withReadyReadModel<T>(
    op: (generation: number) => Promise<T>,
    legacy: () => Promise<T>,
    exclusive = false,
  ): Promise<T> {
    const readRevision = this.readModelRevision;
    if (!this.readModelEnabled()) return legacy();
    if (this.recoveryRequired) {
      if (Date.now() >= this.activeResourceExhaustionCooldownUntil() && (Date.now() >= this.nextPrepareRetryAt || this.recoveryAttempts === 0)) {
        this.kickPrepare(true);
      }
      throw new SessionIndexBuildingError();
    }
    if (this.mirror.dirtyEpoch() !== undefined) {
      if (Date.now() >= this.activeResourceExhaustionCooldownUntil()) {
        void this.ensureDirtyCatchUp().catch(() => false);
      }
      throw new SessionIndexBuildingError();
    }
    let manifest: Checkpoint | undefined;
    try {
      manifest = await this.queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
    } catch (error) {
      if (isQueryStoreBusy(error) || readRevision !== this.readModelRevision) throw new SessionIndexBuildingError();
      this.markDegraded('read model read failed', error);
      this.kickPrepare();
      throw new SessionIndexBuildingError();
    }
    if (manifest === undefined) {
      if (readRevision !== this.readModelRevision) throw new SessionIndexBuildingError();
      if (this.state === 'ready') this.markDegraded('published generation lost');
      this.kickPrepare();
      throw new SessionIndexBuildingError();
    }
    const publishedManifest = manifest;
    const read = async (): Promise<T> => {
      if (readRevision !== this.readModelRevision) throw new SessionIndexBuildingError();
      if (this.mirror.dirtyEpoch() !== undefined) {
        if (Date.now() >= this.activeResourceExhaustionCooldownUntil()) {
          void this.ensureDirtyCatchUp().catch(() => false);
        }
        throw new SessionIndexBuildingError();
      }
      let generation = publishedManifest.seq;
      if (exclusive) {
        const published = await this.queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
        if (readRevision !== this.readModelRevision) throw new SessionIndexBuildingError();
        if (published === undefined) {
          this.kickPrepare();
          throw new SessionIndexBuildingError();
        }
        generation = published.seq;
      }
      if (readRevision !== this.readModelRevision) throw new SessionIndexBuildingError();
      this.generation = generation;
      this.markReady();
      try {
        const result = await op(generation);
        if (readRevision !== this.readModelRevision) throw new SessionIndexBuildingError();
        return result;
      } catch (error) {
        if (error instanceof AuthoritativeReadFailure) throw error.cause;
        if (isQueryStoreBusy(error) || readRevision !== this.readModelRevision) throw new SessionIndexBuildingError();
        this.markDegraded('read model read failed', error);
        this.kickPrepare();
        throw new SessionIndexBuildingError();
      }
    };
    return exclusive ? this.mirror.runExclusive(read) : read();
  }

  private kickPrepare(requested = false): void {
    if (this.prepareFlight !== undefined || this.state === 'preparing') return;
    if (Date.now() < this.activeResourceExhaustionCooldownUntil()) return;
    if (this.recoveryRequired && this.recoveryAttempts >= RECOVERY_MAX_ATTEMPTS) {
      if (!requested || this.state !== 'degraded' || Date.now() < this.nextPrepareRetryAt) return;
      this.recoveryAttempts = 0;
      this.log.info('session index recovery resumed by read after cooldown');
    }
    void this.prepare().catch((error: unknown) => {
      this.log.error('session index recovery failed', { error: String(error) });
    });
  }

  private async getFromReadModel(
    generation: number,
    id: string,
    pending: readonly SessionSummary[] = this.mirror.pending(),
    workspaceId?: string,
    signal?: AbortSignal,
    priority?: boolean,
  ): Promise<SessionSummary | undefined> {
    signal?.throwIfAborted();
    const queued = pending.find((summary) => summary.id === id);
    if (queued !== undefined) {
      if (workspaceId === undefined || queued.workspaceId === workspaceId) return this.withOwnUpdatedAt(queued, signal);
    } else {
      const cached: unknown = await this.queryStore.get(sessionCollection(generation), id, signal, { priority });
      if (isSessionSummaryShape(cached)) {
        const summary = stripRecencyField(generation, cached);
        if (workspaceId === undefined || summary.workspaceId === workspaceId) return this.withOwnUpdatedAt(summary, signal);
      }
    }
    const summary = await abortable(this.getLegacy(id, workspaceId === undefined ? undefined : [workspaceId]), signal)
      .catch((error: unknown) => {
        if (isAbortError(error, signal)) throw error;
        throw new AuthoritativeReadFailure(error);
      });
    if (summary !== undefined) this.mirror.record(summary);
    return summary;
  }

  private async listRecentFromReadModel(
    generation: number,
    query: SessionListQuery,
  ): Promise<Page<SessionSummary>> {
    const pending = this.mirror.pending();
    if (query.sessionId !== undefined) {
      const workspaceId = query.workspaceIds?.length === 1 ? query.workspaceIds[0] : undefined;
      const summary = await this.getFromReadModel(generation, query.sessionId, pending, workspaceId);
      const items =
        summary !== undefined && (!summary.archived || query.includeArchived === true)
          ? [summary]
          : [];
      return { items: query.limit !== undefined ? items.slice(0, query.limit) : items };
    }

    const collection = sessionCollection(generation);
    const cursor = await this.resolveCursor(generation, query, pending);
    if (cursor === undefined) return { items: [] };
    const limit = query.limit ?? UNBOUNDED;
    const filter: QueryFilter = {
      ...this.baseFilter(query),
      ...cursor.filter,
      ...(pending.length > 0
        ? { id: { $nin: pending.map((summary) => summary.id) } }
        : {}),
    };
    const column = recencyColumn(generation);
    const strip = (records: SessionSummary[]): SessionSummary[] =>
      records.map((record) => stripRecencyField(generation, record));

    const page = await this.windowedPage(
      (bounds, fetchLimit, canonicalTie) => {
        if (query.childOf !== undefined || canonicalTie) {
          const base = this.queryStore
            .query<SessionSummary>(collection)
            .where(filter)
            .orderBy(canonicalTie ? 'id' : 'updatedAt', 'desc')
            .limit(fetchLimit);
          const q = Object.keys(bounds).length > 0 ? base.whereColumn(column, bounds) : base;
          return q.execute().then((p) => strip([...p.items]));
        }
        return this.queryStore
          .pageByColumn<SessionSummary>(collection, {
            column,
            dir: 'desc',
            filter,
            bounds,
            limit: fetchLimit,
          })
          .then((p) => strip([...p.items]));
      },
      cursor.bounds,
      limit,
    );
    const merged = this.mergePending(page, query, pending, cursor.position);
    return { ...merged, items: await Promise.all(merged.items.map((summary) => this.withOwnUpdatedAt(summary))) };
  }

  private async withOwnUpdatedAt(summary: SessionSummary, signal?: AbortSignal): Promise<SessionSummary> {
    if (summary.ownUpdatedAt !== undefined) return summary;
    const result = await abortable(readSessionSummaryResult(this.docs, this.sessionsScope, summary.workspaceId, summary.id, this.log, this.storage), signal);
    if (result.kind !== 'found' || result.summary.ownUpdatedAt === undefined) return summary;
    const current = this.mirror.pending().find((entry) => entry.id === summary.id);
    const original = current === undefined ? result.summary : {
      ...current, ownUpdatedAt: current.ownUpdatedAt ?? result.summary.ownUpdatedAt,
    };
    this.mirror.record(original);
    return { ...summary, ownUpdatedAt: original.ownUpdatedAt };
  }

  private async countFromReadModel(
    generation: number,
    query: SessionCountQuery,
  ): Promise<number> {
    const restricted = query.workspaceIds;
    const pending = this.mirror.pending();
    const counters = sessionCountersCollection(generation);
    const workspaceIds = restricted ?? (await this.queryStore.listKeys(counters));
    const counts = await this.queryStore.getMany<SessionWorkspaceCounts>(counters, workspaceIds);
    let total = 0;
    for (const entry of counts.values()) {
      total += query.includeArchived === true ? entry.active + entry.archived : entry.active;
    }
    if (pending.length === 0) return total;
    const stored = await this.queryStore.getMany<unknown>(
      sessionCollection(generation),
      pending.map((summary) => summary.id),
    );
    const contribution = (summary: SessionSummary | undefined): number =>
      summary !== undefined &&
      (restricted === undefined || restricted.includes(summary.workspaceId)) &&
      (query.includeArchived === true || !summary.archived)
        ? 1
        : 0;
    for (const summary of pending) {
      const oldValue = stored.get(summary.id);
      const old = isSessionSummaryShape(oldValue) ? oldValue : undefined;
      total += contribution(summary) - contribution(old);
    }
    return total;
  }

  private acknowledgePendingId(id: string): void {
    this.mirror.acknowledge(this.mirror.pending().filter((summary) => summary.id === id));
  }

  private async removeFromReadModel(generation: number, id: string): Promise<void> {
    const collection = sessionCollection(generation);
    const storedValue: unknown = await this.queryStore.get(collection, id);
    if (storedValue === undefined) return;
    await advanceSessionIndexRevision(this.queryStore);
    if (!isSessionSummaryShape(storedValue)) {
      await this.queryStore.delete(collection, id);
      return;
    }
    const counters = sessionCountersCollection(generation);
    const current =
      (await this.queryStore.get<SessionWorkspaceCounts>(counters, storedValue.workspaceId)) ?? {
        active: 0,
        archived: 0,
      };
    const value: SessionWorkspaceCounts = storedValue.archived
      ? { active: current.active, archived: Math.max(0, current.archived - 1) }
      : { active: Math.max(0, current.active - 1), archived: current.archived };
    await this.queryStore.batch([
      { kind: 'delete', collection, key: id },
      { kind: 'put', collection: counters, key: storedValue.workspaceId, value },
    ]);
  }

  private async windowedPage(
    fetch: (bounds: ColumnBounds, limit: number, canonicalTie: boolean) => Promise<SessionSummary[]>,
    bounds: ColumnBounds,
    limit: number,
  ): Promise<Page<SessionSummary>> {
    const raw = await fetch(bounds, limit + 1, false);
    if (raw.length <= limit) {
      return { items: raw.toSorted(canonicalOrder) };
    }
    const minUpdatedAt = Math.min(...raw.map((summary) => summary.updatedAt));
    if (raw.filter((summary) => summary.updatedAt === minUpdatedAt).length === 1) {
      const items = raw.toSorted(canonicalOrder).slice(0, limit);
      return { items, nextCursor: items.at(-1)!.id };
    }
    const tie = await fetch({ gte: minUpdatedAt, lte: minUpdatedAt }, limit + 1, true);
    const merged = new Map<string, SessionSummary>();
    for (const summary of tie) merged.set(summary.id, summary);
    for (const summary of raw) merged.set(summary.id, summary);
    const items = [...merged.values()].toSorted(canonicalOrder);
    const kept = items.slice(0, limit);
    return { items: kept, nextCursor: kept.at(-1)!.id };
  }

  /**
   * Read-your-writes merge: pages fold in the mirror's queued summaries so a
   * just-mutated session shows up before the flush lands. Cursor pages merge
   * only the queued summaries that fall inside the page's canonical range
   * (the queue is a tiny, transient window).
   */
  private mergePending(
    page: Page<SessionSummary>,
    query: SessionListQuery,
    pendingSnapshot: readonly SessionSummary[],
    position?: { u: number; id: string; before: boolean },
  ): Page<SessionSummary> {
    const pending = pendingSnapshot.filter(
      (summary) =>
        (query.workspaceIds === undefined || query.workspaceIds.includes(summary.workspaceId)) &&
        (query.includeArchived === true || !summary.archived) &&
        summaryMatchesChildOf(summary, query.childOf) &&
        (position === undefined ||
          (position.before
            ? summary.updatedAt < position.u ||
              (summary.updatedAt === position.u && summary.id < position.id)
            : summary.updatedAt > position.u ||
              (summary.updatedAt === position.u && summary.id > position.id))),
    );
    if (pending.length === 0) return page;
    const merged = new Map<string, SessionSummary>();
    for (const summary of pending) merged.set(summary.id, summary);
    for (const summary of page.items) {
      if (!merged.has(summary.id)) merged.set(summary.id, summary);
    }
    const items = [...merged.values()].toSorted(canonicalOrder);
    if (query.limit === undefined) return { items };
    const kept = items.slice(0, query.limit);
    const hasMore = page.nextCursor !== undefined || items.length > query.limit;
    return { items: kept, nextCursor: hasMore ? kept.at(-1)!.id : undefined };
  }

  /**
   * Resolve a keyset cursor id to its column bounds plus the exact
   * tie-exclusion filter, in canonical order: strictly older (`before`) is
   * `(updatedAt, id)` lexicographically below the cursor, strictly newer
   * (`after`) is above. An unknown cursor id yields `undefined` — the caller
   * answers an empty, terminal page.
   */
  private async resolveCursor(
    generation: number,
    query: SessionListQuery,
    pending: readonly SessionSummary[],
  ): Promise<
    | { filter: QueryFilter; bounds: ColumnBounds; position?: { u: number; id: string; before: boolean } }
    | undefined
  > {
    const id = query.beforePosition?.id ?? query.before ?? query.after;
    if (id === undefined) return { filter: {}, bounds: {} };
    let cursor: { readonly updatedAt: number; readonly id: string } | undefined = query.beforePosition;
    if (cursor === undefined) {
      const queued = pending.find((summary) => summary.id === id);
      const storedValue: unknown = await this.queryStore.get(sessionCollection(generation), id);
      const stored = isSessionSummaryShape(storedValue) ? storedValue : undefined;
      cursor = queued ?? stored;
    }
    if (cursor === undefined) return undefined;
    const u = cursor.updatedAt;
    if (query.beforePosition !== undefined || query.before !== undefined) {
      return {
        bounds: { lte: u },
        filter: {
          $or: [
            { updatedAt: { $lt: u } },
            { updatedAt: u, id: { $lt: id } },
          ],
        },
        position: { u, id, before: true },
      };
    }
    return {
      bounds: { gte: u },
      filter: {
        $or: [
          { updatedAt: { $gt: u } },
          { updatedAt: u, id: { $gt: id } },
        ],
      },
      position: { u, id, before: false },
    };
  }

  private baseFilter(query: SessionListQuery): QueryFilter {
    const filter: Record<string, unknown> = {};
    if (query.workspaceIds !== undefined) {
      filter['workspaceId'] =
        query.workspaceIds.length === 1
          ? query.workspaceIds[0]
          : { $in: [...query.workspaceIds] };
    }
    if (query.childOf !== undefined) {
      filter[`custom.${PARENT_SESSION_ID_KEY}`] = query.childOf;
      filter[`custom.${CHILD_SESSION_KIND_KEY}`] = CHILD_SESSION_KIND;
    }
    if (query.includeArchived !== true) filter['archived'] = { $ne: true };
    return filter;
  }

  private get sessionsScope(): string {
    return this.bootstrap.scope('sessions');
  }

  private async listLegacy(query: SessionListQuery): Promise<Page<SessionSummary>> {
    if (query.sessionId !== undefined) {
      const summary = await this.getLegacy(query.sessionId, query.workspaceIds);
      const items =
        summary !== undefined && (!summary.archived || query.includeArchived === true)
          ? [summary]
          : [];
      return { items: query.limit !== undefined ? items.slice(0, query.limit) : items };
    }

    const collected = (await this.collectAuthoritative(query.workspaceIds)).filter(
      (summary) =>
        (query.includeArchived === true || !summary.archived) &&
        summaryMatchesChildOf(summary, query.childOf),
    );
    const items = collected.toSorted(canonicalOrder);

    let start = 0;
    let end = items.length;
    const cursorId = query.before ?? query.after;
    if (query.beforePosition !== undefined) {
      const position = query.beforePosition;
      start = items.findIndex((summary) => canonicalOrder(summary, position) > 0);
      if (start === -1) start = items.length;
    } else if (cursorId !== undefined) {
      const index = items.findIndex((summary) => summary.id === cursorId);
      if (index === -1) return { items: [] };
      if (query.before !== undefined) start = index + 1;
      else end = index;
    }
    const window = items.slice(start, end);
    if (query.limit === undefined) return { items: window };
    const kept = window.slice(0, query.limit);
    return {
      items: kept,
      nextCursor: window.length > query.limit ? kept.at(-1)!.id : undefined,
    };
  }

  private getLegacy(
    id: string,
    knownWorkspaceIds?: readonly string[],
  ): Promise<SessionSummary | undefined> {
    const key = JSON.stringify([id, knownWorkspaceIds?.toSorted()]);
    const existing = this.authoritativePointFlights.get(key);
    if (existing !== undefined) return existing;
    const flight = this.readAuthoritativeWithRetry(id, async () => {
      const pendingBefore = this.mirror.pending().find(
        (summary) =>
          summary.id === id &&
          (knownWorkspaceIds === undefined || knownWorkspaceIds.includes(summary.workspaceId)),
      );
      let authoritative: SessionSummary | undefined;
      const workspaceIds =
        knownWorkspaceIds ?? await listWorkspaceIds(this.storage, this.sessionsScope, this.log);
      for (let offset = 0; offset < workspaceIds.length && authoritative === undefined; offset += POINT_PROBE_CONCURRENCY) {
        const results = await Promise.all(workspaceIds.slice(offset, offset + POINT_PROBE_CONCURRENCY).map((workspaceId) =>
          knownWorkspaceIds === undefined
            ? probeSessionSummaryResult(this.storage, this.docs, this.sessionsScope, workspaceId, id, this.log)
            : readSessionSummaryResult(this.docs, this.sessionsScope, workspaceId, id, this.log, this.storage),
        ));
        for (const result of results) {
          if (result.kind === 'error') throw result.error;
          if (result.kind === 'found') {
            authoritative = result.summary;
            break;
          }
        }
      }
      if (!this.readModelEnabled()) return authoritative;
      const pendingAfter = this.mirror.pending().find(
        (summary) =>
          summary.id === id &&
          (knownWorkspaceIds === undefined || knownWorkspaceIds.includes(summary.workspaceId)),
      );
      return pendingAfter ?? pendingBefore ?? authoritative;
    }).finally(() => {
      if (this.authoritativePointFlights.get(key) === flight) this.authoritativePointFlights.delete(key);
    });
    this.authoritativePointFlights.set(key, flight);
    return flight;
  }

  private async countLegacy(query: SessionCountQuery): Promise<number> {
    let count = 0;
    for (const summary of await this.collectAuthoritative(query.workspaceIds)) {
      if (query.includeArchived === true || !summary.archived) count += 1;
    }
    return count;
  }

  private collectAuthoritative(
    workspaceIds: readonly string[] | undefined,
  ): Promise<SessionSummary[]> {
    const key = workspaceIds === undefined ? '*' : [...workspaceIds].toSorted().join('\u0000');
    const existing = this.authoritativeFlights.get(key);
    if (existing !== undefined) return existing.then((items) => [...items]);
    const flight = this.scanAuthoritativeSnapshot(workspaceIds).finally(() => {
      if (this.authoritativeFlights.get(key) === flight) this.authoritativeFlights.delete(key);
    });
    this.authoritativeFlights.set(key, flight);
    return flight.then((items) => [...items]);
  }

  private async scanAuthoritativeSnapshot(workspaceIds: readonly string[] | undefined): Promise<SessionSummary[]> {
    const changed = new Map<string, string | undefined>();
    const subscription = this.mirror.onDidChange(({ id, workspaceId }) => changed.set(id, workspaceId));
    const collected = new Map<string, SessionSummary>();
    try {
      const ids = workspaceIds ?? await listWorkspaceIds(this.storage, this.sessionsScope, this.log);
      for (const workspaceId of ids) {
        const sessionIds = await listSessionIds(this.storage, this.sessionsScope, workspaceId, this.log);
        const results = await mapBounded(sessionIds, POINT_PROBE_CONCURRENCY, async (sessionId) => ({
          sessionId,
          result: await readSessionSummaryResult(this.docs, this.sessionsScope, workspaceId, sessionId, this.log, this.storage),
        }));
        for (const { sessionId, result } of results) {
          if (result.kind === 'found') collected.set(sessionId, result.summary);
        }
      }
    } finally {
      subscription.dispose();
    }
    for (const [id, changedWorkspace] of changed) {
      const workspaceId = changedWorkspace ?? collected.get(id)?.workspaceId;
      collected.delete(id);
      if (workspaceId === undefined || workspaceIds !== undefined && !workspaceIds.includes(workspaceId)) continue;
      const result = await readSessionSummaryResult(this.docs, this.sessionsScope, workspaceId, id, this.log, this.storage);
      if (result.kind === 'found') collected.set(id, result.summary);
    }
    return [...collected.values()];
  }

  private async readAuthoritativeWithRetry<T>(id: string, read: () => Promise<T>): Promise<T> {
    let changed = false;
    const subscription = this.mirror.onDidChange((mutation) => { if (mutation.id === id) changed = true; });
    try {
      const result = await read();
      return changed ? await read() : result;
    } finally {
      subscription.dispose();
    }
  }

  private readModelEnabled(): boolean {
    return this.flags.enabled(READ_MODEL_FLAG);
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionIndex,
  FileSessionIndex,
  ScopeActivation.OnScopeCreated,
  'sessionIndex',
);
