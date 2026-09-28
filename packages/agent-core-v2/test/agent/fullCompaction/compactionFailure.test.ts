import { describe, expect, it } from 'vitest';
import { APIEmptyResponseError, APIProviderQuotaExhaustedError, APIStatusError, normalizeAPIStatusError, isRetryableGenerateError } from '#/kosong/contract/errors';
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

  it('attaches sanitized status detail for all 4xx, including 429', () => {
    expect(normalizeAPIStatusError(403, 'Forbidden', null, null, null, { error: { code: 'FORBIDDEN', message: 'bad scope' } }).message).toContain('FORBIDDEN: bad scope');
    expect(normalizeAPIStatusError(429, 'Rate limit', null, null, null, { error: { code: 'RATE_LIMITED', message: 'slow down' } }).message).toContain('RATE_LIMITED: slow down');
    expect(normalizeAPIStatusError(409, 'Conflict', null, null, null, { error: { api_key: 'sk-SUPERSECRET123', code: 'CONTENT_FILTERED', message: 'filtered' } }).message).not.toContain('SUPERSECRET');
  });
});
