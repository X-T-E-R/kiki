const HISTORY_READ_CONCURRENCY = 3;
const HISTORY_READ_QUEUE_LIMIT = 128;

interface Waiter {
  readonly enter: () => void;
  readonly cancel: () => void;
}

class HistoryReadLane {
  private active = 0;
  private readonly waiting: Waiter[] = [];

  read<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.active < HISTORY_READ_CONCURRENCY) return this.run(read, signal);
    if (this.waiting.length >= HISTORY_READ_QUEUE_LIMIT) return Promise.reject(new Error('History reads are busy. Retry after the current reads finish.'));
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        enter: () => { signal?.removeEventListener('abort', waiter.cancel); resolve(this.run(read, signal)); },
        cancel: () => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          signal?.removeEventListener('abort', waiter.cancel);
          reject(signal?.reason ?? new DOMException('History read cancelled', 'AbortError'));
        },
      };
      this.waiting.push(waiter);
      signal?.addEventListener('abort', waiter.cancel, { once: true });
    });
  }

  private async run<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.active += 1;
    try { signal?.throwIfAborted(); return await read(); }
    finally {
      this.active -= 1;
      this.waiting.shift()?.enter();
    }
  }
}

const lanes = new WeakMap<object, HistoryReadLane>();

export function readInHistoryLane<T>(connection: object, read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let lane = lanes.get(connection);
  if (lane === undefined) { lane = new HistoryReadLane(); lanes.set(connection, lane); }
  return lane.read(read, signal);
}
