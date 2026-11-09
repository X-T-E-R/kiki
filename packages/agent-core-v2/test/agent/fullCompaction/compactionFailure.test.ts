import { describe, expect, it } from 'vitest';
import { attachErrorDetails, Error2, unwrapErrorCause } from '#/errors';
import { APIConnectionError, APIEmptyResponseError, APIProviderQuotaExhaustedError, APIStatusError, APITimeoutError, ambiguousRequestDelivery, normalizeAPIStatusError, isRetryableGenerateError, requestDeliveryProvenance } from '#/kosong/contract/errors';
import { compactionFailureKind, describeCompactionFailure, isRetryableCompactionError } from '#/agent/fullCompaction/compactionFailure';

describe('compaction-only retry classification', () => {
  it('never retries 409 CONTENT_FILTERED, even though general 409 remains retryable', () => {
    const error = normalizeAPIStatusError(409, 'Conflict', 'req-409', null, 'trace-409', {
      error: { code: 'CONTENT_FILTERED', message: 'Rejected by moderation' },
    });
    expect(error.message).toContain('CONTENT_FILTERED');
    expect(compactionFailureKind(error)).toBe('filtered');
    expect(isRetryableCompactionError(error)).toBe(false);
    expect(isRetryableGenerateError(error)).toBe(true);
    expect(describeCompactionFailure(error, 'anthropic', 'opus', 1)).toContain('filtered; HTTP 409 CONTENT_FILTERED; anthropic/opus; request req-409; 1 attempt');
    expect(describeCompactionFailure(error, 'anthropic', 'opus', 1)).toContain('Rejected by moderation');
    expect(isRetryableCompactionError(new APIStatusError(409, 'temporary conflict'))).toBe(true);
  });

  it('rejects filtered empty responses, auth, quota and non-overflow 400 without retries', () => {
    for (const error of [
      new APIEmptyResponseError('filtered', { finishReason: 'filtered' }),
      new APIStatusError(401, 'unauthorized'), new APIStatusError(403, 'forbidden'),
      new APIProviderQuotaExhaustedError('insufficient_quota'), new APIStatusError(400, 'invalid request'),
    ]) expect(isRetryableCompactionError(error)).toBe(false);
    expect(isRetryableCompactionError(new APIEmptyResponseError('empty'))).toBe(true);
    expect(isRetryableCompactionError(new APIStatusError(503, 'down'))).toBe(true);
  });

  it('retries a discarded empty summary after observed thinking while preserving terminal refusals', () => {
    const observed = <T extends Error>(error: T): T => attachErrorDetails(error, { request_delivery: 'executed', request_output: 'observed' });
    const empty = observed(new APIEmptyResponseError('thinking only'));
    expect(isRetryableGenerateError(empty)).toBe(false);
    expect(isRetryableCompactionError(empty)).toBe(true);
    expect(isRetryableCompactionError(new Error2(empty.code, 'summary request failed', { cause: empty }))).toBe(true);
    for (const error of [
      new APIEmptyResponseError('filtered', { finishReason: 'filtered' }),
      new APIStatusError(401, 'unauthorized'), new APIStatusError(403, 'forbidden'),
      new APIProviderQuotaExhaustedError('insufficient_quota'), new APIConnectionError('interrupted output'),
    ]) expect(isRetryableCompactionError(observed(error))).toBe(false);
    const cancelled = new Error2(empty.code, 'cancelled', { name: 'AbortError', cause: empty });
    expect(isRetryableCompactionError(cancelled)).toBe(false);
  });

  it('names manual and automatic failures from their actual trigger', () => {
    const error = new Error('summary failed');
    expect(describeCompactionFailure(error, 'fixture', 'model', 1, 'manual')).toMatch(/^Manual compaction failed/);
    expect(describeCompactionFailure(error, 'fixture', 'model', 1, 'auto')).toMatch(/^Automatic compaction failed/);
  });

  it('classifies no-output unknown delivery and parsed failures through the shared retry policy', () => {
    const unknown = ambiguousRequestDelivery(new APIConnectionError('terminated'));
    const timedOut = ambiguousRequestDelivery(new APITimeoutError('timed out'));
    const parsed = attachErrorDetails(new APIStatusError(429, 'slow down'), { errorSource: 'provider_event' });
    for (const error of [unknown, timedOut, parsed]) {
      expect(isRetryableCompactionError(error)).toBe(true);
      expect(isRetryableCompactionError(unwrapErrorCause(error))).toBe(true);
    }
    expect(requestDeliveryProvenance(unknown)).toBe('unknown');
    expect(parsed).toMatchObject({ statusCode: 429, message: 'slow down' });
    expect(isRetryableCompactionError(new APIStatusError(503, 'down'))).toBe(true);
    expect(requestDeliveryProvenance(new APIStatusError(401, 'unauthorized'))).toBeUndefined();
  });

  it('attaches sanitized status detail for all 4xx and 5xx, and formats stream error compaction failures accurately', () => {
    expect(normalizeAPIStatusError(403, 'Forbidden', null, null, null, { error: { code: 'FORBIDDEN', message: 'bad scope' } }).message).toContain('FORBIDDEN: bad scope');
    expect(normalizeAPIStatusError(429, 'Rate limit', null, null, null, { error: { code: 'RATE_LIMITED', message: 'slow down' } }).message).toContain('RATE_LIMITED: slow down');
    expect(normalizeAPIStatusError(502, '502 Bad Gateway', 'req-502', null, 'trace-502', { error: { code: 'gateway_stream_terminal_error', type: 'upstream_error', message: 'Upstream stream ended before a terminal event', extra_field: 'preserved' } })).toMatchObject({
      statusCode: 502,
      requestId: 'req-502',
      traceId: 'trace-502',
    });
    const status502 = normalizeAPIStatusError(502, '502 Bad Gateway', 'req-502', null, 'trace-502', { error: { code: 'gateway_stream_terminal_error', type: 'upstream_error', message: 'Upstream stream ended before a terminal event', extra_field: 'preserved' } });
    expect(status502.message).toContain('gateway_stream_terminal_error: Upstream stream ended before a terminal event');
    expect(normalizeAPIStatusError(409, 'Conflict', null, null, null, { error: { api_key: 'sk-SUPERSECRET123', code: 'CONTENT_FILTERED', message: 'filtered' } }).message).not.toContain('SUPERSECRET');

    const streamCompactionCause = attachErrorDetails(
      new Error2(
        'provider.api_error',
        'Anthropic error: {"error":{"code":"gateway_stream_terminal_error","message":"Upstream stream ended before a terminal event","status":502,"type":"upstream_error"},"type":"error"}',
      ),
      {
        errorSource: 'provider_stream',
        upstreamErrorType: 'upstream_error',
        upstreamErrorCode: 'gateway_stream_terminal_error',
        upstreamStatus: 502,
        requestId: 'req-stream-502',
      },
    );
    const described = describeCompactionFailure(
      ambiguousRequestDelivery(streamCompactionCause),
      'anthropic',
      'axon-message/gemini-4-argon',
      1,
    );
    expect(described).toContain('HTTP 502 gateway_stream_terminal_error; anthropic/axon-message/gemini-4-argon; request req-stream-502; 1 attempt');
    expect(described).toContain('Upstream stream ended before a terminal event');
    expect(described).not.toContain('HTTP n/a error');
  });
});
