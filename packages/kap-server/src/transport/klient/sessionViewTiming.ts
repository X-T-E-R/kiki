import { channel } from 'node:diagnostics_channel';

const timing = channel('kiki.session-view.timing');
const SLOW_PHASE_MS = 1_000;

export interface SessionViewTimingFields {
  readonly sessionId: string;
  readonly agentId?: string;
  readonly generation?: number;
  readonly transcriptGeneration?: number;
  readonly viewId?: string;
  readonly requestId?: string;
  readonly admittedAgents?: number;
  readonly priorityAgents?: number;
}

export interface SessionViewTimingContext {
  readonly logger?: { warn(fields: unknown, message: string): void };
  readonly signal?: AbortSignal;
  readonly generation?: number;
  readonly viewId?: string;
  readonly requestId?: string;
}

export function recordSessionViewTiming(
  stage: string,
  startedAt: number,
  fields: SessionViewTimingFields,
  context: SessionViewTimingContext = {},
): void {
  const record = { stage, durationMs: performance.now() - startedAt, ...fields };
  if (timing.hasSubscribers) timing.publish(record);
  if (record.durationMs >= SLOW_PHASE_MS) context.logger?.warn(record, 'session view phase');
}

/**
 * Publishes await outcomes on `kiki.session-view.timing`. One pending record at 1s,
 * slow completion, failure and abort requests also use the existing warning logger.
 * Abort requests retain observation until the original work actually settles.
 * `generation` identifies the client view; `transcriptGeneration` identifies its server subscription.
 */
export async function timeSessionViewPhase<T>(
  stage: string,
  fields: SessionViewTimingFields,
  call: () => Promise<T>,
  context: SessionViewTimingContext = {},
): Promise<T> {
  const startedAt = performance.now();
  let finished = false;
  const publish = (outcome: 'pending' | 'abort_requested' | 'succeeded' | 'failed' | 'cancelled'): void => {
    const record = { stage, outcome, durationMs: performance.now() - startedAt,
      signalAborted: context.signal?.aborted === true, ...fields };
    if (timing.hasSubscribers) timing.publish(record);
    if (outcome !== 'succeeded' || record.signalAborted || record.durationMs >= SLOW_PHASE_MS) {
      context.logger?.warn(record, 'session view phase');
    }
  };
  const slow = context.logger !== undefined || timing.hasSubscribers
    ? setTimeout(() => { if (!finished) publish('pending'); }, SLOW_PHASE_MS).unref()
    : undefined;
  const finish = (outcome: 'succeeded' | 'failed' | 'cancelled'): void => {
    if (finished) return;
    finished = true;
    clearTimeout(slow);
    context.signal?.removeEventListener('abort', onAbort);
    publish(outcome);
  };
  const onAbort = (): void => { if (!finished) publish('abort_requested'); };
  context.signal?.addEventListener('abort', onAbort, { once: true });
  if (context.signal?.aborted === true) onAbort();
  try {
    const result = await call();
    finish('succeeded');
    return result;
  } catch (error) {
    finish((error instanceof Error && error.name === 'AbortError') ||
      (context.signal?.aborted === true && error === context.signal.reason) ? 'cancelled' : 'failed');
    throw error;
  }
}
