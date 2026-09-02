/**
 * Heap watchdog for the foreground server.
 *
 * A long-lived `kimi web` process that leaks towards V8's old-space limit
 * spends its last stretch in back-to-back mark-compacts (multi-second event
 * loop stalls) before dying with a fatal OOM. Under a supervisor that
 * restarts the server (the Kiki desktop shell), a clean early exit is
 * strictly better than that death spiral, so the watchdog samples
 * `heapUsed` and asks for a shutdown once it stays above a threshold.
 *
 * Enabled by default only for the desktop sidecar (`KIKI_DESKTOP_BUNDLED=1`).
 * `KIMI_CODE_SERVER_HEAP_RESTART_MB` overrides the threshold for any host;
 * `0` disables the watchdog.
 */

import { getHeapStatistics } from 'node:v8';

export const HEAP_RESTART_ENV = 'KIMI_CODE_SERVER_HEAP_RESTART_MB';
export const DESKTOP_BUNDLED_ENV = 'KIKI_DESKTOP_BUNDLED';

const DEFAULT_LIMIT_FRACTION = 0.75;
const DEFAULT_INTERVAL_MS = 30_000;
const CONSECUTIVE_SAMPLES = 2;

export interface HeapWatchdogPolicy {
  readonly thresholdBytes: number;
  readonly intervalMs: number;
  readonly consecutiveSamples: number;
}

export function resolveHeapWatchdogPolicy(
  env: NodeJS.ProcessEnv,
  heapSizeLimit: number = getHeapStatistics().heap_size_limit,
): HeapWatchdogPolicy | undefined {
  const raw = env[HEAP_RESTART_ENV];
  if (raw !== undefined && raw !== '') {
    const mb = Number.parseInt(raw, 10);
    if (!Number.isFinite(mb) || mb <= 0) return undefined;
    return {
      thresholdBytes: mb * 1024 * 1024,
      intervalMs: DEFAULT_INTERVAL_MS,
      consecutiveSamples: CONSECUTIVE_SAMPLES,
    };
  }
  if (env[DESKTOP_BUNDLED_ENV] !== '1') return undefined;
  if (!Number.isFinite(heapSizeLimit) || heapSizeLimit <= 0) return undefined;
  return {
    thresholdBytes: Math.floor(heapSizeLimit * DEFAULT_LIMIT_FRACTION),
    intervalMs: DEFAULT_INTERVAL_MS,
    consecutiveSamples: CONSECUTIVE_SAMPLES,
  };
}

export interface HeapWatchdogTrip {
  readonly heapUsed: number;
  readonly heapTotal: number;
  readonly rss: number;
  readonly thresholdBytes: number;
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
  let above = 0;
  let tripped = false;
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;

  const stop = (): void => {
    if (timer !== undefined) {
      cancel(timer);
      timer = undefined;
    }
  };

  const sample = (): boolean => {
    if (tripped) return false;
    const usage = memoryUsage();
    if (usage.heapUsed < deps.policy.thresholdBytes) {
      above = 0;
      return false;
    }
    above += 1;
    if (above < deps.policy.consecutiveSamples) return false;
    tripped = true;
    stop();
    deps.onTrip({
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      rss: usage.rss,
      thresholdBytes: deps.policy.thresholdBytes,
    });
    return true;
  };

  timer = schedule(() => {
    sample();
  }, deps.policy.intervalMs);
  (timer as { unref?: () => void }).unref?.();

  return { sample, stop };
}
