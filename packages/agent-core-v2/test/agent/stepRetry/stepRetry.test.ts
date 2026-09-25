import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APIConnectionError,
  APIProviderOverloadedError,
  APIProviderRateLimitError,
  APIStatusError,
} from '#/kosong/contract/errors';
import { emptyUsage } from '#/kosong/contract/usage';
import { IEventBus } from '#/app/event/eventBus';
import { MAX_RETRY_AFTER_MS, readRetryAfterMs, retryBackoffDelays } from '#/_base/utils/retry';
import { IAgentLoopService } from '#/agent/loop/loop';
import { ContinuationStepRequest } from '#/agent/loop/stepRequest';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnStepRetrying } from '#/agent/stepRetry/stepRetryService';

import {
  createTestAgent,
  llmGenerateServices,
  permissionModeServices,
  type TestAgentContext,
  type TestAgentOptions,
  type TestAgentServiceOverride,
} from '../../harness';

const realSetTimeout = globalThis.setTimeout;

type RetryTestAgentInput = TestAgentOptions | TestAgentServiceOverride;

function createRetryTestAgent(...inputs: readonly RetryTestAgentInput[]): TestAgentContext {
  return createTestAgent(...inputs, permissionModeServices('manual'));
}

describe('stepRetry plugin', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    vi.useRealTimers();
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      vi.unstubAllEnvs();
    }
  });

  function rpcEvents(name: string) {
    return ctx.allEvents.filter((event) => event.type === '[rpc]' && event.event === name);
  }

  function wireLoopEvents(eventType: string): Array<Record<string, unknown>> {
    return ctx.allEvents
      .filter(
        (entry) =>
          entry.type === '[wire]' &&
          entry.event === 'context.append_loop_event' &&
          (entry.args as { event?: { type?: string } }).event?.type === eventType,
      )
      .map((entry) => (entry.args as { event: Record<string, unknown> }).event);
  }

  async function runTurn(turnId: number, signal?: AbortSignal) {
    void ctx.dispatcher.dispatch(new TurnStarted({ turnId, origin: { kind: 'user' } }));
    const loop = ctx.get(IAgentLoopService);
    loop.enqueue(new ContinuationStepRequest());
    const resultPromise = loop.run({ turnId, signal });
    let settled = false;
    void resultPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    for (let i = 0; i < 100; i += 1) {
      if (settled) break;
      await vi.runAllTimersAsync();
      if (!settled) {
        await new Promise((resolve) => realSetTimeout(resolve, 1));
      }
    }
    return resultPromise;
  }

  it('retries a body-less 520 and resumes the same step number', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls === 1) throw new APIStatusError(520, '520 status code (no body)');
        return {
          id: 'retry-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'recovered' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );

    const result = await runTurn(1);

    expect(result).toEqual({ type: 'completed', steps: 2, truncated: false });
    expect(calls).toBe(2);
    expect(rpcEvents('turn.step.retrying')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({
          turnId: 1,
          step: 1,
          failedAttempt: 1,
          nextAttempt: 2,
          maxAttempts: 5,
          delayMs: expect.any(Number),
          errorName: 'APIStatusError',
          errorMessage: '520 status code (no body)',
          statusCode: 520,
        }),
      }),
    ]);
    const retryArgs = rpcEvents('turn.step.retrying')[0]?.args as { delayMs: number };
    expect(retryArgs.delayMs).toBeGreaterThanOrEqual(2_000);
    expect(retryArgs.delayMs).toBeLessThanOrEqual(2_500);
    expect(
      rpcEvents('turn.step.started').map((event) => (event.args as { step: number }).step),
    ).toEqual([1, 2]);
    expect(rpcEvents('turn.step.interrupted')).toEqual([]);
    expect(ctx.contextData().history).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: [{ type: 'text', text: 'recovered' }],
      }),
    ]);
  });

  it('pairs every retried step.begin with a step.end in the wire', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls === 1) throw new APIConnectionError('terminated');
        return {
          id: 'retry-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'recovered' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );

    const result = await runTurn(1);

    expect(result).toEqual({ type: 'completed', steps: 2, truncated: false });
    const begins = wireLoopEvents('step.begin');
    const ends = wireLoopEvents('step.end');
    expect(begins).toHaveLength(2);
    expect(ends.map((event) => event['finishReason'])).toEqual(['error', 'end_turn']);
    expect(ends.map((event) => event['uuid'])).toEqual(begins.map((event) => event['uuid']));
  });

  it('surfaces a classified 520 after the default attempt budget is exhausted', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw new APIStatusError(520, '520 status code (no body)');
      }),
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    if (result.type !== 'failed') throw new Error('Expected the turn to fail');
    expect(result.error).toBeInstanceOf(APIStatusError);
    expect(result.error).toMatchObject({
      name: 'APIStatusError',
      code: 'provider.api_error',
      statusCode: 520,
      message: '520 status code (no body)',
    });
    expect(calls).toBe(5);
    expect(rpcEvents('turn.step.retrying')).toHaveLength(4);
    expect(rpcEvents('turn.step.interrupted')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({
          reason: 'error',
          step: 5,
          message: '[provider.api_error] 520 status code (no body)',
        }),
      }),
    ]);
  });

  it('honors the provider retry-after delay before retrying', async () => {
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls === 1) throw new APIProviderRateLimitError('slow down', null, 1);
        return {
          id: 'retry-after-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'recovered' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );

    void ctx.dispatcher.dispatch(new TurnStarted({ turnId: 1, origin: { kind: 'user' } }));
    const loop = ctx.get(IAgentLoopService);
    loop.enqueue(new ContinuationStepRequest());
    const result = await loop.run({ turnId: 1 });

    expect(result.type).toBe('completed');
    expect(rpcEvents('turn.step.retrying')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({ delayMs: 1 }),
      }),
    ]);
  });

  it('clamps an excessive relay retry-after to the 60s cap', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls === 1) throw new APIProviderOverloadedError(503, 'relay overloaded', null, 120_000);
        return {
          id: 'clamped-retry-after-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'recovered' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );

    const result = await runTurn(1);

    expect(result.type).toBe('completed');
    expect(rpcEvents('turn.step.retrying')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({ delayMs: MAX_RETRY_AFTER_MS }),
      }),
    ]);
  });

  it('does not retry a non-retryable error', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw new APIStatusError(401, 'unauthorized');
      }),
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(calls).toBe(1);
    expect(rpcEvents('turn.step.retrying')).toEqual([]);
  });

  it('cancels the turn when aborted during the backoff wait', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        throw new APIConnectionError('terminated');
      }),
    );
    ctx.get(IEventBus).subscribe(TurnStepRetrying, () => {
      controller.abort(new Error('stop'));
    });

    const result = await runTurn(1, controller.signal);

    expect(result.type).toBe('cancelled');
  });

  it('honors loop_control.max_attempts_per_step', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createRetryTestAgent(llmGenerateServices(async () => {
      calls += 1;
      throw new APIConnectionError('terminated');
    }), {
      initialConfig: { loopControl: { maxAttemptsPerStep: 1 } },
    });

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(calls).toBe(1);
    expect(rpcEvents('turn.step.retrying')).toEqual([]);
  });

  it('starts a fresh attempt budget on the next turn', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let failing = true;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        if (failing) {
          calls += 1;
          throw new APIConnectionError('terminated');
        }
        return {
          id: 'ok-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );

    const first = await runTurn(1);
    expect(first.type).toBe('failed');
    expect(calls).toBe(5);

    failing = false;
    const second = await runTurn(2);
    expect(second).toEqual({ type: 'completed', steps: 1, truncated: false });
  });

  it('retries any request error inside the request when KIKI_INFINITE_RETRY is set', async () => {
    vi.useFakeTimers();
    vi.stubEnv('KIKI_INFINITE_RETRY', '1');
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls === 1) throw new APIStatusError(400, 'endpoint broken');
        if (calls === 2) throw new APIStatusError(404, 'model not found');
        if (calls === 3) throw new APIStatusError(429, 'slow down');
        return {
          id: 'infinite-retry-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'recovered' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );

    const result = await runTurn(1);

    expect(result).toEqual({ type: 'completed', steps: 1, truncated: false });
    expect(calls).toBe(4);
    expect(rpcEvents('turn.step.retrying')).toEqual([]);
    expect(rpcEvents('turn.step.interrupted')).toEqual([]);
  });

  it('keeps retrying past the per-step attempt budget when KIKI_INFINITE_RETRY is set', async () => {
    vi.useFakeTimers();
    vi.stubEnv('KIKI_INFINITE_RETRY', '1');
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls <= 12) throw new APIStatusError(429, 'slow down');
        return {
          id: 'infinite-retry-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'recovered' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );

    const result = await runTurn(1);

    expect(result).toEqual({ type: 'completed', steps: 1, truncated: false });
    expect(calls).toBe(13);
    expect(rpcEvents('turn.step.retrying')).toEqual([]);
  });

  it('cancels the turn when aborted during an infinite retry backoff', async () => {
    vi.useFakeTimers();
    vi.stubEnv('KIKI_INFINITE_RETRY', '1');
    const controller = new AbortController();
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw new APIStatusError(400, 'endpoint broken');
      }),
    );
    setTimeout(() => controller.abort(new Error('stop')), 100);

    const result = await runTurn(1, controller.signal);

    expect(result.type).toBe('cancelled');
    expect(calls).toBe(1);
  });

  it('keeps the default attempt budget when no retry policy matches the error', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw new APIConnectionError('terminated');
      }),
      { initialConfig: { retry: { policies: [{ match: 'SomeOtherError' }] } } },
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(calls).toBe(5);
    expect(rpcEvents('turn.step.retrying')).toHaveLength(4);
    expect(rpcEvents('turn.step.retrying')[0]).toEqual(
      expect.objectContaining({
        args: expect.objectContaining({ failedAttempt: 1, maxAttempts: 5 }),
      }),
    );
  });

  it('applies a matched policy attempt budget and flat backoff', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls === 1) throw new APIConnectionError('terminated');
        return {
          id: 'policy-retry-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'recovered' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
      {
        initialConfig: {
          retry: {
            policies: [{ match: 'APIConnectionError', maxAttempts: 2, backoff: 1_234 }],
          },
        },
      },
    );

    const result = await runTurn(1);

    expect(result).toEqual({ type: 'completed', steps: 2, truncated: false });
    expect(calls).toBe(2);
    expect(rpcEvents('turn.step.retrying')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({
          failedAttempt: 1,
          nextAttempt: 2,
          maxAttempts: 2,
          delayMs: 1_234,
          errorName: 'APIConnectionError',
        }),
      }),
    ]);
  });

  it('honors the retry section attempt budget when no policy matches', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw new APIConnectionError('terminated');
      }),
      { initialConfig: { retry: { maxAttempts: 3 } } },
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(calls).toBe(3);
    expect(rpcEvents('turn.step.retrying')).toHaveLength(2);
    expect(rpcEvents('turn.step.retrying')[1]).toEqual(
      expect.objectContaining({
        args: expect.objectContaining({ failedAttempt: 2, maxAttempts: 3 }),
      }),
    );
  });

  it('lets a matched policy override the retry section attempt budget', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw new APIConnectionError('terminated');
      }),
      {
        initialConfig: {
          retry: {
            maxAttempts: 4,
            policies: [{ match: 'APIConnectionError', maxAttempts: 2, backoff: 10 }],
          },
        },
      },
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(calls).toBe(2);
    expect(rpcEvents('turn.step.retrying')).toEqual([
      expect.objectContaining({ args: expect.objectContaining({ maxAttempts: 2, delayMs: 10 }) }),
    ]);
  });

  it('does not retry when a policy matches the error code with retry = false', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw new APIStatusError(429, 'slow down');
      }),
      { initialConfig: { retry: { policies: [{ match: 'provider\\.rate_limit', retry: false }] } } },
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(calls).toBe(1);
    expect(rpcEvents('turn.step.retrying')).toEqual([]);
  });

  it('does not retry when a policy matches the error name with retry = false', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw new APIConnectionError('terminated');
      }),
      { initialConfig: { retry: { policies: [{ match: 'APIConnectionError', retry: false }] } } },
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(calls).toBe(1);
    expect(rpcEvents('turn.step.retrying')).toEqual([]);
  });

  it('keeps the provider retry-after delay ahead of a policy backoff', async () => {
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls === 1) throw new APIProviderRateLimitError('slow down', null, 1);
        return {
          id: 'policy-retry-after-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'recovered' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
      {
        initialConfig: {
          retry: {
            policies: [{ match: 'provider\\.rate_limit', maxAttempts: 2, backoff: 250 }],
          },
        },
      },
    );

    void ctx.dispatcher.dispatch(new TurnStarted({ turnId: 1, origin: { kind: 'user' } }));
    const loop = ctx.get(IAgentLoopService);
    loop.enqueue(new ContinuationStepRequest());
    const result = await loop.run({ turnId: 1 });

    expect(result.type).toBe('completed');
    expect(rpcEvents('turn.step.retrying')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({ maxAttempts: 2, delayMs: 1 }),
      }),
    ]);
  });

  it('skips a policy whose match is not a valid regular expression', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls === 1) throw new APIConnectionError('terminated');
        return {
          id: 'invalid-pattern-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'recovered' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
      {
        initialConfig: {
          retry: {
            policies: [
              { match: '(', retry: false },
              { match: 'APIConnectionError', maxAttempts: 2 },
            ],
          },
        },
      },
    );

    const result = await runTurn(1);

    expect(result).toEqual({ type: 'completed', steps: 2, truncated: false });
    expect(calls).toBe(2);
    expect(rpcEvents('turn.step.retrying')).toEqual([
      expect.objectContaining({ args: expect.objectContaining({ maxAttempts: 2 }) }),
    ]);
  });
});

describe('retryBackoffDelays', () => {
  it('starts at 500 milliseconds and doubles with up to 25 percent jitter', () => {
    const delays = retryBackoffDelays(3);

    expect(delays[0]).toBeGreaterThanOrEqual(500);
    expect(delays[0]).toBeLessThanOrEqual(625);
    expect(delays[1]).toBeGreaterThanOrEqual(1_000);
    expect(delays[1]).toBeLessThanOrEqual(1_250);
  });

  it('caps high-attempt backoff at 32 seconds plus up to 25 percent jitter', () => {
    const delays = retryBackoffDelays(10);

    expect(delays).toHaveLength(9);
    expect(delays[6]).toBeGreaterThanOrEqual(32_000);
    expect(delays[6]).toBeLessThanOrEqual(40_000);
    expect(delays[8]).toBeGreaterThanOrEqual(32_000);
    expect(delays[8]).toBeLessThanOrEqual(40_000);
  });
});

describe('readRetryAfterMs', () => {
  it('passes small provider retry-after values through unchanged', () => {
    expect(readRetryAfterMs({ retryAfterMs: 1_500 })).toBe(1_500);
  });

  it('clamps values beyond the cap and ignores non-positive ones', () => {
    expect(readRetryAfterMs({ retryAfterMs: 120_000 })).toBe(MAX_RETRY_AFTER_MS);
    expect(readRetryAfterMs({ retryAfterMs: 0 })).toBeNull();
    expect(readRetryAfterMs(undefined)).toBeNull();
  });

  it('honors a real 429 retry-after verbatim instead of clamping', () => {
    expect(readRetryAfterMs({ retryAfterMs: 600_000, statusCode: 429 })).toBe(600_000);
    expect(readRetryAfterMs({ retryAfterMs: 120_000, statusCode: 502 })).toBe(MAX_RETRY_AFTER_MS);
    expect(readRetryAfterMs({ retryAfterMs: 120_000, details: { statusCode: 429 } })).toBe(120_000);
  });
});
