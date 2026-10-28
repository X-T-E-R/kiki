import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { usageReadModelWorkerEntry, type UsageStoreOperation, type UsageStoreRequest, type UsageStoreResponse } from './usageProtocol';

interface Pending {
  readonly operation: UsageStoreOperation;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  readonly cancellation?: Int32Array;
  readonly abort?: () => void;
  watchdog?: ReturnType<typeof setTimeout>;
}

export class UsageReadModelWorker {
  private readonly worker: Worker;
  private readonly waiting: Pending[] = [];
  private active?: Pending;
  private serial = 0;
  private stopped = false;
  private closing?: Promise<void>;
  private readonly exited: Promise<void>;

  constructor(database: string, private readonly writable: boolean) {
    const configured = usageReadModelWorkerEntry();
    const entry = configured === undefined ? resolveEntry() : pathToFileURL(configured);
    this.worker = new Worker(entry, { name: writable ? 'kiki-usage-writer' : 'kiki-usage-reader', workerData: { database, writable }, execArgv: entry.pathname.endsWith('.ts') ? ['--experimental-transform-types', '--disable-warning=ExperimentalWarning'] : [], resourceLimits: { maxOldGenerationSizeMb: 128 } });
    this.worker.unref();
    this.exited = new Promise((resolve) => { this.worker.once('exit', () => resolve()); });
    this.worker.on('message', (response: UsageStoreResponse) => {
      if (this.active === undefined || response.id !== this.serial) return;
      const pending = this.active;
      this.active = undefined;
      this.release(pending);
      if ('error' in response) pending.reject(Object.assign(new Error(response.error.message), { code: response.error.code, committed: response.error.committed }));
      else pending.resolve(response.result);
      this.pump();
    });
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) => { if (this.active !== undefined || this.waiting.length > 0) this.fail(new Error(`Usage worker exited (${code})`)); this.stopped = true; });
  }
  get isStopped(): boolean { return this.stopped; }
  request<T>(operation: UsageStoreOperation, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.stopped || this.closing !== undefined) return Promise.reject(new Error('Usage worker closed'));
    if (this.waiting.length >= 16) return Promise.reject(Object.assign(new Error('Usage queue full; retry'), { code: 'usage.busy' }));
    return this.enqueue(operation, signal);
  }
  private enqueue<T>(operation: UsageStoreOperation, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancellation = signal === undefined ? undefined : new Int32Array(new SharedArrayBuffer(4));
      const abort = signal === undefined ? undefined : (): void => {
        const index = this.waiting.indexOf(pending);
        if (index >= 0) { this.waiting.splice(index, 1); this.release(pending); reject(signal.reason); }
        else if (this.active === pending) {
          Atomics.store(cancellation!, 0, 1);
          if (!this.writable) pending.watchdog ??= setTimeout(() => this.fail(signal.reason), 100);
        }
      };
      const pending: Pending = { operation, signal, cancellation, abort, resolve: (value) => resolve(value as T), reject };
      signal?.addEventListener('abort', abort!, { once: true });
      this.waiting.push(pending);
      this.pump();
    });
  }
  private release(pending: Pending): void {
    if (pending.abort !== undefined) pending.signal?.removeEventListener('abort', pending.abort);
    if (pending.watchdog !== undefined) clearTimeout(pending.watchdog);
  }
  private pump(): void {
    if (this.stopped || this.active !== undefined) return;
    const pending = this.waiting.shift();
    if (pending === undefined) { this.worker.unref(); return; }
    this.active = pending;
    this.worker.ref();
    try { this.worker.postMessage({ id: ++this.serial, operation: pending.operation, cancellation: pending.cancellation?.buffer as SharedArrayBuffer | undefined } satisfies UsageStoreRequest); }
    catch (error) { this.fail(error); }
  }
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    if (this.stopped) return this.exited;
    const drain = this.enqueue<void>({ type: 'close' });
    this.closing = (async () => { try { await drain; } finally { await this.exited; } })();
    return this.closing;
  }
  private fail(error: unknown): void {
    this.stopped = true;
    for (const pending of [this.active, ...this.waiting]) {
      if (pending === undefined) continue;
      this.release(pending);
      const writing = ['apply', 'catalog', 'maintain', 'abandon', 'invalidate', 'settleRetained'].includes(pending.operation.type);
      pending.reject(writing ? Object.assign(new Error('Usage worker stopped; reconcile persisted source progress before retry', { cause: error }), { committed: pending === this.active ? undefined : false }) : error);
    }
    this.active = undefined;
    this.waiting.length = 0;
    void this.worker.terminate();
  }
}

function resolveEntry(): URL {
  for (const relative of ['./usageEntry.ts', './usage-read-model-worker.mjs']) {
    const entry = new URL(relative, import.meta.url);
    try { if (statSync(entry).isFile()) return entry; } catch {}
  }
  throw new Error('Usage read-model worker asset is unavailable');
}
