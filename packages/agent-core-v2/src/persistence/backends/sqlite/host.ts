import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { RESOURCE_DEFAULTS } from '#/_base/node/resourceDefaults';
import { queryStoreWorkerEntry, type StoreOperation, type StoreRequest, type StoreResponse } from './protocol';
import { QueryStoreBusyError } from '#/persistence/interface/queryStore';

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly operation: StoreOperation;
  readonly priority: boolean;
  readonly signal?: AbortSignal;
  readonly cancellation?: Int32Array;
  readonly abort?: () => void;
}

const MAX_PRIORITY_BURST = 4;

function isPriorityRead(operation: StoreOperation): boolean {
  return operation.type === 'get' && operation.priority === true;
}

export class QueryStoreWorker {
  private readonly worker: Worker;
  private readonly priorityWaiting: Pending[] = [];
  private readonly waiting: Pending[] = [];
  private priorityStreak = 0;
  private active?: Pending;
  private serial = 0;
  private stopped = false;
  private closing?: Promise<void>;
  private readonly exited: Promise<void>;

  constructor(database: string) {
    const configured = queryStoreWorkerEntry();
    const entry = configured === undefined ? resolveEntry() : pathToFileURL(configured);
    this.worker = new Worker(entry, {
      name: 'kiki-query-store', workerData: { database },
      execArgv: entry.pathname.endsWith('.ts') ? ['--experimental-transform-types', '--disable-warning=ExperimentalWarning'] : [],
      resourceLimits: { maxOldGenerationSizeMb: RESOURCE_DEFAULTS.workerHeapMb },
    });
    this.worker.unref();
    this.exited = new Promise((resolve) => { this.worker.once('exit', () => resolve()); });
    this.worker.on('message', (response: StoreResponse) => {
      const pending = this.active;
      if (pending === undefined || response.id !== this.serial) return;
      this.active = undefined;
      if (pending.abort !== undefined) pending.signal?.removeEventListener('abort', pending.abort);
      if ('error' in response) pending.reject(Object.assign(new Error(response.error.message), { code: response.error.code, committed: response.error.committed }));
      else pending.resolve(response.result);
      this.pump();
    });
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) => {
      if (this.active !== undefined || this.priorityWaiting.length > 0 || this.waiting.length > 0) this.fail(new Error(`Query store worker exited (${code})`));
      this.stopped = true;
    });
  }

  request<T>(operation: StoreOperation, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.stopped || this.closing !== undefined) return Promise.reject(new Error('Query store worker closed'));
    const queue = isPriorityRead(operation) ? this.priorityWaiting : this.waiting;
    if (queue.length >= RESOURCE_DEFAULTS.workerQueue) return Promise.reject(new QueryStoreBusyError());
    return this.enqueue<T>(operation, signal);
  }

  get isStopped(): boolean { return this.stopped; }

  private enqueue<T>(operation: StoreOperation, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const priority = isPriorityRead(operation);
      const queue = priority ? this.priorityWaiting : this.waiting;
      const cancellation = signal === undefined ? undefined : new Int32Array(new SharedArrayBuffer(4));
      const abort = signal === undefined ? undefined : (): void => {
        const index = queue.indexOf(pending);
        if (index >= 0) { queue.splice(index, 1); signal.removeEventListener('abort', abort!); reject(signal.reason); }
        else if (this.active === pending) Atomics.store(cancellation!, 0, 1);
      };
      const pending: Pending = { operation, priority, signal, cancellation, abort, resolve: (value) => resolve(value as T), reject };
      signal?.addEventListener('abort', abort!, { once: true });
      queue.push(pending);
      this.pump();
    });
  }

  private pump(): void {
    if (this.active !== undefined || this.stopped) return;
    const takePriority = this.priorityWaiting.length > 0 &&
      (this.waiting.length === 0 || this.priorityStreak < MAX_PRIORITY_BURST);
    const pending = takePriority ? this.priorityWaiting.shift() : this.waiting.shift() ?? this.priorityWaiting.shift();
    if (pending === undefined) { if (this.closing === undefined) this.worker.unref(); return; }
    this.priorityStreak = pending.priority ? this.priorityStreak + 1 : 0;
    this.active = pending;
    this.worker.ref();
    try { this.worker.postMessage({ id: ++this.serial, operation: pending.operation, cancellation: pending.cancellation?.buffer as SharedArrayBuffer | undefined } satisfies StoreRequest); }
    catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    if (this.stopped) return this.exited;
    const drain = this.enqueue<void>({ type: 'close' });
    this.closing = (async () => { try { await drain; } finally { await this.exited; } })();
    return this.closing;
  }

  private fail(error: Error): void {
    this.stopped = true;
    for (const pending of [this.active, ...this.priorityWaiting, ...this.waiting]) {
      if (pending === undefined) continue;
      if (pending.abort !== undefined) pending.signal?.removeEventListener('abort', pending.abort);
      const writing = pending.operation.type === 'batch' || pending.operation.type === 'drop' || pending.operation.type === 'index';
      pending.reject(writing ? Object.assign(new Error(`${error.message}${pending === this.active ? '; write outcome must be reconciled from source' : '; write was not dispatched'}`, { cause: error }), { committed: pending === this.active ? undefined : false }) : error);
    }
    this.active = undefined;
    this.priorityWaiting.length = 0;
    this.waiting.length = 0;
    void this.worker.terminate();
  }
}

function resolveEntry(): URL {
  for (const relative of ['./entry.ts', './query-store-worker.mjs']) {
    const entry = new URL(relative, import.meta.url);
    try { if (statSync(entry).isFile()) return entry; } catch {}
  }
  throw new Error('Query-store SQLite worker asset is unavailable');
}
