import { setImmediate } from 'node:timers/promises';
import { join } from 'pathe';
import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import { acquireFileLock } from '#/persistence/backends/node-fs/fileLock';
import { isStorageError, StorageErrors, type IStorageLock } from '#/persistence/interface/storage';
import { IUsageReadModel, type UsageReadModelQuery, type UsageReadModelSession, type UsageSourcePage } from '#/persistence/interface/usageReadModel';
import type { UsageFactRange } from '#/app/usageFacts/usageFactStore';
import { trackQueryStoreDisposal } from '#/persistence/queryStoreDisposals';
import { UsageReadModelWorker } from './usageHost';
import type { UsageStoreOperation } from './usageProtocol';

export { configureUsageReadModelWorkerRuntime } from './usageProtocol';

export class SqliteUsageReadModel extends Disposable implements IUsageReadModel {
  declare readonly _serviceBrand: undefined;
  private readonly directory: string;
  private writer?: UsageReadModelWorker;
  private reader?: UsageReadModelWorker;
  private lease?: IStorageLock;
  private opening?: Promise<void>;
  private closed = false;
  private closing?: Promise<void>;
  private nextElection = 0;

  constructor(@IBootstrapService bootstrap: IBootstrapService, @ILogService private readonly log: ILogService) {
    super();
    this.directory = join(bootstrap.cacheDir, 'usage-read-model-v2');
    this._register(toDisposable(() => { trackQueryStoreDisposal(this.close()); }));
  }
  private async ready(): Promise<void> {
    if (this.closed) throw new Error('Usage read model closed');
    if (this.opening !== undefined) return this.opening;
    const flight = (async () => {
      if (this.writer?.isStopped) { await this.writer.close().catch(() => undefined); this.writer = undefined; await this.lease?.release(); this.lease = undefined; }
      if (this.reader?.isStopped) { await this.reader.close().catch(() => undefined); this.reader = undefined; }
      if (this.writer === undefined && Date.now() >= this.nextElection) {
        try {
          this.lease = await acquireFileLock(join(this.directory, 'writer.lock'), { owner: { kind: 'usage-read-model' } });
          this.writer = new UsageReadModelWorker(join(this.directory, 'index.sqlite'), true);
          await this.writer.request({ type: 'source', source: '' });
        } catch (error) {
          if (this.writer !== undefined) { await this.writer.close().catch(() => undefined); this.writer = undefined; }
          await this.lease?.release(); this.lease = undefined;
          if (!isStorageError(error, StorageErrors.codes.STORAGE_LOCKED)) throw error;
          this.nextElection = Date.now() + 2000;
        }
      }
      this.reader ??= new UsageReadModelWorker(join(this.directory, 'index.sqlite'), false);
    })();
    this.opening = flight;
    try { await flight; } finally { this.opening = undefined; }
  }
  private async readOperation<T>(operation: UsageStoreOperation, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    await this.ready();
    signal?.throwIfAborted();
    if (operation.type === 'query' && this.writer !== undefined) {
      while (await this.writer.request<boolean>({ type: 'maintain' }, signal)) await setImmediate(undefined, { signal });
    }
    return this.reader!.request(operation, signal);
  }
  private async writeOperation<T>(operation: UsageStoreOperation): Promise<T> {
    await this.ready();
    if (this.writer === undefined) throw Object.assign(new Error('Usage writer is active in another process; projection is pending'), { code: 'usage.read_only', committed: false });
    return this.writer.request(operation);
  }
  source(...[source, signal]: Parameters<IUsageReadModel['source']>): ReturnType<IUsageReadModel['source']> { return this.readOperation({ type: 'source', source }, signal); }
  sources(signal?: AbortSignal): ReturnType<IUsageReadModel['sources']> { return this.readOperation({ type: 'sources' }, signal); }
  progress(...[source, signal]: Parameters<IUsageReadModel['progress']>): ReturnType<IUsageReadModel['progress']> { return this.readOperation({ type: 'progress', source }, signal); }
  apply(page: UsageSourcePage): Promise<boolean> { return this.writeOperation({ type: 'apply', page }); }
  async abandon(source: string): Promise<void> { await this.writeOperation({ type: 'abandon', source }); }
  async invalidate(source: string): Promise<void> { await this.writeOperation({ type: 'invalidate', source }); }
  read(source: string, range?: UsageFactRange, offset?: number, limit?: number, signal?: AbortSignal, until?: number): ReturnType<IUsageReadModel['read']> { return this.readOperation({ type: 'read', source, range, offset, limit, until }, signal); }
  summary(...[source, signal]: Parameters<IUsageReadModel['summary']>): ReturnType<IUsageReadModel['summary']> { return this.readOperation({ type: 'summary', source }, signal); }
  async catalog(sessions: readonly UsageReadModelSession[], sources: readonly { source: string; workspaceId: string; sessionId: string }[], inventory?: boolean): Promise<void> { await this.writeOperation({ type: 'catalog', sessions, sources, inventory }); }
  async settleRetained(ledger: string, generation: string): Promise<void> { await this.writeOperation({ type: 'settleRetained', ledger, generation }); }
  retained(workspaceIds?: readonly string[], signal?: AbortSignal): ReturnType<IUsageReadModel['retained']> { return this.readOperation({ type: 'retained', workspaceIds }, signal); }
  models(signal?: AbortSignal): ReturnType<IUsageReadModel['models']> { return this.readOperation({ type: 'models' }, signal); }
  query(query: UsageReadModelQuery, signal?: AbortSignal): ReturnType<IUsageReadModel['query']> { return this.readOperation({ type: 'query', query }, signal); }
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await this.opening?.catch(() => undefined);
      try { await Promise.all([this.writer?.close(), this.reader?.close()]); }
      finally { await this.lease?.release(); this.lease = undefined; this.writer = undefined; this.reader = undefined; this.log.info('Usage read-model workers closed'); }
    })();
    return this.closing;
  }
}

registerScopedService(LifecycleScope.App, IUsageReadModel, SqliteUsageReadModel, ScopeActivation.OnDemand, 'storage');
