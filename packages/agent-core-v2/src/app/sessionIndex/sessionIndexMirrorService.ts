import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IntervalTimer } from '#/_base/utils/timer';
import { IFlagService } from '#/app/flag/flag';
import { IQueryStore } from '#/persistence/interface/queryStore';

import { ISessionIndexMirror, type SessionSummary } from './sessionIndex';
import {
  SESSION_INDEX_MANIFEST,
  recencyColumn,
  sessionCollection,
  sessionCountersCollection,
  withRecencyField,
  type SessionWorkspaceCounts,
} from './sessionIndexModel';

const READ_MODEL_FLAG = 'persistence_minidb_readmodel';

const FLUSH_INTERVAL_MS = 100;
const FLUSH_BATCH_SIZE = 500;
const MAX_PENDING = FLUSH_BATCH_SIZE;
const MAX_CONSECUTIVE_FAILURES = 5;

const pendingDrains = new Set<Promise<void>>();

export async function drainSessionIndexMirror(): Promise<void> {
  await Promise.all(pendingDrains);
}

export class SessionIndexMirror extends Disposable implements ISessionIndexMirror {
  declare readonly _serviceBrand: undefined;

  private readonly pendingMap = new Map<string, SessionSummary>();
  private readonly timer = this._register(new IntervalTimer({ unref: true }));
  private exclusiveTail: Promise<void> = Promise.resolve();
  private flushing: Promise<void> | undefined;
  private consecutiveFailures = 0;
  private mutationEpochValue = 0;
  private dirtyEpochValue = 0;
  private settledDirtyEpoch = 0;
  private lastReadModelEnabled: boolean;
  private disposed = false;

  constructor(
    @IQueryStore private readonly queryStore: IQueryStore,
    @IFlagService private readonly flags: IFlagService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.lastReadModelEnabled = this.flags.enabled(READ_MODEL_FLAG);
    this._register(
      toDisposable(() => {
        this.disposed = true;
        const pending = this.drain().catch(() => {});
        pendingDrains.add(pending);
        void pending.finally(() => pendingDrains.delete(pending));
      }),
    );
  }

  record(summary: SessionSummary): void {
    if (this.disposed) return;
    const enabled = this.observeReadModelFlag();
    this.mutationEpochValue += 1;
    if (!enabled || this.isDirty()) {
      this.markDirty();
      return;
    }
    if (!this.pendingMap.has(summary.id) && this.pendingMap.size >= MAX_PENDING) {
      this.markDirty();
      return;
    }
    this.pendingMap.set(summary.id, summary);
    if (this.pendingMap.size >= FLUSH_BATCH_SIZE) {
      void this.flush();
    } else if (!this.timer.isSet()) {
      this.timer.cancelAndSet(() => void this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  epoch(): number {
    this.observeReadModelFlag();
    return this.mutationEpochValue;
  }

  dirtyEpoch(): number | undefined {
    this.observeReadModelFlag();
    return this.isDirty() ? this.dirtyEpochValue : undefined;
  }

  settleDirty(epoch: number): void {
    if (!this.observeReadModelFlag()) return;
    this.settledDirtyEpoch = Math.max(
      this.settledDirtyEpoch,
      Math.min(epoch, this.dirtyEpochValue),
    );
    if (!this.isDirty()) this.consecutiveFailures = 0;
  }

  invalidate(id: string): void {
    if (this.disposed) return;
    const enabled = this.observeReadModelFlag();
    this.mutationEpochValue += 1;
    this.pendingMap.delete(id);
    if (this.pendingMap.size === 0) this.timer.cancel();
    if (!enabled || this.isDirty()) this.markDirty();
  }

  pending(): readonly SessionSummary[] {
    if (!this.observeReadModelFlag() || this.isDirty()) return [];
    return [...this.pendingMap.values()];
  }

  acknowledge(summaries: readonly SessionSummary[]): void {
    if (!this.observeReadModelFlag() || this.isDirty()) return;
    for (const summary of summaries) {
      if (this.pendingMap.get(summary.id) === summary) this.pendingMap.delete(summary.id);
    }
    if (this.pendingMap.size === 0) this.timer.cancel();
  }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.exclusiveTail.then(operation, operation);
    this.exclusiveTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async evict(id: string): Promise<void> {
    await this.runExclusive(async () => {
      this.invalidate(id);
    });
  }

  async drain(): Promise<void> {
    this.timer.cancel();
    if (!this.observeReadModelFlag() || this.isDirty()) return;
    while (this.pendingMap.size > 0) {
      const before = this.pendingMap.size;
      await this.flush();
      if (this.pendingMap.size >= before) {
        this.log.warn('session index mirror drain made no progress; leaving the rest dirty', {
          pending: this.pendingMap.size,
        });
        return;
      }
    }
  }

  private observeReadModelFlag(): boolean {
    const enabled = this.flags.enabled(READ_MODEL_FLAG);
    if (enabled === this.lastReadModelEnabled) return enabled;
    this.lastReadModelEnabled = enabled;
    if (!enabled) {
      if (this.pendingMap.size > 0) this.markDirty();
      else this.timer.cancel();
    }
    return enabled;
  }

  private isDirty(): boolean {
    return this.dirtyEpochValue > this.settledDirtyEpoch;
  }

  private markDirty(): void {
    this.dirtyEpochValue = Math.max(this.dirtyEpochValue, this.mutationEpochValue);
    this.pendingMap.clear();
    this.timer.cancel();
  }

  private flush(): Promise<void> {
    if (this.flushing !== undefined) return this.flushing;
    if (!this.observeReadModelFlag() || this.isDirty()) return Promise.resolve();
    this.flushing = this.runExclusive(() => this.flushChunk()).finally(() => {
      this.flushing = undefined;
      if (
        this.observeReadModelFlag() &&
        !this.isDirty() &&
        this.pendingMap.size > 0 &&
        this.consecutiveFailures < MAX_CONSECUTIVE_FAILURES
      ) {
        this.timer.cancelAndSet(() => void this.flush(), FLUSH_INTERVAL_MS);
      }
    });
    return this.flushing;
  }

  private registerFlushFailure(): boolean {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) return false;
    this.markDirty();
    return true;
  }

  private async flushChunk(): Promise<void> {
    if (!this.observeReadModelFlag() || this.isDirty()) return;
    const chunk = [...this.pendingMap.entries()].slice(0, FLUSH_BATCH_SIZE);
    if (chunk.length === 0) return;
    try {
      const manifest = await this.queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
      if (manifest === undefined) {
        const pending = this.pendingMap.size;
        if (this.registerFlushFailure()) {
          this.log.warn('session index mirror switching to authoritative catch-up', {
            pending,
            failures: this.consecutiveFailures,
          });
        }
        return;
      }
      const collection = sessionCollection(manifest.seq);
      const counters = sessionCountersCollection(manifest.seq);
      const ids = chunk.map(([id]) => id);
      const olds = await this.queryStore.getMany<SessionSummary>(collection, ids);

      const deltas = new Map<string, { active: number; archived: number }>();
      const bump = (workspaceId: string, field: 'active' | 'archived', by: number): void => {
        const entry = deltas.get(workspaceId) ?? { active: 0, archived: 0 };
        entry[field] += by;
        deltas.set(workspaceId, entry);
      };
      for (const [id, summary] of chunk) {
        const old = olds.get(id);
        if (old === undefined) {
          bump(summary.workspaceId, summary.archived ? 'archived' : 'active', 1);
        } else if (old.workspaceId !== summary.workspaceId) {
          bump(old.workspaceId, old.archived ? 'archived' : 'active', -1);
          bump(summary.workspaceId, summary.archived ? 'archived' : 'active', 1);
        } else if (old.archived !== summary.archived) {
          bump(summary.workspaceId, old.archived ? 'archived' : 'active', -1);
          bump(summary.workspaceId, summary.archived ? 'archived' : 'active', 1);
        }
      }

      const current = await this.queryStore.getMany<SessionWorkspaceCounts>(counters, [
        ...deltas.keys(),
      ]);
      const ops = [
        ...chunk.map(([id, summary]) => ({
          kind: 'put' as const,
          collection,
          key: id,
          value: withRecencyField(manifest.seq, summary),
          columns: { [recencyColumn(manifest.seq)]: summary.updatedAt },
        })),
        ...[...deltas.entries()].map(([workspaceId, delta]) => {
          const base = current.get(workspaceId) ?? { active: 0, archived: 0 };
          const value: SessionWorkspaceCounts = {
            active: Math.max(0, base.active + delta.active),
            archived: Math.max(0, base.archived + delta.archived),
          };
          return { kind: 'put' as const, collection: counters, key: workspaceId, value };
        }),
      ];
      await this.queryStore.batch(ops);
      this.acknowledge(chunk.map(([, summary]) => summary));
      this.consecutiveFailures = 0;
    } catch (error) {
      const pending = this.pendingMap.size;
      const dirty = this.registerFlushFailure();
      this.log.warn('failed to flush session index mirror chunk', {
        pending,
        failures: this.consecutiveFailures,
        error: String(error),
      });
      if (dirty) {
        this.log.warn('session index mirror switching to authoritative catch-up', {
          pending,
          failures: this.consecutiveFailures,
        });
      }
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionIndexMirror,
  SessionIndexMirror,
  ScopeActivation.OnScopeCreated,
  'sessionIndex',
);
