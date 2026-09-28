import {
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderQuotaExhaustedError,
  APIStatusError,
  isRetryableGenerateError,
} from '#/kosong/contract/errors';
import { isAbortError } from '#/_base/utils/abort';
import { isCodedError, unwrapErrorCause } from '#/errors';

export function compactionFailureKind(error: unknown): 'filtered' | 'auth' | 'quota' | 'timeout' | 'upstream' {
  const cause = unwrapErrorCause(error);
  if (cause instanceof APIEmptyResponseError && cause.finishReason === 'filtered') return 'filtered';
  if (isCodedError(cause) && cause.code === 'provider.filtered') return 'filtered';
  const status = cause instanceof APIStatusError ? cause : undefined;
  if (/CONTENT_FILTERED|content[_-]?filter/i.test(status?.message ?? '')) return 'filtered';
  if (status?.statusCode === 401 || status?.statusCode === 403) return 'auth';
  if (cause instanceof APIProviderQuotaExhaustedError ||
      /(?:insufficient_quota|quota[_ -]?(?:exceeded|exhausted)|billing[_ -]?(?:limit|exhausted))/i.test(status?.message ?? '')) return 'quota';
  if (/timeout|timed out/i.test(cause instanceof Error ? cause.message : '')) return 'timeout';
  return 'upstream';
}

export function isRetryableCompactionError(error: unknown): boolean {
  const cause = unwrapErrorCause(error);
  if (isAbortError(cause)) return false;
  const kind = compactionFailureKind(error);
  if (kind === 'filtered' || kind === 'auth' || kind === 'quota') return false;
  if (cause instanceof APIStatusError && cause.statusCode === 400 && !(cause instanceof APIContextOverflowError)) return false;
  return isRetryableGenerateError(cause);
}

export function describeCompactionFailure(error: unknown, provider: string, model: string, attempts: number): string {
  const cause = unwrapErrorCause(error);
  const status = cause instanceof APIStatusError ? cause : undefined;
  const kind = compactionFailureKind(error);
  const labels = { filtered: 'content filtered', auth: 'authentication failed', quota: 'quota exhausted', timeout: 'request timed out', upstream: 'upstream error' };
  const detail = cause instanceof Error ? cause.message : String(cause);
  const sanitized = detail.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\b(?:api[_-]?key|authorization|secret|access[_-]?token)\s*[=:]\s*\S+/gi, '[REDACTED]')
    .slice(0, 200);
  const code = /\b(CONTENT_FILTERED|content_filter|[A-Z][A-Z0-9_]{3,})\s*:/i.exec(detail)?.[1];
  const request = status?.requestId ?? status?.traceId;
  return `Automatic compaction failed (${labels[kind]}; HTTP ${status?.statusCode ?? 'n/a'}${code ? ` ${code}` : ''}; ${provider}/${model}${request ? `; request ${request}` : ''}; ${attempts} attempt${attempts === 1 ? '' : 's'}): ${sanitized}`;
}
