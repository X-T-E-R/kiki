import { join } from 'pathe';
import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import { IMemoryPersistence, type MemoryCommit, type MemoryLegacyPayload } from '#/persistence/interface/memoryPersistence';
import { trackQueryStoreDisposal } from '#/persistence/queryStoreDisposals';
import { MemoryWorker } from './host';
import type { MemoryOperation } from './protocol';

export { configureMemoryWorkerRuntime } from './protocol';
export class SqliteMemoryPersistence extends Disposable implements IMemoryPersistence {
  declare readonly _serviceBrand: undefined;
  readonly databasePath: string;
  private worker?: MemoryWorker;
  private closed = false;
  private closing?: Promise<void>;
  constructor(@IBootstrapService bootstrap: IBootstrapService) {
    super();
    this.databasePath = join(bootstrap.storeDir, 'memory-sqlite-v1', 'memory.sqlite');
    this._register(toDisposable(() => { trackQueryStoreDisposal(this.close()); }));
  }
  private operation<T>(operation: MemoryOperation): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Memory persistence closed'));
    if (this.worker?.isStopped) this.worker = undefined;
    this.worker ??= new MemoryWorker(this.databasePath);
    return this.worker.request(operation);
  }
  read(...[scopes, generation]: Parameters<IMemoryPersistence['read']>): ReturnType<IMemoryPersistence['read']> { return this.operation({ type: 'read', scopes, generation }); }
  revision(...[scope, id, revision]: Parameters<IMemoryPersistence['revision']>): ReturnType<IMemoryPersistence['revision']> { return this.operation({ type: 'revision', scope, id, revision }); }
  commit(input: MemoryCommit): ReturnType<IMemoryPersistence['commit']> { return this.operation({ type: 'commit', input }); }
  receipt(...[operationId, request]: Parameters<IMemoryPersistence['receipt']>): ReturnType<IMemoryPersistence['receipt']> { return this.operation({ type: 'receipt', operationId, request }); }
  journal(...[scope, id]: Parameters<IMemoryPersistence['journal']>): ReturnType<IMemoryPersistence['journal']> { return this.operation({ type: 'journal', scope, id }); }
  source(...[scope, id]: Parameters<IMemoryPersistence['source']>): ReturnType<IMemoryPersistence['source']> { return this.operation({ type: 'source', scope, id }); }
  provenance(...[scope, id]: Parameters<IMemoryPersistence['provenance']>): ReturnType<IMemoryPersistence['provenance']> { return this.operation({ type: 'provenance', scope, id }); }
  importLegacy(batch: readonly MemoryLegacyPayload[]): ReturnType<IMemoryPersistence['importLegacy']> { return this.operation({ type: 'importLegacy', batch }); }
  legacy(scope: string): ReturnType<IMemoryPersistence['legacy']> { return this.operation({ type: 'legacy', scope }); }
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    this.closing = this.worker?.close() ?? Promise.resolve();
    return this.closing;
  }
}
registerScopedService(LifecycleScope.App, IMemoryPersistence, SqliteMemoryPersistence, ScopeActivation.OnDemand, 'storage');
