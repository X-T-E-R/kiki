import type { ILogger, LogContext } from '#/_base/log/log';

export async function timeRestorePhase<T>(log: ILogger | undefined, context: LogContext, phase: string, action: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const report = (status: string) => log?.info('agent restore phase', { ...context, phase, status, elapsedMs: Math.round(performance.now() - started) });
  const pending = setTimeout(() => report('pending'), 1000);
  pending.unref?.();
  try {
    const result = await action();
    report('completed');
    return result;
  } catch (error) {
    report('failed');
    throw error;
  } finally {
    clearTimeout(pending);
  }
}
