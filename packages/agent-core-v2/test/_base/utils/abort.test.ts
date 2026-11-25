import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  abortError,
  abortable,
  createDeadlineAbortSignal,
  isAbortError,
  isUserCancellation,
  userCancellationReason,
} from '#/_base/utils/abort';
import { sleepForRetry } from '#/_base/utils/retry';

describe('userCancellationReason', () => {
  it('is recognised as a deliberate user cancellation', () => {
    expect(isUserCancellation(userCancellationReason())).toBe(true);
  });

  it('stays an AbortError so abort detection keeps treating it as an abort', () => {
    expect(isAbortError(userCancellationReason())).toBe(true);
  });

  it('is distinguishable from a generic abort, an ordinary error, and undefined', () => {
    expect(isUserCancellation(abortError())).toBe(false);
    expect(isUserCancellation(new Error('boom'))).toBe(false);
    expect(isUserCancellation(undefined)).toBe(false);
  });

  it('keeps custom system abort messages classified as AbortError', () => {
    expect(abortError('Session closed')).toMatchObject({
      name: 'AbortError',
      message: 'Session closed',
    });
  });
});

describe('abortable', () => {
  it('rejects with the signal reason when already aborted', async () => {
    const controller = new AbortController();
    const reason = userCancellationReason();
    controller.abort(reason);

    await expect(abortable(Promise.resolve('ok'), controller.signal)).rejects.toBe(reason);
  });

  it('rejects with the signal reason when aborted while pending', async () => {
    const controller = new AbortController();
    const reason = userCancellationReason();
    const pending = new Promise<never>(() => {});
    const result = abortable(pending, controller.signal);

    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
  });

  it('normalizes the default AbortController reason to a generic AbortError', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(abortable(Promise.resolve('ok'), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Aborted',
    });
  });

  it('falls back to a generic AbortError when the signal reason is not an Error', async () => {
    const controller = new AbortController();
    controller.abort('cancelled');

    await expect(abortable(Promise.resolve('ok'), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Aborted',
    });
  });
});

describe('createDeadlineAbortSignal', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts with AbortError and marks timedOut when the deadline expires', async () => {
    vi.useFakeTimers();
    const source = new AbortController();
    const deadline = createDeadlineAbortSignal(source.signal, 100);

    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.timedOut()).toBe(false);

    await vi.advanceTimersByTimeAsync(100);

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.timedOut()).toBe(true);
    expect(isAbortError(deadline.signal.reason)).toBe(true);

    source.abort(userCancellationReason());
    expect(deadline.timedOut()).toBe(true);
    deadline.clear();
  });

  it('propagates source abort without marking timedOut even after timeoutMs elapses', async () => {
    vi.useFakeTimers();
    const source = new AbortController();
    const reason = userCancellationReason();
    const deadline = createDeadlineAbortSignal(source.signal, 100);

    source.abort(reason);

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe(reason);
    expect(deadline.timedOut()).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    expect(deadline.timedOut()).toBe(false);
    deadline.clear();
  });

  it('cancels the pending timer on clear', async () => {
    vi.useFakeTimers();
    const source = new AbortController();
    const deadline = createDeadlineAbortSignal(source.signal, 100);

    deadline.clear();
    await vi.advanceTimersByTimeAsync(200);

    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.timedOut()).toBe(false);
  });
});

describe('sleepForRetry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects immediately when signal is pre-aborted and preserves user cancellation', async () => {
    const controller = new AbortController();
    const reason = userCancellationReason();
    controller.abort(reason);

    await expect(sleepForRetry(5_000, controller.signal)).rejects.toBe(reason);
  });

  it('clears the timer and rejects with the normalized abort reason when aborted mid-sleep', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = userCancellationReason();
    const pending = sleepForRetry(5_000, controller.signal);

    expect(vi.getTimerCount()).toBe(1);
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves after delayMs when not aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let done = false;
    const pending = sleepForRetry(500, controller.signal).then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
  });
});
