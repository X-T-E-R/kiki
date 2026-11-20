import { availableParallelism } from 'node:os';
import { Worker, type Transferable } from 'node:worker_threads';
import type { CpuRequest, CpuResponse } from './protocol';
import { fromErrorPayload } from '#/_base/errors/serialize';
import { RESOURCE_DEFAULTS } from '#/_base/node/resourceDefaults';

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const HARD_TERMINATE_GRACE_MS = 5_000;
const WARM_WORKER_FLOOR = 1;

export interface CpuPoolOptions {
  readonly maxWorkers?: number;
  readonly maxQueue?: number;
  readonly maxQueuedBytes?: number;
  readonly timeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly cancelGraceMs?: number;
}

export interface CpuRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly transferList?: readonly Transferable[];
  readonly bytes?: number;
  readonly priority?: 'high' | 'normal' | 'low';
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
  readonly cancellation: SharedArrayBuffer;
  readonly cancelFlag: Int32Array;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  abort?: () => void;
}

interface DrainingCancel {
  readonly id: number;
  timer?: ReturnType<typeof setTimeout>;
  readonly hardTimeout: boolean;
  waitingForDetachSlot: boolean;
}

interface DetachedDraining {
  readonly worker: Worker;
  readonly id: number;
  readonly exited: Promise<void>;
  closeTimer?: ReturnType<typeof setTimeout>;
  retiring?: Promise<number>;
}

interface Slot {
  worker?: Worker;
  active?: Pending;
  drainingCancel?: DrainingCancel;
  retiring?: Promise<number>;
  exited?: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export class CpuWorkerPool {
  readonly size: number;
  private readonly slots: Slot[] = [];
  private readonly detachedDraining: DetachedDraining[] = [];
  private readonly retiringExits = new Set<Promise<void>>();
  private readonly waiting: Pending[] = [];
  private readonly highWaiting: Pending[] = [];
  private readonly lowWaiting: Pending[] = [];
  private consecutiveHigh = 0;
  private readonly maxQueue: number;
  private readonly maxQueuedBytes: number;
  private readonly maxDetachedDraining: number;
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private queuedBytes = 0;
  private serial = 0;
  private closing?: Promise<void>;

  constructor(private readonly entry: URL, options: CpuPoolOptions = {}) {
    const cap = positiveInteger(options.maxWorkers ?? RESOURCE_DEFAULTS.cpuWorkers, 'maxWorkers');
    this.size = Math.max(1, Math.min(availableParallelism() - 1, cap));
    this.maxQueue = positiveInteger(options.maxQueue ?? RESOURCE_DEFAULTS.cpuQueue, 'maxQueue');
    this.maxQueuedBytes = positiveInteger(options.maxQueuedBytes ?? RESOURCE_DEFAULTS.cpuQueuedBytes, 'maxQueuedBytes');
    this.maxDetachedDraining = Math.max(2, this.size * 2);
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 30_000, 'timeoutMs');
    this.idleTimeoutMs = positiveInteger(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, 'idleTimeoutMs');
    this.cancelGraceMs = positiveInteger(options.cancelGraceMs ?? HARD_TERMINATE_GRACE_MS, 'cancelGraceMs');
  }

  get liveWorkerCount(): number {
    let count = 0;
    for (const slot of this.slots) {
      if (slot.worker !== undefined && slot.retiring === undefined) count += 1;
    }
    return count;
  }

  warm(count = WARM_WORKER_FLOOR): void {
    if (this.closing !== undefined) return;
    const target = Math.min(this.size, Math.max(0, Math.floor(count)));
    while (this.liveWorkerCount < target && this.slots.length < this.size) {
      const slot: Slot = {};
      this.slots.push(slot);
      try {
        const worker = this.spawn(slot);
        worker.unref();
      } catch {
        const idx = this.slots.indexOf(slot);
        if (idx >= 0) this.slots.splice(idx, 1);
        break;
      }
    }
  }

  request<T>(operation: unknown, options: CpuRequestOptions = {}): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    if (this.closing !== undefined) return Promise.reject(new CpuWorkerError('CPU_POOL_CLOSED', 'CPU worker pool is closed'));
    const timeoutMs = positiveInteger(options.timeoutMs ?? this.timeoutMs, 'timeoutMs');
    const bytes = options.bytes ?? options.transferList?.reduce((sum, value) => sum + (value instanceof ArrayBuffer ? value.byteLength : 0), 0) ?? 0;
    if (!Number.isSafeInteger(bytes) || bytes < 0) return Promise.reject(new RangeError('CPU request bytes must be a nonnegative safe integer'));
    if (this.waiting.length + this.highWaiting.length + this.lowWaiting.length >= this.maxQueue || this.queuedBytes + bytes > this.maxQueuedBytes) {
      return Promise.reject(new CpuWorkerError('CPU_QUEUE_FULL', 'CPU worker queue is full; retry after active work completes'));
    }
    const cancellation = new SharedArrayBuffer(4);
    const cancelFlag = new Int32Array(cancellation);
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = { id: ++this.serial, operation, options, bytes, cancellation, cancelFlag, resolve: (value) => { resolve(value as T); }, reject };
      pending.abort = () => { this.cancel(pending, options.signal!.reason, false); };
      options.signal?.addEventListener('abort', pending.abort, { once: true });
      pending.timer = setTimeout(() => { this.cancel(pending, new CpuWorkerError('CPU_TIMEOUT', 'CPU worker request timed out'), true); }, timeoutMs);
      if (options.priority === 'high') this.highWaiting.push(pending);
      else if (options.priority === 'low') this.lowWaiting.push(pending);
      else this.waiting.push(pending);
      this.queuedBytes += bytes;
      this.pump();
    });
  }

  private activeSlotCount(): number {
    let count = 0;
    for (const slot of this.slots) {
      if (slot.active !== undefined || slot.drainingCancel !== undefined) count += 1;
    }
    return count;
  }

  private hasRunnableWaiting(activeCount: number): boolean {
    if (this.highWaiting.length > 0 || this.waiting.length > 0) return true;
    if (this.lowWaiting.length === 0) return false;
    return this.size <= 1 || activeCount < this.size - 1;
  }

  private dequeueNext(allowLow: boolean): Pending | undefined {
    if (this.highWaiting.length > 0 && (this.waiting.length === 0 || this.consecutiveHigh < 4)) {
      this.consecutiveHigh += 1;
      return this.highWaiting.shift();
    }
    if (this.waiting.length > 0) {
      this.consecutiveHigh = 0;
      return this.waiting.shift();
    }
    if (this.highWaiting.length > 0) {
      this.consecutiveHigh += 1;
      return this.highWaiting.shift();
    }
    if (allowLow && this.lowWaiting.length > 0) {
      this.consecutiveHigh = 0;
      return this.lowWaiting.shift();
    }
    return undefined;
  }

  private pump(): void {
    if (this.closing !== undefined) return;
    let activeCount = this.activeSlotCount();
    while (this.hasRunnableWaiting(activeCount)) {
      let slot = this.slots.find((candidate) => candidate.worker !== undefined && candidate.active === undefined && candidate.drainingCancel === undefined && candidate.retiring === undefined)
        ?? this.slots.find((candidate) => candidate.active === undefined && candidate.drainingCancel === undefined && candidate.retiring === undefined);
      if (slot === undefined) {
        if (this.slots.length >= this.size) break;
        slot = {};
        this.slots.push(slot);
      }
      this.clearIdleTimer(slot);
      const pending = this.dequeueNext(this.size <= 1 || activeCount < this.size - 1);
      if (pending === undefined) break;
      this.queuedBytes -= pending.bytes;
      slot.active = pending;
      activeCount += 1;
      try {
        const worker = slot.worker ?? this.spawn(slot);
        worker.ref();
        worker.postMessage({ id: pending.id, operation: pending.operation, cancellation: pending.cancellation } satisfies CpuRequest, optionsTransfer(pending.options));
      } catch (error) {
        this.settle(pending, new CpuWorkerError('CPU_WORKER_EXIT', 'CPU worker dispatch failed', { cause: error }));
        slot.active = undefined;
        activeCount -= 1;
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

  private clearDrainingCancel(slot: Slot): void {
    if (slot.drainingCancel !== undefined) {
      if (slot.drainingCancel.timer !== undefined) {
        clearTimeout(slot.drainingCancel.timer);
      }
      slot.drainingCancel = undefined;
    }
  }

  private clearDetachedCloseTimer(detached: DetachedDraining): void {
    if (detached.closeTimer !== undefined) {
      clearTimeout(detached.closeTimer);
      detached.closeTimer = undefined;
    }
  }

  private trackRetiringExit(exited: Promise<void> | undefined): void {
    if (exited === undefined) return;
    this.retiringExits.add(exited);
    void exited.finally(() => {
      this.retiringExits.delete(exited);
    });
  }

  private beginDrainingCancel(slot: Slot, id: number, hardTimeout: boolean): void {
    this.clearIdleTimer(slot);
    this.clearDrainingCancel(slot);
    if (slot.worker === undefined || slot.retiring !== undefined) return;
    const timer = setTimeout(() => {
      const draining = slot.drainingCancel;
      if (draining?.id !== id) return;
      draining.timer = undefined;
      if (hardTimeout || this.closing !== undefined) {
        slot.drainingCancel = undefined;
        void this.retire(slot);
      } else if (this.detachedDraining.length < this.maxDetachedDraining) {
        this.detachDrainingSlot(slot, id);
      } else {
        draining.waitingForDetachSlot = true;
      }
      this.reconcileIdleTimers();
    }, this.cancelGraceMs);
    timer.unref?.();
    slot.drainingCancel = { id, timer, hardTimeout, waitingForDetachSlot: false };
  }

  private detachDrainingSlot(slot: Slot, id: number): void {
    const worker = slot.worker;
    const exited = slot.exited;
    if (worker === undefined || exited === undefined) return;
    this.clearIdleTimer(slot);
    this.clearDrainingCancel(slot);
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
    slot.worker = undefined;
    slot.exited = undefined;
    worker.unref();
    const detached: DetachedDraining = { worker, id, exited };
    this.detachedDraining.push(detached);
    this.pump();
  }

  private promoteWaitingDetaches(): void {
    if (this.closing !== undefined) return;
    while (this.detachedDraining.length < this.maxDetachedDraining) {
      const candidate = this.slots.find(
        (slot) => slot.drainingCancel?.waitingForDetachSlot === true && slot.worker !== undefined && slot.retiring === undefined,
      );
      if (candidate === undefined) break;
      this.detachDrainingSlot(candidate, candidate.drainingCancel!.id);
    }
  }

  private retireDetached(detached: DetachedDraining): void {
    this.clearDetachedCloseTimer(detached);
    if (detached.retiring !== undefined) return;
    this.trackRetiringExit(detached.exited);
    detached.retiring = detached.worker.terminate();
    void detached.retiring.catch(() => {});
  }

  private reconcileIdleTimers(): void {
    if (this.closing !== undefined || this.waiting.length > 0 || this.highWaiting.length > 0 || this.lowWaiting.length > 0) {
      for (const slot of this.slots) this.clearIdleTimer(slot);
      return;
    }
    const live = this.slots.filter((slot) => slot.worker !== undefined && slot.retiring === undefined);
    if (live.length <= WARM_WORKER_FLOOR) {
      for (const slot of this.slots) this.clearIdleTimer(slot);
      return;
    }
    let warmReserved = live.filter((slot) => slot.active !== undefined || slot.drainingCancel !== undefined).length;
    for (const slot of live) {
      if (slot.active !== undefined || slot.drainingCancel !== undefined) {
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
      slot.drainingCancel !== undefined ||
      slot.worker === undefined ||
      slot.retiring !== undefined ||
      this.waiting.length > 0 ||
      this.highWaiting.length > 0 ||
      this.lowWaiting.length > 0 ||
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
    slot.exited = new Promise<void>((resolve) => {
      worker.once('exit', () => { resolve(); });
    });
    worker.on('message', (response: CpuResponse) => {
      const detachedIndex = this.detachedDraining.findIndex((entry) => entry.worker === worker);
      if (detachedIndex >= 0) {
        const detached = this.detachedDraining[detachedIndex]!;
        if (response.id !== detached.id) return;
        this.detachedDraining.splice(detachedIndex, 1);
        this.retireDetached(detached);
        this.promoteWaitingDetaches();
        return;
      }
      if (slot.worker !== worker || slot.retiring !== undefined) return;
      const draining = slot.drainingCancel;
      if (draining !== undefined && response.id === draining.id) {
        this.clearDrainingCancel(slot);
        if (this.closing !== undefined) {
          void this.retire(slot);
          return;
        }
        worker.unref();
        this.pump();
        return;
      }
      const pending = slot.active;
      if (pending === undefined || response.id !== pending.id) return;
      slot.active = undefined;
      if ('cancelled' in response) this.settle(pending, new DOMException('CPU operation cancelled', 'AbortError'));
      else if ('error' in response) this.settle(pending, response.error.payload === undefined
        ? Object.assign(new Error(response.error.message), { name: response.error.name, code: response.error.code })
        : fromErrorPayload(response.error.payload));
      else this.settle(pending, undefined, response.result);
      worker.unref();
      this.pump();
    });
    worker.on('error', (cause) => {
      const detachedIndex = this.detachedDraining.findIndex((entry) => entry.worker === worker);
      if (detachedIndex >= 0) {
        const [detached] = this.detachedDraining.splice(detachedIndex, 1);
        this.retireDetached(detached!);
        this.promoteWaitingDetaches();
        return;
      }
      if (slot.worker !== worker) return;
      this.clearDrainingCancel(slot);
      if (slot.active !== undefined) this.settle(slot.active, new CpuWorkerError('CPU_WORKER_EXIT', 'CPU worker failed', { cause }));
      slot.active = undefined;
      void this.retire(slot);
      this.reconcileIdleTimers();
    });
    worker.on('exit', (code) => {
      const detachedIndex = this.detachedDraining.findIndex((entry) => entry.worker === worker);
      if (detachedIndex >= 0) {
        const [detached] = this.detachedDraining.splice(detachedIndex, 1);
        this.clearDetachedCloseTimer(detached!);
        this.promoteWaitingDetaches();
        return;
      }
      if (slot.worker !== worker) return;
      this.clearIdleTimer(slot);
      this.clearDrainingCancel(slot);
      if (slot.active !== undefined) this.settle(slot.active, new CpuWorkerError('CPU_WORKER_EXIT', `CPU worker exited (${code})`));
      slot.active = undefined;
      slot.worker = undefined;
      slot.retiring = undefined;
      slot.exited = undefined;
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots.splice(index, 1);
      this.pump();
    });
    return worker;
  }

  private cancel(pending: Pending, error: unknown, hardTimeout: boolean): void {
    Atomics.store(pending.cancelFlag, 0, 1);
    const highIndex = this.highWaiting.indexOf(pending);
    if (highIndex >= 0) {
      this.highWaiting.splice(highIndex, 1);
      this.queuedBytes -= pending.bytes;
      this.settle(pending, error);
      return;
    }
    const index = this.waiting.indexOf(pending);
    if (index >= 0) {
      this.waiting.splice(index, 1);
      this.queuedBytes -= pending.bytes;
      this.settle(pending, error);
      return;
    }
    const lowIndex = this.lowWaiting.indexOf(pending);
    if (lowIndex >= 0) {
      this.lowWaiting.splice(lowIndex, 1);
      this.queuedBytes -= pending.bytes;
      this.settle(pending, error);
      return;
    }
    const slot = this.slots.find((candidate) => candidate.active === pending);
    if (slot === undefined) return;
    slot.active = undefined;
    this.settle(pending, error);
    this.beginDrainingCancel(slot, pending.id, hardTimeout);
    this.reconcileIdleTimers();
  }

  private retire(slot: Slot): Promise<number> | undefined {
    this.clearIdleTimer(slot);
    this.clearDrainingCancel(slot);
    if (slot.worker === undefined || slot.retiring !== undefined) return slot.retiring;
    this.trackRetiringExit(slot.exited);
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
    for (const pending of [...this.highWaiting.splice(0), ...this.waiting.splice(0), ...this.lowWaiting.splice(0)]) {
      Atomics.store(pending.cancelFlag, 0, 1);
      this.settle(pending, error);
    }
    this.queuedBytes = 0;
    const exits: Promise<void>[] = [...this.retiringExits];
    for (const detached of Array.from(this.detachedDraining)) {
      exits.push(detached.exited);
      if (detached.retiring === undefined && detached.closeTimer === undefined) {
        detached.closeTimer = setTimeout(() => {
          detached.closeTimer = undefined;
          const idx = this.detachedDraining.indexOf(detached);
          if (idx >= 0) this.detachedDraining.splice(idx, 1);
          this.retireDetached(detached);
        }, this.cancelGraceMs);
        detached.closeTimer.unref?.();
      }
    }
    for (const slot of Array.from(this.slots)) {
      this.clearIdleTimer(slot);
      if (slot.worker === undefined) continue;
      if (slot.exited !== undefined) exits.push(slot.exited);
      if (slot.active !== undefined) {
        const pending = slot.active;
        slot.active = undefined;
        Atomics.store(pending.cancelFlag, 0, 1);
        this.settle(pending, error);
        this.beginDrainingCancel(slot, pending.id, true);
      } else if (slot.drainingCancel === undefined) {
        void this.retire(slot);
      } else if (slot.drainingCancel.timer === undefined) {
        this.beginDrainingCancel(slot, slot.drainingCancel.id, true);
      }
    }
    this.closing = Promise.all(exits).then(() => {});
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
