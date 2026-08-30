import { abortable } from '#/_base/utils/abort';

export const DEFAULT_MAX_RETRY_ATTEMPTS = 10;

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32_000;
const RETRY_FACTOR = 2;
const JITTER_FACTOR = 0.25;
/**
 * Cap on a provider-supplied retry-after. Overloaded relays advertise
 * 60–120s waits they recover from in seconds; honoring them verbatim
 * turns one flaky step into minutes of dead air, so probe again sooner
 * and let the attempt budget bound the total wait instead. A real 429
 * keeps the provider's value untouched: its Retry-After is a hard
 * rate-limit directive, not a relay hint.
 */
export const MAX_RETRY_AFTER_MS = 60_000;

export interface RetryErrorFields {
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

export function retryBackoffDelay(attemptIndex: number): number {
  const base = Math.min(BASE_DELAY_MS * Math.pow(RETRY_FACTOR, attemptIndex), MAX_DELAY_MS);
  return base + Math.random() * JITTER_FACTOR * base;
}

export function retryBackoffDelays(maxAttempts: number): number[] {
  const count = Math.max(maxAttempts - 1, 0);
  const delays: number[] = [];
  for (let i = 0; i < count; i += 1) {
    delays.push(retryBackoffDelay(i));
  }
  return delays;
}

export function readRetryAfterMs(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof value !== 'number' || value <= 0) return null;
  return maybeStatusCode(error) === 429 ? value : Math.min(value, MAX_RETRY_AFTER_MS);
}

export async function sleepForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const sleepPromise = sleep(delayMs);
  if (signal === undefined) {
    await sleepPromise;
    return;
  }
  await abortable(sleepPromise, signal);
}

export function retryErrorFields(error: unknown): RetryErrorFields {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    statusCode: maybeStatusCode(error),
  };
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function maybeStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number') return statusCode;
  const details = (error as { details?: unknown }).details;
  if (details !== null && typeof details === 'object') {
    const detailsStatus = (details as { statusCode?: unknown }).statusCode;
    if (typeof detailsStatus === 'number') return detailsStatus;
  }
  return undefined;
}
