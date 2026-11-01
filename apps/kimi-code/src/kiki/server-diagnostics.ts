import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getHeapStatistics } from 'node:v8';

export function installServerDiagnostics(homeDir: string): {
  record(event: string, details?: Record<string, unknown>): void;
} {
  const directory = join(homeDir, 'logs');
  const path = join(directory, 'server-runtime.log');
  const record = (event: string, details?: Record<string, unknown>): void => {
    try {
      mkdirSync(directory, { recursive: true });
      try {
        if (statSync(path).size >= 1024 * 1024) renameSync(path, `${path}.1`);
      } catch {}
      appendFileSync(path, `${JSON.stringify({
        time: new Date().toISOString(),
        pid: process.pid,
        event,
        uptimeSeconds: process.uptime(),
        heapLimitBytes: getHeapStatistics().heap_size_limit,
        ...process.memoryUsage(),
        ...details,
      })}\n`, { mode: 0o600 });
    } catch (error) {
      try {
        process.stderr.write(`Cannot write server runtime diagnostic: ${String(error)}\n`);
      } catch {}
    }
  };
  try {
    const reports = join(directory, 'reports');
    mkdirSync(reports, { recursive: true });
    process.report.directory = reports;
    process.report.excludeEnv = true;
    Object.assign(process.report, { excludeNetwork: true });
    process.report.reportOnFatalError = true;
    process.report.reportOnUncaughtException = true;
  } catch (error) {
    record('report_setup_failed', { error: String(error) });
  }
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    record('uncaught_exception', {
      origin, name: error.name, message: error.message, stack: error.stack,
    });
  });
  process.on('beforeExit', (code) => {
    record('before_exit', { code, resources: process.getActiveResourcesInfo() });
  });
  process.on('exit', (code) => { record('exit', { code }); });
  record('starting', { nodeVersion: process.versions.node });
  return { record };
}
