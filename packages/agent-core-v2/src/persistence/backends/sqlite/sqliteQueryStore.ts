import { createHash, randomUUID } from 'node:crypto';
import { join } from 'pathe';
import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import { acquireFileLock } from '#/persistence/backends/node-fs/fileLock';
import { IQueryStore, type Checkpoint, type ColumnBounds, type ColumnPageQuery, type IndexDef, type IQuery, type Page, type QueryFilter, type QueryStaging, type SortDir, type StagedWrite, type WriteCondition, type WriteOp } from '#/persistence/interface/queryStore';
import { isStorageError, StorageErrors, type IStorageLock } from '#/persistence/interface/storage';
import { trackQueryStoreDisposal } from '#/persistence/queryStoreDisposals';
import { QueryStoreWorker } from './host';
import type { ReadQuery, StoreOperation } from './protocol';

export { configureQueryStoreWorkerRuntime } from './protocol';
export const SQLITE_QUERY_STORE_SUBDIR = 'query-store-sqlite-v1';
const STAGING = '__query_staging_v1__';

interface StagingOwner {
  readonly id: string;
  readonly source: string;
}

export class SqliteQueryStore extends Disposable implements IQueryStore {
  declare readonly _serviceBrand: undefined;
  private readonly directory: string;
  private worker?: QueryStoreWorker;
  private opening?: Promise<void>;
  private readonly staging = new Map<string, IStorageLock>();
  private recovery?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;

  constructor(
    @IBootstrapService bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.directory = join(bootstrap.cacheDir, SQLITE_QUERY_STORE_SUBDIR);
    this._register(toDisposable(() => { trackQueryStoreDisposal(this.close()); }));
  }

  private async ready(): Promise<QueryStoreWorker> {
    await this.recovery;
    if (this.closed) throw new Error('Query store closed');
    if (this.worker?.isStopped) await this.recover();
    if (this.closed) throw new Error('Query store closed');
    if (this.worker === undefined) {
      this.log.info('SQLite query-store opening', { directory: this.directory });
      this.worker = new QueryStoreWorker(join(this.directory, 'index.sqlite'));
      this.opening = this.reclaimStaging(this.worker);
    }
    const worker = this.worker;
    await this.opening;
    return worker;
  }

  private async request<T>(operation: StoreOperation, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const worker = await this.ready();
    signal?.throwIfAborted();
    return worker.request<T>(operation, signal);
  }

  private async reclaimStaging(worker: QueryStoreWorker): Promise<void> {
    const owners = await worker.request<Page<StagingOwner>>({ type: 'query', query: { collection: STAGING } });
    for (const owner of owners.items) {
      if (typeof owner.source !== 'string' || !/^[a-f0-9-]{36}$/.test(owner.id)) throw new Error('Invalid query staging owner');
      if (this.staging.has(owner.id)) continue;
      let lease: IStorageLock;
      try { lease = await acquireFileLock(join(this.directory, `${owner.id}.stage.lock`)); }
      catch (error) { if (isStorageError(error, StorageErrors.codes.STORAGE_LOCKED)) continue; throw error; }
      try { await this.removeStaging(worker, owner); } finally { await lease.release(); }
    }
  }

  private async removeStaging(worker: QueryStoreWorker, owner: StagingOwner): Promise<void> {
    const stage = `${owner.source}:stage:${owner.id}`;
    await worker.request({ type: 'drop', collection: stage });
    await worker.request({ type: 'drop', collection: `${stage}:publish` });
    await worker.request({ type: 'batch', ops: [{ kind: 'delete', collection: STAGING, key: owner.id }] });
  }

  async createStaging(source: string): Promise<QueryStaging> {
    const worker = await this.ready();
    await this.reclaimStaging(worker);
    const owner = { id: randomUUID(), source };
    const lease = await acquireFileLock(join(this.directory, `${owner.id}.stage.lock`), { owner: { kind: 'query-staging', source } });
    this.staging.set(owner.id, lease);
    try { await this.put(STAGING, owner.id, owner); }
    catch (error) { this.staging.delete(owner.id); await lease.release(); throw error; }
    const stage = `${source}:stage:${owner.id}`;
    let disposal: Promise<void> | undefined;
    return { stage, publication: `${stage}:publish`, dispose: () => disposal ??= (async () => {
      try { await this.removeStaging(await this.ready(), owner); }
      finally { this.staging.delete(owner.id); await lease.release(); }
    })() };
  }

  async put<T>(collection: string, key: string, value: T, options?: { columns?: Record<string, number> }): Promise<void> {
    await this.batch([{ kind: 'put', collection, key, value, columns: options?.columns }]);
  }

  async batch(ops: readonly WriteOp[]): Promise<void> { if (ops.length > 0) await this.request({ type: 'batch', ops }); }
  batchIf(conditions: readonly WriteCondition[], ops: readonly WriteOp[], staged?: StagedWrite): Promise<boolean> { return this.request({ type: 'batch', conditions, ops, staged }); }
  async delete(collection: string, key: string): Promise<void> { await this.batch([{ kind: 'delete', collection, key }]); }
  async get<T>(collection: string, key: string, signal?: AbortSignal): Promise<T | undefined> { return (await this.getMany<T>(collection, [key], signal)).get(key); }
  async getMany<T>(collection: string, keys: readonly string[], signal?: AbortSignal): Promise<Map<string, T>> {
    if (keys.length === 0) return new Map();
    return new Map(await this.request<Array<[string, T]>>({ type: 'get', collection, keys }, signal));
  }
  query<T>(collection: string): IQuery<T> { return new SqliteQuery((query, signal) => this.request({ type: 'query', query }, signal), collection); }
  pageByColumn<T>(collection: string, query: ColumnPageQuery, signal?: AbortSignal): Promise<Page<T>> {
    return this.request({ type: 'query', query: { collection, column: { name: query.column, bounds: query.bounds ?? {} }, columnOrder: query.dir ?? 'asc', limit: query.limit, filter: query.filter } }, signal);
  }
  async ensureIndex(collection: string, definition: IndexDef): Promise<void> { await this.request({ type: 'index', collection, definition }); }
  listKeys(collection: string): Promise<readonly string[]> { return this.request({ type: 'keys', collection }); }
  async dropCollection(collection: string): Promise<void> { await this.request({ type: 'drop', collection }); }
  getCheckpoint(source: string): Promise<Checkpoint | undefined> { return this.get('__checkpoint__', source); }
  setCheckpoint(source: string, checkpoint: Checkpoint): Promise<void> { return this.put('__checkpoint__', source, checkpoint); }

  async withExclusive<T>(operation: () => Promise<T>, source?: string): Promise<T> {
    const name = source === undefined ? 'session-index' : createHash('sha256').update(source).digest('hex');
    const lock = await acquireFileLock(join(this.directory, `${name}.lock`), { waitForMs: 30_000, owner: { kind: 'query-projection', source } });
    try { return await operation(); } finally { await lock.release(); }
  }

  recover(): Promise<void> {
    if (this.recovery !== undefined) return this.recovery;
    const worker = this.worker;
    const flight = (async () => {
      await this.opening?.catch(() => undefined);
      try { await worker?.close(); }
      finally { if (this.worker === worker) { this.worker = undefined; this.opening = undefined; } }
    })();
    this.recovery = flight.finally(() => { this.recovery = undefined; });
    return this.recovery;
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      try {
        await this.recovery;
        await this.opening?.catch(() => undefined);
        await this.worker?.close();
        this.worker = undefined;
        this.opening = undefined;
      } finally {
        await Promise.all([...this.staging.values()].map((lease) => lease.release()));
        this.staging.clear();
      }
    })();
    return this.closing;
  }
}

class SqliteQuery<T> implements IQuery<T> {
  private filter: QueryFilter = {};
  private column?: ReadQuery['column'];
  private sort?: ReadQuery['sort'];
  private count?: number;
  private continuation?: string;
  constructor(private readonly executeQuery: (query: ReadQuery, signal?: AbortSignal) => Promise<Page<T>>, private readonly collection: string) {}
  where(filter: QueryFilter): IQuery<T> { this.filter = { ...this.filter, ...filter }; return this; }
  whereColumn(name: string, bounds: ColumnBounds): IQuery<T> { this.column = { name, bounds }; return this; }
  orderBy(field: string, dir: SortDir = 'asc'): IQuery<T> { this.sort = { field, dir }; return this; }
  limit(count: number): IQuery<T> { this.count = count; return this; }
  cursor(cursor: string | undefined): IQuery<T> { this.continuation = cursor; return this; }
  execute(signal?: AbortSignal): Promise<Page<T>> { return this.executeQuery({ collection: this.collection, filter: this.filter, column: this.column, sort: this.sort, limit: this.count, cursor: this.continuation }, signal); }
}

registerScopedService(LifecycleScope.App, IQueryStore, SqliteQueryStore, ScopeActivation.OnScopeCreated, 'storage');
