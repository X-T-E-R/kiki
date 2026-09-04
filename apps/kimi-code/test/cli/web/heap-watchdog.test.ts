import { describe, expect, it, vi } from 'vitest';

import {
  DESKTOP_BUNDLED_ENV,
  EXTERNAL_RESTART_ENV,
  HEAP_RESTART_ENV,
  RSS_RESTART_ENV,
  resolveHeapWatchdogPolicy,
  startHeapWatchdog,
  type HeapWatchdogPolicy,
  type HeapWatchdogTriggerMetric,
} from '#/cli/sub/web/heap-watchdog';

const MB = 1024 * 1024;

function usage(values: Partial<NodeJS.MemoryUsage> = {}): NodeJS.MemoryUsage {
  const heapUsed = values.heapUsed ?? 0;
  return {
    heapUsed,
    heapTotal: values.heapTotal ?? heapUsed + 64 * MB,
    rss: values.rss ?? 0,
    external: values.external ?? 0,
    arrayBuffers: values.arrayBuffers ?? 0,
  };
}

function policy(overrides: Partial<HeapWatchdogPolicy> = {}): HeapWatchdogPolicy {
  return {
    heapThresholdBytes: 0,
    rssThresholdBytes: 0,
    externalThresholdBytes: 0,
    externalRssThresholdBytes: 3072 * MB,
    intervalMs: 1000,
    heapConsecutiveSamples: 2,
    rssConsecutiveSamples: 4,
    externalConsecutiveSamples: 4,
    ...overrides,
  };
}

function manualTimer(): Pick<Parameters<typeof startHeapWatchdog>[0], 'setInterval' | 'clearInterval'> {
  return {
    setInterval: (() => ({ unref: () => undefined })) as unknown as typeof setInterval,
    clearInterval: () => undefined,
  };
}

describe('resolveHeapWatchdogPolicy', () => {
  it('is disabled outside the desktop sidecar unless a metric override is set', () => {
    expect(resolveHeapWatchdogPolicy({}, 4096 * MB, 16_384 * MB)).toBeUndefined();
  });

  it('computes bundled defaults with clamped RSS and the external RSS floor', () => {
    const lowMemory = resolveHeapWatchdogPolicy(
      { [DESKTOP_BUNDLED_ENV]: '1' },
      8192 * MB,
      8192 * MB,
    );
    expect(lowMemory).toMatchObject({
      heapThresholdBytes: 6144 * MB,
      rssThresholdBytes: 3072 * MB,
      externalThresholdBytes: 1536 * MB,
      externalRssThresholdBytes: 3072 * MB,
      intervalMs: 30_000,
      heapConsecutiveSamples: 2,
      rssConsecutiveSamples: 4,
      externalConsecutiveSamples: 4,
    });

    const midMemory = resolveHeapWatchdogPolicy(
      { [DESKTOP_BUNDLED_ENV]: '1' },
      8192 * MB,
      12_288 * MB,
    );
    expect(midMemory?.rssThresholdBytes).toBe(Math.floor(12_288 * MB * 0.35));

    const highMemory = resolveHeapWatchdogPolicy(
      { [DESKTOP_BUNDLED_ENV]: '1' },
      8192 * MB,
      32_768 * MB,
    );
    expect(highMemory?.rssThresholdBytes).toBe(5120 * MB);
  });

  it('honors per-metric overrides on any host and lets 0 disable each metric', () => {
    expect(
      resolveHeapWatchdogPolicy(
        {
          [HEAP_RESTART_ENV]: '3000',
          [RSS_RESTART_ENV]: '4000',
          [EXTERNAL_RESTART_ENV]: '1200',
        },
        8192 * MB,
        16_384 * MB,
      ),
    ).toMatchObject({
      heapThresholdBytes: 3000 * MB,
      rssThresholdBytes: 4000 * MB,
      externalThresholdBytes: 1200 * MB,
    });

    expect(
      resolveHeapWatchdogPolicy(
        {
          [DESKTOP_BUNDLED_ENV]: '1',
          [HEAP_RESTART_ENV]: '0',
          [RSS_RESTART_ENV]: '4096',
          [EXTERNAL_RESTART_ENV]: '0',
        },
        8192 * MB,
        16_384 * MB,
      ),
    ).toMatchObject({
      heapThresholdBytes: 0,
      rssThresholdBytes: 4096 * MB,
      externalThresholdBytes: 0,
    });

    expect(
      resolveHeapWatchdogPolicy(
        {
          [DESKTOP_BUNDLED_ENV]: '1',
          [HEAP_RESTART_ENV]: '0',
          [RSS_RESTART_ENV]: '0',
          [EXTERNAL_RESTART_ENV]: '0',
        },
        8192 * MB,
        16_384 * MB,
      ),
    ).toBeUndefined();
    expect(resolveHeapWatchdogPolicy({ [HEAP_RESTART_ENV]: 'lots' }, 8192 * MB, 16_384 * MB)).toBeUndefined();
  });
});

describe('startHeapWatchdog', () => {
  it('does not trip on transient pressure below a consecutive sample gate', () => {
    const readings = [1200, 1200, 1200].map((rss) => usage({ rss: rss * MB }));
    const onTrip = vi.fn();
    const handle = startHeapWatchdog({
      policy: policy({ rssThresholdBytes: 1000 * MB }),
      onTrip,
      memoryUsage: () => readings.shift() ?? usage(),
      ...manualTimer(),
    });

    expect(handle.sample()).toBe(false);
    expect(handle.sample()).toBe(false);
    expect(handle.sample()).toBe(false);
    expect(onTrip).not.toHaveBeenCalled();
  });

  it('holds counts between 90% and 100% and resets below 90%', () => {
    const readings = [1000, 950, 899, 1000, 900, 1000].map((heapUsed) =>
      usage({ heapUsed: heapUsed * MB }),
    );
    const onTrip = vi.fn();
    const handle = startHeapWatchdog({
      policy: policy({ heapThresholdBytes: 1000 * MB }),
      onTrip,
      memoryUsage: () => readings.shift() ?? usage(),
      ...manualTimer(),
    });

    expect(handle.sample()).toBe(false);
    expect(handle.sample()).toBe(false);
    expect(handle.sample()).toBe(false);
    expect(handle.sample()).toBe(false);
    expect(handle.sample()).toBe(false);
    expect(handle.sample()).toBe(true);
    expect(onTrip).toHaveBeenCalledTimes(1);
  });

  it('requires the RSS floor on every counted external sample', () => {
    const readings = [
      ...Array.from({ length: 4 }, () => usage({ rss: 3000 * MB, external: 2000 * MB })),
      ...Array.from({ length: 4 }, () => usage({ rss: 3200 * MB, external: 2000 * MB })),
    ];
    const onTrip = vi.fn();
    const handle = startHeapWatchdog({
      policy: policy({ externalThresholdBytes: 1536 * MB }),
      onTrip,
      memoryUsage: () => readings.shift() ?? usage(),
      ...manualTimer(),
    });

    for (let sample = 0; sample < 7; sample += 1) {
      expect(handle.sample()).toBe(false);
    }
    expect(handle.sample()).toBe(true);
    expect(onTrip).toHaveBeenCalledTimes(1);
  });

  it.each<{
    metric: HeapWatchdogTriggerMetric;
    metricPolicy: Partial<HeapWatchdogPolicy>;
    reading: NodeJS.MemoryUsage;
    samples: number;
  }>([
    {
      metric: 'heap',
      metricPolicy: { heapThresholdBytes: 1000 * MB },
      reading: usage({ heapUsed: 1200 * MB, rss: 3500 * MB, external: 1700 * MB, arrayBuffers: 400 * MB }),
      samples: 2,
    },
    {
      metric: 'rss',
      metricPolicy: { rssThresholdBytes: 1000 * MB },
      reading: usage({ heapUsed: 800 * MB, rss: 1200 * MB, external: 600 * MB, arrayBuffers: 200 * MB }),
      samples: 4,
    },
    {
      metric: 'external',
      metricPolicy: { externalThresholdBytes: 1000 * MB },
      reading: usage({ heapUsed: 800 * MB, rss: 3500 * MB, external: 1200 * MB, arrayBuffers: 900 * MB }),
      samples: 4,
    },
  ])('lets $metric trip once and reports the full memory payload', ({ metric, metricPolicy, reading, samples }) => {
    const onTrip = vi.fn();
    const handle = startHeapWatchdog({
      policy: policy(metricPolicy),
      onTrip,
      memoryUsage: () => reading,
      ...manualTimer(),
    });

    for (let sample = 1; sample < samples; sample += 1) {
      expect(handle.sample()).toBe(false);
    }
    expect(handle.sample()).toBe(true);
    expect(handle.sample()).toBe(false);
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(onTrip).toHaveBeenCalledWith({
      triggerMetric: metric,
      heapUsed: reading.heapUsed,
      heapTotal: reading.heapTotal,
      rss: reading.rss,
      external: reading.external,
      arrayBuffers: reading.arrayBuffers,
      heapThresholdBytes: metricPolicy.heapThresholdBytes ?? 0,
      rssThresholdBytes: metricPolicy.rssThresholdBytes ?? 0,
      externalThresholdBytes: metricPolicy.externalThresholdBytes ?? 0,
      externalRssThresholdBytes: 3072 * MB,
    });
  });

  it('stops the timer explicitly and when a metric trips', () => {
    let tick: (() => void) | undefined;
    const clearInterval = vi.fn();
    const handle = startHeapWatchdog({
      policy: policy({ heapThresholdBytes: 1000 * MB }),
      onTrip: vi.fn(),
      memoryUsage: () => usage({ heapUsed: 2000 * MB }),
      setInterval: ((fn: () => void) => {
        tick = fn;
        return 7;
      }) as unknown as typeof setInterval,
      clearInterval: clearInterval as unknown as typeof globalThis.clearInterval,
    });

    handle.stop();
    handle.stop();
    expect(clearInterval).toHaveBeenCalledTimes(1);
    expect(clearInterval).toHaveBeenCalledWith(7);

    let tripTick: (() => void) | undefined;
    const tripClearInterval = vi.fn();
    startHeapWatchdog({
      policy: policy({ heapThresholdBytes: 1000 * MB }),
      onTrip: vi.fn(),
      memoryUsage: () => usage({ heapUsed: 2000 * MB }),
      setInterval: ((fn: () => void) => {
        tripTick = fn;
        return 8;
      }) as unknown as typeof setInterval,
      clearInterval: tripClearInterval as unknown as typeof globalThis.clearInterval,
    });
    tripTick?.();
    expect(tripClearInterval).not.toHaveBeenCalled();
    tripTick?.();
    expect(tripClearInterval).toHaveBeenCalledWith(8);
    expect(tick).toBeTypeOf('function');
  });
});
