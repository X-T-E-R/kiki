export interface AsyncQueueReservation<T> {
  commit(value: T): void;
  release(): void;
}

interface SlotWaiter<T> {
  readonly resolve: (reservation: AsyncQueueReservation<T>) => void;
  readonly reject: (error: unknown) => void;
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  readonly #slotWaiters: SlotWaiter<T>[] = [];
  #inFlight = 0;
  #closed = false;
  #error: unknown;

  constructor(private readonly maxBacklog: number) {}

  isFull(): boolean {
    return !this.#closed && this.#inFlight >= this.maxBacklog;
  }

  reserve(): Promise<AsyncQueueReservation<T>> {
    if (this.#error !== undefined) return Promise.reject(this.#error);
    if (this.#closed) return Promise.reject(new Error('Async queue is closed'));
    if (this.#inFlight < this.maxBacklog) {
      this.#inFlight += 1;
      return Promise.resolve(this.#reservation());
    }
    return new Promise<AsyncQueueReservation<T>>((resolve, reject) => {
      this.#slotWaiters.push({ resolve, reject });
    });
  }

  push(value: T): void {
    if (this.#closed) return;
    if (this.#inFlight >= this.maxBacklog) {
      throw new Error('Async queue backlog limit exceeded');
    }
    this.#inFlight += 1;
    this.#deliver(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#slotWaiters.splice(0)) {
      waiter.reject(new Error('Async queue is closed'));
    }
    this.#drainWaiters();
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    this.#values.length = 0;
    for (const waiter of this.#slotWaiters.splice(0)) waiter.reject(error);
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.#values.length > 0) {
          const value = this.#values.shift()!;
          this.#inFlight -= 1;
          this.#grantSlot();
          return Promise.resolve({ value, done: false });
        }
        if (this.#error !== undefined) return Promise.reject(this.#error);
        if (this.#closed && this.#inFlight === 0) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
    };
  }

  #reservation(): AsyncQueueReservation<T> {
    let settled = false;
    return {
      commit: (value: T) => {
        if (settled) return;
        settled = true;
        if (this.#error !== undefined) {
          this.#inFlight -= 1;
          this.#drainWaiters();
          return;
        }
        this.#deliver(value);
      },
      release: () => {
        if (settled) return;
        settled = true;
        this.#inFlight -= 1;
        this.#grantSlot();
        this.#drainWaiters();
      },
    };
  }

  #deliver(value: T): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      this.#inFlight -= 1;
      waiter.resolve({ value, done: false });
      this.#grantSlot();
      this.#drainWaiters();
      return;
    }
    this.#values.push(value);
  }

  #grantSlot(): void {
    if (this.#closed || this.#error !== undefined || this.#inFlight >= this.maxBacklog) return;
    const waiter = this.#slotWaiters.shift();
    if (waiter === undefined) return;
    this.#inFlight += 1;
    waiter.resolve(this.#reservation());
  }

  #drainWaiters(): void {
    if (this.#error !== undefined) {
      for (const waiter of this.#waiters.splice(0)) waiter.reject(this.#error);
      return;
    }
    if (this.#values.length > 0 || this.#inFlight > 0 || !this.#closed) return;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }
}
