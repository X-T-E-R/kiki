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
  skillActivationOriginSchema,
  assistantDeltaEventSchema,
  kimiErrorPayloadSchema,
  thinkingDeltaEventSchema,
  taskStartedEventSchema,
  taskTerminatedEventSchema,
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

describe('events-zod skill author input', () => {
  it('preserves userInput on the existing activation origin', () => {
    const origin = { kind: 'skill_activation', activationId: 'example-skill', skillName: 'review', trigger: 'user-slash', userInput: '/review --fix\nKeep the second line.' };
    expect(skillActivationOriginSchema.parse(origin)).toEqual(origin);
  });
});

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

describe('events-zod task receipt projection', () => {
  it('preserves verified receipt metadata in task lifecycle frames', () => {
    const receipt = {
      schemaVersion: 1 as const,
      path: 'tasks/agent-12345678/output.log',
      mediaType: 'text/plain; charset=utf-8' as const,
      bytes: 14,
      sha256: 'a'.repeat(64),
      contentState: 'final' as const,
      committedAt: '2026-01-01T00:00:00.000Z',
      sourceTurnId: 4,
    };
    const info = {
      taskId: 'agent-12345678', description: 'child', kind: 'agent' as const,
      status: 'completed' as const, startedAt: 1, endedAt: 2,
      receipt, receiptVerification: 'verified' as const,
    };
    for (const type of ['task.started', 'task.terminated'] as const) {
      const frame = { type, info };
      expect((type === 'task.started' ? taskStartedEventSchema : taskTerminatedEventSchema).parse(frame)).toEqual(frame);
    }
  });

  it('keeps unverified and invalid legacy frames without manufacturing a receipt', () => {
    const info = { taskId: 'agent-12345678', description: 'old child', kind: 'agent',
      status: 'failed', startedAt: 1, endedAt: 2 };
    for (const receiptVerification of ['legacy_unverified', 'invalid'] as const) {
      expect(taskTerminatedEventSchema.parse({ type: 'task.terminated',
        info: { ...info, receiptVerification } }).info).toMatchObject({ receiptVerification });
    }
    expect(taskStartedEventSchema.parse({ type: 'task.started', info: { ...info, status: 'running', endedAt: null } }).info)
      .not.toHaveProperty('receipt');
  });
});
