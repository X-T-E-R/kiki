import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startVisiblePoll } from './visiblePoll';

function fakeVisibility(initial: DocumentVisibilityState = 'visible') {
  let state = initial;
  const listeners = new Set<() => void>();
  const visibility = {
    get visibilityState() {
      return state;
    },
    addEventListener: (_type: string, listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      listeners.delete(listener);
    },
  } as unknown as Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  return {
    visibility,
    set(next: DocumentVisibilityState) {
      state = next;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

describe('startVisiblePoll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never overlaps a slow poll with another interval tick', async () => {
    let release!: () => void;
    let first = true;
    const task = vi.fn(() => {
      if (!first) return Promise.resolve();
      first = false;
      return new Promise<void>((resolve) => { release = resolve; });
    });
    const source = fakeVisibility();
    const stop = startVisiblePoll({ intervalMs: 1000, task, visibility: source.visibility });

    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(1);

    release();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(999);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });

  it('keeps scheduling when the optional error observer throws', async () => {
    const task = vi.fn(async () => { throw new Error('poll failed'); });
    const source = fakeVisibility();
    const stop = startVisiblePoll({
      intervalMs: 1000,
      task,
      visibility: source.visibility,
      onError: () => { throw new Error('observer failed'); },
    });

    await vi.advanceTimersByTimeAsync(2000);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });

  it('does no background work and refreshes immediately when visible again', async () => {
    const task = vi.fn(async () => {});
    const source = fakeVisibility('hidden');
    const stop = startVisiblePoll({ intervalMs: 1000, task, visibility: source.visibility });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).not.toHaveBeenCalled();
    source.set('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);

    source.set('hidden');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(1);
    stop();
    expect(source.listenerCount()).toBe(0);
  });
});