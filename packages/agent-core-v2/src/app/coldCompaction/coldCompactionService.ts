import { Disposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { SESSION_LOCK_SCOPE, sessionLockKey } from '#/persistence/backends/node-fs/fileLock';
import { warmSparseFileWorker } from '#/persistence/backends/node-fs/sparseFile';
import type { ColdUnsealOptions } from '#/persistence/coldSegmentLog';
import { IFileSystemStorageService, StorageErrors } from '#/persistence/interface/storage';
import {
  compactRetainedSession,
  unsealRetainedSession,
  type RetainedCompactOptions,
  type RetainedCompactSessionResult,
  type RetainedUnsealSessionResult,
} from '#/persistence/retainedJournal';
import { sessionScopeOf, workspacePersistenceScope } from '#/workspace/sessionLifecycle/internal/addressing';

import { IColdCompactionService, type ColdCompactionStatus } from './coldCompaction';
import { COLD_COMPACTION_SECTION, ColdCompactionConfigSchema, type ColdCompactionConfig } from './configSection';

const CANDIDATE_PAGE_SIZE = 32;
const MAX_CANDIDATE_PAGES = 8;
const FOREGROUND_COOLDOWN_MS = 5_000;

class ForegroundSessionPreemptionError extends Error {
  constructor(sessionId: string) {
    super(`Cold compaction preempted by foreground access to ${sessionId}`);
    this.name = 'ForegroundSessionPreemptionError';
  }
}

interface ActiveColdSessionRun {
  readonly preemptible: boolean;
  readonly controller: AbortController;
  readonly released: Promise<void>;
}

export class ColdCompactionService extends Disposable implements IColdCompactionService {
  declare readonly _serviceBrand: undefined;

  private readonly checkedUpdatedAt = new Map<string, number>();
  private readonly recentForegroundAccess = new Map<string, number>();
  private readonly activeSessionRuns = new Map<string, Set<ActiveColdSessionRun>>();
  private readonly disposalAbort = new AbortController();
  private sweepCursor: { readonly updatedAt: number; readonly id: string } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private activeSweep: Promise<number> | undefined;
  private sweepsCompleted = 0;
  private sessionsCompacted = 0;
  private physicalBytesReclaimed = 0;
  private lastSweepAt: number | undefined;
  private disposed = false;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @ISessionIndex private readonly index: ISessionIndex,
    @ISessionManager private readonly sessions: ISessionManager,
    @IConfigService private readonly config?: IConfigService,
    @ILogService private readonly log?: ILogService,
  ) {
    super();
    if (this.sessions.onWillAccessSession !== undefined) {
      this._register(
        this.sessions.onWillAccessSession((sessionId) => {
          this.noteForegroundAccess(sessionId);
        }),
      );
    }
    if (this.sessions.registerMaintenanceBarrier !== undefined) {
      this._register(
        this.sessions.registerMaintenanceBarrier((sessionId) => this.preemptAndWaitSessionRelease(sessionId)),
      );
    }
    if (this.isFileBacked()) {
      const cfg = this.readConfig();
      if (cfg.enabled) {
        this.armTimer(cfg.initialDelayMs);
      }
      if (this.config?.onDidSectionChange !== undefined) {
        this._register(
          this.config.onDidSectionChange((event) => {
            if (event.domain !== COLD_COMPACTION_SECTION || this.disposed) return;
            const next = this.readConfig();
            if (!next.enabled) {
              this.clearTimer();
            } else if (this.timer === undefined && this.activeSweep === undefined) {
              this.armTimer(next.sweepIntervalMs);
            }
          }),
        );
      }
    }
  }

  status(): ColdCompactionStatus {
    const cfg = this.readConfig();
    return {
      enabled: cfg.enabled && this.isFileBacked(),
      running: this.activeSweep !== undefined,
      sweepsCompleted: this.sweepsCompleted,
      sessionsCompacted: this.sessionsCompacted,
      physicalBytesReclaimed: this.physicalBytesReclaimed,
      lastSweepAt: this.lastSweepAt,
    };
  }

  async compactSession(
    sessionId: string,
    options: RetainedCompactOptions & { readonly workspaceId?: string } = {},
  ): Promise<RetainedCompactSessionResult | undefined> {
    return this.runSessionCompaction(sessionId, options, true);
  }

  async unsealSession(
    sessionId: string,
    options: ColdUnsealOptions & { readonly workspaceId?: string } = {},
  ): Promise<RetainedUnsealSessionResult | undefined> {
    if (this.disposed || !this.isFileBacked()) return undefined;
    const workspaceId = options.workspaceId ?? (await this.index.get(sessionId))?.workspaceId;
    if (workspaceId === undefined) return undefined;
    const signal = this.mergeSignal(options.signal);
    return this.withColdSessionLock(sessionId, workspaceId, false, signal, (sessionDir, effectiveSignal) =>
      unsealRetainedSession(sessionDir, {
        ...options,
        signal: effectiveSignal,
      }),
    );
  }

  async runIdlePass(maxSessions?: number): Promise<number> {
    if (this.disposed || !this.isFileBacked()) return 0;
    if (this.activeSweep !== undefined) return this.activeSweep;
    const run = this.executeIdlePass(maxSessions).finally(() => {
      if (this.activeSweep === run) this.activeSweep = undefined;
    });
    this.activeSweep = run;
    return run;
  }

  override async dispose(): Promise<void> {
    this.disposed = true;
    this.clearTimer();
    this.disposalAbort.abort();
    const releases: Promise<void>[] = [];
    for (const runs of this.activeSessionRuns.values()) {
      for (const run of runs) {
        run.controller.abort();
        releases.push(run.released);
      }
    }
    if (this.activeSweep !== undefined) {
      await this.activeSweep.catch(() => undefined);
    }
    if (releases.length > 0) {
      await Promise.all(releases);
    }
    await super.dispose();
  }

  private noteForegroundAccess(sessionId: string): void {
    const now = Date.now();
    if (this.recentForegroundAccess.size >= 512) {
      for (const [key, stamp] of this.recentForegroundAccess) {
        if (now - stamp >= FOREGROUND_COOLDOWN_MS) this.recentForegroundAccess.delete(key);
      }
      if (this.recentForegroundAccess.size >= 512) {
        const oldest = this.recentForegroundAccess.keys().next().value;
        if (oldest !== undefined) this.recentForegroundAccess.delete(oldest);
      }
    }
    this.recentForegroundAccess.set(sessionId, now);
    const runs = this.activeSessionRuns.get(sessionId);
    if (runs === undefined) return;
    const reason = new ForegroundSessionPreemptionError(sessionId);
    for (const run of runs) {
      if (run.preemptible) run.controller.abort(reason);
    }
  }

  private async preemptAndWaitSessionRelease(sessionId: string): Promise<void> {
    this.noteForegroundAccess(sessionId);
    for (;;) {
      const runs = this.activeSessionRuns.get(sessionId);
      if (runs === undefined || runs.size === 0) return;
      const reason = new ForegroundSessionPreemptionError(sessionId);
      const pending: Promise<void>[] = [];
      for (const run of runs) {
        if (run.preemptible && !run.controller.signal.aborted) {
          run.controller.abort(reason);
        }
        pending.push(run.released);
      }
      await Promise.all(pending);
    }
  }

  private hasRecentForegroundAccess(sessionId: string): boolean {
    const stamp = this.recentForegroundAccess.get(sessionId);
    if (stamp === undefined) return false;
    if (Date.now() - stamp < FOREGROUND_COOLDOWN_MS) return true;
    this.recentForegroundAccess.delete(sessionId);
    return false;
  }

  private async runSessionCompaction(
    sessionId: string,
    options: RetainedCompactOptions & { readonly workspaceId?: string },
    preemptible: boolean,
  ): Promise<RetainedCompactSessionResult | undefined> {
    if (this.disposed || !this.isFileBacked()) return undefined;
    const workspaceId = options.workspaceId ?? (await this.index.get(sessionId))?.workspaceId;
    if (workspaceId === undefined) return undefined;
    const cfg = this.readConfig();
    const signal = this.mergeSignal(options.signal);
    try {
      return await this.withColdSessionLock(sessionId, workspaceId, preemptible, signal, async (sessionDir, effectiveSignal) => {
        const result = await compactRetainedSession(sessionDir, {
          ...options,
          level: options.level ?? ((options.codec ?? 'zstd') === 'zstd' ? cfg.zstdLevel : undefined),
          segmentBytes: options.segmentBytes ?? cfg.segmentBytes,
          reclaim: options.reclaim ?? cfg.reclaimSparse,
          signal: effectiveSignal,
        });
        const reclaimed = Math.max(0, result.physicalBytesBefore - result.physicalBytesAfter);
        if (result.compactedJournals > 0) {
          this.sessionsCompacted += 1;
          this.physicalBytesReclaimed += reclaimed;
        }
        return result;
      });
    } catch (error) {
      if (error instanceof ForegroundSessionPreemptionError) return undefined;
      throw error;
    }
  }

  private isFileBacked(): boolean {
    const probe = this.storage.pathFor(this.bootstrap.scope('sessions'), '');
    return probe !== undefined && probe.length > 0;
  }

  private readConfig(): ColdCompactionConfig {
    return ColdCompactionConfigSchema.parse(this.config?.get(COLD_COMPACTION_SECTION) ?? {});
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private armTimer(delayMs: number): void {
    if (this.disposed) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.disposed) return;
      const cfg = this.readConfig();
      if (!cfg.enabled) return;
      void this.runIdlePass()
        .catch((error) => {
          this.log?.warn('idle cold compaction sweep failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (!this.disposed && this.readConfig().enabled) {
            this.armTimer(this.readConfig().sweepIntervalMs);
          }
        });
    }, delayMs);
    this.timer.unref?.();
  }

  private mergeSignal(callerSignal: AbortSignal | undefined): AbortSignal {
    if (callerSignal === undefined) return this.disposalAbort.signal;
    return AbortSignal.any([this.disposalAbort.signal, callerSignal]);
  }

  private async executeIdlePass(maxSessionsOverride?: number): Promise<number> {
    const cfg = this.readConfig();
    const limit = Math.max(1, maxSessionsOverride ?? cfg.maxSessionsPerSweep);
    const cutoff = Date.now() - cfg.minIdleAgeMs;
    let compactedCount = 0;
    const startedWithCursor = this.sweepCursor !== undefined;
    let beforePosition = this.sweepCursor;
    let wrapped = false;

    for (let pageIndex = 0; pageIndex < MAX_CANDIDATE_PAGES && compactedCount < limit; pageIndex += 1) {
      if (this.disposalAbort.signal.aborted) break;
      const page = await this.index.listRecent({
        includeArchived: true,
        limit: CANDIDATE_PAGE_SIZE,
        beforePosition,
      });
      if (page.items.length === 0) {
        if (startedWithCursor && !wrapped) {
          beforePosition = undefined;
          wrapped = true;
          continue;
        }
        beforePosition = undefined;
        break;
      }
      for (const summary of page.items) {
        if (this.disposalAbort.signal.aborted || compactedCount >= limit) break;
        beforePosition = { updatedAt: summary.updatedAt, id: summary.id };
        if (summary.updatedAt > cutoff) continue;
        if (summary.executionPhase !== undefined && summary.executionPhase !== 'running' && summary.executionPhase !== 'failed') continue;
        if (this.sessions.get(summary.id) !== undefined || this.hasRecentForegroundAccess(summary.id)) continue;
        if (this.checkedUpdatedAt.get(summary.id) === summary.updatedAt) continue;
        try {
          const result = await this.runSessionCompaction(
            summary.id,
            {
              workspaceId: summary.workspaceId,
              reclaim: cfg.reclaimSparse,
              incremental: true,
            },
            true,
          );
          if (result === undefined) continue;
          this.checkedUpdatedAt.set(summary.id, summary.updatedAt);
          if (result.compactedJournals > 0) {
            compactedCount += 1;
          }
        } catch (error) {
          if (
            error instanceof ForegroundSessionPreemptionError ||
            isLockedStorageError(error) ||
            this.disposalAbort.signal.aborted
          ) {
            continue;
          }
          this.log?.warn('idle cold compaction skipped session after error', {
            sessionId: summary.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (compactedCount >= limit) break;
      if (page.nextCursor === undefined && page.items.length < CANDIDATE_PAGE_SIZE) {
        if (startedWithCursor && !wrapped) {
          beforePosition = undefined;
          wrapped = true;
          continue;
        }
        beforePosition = undefined;
        break;
      }
    }

    this.sweepCursor = beforePosition;
    this.sweepsCompleted += 1;
    this.lastSweepAt = Date.now();
    return compactedCount;
  }

  private async withColdSessionLock<T>(
    sessionId: string,
    workspaceId: string,
    preemptible: boolean,
    baseSignal: AbortSignal,
    work: (sessionDir: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    if (this.sessions.get(sessionId) !== undefined) return undefined;
    if (preemptible && this.hasRecentForegroundAccess(sessionId)) return undefined;

    const preemptionController = new AbortController();
    let resolveReleased!: () => void;
    const released = new Promise<void>((done) => {
      resolveReleased = done;
    });
    const activeEntry: ActiveColdSessionRun = {
      preemptible,
      controller: preemptionController,
      released,
    };
    let bucket = this.activeSessionRuns.get(sessionId);
    if (bucket === undefined) {
      bucket = new Set();
      this.activeSessionRuns.set(sessionId, bucket);
    }
    bucket.add(activeEntry);

    const effectiveSignal = preemptible
      ? AbortSignal.any([baseSignal, preemptionController.signal])
      : baseSignal;

    try {
      if (this.sessions.get(sessionId) !== undefined) return undefined;
      if (preemptible && this.hasRecentForegroundAccess(sessionId)) return undefined;
      effectiveSignal.throwIfAborted();

      const sessionsScope = this.bootstrap.scope('sessions');
      const scope = sessionScopeOf(workspacePersistenceScope(sessionsScope, workspaceId), sessionId);
      const sessionDir = this.storage.pathFor(scope, '');
      if (sessionDir === undefined || sessionDir.length === 0) return undefined;
      await warmSparseFileWorker(effectiveSignal);
      if (this.sessions.get(sessionId) !== undefined) return undefined;
      if (preemptible && this.hasRecentForegroundAccess(sessionId)) return undefined;
      effectiveSignal.throwIfAborted();

      let lock: { release(): Promise<void> } | undefined;
      try {
        lock = await this.storage.acquireLock(SESSION_LOCK_SCOPE, sessionLockKey(scope), {
          waitForMs: 0,
          signal: effectiveSignal,
          owner: {
            sessionId,
            workspaceId,
            scope,
          },
        });
      } catch (error) {
        if (isLockedStorageError(error)) return undefined;
        throw error;
      }
      try {
        if (this.sessions.get(sessionId) !== undefined) return undefined;
        effectiveSignal.throwIfAborted();
        return await work(sessionDir, effectiveSignal);
      } finally {
        await lock.release();
      }
    } finally {
      bucket.delete(activeEntry);
      if (bucket.size === 0) this.activeSessionRuns.delete(sessionId);
      resolveReleased();
    }
  }
}

function isLockedStorageError(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === StorageErrors.codes.STORAGE_LOCKED;
}

registerScopedService(
  LifecycleScope.App,
  IColdCompactionService,
  ColdCompactionService,
  ScopeActivation.OnScopeCreated,
  'coldCompaction',
);
