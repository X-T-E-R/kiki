import { describe, expect, it, vi } from 'vitest';

import {
  DESKTOP_BUNDLED_ENV,
  HEAP_RESTART_ENV,
  resolveHeapWatchdogPolicy,
  startHeapWatchdog,
} from '#/cli/sub/web/heap-watchdog';

const MB = 1024 * 1024;

function usage(heapUsed: number): NodeJS.MemoryUsage {
  return { heapUsed, heapTotal: heapUsed + 64 * MB, rss: heapUsed + 512 * MB, external: 0, arrayBuffers: 0 };
}

describe('resolveHeapWatchdogPolicy', () => {
  it('is disabled outside the desktop sidecar unless the env override is set', () => {
    expect(resolveHeapWatchdogPolicy({}, 4096 * MB)).toBeUndefined();
  });

  it('arms at 75% of the old-space limit for the desktop sidecar', () => {
    const policy = resolveHeapWatchdogPolicy({ [DESKTOP_BUNDLED_ENV]: '1' }, 8192 * MB);
    expect(policy?.thresholdBytes).toBe(6144 * MB);
    expect(policy?.consecutiveSamples).toBe(2);
  });

  it('honors an explicit MB override on any host and lets 0 disable it', () => {
    expect(resolveHeapWatchdogPolicy({ [HEAP_RESTART_ENV]: '3000' }, 8192 * MB)?.thresholdBytes).toBe(3000 * MB);
    expect(
      resolveHeapWatchdogPolicy({ [HEAP_RESTART_ENV]: '0', [DESKTOP_BUNDLED_ENV]: '1' }, 8192 * MB),
    ).toBeUndefined();
    expect(resolveHeapWatchdogPolicy({ [HEAP_RESTART_ENV]: 'lots' }, 8192 * MB)).toBeUndefined();
  });
});

describe('startHeapWatchdog', () => {
  const policy = { thresholdBytes: 1000 * MB, intervalMs: 1000, consecutiveSamples: 2 };

  it('trips only after consecutive samples above the threshold', () => {
    const readings = [1200, 900, 1200, 1300].map((mb) => usage(mb * MB));
    const onTrip = vi.fn();
    const handle = startHeapWatchdog({
      policy,
      onTrip,
      memoryUsage: () => readings.shift() ?? usage(0),
      setInterval: (() => ({ unref: () => undefined })) as unknown as typeof setInterval,
      clearInterval: () => undefined,
    });
    expect(handle.sample()).toBe(false);
    expect(handle.sample()).toBe(false);
    expect(handle.sample()).toBe(false);
    expect(handle.sample()).toBe(true);
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(onTrip.mock.calls[0]?.[0]).toMatchObject({ heapUsed: 1300 * MB, thresholdBytes: 1000 * MB });
    expect(handle.sample()).toBe(false);
    expect(onTrip).toHaveBeenCalledTimes(1);
  });

  it('samples on the interval and stops the timer once tripped', () => {
    let tick: (() => void) | undefined;
    const clearInterval = vi.fn();
    const onTrip = vi.fn();
    startHeapWatchdog({
      policy,
      onTrip,
      memoryUsage: () => usage(2000 * MB),
      setInterval: ((fn: () => void) => {
        tick = fn;
        return 7;
      }) as unknown as typeof setInterval,
      clearInterval: clearInterval as unknown as typeof globalThis.clearInterval,
    });
    tick?.();
    expect(onTrip).not.toHaveBeenCalled();
    tick?.();
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(clearInterval).toHaveBeenCalledWith(7);
  });
});
