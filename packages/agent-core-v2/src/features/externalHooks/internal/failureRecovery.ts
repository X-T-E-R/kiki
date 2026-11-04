import type { ErrorPayload } from '#/_base/errors/serialize';
import { readProviderErrorIdentifier } from '#/kosong/contract/errors';

export const MAX_FAILURE_RECOVERIES_PER_TURN = 2;

export function failureHookInput(error: ErrorPayload): Record<string, unknown> {
  return {
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
    const status = entry.details?.['statusCode'];
    return entry.details?.['retry'] === false ||
      entry.details?.['request_delivery'] === 'ambiguous' ||
      entry.name === 'APIProviderQuotaExhaustedError' ||
      ['provider.auth_error', 'provider.filtered', 'provider.rate_limit', 'context.overflow'].includes(entry.code) ||
      typeof status === 'number' && status >= 400 && status < 500;
  });
}

function errorChain(error: ErrorPayload): ErrorPayload[] {
  const chain: ErrorPayload[] = [];
  for (let current: ErrorPayload | undefined = error; current !== undefined; current = current.cause) chain.push(current);
  return chain;
}
