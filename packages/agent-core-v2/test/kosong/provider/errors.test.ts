import { APIError as AnthropicAPIError } from '@anthropic-ai/sdk';
import { Stream as AnthropicStream } from '@anthropic-ai/sdk/core/streaming';
import { ApiError as GoogleApiError } from '@google/genai';
import { APIError as OpenAIAPIError } from 'openai';
import { Stream as OpenAIStream } from 'openai/core/streaming';
import { describe, expect, it } from 'vitest';

import { fromErrorPayload, toErrorPayload } from '#/_base/errors/serialize';
import { attachErrorDetails } from '#/errors';

import { permitsFailureContinuation } from '#/features/externalHooks/internal/failureRecovery';
import {
  APIConnectionError,
  APIProviderQuotaExhaustedError,
  APIProviderRateLimitError,
  APIStatusError,
  ChatProviderError,
  createAbortError,
  hasExplicitRetryVeto,
  isRetryableGenerateError,
  isRetryableRequestInterruption,
  markProviderEventError,
  markProviderHttpError,
  normalizeAPIStatusError,
  noteExplicitUpstreamRetryDenial,
  sameRequestRetryProhibition,
} from '#/kosong/contract/errors';
import { safeProviderFailureDetails, safeResponsesTransportDiagnostics } from '#/kosong/contract/streamDiagnostics';
import type { ProtocolAdapterConfig } from '#/kosong/protocol/protocol';
import { traitConvertError, type TraitContext } from '#/kosong/protocol/protocolTrait';
import { convertAnthropicError } from '#/kosong/provider/bases/anthropic/anthropic';
import { convertGoogleGenAIError } from '#/kosong/provider/bases/google-genai/google-genai';
import { convertOpenAIError } from '#/kosong/provider/bases/openai/openai-common';
import { OpenAIResponsesStreamedMessage } from '#/kosong/provider/bases/openai/openai-responses';
import { composeOpenAIChatHooks } from '#/kosong/provider/bases/openai/openaiHooks';
import { generate } from '#/kosong/contract/generate';
import { guardRequestDelivery } from '#/kosong/provider/bases/request-delivery';
import { ResponsesWebSocketError } from '#/kosong/provider/bases/openai/responses-websocket';
import { kimiAnthropicTrait, kimiOpenAITrait } from '#/kosong/provider/providers/kimi/kimi.contrib';
import { classifyKimiQuotaError } from '#/kosong/provider/providers/kimi/kimi-errors';

const APIUserAbortError = class extends Error {};

function expectStandardAbort(run: () => unknown): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DOMException);
  expect((thrown as DOMException).name).toBe('AbortError');
}

describe('convertOpenAIError abort guard', () => {
  it('throws the standard abort DOMException for the standard abort shape', () => {
    expectStandardAbort(() => convertOpenAIError(createAbortError()));
  });

  it('throws for a bare Error named AbortError', () => {
    const bare = new Error('aborted');
    bare.name = 'AbortError';
    expectStandardAbort(() => convertOpenAIError(bare));
  });

  it('throws for an SDK APIUserAbortError', () => {
    expectStandardAbort(() => convertOpenAIError(new APIUserAbortError('user aborted')));
  });

  it('never classifies an abort as retryable', () => {
    expect(isRetryableGenerateError(createAbortError())).toBe(false);
  });
});

describe('convertAnthropicError abort guard', () => {
  it('throws the standard abort DOMException for abort shapes', () => {
    expectStandardAbort(() => convertAnthropicError(createAbortError()));
    expectStandardAbort(() => convertAnthropicError(new APIUserAbortError('user aborted')));
  });
});

describe('SDK stream error metadata', () => {
  it.each(['openai', 'anthropic'] as const)(
    'retains whitelisted %s HTTP 200 SSE error identifiers through serialization',
    async (protocol) => {
      const message = 'failed to stream request: empty response detected';
      const body = {
        error: { type: 'internal_server_error', code: 'stream_failed', message, request_id: 'body-request' },
        request_id: 'body-request',
      };
      const response = new Response(`event: error\ndata: ${JSON.stringify(body)}\n\n`, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-request-id': 'header-request',
          'request-id': 'header-request',
          'x-trace-id': 'header-trace',
          authorization: 'Bearer fixture-secret',
        },
      });
      const controller = new AbortController();
      const stream = protocol === 'openai'
        ? OpenAIStream.fromSSEResponse(response, controller)
        : AnthropicStream.fromSSEResponse(response, controller);
      let source: unknown;
      try {
        await consume(stream);
      } catch (error) {
        source = error;
      }
      expect(source).toBeInstanceOf(protocol === 'openai' ? OpenAIAPIError : AnthropicAPIError);
      const converted = protocol === 'openai' ? convertOpenAIError(source) : convertAnthropicError(source);
      const expectedMessage = protocol === 'openai' ? `Error: ${message}` : `Anthropic error: ${JSON.stringify(body)}`;
      expect(converted).toMatchObject({ name: 'ChatProviderError', code: 'provider.api_error', message: expectedMessage });
      expect(converted.details).toEqual({
        errorSource: 'provider_stream', upstreamErrorType: 'internal_server_error', upstreamErrorCode: 'stream_failed',
        requestId: 'header-request', traceId: 'header-trace', error_kind: 'unknown',
        upstreamDetails: { request_id: 'body-request' },
      });
      expect(isRetryableGenerateError(converted)).toBe(true);
      expect(convertOpenAIError(converted)).toBe(converted);
      expect(convertAnthropicError(converted)).toBe(converted);
      const payload = toErrorPayload(converted);
      expect(payload.message).toBe(expectedMessage);
      expect(payload.details).toEqual({ ...converted.details, errorSource: protocol === 'openai' ? 'provider_event' : 'provider_stream' });
      expect(fromErrorPayload(payload).details).toEqual(payload.details);
      expect(payload.cause).toBeUndefined();
      expect(JSON.stringify(payload.details)).not.toContain('fixture-secret');
      expect(payload.details).not.toHaveProperty('statusCode');
      expect(payload.details).not.toHaveProperty('headers');
      expect(payload.details).not.toHaveProperty('body');
    },
  );

  it('uses an envelope request ID when no response header ID is available', () => {
    const source = new AnthropicAPIError(undefined, {
      request_id: 'body-request',
      error: { type: 'internal_server_error', message: 'stream failed' },
    }, undefined, new Headers());
    expect(convertAnthropicError(source).details).toMatchObject({ requestId: 'body-request', upstreamErrorType: 'internal_server_error' });
  });

  it('omits invalid, oversized and credential-shaped metadata identifiers while retaining non-secret oversized fields in upstreamDetails', () => {
    const source = new OpenAIAPIError(undefined, {
      type: 'Authorization: Bearer fixture-secret', code: 'x'.repeat(201), message: 'stream failed',
      api_key: 'fixture-secret',
    }, 'stream failed', new Headers({ 'x-request-id': 'sk-fixture-secret-123', 'x-trace-id': 'invalid\ttrace' }));
    expect(convertOpenAIError(source).details).toEqual({
      errorSource: 'provider_stream', upstreamErrorType: null, upstreamErrorCode: null,
      requestId: null, traceId: null, error_kind: 'unknown',
      upstreamDetails: { code: 'x'.repeat(201) },
    });
  });

  it('retains error.error.error.message in upstreamDetails when SDK SSE error.message is only a generic transport error', () => {
    const specificNestedMessage = 'Upstream worker stream aborted: backend connection reset by peer.';
    const anthropicSource = new AnthropicAPIError(
      undefined,
      {
        type: 'error',
        error: {
          type: 'api_error',
          code: 'upstream_stream_reset',
          message: specificNestedMessage,
        },
      },
      'generic transport error',
      new Headers(),
    );
    Object.defineProperty(anthropicSource, 'message', {
      value: 'generic transport error',
      configurable: true,
    });
    const convertedAnthropic = convertAnthropicError(anthropicSource);
    expect(convertedAnthropic.message).toBe('Anthropic error: generic transport error');
    expect(toErrorPayload(convertedAnthropic).details).toMatchObject({
      errorSource: 'provider_stream',
      upstreamErrorType: 'api_error',
      upstreamErrorCode: 'upstream_stream_reset',
      upstreamDetails: {
        message: specificNestedMessage,
      },
    });

    const openaiSource = new OpenAIAPIError(
      undefined,
      {
        error: {
          type: 'server_error',
          code: 'upstream_stream_reset',
          message: specificNestedMessage,
        },
      },
      'generic transport error',
      new Headers(),
    );
    Object.defineProperty(openaiSource, 'message', {
      value: 'generic transport error',
      configurable: true,
    });
    const convertedOpenai = convertOpenAIError(openaiSource);
    expect(convertedOpenai.message).toBe('Error: generic transport error');
    expect(toErrorPayload(convertedOpenai).details).toMatchObject({
      errorSource: 'provider_event',
      upstreamErrorType: 'server_error',
      upstreamErrorCode: 'upstream_stream_reset',
      upstreamDetails: {
        message: specificNestedMessage,
      },
    });
  });
});

describe('non-abort classification still works', () => {
  it('passes ChatProviderError through unchanged', () => {
    const original = new ChatProviderError('wire issue');
    expect(convertOpenAIError(original)).toBe(original);
    expect(convertAnthropicError(original)).not.toBeUndefined();
  });

  it('classifies generic errors and keeps status errors retryable', () => {
    const timeout = convertOpenAIError(new Error('request timed out'));
    expect(isRetryableGenerateError(timeout)).toBe(true);

    const status = new APIStatusError(500, 'server error');
    expect(convertOpenAIError(status)).toBe(status);
    expect(isRetryableGenerateError(status)).toBe(true);
  });

  it('includes the provider body message on a 400', () => {
    const err = new OpenAIAPIError(
      400,
      { message: 'content_filter: the request was rejected', type: 'invalid_request_error' },
      'Bad Request',
      new Headers(),
    );
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect((result as APIStatusError).statusCode).toBe(400);
    expect(result.message).toContain('content_filter: the request was rejected');
    expect(isRetryableGenerateError(result)).toBe(false);
  });

  it('keeps a body-less 400 as the SDK status message', () => {
    const err = new OpenAIAPIError(400, undefined, 'Bad Request', new Headers());
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect(result.message).toBe('400 Bad Request');
    expect(isRetryableGenerateError(result)).toBe(false);
  });

  it('classifies a body-less 520 as a retryable status error', () => {
    const err = new OpenAIAPIError(520, undefined, undefined, new Headers());
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect(result).toMatchObject({
      name: 'APIStatusError',
      code: 'provider.api_error',
      statusCode: 520,
      message: '520 status code (no body)',
    });
    expect(isRetryableGenerateError(result)).toBe(true);
  });

  it('bounds an 800-char body already inlined by the OpenAI SDK message', () => {
    const detail = `provider-rejected-${'x'.repeat(800)}`;
    const err = new OpenAIAPIError(
      400,
      { message: detail, type: 'invalid_request_error' },
      'Bad Request',
      new Headers(),
    );
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect(result.message.length).toBeLessThanOrEqual(700);
    expect((result.message.match(/provider-rejected-/g) ?? []).length).toBe(1);
    expect(isRetryableGenerateError(result)).toBe(false);
  });

  it('redacts api_key and Authorization from an OpenAI 400 body', () => {
    const err = new OpenAIAPIError(
      400,
      {
        api_key: 'sk-live-SECRETVALUE',
        Authorization: 'Bearer super-secret-token',
        stack: 'internal stack',
      },
      'Bad Request',
      new Headers(),
    );
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect(result.message).toContain('[REDACTED]');
    expect(result.message).not.toContain('sk-live-SECRETVALUE');
    expect(result.message).not.toContain('super-secret-token');
    expect(result.message.length).toBeLessThanOrEqual(700);
  });

  it('bounds an 800-char body already inlined by the Anthropic SDK message', () => {
    const detail = `provider-rejected-${'x'.repeat(800)}`;
    const err = AnthropicAPIError.generate(
      400,
      { type: 'error', error: { type: 'invalid_request_error', message: detail } },
      'Bad Request',
      new Headers(),
    );
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect(result.message.length).toBeLessThanOrEqual(700);
    expect((result.message.match(/provider-rejected-/g) ?? []).length).toBe(1);
    expect(isRetryableGenerateError(result)).toBe(false);
  });

  it('redacts api_key and Authorization from an Anthropic 400 body', () => {
    const err = AnthropicAPIError.generate(
      400,
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          api_key: 'sk-live-SECRETVALUE',
          Authorization: 'Bearer super-secret-token',
          stack: 'internal stack',
        },
      },
      'Bad Request',
      new Headers(),
    );
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect(result.message).toContain('[REDACTED]');
    expect(result.message).not.toContain('sk-live-SECRETVALUE');
    expect(result.message).not.toContain('super-secret-token');
    expect(result.message.length).toBeLessThanOrEqual(700);
  });

  it('redacts labeled plaintext secrets inlined in the OpenAI SDK message', () => {
    const labeled = 'api_key=AIza-PLAINSECRET123 token: plainsecret123 Authorization: Basic plainsecret123';
    const err = new OpenAIAPIError(400, { message: labeled }, 'Bad Request', new Headers());
    const result = convertOpenAIError(err);
    expect(result.message).toContain('[REDACTED]');
    expect(result.message).not.toContain('AIza-PLAINSECRET123');
    expect(result.message).not.toContain('plainsecret123');
  });

  it('does not re-append a pretty-printed JSON body already present in the OpenAI message', () => {
    const payload = { api_key: 'sk-live-SECRETVALUE', stack: 'internal stack' };
    const pretty = JSON.stringify(payload, null, 2);
    const err = new OpenAIAPIError(400, payload, pretty, new Headers());
    const result = convertOpenAIError(err);
    expect(result.message).not.toContain('sk-live-SECRETVALUE');
    expect(result.message).toContain('internal stack');
    expect((result.message.match(/\[REDACTED\]/g) ?? []).length).toBe(1);
    expect(result.message).not.toContain(' — ');
  });

  it('keeps a status-less Messages api_error retryable and a status-less invalid_request permanent', () => {
    const retryable = convertAnthropicError(new AnthropicAPIError(undefined, {
      type: 'error',
      error: { type: 'api_error', message: 'upstream reset' },
    }, undefined, new Headers(), 'api_error'));
    expect(retryable).toMatchObject({ name: 'ChatProviderError', code: 'provider.api_error' });
    expect(isRetryableGenerateError(retryable)).toBe(true);

    const permanent = convertAnthropicError(new AnthropicAPIError(undefined, {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Invalid signature in thinking block' },
    }, undefined, new Headers(), 'invalid_request_error'));
    expect(permanent).toBeInstanceOf(APIStatusError);
    expect(permanent).toMatchObject({ statusCode: 400 });
    expect(isRetryableGenerateError(permanent)).toBe(false);
  });

  it('keeps an explicit upstream retryable false without writing retry false', () => {
    const denied = convertAnthropicError(new AnthropicAPIError(undefined, {
      type: 'error',
      error: { type: 'api_error', code: 'antigravity_missing_terminal', message: 'Upstream completed without a usable answer.', retryable: false },
    }, undefined, new Headers(), 'api_error'));
    expect(denied.details).toMatchObject({
      upstream_retryable: false,
      upstreamErrorCode: 'antigravity_missing_terminal',
      upstreamErrorType: 'api_error',
    });
    expect(denied.details).not.toHaveProperty('retry');
    expect(isRetryableGenerateError(denied)).toBe(false);
    expect(sameRequestRetryProhibition(toErrorPayload(denied).details)).toBe('upstream');
    expect(fromErrorPayload(toErrorPayload(denied)).details).toMatchObject({ upstream_retryable: false });
  });

  it.each([true, 'false', 0, null, undefined])('ignores upstream retryable %j and does not clear a local veto', (retryable) => {
    const body = { type: 'error', error: { type: 'api_error', code: 'antigravity_missing_terminal', message: 'again', retryable } };
    const converted = convertAnthropicError(new AnthropicAPIError(undefined, body, undefined, new Headers(), 'api_error'));
    expect(converted.details).not.toHaveProperty('upstream_retryable');
    expect(isRetryableGenerateError(converted)).toBe(true);
    const local = markProviderEventError(new ChatProviderError('terminal'), 'gateway_stream_terminal_error');
    noteExplicitUpstreamRetryDenial(local, body);
    expect(isRetryableGenerateError(local)).toBe(false);
    expect(sameRequestRetryProhibition(toErrorPayload(local).details)).toBe('stream_terminal');
    expect(toErrorPayload(local).details).toMatchObject({ retry: false });
  });

  it('permits a new message for the recorded Messages gateway terminal details', () => {
    const recorded = new ChatProviderError(
      'Anthropic error: {"error":{"code":"gateway_stream_terminal_error","message":"Upstream stream ended before a terminal event","status":502,"type":"upstream_error"},"type":"error"}',
      undefined,
      { details: {
        errorSource: 'provider_event',
        upstreamErrorType: 'upstream_error',
        upstreamErrorCode: 'gateway_stream_terminal_error',
        requestId: null,
        traceId: null,
        retry: false,
      } },
    );
    const payload = toErrorPayload(recorded);
    expect(payload.details).toMatchObject({ error_kind: 'unknown', errorSource: 'provider_event', retry: false });
    expect(payload.details).not.toHaveProperty('statusCode');
    expect(sameRequestRetryProhibition(payload.details)).toBe('stream_terminal');
    expect(permitsFailureContinuation(payload)).toBe(true);
    expect(isRetryableGenerateError(recorded)).toBe(false);
  });

  it('keeps an HTTP body that names gateway_stream_terminal_error continuable and does not resend it', () => {
    const body = {
      type: 'error',
      error: {
        code: 'gateway_stream_terminal_error',
        message: 'Upstream stream ended before a terminal event',
        status: 502,
        type: 'upstream_error',
      },
    };
    const anthropic = convertAnthropicError(new AnthropicAPIError(502, body, 'Bad Gateway', new Headers()));
    const responses = convertOpenAIError(new OpenAIAPIError(502, body.error, 'Bad Gateway', new Headers()));
    for (const converted of [anthropic, responses]) {
      const payload = toErrorPayload(converted);
      expect(payload).toMatchObject({
        code: 'provider.api_error',
        details: { errorSource: 'provider_http', upstreamErrorCode: 'gateway_stream_terminal_error', statusCode: 502, retry: false },
      });
      expect(sameRequestRetryProhibition(payload.details)).toBe('stream_terminal');
      expect(isRetryableGenerateError(converted)).toBe(false);
      expect(permitsFailureContinuation(payload)).toBe(true);
    }
    const permanent = markProviderHttpError(new APIStatusError(502, 'closed'), 'antigravity_upstream_terminal_error');
    expect(sameRequestRetryProhibition(toErrorPayload(permanent).details)).toBe('local');
    expect(permitsFailureContinuation(toErrorPayload(permanent))).toBe(false);
    const ordinary = convertAnthropicError(new AnthropicAPIError(502, {
      type: 'error', error: { type: 'api_error', message: 'temporary' },
    }, 'Bad Gateway', new Headers(), 'api_error'));
    expect(isRetryableGenerateError(ordinary)).toBe(true);
    expect(sameRequestRetryProhibition(toErrorPayload(ordinary).details)).toBeUndefined();
    const executed = markProviderHttpError(new APIStatusError(502, 'closed'), 'gateway_stream_terminal_error');
    attachErrorDetails(executed, { execution: 'executed' });
    expect(sameRequestRetryProhibition(toErrorPayload(executed).details)).toBe('local');
  });

  it('redacts labeled plaintext secrets inlined in the Anthropic SDK message', () => {
    const labeled = 'api_key=AIza-PLAINSECRET123 token: plainsecret123 Authorization: Basic plainsecret123';
    const err = AnthropicAPIError.generate(
      400,
      { type: 'error', error: { type: 'invalid_request_error', message: labeled } },
      'Bad Request',
      new Headers(),
    );
    const result = convertAnthropicError(err);
    expect(result.message).toContain('[REDACTED]');
    expect(result.message).not.toContain('AIza-PLAINSECRET123');
    expect(result.message).not.toContain('plainsecret123');
  });
});

async function* streamEvents(events: readonly Record<string, unknown>[]) {
  yield* events;
}

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _part of stream) {
    void _part;
  }
}

const QUOTA_MESSAGE =
  'Your account org-0123456789abcdef <ak-test> is suspended due to insufficient balance, please recharge your account or check your plan and billing details';

const TOKEN_QUOTA_MESSAGE =
  'You exceeded your current token quota: <org-0123456789abcdef> 31275, please check your account balance';

function moonshotQuota429(message: string, type?: string): OpenAIAPIError {
  return new OpenAIAPIError(
    429,
    type === undefined ? undefined : { message, type },
    `429 ${message}`,
    new Headers(),
  );
}

describe('classifyKimiQuotaError (Kimi trait classifier)', () => {
  it('classifies a structured exceeded_current_quota_error body as quota-exhausted', () => {
    const error = classifyKimiQuotaError(
      moonshotQuota429('Too many requests', 'exceeded_current_quota_error'),
    );
    expect(error).toBeInstanceOf(APIProviderQuotaExhaustedError);
    expect(isRetryableGenerateError(error)).toBe(false);
  });

  it.each([QUOTA_MESSAGE, TOKEN_QUOTA_MESSAGE])(
    'falls back to billing wording "%s" when no structured body is present',
    (message) => {
      const error = classifyKimiQuotaError(moonshotQuota429(message));
      expect(error).toBeInstanceOf(APIProviderQuotaExhaustedError);
      expect(isRetryableGenerateError(error)).toBe(false);
    },
  );

  it.each(['Too many requests', 'your token quota per minute was exceeded'])(
    'answers undefined for transient 429 "%s"',
    (message) => {
      expect(classifyKimiQuotaError(moonshotQuota429(message))).toBeUndefined();
    },
  );

  it('answers undefined for non-429 and non-SDK shapes', () => {
    expect(
      classifyKimiQuotaError(new OpenAIAPIError(403, undefined, QUOTA_MESSAGE, new Headers())),
    ).toBeUndefined();
    expect(classifyKimiQuotaError(new Error(QUOTA_MESSAGE))).toBeUndefined();
    expect(classifyKimiQuotaError(undefined)).toBeUndefined();
  });

  it('classifies the Anthropic SDK error shape (body nested under .error)', () => {
    const source = AnthropicAPIError.generate(
      429,
      { type: 'error', error: { type: 'exceeded_current_quota_error', message: 'quota gone' } },
      'Too many requests',
      new Headers(),
    );
    const error = classifyKimiQuotaError(source);
    expect(error).toBeInstanceOf(APIProviderQuotaExhaustedError);
    expect(isRetryableGenerateError(error)).toBe(false);
  });

  it('is declared as the convertError hook on both Kimi traits', () => {
    const context: TraitContext = {
      config: { protocol: 'openai', providerType: 'kimi', modelName: '' } as ProtocolAdapterConfig,
      providerId: 'kimi',
    };
    const source = moonshotQuota429('Too many requests', 'exceeded_current_quota_error');
    expect(kimiOpenAITrait.convertError!(source, context)).toBeInstanceOf(
      APIProviderQuotaExhaustedError,
    );
    expect(kimiAnthropicTrait.convertError!(source, context)).toBeInstanceOf(
      APIProviderQuotaExhaustedError,
    );
  });
});

describe('quota convertError hook retry metadata', () => {
  it.each(['anthropic', 'openai'] as const)('preserves an explicit SDK retry denial without changing the %s quota classification', (protocol) => {
    for (const retryable of [false, undefined]) {
      const body = { type: 'exceeded_current_quota_error', message: 'Example quota exhausted', retryable };
      const source = protocol === 'anthropic'
        ? AnthropicAPIError.generate(429, { type: 'error', error: body }, 'Too many requests', new Headers())
        : new OpenAIAPIError(429, body, 'Too many requests', new Headers());
      const converted = protocol === 'anthropic'
        ? convertAnthropicError(source, classifyKimiQuotaError)
        : convertOpenAIError(source, classifyKimiQuotaError);
      expect(converted).toBeInstanceOf(APIProviderQuotaExhaustedError);
      expect(converted).toMatchObject({ statusCode: 429 });
      expect(isRetryableGenerateError(converted)).toBe(false);
      expect(hasExplicitRetryVeto(converted)).toBe(retryable === false);
      if (retryable === false) expect(toErrorPayload(converted).details).toMatchObject({ upstream_retryable: false });
      else expect(toErrorPayload(converted).details).not.toHaveProperty('upstream_retryable');
    }
  });
});

describe('convertError hook consult at the OpenAI boundary', () => {
  const kimiContext: TraitContext = {
    config: { protocol: 'openai', providerType: 'kimi', modelName: '' } as ProtocolAdapterConfig,
    providerId: 'kimi',
  };

  it('prefers the composed hook over the vendor-neutral base classification', () => {
    const hooks = composeOpenAIChatHooks([{ trait: kimiOpenAITrait, context: kimiContext }]);
    const source = moonshotQuota429(QUOTA_MESSAGE);

    expect(convertOpenAIError(source)).toBeInstanceOf(APIProviderRateLimitError);
    expect(convertOpenAIError(source, hooks?.convertError)).toBeInstanceOf(
      APIProviderQuotaExhaustedError,
    );
  });

  it('binds convertError with last-declarer-wins semantics', () => {
    const bound = traitConvertError([
      { trait: { convertError: () => new ChatProviderError('first') }, context: kimiContext },
      { trait: { convertError: () => new ChatProviderError('second') }, context: kimiContext },
    ]);
    expect(bound!(new Error('anything'))?.message).toBe('second');
  });

  it('still throws the standard abort shape when a hook is present', () => {
    expectStandardAbort(() =>
      convertOpenAIError(createAbortError(), () => new ChatProviderError('never')),
    );
  });

  it('passes already-converted errors through without re-consulting the hook', () => {
    const calls: unknown[] = [];
    const converted = new APIProviderQuotaExhaustedError('already classified');
    const result = convertOpenAIError(converted, (error) => {
      calls.push(error);
      return new ChatProviderError('re-classified');
    });
    expect(result).toBe(converted);
    expect(calls).toHaveLength(0);
  });
});

describe('OpenAI base quota classification (vendor-neutral)', () => {
  it("fails fast on OpenAI's own insufficient_quota code without any hook", () => {
    const source = new OpenAIAPIError(
      429,
      {
        message: 'You exceeded your current quota, please check your plan and billing details.',
        type: 'insufficient_quota',
      },
      '429 You exceeded your current quota, please check your plan and billing details.',
      new Headers(),
    );

    const error = convertOpenAIError(source);

    expect(error).toBeInstanceOf(APIProviderQuotaExhaustedError);
    expect(isRetryableGenerateError(error)).toBe(false);
  });

  it('keeps vendor billing wordings a retryable rate limit without a hook', () => {
    const error = convertOpenAIError(moonshotQuota429(QUOTA_MESSAGE));
    expect(error).toBeInstanceOf(APIProviderRateLimitError);
    expect(isRetryableGenerateError(error)).toBe(true);
  });
});

describe('OpenAI Responses quota-exhausted conversion', () => {
  it('fails fast on a streamed insufficient_quota error event', async () => {
    const stream = new OpenAIResponsesStreamedMessage(
      streamEvents([
        {
          type: 'error',
          code: 'insufficient_quota',
          message: 'You exceeded your current quota, please check your plan and billing details.',
          param: null,
        },
      ]),
      true,
    );

    const caught = await consume(stream).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(APIProviderQuotaExhaustedError);
    expect(isRetryableGenerateError(caught)).toBe(false);
  });

  it('consults a convertError hook with the raw in-stream error event', async () => {
    const seen: unknown[] = [];
    const stream = new OpenAIResponsesStreamedMessage(
      streamEvents([
        {
          type: 'error',
          code: 'vendor_quota_gone',
          message: 'vendor says the quota is gone',
          param: null,
        },
      ]),
      true,
      (error) => {
        seen.push(error);
        return (error as { code?: string }).code === 'vendor_quota_gone'
          ? new APIProviderQuotaExhaustedError('vendor quota exhausted')
          : undefined;
      },
    );

    const caught = await consume(stream).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(APIProviderQuotaExhaustedError);
    expect((caught as APIProviderQuotaExhaustedError).message).toBe('vendor quota exhausted');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'error', code: 'vendor_quota_gone' });
  });
});

describe('Responses forwarded WebSocket close errors', () => {
  it.each(['sdk', 'failed'] as const)('preserves a custom error conversion veto for %s', async shape => {
    const error = { type: 'websocket_close_error', code: '1012', message: 'Service restarting.' };
    const source = shape === 'sdk'
      ? OpenAIStream.fromSSEResponse(new Response(`event: error\ndata: ${JSON.stringify({ error })}\n\n`, {
        headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-hook', 'x-trace-id': 'trace-hook' },
      }), new AbortController())
      : streamEvents([{ type: 'response.failed', response: { id: 'failed', status: 'failed', output: [], error } }]);
    const veto = attachErrorDetails(new ChatProviderError('Custom rejection.'), { retry: false });
    const seen: unknown[] = [];
    const failure = await consume(new OpenAIResponsesStreamedMessage(source, true, value => { seen.push(value); return veto; })).catch((error: unknown) => error);
    expect(failure).toBe(veto);
    expect(seen).toHaveLength(1);
    expect(isRetryableRequestInterruption(failure)).toBe(false);
    expect(toErrorPayload(failure).details).toMatchObject({
      upstreamErrorType: 'websocket_close_error',
      upstreamErrorCode: '1012',
      retry: false,
      upstreamDetails: { message: 'Service restarting.' },
    });
    if (shape === 'sdk') {
      expect(toErrorPayload(failure).details).toMatchObject({
        requestId: 'req-hook',
        traceId: 'trace-hook',
      });
    }
  });

  it.each(['sdk', 'failed'] as const)('classifies structured upstream close codes from %s without parsing text', async shape => {
    const error = { type: 'websocket_close_error', code: '1012', message: 'Service restarting.' };
    const source = shape === 'sdk'
      ? OpenAIStream.fromSSEResponse(new Response(`event: error\ndata: ${JSON.stringify({ error })}\n\n`, {
        headers: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-request' },
      }), new AbortController())
      : streamEvents([{ type: 'response.failed', response: { id: 'failed', status: 'failed', output: [], error } }]);
    const failure = await consume(new OpenAIResponsesStreamedMessage(source, true)).catch((error: unknown) => error);
    expect(toErrorPayload(failure)).toMatchObject({ name: 'APIConnectionError', code: 'provider.connection_error', details: {
      upstreamErrorType: 'websocket_close_error', upstreamErrorCode: '1012', websocketCloseCode: 1012, retry: true,
      responsesTransport: { transport: 'sse', webSocketCapabilities: false },
    } });
    expect(isRetryableRequestInterruption(failure)).toBe(true);
    if (shape === 'sdk') expect(toErrorPayload(failure).details).toHaveProperty('requestId', 'fixture-request');
  });

  it.each(['1002', '1008', 'not-a-code', '1012-extra'])( 'vetoes forwarded permanent or malformed close code %s', async code => {
    const source = OpenAIStream.fromSSEResponse(new Response(`event: error\ndata: ${JSON.stringify({ error: {
      type: 'websocket_close_error', code, message: 'websocket closed before terminal event (code 1012)',
    } })}\n\n`), new AbortController());
    const failure = await consume(new OpenAIResponsesStreamedMessage(source, true)).catch((error: unknown) => error);
    expect(toErrorPayload(failure)).toMatchObject({ code: 'provider.api_error', details: { retry: false } });
    expect(isRetryableGenerateError(failure)).toBe(false);
    expect(isRetryableRequestInterruption(failure)).toBe(false);
  });

  it.each(['invalid_request_error', 'insufficient_quota', 'antigravity_safety', undefined])('keeps a 1012 text/code lookalike with type %s out of interruption replay', async type => {
    const source = OpenAIStream.fromSSEResponse(new Response(`event: error\ndata: ${JSON.stringify({ error: {
      type, code: '1012', message: 'websocket closed before terminal event (code 1012)',
    } })}\n\n`), new AbortController());
    const failure = await consume(new OpenAIResponsesStreamedMessage(source, true)).catch((error: unknown) => error);
    expect(toErrorPayload(failure)).toMatchObject({ name: 'ChatProviderError', code: 'provider.api_error' });
    expect(isRetryableRequestInterruption(failure)).toBe(false);
  });

  it('preserves HTTP rejection status even when its body describes an upstream close', async () => {
    const source = { [Symbol.asyncIterator]() { return { async next(): Promise<IteratorResult<never>> {
      throw new OpenAIAPIError(400, { type: 'websocket_close_error', code: '1012', message: 'Service restarting.' }, undefined, new Headers());
    } }; } };
    const failure = await consume(new OpenAIResponsesStreamedMessage(source, true)).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'APIStatusError', statusCode: 400 });
    expect(isRetryableRequestInterruption(failure)).toBe(false);
  });
});

describe('Responses native WebSocket failure boundaries', () => {
  it('projects only bounded transport diagnostics without connection identity or headers', () => {
    const diagnostics = { transport: 'ws', webSocketCapabilities: true, webSocketCapabilityVersion: 2, webSocketConnectionAgeMs: 3_600_000 };
    expect(safeProviderFailureDetails({ responsesTransport: { ...diagnostics, url: 'https://example.test/private', headers: { authorization: 'secret' } } }))
      .toEqual({ responsesTransport: diagnostics });
    for (const invalid of [{ ...diagnostics, webSocketConnectionAgeMs: -1 }, { ...diagnostics, webSocketCapabilityVersion: 3 }, { ...diagnostics, transport: 'other' }]) {
      expect(safeResponsesTransportDiagnostics(invalid)).toBeUndefined();
    }
  });
  it.each(['ws', 'sse'] as const)('classifies the exact upstream connection-limit code over %s', async transport => {
    const stream = new OpenAIResponsesStreamedMessage(streamEvents([{ type: 'response.failed', response: {
      id: 'failed', status: 'failed', output: [], error: { code: 'websocket_connection_limit_reached', message: 'native connection limit' },
    } }]), true, undefined, undefined, () => ({
      transport, webSocketCapabilities: transport === 'ws', webSocketCapabilityVersion: transport === 'ws' ? 1 : null, webSocketConnectionAgeMs: transport === 'ws' ? 3600000 : null,
    }));
    const failure = await consume(stream).catch((error: unknown) => error);
    expect(toErrorPayload(failure)).toMatchObject({ code: 'provider.connection_error', details: {
      errorSource: 'provider_event', upstreamErrorCode: 'websocket_connection_limit_reached', responsesTransport: { transport },
    } });
  });

  it.each([
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'observed thought' }] },
    { type: 'reasoning', summary: [], encrypted_content: 'encrypted-fixture' },
    { type: 'web_search_call', id: 'builtin_fixture', status: 'completed' },
    { type: 'message', content: [{ type: 'refusal', refusal: 'refused' }] },
  ])('keeps actual failed-terminal output from being replayed: $type', async item => {
    const stream = new OpenAIResponsesStreamedMessage(streamEvents([{ type: 'response.failed', response: {
      id: 'failed', status: 'failed', output: [item], error: { code: 'websocket_connection_limit_reached', message: 'native limit' },
    } }]), true);
    const failure = await consume(stream).catch((error: unknown) => error);
    expect(isRetryableGenerateError(failure)).toBe(false);
    expect(toErrorPayload(failure).details).toMatchObject({ request_delivery: 'executed', request_output: 'observed' });
  });
});

describe.each(['failed', 'event_error', 'close'] as const)('Responses non-yielded output before %s', ending => {
  it.each([
    { name: 'refusal delta', observed: true, event: { type: 'response.refusal.delta', delta: 'refused' } },
    { name: 'hosted tool', observed: true, event: { type: 'response.output_item.done', item: { type: 'web_search_call', id: 'builtin_fixture', status: 'completed' } } },
    { name: 'encrypted thinking', observed: true, event: { type: 'response.output_item.added', item: { type: 'reasoning', id: 'reason_fixture', summary: [], encrypted_content: 'encrypted-fixture' } } },
    { name: 'reasoning summary', observed: true, event: { type: 'response.reasoning_summary_part.added', part: { type: 'summary_text', text: 'observed thought' } } },
    { name: 'summary part done', observed: true, event: { type: 'response.reasoning_summary_part.done', part: { type: 'summary_text', text: 'observed thought' } } },
    { name: 'summary text done', observed: true, event: { type: 'response.reasoning_summary_text.done', text: 'observed thought' } },
    { name: 'reasoning text delta', observed: true, event: { type: 'response.reasoning_text.delta', delta: 'observed thought' } },
    { name: 'reasoning text done', observed: true, event: { type: 'response.reasoning_text.done', text: 'observed thought' } },
    { name: 'refusal done', observed: true, event: { type: 'response.refusal.done', refusal: 'refused' } },
    { name: 'content refusal done', observed: true, event: { type: 'response.content_part.done', part: { type: 'refusal', refusal: 'refused' } } },
    { name: 'content text done', observed: true, event: { type: 'response.content_part.done', part: { type: 'output_text', text: 'observed text' } } },
    { name: 'output text done', observed: true, event: { type: 'response.output_text.done', text: 'observed text' } },
    { name: 'in-progress output snapshot', observed: true, event: { type: 'response.in_progress', response: { output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'observed thought' }] }] } } },
    { name: 'empty summary done', observed: false, event: { type: 'response.reasoning_summary_text.done', text: '' } },
    { name: 'empty refusal done', observed: false, event: { type: 'response.content_part.done', part: { type: 'refusal', refusal: '' } } },
    { name: 'empty message', observed: false, event: { type: 'response.output_item.added', item: { type: 'message', id: 'msg_fixture', role: 'assistant', content: [] } } },
    { name: 'empty reasoning', observed: false, event: { type: 'response.output_item.added', item: { type: 'reasoning', id: 'reason_fixture', summary: [] } } },
  ])('preserves $name through generate and the delivery guard', async ({ observed, event }) => {
    const events = (async function* () {
      yield { type: 'response.output_item.added', item: { type: 'message', id: 'msg_fixture', role: 'assistant', content: [] } };
      yield { type: 'response.content_part.added', part: { type: 'refusal', refusal: '' } };
      yield { type: 'response.output_item.added', item: { type: 'reasoning', id: 'reason_fixture', summary: [] } };
      yield { type: 'response.reasoning_summary_part.added', part: { type: 'summary_text', text: '' } };
      yield event;
      if (ending === 'close') throw new ResponsesWebSocketError('fixture close', 'responses_websocket_closed_before_terminal', { status: 1012 });
      if (ending === 'event_error') yield { type: 'error', code: 'websocket_connection_limit_reached', message: 'native limit' };
      else yield { type: 'response.failed', response: { id: 'failed', status: 'failed', output: [], error: { code: 'websocket_connection_limit_reached', message: 'native limit' } } };
    })();
    const stream = new OpenAIResponsesStreamedMessage(events, true);
    const failure = await generate({ name: 'fixture', modelName: 'fixture', thinkingEffort: null,
      generate: async () => guardRequestDelivery(stream, true) }, '', [], []).catch((error: unknown) => error);
    expect(isRetryableGenerateError(failure)).toBe(!observed);
    if (observed) expect(toErrorPayload(failure).details).toMatchObject({ request_delivery: 'executed', request_output: 'observed' });
    else expect(toErrorPayload(failure).details).not.toHaveProperty('request_output', 'observed');
  });
});

describe('convertGoogleGenAIError RetryInfo recovery', () => {
  function googleApiError(status: number, body: unknown): GoogleApiError {
    return new GoogleApiError({ message: JSON.stringify(body), status });
  }

  it('recovers the server-directed retry delay from the RetryInfo detail', () => {
    const error = convertGoogleGenAIError(
      googleApiError(429, {
        error: {
          code: 429,
          message: 'Resource exhausted',
          status: 'RESOURCE_EXHAUSTED',
          details: [
            { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [] },
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '5s' },
          ],
        },
      }),
    );
    expect(error).toBeInstanceOf(APIProviderRateLimitError);
    expect((error as APIStatusError).retryAfterMs).toBe(5000);
    expect(isRetryableGenerateError(error)).toBe(true);
  });

  it('parses fractional proto Duration delays', () => {
    const error = convertGoogleGenAIError(
      googleApiError(429, {
        error: {
          details: [
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '5.5s' },
          ],
        },
      }),
    );
    expect((error as APIStatusError).retryAfterMs).toBe(5500);
  });

  it('keeps an ordinary HTTP 429 retryable and honors an explicit false without clearing authentication', () => {
    const ordinary = convertAnthropicError(new AnthropicAPIError(429, {
      type: 'error', error: { type: 'rate_limit_error', message: 'slow down' },
    }, 'slow down', new Headers()));
    expect(isRetryableGenerateError(ordinary)).toBe(true);
    expect(ordinary.details).not.toHaveProperty('upstream_retryable');

    const denied = convertAnthropicError(new AnthropicAPIError(429, {
      type: 'error', error: { type: 'rate_limit_error', message: 'slow down', retryable: false },
    }, 'slow down', new Headers()));
    expect(isRetryableGenerateError(denied)).toBe(false);
    expect(toErrorPayload(denied).details).toMatchObject({ upstream_retryable: false, statusCode: 429 });
    expect(toErrorPayload(denied).details).not.toHaveProperty('retry');

    const authenticated = convertAnthropicError(new AnthropicAPIError(401, {
      type: 'error', error: { type: 'authentication_error', message: 'Sign in again', retryable: true },
    }, 'Sign in again', new Headers(), 'authentication_error'));
    expect(isRetryableGenerateError(authenticated)).toBe(false);
    expect(toErrorPayload(authenticated).details).not.toHaveProperty('upstream_retryable');

    const server = convertOpenAIError(new OpenAIAPIError(500, {
      error: { type: 'api_error', message: 'unavailable', retryable: false },
    }, 'unavailable', new Headers()));
    expect(isRetryableGenerateError(server)).toBe(false);
    expect(toErrorPayload(server).details).toMatchObject({ upstream_retryable: false });
    expect(sameRequestRetryProhibition(toErrorPayload(server).details)).toBe('upstream');
  });

  it('keeps a Google explicit retryable false distinct from a gateway terminal and a retry budget', () => {
    const denied = convertGoogleGenAIError(googleApiError(503, {
      error: { code: 503, message: 'unavailable', retryable: false },
    }));
    expect(isRetryableGenerateError(denied)).toBe(false);
    expect(sameRequestRetryProhibition(toErrorPayload(denied).details)).toBe('upstream');
    expect(toErrorPayload(denied).details).not.toHaveProperty('retry');

    const budget = attachErrorDetails(new APIConnectionError('dropped'), {
      retry: false, retry_exhausted: true, retry_attempts: 5, retry_max_attempts: 5,
    });
    expect(isRetryableGenerateError(budget)).toBe(false);
    expect(sameRequestRetryProhibition(toErrorPayload(budget).details)).toBe('budget');
    expect(toErrorPayload(budget).details).not.toHaveProperty('upstream_retryable');
  });

  it('keeps a 429 without RetryInfo a retryable rate limit with no server delay', () => {
    const error = convertGoogleGenAIError(
      googleApiError(429, { error: { code: 429, message: 'Too many requests' } }),
    );
    expect(error).toBeInstanceOf(APIProviderRateLimitError);
    expect((error as APIStatusError).retryAfterMs).toBeNull();
    expect(isRetryableGenerateError(error)).toBe(true);
  });

  it('tolerates a non-JSON ApiError message', () => {
    const error = convertGoogleGenAIError(
      new GoogleApiError({ message: 'Too many requests', status: 429 }),
    );
    expect(error).toBeInstanceOf(APIProviderRateLimitError);
    expect((error as APIStatusError).retryAfterMs).toBeNull();
  });

  it('recovers the delay from a mid-stream error chunk carrying the "got status" prefix', () => {
    const chunk = {
      error: {
        code: 429,
        message: 'Resource exhausted',
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '5s' }],
      },
    };
    const error = convertGoogleGenAIError(
      new GoogleApiError({
        message: `got status: RESOURCE_EXHAUSTED. ${JSON.stringify(chunk)}`,
        status: 429,
      }),
    );
    expect(error).toBeInstanceOf(APIProviderRateLimitError);
    expect((error as APIStatusError).retryAfterMs).toBe(5000);
  });

  it('retains ErrorInfo reason and structured details across domains in upstreamDetails without altering execution or retry semantics for non-supported domains', () => {
    const chunk = {
      error: {
        code: 500,
        message: 'Upstream model worker failed',
        status: 'INTERNAL',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'custom_worker_crash',
            domain: 'custom.gateway.domain',
            metadata: { worker_id: 'w-7', api_key: 'sk-SUPERSECRET999' },
          },
        ],
      },
    };
    const error = convertGoogleGenAIError(
      new GoogleApiError({
        message: JSON.stringify(chunk),
        status: 500,
      }),
    );
    expect(error).toBeInstanceOf(APIStatusError);
    expect(error.message).toContain('Upstream model worker failed');
    expect(isRetryableGenerateError(error)).toBe(true);
    const payload = toErrorPayload(error);
    expect(payload.details).toMatchObject({
      statusCode: 500,
      upstreamErrorType: 'INTERNAL',
    });
    expect(payload.details).not.toHaveProperty('upstreamErrorCode');
    expect(JSON.stringify(payload.details)).toContain('custom_worker_crash');
    expect(JSON.stringify(payload.details)).toContain('w-7');
    expect(JSON.stringify(payload.details)).not.toContain('SUPERSECRET999');

    const foreignDomainLookalike = convertGoogleGenAIError(
      new GoogleApiError({
        message: JSON.stringify({
          error: {
            code: 503,
            message: 'Third-party gateway temporary safety check timeout',
            status: 'UNAVAILABLE',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'antigravity_safety',
                domain: 'other.vendor.domain',
              },
            ],
          },
        }),
        status: 503,
      }),
    );
    expect(isRetryableGenerateError(foreignDomainLookalike)).toBe(true);
    const foreignPayload = toErrorPayload(foreignDomainLookalike);
    expect(foreignPayload.details).not.toHaveProperty('retry', false);
    expect(foreignPayload.details).not.toHaveProperty('upstreamErrorCode');
    expect(sameRequestRetryProhibition(foreignPayload.details)).toBeUndefined();
    expect(permitsFailureContinuation(foreignPayload)).toBe(true);
    expect(JSON.stringify(foreignPayload.details?.['upstreamDetails'])).toContain('antigravity_safety');
    expect(JSON.stringify(foreignPayload.details?.['upstreamDetails'])).toContain('other.vendor.domain');

    const supportedDomainSafety = convertGoogleGenAIError(
      new GoogleApiError({
        message: JSON.stringify({
          error: {
            code: 503,
            message: 'Antigravity safety stop',
            status: 'UNAVAILABLE',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'antigravity_safety',
                domain: 'sub2api.antigravity',
              },
            ],
          },
        }),
        status: 503,
      }),
    );
    expect(isRetryableGenerateError(supportedDomainSafety)).toBe(false);
    const supportedPayload = toErrorPayload(supportedDomainSafety);
    expect(supportedPayload.details).toMatchObject({
      statusCode: 503,
      errorSource: 'provider_http',
      upstreamErrorCode: 'antigravity_safety',
      retry: false,
    });
    expect(sameRequestRetryProhibition(supportedPayload.details)).toBe('local');
    expect(permitsFailureContinuation(supportedPayload)).toBe(false);
  });

  it('preserves Google HTTP 400 INVALID_ARGUMENT function-call turn ordering message and unknown error codes across normalization and display', () => {
    const turnOrderingMessage =
      'Please ensure that function call turn comes immediately after a user turn or after a function response turn.';
    const google400Body = {
      error: {
        code: 400,
        message: turnOrderingMessage,
        status: 'INVALID_ARGUMENT',
      },
    };
    const googleHttpError = convertGoogleGenAIError(
      new GoogleApiError({
        message: JSON.stringify(google400Body),
        status: 400,
      }),
    );
    expect(googleHttpError).toBeInstanceOf(APIStatusError);
    expect((googleHttpError as APIStatusError).statusCode).toBe(400);
    expect(googleHttpError.message).toContain(turnOrderingMessage);
    const googlePayload = toErrorPayload(googleHttpError);
    expect(googlePayload.details).toMatchObject({
      statusCode: 400,
      upstreamErrorType: 'INVALID_ARGUMENT',
    });

    const translated400 = normalizeAPIStatusError(
      400,
      '400 Bad Request',
      '00000000-0000-4000-8000-000000000001',
      null,
      null,
      {
        error: {
          code: 'unlisted_upstream_turn_order_error',
          status: 'INVALID_ARGUMENT',
          message: turnOrderingMessage,
          client_request_id: '00000000-0000-4000-8000-000000000002',
        },
      },
    );
    expect(translated400.message).toContain(
      `unlisted_upstream_turn_order_error: ${turnOrderingMessage}`,
    );
    const translatedPayload = toErrorPayload(translated400);
    expect(translatedPayload.details).toMatchObject({
      statusCode: 400,
      requestId: '00000000-0000-4000-8000-000000000001',
      upstreamErrorCode: 'unlisted_upstream_turn_order_error',
      upstreamErrorType: 'INVALID_ARGUMENT',
      upstreamDetails: {
        client_request_id: '00000000-0000-4000-8000-000000000002',
      },
    });
  });

  it('retains non-identifier codes (slash/space, >200 chars, or numeric), long type/request_id, full long messages when truncated, and request/trace IDs in upstreamDetails without altering execution or retry semantics', () => {
    const longCauseTail = ' [tail-marker: full upstream diagnostic preserved beyond summary cap]';
    const longUpstreamMessage = `Upstream rejected tool turn order: ${'detail-segment-'.repeat(45)}api_key=sk-live-SUPERSECRET999${longCauseTail}`;
    const longCode = `vendor_long_code_${'c'.repeat(210)}`;
    const longType = `vendor_long_type_${'t'.repeat(210)}`;
    const longBodyRequestId = `req_long_id_${'r'.repeat(210)}`;
    const slashSpaceError = normalizeAPIStatusError(
      400,
      '400 Bad Request',
      'req-slash-space-400',
      null,
      'trace-slash-space-400',
      {
        request_id: longBodyRequestId,
        error: {
          code: 'vendor/quota edge',
          type: 'gateway/upstream rejection',
          message: longUpstreamMessage,
          client_request_id: 'client-req-slash-space',
        },
      },
    );
    expect(slashSpaceError.message.length).toBeLessThanOrEqual(700);
    expect(slashSpaceError.message).toContain('vendor/quota edge:');
    expect(slashSpaceError.message).not.toContain(longCauseTail);
    expect(slashSpaceError.message).not.toContain('SUPERSECRET999');
    expect(isRetryableGenerateError(slashSpaceError)).toBe(false);

    const slashSpacePayload = toErrorPayload(slashSpaceError);
    expect(slashSpacePayload.details).toMatchObject({
      statusCode: 400,
      requestId: 'req-slash-space-400',
      traceId: 'trace-slash-space-400',
      upstreamDetails: {
        request_id: longBodyRequestId,
        code: 'vendor/quota edge',
        type: 'gateway/upstream rejection',
        client_request_id: 'client-req-slash-space',
      },
    });
    const retainedMessage = (
      slashSpacePayload.details?.['upstreamDetails'] as Record<string, unknown> | undefined
    )?.['message'];
    expect(typeof retainedMessage).toBe('string');
    expect(retainedMessage).toContain(longCauseTail);
    expect(retainedMessage).toContain('[REDACTED]');
    expect(retainedMessage).not.toContain('SUPERSECRET999');

    const distinctRequestIdsError = normalizeAPIStatusError(
      400,
      'Bad Request',
      'req-header',
      null,
      null,
      {
        request_id: 'req-body',
        error: {
          code: 'example/turn order',
          message: 'Specific order failure',
        },
      },
    );
    expect(toErrorPayload(distinctRequestIdsError).details).toMatchObject({
      statusCode: 400,
      requestId: 'req-header',
      upstreamDetails: {
        request_id: 'req-body',
        code: 'example/turn order',
      },
    });

    const mixedSecretMultilineError = normalizeAPIStatusError(
      400,
      '400 Bad Request',
      'req-multiline-400',
      null,
      null,
      {
        request_id: 'req-body\nshard-B',
        error: {
          code: 'vendor/quota\nphase-B',
          type: 'type-A api_key=EXAMPLE_ONLY type-B',
          status: 'status-A\nstatus-B',
          message: 'Primary rejection summary.',
          detail:
            'line 1: upstream shard=3 rejected payload\nline 2:\tapi_key=sk-live-RAWSECRET777 on edge-node-9\nline 3: retry after fixing turn order',
          pure_secret_note: 'sk-live-ONLYSECRET888',
          control_only_note: '\t\n\r',
        },
      },
    );
    const mixedPayload = toErrorPayload(mixedSecretMultilineError);
    const serializedMixedDetails = JSON.stringify(mixedPayload.details);
    expect(serializedMixedDetails).not.toContain('RAWSECRET777');
    expect(serializedMixedDetails).not.toContain('ONLYSECRET888');
    expect(serializedMixedDetails).not.toContain('EXAMPLE_ONLY');
    expect(mixedPayload.details).toMatchObject({
      statusCode: 400,
      requestId: 'req-multiline-400',
      upstreamDetails: {
        request_id: 'req-body\nshard-B',
        code: 'vendor/quota\nphase-B',
        type: 'type-A api_key=[REDACTED] type-B',
        status: 'status-A\nstatus-B',
        detail:
          'line 1: upstream shard=3 rejected payload\nline 2:\tapi_key=[REDACTED] on edge-node-9\nline 3: retry after fixing turn order',
      },
    });
    expect(
      (mixedPayload.details?.['upstreamDetails'] as Record<string, unknown> | undefined)?.[
        'pure_secret_note'
      ],
    ).toBeUndefined();
    expect(
      (mixedPayload.details?.['upstreamDetails'] as Record<string, unknown> | undefined)?.[
        'control_only_note'
      ],
    ).toBeUndefined();

    const mixedSecretCodeError = normalizeAPIStatusError(
      400,
      '400 Bad Request',
      'req-code-secret-400',
      null,
      null,
      {
        error: {
          code: 'phase-A api_key=EXAMPLE_ONLY phase-B',
          message: 'Secondary rejection summary.',
        },
      },
    );
    const mixedSecretCodePayload = toErrorPayload(mixedSecretCodeError);
    expect(JSON.stringify(mixedSecretCodePayload.details)).not.toContain('EXAMPLE_ONLY');
    expect(mixedSecretCodePayload.details).toMatchObject({
      statusCode: 400,
      requestId: 'req-code-secret-400',
      upstreamDetails: {
        code: 'phase-A api_key=[REDACTED] phase-B',
      },
    });

    const oversizedFieldsError = normalizeAPIStatusError(
      400,
      '400 Bad Request',
      null,
      null,
      null,
      {
        request_id: longBodyRequestId,
        error: {
          code: longCode,
          type: longType,
          message: 'Short upstream rejection reason.',
        },
      },
    );
    expect(toErrorPayload(oversizedFieldsError).details).toMatchObject({
      statusCode: 400,
      upstreamDetails: {
        request_id: longBodyRequestId,
        code: longCode,
        type: longType,
      },
    });

    const numericCodeError = normalizeAPIStatusError(
      502,
      '502 Bad Gateway',
      'req-numeric-502',
      null,
      'trace-numeric-502',
      {
        error: {
          code: 400102,
          status: 'UPSTREAM_BAD_GATEWAY',
          message: 'Upstream worker pool saturation.',
        },
      },
    );
    expect(numericCodeError.message).toContain('400102: Upstream worker pool saturation.');
    expect(isRetryableGenerateError(numericCodeError)).toBe(true);
    expect(sameRequestRetryProhibition(toErrorPayload(numericCodeError).details)).toBeUndefined();
    expect(toErrorPayload(numericCodeError).details).toMatchObject({
      statusCode: 502,
      requestId: 'req-numeric-502',
      traceId: 'trace-numeric-502',
      upstreamErrorType: 'UPSTREAM_BAD_GATEWAY',
      upstreamDetails: {
        code: 400102,
      },
    });
  });
});
