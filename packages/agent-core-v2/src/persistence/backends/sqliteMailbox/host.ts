import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { MAILBOX_QUEUE_FULL, mailboxWorkerEntry, type MailboxOperation, type MailboxRequest, type MailboxResponse } from './protocol';

const MAILBOX_MAX_WAITING = 128;

interface Pending {
  readonly operation: MailboxOperation;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly cancellation?: Int32Array;
  readonly abort?: () => void;
}

export class MailboxWorker {
  private readonly worker: Worker;
  private readonly waiting: Pending[] = [];
  private active?: Pending;
  private serial = 0;
  private stopped = false;
  private closing?: Promise<void>;
  private readonly exited: Promise<void>;

  constructor(database: string, create: boolean, readOnly: boolean) {
    const configured = mailboxWorkerEntry();
    const entry = configured === undefined ? resolveEntry() : pathToFileURL(configured);
    this.worker = new Worker(entry, {
      name: 'kiki-canonical-mailbox', workerData: { database, create, readOnly },
      execArgv: entry.pathname.endsWith('.ts') ? ['--experimental-transform-types', '--disable-warning=ExperimentalWarning'] : [],
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    this.worker.unref();
    this.exited = new Promise((resolve) => { this.worker.once('exit', () => resolve()); });
    this.worker.on('message', (response: MailboxResponse) => {
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
      if (this.active !== undefined || this.waiting.length > 0) this.fail(new Error(`Canonical mailbox worker exited (${code})`));
      this.stopped = true;
    });
  }

  request<T>(operation: MailboxOperation, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.stopped || this.closing !== undefined) return Promise.reject(new Error('Canonical mailbox worker closed; reopen and reconcile the request receipt'));
    if (this.waiting.length >= MAILBOX_MAX_WAITING) return Promise.reject(Object.assign(new Error('Canonical mailbox queue full; request was not dispatched'), { code: MAILBOX_QUEUE_FULL, committed: false }));
    return this.enqueue<T>(operation, signal);
  }

  private enqueue<T>(operation: MailboxOperation, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancellation = signal === undefined ? undefined : new Int32Array(new SharedArrayBuffer(4));
      const abort = signal === undefined ? undefined : (): void => {
        const index = this.waiting.indexOf(pending);
        if (index >= 0) { this.waiting.splice(index, 1); signal.removeEventListener('abort', abort!); reject(signal.reason); }
        else if (this.active === pending) Atomics.store(cancellation!, 0, 1);
      };
      const pending: Pending = { operation, signal, cancellation, abort, resolve: (value) => resolve(value as T), reject };
      signal?.addEventListener('abort', abort!, { once: true });
      this.waiting.push(pending);
      this.pump();
    });
  }

  private pump(): void {
    if (this.active !== undefined || this.stopped) return;
    const pending = this.waiting.shift();
    if (pending === undefined) { if (this.closing === undefined) this.worker.unref(); return; }
    this.active = pending;
    this.worker.ref();
    try { this.worker.postMessage({ id: ++this.serial, operation: pending.operation, cancellation: pending.cancellation?.buffer as SharedArrayBuffer | undefined } satisfies MailboxRequest); }
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
    for (const pending of [this.active, ...this.waiting]) {
      if (pending === undefined) continue;
      if (pending.abort !== undefined) pending.signal?.removeEventListener('abort', pending.abort);
      pending.reject(Object.assign(new Error(`${error.message}; ${pending === this.active ? 'outcome unknown; reopen and read the persisted request receipt' : 'request was not dispatched'}`, { cause: error }), { committed: pending === this.active ? undefined : false }));
    }
    this.active = undefined;
    this.waiting.length = 0;
    void this.worker.terminate();
  }
}

function resolveEntry(): URL {
  for (const relative of ['./entry.ts', './mailbox-worker.mjs']) {
    const entry = new URL(relative, import.meta.url);
    try { if (statSync(entry).isFile()) return entry; } catch {}
  }
  throw new Error('Canonical mailbox SQLite worker asset is unavailable');
}
