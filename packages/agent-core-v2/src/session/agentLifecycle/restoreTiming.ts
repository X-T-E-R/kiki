import { AsyncLocalStorage } from 'node:async_hooks';
import type { ILogger, LogContext } from '#/_base/log/log';
import { abortable } from '#/_base/utils/abort';
import { Error2, ErrorCodes } from '#/errors';

export const SESSION_RESTORE_TIMEOUT_MS = 60_000;

export interface RestoreProgress {
  readonly phase: string;
  readonly startedAt: string;
  readonly elapsedMs: number;
  readonly queuePosition?: number;
}

interface RestoreAttempt {
  readonly controller: AbortController;
  readonly startedAt: number;
  readonly phases: Map<symbol, string>;
}

const attempts = new AsyncLocalStorage<RestoreAttempt>();
const observers = new AsyncLocalStorage<(progress: RestoreProgress) => void>();

export function observeRestore<T>(observer: (progress: RestoreProgress) => void, action: () => Promise<T>): Promise<T> {
  return observers.run(observer, action);
}

export function restoreQueueReporter(): (position: number) => void {
  const observer = observers.getStore();
  const startedAt = attempts.getStore()?.startedAt ?? Date.now();
  return (queuePosition) => observer?.({ phase: 'restore_queue', startedAt: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt, queuePosition });
}

export function restoreSignal(): AbortSignal | undefined {
  return attempts.getStore()?.controller.signal;
}

export function throwIfRestoreAborted(): void {
  restoreSignal()?.throwIfAborted();
}

export function withRestoreDeadline<T>(action: () => Promise<T>): Promise<T> {
  if (attempts.getStore() !== undefined) return action();
  const attempt: RestoreAttempt = { controller: new AbortController(), startedAt: Date.now(), phases: new Map() };
  return attempts.run(attempt, async () => {
    const timeout = setTimeout(() => {
      const phase = [...attempt.phases.values()].at(-1) ?? 'restore_queue';
      attempt.controller.abort(new Error2(ErrorCodes.SESSION_BUSY,
        `Session restoration timed out after ${SESSION_RESTORE_TIMEOUT_MS / 1000}s during ${phase}. Retry the saved message or cancel it.`,
        { details: { phase, elapsedMs: Date.now() - attempt.startedAt } }));
    }, SESSION_RESTORE_TIMEOUT_MS);
    timeout.unref?.();
    try {
      return await abortable(action(), attempt.controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  });
}

export async function timeRestorePhase<T>(log: ILogger | undefined, context: LogContext, phase: string, action: () => Promise<T>): Promise<T> {
  throwIfRestoreAborted();
  const started = performance.now();
  const attempt = attempts.getStore();
  const token = Symbol(phase);
  attempt?.phases.set(token, phase);
  const reportProgress = () => observers.getStore()?.({ phase: [...(attempt?.phases.values() ?? [phase])].at(-1) ?? phase,
    startedAt: new Date(attempt?.startedAt ?? Date.now()).toISOString(), elapsedMs: attempt === undefined ? Math.round(performance.now() - started) : Date.now() - attempt.startedAt });
  reportProgress();
  const report = (status: string) => log?.info('agent restore phase', { ...context, phase, status, elapsedMs: Math.round(performance.now() - started) });
  const pending = setTimeout(() => report('pending'), 1000);
  pending.unref?.();
  try {
    const promise = action();
    const result = attempt === undefined ? await promise : await abortable(promise, attempt.controller.signal);
    throwIfRestoreAborted();
    report('completed');
    return result;
  } catch (error) {
    report('failed');
    throw error;
  } finally {
    clearTimeout(pending);
    attempt?.phases.delete(token);
    if (!attempt?.controller.signal.aborted) reportProgress();
  }
}
