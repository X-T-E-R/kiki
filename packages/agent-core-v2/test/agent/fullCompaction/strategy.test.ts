import { type Message } from '#/kosong/contract/message';
import { describe, expect, it } from 'vitest';

import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import { estimateTokensForMessages } from '#/kosong/contract/tokens';
import type { ProfileModelContext } from '#/agent/profile/profile';
import {
  DefaultCompactionStrategy,
  RuntimeCompactionStrategy,
} from '#/agent/fullCompaction/strategy';

describe('DefaultCompactionStrategy', () => {
  it('keeps an oversized trailing user message as recent', () => {
    const strategy = testCompactionStrategy();
    const messages = [
      textMessage('user', 'old user'),
      textMessage('assistant', 'old assistant'),
      textMessage('user', `pending user ${'x'.repeat(1_200)}`),
    ];

    expect(strategy.computeCompactCount(messages, 'auto')).toBe(2);
  });

  it('keeps consecutive trailing user messages as recent', () => {
    const strategy = testCompactionStrategy();
    const messages = [
      textMessage('user', 'old user'),
      textMessage('assistant', 'old assistant'),
      textMessage('user', `pending user one ${'x'.repeat(1_200)}`),
      textMessage('user', `pending user two ${'x'.repeat(1_200)}`),
    ];

    expect(strategy.computeCompactCount(messages, 'auto')).toBe(2);
  });

  it('compacts the prefix when the trailing exchange itself is oversized', () => {
    const strategy = testCompactionStrategy();
    const messages = [
      textMessage('user', 'old user'),
      textMessage('assistant', 'old assistant'),
      textMessage('user', 'recent user'),
      textMessage('assistant', `recent assistant ${'x'.repeat(1_200)}`),
    ];

    expect(strategy.computeCompactCount(messages, 'auto')).toBe(2);
  });

  it('returns 0 when there is nothing to compact', () => {
    const strategy = testCompactionStrategy();
    expect(strategy.computeCompactCount([], 'auto')).toBe(0);
    expect(strategy.computeCompactCount([textMessage('user', 'only pending')], 'auto')).toBe(0);
    expect(
      strategy.computeCompactCount(
        [
          textMessage('user', 'a'),
          textMessage('user', 'b'),
          textMessage('user', 'c'),
        ],
        'auto',
      ),
    ).toBe(0);
  });

  it('returns 0 when no intermediate split exists and the last message is also unsplittable', () => {
    const strategy = testCompactionStrategy();
    const messages: Message[] = [
      textMessage('user', 'inspect'),
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'call_a', name: 'Lookup', arguments: '{}' }],
      },
    ];

    expect(strategy.computeCompactCount(messages, 'auto')).toBe(0);
  });

  it('does not split inside a parallel tool exchange', () => {
    const strategy = testCompactionStrategy();
    const messages: Message[] = [
      textMessage('user', 'old user'),
      textMessage('assistant', 'old assistant'),
      textMessage('user', 'run both tools'),
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: 'call_a', name: 'Lookup', arguments: '{}' },
          { type: 'function', id: 'call_b', name: 'Lookup', arguments: '{}' },
        ],
      },
      { role: 'tool', content: [{ type: 'text', text: 'a' }], toolCalls: [], toolCallId: 'call_a' },
      { role: 'tool', content: [{ type: 'text', text: 'b' }], toolCalls: [], toolCallId: 'call_b' },
      textMessage('user', 'next prompt'),
    ];

    expect(strategy.computeCompactCount(messages, 'auto')).toBe(2);
  });

  it('shrinks auto compaction input to fit the model window', () => {
    const maxSize = 1_000;
    const strategy = testCompactionStrategy(maxSize);
    const messages = Array.from({ length: 30 }, (_, i) =>
      textMessage('assistant', `message ${i} ${'x'.repeat(400)}`),
    );

    const count = strategy.computeCompactCount(messages, 'auto');

    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(messages.length);
    expect(estimateTokensForMessages(messages.slice(0, count))).toBeLessThanOrEqual(maxSize);
    expect(estimateTokensForMessages(messages.slice(0, count + 1))).toBeGreaterThan(maxSize);
  });

  it('shrinks manual compaction input to fit the model window', () => {
    const maxSize = 1_000;
    const strategy = testCompactionStrategy(maxSize);
    const messages = Array.from({ length: 30 }, (_, i) =>
      textMessage('assistant', `message ${i} ${'x'.repeat(400)}`),
    );

    const count = strategy.computeCompactCount(messages, 'manual');

    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(messages.length);
    expect(estimateTokensForMessages(messages.slice(0, count))).toBeLessThanOrEqual(maxSize);
    expect(estimateTokensForMessages(messages.slice(0, count + 1))).toBeGreaterThan(maxSize);
  });

  it('rejects manual compaction without a safe split boundary', () => {
    const strategy = testCompactionStrategy();
    const messages: Message[] = [
      textMessage('user', 'run tool'),
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'call_a', name: 'Lookup', arguments: '{}' }],
      },
    ];

    expect(strategy.computeCompactCount(messages, 'manual')).toBe(0);
  });

  it('degrades to count-based recency and skips window fitting under a zero estimator', () => {
    const zeroed = new DefaultCompactionStrategy(
      () => 1_000,
      {
        triggerRatio: 0.85,
        blockRatio: 0.85,
        reservedContextSize: 0,
        maxCompactionPerTurn: 3,
        maxOverflowCompactionAttempts: 3,
        maxRecentMessages: 2,
        maxRecentUserMessages: Infinity,
        maxRecentSizeRatio: 0.2,
        minOverflowReductionRatio: 0.05,
      },
      () => 0,
    );
    const messages = [
      textMessage('user', `old user ${'x'.repeat(1_200)}`),
      textMessage('assistant', `old assistant ${'x'.repeat(1_200)}`),
      textMessage('user', `older user ${'x'.repeat(1_200)}`),
      textMessage('assistant', `older assistant ${'x'.repeat(1_200)}`),
      textMessage('user', 'pending user'),
      textMessage('assistant', 'pending assistant'),
    ];

    expect(zeroed.computeCompactCount(messages, 'auto')).toBe(4);
    expect(testCompactionStrategy(1_000).computeCompactCount(messages, 'auto')).toBe(2);
  });

  it('reserves response context by default before the ratio threshold is reached', () => {
    const strategy = new DefaultCompactionStrategy(() => 256_000);

    expect(strategy.shouldCompact(210_000)).toBe(true);
    expect(strategy.shouldBlock(210_000)).toBe(true);
  });

  it('ignores reserved context when the reserve is not smaller than the model window', () => {
    const strategy = new DefaultCompactionStrategy(() => 32_000, {
      triggerRatio: 0.85,
      blockRatio: 0.85,
      reservedContextSize: 50_000,
      maxCompactionPerTurn: 3,
      maxOverflowCompactionAttempts: 3,
      maxRecentMessages: 3,
      maxRecentUserMessages: Infinity,
      maxRecentSizeRatio: 0.2,
      minOverflowReductionRatio: 0.05,
    });

    expect(strategy.shouldCompact(1)).toBe(false);
    expect(strategy.shouldBlock(1)).toBe(false);
    expect(strategy.shouldCompact(28_000)).toBe(true);
    expect(strategy.shouldBlock(28_000)).toBe(true);
  });
});

describe('RuntimeCompactionStrategy', () => {
  it('uses the default 85% ratio threshold for a 700k window', () => {
    const strategy = runtimeCompactionStrategy({ maxSize: 700_000, reservedContextSize: 0 });

    expect(strategy.shouldCompact(594_999)).toBe(false);
    expect(strategy.shouldBlock(594_999)).toBe(false);
    expect(strategy.shouldCompact(595_000)).toBe(true);
    expect(strategy.shouldBlock(595_000)).toBe(true);
  });

  it('honors an explicit absolute cap', () => {
    const strategy = runtimeCompactionStrategy({
      maxSize: 700_000,
      reservedContextSize: 0,
      compactionSoftContextSize: 256_000,
    });

    expect(strategy.shouldCompact(255_999)).toBe(false);
    expect(strategy.shouldBlock(255_999)).toBe(false);
    expect(strategy.shouldCompact(256_000)).toBe(true);
    expect(strategy.shouldBlock(256_000)).toBe(true);
  });

  it('keeps the reserved-context threshold for a 128k window', () => {
    const strategy = runtimeCompactionStrategy({ maxSize: 128_000 });

    expect(strategy.shouldCompact(77_999)).toBe(false);
    expect(strategy.shouldBlock(77_999)).toBe(false);
    expect(strategy.shouldCompact(78_000)).toBe(true);
    expect(strategy.shouldBlock(78_000)).toBe(true);
  });

  it('honors a larger explicit absolute cap', () => {
    const strategy = runtimeCompactionStrategy({
      maxSize: 700_000,
      reservedContextSize: 0,
      compactionSoftContextSize: 512_000,
    });

    expect(strategy.shouldCompact(500_000)).toBe(false);
    expect(strategy.shouldBlock(500_000)).toBe(false);
    expect(strategy.shouldCompact(512_000)).toBe(true);
    expect(strategy.shouldBlock(512_000)).toBe(true);
  });

  it('uses an explicit auto window for recent-tail selection without limiting manual compaction', () => {
    const messages = [
      ...Array.from({ length: 7 }, (_, i) => textMessage('assistant', `old ${i}`)),
      ...Array.from({ length: 3 }, (_, i) => textMessage('assistant', `recent ${i}`)),
    ];
    const estimate = (message: Message): number =>
      message.content[0]?.type === 'text' && message.content[0].text.startsWith('recent')
        ? 100_000
        : 20_000;
    const capped = runtimeCompactionStrategy(
      { maxSize: 2_000_000, compactionSoftContextSize: 256_000 },
      estimate,
    );
    const disabled = runtimeCompactionStrategy(
      { maxSize: 2_000_000, compactionSoftContextSize: 0 },
      estimate,
    );

    const cappedCount = capped.computeCompactCount(messages, 'auto');
    const disabledCount = disabled.computeCompactCount(messages, 'auto');

    expect(cappedCount).toBe(8);
    expect(messages.slice(cappedCount).reduce((sum, message) => sum + estimate(message), 0)).toBe(
      200_000,
    );
    expect(disabledCount).toBe(6);
    expect(messages.slice(disabledCount).reduce((sum, message) => sum + estimate(message), 0)).toBe(
      320_000,
    );
    expect(capped.computeCompactCount(messages, 'manual')).toBe(10);
  });
});

function runtimeCompactionStrategy(
  options: {
    readonly maxSize: number;
    readonly reservedContextSize?: number;
    readonly compactionTriggerRatio?: number;
    readonly compactionSoftContextSize?: number;
  },
  estimateMessage?: (message: Message) => number,
): RuntimeCompactionStrategy {
  const context: ProfileModelContext = {
    modelAlias: 'test-model',
    modelCapabilities: { ...UNKNOWN_CAPABILITY, max_context_tokens: options.maxSize },
    maxOutputSize: undefined,
    alwaysThinking: undefined,
    thinkingLevel: 'off',
    reservedContextSize: options.reservedContextSize,
    compactionTriggerRatio: options.compactionTriggerRatio,
    compactionSoftContextSize: options.compactionSoftContextSize,
  };
  return new RuntimeCompactionStrategy(() => context, estimateMessage);
}

function testCompactionStrategy(maxSize: number = 1_000): DefaultCompactionStrategy {
  return new DefaultCompactionStrategy(() => maxSize, {
    triggerRatio: 0.85,
    blockRatio: 0.85,
    reservedContextSize: 0,
    maxCompactionPerTurn: 3,
    maxOverflowCompactionAttempts: 3,
    maxRecentMessages: 10,
    maxRecentUserMessages: Infinity,
    maxRecentSizeRatio: 0.2,
    minOverflowReductionRatio: 0.05,
  });
}

function overflowOnlyCompactionStrategy(maxSize: number = 14): DefaultCompactionStrategy {
  return new DefaultCompactionStrategy(() => maxSize, {
    triggerRatio: Infinity,
    blockRatio: Infinity,
    reservedContextSize: 0,
    maxCompactionPerTurn: 3,
    maxOverflowCompactionAttempts: 3,
    maxRecentMessages: 3,
    maxRecentUserMessages: Infinity,
    maxRecentSizeRatio: 0.2,
    minOverflowReductionRatio: 0.05,
  });
}

function textMessage(role: 'user' | 'assistant', text: string): Message {
  return {
    role,
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}
