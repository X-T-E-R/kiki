import { describe, expect, it } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { acpToolOutput, mergeAcpToolState } from '#/agent/execution/acpToolDisplay';
import { ExternalTurnRecorder } from '#/agent/execution/externalTurnRecorder';
import {
  extractStreamingRateLimitResetAt,
  normalizeExternalExecutorError,
  parseExternalUsageLimit,
} from '#/agent/execution/externalUsageLimitParser';
import { AssistantDelta, ThinkingDelta, TurnStepCompleted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentUsageService } from '#/agent/usage/usage';
import { isQuotaExhaustedTurnError } from '#/app/agentExecutor/executorSchedule';
import type { Event2 } from '#/app/event/event2';
import { Error2, ErrorCodes, toKimiErrorPayload } from '#/errors';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IWireService } from '#/wire/wire';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

const FIXED_NOW_MS = Date.parse('2026-11-12T12:00:00.000Z');

function createTestRecorder(privateSession = false) {
  const dispatched: Event2[] = [];
  const loopEvents: unknown[] = [];
  const dispatcher = {
    dispatch: async (event: Event2) => {
      dispatched.push(event);
    },
    flush: async () => {},
  };
  const wire = {
    flush: async () => {},
  };
  const context = {
    get: () => [],
    appendLoopEvent: (event: unknown) => {
      loopEvents.push(event);
    },
    appendManaged: () => {},
  };
  const usage = {
    record: () => {},
  };
  const services = new Map<unknown, unknown>([
    [IEventDispatcher, dispatcher],
    [IWireService, wire],
    [IAgentContextMemoryService, context],
    [IAgentUsageService, usage],
    [ISessionContext, { isPrivate: () => privateSession }],
  ]);
  const recorder = new ExternalTurnRecorder(
    {
      id: 'sub-1',
      accessor: { get: <T>(id: unknown) => services.get(id as never) as T },
    },
    1,
    'session-ext',
    {
      executorId: 'claude-acp',
      protocol: 'acp-v1',
      model: 'claude-sonnet',
      resumeMode: 'new',
      profileDelivery: 'developer_instructions',
    },
  );
  return { recorder, dispatched, loopEvents };
}

describe('externalUsageLimitParser across harnesses', () => {
  it('classifies Codex usageLimitExceeded, responseTooManyFailedAttempts 429, and subscription sharing limits', () => {
    const codexWindowReset = new Date(1_850_000_000 * 1000).toISOString();
    const codexError = normalizeExternalExecutorError(
      {
        message: 'Too many failed attempts',
        codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      },
      {
        executorId: 'codex',
        observedResetAt: codexWindowReset,
        nowMs: FIXED_NOW_MS,
      },
    );
    expect(codexError).toBeInstanceOf(Error2);
    expect(codexError).toMatchObject({
      code: ErrorCodes.PROVIDER_RATE_LIMIT,
      details: {
        executorId: 'codex',
        statusCode: 429,
        reason_code: 'quota_exceeded',
        resetAt: codexWindowReset,
        resetAtMs: 1_850_000_000 * 1000,
      },
    });
    expect(isQuotaExhaustedTurnError(codexError)).toBe(true);

    const sharing = parseExternalUsageLimit(
      new Error('{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"User has reached their Subscription Sharing usage limit"}}'),
      {
        observedResetAt: codexWindowReset,
        observedWindows: [{ id: 'five_hour', kind: 'session', label: 'Session', windowDurationMins: 300,
          usedPercent: 100, remainingPercent: 0, resetsAt: codexWindowReset }],
        nowMs: FIXED_NOW_MS,
      },
    );
    expect(sharing).toMatchObject({
      statusCode: 429,
      upstreamErrorCode: 'subscription_sharing_usage_limit_exceeded',
      resetAt: undefined,
    });
  });

  it('extracts Claude rate_limit_event epoch seconds and API Error 429 duration resets', () => {
    const epochSec = 1_800_000_900;
    const claudeEvent = parseExternalUsageLimit(
      {
        message: 'Claude rate limit rejected',
        api_error_params: {
          rate_limit_info: {
            status: 'rejected',
            rateLimitType: 'five_hour',
            resetsAt: epochSec,
          },
        },
      },
      { nowMs: FIXED_NOW_MS },
    );
    expect(claudeEvent).toMatchObject({
      statusCode: 429,
      resetAt: new Date(epochSec * 1000).toISOString(),
      resetAtMs: epochSec * 1000,
    });

    const claudeDuration = parseExternalUsageLimit(
      new Error('API Error: 503 [429]: {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your rate limit"}} (reset after 1h 30m 15s)'),
      { nowMs: FIXED_NOW_MS },
    );
    expect(claudeDuration).toMatchObject({
      statusCode: 429,
      upstreamErrorCode: 'rate_limit_error',
      retryAfterMs: (3600 + 1800 + 15) * 1000,
      resetAt: new Date(FIXED_NOW_MS + (3600 + 1800 + 15) * 1000).toISOString(),
    });
  });

  it('retains Claude 5h, 7d, overage and precise spend windows in the serialized error', () => {
    const session = '2026-11-12T13:00:00.000Z';
    const weekly = '2026-11-16T10:30:00.000Z';
    const overage = '2026-11-18T12:00:00.000Z';
    const source = {
      message: 'HTTP 429: Claude quota exceeded',
      data: { rate_limits: {
        five_hour: { utilization: 100, resets_at: session },
        seven_day: { utilization: 42.5, resets_at: weekly },
        spend: { enabled: true,
          used: { amount_minor: 17, currency: 'USD', exponent: 2 },
          limit: { amount_minor: 200, currency: 'USD', exponent: 2 } },
        extra_usage: { is_enabled: true, utilization: 9 },
      } },
      cause: { rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day_overage_included',
        utilization: 0.25, resetsAt: Date.parse(overage) / 1000 } },
    };
    const context = { nowMs: FIXED_NOW_MS, executorId: 'claude-acp' };
    const parsed = parseExternalUsageLimit(source, context);
    expect(parsed?.windows).toHaveLength(4);
    expect(parsed?.windows).toEqual(expect.arrayContaining([
      { id: 'five_hour', kind: 'session', label: 'Session', windowDurationMins: 300,
        usedPercent: 100, remainingPercent: 0, resetsAt: session },
      { id: 'seven_day', kind: 'weekly', label: 'Weekly', windowDurationMins: 10080,
        usedPercent: 42.5, remainingPercent: 57.5, resetsAt: weekly },
      { id: 'monthly_spend', kind: 'monthly', label: 'Monthly spend', usedPercent: 8.5, remainingPercent: 91.5 },
      { id: 'seven_day_overage_included', kind: 'weekly', label: 'Weekly · Overage included',
        windowDurationMins: 10080, usedPercent: 25, remainingPercent: 75, resetsAt: overage },
    ]));
    expect(toKimiErrorPayload(normalizeExternalExecutorError(source, context))).toMatchObject({
      code: ErrorCodes.PROVIDER_RATE_LIMIT, details: { windows: parsed?.windows, resetAt: session, retryAfterMs: 3600_000 },
    });
  });

  it('merges observed Claude windows with error windows, preferring the error for matching ids', () => {
    const observedReset = '2026-11-12T13:00:00.000Z';
    const weeklyReset = '2026-11-16T10:30:00.000Z';
    const directReset = '2026-11-12T12:30:00.000Z';
    const parsed = parseExternalUsageLimit({
      statusCode: 429,
      message: 'HTTP 429: Claude quota exceeded',
      data: { rate_limits: {
        five_hour: { utilization: 40, resets_at: directReset },
      } },
    }, {
      nowMs: FIXED_NOW_MS,
      observedWindows: [
        { id: 'five_hour', kind: 'session', label: 'Session', windowDurationMins: 300,
          usedPercent: 100, remainingPercent: 0, resetsAt: observedReset },
        { id: 'seven_day', kind: 'weekly', label: 'Weekly', windowDurationMins: 10080,
          usedPercent: 100, remainingPercent: 0, resetsAt: weeklyReset },
      ],
    });
    expect(parsed?.windows).toEqual([
      { id: 'five_hour', kind: 'session', label: 'Session', windowDurationMins: 300,
        usedPercent: 40, remainingPercent: 60, resetsAt: directReset },
      { id: 'seven_day', kind: 'weekly', label: 'Weekly', windowDurationMins: 10080,
        usedPercent: 100, remainingPercent: 0, resetsAt: weeklyReset },
    ]);
    expect(parsed?.resetAt).toBe(weeklyReset);
  });

  it('does not classify ordinary errors from un-rejected observed Claude windows', () => {
    expect(parseExternalUsageLimit(new Error('Unexpected transport failure'), {
      observedWindows: [{ id: 'five_hour', kind: 'session', label: 'Session', windowDurationMins: 300,
        usedPercent: 100, remainingPercent: 0, resetsAt: '2026-11-12T13:00:00.000Z' }],
    })).toBeUndefined();
  });

  it('uses Claude extra usage credits when a spend budget has incompatible currency units', () => {
    const parsed = parseExternalUsageLimit({ statusCode: 429, details: { rate_limits: {
      spend: { enabled: true, used: { amount_minor: 100, currency: 'EUR', exponent: 2 },
        limit: { amount_minor: 200, currency: 'USD', exponent: 2 } },
      extra_usage: { is_enabled: true, used_credits: 3, monthly_limit: 8 },
    } } });
    expect(parsed?.windows).toMatchObject([{ id: 'monthly_spend', usedPercent: 37.5, remainingPercent: 62.5 }]);
  });

  it('extracts Grok -32003 RPC rate limits, Cursor ConnectError resource_exhausted, OpenCode 429 headers, and Kiro/Antigravity quota resets', () => {
    const grok = normalizeExternalExecutorError(
      {
        remoteCode: -32003,
        message: 'Rate limit exceeded for xAI account',
        data: { retry_after_seconds: 120 },
      },
      { executorId: 'grok-acp', nowMs: FIXED_NOW_MS },
    );
    expect(grok).toMatchObject({
      code: ErrorCodes.PROVIDER_RATE_LIMIT,
      details: {
        statusCode: 429,
        upstreamErrorCode: 'xai_rate_limited',
        retryAfterMs: 120_000,
        resetAt: new Date(FIXED_NOW_MS + 120_000).toISOString(),
      },
    });
    expect(isQuotaExhaustedTurnError(grok)).toBe(true);

    const cursor = parseExternalUsageLimit(
      new Error('ConnectError: [resource_exhausted] You have hit your fast request limit. Resets at 2026-11-13T00:00:00Z'),
      { nowMs: FIXED_NOW_MS },
    );
    expect(cursor).toMatchObject({
      statusCode: 429,
      upstreamErrorCode: 'resource_exhausted',
      resetAt: '2026-11-13T00:00:00.000Z',
    });

    const opencode = parseExternalUsageLimit(
      {
        name: 'APIError',
        statusCode: 429,
        message: 'Too Many Requests',
        responseHeaders: { 'Retry-After': '45' },
      },
      { nowMs: FIXED_NOW_MS },
    );
    expect(opencode).toMatchObject({
      statusCode: 429,
      retryAfterMs: 45_000,
      resetAt: new Date(FIXED_NOW_MS + 45_000).toISOString(),
    });

    const kiroAgy = parseExternalUsageLimit(
      new Error('Internal error'),
      {
        stderrTail: 'QUOTA_EXHAUSTED: quotaResetTimeStamp:2026-11-12T18:30:00Z token=YOUR_API_KEY',
        nowMs: FIXED_NOW_MS,
      },
    );
    expect(kiroAgy).toMatchObject({
      statusCode: 429,
      upstreamErrorCode: 'QUOTA_EXHAUSTED',
      resetAt: '2026-11-12T18:30:00.000Z',
    });
    expect(kiroAgy?.stderrTail).toMatch(/\[REDACTED(?:_SECRET)?\]/);
    expect(kiroAgy?.stderrTail).not.toContain('YOUR_API_KEY');
  });

  it('preserves PROVIDER_RATE_LIMIT and projects details cleanly when wrapped with plugin_account attribution', () => {
    const normalized = normalizeExternalExecutorError(
      new Error('HTTP 429 Too Many Requests (retry after 10m)'),
      {
        executorId: 'codex-work',
        accountLabel: 'Work Account',
        accountSource: 'magpie',
        nowMs: FIXED_NOW_MS,
      },
    );
    expect(normalized).toMatchObject({
      code: ErrorCodes.PROVIDER_RATE_LIMIT,
      message: expect.stringContaining('Executor instance "Work Account" (magpie):'),
    });
    expect(isQuotaExhaustedTurnError(normalized)).toBe(true);
    const payload = toKimiErrorPayload(normalized);
    expect(payload).toMatchObject({
      code: 'provider.rate_limit',
      retryable: true,
      message: expect.stringContaining('Executor instance "Work Account" (magpie):'),
      details: expect.objectContaining({
        executorId: 'codex-work',
        accountSource: 'magpie',
        statusCode: 429,
        reason_code: 'quota_exceeded',
        resetAt: '2026-11-12T12:10:00.000Z',
        retryAfterMs: 600_000,
      }),
    });
  });

  it('excludes HTTP 402 permanent billing errors and pure socket disconnects from rate-limit classification', () => {
    expect(parseExternalUsageLimit({ status: 402, message: 'Payment required: credit balance is too low' })).toBeUndefined();
    expect(parseExternalUsageLimit(new Error('read tcp 10.0.0.1:4290->10.0.0.2:443: wsarecv: ECONNRESET'))).toBeUndefined();
    expect(parseExternalUsageLimit(new Error('SyntaxError: Unexpected token'))).toBeUndefined();
  });
});

describe('ExternalTurnRecorder streaming coalescing and rate-limit capture', () => {
  it('filters empty text/thought deltas while coalescing same-message chunks and attaching streamed resetAt on fail', async () => {
    const { recorder, dispatched, loopEvents } = createTestRecorder();
    await recorder.begin('hello', { kind: 'user' });

    await recorder.record({
      type: 'message.delta',
      role: 'assistant',
      messageId: 'msg-1',
      content: { type: 'text', text: '' },
    });
    await recorder.record({
      type: 'message.delta',
      role: 'assistant',
      messageId: 'msg-1',
      content: { type: 'text', text: 'First ' },
    });
    await recorder.record({
      type: 'message.delta',
      role: 'assistant',
      messageId: 'msg-1',
      content: { type: 'text', text: '' },
    });
    await recorder.record({
      type: 'message.delta',
      role: 'assistant',
      messageId: 'msg-1',
      content: { type: 'text', text: 'Second' },
    });
    await recorder.record({
      type: 'thought.delta',
      messageId: 'think-1',
      content: { type: 'text', text: '' },
    });

    const assistantDeltas = dispatched.filter((event): event is AssistantDelta => event instanceof AssistantDelta);
    const thinkingDeltas = dispatched.filter((event): event is ThinkingDelta => event instanceof ThinkingDelta);
    expect(assistantDeltas).toHaveLength(2);
    expect(assistantDeltas[0]?.partId).toBe(assistantDeltas[1]?.partId);
    expect(thinkingDeltas).toHaveLength(0);

    const expectedIso = new Date(1_860_000_000 * 1000).toISOString();
    expect(extractStreamingRateLimitResetAt({ rate_limit_info: { resetsAt: 1_860_000_000 } })).toBe(expectedIso);
    await recorder.record({
      type: 'session.info',
      meta: { rate_limit_info: { status: 'rejected', resetsAt: 1_860_000_000 } },
    });
    await recorder.fail(new Error('You have hit your usage limit'));

    const contentParts = loopEvents.filter((item) => (item as { type?: string }).type === 'content.part');
    expect(contentParts).toEqual([
      expect.objectContaining({
        type: 'content.part',
        part: { type: 'text', text: 'First Second' },
      }),
    ]);

    const ended = dispatched.find((event): event is TurnEnded => event instanceof TurnEnded);
    expect(ended?.error).toMatchObject({
      code: ErrorCodes.PROVIDER_RATE_LIMIT,
      details: expect.objectContaining({
        executorId: 'claude-acp',
        statusCode: 429,
        resetAt: expectedIso,
      }),
    });
  });

  it('suppresses private usage from the durable step record while retaining live completion usage', async () => {
    const { recorder, dispatched, loopEvents } = createTestRecorder(true);
    const usage = { inputOther: 10, output: 20, inputCacheRead: 30, inputCacheCreation: 40 };
    await recorder.begin('hello', { kind: 'user' });
    await recorder.complete('end_turn', usage);

    const stepEnd = loopEvents.find((item) => (item as { type?: string }).type === 'step.end') as Record<string, unknown>;
    expect(stepEnd).toMatchObject({ finishReason: 'end_turn', rawFinishReason: 'end_turn' });
    expect(stepEnd).not.toHaveProperty('usage');
    expect(dispatched.find((event) => event instanceof TurnStepCompleted)).toMatchObject({ usage, finishReason: 'end_turn' });
  });

  it('persists accumulated Claude session.info windows and reset timing on an ordinary 429', async () => {
    const { recorder, dispatched } = createTestRecorder();
    await recorder.begin('hello', { kind: 'user' });
    const sessionReset = '2026-11-12T13:00:00.000Z';
    const weeklyReset = '2026-11-16T10:30:00.000Z';

    await recorder.record({
      type: 'session.info',
      meta: { rate_limits: { five_hour: { utilization: 100, resets_at: sessionReset } }, api_key: 'not-for-error-details' },
    });
    await recorder.record({
      type: 'session.info',
      meta: { rate_limits: { seven_day: { utilization: 100, resets_at: weeklyReset } } },
    });
    await recorder.fail({ statusCode: 429, message: 'Too many requests' });

    const ended = dispatched.find((event): event is TurnEnded => event instanceof TurnEnded);
    expect(ended?.error).toMatchObject({
      code: ErrorCodes.PROVIDER_RATE_LIMIT,
      details: {
        statusCode: 429,
        resetAt: weeklyReset,
        windows: expect.arrayContaining([
          { id: 'five_hour', kind: 'session', label: 'Session', windowDurationMins: 300,
            usedPercent: 100, remainingPercent: 0, resetsAt: sessionReset },
          { id: 'seven_day', kind: 'weekly', label: 'Weekly', windowDurationMins: 10080,
            usedPercent: 100, remainingPercent: 0, resetsAt: weeklyReset },
        ]),
      },
    });
    expect(JSON.stringify(ended?.error)).not.toContain('not-for-error-details');
  });

  it('extracts Grok byte-array tool output text and OpenCode data-URL image attachments in acpToolOutput', () => {
    const grokBytes = Array.from(Buffer.from('grok stdout ok', 'utf8'));
    const grokState = mergeAcpToolState(undefined, {
      type: 'tool.update',
      toolCallId: 'grok-1',
      title: 'bash',
      status: 'completed',
      rawOutput: { Result: { output: grokBytes } },
    });
    expect(grokState.text).toBe('grok stdout ok');

    const opencodeState = mergeAcpToolState(undefined, {
      type: 'tool.update',
      toolCallId: 'oc-1',
      title: 'read',
      status: 'completed',
      rawOutput: {
        output: 'Read image',
        files: [{ url: 'data:image/png;base64,iVBORw0KGgo=' }],
      },
    });
    const out = acpToolOutput(opencodeState, 'sess-1', 'oc-1');
    expect(out.text).toBe('Read image');
    expect(out.media).toEqual([
      {
        type: 'image',
        source: { kind: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
      },
    ]);
  });
});
