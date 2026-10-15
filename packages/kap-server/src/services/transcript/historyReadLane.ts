import { Error2, ErrorCodes } from '@kiki/agent-core-v2';

interface Waiter {
  start(): void;
  cancel(): void;
}

export class HistoryReadLane {
  private active = 0;
  private peak = 0;
  private readonly waiting = new Set<Waiter>();
  private readonly shutdown = new AbortController();

  async run<T>(signal: AbortSignal | undefined, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const owned = signal === undefined ? this.shutdown.signal : AbortSignal.any([signal, this.shutdown.signal]);
    owned.throwIfAborted();
    if (this.active >= 2) {
      if (this.waiting.size >= 8) throw new Error2(ErrorCodes.SESSION_BUSY, 'History readers are busy. Retry this page shortly.');
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          start: () => { owned.removeEventListener('abort', waiter.cancel); this.waiting.delete(waiter); this.active += 1; resolve(); },
          cancel: () => { owned.removeEventListener('abort', waiter.cancel); this.waiting.delete(waiter); reject(owned.reason); },
        };
        this.waiting.add(waiter);
        owned.addEventListener('abort', waiter.cancel, { once: true });
        if (owned.aborted) waiter.cancel();
      });
    } else this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    try { owned.throwIfAborted(); return await read(owned); }
    finally {
      this.active -= 1;
      this.waiting.values().next().value?.start();
    }
  }

  report() { return { active: this.active, queued: this.waiting.size, peak: this.peak, activeLimit: 2, queueLimit: 8 }; }

  dispose(): void { this.shutdown.abort(new DOMException('History service closed', 'AbortError')); }
}
