import {
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderQuotaExhaustedError,
  APIStatusError,
  isRetryableBufferedRequestError,
  isRetryableMalformedFunctionCallError,
  isRetryableMissingTerminalError,
  isSafetyProviderErrorCode,
  isStructuredQuotaExhaustedCode,
  readUpstreamSafetySubCode,
} from '#/kosong/contract/errors';
import { isAbortError } from '#/_base/utils/abort';
import { MAX_RETRY_AFTER_MS, readRetryAfterMs } from '#/_base/utils/retry';
import { sliceUtf16 } from '#/_base/text/utf16';
import { Error2, attachErrorDetails, isCodedError, readAttachedErrorDetails, toErrorDisplayMessage, toErrorPayload, unwrapErrorCause } from '#/errors';

export class CompactionToolOutputError extends Error {
  readonly code = 'compaction_tool_output';

  constructor(message = 'Compaction summary attempted to call tools after text-only correction.') {
    super(message);
    this.name = 'CompactionToolOutputError';
    attachErrorDetails(this, { retry: false, reason: 'compaction_tool_output' });
  }
}

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
  const upstreamErrorType = typeof details?.['upstreamErrorType'] === 'string' ? details['upstreamErrorType'].trim() : '';
  if (upstreamErrorType.length > 0 && isSafetyProviderErrorCode(upstreamErrorType)) return 'filtered';
  const subCode = readUpstreamSafetySubCode(details);
  if (subCode !== undefined && isSafetyProviderErrorCode(subCode)) return 'filtered';
  const status = cause instanceof APIStatusError ? cause : undefined;
  const message = status?.message ?? (cause instanceof Error ? cause.message : '');
  if (/CONTENT_FILTERED|content[_-]?filter|soft safety filter block|blocked by gemini's filters|safety filter blocks/i.test(message)) return 'filtered';
  if (status?.statusCode === 401 || status?.statusCode === 403) return 'auth';
  if (
    cause instanceof APIProviderQuotaExhaustedError ||
    isStructuredQuotaExhaustedCode(upstreamErrorCode) ||
    isStructuredQuotaExhaustedCode(upstreamErrorType)
  ) {
    return 'quota';
  }
  const statusMessage = status?.message ?? '';
  if (
    /(?:insufficient_quota|quota[_ -]?(?:exceeded|exhausted)|billing[_ -]?(?:limit|exhausted))/i.test(statusMessage) &&
    !/(?:per[ _-]?(?:second|minute)|(?:^|[^a-z])(?:rpm|tpm)(?:$|[^a-z]))/i.test(statusMessage)
  ) {
    return 'quota';
  }
  if (/timeout|timed out/i.test(cause instanceof Error ? cause.message : '')) return 'timeout';
  return 'upstream';
}

function statusCodeOf(error: unknown, cause: unknown): number | undefined {
  if (cause instanceof APIStatusError) return cause.statusCode;
  if (error instanceof APIStatusError) return error.statusCode;
  for (const candidate of [error, cause]) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const attached = readAttachedErrorDetails(candidate);
    const declared = candidate instanceof Error2 ? candidate.details : undefined;
    for (const raw of [attached?.['statusCode'], attached?.['upstreamStatus'], declared?.['statusCode'], declared?.['upstreamStatus']]) {
      if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
    }
  }
  return undefined;
}

function hasDetailFlag(error: unknown, key: string, expected: boolean | string): boolean {
  const visited = new Set<object>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current);
    const attached = readAttachedErrorDetails(current);
    const declared = current instanceof Error2 ? current.details : undefined;
    if (attached?.[key] === expected || declared?.[key] === expected) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

function isBufferedStreamTerminal502(error: unknown, cause: unknown): boolean {
  if (statusCodeOf(error, cause) !== 502) return false;
  const visited = new Set<object>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current);
    const attached = readAttachedErrorDetails(current);
    const declared = current instanceof Error2 ? current.details : undefined;
    const source = attached?.['errorSource'] ?? declared?.['errorSource'];
    const code = attached?.['upstreamErrorCode'] ?? declared?.['upstreamErrorCode'];
    if ((source === 'provider_event' || source === 'provider_http') && typeof code === 'string' && code.length > 0) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

export function isRetryableCompactionError(error: unknown, maxRetryAfterMs = MAX_RETRY_AFTER_MS): boolean {
  const cause = unwrapErrorCause(error);
  if (error instanceof CompactionToolOutputError || cause instanceof CompactionToolOutputError) return false;
  if (isAbortError(error) || isAbortError(cause)) return false;
  const kind = compactionFailureKind(error);
  if (kind === 'filtered' || kind === 'auth' || kind === 'quota') return false;
  if (hasDetailFlag(error, 'upstream_should_retry', false)) return false;
  if (hasDetailFlag(error, 'retry_exhausted', true)) return false;
  const statusCode = statusCodeOf(error, cause);
  if (statusCode === 429) {
    const retryAfterMs = readRetryAfterMs(cause) ?? readRetryAfterMs(error);
    if (retryAfterMs !== null && retryAfterMs > maxRetryAfterMs) return false;
    if (hasDetailFlag(error, 'upstream_retryable', false)) return false;
  } else if (
    hasDetailFlag(error, 'upstream_retryable', false) &&
    !isBufferedStreamTerminal502(error, cause) &&
    !isRetryableMalformedFunctionCallError(error) &&
    !isRetryableMissingTerminalError(error)
  ) {
    return false;
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
