import type { ErrorPayload } from '#/_base/errors/serialize';
import { readProviderErrorIdentifier, sameRequestRetryProhibition } from '#/kosong/contract/errors';

export const MAX_FAILURE_RECOVERIES_PER_STREAK = 1;

export function failureHookInput(error: ErrorPayload, hasPartialOutput: boolean): Record<string, unknown> {
  return {
    hasPartialOutput,
    errorType: error.name,
    errorMessage: error.message,
    errorCode: error.code,
    errorDetails: error.details,
    upstreamErrorCode: errorChain(error).map((entry) => readProviderErrorIdentifier(entry.details?.['upstreamErrorCode'])).find((code) => code !== null),
    error,
  };
}

export function permitsFailureContinuation(error: ErrorPayload): boolean {
  const chain = errorChain(error);
  if (!chain.some((entry) => ['provider.api_error', 'provider.connection_error', 'provider.overloaded'].includes(entry.code))) return false;
  return !chain.some((entry) => {
    const status = entry.details?.['statusCode'] ?? entry.details?.['upstreamStatus'];
    return sameRequestRetryProhibition(entry.details) === 'local' ||
      entry.name === 'APIProviderQuotaExhaustedError' ||
      ['provider.auth_error', 'provider.filtered', 'provider.rate_limit', 'context.overflow', 'config.invalid'].includes(entry.code) ||
      typeof status === 'number' && status >= 400 && status < 500;
  });
}

function errorChain(error: ErrorPayload): ErrorPayload[] {
  const chain: ErrorPayload[] = [];
  for (let current: ErrorPayload | undefined = error; current !== undefined; current = current.cause) chain.push(current);
  return chain;
}
