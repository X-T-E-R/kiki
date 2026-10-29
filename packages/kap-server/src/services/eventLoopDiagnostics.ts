import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import type { ILogService } from '@kiki/agent-core-v2/_base/log/log';

const RESOLUTION_MS = 20;
const INTERVAL_MS = 30_000;
const P99_WARN_MS = 100;
const MAX_WARN_MS = 500;

export function registerEventLoopDiagnostics(
  app: Pick<FastifyInstance, 'addHook'>,
  logger: Pick<ILogService, 'warn'>,
): void {
  let stop: (() => void) | undefined;
  app.addHook('onReady', async () => {
    const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    let windowStart = performance.now();
    let utilizationStart = performance.eventLoopUtilization();
    histogram.enable();
    const timer = setInterval(() => {
      const now = performance.now();
      const utilization = performance.eventLoopUtilization();
      const elapsedUtilization = performance.eventLoopUtilization(utilization, utilizationStart);
      const p99Ms = histogram.percentile(99) / 1e6;
      const maxMs = histogram.max / 1e6;
      if (histogram.count > 0 && (p99Ms >= P99_WARN_MS || maxMs >= MAX_WARN_MS)) {
        logger.warn('server event loop delayed', {
          event_type: 'server_event_loop_delay',
          window_ms: Math.round(now - windowStart),
          resolution_ms: RESOLUTION_MS,
          sample_count: histogram.count,
          p50_ms: Math.round(histogram.percentile(50) / 1e6),
          p99_ms: Math.round(p99Ms),
          max_ms: Math.round(maxMs),
          event_loop_utilization: Math.round(elapsedUtilization.utilization * 1000) / 1000,
        });
      }
      histogram.reset();
      windowStart = now;
      utilizationStart = utilization;
    }, INTERVAL_MS);
    timer.unref();
    stop = () => {
      clearInterval(timer);
      histogram.disable();
    };
  });
  app.addHook('onClose', async () => { stop?.(); });
}
