import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerEventLoopDiagnostics } from '../../src/services/eventLoopDiagnostics';

const { histogram, monitor } = vi.hoisted(() => {
  const histogram = {
    count: 100,
    max: 30_000_000,
    percentile: vi.fn((percentile: number): number => percentile === 50 ? 20_000_000 : 30_000_000),
    enable: vi.fn(),
    disable: vi.fn(),
    reset: vi.fn(),
  };
  return { histogram, monitor: vi.fn(() => histogram) };
});

vi.mock('node:perf_hooks', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:perf_hooks')>(),
  monitorEventLoopDelay: monitor,
}));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('event loop diagnostics', () => {
  it('stays quiet below the thresholds, resets every window and releases the monitor on close', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    histogram.count = 100;
    histogram.max = 30_000_000;
    histogram.percentile.mockImplementation((percentile) => percentile === 50 ? 20_000_000 : 30_000_000);
    const app = Fastify();
    const logger = { warn: vi.fn() };
    registerEventLoopDiagnostics(app, logger);
    expect(monitor).not.toHaveBeenCalled();
    await app.ready();
    expect(monitor).toHaveBeenCalledWith({ resolution: 20 });
    expect(histogram.enable).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(30_000);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(histogram.reset).toHaveBeenCalledOnce();
    await app.close();
    expect(histogram.disable).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(30_000);
    expect(histogram.reset).toHaveBeenCalledOnce();
  });

  it.each([
    { p99: 100_000_000, max: 200_000_000 },
    { p99: 30_000_000, max: 500_000_000 },
  ])('warns for p99 or a single long stall and includes a content-free window summary ($p99, $max)', async ({ p99, max }) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    histogram.count = 100;
    histogram.max = max;
    histogram.percentile.mockImplementation((percentile) => percentile === 50 ? 20_000_000 : p99);
    const app = Fastify();
    const logger = { warn: vi.fn() };
    registerEventLoopDiagnostics(app, logger);
    await app.ready();
    vi.advanceTimersByTime(30_000);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith('server event loop delayed', {
      event_type: 'server_event_loop_delay',
      window_ms: expect.any(Number),
      resolution_ms: 20,
      sample_count: 100,
      p50_ms: 20,
      p99_ms: p99 / 1e6,
      max_ms: max / 1e6,
      event_loop_utilization: expect.any(Number),
    });
    histogram.count = 0;
    vi.advanceTimersByTime(30_000);
    expect(logger.warn).toHaveBeenCalledOnce();
    await app.close();
  });
});
