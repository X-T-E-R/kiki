import {
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderQuotaExhaustedError,
  APIStatusError,
  isRetryableBufferedRequestError,
  isSafetyProviderErrorCode,
  readUpstreamSafetySubCode,
} from '#/kosong/contract/errors';
import { isAbortError } from '#/_base/utils/abort';
import { MAX_RETRY_AFTER_MS, readRetryAfterMs } from '#/_base/utils/retry';
import { sliceUtf16 } from '#/_base/text/utf16';
import { Error2, isCodedError, readAttachedErrorDetails, toErrorDisplayMessage, toErrorPayload, unwrapErrorCause } from '#/errors';

export function isStreamedSafetyRefusalText(text: string): boolean {
  return text.includes("This request was blocked by Gemini's filters.") && text.includes('generative-ai/use-policy');
}

export function compactionFailureKind(error: unknown): 'filtered' | 'auth' | 'quota' | 'timeout' | 'upstream' {
  const topDetails = typeof error === 'object' && error !== null ? toErrorPayload(error).details : undefined;
  if (topDetails?.['compaction_stream_filtered'] === true) return 'filtered';
  const topSubCode = readUpstreamSafetySubCode(topDetails);
  if (topSubCode !== undefined && isSafetyProviderErrorCode(topSubCode)) return 'filtered';
  const cause = unwrapErrorCause(error);
  if (cause instanceof APIEmptyResponseError && cause.finishReason === 'filtered') return 'filtered';
  if (isCodedError(cause) && cause.code === 'provider.filtered') return 'filtered';
  const details = typeof cause === 'object' && cause !== null ? toErrorPayload(cause).details : undefined;
  if (details?.['compaction_stream_filtered'] === true) return 'filtered';
  const upstreamErrorCode = typeof details?.['upstreamErrorCode'] === 'string' ? details['upstreamErrorCode'].trim() : '';
  if (upstreamErrorCode.length > 0 && isSafetyProviderErrorCode(upstreamErrorCode)) return 'filtered';
  const subCode = readUpstreamSafetySubCode(details);
  if (subCode !== undefined && isSafetyProviderErrorCode(subCode)) return 'filtered';
  const status = cause instanceof APIStatusError ? cause : undefined;
  const message = status?.message ?? (cause instanceof Error ? cause.message : '');
  if (/CONTENT_FILTERED|content[_-]?filter|soft safety filter block|blocked by gemini's filters|safety filter blocks/i.test(message)) return 'filtered';
  if (status?.statusCode === 401 || status?.statusCode === 403) return 'auth';
  if (cause instanceof APIProviderQuotaExhaustedError ||
      /(?:insufficient_quota|quota[_ -]?(?:exceeded|exhausted)|billing[_ -]?(?:limit|exhausted))/i.test(status?.message ?? '')) return 'quota';
  if (/timeout|timed out/i.test(cause instanceof Error ? cause.message : '')) return 'timeout';
  return 'upstream';
}

function is429CompactionError(error: unknown, cause: unknown): boolean {
  if (cause instanceof APIStatusError && cause.statusCode === 429) return true;
  if (error instanceof APIStatusError && error.statusCode === 429) return true;
  for (const candidate of [error, cause]) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const attached = readAttachedErrorDetails(candidate);
    const declared = candidate instanceof Error2 ? candidate.details : undefined;
    if (
      attached?.['statusCode'] === 429 ||
      attached?.['upstreamStatus'] === 429 ||
      declared?.['statusCode'] === 429 ||
      declared?.['upstreamStatus'] === 429
    ) {
      return true;
    }
  }
  return false;
}

function hasUpstreamRetryDenial(error: unknown): boolean {
  const visited = new Set<object>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current);
    const attached = readAttachedErrorDetails(current);
    const declared = current instanceof Error2 ? current.details : undefined;
    if (attached?.['upstream_retryable'] === false || declared?.['upstream_retryable'] === false) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

export function isRetryableCompactionError(error: unknown): boolean {
  const cause = unwrapErrorCause(error);
  if (isAbortError(error) || isAbortError(cause)) return false;
  const kind = compactionFailureKind(error);
  if (kind === 'filtered' || kind === 'auth' || kind === 'quota') return false;
  if (is429CompactionError(error, cause)) {
    const retryAfterMs = readRetryAfterMs(cause) ?? readRetryAfterMs(error);
    if (retryAfterMs !== null && retryAfterMs > MAX_RETRY_AFTER_MS) return false;
    if (hasUpstreamRetryDenial(error)) return false;
  }
  if (!isRetryableBufferedRequestError(error)) return false;
  if (cause instanceof APIStatusError && cause.statusCode === 400 && !(cause instanceof APIContextOverflowError)) return false;
  return true;
}

export function describeCompactionFailure(error: unknown, provider: string, model: string, attempts: number, source: 'manual' | 'auto' = 'auto'): string {
  const cause = unwrapErrorCause(error);
  const status = cause instanceof APIStatusError ? cause : undefined;
  const details = typeof cause === 'object' && cause !== null ? toErrorPayload(cause).details : undefined;
  const kind = compactionFailureKind(error);
  const labels = { filtered: 'content filtered', auth: 'authentication failed', quota: 'quota exhausted', timeout: 'request timed out', upstream: 'upstream error' };
  const detail = cause instanceof Error ? toErrorDisplayMessage(cause) : String(cause);
  const sanitized = sliceUtf16(detail.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\b(?:api[_-]?key|authorization|secret|access[_-]?token)\s*[=:]\s*\S+/gi, '[REDACTED]'), 0, 200);
  const statusNumber = status?.statusCode ??
    (typeof details?.['statusCode'] === 'number' ? details['statusCode'] : undefined) ??
    (typeof details?.['upstreamStatus'] === 'number' ? details['upstreamStatus'] : undefined);
  const upstreamErrorCode = typeof details?.['upstreamErrorCode'] === 'string' && details['upstreamErrorCode'].trim().length > 0
    ? details['upstreamErrorCode'].trim()
    : undefined;
  const code = upstreamErrorCode ?? /\b(CONTENT_FILTERED|content_filter|[A-Z][A-Z0-9_]{3,})\s*:/i.exec(detail)?.[1];
  const request = status?.requestId ?? status?.traceId ??
    (typeof details?.['requestId'] === 'string' ? details['requestId'] : undefined) ??
    (typeof details?.['traceId'] === 'string' ? details['traceId'] : undefined);
  return `${source === 'manual' ? 'Manual' : 'Automatic'} compaction failed (${labels[kind]}; HTTP ${statusNumber ?? 'n/a'}${code ? ` ${code}` : ''}; ${provider}/${model}${request ? `; request ${request}` : ''}; ${attempts} attempt${attempts === 1 ? '' : 's'}): ${sanitized}`;
}
