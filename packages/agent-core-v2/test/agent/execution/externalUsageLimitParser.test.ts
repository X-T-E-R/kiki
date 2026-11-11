import { describe, expect, it } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { acpToolOutput, mergeAcpToolState } from '#/agent/execution/acpToolDisplay';
import { ExternalTurnRecorder } from '#/agent/execution/externalTurnRecorder';
import {
  extractStreamingRateLimitResetAt,
  normalizeExternalExecutorError,
  parseExternalUsageLimit,
} from '#/agent/execution/externalUsageLimitParser';
import { AssistantDelta, ThinkingDelta } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentUsageService } from '#/agent/usage/usage';
import { isQuotaExhaustedTurnError } from '#/app/agentExecutor/executorSchedule';
import type { Event2 } from '#/app/event/event2';
import { Error2, ErrorCodes, toKimiErrorPayload } from '#/errors';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IWireService } from '#/wire/wire';

const FIXED_NOW_MS = Date.parse('2026-11-12T12:00:00.000Z');

function createTestRecorder() {
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
