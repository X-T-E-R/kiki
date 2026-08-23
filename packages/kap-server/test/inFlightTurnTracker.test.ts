import type { Event } from '../src/transport/ws/v1/events';
import { describe, expect, it } from 'vitest';

import { InFlightTurnTracker } from '../src/transport/ws/v1/inFlightTurnTracker';

const SID = 'sess_1';

function ev(partial: Record<string, unknown>): Event {
  return { agentId: 'main', sessionId: SID, ...partial } as unknown as Event;
}

describe('InFlightTurnTracker', () => {
  it('accumulates assistant text and reports pre-append offsets', () => {
    const t = new InFlightTurnTracker();
    t.apply(SID, ev({ type: 'turn.started', turnId: 1 }));

    expect(t.apply(SID, ev({ type: 'assistant.delta', turnId: 1, delta: 'Hello' }))).toEqual({
      disposition: 'accepted',
      offset: 0,
    });
    expect(t.apply(SID, ev({ type: 'assistant.delta', turnId: 1, delta: ' world' }))).toEqual({
      disposition: 'accepted',
      offset: 5,
    });

    expect(t.get(SID)).toMatchObject({ turn_id: 1, assistant_text: 'Hello world' });
  });

  it('tracks thinking offsets independently', () => {
    const t = new InFlightTurnTracker();
    t.apply(SID, ev({ type: 'turn.started', turnId: 1 }));
    expect(t.apply(SID, ev({ type: 'thinking.delta', turnId: 1, delta: 'abc' }))).toEqual({
      disposition: 'accepted',
      offset: 0,
    });
    expect(t.apply(SID, ev({ type: 'thinking.delta', turnId: 1, delta: 'de' }))).toEqual({
      disposition: 'accepted',
      offset: 3,
    });
    expect(t.get(SID)).toMatchObject({ assistant_text: '', thinking_text: 'abcde' });
  });

  it('clears on turn.ended', () => {
    const t = new InFlightTurnTracker();
    t.apply(SID, ev({ type: 'turn.started', turnId: 1 }));
    t.apply(SID, ev({ type: 'assistant.delta', turnId: 1, delta: 'x' }));
    t.apply(SID, ev({ type: 'turn.ended', turnId: 1 }));
    expect(t.get(SID)).toBeNull();
  });

  it('ignores non-main agents', () => {
    const t = new InFlightTurnTracker();
    t.apply(SID, ev({ type: 'turn.started', turnId: 1 }));
    const sub = { agentId: 'agent-sub', sessionId: SID, type: 'assistant.delta', turnId: 1, delta: 'nope' } as unknown as Event;
    expect(t.apply(SID, sub)).toEqual({});
    expect(t.get(SID)?.assistant_text).toBe('');
  });

  it('ignores deltas for a mismatched turn', () => {
    const t = new InFlightTurnTracker();
    t.apply(SID, ev({ type: 'turn.started', turnId: 1 }));
    expect(t.apply(SID, ev({ type: 'assistant.delta', turnId: 99, delta: 'stale' }))).toEqual({
      disposition: 'rejected',
    });
    expect(t.get(SID)?.assistant_text).toBe('');
  });

  it('tracks running tools and their last progress', () => {
    const t = new InFlightTurnTracker();
    t.apply(SID, ev({ type: 'turn.started', turnId: 1 }));
    t.apply(SID, ev({ type: 'tool.call.started', turnId: 1, toolCallId: 'tc1', name: 'bash' }));
    t.apply(
      SID,
      ev({ type: 'tool.progress', turnId: 1, toolCallId: 'tc1', update: { kind: 'stdout', text: 'hi' } }),
    );
    expect(t.get(SID)?.running_tools).toEqual([
      { tool_call_id: 'tc1', name: 'bash', last_progress: { kind: 'stdout', text: 'hi' } },
    ]);
    t.apply(SID, ev({ type: 'tool.result', turnId: 1, toolCallId: 'tc1' }));
    expect(t.get(SID)?.running_tools).toEqual([]);
  });

  it('resets text accumulation at step boundaries (step-relative in-flight text)', () => {
    const t = new InFlightTurnTracker();
    t.apply(SID, ev({ type: 'turn.started', turnId: 1 }));
    t.apply(SID, ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    t.apply(SID, ev({ type: 'thinking.delta', turnId: 1, delta: 'think-1' }));
    t.apply(SID, ev({ type: 'assistant.delta', turnId: 1, delta: 'text-1' }));
    t.apply(SID, ev({ type: 'turn.step.completed', turnId: 1, step: 1 }));

    t.apply(SID, ev({ type: 'turn.step.started', turnId: 1, step: 2 }));
    t.apply(SID, ev({ type: 'assistant.delta', turnId: 1, delta: 'text-2' }));

    expect(t.get(SID)).toMatchObject({ assistant_text: 'text-2', thinking_text: '' });
  });

  it('reports step-relative offsets that restart at 0 each step', () => {
    const t = new InFlightTurnTracker();
    t.apply(SID, ev({ type: 'turn.started', turnId: 1 }));
    t.apply(SID, ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    expect(t.apply(SID, ev({ type: 'assistant.delta', turnId: 1, delta: 'ab' }))).toEqual({
      disposition: 'accepted',
      offset: 0,
    });
    expect(t.apply(SID, ev({ type: 'assistant.delta', turnId: 1, delta: 'cd' }))).toEqual({
      disposition: 'accepted',
      offset: 2,
    });

    t.apply(SID, ev({ type: 'turn.step.started', turnId: 1, step: 2 }));
    expect(t.apply(SID, ev({ type: 'assistant.delta', turnId: 1, delta: 'x' }))).toEqual({
      disposition: 'accepted',
      offset: 0,
    });
  });

  it('keeps running tools across step boundaries while resetting text', () => {
    const t = new InFlightTurnTracker();
    t.apply(SID, ev({ type: 'turn.started', turnId: 1 }));
    t.apply(SID, ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    t.apply(SID, ev({ type: 'tool.call.started', turnId: 1, toolCallId: 'tc1', name: 'bash' }));
    t.apply(SID, ev({ type: 'assistant.delta', turnId: 1, delta: 'text-1' }));

    t.apply(SID, ev({ type: 'turn.step.started', turnId: 1, step: 2 }));

    expect(t.get(SID)?.assistant_text).toBe('');
    expect(t.get(SID)?.running_tools).toEqual([{ tool_call_id: 'tc1', name: 'bash' }]);
  });

  it('ignores step boundaries for a mismatched turn', () => {
    const t = new InFlightTurnTracker();
    t.apply(SID, ev({ type: 'turn.started', turnId: 1 }));
    t.apply(SID, ev({ type: 'assistant.delta', turnId: 1, delta: 'keep' }));
    t.apply(SID, ev({ type: 'turn.step.started', turnId: 99, step: 2 }));
    expect(t.get(SID)?.assistant_text).toBe('keep');
  });

  it('transfers text and thinking ownership independently by stepUuid', () => {
    const t = new InFlightTurnTracker();
    t.apply(SID, ev({ type: 'turn.started', turnId: 1 }));
    t.apply(SID, ev({ type: 'turn.step.started', turnId: 1, step: 1, stepId: 'step-1' }));
    t.apply(
      SID,
      ev({ type: 'assistant.delta', turnId: 1, step: 1, stepId: 'step-1', delta: 'answer' }),
    );
    t.apply(
      SID,
      ev({ type: 'thinking.delta', turnId: 1, step: 1, stepId: 'step-1', delta: 'thought' }),
    );

    t.apply(
      SID,
      ev({
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          uuid: 'part-text',
          turnId: '1',
          step: 1,
          stepUuid: 'step-1',
          part: { type: 'text', text: 'answer' },
        },
      }),
    );
    expect(t.get(SID)).toMatchObject({
      step: 1,
      step_id: 'step-1',
      assistant_text: '',
      thinking_text: 'thought',
    });

    t.apply(
      SID,
      ev({
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          uuid: 'part-wrong-turn',
          turnId: '99',
          step: 1,
          stepUuid: 'step-1',
          part: { type: 'think', think: 'thought' },
        },
      }),
    );
    expect(t.get(SID)?.thinking_text).toBe('thought');

    t.apply(
      SID,
      ev({
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          uuid: 'part-wrong',
          turnId: '1',
          step: 2,
          stepUuid: 'step-2',
          part: { type: 'think', think: 'thought' },
        },
      }),
    );
    expect(t.get(SID)?.thinking_text).toBe('thought');

    t.apply(
      SID,
      ev({
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          uuid: 'part-think',
          turnId: '1',
          step: 1,
          stepUuid: 'step-1',
          part: { type: 'think', think: 'thought' },
        },
      }),
    );
    expect(t.get(SID)).toMatchObject({ assistant_text: '', thinking_text: '' });
  });

  it('rejects a stale delta with a different step identity', () => {
    const t = new InFlightTurnTracker();
    t.apply(SID, ev({ type: 'turn.started', turnId: 1 }));
    t.apply(SID, ev({ type: 'turn.step.started', turnId: 1, step: 2, stepId: 'step-2' }));
    expect(
      t.apply(
        SID,
        ev({ type: 'assistant.delta', turnId: 1, step: 1, stepId: 'step-1', delta: 'stale' }),
      ),
    ).toEqual({ disposition: 'rejected' });
    expect(t.get(SID)?.assistant_text).toBe('');
  });

  it('reports delta disposition and does not reopen channels after durable handoff', () => {
    const t = new InFlightTurnTracker();
    t.apply(SID, ev({ type: 'turn.started', turnId: 1 }));
    t.apply(SID, ev({ type: 'turn.step.started', turnId: 1, step: 1, stepId: 'step-1' }));

    expect(
      t.apply(
        SID,
        ev({ type: 'assistant.delta', turnId: 1, step: 1, stepId: 'step-1', delta: 'answer' }),
      ),
    ).toEqual({ disposition: 'accepted', offset: 0 });
    expect(
      t.apply(
        SID,
        ev({ type: 'thinking.delta', turnId: 1, step: 1, stepId: 'step-1', delta: 'thought' }),
      ),
    ).toEqual({ disposition: 'accepted', offset: 0 });

    t.apply(
      SID,
      ev({
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          uuid: 'part-text',
          turnId: '1',
          step: 1,
          stepUuid: 'step-1',
          part: { type: 'text', text: 'answer' },
        },
      }),
    );
    expect(t.apply(SID, ev({ type: 'assistant.delta', turnId: 1, delta: 'late' }))).toEqual({
      disposition: 'closed',
    });
    expect(t.get(SID)?.assistant_text).toBe('');
    expect(
      t.apply(
        SID,
        ev({ type: 'thinking.delta', turnId: 1, step: 1, stepId: 'step-1', delta: ' more' }),
      ),
    ).toEqual({ disposition: 'accepted', offset: 7 });

    t.apply(
      SID,
      ev({
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          uuid: 'part-think',
          turnId: '1',
          step: 1,
          stepUuid: 'step-1',
          part: { type: 'think', think: 'thought more' },
        },
      }),
    );
    expect(
      t.apply(
        SID,
        ev({ type: 'thinking.delta', turnId: 1, step: 1, stepId: 'step-1', delta: 'late' }),
      ),
    ).toEqual({ disposition: 'closed' });

    t.apply(SID, ev({ type: 'turn.step.started', turnId: 1, step: 2, stepId: 'step-2' }));
    expect(
      t.apply(
        SID,
        ev({ type: 'assistant.delta', turnId: 1, step: 2, stepId: 'step-2', delta: 'next' }),
      ),
    ).toEqual({ disposition: 'accepted', offset: 0 });
    expect(
      t.apply(
        SID,
        ev({ type: 'assistant.delta', turnId: 1, step: 1, stepId: 'step-1', delta: 'stale' }),
      ),
    ).toEqual({ disposition: 'rejected' });
  });

  it('uses durable tool_call_id facts as an overlay fallback and release', () => {
    const t = new InFlightTurnTracker();
    t.apply(SID, ev({ type: 'turn.started', turnId: 1 }));
    t.apply(SID, ev({ type: 'turn.step.started', turnId: 1, step: 1, stepId: 'step-1' }));
    t.apply(
      SID,
      ev({
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'tool-1',
          turnId: '1',
          step: 1,
          stepUuid: 'step-1',
          toolCallId: 'call-1',
          name: 'Bash',
          args: { command: 'pwd' },
        },
      }),
    );
    expect(t.get(SID)?.running_tools).toEqual([
      expect.objectContaining({ tool_call_id: 'call-1', name: 'Bash', args: { command: 'pwd' } }),
    ]);

    t.apply(
      SID,
      ev({
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          parentUuid: 'tool-1',
          toolCallId: 'call-1',
          result: { output: 'ok' },
        },
      }),
    );
    expect(t.get(SID)?.running_tools).toEqual([]);
  });
});
