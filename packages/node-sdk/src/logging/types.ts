import type { ILogService } from '@moonshot-ai/agent-core-v2';

export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

export type LogContext = Record<string, unknown>;

/**
 * Second argument to `log.error / warn / info / debug`.
 *
 * Three usage shapes, detected at runtime:
 *   - `Error`     → stack is extracted onto the entry
 *   - `LogContext` (object) → merged into entry context; if it contains
 *                              `{ error: Error }`, that field is pulled out
 *                              and its stack extracted (bunyan-style)
 *   - `unknown`   → typically a `catch` binding; treated as an Error if
 *                   it's an Error instance, otherwise stringified into a
 *                   `reason` field
 */
export type LogPayload = unknown;

export interface Logger {
  error(message: string, payload?: LogPayload): void;
  warn(message: string, payload?: LogPayload): void;
  info(message: string, payload?: LogPayload): void;
  debug(message: string, payload?: LogPayload): void;
  /**
   * Returns a new logger that adds `ctx` to every entry it emits. The bound
   * context wins over per-call payload context, so callers can't accidentally
   * overwrite ownership fields like `sessionId` / `agentId`:
   *
   *   finalCtx = { ...payloadCtx, ...boundCtx }
   *
   * Children chain — `parent.createChild({a: 1}).createChild({b: 2})` binds
   * both.
   */
  createChild(ctx: LogContext): Logger;
}

/**
 * The engine-side logging seam the SDK's `log` writes through.
 *
 * The v2 engine owns both diagnostic log files: the app scope's `ILogService`
 * appends to `<homeDir>/logs/kimi-code.log`, and every live session scope has
 * its own `ILogService` appending to `<sessionDir>/logs/kimi-code.log` with
 * the session's `sessionId` bound and omitted from the rendered line. A host
 * that runs the engine in-process (`SDKRpcClient`) registers one of these, so
 * SDK-level diagnostics land in the same files, with the same format, level
 * and rotation, as the entries the engine writes for itself.
 */
export interface DiagnosticLogHost {
  /** App-scope logger; undefined once the host's scope is gone. */
  globalLog(): ILogService | undefined;
  /** The named session's own logger while that session is live in this host. */
  sessionLog(sessionId: string): ILogService | undefined;
  /** Every live session logger, for a whole-host flush. */
  liveSessionLogs(): readonly ILogService[];
}

export interface RootLogger {
  /**
   * Register an engine host. Untagged entries go to the most recently bound
   * host's global log, so a process that constructs a second harness starts
   * logging into the second home directory.
   */
  bind(host: DiagnosticLogHost): void;
  unbind(host: DiagnosticLogHost): void;
  isBound(): boolean;
  /** False if a log service rejected its flush. */
  flush(): Promise<boolean>;
  /** False if a bound host's global log rejected its flush. */
  flushGlobal(): Promise<boolean>;
  /** False if the session's log rejected its flush; true when it is not live. */
  flushSession(sessionId: string): Promise<boolean>;
  flushSync(): void;
}
