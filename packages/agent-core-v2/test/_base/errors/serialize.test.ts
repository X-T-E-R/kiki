import { describe, expect, it } from 'vitest';

import '#/errors';

import { Error2, attachErrorDetails } from '#/_base/errors/errors';
import { toErrorDisplayMessage } from '#/_base/errors/errorMessage';
import { fromErrorPayload, toErrorPayload } from '#/_base/errors/serialize';
import { APIProviderRateLimitError } from '#/kosong/contract/errors';

describe('toErrorPayload', () => {
  it('passes a coded error through with registry retryability and details', () => {
    const payload = toErrorPayload(
      new Error2('provider.rate_limit', 'slow down', {
        name: 'APIStatusError',
        details: { statusCode: 429 },
      }),
    );
    expect(payload).toMatchObject({
      code: 'provider.rate_limit',
      message: 'slow down',
      name: 'APIStatusError',
      details: { statusCode: 429 },
      retryable: true,
    });
  });

  it('collapses an uncoded Error to internal', () => {
    const payload = toErrorPayload(new Error('boom'));
    expect(payload.code).toBe('internal');
    expect(payload.message).toBe('boom');
  });

  it('stringifies non-error throws', () => {
    expect(toErrorPayload('nope').code).toBe('internal');
    expect(toErrorPayload(undefined).code).toBe('internal');
  });

  it('serializes the cause chain recursively', () => {
    const payload = toErrorPayload(
      new Error2('provider.api_error', 'translated', {
        cause: new Error2('provider.connection_error', 'socket reset'),
      }),
    );
    expect(payload.code).toBe('provider.api_error');
    expect(payload.cause).toMatchObject({
      code: 'provider.connection_error',
      message: 'socket reset',
    });
  });

  it('caps cause recursion for pathologically deep chains', () => {
    let error: Error2 | undefined;
    for (let i = 0; i < 20; i += 1) {
      error = new Error2('internal', `layer ${i}`, error === undefined ? undefined : { cause: error });
    }
    const payload = toErrorPayload(error!);
    let depth = 0;
    let current = payload;
    while (current.cause !== undefined) {
      depth += 1;
      current = current.cause;
    }
    expect(depth).toBeLessThanOrEqual(8);
  });

  it('carries the provider error kind into the payload a host reads', () => {
    const payload = toErrorPayload(new APIProviderRateLimitError('Too many requests'));
    expect(payload).toMatchObject({
      code: 'provider.rate_limit',
      retryable: true,
      details: { error_kind: 'rate_limit' },
    });
  });

  it('adds no error kind to a non-provider failure', () => {
    expect(toErrorPayload(new Error('boom')).details).toBeUndefined();
    expect(toErrorPayload(new Error2('internal', 'boom', { details: { op: 'read' } })).details)
      .toEqual({ op: 'read' });
  });
});

describe('toErrorDisplayMessage', () => {
  it('projects exhausted attempts without changing the original error or duplicating a recovered summary', () => {
    const cause = new Error('upstream failure');
    const error = attachErrorDetails(new Error2('provider.api_error', 'generation_failed: Generation failed.', {
      cause, details: { statusCode: 500 },
    }), { retry: false, retry_exhausted: true, retry_attempts: 5, retry_max_attempts: 5 });
    const message = 'Retry attempts exhausted (5/5). generation_failed: Generation failed.';
    expect(toErrorDisplayMessage(error)).toBe(message);
    expect(error.message).toBe('generation_failed: Generation failed.');
    expect(error.cause).toBe(cause);
    const payload = toErrorPayload(error);
    expect(payload).toMatchObject({ code: 'provider.api_error', details: { statusCode: 500, retry_attempts: 5, retry_max_attempts: 5 } });
    expect(toErrorDisplayMessage(fromErrorPayload({ ...payload, message }))).toBe(message);
  });

  it.each([
    {},
    { retry: false },
    { retry_exhausted: true, retry_attempts: 0, retry_max_attempts: 5 },
    { retry_exhausted: true, retry_attempts: 2, retry_max_attempts: 5 },
    { retry_exhausted: true, retry_attempts: 5, retry_max_attempts: Number.NaN },
  ])('keeps ordinary errors and incomplete budgets unchanged: %j', details => {
    expect(toErrorDisplayMessage(new Error2('provider.auth_error', 'Access denied.', { details }))).toBe('Access denied.');
  });
});

describe('fromErrorPayload', () => {
  it('rehydrates a Error2 with its cause chain', () => {
    const original = new Error2('provider.api_error', 'outer', {
      details: { statusCode: 500 },
      cause: new Error2('provider.connection_error', 'inner'),
    });
    const revived = fromErrorPayload(toErrorPayload(original));
    expect(revived).toBeInstanceOf(Error2);
    expect(revived.code).toBe('provider.api_error');
    expect(revived.details).toMatchObject({ statusCode: 500 });
    expect(revived.cause).toBeInstanceOf(Error2);
    expect((revived.cause as Error2).code).toBe('provider.connection_error');
  });
});
