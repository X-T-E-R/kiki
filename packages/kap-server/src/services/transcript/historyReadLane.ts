import { Error2, ErrorCodes } from '@kiki/agent-core-v2';
import { RESOURCE_DEFAULTS } from '@kiki/agent-core-v2/_base/node/resourceDefaults';

interface Waiter {
  start(): void;
  cancel(): void;
}

const PRIORITY_BURST_LIMIT = 4;

export class HistoryReadLane {
  private active = 0;
  private peak = 0;
  private priorityStreak = 0;
  private readonly priorityWaiting = new Set<Waiter>();
  private readonly waiting = new Set<Waiter>();
  private readonly shutdown = new AbortController();

  async run<T>(signal: AbortSignal | undefined, read: (signal: AbortSignal) => Promise<T>, priority = false): Promise<T> {
    const owned = signal === undefined ? this.shutdown.signal : AbortSignal.any([signal, this.shutdown.signal]);
    owned.throwIfAborted();
    if (this.active >= 2) {
      if (this.priorityWaiting.size + this.waiting.size >= RESOURCE_DEFAULTS.workerQueue) {
        throw new Error2(ErrorCodes.SESSION_BUSY, 'History readers are busy. Retry this page shortly.');
      }
      const bucket = priority ? this.priorityWaiting : this.waiting;
      await new Promise<void>((resolve, reject) => {
        let onAbort = (): void => {};
        const waiter: Waiter = {
          start: () => { owned.removeEventListener('abort', onAbort); bucket.delete(waiter); this.active += 1; resolve(); },
          cancel: () => { owned.removeEventListener('abort', onAbort); bucket.delete(waiter); reject(owned.reason); },
        };
        onAbort = () => { waiter.cancel(); };
        bucket.add(waiter);
        owned.addEventListener('abort', onAbort, { once: true });
        if (owned.aborted) waiter.cancel();
      });
    } else this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    try { owned.throwIfAborted(); return await read(owned); }
    finally {
      this.active -= 1;
      this.wakeNext();
    }
  }

  private wakeNext(): void {
    if (this.priorityWaiting.size > 0 && (this.waiting.size === 0 || this.priorityStreak < PRIORITY_BURST_LIMIT)) {
      this.priorityStreak += 1;
      this.priorityWaiting.values().next().value?.start();
      return;
    }
    if (this.waiting.size > 0) {
      this.priorityStreak = 0;
      this.waiting.values().next().value?.start();
      return;
    }
    if (this.priorityWaiting.size > 0) {
      this.priorityStreak += 1;
      this.priorityWaiting.values().next().value?.start();
    }
  }

  report() {
    return {
      active: this.active,
      queued: this.priorityWaiting.size + this.waiting.size,
      peak: this.peak,
      activeLimit: 2,
      queueLimit: RESOURCE_DEFAULTS.workerQueue,
    };
  }

  dispose(): void { this.shutdown.abort(new DOMException('History service closed', 'AbortError')); }
}
