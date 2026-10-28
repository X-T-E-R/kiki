import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { memoryWorkerEntry, type MemoryOperation, type MemoryRequest, type MemoryResponse } from './protocol';

interface Pending {
  readonly operation: MemoryOperation;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}
export class MemoryWorker {
  private readonly worker: Worker;
  private readonly waiting: Pending[] = [];
  private active?: Pending;
  private serial = 0;
  private stopped = false;
  private closing?: Promise<void>;
  private readonly exited: Promise<void>;
  get isStopped(): boolean { return this.stopped; }
  constructor(database: string) {
    const configured = memoryWorkerEntry();
    const entry = configured === undefined ? resolveEntry() : pathToFileURL(configured);
    this.worker = new Worker(entry, { name: 'kiki-memory', workerData: { database }, execArgv: entry.pathname.endsWith('.ts') ? ['--experimental-transform-types', '--disable-warning=ExperimentalWarning'] : [], resourceLimits: { maxOldGenerationSizeMb: 128 } });
    this.worker.unref();
    this.exited = new Promise((resolve) => { this.worker.once('exit', () => { resolve(); }); });
    this.worker.on('message', (response: MemoryResponse) => {
      const pending = this.active;
      if (pending === undefined || response.id !== this.serial) return;
      this.active = undefined;
      if ('error' in response) pending.reject(Object.assign(new Error(response.error.message), { code: response.error.code, committed: response.error.committed }));
      else pending.resolve(response.result);
      this.pump();
    });
    this.worker.on('error', (error) => { this.fail(error); });
    this.worker.on('exit', (code) => { this.stopped = true; if (this.active !== undefined || this.waiting.length > 0) this.fail(new Error(`Memory worker exited (${code})`)); });
  }
  request<T>(operation: MemoryOperation): Promise<T> {
    if (this.stopped || this.closing !== undefined) return Promise.reject(new Error('Memory worker closed; reopen and reconcile the operation receipt'));
    if (this.waiting.length >= 128) return Promise.reject(Object.assign(new Error('Memory queue full'), { committed: false }));
    return this.enqueue(operation);
  }
  private enqueue<T>(operation: MemoryOperation): Promise<T> {
    return new Promise<T>((resolve, reject) => { this.waiting.push({ operation, resolve: (value) => { resolve(value as T); }, reject }); this.pump(); });
  }
  private pump(): void {
    if (this.active !== undefined || this.stopped) return;
    const pending = this.waiting.shift();
    if (pending === undefined) { if (this.closing === undefined) this.worker.unref(); return; }
    this.active = pending;
    this.worker.ref();
    try { this.worker.postMessage({ id: ++this.serial, operation: pending.operation } satisfies MemoryRequest, []); }
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
    for (const pending of [this.active, ...this.waiting]) if (pending !== undefined) pending.reject(Object.assign(new Error(`${error.message}; ${pending === this.active ? 'outcome unknown; reopen and read the persisted operation receipt' : 'request was not dispatched'}`, { cause: error }), { committed: pending === this.active ? undefined : false }));
    this.active = undefined;
    this.waiting.length = 0;
    void this.worker.terminate();
  }
}
function resolveEntry(): URL {
  for (const relative of ['./entry.ts', './memory-worker.mjs']) {
    const entry = new URL(relative, import.meta.url);
    try { if (statSync(entry).isFile()) return entry; } catch {}
  }
  throw new Error('Memory SQLite worker asset is unavailable');
}
