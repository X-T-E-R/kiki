import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { afterPaint } from './afterPaint';

describe('afterPaint', () => {
  let frameDelay: number;
  let idleDelay: number;
  let visibilityState: DocumentVisibilityState;
  const visibilityListeners = new Set<() => void>();

  const animationFrame = vi.fn((callback: FrameRequestCallback) =>
    setTimeout(() => { callback(performance.now()); }, frameDelay),
  );
  const idleCallback = vi.fn((callback: IdleRequestCallback) =>
    setTimeout(() => { callback({ didTimeout: false, timeRemaining: () => 10 }); }, idleDelay),
  );

  beforeEach(() => {
    vi.useFakeTimers();
    frameDelay = 16;
    idleDelay = 20;
    visibilityState = 'visible';
    visibilityListeners.clear();
    animationFrame.mockClear();
    idleCallback.mockClear();
    vi.stubGlobal('document', {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: (_type: string, listener: () => void) => {
        visibilityListeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        visibilityListeners.delete(listener);
      },
    });
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
    visibilityState = 'hidden';
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

  it('switches to a timer when the document becomes hidden while waiting for paint', () => {
    frameDelay = 10_000;
    const task = vi.fn();
    afterPaint(task);

    expect(task).not.toHaveBeenCalled();
    visibilityState = 'hidden';
    for (const listener of visibilityListeners) listener();
    vi.advanceTimersByTime(0);
    expect(task).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(task).toHaveBeenCalledTimes(1);
    expect(idleCallback).not.toHaveBeenCalled();
    expect(visibilityListeners.size).toBe(0);
  });

  it('waits for two frames and an idle slot without forcing an elapsed-time cutoff', () => {
    const task = vi.fn();
    afterPaint(task);

    vi.advanceTimersByTime(31);
    expect(idleCallback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(idleCallback).toHaveBeenCalledTimes(1);
    expect(idleCallback.mock.calls[0]?.[1]).toBeUndefined();
    vi.advanceTimersByTime(19);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledTimes(1);
    expect(visibilityListeners.size).toBe(0);
  });

  it.each([0, 16, 32])('cancels all scheduled work when disposed after %i ms', (elapsed) => {
    const task = vi.fn();
    const dispose = afterPaint(task);

    vi.advanceTimersByTime(elapsed);
    dispose();

    expect(vi.getTimerCount()).toBe(0);
    expect(visibilityListeners.size).toBe(0);
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
