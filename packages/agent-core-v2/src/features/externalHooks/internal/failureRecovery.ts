import type { ErrorPayload } from '#/_base/errors/serialize';
import { readProviderErrorIdentifier, sameRequestRetryProhibition } from '#/kosong/contract/errors';

export const MAX_FAILURE_RECOVERIES_PER_STREAK = 1;

const MERGED_DETAIL_KEYS = [
  'retry',
  'retry_exhausted',
  'retry_attempts',
  'retry_max_attempts',
  'request_delivery',
  'request_output',
  'finishReason',
  'rawFinishReason',
  'statusCode',
  'upstreamStatus',
] as const;

export function failureHookInput(error: ErrorPayload, hasPartialOutput: boolean): Record<string, unknown> {
  const chain = errorChain(error);
  return {
    hasPartialOutput,
    errorType: error.name,
    errorMessage: error.message,
    errorCode: error.code,
    errorDetails: mergeFailureErrorDetails(error, chain),
    upstreamErrorCode: chain.map((entry) => readProviderErrorIdentifier(entry.details?.['upstreamErrorCode'])).find((code) => code !== null),
    error,
  };
}

export function permitsFailureContinuation(error: ErrorPayload): boolean {
  const chain = errorChain(error);
  if (!chain.some((entry) => ['provider.api_error', 'provider.connection_error', 'provider.timeout', 'provider.overloaded'].includes(entry.code))) return false;
  return !chain.some((entry) => {
    const status = entry.details?.['statusCode'] ?? entry.details?.['upstreamStatus'];
    return sameRequestRetryProhibition(entry.details) === 'local' ||
      entry.name === 'APIProviderQuotaExhaustedError' ||
      ['provider.auth_error', 'provider.filtered', 'provider.rate_limit', 'context.overflow', 'config.invalid'].includes(entry.code) ||
      typeof status === 'number' && status >= 400 && status < 500;
  });
}

function mergeFailureErrorDetails(
  error: ErrorPayload,
  chain: readonly ErrorPayload[],
): Readonly<Record<string, unknown>> | undefined {
  const merged: Record<string, unknown> = { ...error.details };
  for (const entry of chain) {
    if (entry.details === undefined) continue;
    for (const key of MERGED_DETAIL_KEYS) {
      if (merged[key] === undefined && entry.details[key] !== undefined) {
        merged[key] = entry.details[key];
      }
    }
  }
  return Object.keys(merged).length > 0 ? merged : error.details;
}

function errorChain(error: ErrorPayload): ErrorPayload[] {
  const chain: ErrorPayload[] = [];
  for (let current: ErrorPayload | undefined = error; current !== undefined; current = current.cause) chain.push(current);
  return chain;
}
