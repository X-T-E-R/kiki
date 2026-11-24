import { describe, expect, it } from 'vitest';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';

import { ChatProviderError } from '#/kosong/contract/errors';
import {
  ANTHROPIC_MAX_CACHE_BREAKPOINTS,
  assertAnthropicBreakpointsValid,
  countAnthropicBodyBreakpoints,
  digestAnthropicContentBlock,
  planAndApplyAnthropicMessageBreakpoints,
} from '#/kosong/provider/bases/anthropic/anthropic-cache-breakpoints';
import {
  AnthropicThreadTracker,
  hashThreadMessages,
  MESSAGE_THREADS_BETA,
  sanitizeCreateMessagesCacheControl,
} from '#/kosong/provider/bases/anthropic/anthropic-threads';

function makeMessages(texts: readonly string[]): MessageParam[] {
  return texts.map((text, idx) => ({
    role: idx % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: 'text', text }],
  }));
}

describe('Anthropic cache breakpoint accounting and planning', () => {
  it('plans normal 3-point turn and compaction 4-point coexistence while staying <= 4', () => {
    const turnMessages = makeMessages(['u0', 'a0', 'u1']);
    const turnBody: Record<string, unknown> = {
      tools: [{ name: 'Read', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }],
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      messages: turnMessages,
    };
    const turnPlan = planAndApplyAnthropicMessageBreakpoints(turnBody, turnMessages);
    expect(turnPlan.fixedCount).toBe(2);
    expect(turnPlan.applied).toHaveLength(1);
    expect(turnPlan.applied[0]).toMatchObject({ messageIndex: 2, blockIndex: 0, role: 'user' });
    expect(countAnthropicBodyBreakpoints(turnBody).total).toBe(3);

    const compactMessages = makeMessages(['u0', 'a0', 'u1', 'a1', 'compact instruction']);
    const compactBody: Record<string, unknown> = {
      tools: turnBody['tools'],
      system: turnBody['system'],
      messages: compactMessages,
    };
    const compactPlan = planAndApplyAnthropicMessageBreakpoints(compactBody, compactMessages, turnPlan.applied);
    expect(compactPlan.applied).toHaveLength(2);
    expect(compactPlan.applied.map((bp) => bp.messageIndex)).toEqual([2, 4]);
    const summary = countAnthropicBodyBreakpoints(compactBody);
    expect(summary.total).toBe(4);
    expect(summary.ttlOrderValid).toBe(true);
    expect(() => assertAnthropicBreakpointsValid(compactBody)).not.toThrow();
  });

  it('preserves proven warm prefix breakpoint and drops new tail when fixed slots already occupy 3 or 4 slots', () => {
    const messages = makeMessages(['u0', 'a0', 'u1', 'a1', 'compact']);
    const proven = [{
      messageIndex: 2,
      blockIndex: 0,
      role: 'user' as const,
      blockDigest: digestAnthropicContentBlock({ type: 'text', text: 'u1' }),
      ttl: '5m' as const,
    }];

    const threeFixedBody: Record<string, unknown> = {
      tools: [{ name: 'Read', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }],
      system: [
        { type: 'text', text: 's0', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 's1', cache_control: { type: 'ephemeral' } },
      ],
      messages,
    };
    const plan3 = planAndApplyAnthropicMessageBreakpoints(threeFixedBody, messages, proven);
    expect(plan3.applied.map((bp) => bp.messageIndex)).toEqual([2]);
    expect(countAnthropicBodyBreakpoints(threeFixedBody).total).toBe(ANTHROPIC_MAX_CACHE_BREAKPOINTS);

    const fourFixedBody: Record<string, unknown> = {
      tools: [{ name: 'Read', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }],
      system: [
        { type: 'text', text: 's0', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 's1', cache_control: { type: 'ephemeral' } },
      ],
      cache_control: { type: 'ephemeral' },
      messages,
    };
    const plan4 = planAndApplyAnthropicMessageBreakpoints(fourFixedBody, messages, proven);
    expect(plan4.applied).toHaveLength(0);
    expect(countAnthropicBodyBreakpoints(fourFixedBody).total).toBe(ANTHROPIC_MAX_CACHE_BREAKPOINTS);
  });

  it('does not miscount cache_control keys inside tool.input_schema or tool_use.input', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: 'inspect schema' }] },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tc-1',
          name: 'Inspect',
          input: { cache_control: { type: 'ephemeral', ttl: '1h' }, nested: { cache_control: { type: 'ephemeral' } } },
        }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tc-1', content: 'ok' }],
      },
    ];
    const body: Record<string, unknown> = {
      tools: [{
        name: 'Inspect',
        input_schema: {
          type: 'object',
          properties: {
            cache_control: { type: 'object', properties: { type: { type: 'string' } } },
          },
        },
        cache_control: { type: 'ephemeral' },
      }],
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      messages,
    };
    const plan = planAndApplyAnthropicMessageBreakpoints(body, messages);
    expect(plan.fixedCount).toBe(2);
    expect(countAnthropicBodyBreakpoints(body).total).toBe(3);
  });

  it('rejects fixed breakpoints exceeding 4 and rejects 5m before 1h TTL inversion pre-flight', () => {
    const messages = makeMessages(['hello']);
    const overLimit: Record<string, unknown> = {
      tools: [
        { name: 'A', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } },
        { name: 'B', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } },
      ],
      system: [
        { type: 'text', text: 's0', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 's1', cache_control: { type: 'ephemeral' } },
      ],
      cache_control: { type: 'ephemeral' },
      messages,
    };
    expect(() => planAndApplyAnthropicMessageBreakpoints(overLimit, messages)).toThrow(ChatProviderError);

    const ttlInverted: Record<string, unknown> = {
      tools: [{ name: 'A', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral', ttl: '5m' } }],
      system: [{ type: 'text', text: 's0', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages,
    };
    expect(() => planAndApplyAnthropicMessageBreakpoints(ttlInverted, messages)).toThrow(ChatProviderError);
  });

  it('enforces 1h before 5m when top-level cache_control is 1h and downgrades later blocks safely', () => {
    const messages = makeMessages(['u0', 'a0', 'u1']);
    const body: Record<string, unknown> = {
      tools: [{ name: 'Read', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      cache_control: { type: 'ephemeral', ttl: '1h' },
      messages,
    };
    const plan = planAndApplyAnthropicMessageBreakpoints(body, messages);
    expect(plan.applied).toHaveLength(1);
    expect(plan.applied[0]?.ttl).toBe('1h');
    expect(countAnthropicBodyBreakpoints(body)).toMatchObject({ total: 4, ttlOrderValid: true });
  });

  it('whitelists proven breakpoints in sanitizeCreateMessagesCacheControl', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: 'm0', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'm1', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: [{ type: 'text', text: 'm2', cache_control: { type: 'ephemeral' } }] },
    ];
    const sanitized = sanitizeCreateMessagesCacheControl(messages, new Set(['0:0', '2:0']));
    const b0 = (sanitized[0]!.content as { cache_control?: unknown }[])[0]!;
    const b1 = (sanitized[1]!.content as { cache_control?: unknown }[])[0]!;
    const b2 = (sanitized[2]!.content as { cache_control?: unknown }[])[0]!;
    expect(b0.cache_control).toEqual({ type: 'ephemeral' });
    expect(b1.cache_control).toBeUndefined();
    expect(b2.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('isolates parent Anthropic thread tracker across auxiliary_readonly, auxiliary_exclusive, and auxiliary_force_create', () => {
    const tracker = new AnthropicThreadTracker();
    const baseMessages = makeMessages(['u0', 'a0']);
    const fixedHash = 'fixed-hash-1';
    const baseBody: Record<string, unknown> = {
      model: 'claude-sonnet-4-6',
      system: [{ type: 'text', text: 'sys' }],
      tools: [],
      messages: baseMessages,
    };
    const createAttempt = tracker.prepare({
      scopeKey: 'session-1',
      baseBody,
      messages: baseMessages,
      baseBetas: [],
      fixedHash,
      threadDisposition: 'turn',
    });
    expect(createAttempt.kind).toBe('create');
    tracker.commit('session-1', {
      responseId: 'msg_parent_1',
      prefixCount: baseMessages.length,
      prefixHash: hashThreadMessages(baseMessages),
      fixedHash,
      createBetas: [MESSAGE_THREADS_BETA],
      replacesLostThread: false,
      unfinishedTurn: false,
    });

    const nextMessages: MessageParam[] = [
      ...baseMessages,
      { role: 'user', content: [{ type: 'text', text: 'summary prompt', cache_control: { type: 'ephemeral' } }] },
    ];

    const readonlyAttempt = tracker.prepare({
      scopeKey: 'session-1',
      baseBody: { ...baseBody, messages: nextMessages },
      messages: nextMessages,
      baseBetas: [],
      fixedHash,
      threadDisposition: 'auxiliary_readonly',
    });
    expect(readonlyAttempt.kind).toBe('create');
    expect(tracker.get('session-1')?.responseId).toBe('msg_parent_1');

    const forceCreateAttempt = tracker.prepare({
      scopeKey: 'session-1',
      baseBody: { ...baseBody, messages: nextMessages },
      messages: nextMessages,
      baseBetas: [],
      fixedHash,
      threadDisposition: 'auxiliary_force_create',
    });
    expect(forceCreateAttempt.kind).toBe('create');
    expect(tracker.get('session-1')?.responseId).toBe('msg_parent_1');

    const exclusiveAttempt = tracker.prepare({
      scopeKey: 'session-1',
      baseBody: { ...baseBody, messages: nextMessages },
      messages: nextMessages,
      baseBetas: [],
      fixedHash,
      threadDisposition: 'auxiliary_exclusive',
      fixedBreakpointCount: 4,
    });
    expect(exclusiveAttempt.kind).toBe('continue');
    expect(tracker.get('session-1')).toBeUndefined();
    expect(exclusiveAttempt.body['thread']).toEqual({ type: 'continue', previous_message_id: 'msg_parent_1' });
    const deltaMessages = exclusiveAttempt.body['messages'] as MessageParam[];
    expect(deltaMessages).toHaveLength(1);
    const deltaBlock = (deltaMessages[0]!.content as { cache_control?: unknown }[])[0]!;
    expect(deltaBlock.cache_control).toBeUndefined();
  });
});
