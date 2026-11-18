import { Disposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { SESSION_LOCK_SCOPE, sessionLockKey } from '#/persistence/backends/node-fs/fileLock';
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

export class ColdCompactionService extends Disposable implements IColdCompactionService {
  declare readonly _serviceBrand: undefined;

  private readonly checkedUpdatedAt = new Map<string, number>();
  private readonly disposalAbort = new AbortController();
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
    if (this.disposed || !this.isFileBacked()) return undefined;
    const workspaceId = options.workspaceId ?? (await this.index.get(sessionId))?.workspaceId;
    if (workspaceId === undefined) return undefined;
    const cfg = this.readConfig();
    const signal = this.mergeSignal(options.signal);
    return this.withColdSessionLock(sessionId, workspaceId, async (sessionDir) => {
      const result = await compactRetainedSession(sessionDir, {
        ...options,
        reclaim: options.reclaim ?? cfg.reclaimSparse,
        signal,
      });
      const reclaimed = Math.max(0, result.physicalBytesBefore - result.physicalBytesAfter);
      if (result.compactedJournals > 0) {
        this.sessionsCompacted += 1;
        this.physicalBytesReclaimed += reclaimed;
      }
      return result;
    });
  }

  async unsealSession(
    sessionId: string,
    options: ColdUnsealOptions & { readonly workspaceId?: string } = {},
  ): Promise<RetainedUnsealSessionResult | undefined> {
    if (this.disposed || !this.isFileBacked()) return undefined;
    const workspaceId = options.workspaceId ?? (await this.index.get(sessionId))?.workspaceId;
    if (workspaceId === undefined) return undefined;
    const signal = this.mergeSignal(options.signal);
    return this.withColdSessionLock(sessionId, workspaceId, (sessionDir) =>
      unsealRetainedSession(sessionDir, {
        ...options,
        signal,
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
    if (this.activeSweep !== undefined) {
      await this.activeSweep.catch(() => undefined);
    }
    super.dispose();
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
    let beforePosition: { readonly updatedAt: number; readonly id: string } | undefined;

    for (let pageIndex = 0; pageIndex < MAX_CANDIDATE_PAGES && compactedCount < limit; pageIndex += 1) {
      if (this.disposalAbort.signal.aborted) break;
      const page = await this.index.listRecent({
        includeArchived: true,
        limit: CANDIDATE_PAGE_SIZE,
        beforePosition,
      });
      if (page.items.length === 0) break;
      for (const summary of page.items) {
        if (this.disposalAbort.signal.aborted || compactedCount >= limit) break;
        beforePosition = { updatedAt: summary.updatedAt, id: summary.id };
        if (summary.updatedAt > cutoff) continue;
        if (summary.executionPhase !== undefined && summary.executionPhase !== 'failed') continue;
        if (this.sessions.get(summary.id) !== undefined) continue;
        if (this.checkedUpdatedAt.get(summary.id) === summary.updatedAt) continue;
        try {
          const result = await this.compactSession(summary.id, {
            workspaceId: summary.workspaceId,
            reclaim: cfg.reclaimSparse,
            incremental: true,
          });
          if (result === undefined) continue;
          this.checkedUpdatedAt.set(summary.id, summary.updatedAt);
          const reclaimed = Math.max(0, result.physicalBytesBefore - result.physicalBytesAfter);
          if (reclaimed > 0) {
            compactedCount += 1;
          }
        } catch (error) {
          if (isLockedStorageError(error) || this.disposalAbort.signal.aborted) continue;
          this.log?.warn('idle cold compaction skipped session after error', {
            sessionId: summary.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (page.nextCursor === undefined && page.items.length < CANDIDATE_PAGE_SIZE) break;
    }

    this.sweepsCompleted += 1;
    this.lastSweepAt = Date.now();
    return compactedCount;
  }

  private async withColdSessionLock<T>(
    sessionId: string,
    workspaceId: string,
    work: (sessionDir: string) => Promise<T>,
  ): Promise<T | undefined> {
    return this.sessions.withLifecycleSerialization(sessionId, async () => {
      if (this.sessions.get(sessionId) !== undefined) return undefined;
      const sessionsScope = this.bootstrap.scope('sessions');
      const scope = sessionScopeOf(workspacePersistenceScope(sessionsScope, workspaceId), sessionId);
      const sessionDir = this.storage.pathFor(scope, '');
      if (sessionDir === undefined || sessionDir.length === 0) return undefined;
      let lock: { release(): Promise<void> } | undefined;
      try {
        lock = await this.storage.acquireLock(SESSION_LOCK_SCOPE, sessionLockKey(scope), {
          waitForMs: 0,
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
        return await work(sessionDir);
      } finally {
        await lock.release();
      }
    });
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
