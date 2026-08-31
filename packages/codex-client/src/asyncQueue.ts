export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{
    readonly resolve: (value: IteratorResult<T>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  #ended = false;
  #error: unknown;

  push(value: T): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter.resolve({ done: false, value });
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.#error !== undefined) {
          throw this.#error instanceof Error ? this.#error : new Error('Executor event queue failed');
        }
        if (this.#ended) return { done: true, value: undefined };
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
    };
  }
}
