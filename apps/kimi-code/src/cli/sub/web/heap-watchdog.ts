/**
 * Memory watchdog for the foreground server.
 *
 * The desktop shell restarts its bundled sidecar after a clean exit, which is
 * preferable to letting a long-lived process enter repeated GC or OOM stalls.
 * The watchdog samples Node's process memory counters and asks the existing
 * graceful shutdown path to stop the server after sustained pressure.
 *
 * Enabled by default only for the desktop sidecar (`KIKI_DESKTOP_BUNDLED=1`).
 * Per-metric MB environment variables override the defaults on any host, and
 * `0` disables that metric.
 */

import { totalmem } from 'node:os';
import { getHeapStatistics } from 'node:v8';

export const HEAP_RESTART_ENV = 'KIMI_CODE_SERVER_HEAP_RESTART_MB';
export const RSS_RESTART_ENV = 'KIMI_CODE_SERVER_RSS_RESTART_MB';
export const EXTERNAL_RESTART_ENV = 'KIMI_CODE_SERVER_EXTERNAL_RESTART_MB';
export const DESKTOP_BUNDLED_ENV = 'KIKI_DESKTOP_BUNDLED';

const MB = 1024 * 1024;
const DEFAULT_HEAP_LIMIT_FRACTION = 0.75;
const DEFAULT_RSS_MEMORY_FRACTION = 0.35;
const DEFAULT_RSS_MIN_BYTES = 3072 * MB;
const DEFAULT_RSS_MAX_BYTES = 5120 * MB;
const DEFAULT_EXTERNAL_BYTES = 1536 * MB;
const EXTERNAL_RSS_THRESHOLD_BYTES = 3072 * MB;
const DEFAULT_INTERVAL_MS = 30_000;
const HEAP_CONSECUTIVE_SAMPLES = 2;
const RSS_CONSECUTIVE_SAMPLES = 4;
const EXTERNAL_CONSECUTIVE_SAMPLES = 4;
const RESET_FRACTION = 0.9;

export type HeapWatchdogTriggerMetric = 'heap' | 'rss' | 'external';

export interface HeapWatchdogPolicy {
  readonly heapThresholdBytes: number;
  readonly rssThresholdBytes: number;
  readonly externalThresholdBytes: number;
  readonly externalRssThresholdBytes: number;
  readonly intervalMs: number;
  readonly heapConsecutiveSamples: number;
  readonly rssConsecutiveSamples: number;
  readonly externalConsecutiveSamples: number;
}

function thresholdBytes(raw: string | undefined, defaultBytes: number): number {
  if (raw === undefined || raw === '') return defaultBytes;
  const mb = Number.parseInt(raw, 10);
  if (!Number.isFinite(mb) || mb <= 0) return 0;
  return mb * MB;
}

export function resolveHeapWatchdogPolicy(
  env: NodeJS.ProcessEnv,
  heapSizeLimit: number = getHeapStatistics().heap_size_limit,
  totalMemory: number = totalmem(),
): HeapWatchdogPolicy | undefined {
  const bundled = env[DESKTOP_BUNDLED_ENV] === '1';
  const heapOverride = env[HEAP_RESTART_ENV];
  const useBundledDefaults = bundled && (heapOverride === undefined || heapOverride === '');
  const defaultHeapThreshold =
    useBundledDefaults && Number.isFinite(heapSizeLimit) && heapSizeLimit > 0
      ? Math.floor(heapSizeLimit * DEFAULT_HEAP_LIMIT_FRACTION)
      : 0;
  const defaultRssThreshold = useBundledDefaults
    ? Math.min(
        DEFAULT_RSS_MAX_BYTES,
        Math.max(DEFAULT_RSS_MIN_BYTES, Math.floor(totalMemory * DEFAULT_RSS_MEMORY_FRACTION)),
      )
    : 0;
  const heapThresholdBytes = thresholdBytes(heapOverride, defaultHeapThreshold);
  const rssThresholdBytes = thresholdBytes(env[RSS_RESTART_ENV], defaultRssThreshold);
  const externalThresholdBytes = thresholdBytes(
    env[EXTERNAL_RESTART_ENV],
    useBundledDefaults ? DEFAULT_EXTERNAL_BYTES : 0,
  );

  if (heapThresholdBytes === 0 && rssThresholdBytes === 0 && externalThresholdBytes === 0) {
    return undefined;
  }
  return {
    heapThresholdBytes,
    rssThresholdBytes,
    externalThresholdBytes,
    externalRssThresholdBytes: EXTERNAL_RSS_THRESHOLD_BYTES,
    intervalMs: DEFAULT_INTERVAL_MS,
    heapConsecutiveSamples: HEAP_CONSECUTIVE_SAMPLES,
    rssConsecutiveSamples: RSS_CONSECUTIVE_SAMPLES,
    externalConsecutiveSamples: EXTERNAL_CONSECUTIVE_SAMPLES,
  };
}

export interface HeapWatchdogTrip {
  readonly triggerMetric: HeapWatchdogTriggerMetric;
  readonly heapUsed: number;
  readonly heapTotal: number;
  readonly rss: number;
  readonly external: number;
  readonly arrayBuffers: number;
  readonly heapThresholdBytes: number;
  readonly rssThresholdBytes: number;
  readonly externalThresholdBytes: number;
  readonly externalRssThresholdBytes: number;
}

export interface HeapWatchdogDeps {
  readonly policy: HeapWatchdogPolicy;
  readonly onTrip: (trip: HeapWatchdogTrip) => void;
  readonly memoryUsage?: () => NodeJS.MemoryUsage;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
}

export interface HeapWatchdogHandle {
  /** Take one sample now; returns true when the trip fired. */
  sample(): boolean;
  stop(): void;
}

export function startHeapWatchdog(deps: HeapWatchdogDeps): HeapWatchdogHandle {
  const memoryUsage = deps.memoryUsage ?? (() => process.memoryUsage());
  const schedule = deps.setInterval ?? globalThis.setInterval;
  const cancel = deps.clearInterval ?? globalThis.clearInterval;
  const above = { heap: 0, rss: 0, external: 0 } satisfies Record<HeapWatchdogTriggerMetric, number>;
  let tripped = false;
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;

  const stop = (): void => {
    if (timer !== undefined) {
      cancel(timer);
      timer = undefined;
    }
  };

  const reachesLimit = (
    metric: HeapWatchdogTriggerMetric,
    value: number,
    threshold: number,
    consecutiveSamples: number,
    eligible: boolean = true,
  ): boolean => {
    if (threshold === 0) return false;
    if (!eligible) {
      above[metric] = 0;
      return false;
    }
    if (value >= threshold) {
      above[metric] += 1;
    } else if (value < threshold * RESET_FRACTION) {
      above[metric] = 0;
    }
    return above[metric] >= consecutiveSamples;
  };

  const sample = (): boolean => {
    if (tripped) return false;
    const usage = memoryUsage();
    let triggerMetric: HeapWatchdogTriggerMetric | undefined;
    if (
      reachesLimit(
        'heap',
        usage.heapUsed,
        deps.policy.heapThresholdBytes,
        deps.policy.heapConsecutiveSamples,
      )
    ) {
      triggerMetric = 'heap';
    } else if (
      reachesLimit(
        'rss',
        usage.rss,
        deps.policy.rssThresholdBytes,
        deps.policy.rssConsecutiveSamples,
      )
    ) {
      triggerMetric = 'rss';
    } else if (
      reachesLimit(
        'external',
        usage.external,
        deps.policy.externalThresholdBytes,
        deps.policy.externalConsecutiveSamples,
        usage.rss >= deps.policy.externalRssThresholdBytes,
      )
    ) {
      triggerMetric = 'external';
    }
    if (triggerMetric === undefined) return false;

    tripped = true;
    stop();
    deps.onTrip({
      triggerMetric,
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      rss: usage.rss,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers,
      heapThresholdBytes: deps.policy.heapThresholdBytes,
      rssThresholdBytes: deps.policy.rssThresholdBytes,
      externalThresholdBytes: deps.policy.externalThresholdBytes,
      externalRssThresholdBytes: deps.policy.externalRssThresholdBytes,
    });
    return true;
  };

  timer = schedule(() => {
    sample();
  }, deps.policy.intervalMs);
  (timer as { unref?: () => void }).unref?.();

  return { sample, stop };
}
