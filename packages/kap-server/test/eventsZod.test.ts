import {
  PromptAborted,
  PromptCompleted,
  PromptQueued,
  PromptQueueHoldChanged,
  PromptReplaced,
  PromptStarted,
  PromptSteered,
  PromptSubmitted,
} from '@kiki/agent-core-v2/agent/prompt/promptService';
import { describe, expect, it } from 'vitest';

import {
  agentEventSchema,
  assistantDeltaEventSchema,
  kimiErrorPayloadSchema,
  thinkingDeltaEventSchema,
} from '../src/protocol/events-zod';

const ENGINE_PROMPT_EVENTS = [
  PromptQueued,
  PromptQueueHoldChanged,
  PromptStarted,
  PromptSubmitted,
  PromptReplaced,
  PromptSteered,
  PromptCompleted,
  PromptAborted,
];

describe('events-zod dispatch capacity errors', () => {
  it('preserves the code and structured rejection details', () => {
    const payload = {
      code: 'dispatch.limit_exceeded',
      message: 'capacity exhausted',
      retryable: false,
      details: { layer: 'direct', current: 16, limit: 16, owner: 'main' },
    };
    expect(kimiErrorPayloadSchema.parse(payload)).toEqual(payload);
  });
});

describe('events-zod prompt lifecycle coverage', () => {
  it('declares every prompt event type the engine emits', () => {
    const declared = new Set(
      agentEventSchema.options.map((option) => (option.shape.type as { value: string }).value),
    );

    expect(
      ENGINE_PROMPT_EVENTS.map((event) => event.type).filter((type) => !declared.has(type)),
    ).toEqual([]);
  });

  it('parses prompt queue state frames', () => {
    expect(
      agentEventSchema.parse({ type: 'prompt.started', promptId: 'prompt_1' }),
    ).toEqual({ type: 'prompt.started', promptId: 'prompt_1' });
    expect(
      agentEventSchema.parse({
        type: 'prompt.queue_hold_changed',
        hold: { reason: 'recovery', count: 1 },
      }),
    ).toEqual({
      type: 'prompt.queue_hold_changed',
      hold: { reason: 'recovery', count: 1 },
    });
  });
});

describe('events-zod stream identity', () => {
  it('preserves legacy and step-owned assistant and thinking deltas', () => {
    expect(
      assistantDeltaEventSchema.parse({
        type: 'assistant.delta',
        turnId: 1,
        delta: 'legacy',
      }),
    ).toEqual({ type: 'assistant.delta', turnId: 1, delta: 'legacy' });
    expect(
      assistantDeltaEventSchema.parse({
        type: 'assistant.delta',
        turnId: 1,
        step: 2,
        stepId: 'step-2',
        partId: 'part-2',
        delta: 'owned',
      }),
    ).toEqual({
      type: 'assistant.delta',
      turnId: 1,
      step: 2,
      stepId: 'step-2',
      partId: 'part-2',
      delta: 'owned',
    });
    expect(
      thinkingDeltaEventSchema.parse({
        type: 'thinking.delta',
        turnId: 1,
        delta: 'legacy thought',
      }),
    ).toEqual({ type: 'thinking.delta', turnId: 1, delta: 'legacy thought' });
    expect(
      thinkingDeltaEventSchema.parse({
        type: 'thinking.delta',
        turnId: 1,
        step: 2,
        stepId: 'step-2',
        partId: 'part-2',
        delta: 'owned thought',
      }),
    ).toEqual({
      type: 'thinking.delta',
      turnId: 1,
      step: 2,
      stepId: 'step-2',
      partId: 'part-2',
      delta: 'owned thought',
    });
  });
});
