import { describe, expect, it } from 'vitest';

import {
  assistantDeltaEventSchema,
  thinkingDeltaEventSchema,
} from '../src/protocol/events-zod';

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
