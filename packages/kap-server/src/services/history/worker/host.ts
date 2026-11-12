import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { RESOURCE_DEFAULTS } from '@kiki/agent-core-v2/_base/node/resourceDefaults';
import { abortable } from '@kiki/agent-core-v2/_base/utils/abort';
import type { TranscriptService } from '../../transcript/transcriptService';
import { navigationError, type NavigationCallbackResult, type NavigationMethod, type NavigationReport, type NavigationRequest, type NavigationResponse } from './protocol';

interface Pending {
  readonly request: NavigationRequest;
  readonly controller: AbortController;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly release: () => void;
}

const CANONICAL_OPERATIONS = new Set<NavigationRequest['method']>(['readCanonicalEntity', 'readCanonicalTurnHeader',
  'readCanonicalTurnHeaders', 'lookupToolCall', 'readDurableTurn', 'prepareResidentProof', 'proveResident', 'checkResidentFailure']);

export class HistoryNavigationWorker {
  private worker?: Worker;
  private active?: Pending;
  private readonly waiting: Pending[] = [];
  private serial = 0;
  private closing?: Promise<void>;
  private exited?: Promise<void>;
  private retiring?: Promise<void>;
  report?: NavigationReport;
  retainedBodyChars = 0;

  constructor(private readonly database: string, private readonly transcript: TranscriptService) {}

  async request<T>(method: NavigationMethod, args: readonly unknown[], signal?: AbortSignal,
    target?: { session: string; agent: string }): Promise<T> {
    signal?.throwIfAborted();
    if (this.closing !== undefined) throw new Error('history navigation worker closed');
    if (this.waiting.length >= RESOURCE_DEFAULTS.workerQueue) throw new Error('history_navigation_busy');
    return this.enqueue<T>(method, args, signal, target);
  }

  invalidate(): void {
    if (this.closing !== undefined) return;
    this.report = undefined;
    const reason = new DOMException('Detail scope changed', 'AbortError');
    for (const pending of [this.active, ...this.waiting]) {
      if (pending !== undefined && CANONICAL_OPERATIONS.has(pending.request.method)) pending.controller.abort(reason);
    }
    if (this.worker !== undefined) void this.request('invalidateCanonical', []).catch(() => undefined);
  }

  private enqueue<T>(method: NavigationRequest['method'], args: readonly unknown[], signal?: AbortSignal,
    target?: { session: string; agent: string }): Promise<T> {
    const request: NavigationRequest = { id: ++this.serial, method, args, cancellation: new SharedArrayBuffer(4),
      session: target?.session, agent: target?.agent,
      detailBudget: method === 'close' ? 0 : this.transcript.detailCacheBudgetBytes() };
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const relay = () => controller.abort(signal?.reason);
      const abort = () => {
        Atomics.store(new Int32Array(request.cancellation), 0, 1);
        const index = this.waiting.indexOf(pending);
        if (index >= 0) { this.waiting.splice(index, 1); pending.release(); }
        reject(controller.signal.reason);
      };
      const pending: Pending = { request, controller, resolve: value => resolve(value as T), reject,
        release: () => {
          signal?.removeEventListener('abort', relay);
          controller.signal.removeEventListener('abort', abort);
        } };
      this.waiting.push(pending);
      signal?.addEventListener('abort', relay, { once: true });
      controller.signal.addEventListener('abort', abort, { once: true });
      this.pump();
    });
  }

  private start(): Worker {
    if (this.worker !== undefined) return this.worker;
    const configured = process.env['KIKI_HISTORY_NAVIGATION_WORKER_ENTRY'];
    const entry = configured === undefined ? resolveEntry() : pathToFileURL(configured);
    const worker = new Worker(entry, { name: 'kiki-history-navigation', workerData: { database: this.database },
      execArgv: [], resourceLimits: { maxOldGenerationSizeMb: RESOURCE_DEFAULTS.workerHeapMb } });
    this.worker = worker;
    this.exited = new Promise(resolve => worker.once('exit', () => resolve()));
    worker.on('message', (response: NavigationResponse) => {
      if (this.worker !== worker) return;
      if ('type' in response) { void this.callback(worker, response); return; }
      const pending = this.active;
      if (pending?.request.id !== response.id) return;
      this.active = undefined;
      this.report = response.report ?? this.report;
      this.retainedBodyChars = response.retainedBodyChars ?? this.retainedBodyChars;
      pending.release();
      if (response.error !== undefined) pending.reject(Object.assign(new Error(response.error.message), response.error));
      else pending.resolve(response.result);
      if (pending.request.method !== 'close') this.pump();
    });
    worker.on('error', error => this.retire(worker, error, true));
    worker.on('exit', code => this.retire(worker, new Error(`History navigation worker exited (${code})`), false));
    return worker;
  }

  private async callback(worker: Worker, response: Extract<NavigationResponse, { type: 'callback' }>): Promise<void> {
    const pending = this.active;
    if (pending?.request.id !== response.request) return;
    let result: NavigationCallbackResult;
    try {
      const signal = pending.controller.signal;
      signal.throwIfAborted();
      const value = await abortable(this.transcript[response.method](...response.args, signal), signal);
      result = { type: 'callbackResult', id: response.id, result: value };
    } catch (error) {
      result = { type: 'callbackResult', id: response.id, error: navigationError(error) };
    }
    if (this.worker !== worker) return;
    try { worker.postMessage(result); }
    catch (error) { this.retire(worker, error, true); }
  }

  private pump(): void {
    if (this.active !== undefined || this.retiring !== undefined) return;
    const pending = this.waiting.shift();
    if (pending === undefined) { this.worker?.unref(); return; }
    this.active = pending;
    void this.dispatch(pending);
  }

  private async dispatch(pending: Pending): Promise<void> {
    const { request, controller: { signal } } = pending;
    try {
      const { session, agent } = request;
      const location = session === undefined || agent === undefined ? undefined :
        await abortable(this.transcript.historyWireLocation(session, agent), signal);
      signal.throwIfAborted();
      const worker = this.start();
      worker.ref();
      worker.postMessage({ ...request, location });
    } catch (error) {
      if (this.active !== pending) return;
      this.active = undefined;
      pending.release();
      pending.reject(error);
      this.pump();
    }
  }

  private retire(worker: Worker, error: unknown, terminate: boolean): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    this.report = undefined;
    this.retainedBodyChars = 0;
    const pending = this.active;
    this.active = undefined;
    pending?.controller.abort(error);
    pending?.release();
    if (this.closing !== undefined) for (const item of this.waiting.slice()) item.controller.abort(error);
    if (terminate) void worker.terminate();
    this.retiring = this.exited!.then(() => { this.retiring = undefined; this.pump(); });
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    const reason = new Error('history navigation worker closed');
    for (const pending of this.waiting.slice()) pending.controller.abort(reason);
    this.active?.controller.abort(reason);
    const worker = this.worker;
    if (worker === undefined) return this.closing = this.retiring ?? Promise.resolve();
    const exited = this.exited!;
    const drained = this.enqueue<void>('close', []);
    const timer = setTimeout(() => { this.retire(worker, new Error('history navigation shutdown timed out'), true); }, 5000);
    return this.closing = (async () => {
      try { await drained; }
      finally { await exited; clearTimeout(timer); }
    })();
  }
}

function resolveEntry(): URL {
  for (const path of ['./sourceEntry.mjs', './history-navigation-worker.mjs']) {
    const entry = new URL(path, import.meta.url);
    try { if (statSync(entry).isFile()) return entry; } catch {}
  }
  throw new Error('History navigation worker asset is unavailable');
}
