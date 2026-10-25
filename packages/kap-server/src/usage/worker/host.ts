import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { UsageWireState } from '@kiki/agent-core-v2/agent/usage/usageWireFramer';
import { usageWorkerEntry } from './runtime';
import { USAGE_CHUNK_BYTES, type UsageWorkerMetrics, type UsageWorkerRequest, type UsageWorkerResponse } from './protocol';

type Result = Extract<UsageWorkerResponse, { type: 'result' }>;

export interface UsageWorkerObservation {
  readonly threadId: number;
  readonly startupMs: number;
  readonly roundTripMs: number;
  readonly inFlightBytes: number;
  readonly peakInFlightBytes: number;
  readonly worker?: UsageWorkerMetrics;
}

export class UsageParserWorker {
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private pending?: { id: number; resolve: (value: Result) => void; reject: (error: Error) => void; startedAt: number };
  private serial = 0;
  private stopped = false;
  private closing?: Promise<void>;
  private startupMs = 0;
  private roundTripMs = 0;
  private inFlightBytes = 0;
  private peakInFlightBytes = 0;
  private metrics?: UsageWorkerMetrics;
  private readonly startedAt = performance.now();
  private readonly openingTimer: ReturnType<typeof setTimeout>;
  private readonly signal: AbortSignal;
  private readonly abort: () => void;

  constructor(signal: AbortSignal, entry?: URL) {
    signal.throwIfAborted();
    this.signal = signal;
    const source = entry ?? resolveEntry();
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.worker = new Worker(source, { name: 'kiki-usage-parser', execArgv: source.pathname.endsWith('.ts') ? ['--experimental-transform-types', '--disable-warning=ExperimentalWarning'] : [], resourceLimits: { maxOldGenerationSizeMb: 128 } });
    this.openingTimer = setTimeout(() => { this.fail(new Error('Usage parser worker did not become ready')); }, 5000);
    this.abort = () => { this.fail(signal.reason instanceof Error ? signal.reason : new DOMException('Usage read cancelled', 'AbortError')); };
    signal.addEventListener('abort', this.abort, { once: true });
    this.worker.on('message', (event: UsageWorkerResponse) => {
      if (event.v !== 1) { this.fail(new Error('Usage worker protocol mismatch')); return; }
      if (event.type === 'ready') {
        clearTimeout(this.openingTimer);
        this.startupMs = performance.now() - this.startedAt;
        this.resolveReady();
      } else {
        const pending = this.pending;
        if (pending === undefined || pending.id !== event.id) return;
        this.pending = undefined;
        this.roundTripMs += performance.now() - pending.startedAt;
        this.inFlightBytes = 0;
        if (event.type === 'error') pending.reject(new Error(event.message));
        else { this.metrics = event.metrics; pending.resolve(event); }
      }
    });
    this.worker.on('error', (error) => { this.fail(error); });
    this.worker.on('exit', (code) => { if (!this.stopped) this.fail(new Error(`Usage worker exited (${code})`)); });
    void this.ready.catch(() => undefined);
  }

  async begin(offset: number, agentId: string | undefined, state: UsageWireState | undefined, allowance: SharedArrayBuffer, deadlineAt: number): Promise<void> {
    await this.ready;
    await this.request({ v: 1, id: ++this.serial, type: 'begin', offset, agentId, state, allowance, deadlineAt });
  }

  async chunk(bytes: ArrayBuffer, start: number, end: number): Promise<Result> {
    if (bytes.byteLength > USAGE_CHUNK_BYTES) throw new RangeError('Usage parser transfer exceeds one chunk');
    this.inFlightBytes = bytes.byteLength;
    this.peakInFlightBytes = Math.max(this.peakInFlightBytes, this.inFlightBytes);
    return this.request({ v: 1, id: ++this.serial, type: 'chunk', bytes, start, end }, [bytes]);
  }

  observation(): UsageWorkerObservation { return { threadId: this.worker.threadId, startupMs: this.startupMs, roundTripMs: this.roundTripMs, inFlightBytes: this.inFlightBytes, peakInFlightBytes: this.peakInFlightBytes, worker: this.metrics }; }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.stopped = true;
    clearTimeout(this.openingTimer);
    this.signal.removeEventListener('abort', this.abort);
    this.rejectReady(new Error('Usage worker closed'));
    this.pending?.reject(new Error('Usage worker closed'));
    this.pending = undefined;
    this.inFlightBytes = 0;
    this.closing = this.worker.terminate().then(() => undefined);
    return this.closing;
  }

  private request(request: UsageWorkerRequest, transfer: ArrayBuffer[] = []): Promise<Result> {
    this.signal.throwIfAborted();
    if (this.stopped) return Promise.reject(new Error('Usage worker closed'));
    if (this.pending !== undefined) return Promise.reject(new Error('Usage parser backpressure exceeded'));
    return new Promise((resolve, reject) => {
      this.pending = { id: request.id, resolve, reject, startedAt: performance.now() };
      try { this.worker.postMessage(request, transfer); }
      catch (error) { this.pending = undefined; reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private fail(error: Error): void {
    this.rejectReady(error);
    this.pending?.reject(error);
    this.pending = undefined;
    void this.close();
  }
}

function resolveEntry(): URL {
  const configured = usageWorkerEntry();
  if (configured !== undefined) return pathToFileURL(configured);
  for (const path of ['./entry.ts', './usage-parser-worker.mjs']) {
    const url = new URL(path, import.meta.url);
    try { if (statSync(url).isFile()) return url; } catch {}
  }
  throw new Error('Usage parser worker entry is unavailable');
}
