import { redactCtx, type ILogService } from '@kiki/agent-core-v2';

import type {
  DiagnosticLogHost,
  LogContext,
  LogLevel,
  LogPayload,
  Logger,
  RootLogger,
} from './types';

const ROOT_SYMBOL = Symbol.for('kimi.logger.root');

type EmitLevel = Exclude<LogLevel, 'off'>;

/**
 * Routes SDK diagnostics into the engine's own log services. It owns no sink
 * of its own: a bound host resolves the app scope's `ILogService` for untagged
 * entries and the named session's `ILogService` for session-tagged ones, which
 * is what makes an SDK-driven session's `logs/kimi-code.log` identical to the
 * file an engine-internal run writes.
 */
class RootLoggerImpl implements RootLogger {
  private readonly hosts: DiagnosticLogHost[] = [];

  bind(host: DiagnosticLogHost): void {
    this.unbind(host);
    this.hosts.push(host);
  }

  unbind(host: DiagnosticLogHost): void {
    const at = this.hosts.lastIndexOf(host);
    if (at !== -1) this.hosts.splice(at, 1);
  }

  isBound(): boolean {
    return this.hosts.length > 0;
  }

  emit(
    level: EmitLevel,
    message: string,
    payload: LogContext | undefined,
    sessionId: string | undefined,
  ): void {
    const target = this.resolveTarget(sessionId);
    if (target === undefined) return;
    target[level](message, payload);
  }

  async flush(): Promise<boolean> {
    return flushAll(this.collect((host) => [host.globalLog(), ...host.liveSessionLogs()]));
  }

  async flushGlobal(): Promise<boolean> {
    return flushAll(this.collect((host) => [host.globalLog()]));
  }

  async flushSession(sessionId: string): Promise<boolean> {
    return flushAll(this.collect((host) => [host.sessionLog(sessionId)]));
  }

  flushSync(): void {
    for (const target of this.collect((host) => [
      host.globalLog(),
      ...host.liveSessionLogs(),
    ])) {
      try {
        target.flushSync?.();
      } catch {
        // Diagnostic logging is best-effort, and this runs on a crash path.
      }
    }
  }

  /** @internal — vitest only. */
  reset(): void {
    this.hosts.length = 0;
  }

  /**
   * Newest host first: a session-tagged entry follows the session wherever it
   * is live, and an untagged one lands in the most recent harness's global
   * log. A session-tagged entry whose session is live nowhere still gets
   * written — to the active global log rather than dropped.
   */
  private resolveTarget(sessionId: string | undefined): ILogService | undefined {
    if (sessionId !== undefined) {
      for (let i = this.hosts.length - 1; i >= 0; i--) {
        const session = attempt(() => this.hosts[i]?.sessionLog(sessionId));
        if (session !== undefined) return session;
      }
    }
    for (let i = this.hosts.length - 1; i >= 0; i--) {
      const global = attempt(() => this.hosts[i]?.globalLog());
      if (global !== undefined) return global;
    }
    return undefined;
  }

  private collect(
    pick: (host: DiagnosticLogHost) => readonly (ILogService | undefined)[],
  ): ReadonlySet<ILogService> {
    const targets = new Set<ILogService>();
    for (const host of this.hosts) {
      for (const target of attempt(() => pick(host)) ?? []) {
        if (target !== undefined) targets.add(target);
      }
    }
    return targets;
  }
}

async function flushAll(targets: ReadonlySet<ILogService>): Promise<boolean> {
  const results = await Promise.all(
    [...targets].map((target) =>
      target.flush().then(
        () => true,
        () => false,
      ),
    ),
  );
  return results.every(Boolean);
}

/**
 * A disposed engine scope makes its accessor throw, and a resolution failure
 * must never surface through a diagnostic log call.
 */
function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function getRootInternal(): RootLoggerImpl {
  const globalAny = globalThis as Record<symbol, unknown>;
  const existing = globalAny[ROOT_SYMBOL];
  if (existing instanceof RootLoggerImpl) return existing;
  const fresh = new RootLoggerImpl();
  globalAny[ROOT_SYMBOL] = fresh;
  return fresh;
}

export function getRootLogger(): RootLogger {
  return getRootInternal();
}

export function flushDiagnosticLogs(): Promise<boolean> {
  return getRootInternal().flush();
}

/**
 * Synchronous variant for crash / emergency-exit paths that call
 * `process.exit()` on the same tick: pending entries are appended with
 * `appendFileSync`, so they survive the immediate exit that would otherwise
 * drop everything still sitting in the async queue.
 */
export function flushDiagnosticLogsSync(): void {
  getRootInternal().flushSync();
}

class LoggerImpl implements Logger {
  constructor(private readonly boundCtx: LogContext) {}

  error(message: string, payload?: LogPayload): void {
    this.emitAt('error', message, payload);
  }
  warn(message: string, payload?: LogPayload): void {
    this.emitAt('warn', message, payload);
  }
  info(message: string, payload?: LogPayload): void {
    this.emitAt('info', message, payload);
  }
  debug(message: string, payload?: LogPayload): void {
    this.emitAt('debug', message, payload);
  }

  createChild(ctx: LogContext): Logger {
    return new LoggerImpl({ ...this.boundCtx, ...ctx });
  }

  private emitAt(level: EmitLevel, message: string, payload: LogPayload): void {
    const root = getRootInternal();
    if (!root.isBound()) return;
    try {
      const ctx = mergePayload(payload, this.boundCtx);
      const sessionId = ctx?.['sessionId'];
      root.emit(level, message, ctx, typeof sessionId === 'string' ? sessionId : undefined);
    } catch {
      // Diagnostic logging is best-effort and must never affect main control flow.
    }
  }
}

/**
 * Fold the call-site payload and the bound context into the single object the
 * engine's `ILogger` takes. Bound ctx wins so a call site cannot overwrite
 * ownership fields; an `Error` payload rides as `{ error }`, which the engine
 * hoists and extracts the stack from.
 */
function mergePayload(payload: LogPayload, boundCtx: LogContext): LogContext | undefined {
  if (payload instanceof Error) return { ...boundCtx, error: payload };
  if (payload === undefined || payload === null) {
    return Object.keys(boundCtx).length === 0 ? undefined : { ...boundCtx };
  }
  if (typeof payload === 'object') {
    return { ...(payload as LogContext), ...boundCtx };
  }
  return { reason: describePrimitive(payload), ...boundCtx };
}

function describePrimitive(payload: Exclude<LogPayload, undefined | null>): string {
  if (typeof payload === 'function') {
    return payload.name === '' ? '[Function]' : `[Function: ${payload.name}]`;
  }
  return String(payload);
}

/**
 * Root logger. Import and use directly for events that don't belong to any
 * session (CLI startup, harness construction, etc.):
 *
 *   import { log } from 'kimi-code-sdk';
 *   log.info('kimi-code starting', { version });
 *
 * Tag an entry with `{ sessionId }` — directly or through
 * `log.createChild({ sessionId })` — to route it into that session's own
 * `logs/kimi-code.log` instead of the global one, for as long as the session
 * is live.
 *
 * Late-binding: methods look up the current `RootLogger` on every call, so
 * importing `log` at module load (before a harness registers its engine) is
 * safe — calls during the pre-bind window are silent noops.
 */
export const log: Logger = new LoggerImpl({});

export function redact<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return redactCtx({ value: value as unknown })['value'] as T;
}

/** @internal — vitest only. */
export async function __resetRootLoggerForTest(): Promise<void> {
  getRootInternal().reset();
  (globalThis as Record<symbol, unknown>)[ROOT_SYMBOL] = undefined;
  await Promise.resolve();
}
