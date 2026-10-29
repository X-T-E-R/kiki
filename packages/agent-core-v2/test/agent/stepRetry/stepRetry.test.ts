import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { attachErrorDetails, unwrapErrorCause } from '#/errors';
import {
  APIConnectionError,
  APIProviderOverloadedError,
  APIProviderRateLimitError,
  APIStatusError,
  requestDeliveryProvenance,
} from '#/kosong/contract/errors';
import { guardRequestDelivery } from '#/kosong/provider/bases/request-delivery';
import { OpenAIResponsesStreamedMessage } from '#/kosong/provider/bases/openai/openai-responses';
import type { StreamedMessage } from '#/kosong/contract/provider';
import { emptyUsage } from '#/kosong/contract/usage';
import { IEventBus } from '#/app/event/eventBus';
import { MAX_RETRY_AFTER_MS, readRetryAfterMs, retryBackoffDelays } from '#/_base/utils/retry';
import { IAgentLoopService } from '#/agent/loop/loop';
import { ContinuationStepRequest } from '#/agent/loop/stepRequest';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { AgentStepRetryService, TurnStepRetrying } from '#/agent/stepRetry/stepRetryService';
import { IAgentStepRetryService } from '#/agent/stepRetry/stepRetry';
import { RETRY_SECTION, type RetryConfig } from '#/agent/stepRetry/configSection';
import { resolveRetryPolicy } from '#/agent/stepRetry/retryPolicy';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import { ILogService } from '#/_base/log/log';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { IConfigService } from '#/app/config/config';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentTaskService } from '#/agent/task/task';
import { SubagentTask } from '#/agent/tools/agent/subagent-task';
import type { LoopErrorContext, LoopErrorHandler } from '#/agent/loop/loop';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { registerLogServices } from '../../_base/log/stubs';
import { registerStateServices } from '../../state/stubs';
import { StubConfigService } from '../../kosong/stubs';
import { stubLoopWithHooks } from '../loop/stubs';

import {
  createTestAgent,
  llmGenerateServices,
  permissionModeServices,
  type TestAgentContext,
  type TestAgentOptions,
  type TestAgentServiceOverride,
} from '../../harness';

const PARALLEL_WORKER_CONTENTION_TIMEOUT_MS = 30_000;

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
    const maxTimerRounds = 100;
    for (let i = 0; i < maxTimerRounds; i += 1) {
      if (settled) break;
      await vi.runOnlyPendingTimersAsync();
      if (!settled) {
        await new Promise((resolve) => realSetTimeout(resolve, 1));
      }
    }
    if (!settled) {
      throw new Error(
        `stepRetry turn ${turnId} did not settle after ${maxTimerRounds} fake-timer rounds (pending timers: ${vi.getTimerCount()})`,
      );
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
        if (calls === 1) throw new APIStatusError(503, 'temporary');
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
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('cancels the turn when aborted during an infinite retry backoff', async () => {
    vi.useFakeTimers();
    vi.stubEnv('KIKI_INFINITE_RETRY', '1');
    const controller = new AbortController();
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        setTimeout(() => {
          controller.abort(new Error('stop'));
        }, 100);
        throw new APIStatusError(400, 'endpoint broken');
      }),
    );

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

    expect(result).toEqual({ type: 'completed', steps: 1, truncated: false });
    expect(calls).toBe(2);
    expect(wireLoopEvents('step.begin')).toHaveLength(1);
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

  it('applies a policy only when both model and provider selectors match the bound request', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw new APIProviderRateLimitError('slow down');
      }),
      {
        initialConfig: {
          retry: {
            policies: [{
              match: '^provider\\.rate_limit$',
              models: ['mock-model'],
              providers: ['test-provider'],
              maxAttempts: 2,
              backoff: 0,
            }],
          },
        },
      },
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(calls).toBe(2);
    expect(rpcEvents('turn.step.retrying')).toEqual([
      expect.objectContaining({ args: expect.objectContaining({ maxAttempts: 2, delayMs: 0 }) }),
    ]);
  });

  it('skips selector-mismatched policies without changing the default retry budget', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw new APIProviderRateLimitError('slow down');
      }),
      {
        initialConfig: {
          retry: {
            policies: [{
              match: '^provider\\.rate_limit$',
              models: ['other-model'],
              providers: ['other-provider'],
              maxAttempts: 1,
              backoff: 0,
            }],
          },
        },
      },
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(calls).toBe(5);
    expect(rpcEvents('turn.step.retrying')).toHaveLength(4);
    expect(rpcEvents('turn.step.retrying')[0]).toEqual(
      expect.objectContaining({ args: expect.objectContaining({ maxAttempts: 5 }) }),
    );
  });

  it('keeps first-match order among policies whose selectors match', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw new APIProviderRateLimitError('slow down');
      }),
      {
        initialConfig: {
          retry: {
            policies: [
              { match: '^provider\\.rate_limit$', models: ['other-model'], maxAttempts: 1 },
              { match: '^provider\\.rate_limit$', providers: ['test-provider'], maxAttempts: 3, backoff: 0 },
              { match: '^provider\\.rate_limit$', maxAttempts: 4 },
            ],
          },
        },
      },
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(calls).toBe(3);
    expect(rpcEvents('turn.step.retrying')).toHaveLength(2);
    expect(rpcEvents('turn.step.retrying')[0]).toEqual(
      expect.objectContaining({ args: expect.objectContaining({ maxAttempts: 3, delayMs: 0 }) }),
    );
  });

  it.each([
    ['HTTP 400', () => new APIStatusError(400, 'invalid request')],
    ['unknown delivery', () => Object.assign(new Error('delivery outcome unknown'), { name: 'UnknownDeliveryError' })],
    ['partial output', () => Object.assign(new Error('partial output retained'), { name: 'PartialOutputError' })],
    ['already executed', () => Object.assign(new Error('request already executed'), { name: 'AlreadyExecutedError' })],
  ])('does not let retry = true force a non-retryable %s failure', async (_case, makeError) => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw makeError();
      }),
      {
        initialConfig: {
          retry: {
            policies: [{
              match: '.*',
              models: ['mock-model'],
              providers: ['test-provider'],
              maxAttempts: 10,
              retry: true,
            }],
          },
        },
      },
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(calls).toBe(1);
    expect(rpcEvents('turn.step.retrying')).toEqual([]);
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
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

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

    expect(result).toEqual({ type: 'completed', steps: 1, truncated: false });
    expect(calls).toBe(2);
    expect(rpcEvents('turn.step.retrying')).toEqual([
      expect.objectContaining({ args: expect.objectContaining({ maxAttempts: 2 }) }),
    ]);
  });

  it('bounds retries for an unknown connection drop with no observed output', async () => {
    vi.useFakeTimers();
    const failure = await caughtDelivery(deliveryStream(new APIConnectionError('terminated')));
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw failure;
      }),
      { initialConfig: { retry: { policies: [{ match: 'APIConnectionError', maxAttempts: 2 }] } } },
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    if (result.type !== 'failed') throw new Error('Expected the turn to fail');
    expect(calls).toBe(2);
    expect(rpcEvents('turn.step.retrying')).toHaveLength(1);
    expect(requestDeliveryProvenance(result.error)).toBe('unknown');
    expect(requestDeliveryProvenance(unwrapErrorCause(result.error))).toBe('unknown');
    expect(unwrapErrorCause(result.error)).toMatchObject({ name: 'APIConnectionError', message: 'terminated' });
  });

  it('recovers an unobserved WebSocket 1012 through the bounded turn policy', async () => {
    vi.useFakeTimers();
    const connection = attachErrorDetails(new APIConnectionError('Responses WebSocket closed before a terminal response event.'), {
      nativeCode: 'responses_websocket_closed_before_terminal', websocketCloseCode: 1012, retry: true,
    });
    const failure = await caughtDelivery(deliveryStream(connection));
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls === 1) throw failure;
        return { id: 'recovered', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], toolCalls: [] }, usage: emptyUsage(), finishReason: 'completed', rawFinishReason: 'stop' };
      }),
      { initialConfig: { retry: { policies: [{ match: 'APIConnectionError', maxAttempts: 2, backoff: 1 }] } } },
    );

    const result = await runTurn(1);
    expect(result).toEqual({ type: 'completed', steps: 1, truncated: false });
    expect(calls).toBe(2);
    expect(rpcEvents('turn.step.retrying')).toEqual([
      expect.objectContaining({ args: expect.objectContaining({ delayMs: 1, maxAttempts: 2, errorName: 'APIConnectionError' }) }),
    ]);
  });

  it('retracts interrupted text and tool deltas before executing the completed tool exactly once', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const action = vi.fn(async () => ({ output: 'saved once' }));
    ctx = createRetryTestAgent(llmGenerateServices(async (_provider, _system, _tools, _history, callbacks) => {
      calls++;
      if (calls === 1) {
        await callbacks?.onMessagePart?.({ type: 'text', text: 'discarded answer' });
        await callbacks?.onMessagePart?.({ type: 'function', id: 'save-work', name: 'SaveWork', arguments: '{}' });
        throw new APIConnectionError('websocket closed before terminal event (code 1012)');
      }
      if (calls === 2) return { id: 'complete-tool', message: { role: 'assistant', content: [],
        toolCalls: [{ type: 'function', id: 'save-work', name: 'SaveWork', arguments: '{}' }] },
        usage: emptyUsage(), finishReason: 'tool_calls', rawFinishReason: 'tool_calls' };
      return { id: 'complete-text', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], toolCalls: [] },
        usage: emptyUsage(), finishReason: 'completed', rawFinishReason: 'stop' };
    }), { initialConfig: { retry: { policies: [{ match: 'APIConnectionError', backoff: 1 }] } } });
    ctx.get(IAgentPermissionModeService).setMode('yolo', 'ambient');
    ctx.get(IAgentToolRegistryService).register({ name: 'SaveWork', description: 'Save fixture work.', parameters: { type: 'object' },
      resolveExecution: () => ({ approvalRule: 'SaveWork', execute: action }) });
    ctx.get(IAgentProfileService).update({ activeToolNames: ['SaveWork'] });
    expect((await runTurn(1)).type).toBe('completed');
    expect(calls).toBe(3);
    expect(action).toHaveBeenCalledTimes(1);
    expect(rpcEvents('response.attempt.discarded')).toEqual([expect.objectContaining({ args: expect.objectContaining({
      partIds: [expect.any(String)], toolCallIds: ['save-work'],
    }) })]);
    expect(JSON.stringify(ctx.contextData().history)).not.toContain('discarded answer');
    expect(wireLoopEvents('tool.call')).toHaveLength(1);
    expect(wireLoopEvents('tool.call')[0]).toMatchObject({ toolCallId: 'save-work' });
  });

  it('settles exhausted interrupted child work as failed and resumes the same execution', async () => {
    let interrupted = true;
    let calls = 0;
    ctx = createRetryTestAgent(llmGenerateServices(async (_provider, _system, _tools, _history, callbacks) => {
      calls++;
      if (interrupted) {
        await callbacks?.onMessagePart?.({ type: 'text', text: 'uncommitted answer' });
        throw new APIConnectionError('websocket closed before terminal event (code 1012)');
      }
      return { id: 'resumed', message: { role: 'assistant', content: [{ type: 'text', text: 'resumed result' }], toolCalls: [] },
        usage: emptyUsage(), finishReason: 'completed', rawFinishReason: 'stop' };
    }), { initialConfig: { retry: { policies: [{ match: 'APIConnectionError', backoff: 1 }] } } });
    const tasks = ctx.get(IAgentTaskService);
    const executor = ctx.get(IAgentExecutionService);
    const controller = new AbortController();
    const run = await executor.run({ kind: 'prompt', prompt: 'Continue existing work.' }, { signal: controller.signal });
    const taskId = tasks.registerTask(new SubagentTask({ agentId: 'existing-child', profileName: 'example-worker',
      completion: run.completion.then(result => ({ result: result.summary })) }, 'Interrupted work', controller));
    await tasks.suppressTerminalNotification(taskId);
    const outcome = run.completion.catch((error: unknown) => error);
    expect(await outcome).toMatchObject({ code: 'provider.connection_error' });
    expect(await tasks.wait(taskId)).toMatchObject({ status: 'failed', stopReason: expect.stringContaining('1012') });
    expect(calls).toBe(5);
    expect(ctx.get(IAgentLoopService).status()).toMatchObject({ state: 'idle', finalizing: false });
    expect(executor.status().state).toBe('idle');
    expect(rpcEvents('turn.step.retrying')).toHaveLength(4);
    expect(JSON.stringify(ctx.contextData().history)).not.toContain('uncommitted answer');
    interrupted = false;
    const resumed = await executor.run({ kind: 'prompt', prompt: 'Resume and finish.' }, { signal: new AbortController().signal });
    expect(await resumed.completion).toMatchObject({ summary: 'resumed result' });
    expect(calls).toBe(6);
  });

  it.each(['recover', 'exhaust', 'disabled'] as const)('applies the bounded turn policy to a WebSocket connection-limit event: %s', async mode => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls === 1 || mode !== 'recover') {
          const failure = await caughtDelivery(new OpenAIResponsesStreamedMessage((async function* () {
            yield { type: 'response.failed', response: { id: 'resp_limit', status: 'failed', output: [], error: {
              code: 'websocket_connection_limit_reached', message: 'Create a new websocket connection to continue.',
            } } };
          })(), true, undefined, undefined, true));
          throw failure;
        }
        return { id: 'recovered', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], toolCalls: [] }, usage: emptyUsage(), finishReason: 'completed', rawFinishReason: 'stop' };
      }),
      { initialConfig: { retry: { policies: [{ match: 'APIConnectionError', retry: mode !== 'disabled', backoff: 1 }] } } },
    );
    const result = await runTurn(1);
    expect(result.type).toBe(mode === 'recover' ? 'completed' : 'failed');
    expect(calls).toBe(mode === 'recover' ? 2 : mode === 'exhaust' ? 5 : 1);
    expect(rpcEvents('turn.step.retrying')).toHaveLength(calls - 1);
    for (const event of rpcEvents('turn.step.retrying')) {
      expect(event.args).toMatchObject({ delayMs: 1, maxAttempts: 5, errorName: 'APIConnectionError' });
    }
    if (result.type === 'failed') expect(result.error).toMatchObject({ code: 'provider.connection_error' });
  });

  it('retries a parsed temporary provider event with no output using the shared classification', async () => {
    vi.useFakeTimers();
    const parsed = attachErrorDetails(new APIStatusError(429, 'slow down', 'req-temporary'), {
      errorSource: 'provider_event', upstreamErrorCode: 'rate_limit_exceeded',
    });
    const failure = await caughtDelivery(deliveryStream(parsed));
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls === 1) throw failure;
        return { id: 'recovered', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], toolCalls: [] }, usage: emptyUsage(), finishReason: 'completed', rawFinishReason: 'stop' };
      }),
    );
    const result = await runTurn(1);
    expect(result.type).toBe('completed');
    expect(calls).toBe(2);
    expect(rpcEvents('turn.step.retrying')).toHaveLength(1);
  });

  it('does not replay a parsed 429 after output, and keeps the provider status', async () => {
    vi.useFakeTimers();
    const parsed = attachErrorDetails(new APIStatusError(429, 'slow down', 'req-429'), {
      errorSource: 'provider_event',
    });
    const failure = await caughtDelivery(deliveryStream(parsed, { parts: [{ type: 'text', text: 'partial' }] }));
    let calls = 0;
    ctx = createRetryTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw failure;
      }),
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    if (result.type !== 'failed') throw new Error('Expected the turn to fail');
    expect(calls).toBe(1);
    expect(rpcEvents('turn.step.retrying')).toEqual([]);
    expect(result.error).toBe(parsed);
    expect(result.error).toMatchObject({ statusCode: 429, message: 'slow down', requestId: 'req-429' });
    expect(requestDeliveryProvenance(result.error)).toBe('executed');
  });
});

function deliveryStream(
  error: unknown,
  options?: { readonly id?: string | null; readonly parts?: ReadonlyArray<{ readonly type: 'text'; readonly text: string }> },
): StreamedMessage {
  const parts = options?.parts ?? [];
  return {
    id: options?.id ?? null,
    usage: null,
    finishReason: null,
    rawFinishReason: null,
    async *[Symbol.asyncIterator]() {
      for (const part of parts) yield part;
      throw error;
    },
  };
}

async function caughtDelivery(stream: StreamedMessage): Promise<unknown> {
  const guarded = guardRequestDelivery(stream, true);
  try {
    for await (const _part of guarded) {
    }
  } catch (error) {
    return error;
  }
  throw new Error('expected the guarded stream to fail');
}

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

describe('stepRetry binding lookup', () => {
  let disposables: DisposableStore;
  let config: StubConfigService;
  let handler: LoopErrorHandler;
  let context: LoopErrorContext;
  let getModel: ReturnType<typeof vi.fn<IModelCatalog['get']>>;
  let logError: ReturnType<typeof vi.fn<ILogService['error']>>;
  let dispatch: ReturnType<typeof vi.fn<IEventDispatcher['dispatch']>>;
  const lookupFailure = new Error('catalog unavailable');

  beforeEach(() => {
    vi.useFakeTimers();
    disposables = new DisposableStore();
    config = new StubConfigService();
    const loop = stubLoopWithHooks();
    const register = vi.spyOn(loop, 'registerLoopErrorHandler');
    getModel = vi.fn<IModelCatalog['get']>(() => {
      throw lookupFailure;
    });
    logError = vi.fn<ILogService['error']>();
    dispatch = vi.fn(async () => {});
    const ix = createServices(disposables, {
      base: [registerLogServices, registerStateServices],
      additionalServices: (reg) => {
        reg.defineInstance(IConfigService, config);
        reg.defineInstance(IAgentLoopService, loop);
        reg.definePartialInstance(IEventBus, { subscribe: () => toDisposable(() => {}) });
        reg.definePartialInstance(IEventDispatcher, { dispatch });
        reg.definePartialInstance(IAgentProfileService, {
          data: () => ({
            modelAlias: 'model-alias', modelCapabilities: UNKNOWN_CAPABILITY,
            thinkingLevel: 'off', systemPrompt: '',
          }),
          getRecipeModelSettings: () => undefined,
        });
        reg.definePartialInstance(IModelCatalog, { get: getModel });
        reg.define(IAgentStepRetryService, AgentStepRetryService);
      },
    });
    ix.get(ILogService).error = logError;
    ix.get(IAgentStepRetryService);
    const registered = register.mock.calls[0]?.[0];
    if (registered === undefined) throw new Error('Expected the step-retry handler to register');
    handler = registered;
    context = {
      error: new APIProviderRateLimitError('slow down'),
      turnId: 1,
      step: 1,
      signal: new AbortController().signal,
      failedDriver: new ContinuationStepRequest(),
      retry: vi.fn<LoopErrorContext['retry']>(),
    };
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await disposables.dispose();
  });

  async function exhaustAttempts(): Promise<number> {
    let attempts = 1;
    while (handler.match(context)) {
      const recovery = handler.handle(context);
      await vi.runAllTimersAsync();
      if (!(await recovery)) break;
      attempts += 1;
      if (attempts > 10) throw new Error('Retry budget did not stop recovery');
    }
    return attempts;
  }

  it.each<{ label: string; retry?: RetryConfig; attempts: number }>([
    { label: 'no retry section', attempts: 5 },
    { label: 'empty policies', retry: { policies: [] }, attempts: 5 },
    { label: 'section budget only', retry: { maxAttempts: 3 }, attempts: 3 },
    {
      label: 'selector-free policy', attempts: 2,
      retry: { policies: [{ match: 'provider.rate_limit', maxAttempts: 2, backoff: 0, retry: true }] },
    },
    {
      label: 'selector-free off policy', attempts: 1,
      retry: { policies: [{ match: 'provider.rate_limit', retry: false }] },
    },
    {
      label: 'unmatched selector policy', attempts: 5,
      retry: { policies: [{ match: 'SomeOtherError', models: ['model-alias'], retry: false }] },
    },
    {
      label: 'earlier selector-free policy', attempts: 1,
      retry: { policies: [
        { match: 'provider.rate_limit', retry: false },
        { match: 'provider.rate_limit', models: ['model-alias'], retry: true },
      ] },
    },
  ])('avoids retry binding lookup for $label', async ({ retry, attempts }) => {
    config.setSilent(RETRY_SECTION, retry);

    expect(await exhaustAttempts()).toBe(attempts);
    expect(dispatch).toHaveBeenCalledTimes(attempts - 1);
    expect(getModel).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it.each(['model', 'provider', 'both'] as const)(
    'reports retry binding resolution failure for %s selectors without replacing the provider failure',
    async (selector) => {
      const failure = context.error;
      config.setSilent(RETRY_SECTION, { policies: [{
        match: '^provider\\.rate_limit$',
        models: selector === 'provider' ? undefined : ['model-alias'],
        providers: selector === 'model' ? undefined : ['test-provider'],
        retry: false,
      }] });

      expect(await exhaustAttempts()).toBe(5);
      expect(context.error).toBe(failure);
      expect(dispatch).toHaveBeenCalledTimes(4);
      expect(getModel).toHaveBeenCalled();
      expect(logError).toHaveBeenCalledWith(
        'failed to resolve model identity for retry policy selectors; selector policies are skipped',
        { modelAlias: 'model-alias', error: lookupFailure },
      );
    },
  );

  it('keeps selector-free rules and section budget after retry binding resolution fails', async () => {
    config.setSilent(RETRY_SECTION, { maxAttempts: 3, policies: [
      { match: '^provider\\.rate_limit$', models: ['model-alias'], retry: false },
      { match: '^provider\\.rate_limit$', providers: ['test-provider'], retry: false },
      { match: '^provider\\.rate_limit$', backoff: 17, retry: true },
    ] });

    expect(await exhaustAttempts()).toBe(3);
    expect(getModel).toHaveBeenCalledTimes(6);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ maxAttempts: 3, delayMs: 17 }));
  });

  it('resolves the canonical model and provider for a matching 429 policy', async () => {
    const model: Model = {
      id: 'canonical-model', name: 'remote-model', aliases: ['model-alias'],
      protocol: 'openai', headers: {}, capabilities: UNKNOWN_CAPABILITY,
      maxContextSize: 10_000, alwaysThinking: false, providerName: 'test-provider',
      authProvider: { getAuth: async () => undefined },
      imagePolicy: { acceptedTypes: new Set(), convertUnsupported: 'off' },
    };
    getModel.mockReturnValue(model);
    config.setSilent(RETRY_SECTION, { policies: [{
      match: '^provider\\.rate_limit$', models: ['canonical-model'], providers: ['test-provider'],
      maxAttempts: 2, backoff: 23, retry: true,
    }] });

    expect(await exhaustAttempts()).toBe(2);
    expect(getModel).toHaveBeenCalledWith('model-alias', undefined);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ maxAttempts: 2, delayMs: 23 }));
    expect(logError).not.toHaveBeenCalled();
  });

  it('does not resolve selectors or retry after observed partial output', async () => {
    const failure = await caughtDelivery(deliveryStream(new APIConnectionError('terminated'), { parts: [{ type: 'text', text: 'partial' }] }));
    context = { ...context, error: failure };
    config.setSilent(RETRY_SECTION, { policies: [{
      match: 'APIConnectionError', models: ['model-alias'], providers: ['test-provider'], retry: true,
    }] });

    expect(handler.match(context)).toBe(false);
    expect(await handler.handle(context)).toBe(false);
    expect(requestDeliveryProvenance(context.error)).toBe('executed');
    expect(getModel).not.toHaveBeenCalled();
    expect(context.retry).not.toHaveBeenCalled();
  });

  it('keeps an explicit retry false on the wrapper when matching its unwrapped cause', () => {
    const failure = attachErrorDetails(new Error('wrapper', {
      cause: new APIProviderRateLimitError('slow down'),
    }), { retry: false });
    expect(resolveRetryPolicy({ policies: [{ match: 'provider.rate_limit', retry: true }] }, failure))
      .toEqual({ retry: false });
  });

  it('preserves selector-free policy calls without a binding argument', () => {
    expect(resolveRetryPolicy({ policies: [{ match: 'provider.rate_limit', maxAttempts: 7, retry: true }] }, context.error))
      .toEqual({ retry: true, maxAttempts: 7, backoffMs: undefined });
  });
});
