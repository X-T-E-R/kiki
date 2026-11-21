import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { afterPaint } from './afterPaint';

describe('afterPaint', () => {
  let frameDelay: number;

  const animationFrame = vi.fn((callback: FrameRequestCallback) =>
    setTimeout(() => { callback(performance.now()); }, frameDelay),
  );
  const idleCallback = vi.fn((callback: IdleRequestCallback, options: IdleRequestOptions) =>
    setTimeout(() => { callback({ didTimeout: true, timeRemaining: () => 0 }); }, options.timeout),
  );

  beforeEach(() => {
    vi.useFakeTimers();
    frameDelay = 16;
    animationFrame.mockClear();
    idleCallback.mockClear();
    vi.stubGlobal('document', { visibilityState: 'visible' });
    vi.stubGlobal('requestAnimationFrame', animationFrame);
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    vi.stubGlobal('requestIdleCallback', idleCallback);
    vi.stubGlobal('cancelIdleCallback', clearTimeout);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('uses a cancellable timer in a hidden document', () => {
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    const task = vi.fn();
    const disposedTask = vi.fn();

    afterPaint(task);
    afterPaint(disposedTask)();
    expect(task).not.toHaveBeenCalled();
    vi.runAllTimers();

    expect(task).toHaveBeenCalledTimes(1);
    expect(disposedTask).not.toHaveBeenCalled();
    expect(animationFrame).not.toHaveBeenCalled();
  });

  it('runs once when the second animation frame stalls', () => {
    frameDelay = 200;
    const task = vi.fn();
    afterPaint(task);

    vi.advanceTimersByTime(249);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(task).toHaveBeenCalledTimes(1);
    expect(idleCallback).not.toHaveBeenCalled();
  });

  it('waits for two frames, then bounds the wait for an idle slot', () => {
    const task = vi.fn();
    afterPaint(task);

    vi.advanceTimersByTime(31);
    expect(idleCallback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(idleCallback).toHaveBeenCalledWith(task, { timeout: 1000 });
    vi.advanceTimersByTime(999);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it.each([0, 16, 32])('cancels all scheduled work when disposed after %i ms', (elapsed) => {
    const task = vi.fn();
    const dispose = afterPaint(task);

    vi.advanceTimersByTime(elapsed);
    dispose();

    expect(vi.getTimerCount()).toBe(0);
    vi.runAllTimers();
    expect(task).not.toHaveBeenCalled();
  });

  it('uses a cancellable timer after two frames when idle callbacks are unavailable', () => {
    vi.stubGlobal('requestIdleCallback', undefined);
    const task = vi.fn();
    const disposedTask = vi.fn();
    afterPaint(task);
    const dispose = afterPaint(disposedTask);

    vi.advanceTimersByTime(32);
    dispose();
    expect(task).not.toHaveBeenCalled();
    vi.runAllTimers();

    expect(task).toHaveBeenCalledTimes(1);
    expect(disposedTask).not.toHaveBeenCalled();
  });
});
