import { availableParallelism } from 'node:os';
import { Worker, type Transferable } from 'node:worker_threads';
import type { CpuRequest, CpuResponse } from './protocol';
import { fromErrorPayload } from '#/_base/errors/serialize';
import { RESOURCE_DEFAULTS } from '#/_base/node/resourceDefaults';

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const WARM_WORKER_FLOOR = 1;

export interface CpuPoolOptions {
  readonly maxWorkers?: number;
  readonly maxQueue?: number;
  readonly maxQueuedBytes?: number;
  readonly timeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

export interface CpuRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly transferList?: readonly Transferable[];
  readonly bytes?: number;
}

export class CpuWorkerError extends Error {
  constructor(readonly code: 'CPU_QUEUE_FULL' | 'CPU_TIMEOUT' | 'CPU_WORKER_EXIT' | 'CPU_POOL_CLOSED', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CpuWorkerError';
  }
}

interface Pending {
  readonly id: number;
  readonly operation: unknown;
  readonly options: CpuRequestOptions;
  readonly bytes: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  abort?: () => void;
}

interface Slot {
  worker?: Worker;
  active?: Pending;
  retiring?: Promise<number>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export class CpuWorkerPool {
  readonly size: number;
  private readonly slots: Slot[] = [];
  private readonly waiting: Pending[] = [];
  private readonly maxQueue: number;
  private readonly maxQueuedBytes: number;
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;
  private queuedBytes = 0;
  private serial = 0;
  private closing?: Promise<void>;

  constructor(private readonly entry: URL, options: CpuPoolOptions = {}) {
    const cap = positiveInteger(options.maxWorkers ?? RESOURCE_DEFAULTS.cpuWorkers, 'maxWorkers');
    this.size = Math.max(1, Math.min(availableParallelism() - 1, cap));
    this.maxQueue = positiveInteger(options.maxQueue ?? RESOURCE_DEFAULTS.cpuQueue, 'maxQueue');
    this.maxQueuedBytes = positiveInteger(options.maxQueuedBytes ?? RESOURCE_DEFAULTS.cpuQueuedBytes, 'maxQueuedBytes');
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 30_000, 'timeoutMs');
    this.idleTimeoutMs = positiveInteger(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, 'idleTimeoutMs');
  }

  get liveWorkerCount(): number {
    let count = 0;
    for (const slot of this.slots) {
      if (slot.worker !== undefined && slot.retiring === undefined) count += 1;
    }
    return count;
  }

  request<T>(operation: unknown, options: CpuRequestOptions = {}): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    if (this.closing !== undefined) return Promise.reject(new CpuWorkerError('CPU_POOL_CLOSED', 'CPU worker pool is closed'));
    const timeoutMs = positiveInteger(options.timeoutMs ?? this.timeoutMs, 'timeoutMs');
    const bytes = options.bytes ?? options.transferList?.reduce((sum, value) => sum + (value instanceof ArrayBuffer ? value.byteLength : 0), 0) ?? 0;
    if (!Number.isSafeInteger(bytes) || bytes < 0) return Promise.reject(new RangeError('CPU request bytes must be a nonnegative safe integer'));
    if (this.waiting.length >= this.maxQueue || this.queuedBytes + bytes > this.maxQueuedBytes) {
      return Promise.reject(new CpuWorkerError('CPU_QUEUE_FULL', 'CPU worker queue is full; retry after active work completes'));
    }
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = { id: ++this.serial, operation, options, bytes, resolve: (value) => { resolve(value as T); }, reject };
      pending.abort = () => { this.cancel(pending, options.signal!.reason); };
      options.signal?.addEventListener('abort', pending.abort, { once: true });
      pending.timer = setTimeout(() => { this.cancel(pending, new CpuWorkerError('CPU_TIMEOUT', 'CPU worker request timed out')); }, timeoutMs);
      this.waiting.push(pending);
      this.queuedBytes += bytes;
      this.pump();
    });
  }

  private pump(): void {
    if (this.closing !== undefined) return;
    while (this.waiting.length > 0) {
      let slot = this.slots.find((candidate) => candidate.worker !== undefined && candidate.active === undefined && candidate.retiring === undefined)
        ?? this.slots.find((candidate) => candidate.active === undefined && candidate.retiring === undefined);
      if (slot === undefined) {
        if (this.slots.length >= this.size) break;
        slot = {};
        this.slots.push(slot);
      }
      this.clearIdleTimer(slot);
      const pending = this.waiting.shift()!;
      this.queuedBytes -= pending.bytes;
      slot.active = pending;
      try {
        const worker = slot.worker ?? this.spawn(slot);
        worker.ref();
        worker.postMessage({ id: pending.id, operation: pending.operation } satisfies CpuRequest, optionsTransfer(pending.options));
      } catch (error) {
        this.settle(pending, new CpuWorkerError('CPU_WORKER_EXIT', 'CPU worker dispatch failed', { cause: error }));
        slot.active = undefined;
        void this.retire(slot);
      }
    }
    this.reconcileIdleTimers();
  }

  private clearIdleTimer(slot: Slot): void {
    if (slot.idleTimer !== undefined) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = undefined;
    }
  }

  private reconcileIdleTimers(): void {
    if (this.closing !== undefined || this.waiting.length > 0) {
      for (const slot of this.slots) this.clearIdleTimer(slot);
      return;
    }
    const live = this.slots.filter((slot) => slot.worker !== undefined && slot.retiring === undefined);
    if (live.length <= WARM_WORKER_FLOOR) {
      for (const slot of this.slots) this.clearIdleTimer(slot);
      return;
    }
    let warmReserved = live.filter((slot) => slot.active !== undefined).length;
    for (const slot of live) {
      if (slot.active !== undefined) {
        this.clearIdleTimer(slot);
        continue;
      }
      if (warmReserved < WARM_WORKER_FLOOR) {
        warmReserved += 1;
        this.clearIdleTimer(slot);
        continue;
      }
      if (slot.idleTimer === undefined) {
        slot.idleTimer = setTimeout(() => { this.onIdleTimeout(slot); }, this.idleTimeoutMs);
        slot.idleTimer.unref?.();
      }
    }
  }

  private onIdleTimeout(slot: Slot): void {
    slot.idleTimer = undefined;
    if (
      this.closing !== undefined ||
      slot.active !== undefined ||
      slot.worker === undefined ||
      slot.retiring !== undefined ||
      this.waiting.length > 0 ||
      this.liveWorkerCount <= WARM_WORKER_FLOOR
    ) {
      this.reconcileIdleTimers();
      return;
    }
    void this.retire(slot);
    this.reconcileIdleTimers();
  }

  private spawn(slot: Slot): Worker {
    const worker = new Worker(this.entry, {
      name: 'kiki-cpu',
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: RESOURCE_DEFAULTS.workerHeapMb },
    });
    slot.worker = worker;
    worker.on('message', (response: CpuResponse) => {
      const pending = slot.active;
      if (slot.worker !== worker || pending === undefined || response.id !== pending.id || slot.retiring !== undefined) return;
      slot.active = undefined;
      if ('error' in response) this.settle(pending, response.error.payload === undefined
        ? Object.assign(new Error(response.error.message), { name: response.error.name, code: response.error.code })
        : fromErrorPayload(response.error.payload));
      else this.settle(pending, undefined, response.result);
      worker.unref();
      this.pump();
    });
    worker.on('error', (cause) => {
      if (slot.worker !== worker) return;
      if (slot.active !== undefined) this.settle(slot.active, new CpuWorkerError('CPU_WORKER_EXIT', 'CPU worker failed', { cause }));
      slot.active = undefined;
      void this.retire(slot);
      this.reconcileIdleTimers();
    });
    worker.on('exit', (code) => {
      if (slot.worker !== worker) return;
      this.clearIdleTimer(slot);
      if (slot.active !== undefined) this.settle(slot.active, new CpuWorkerError('CPU_WORKER_EXIT', `CPU worker exited (${code})`));
      slot.active = undefined;
      slot.worker = undefined;
      slot.retiring = undefined;
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots.splice(index, 1);
      this.pump();
    });
    return worker;
  }

  private cancel(pending: Pending, error: unknown): void {
    const index = this.waiting.indexOf(pending);
    if (index >= 0) {
      this.waiting.splice(index, 1);
      this.queuedBytes -= pending.bytes;
      this.settle(pending, error);
      return;
    }
    const slot = this.slots.find((candidate) => candidate.active === pending);
    if (slot === undefined) return;
    slot.active = undefined;
    const retired = this.retire(slot);
    this.reconcileIdleTimers();
    void Promise.resolve(retired).then(() => this.settle(pending, error), () => this.settle(pending, error));
  }

  private retire(slot: Slot): Promise<number> | undefined {
    this.clearIdleTimer(slot);
    if (slot.worker === undefined || slot.retiring !== undefined) return slot.retiring;
    slot.retiring = slot.worker.terminate();
    void slot.retiring.catch(() => {});
    return slot.retiring;
  }

  private settle(pending: Pending, error?: unknown, value?: unknown): void {
    clearTimeout(pending.timer);
    pending.options.signal?.removeEventListener('abort', pending.abort!);
    if (error === undefined) pending.resolve(value);
    else pending.reject(error);
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    const error = new CpuWorkerError('CPU_POOL_CLOSED', 'CPU worker pool is closed');
    this.closing = Promise.resolve();
    for (const pending of this.waiting.splice(0)) this.settle(pending, error);
    this.queuedBytes = 0;
    const retiring: Promise<number>[] = [];
    for (const slot of [...this.slots]) {
      this.clearIdleTimer(slot);
      if (slot.active !== undefined) this.settle(slot.active, error);
      slot.active = undefined;
      const termination = this.retire(slot);
      if (termination !== undefined) retiring.push(termination);
    }
    this.closing = Promise.all(retiring).then(() => {});
    return this.closing;
  }
}

function optionsTransfer(options: CpuRequestOptions): Transferable[] {
  return [...(options.transferList ?? [])];
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}
