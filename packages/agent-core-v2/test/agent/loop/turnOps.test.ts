import { produce } from 'immer';
import { describe, expect, it } from 'vitest';

import {
  ContextAppendLoopEvent,
  ContextApplyCompaction,
  ContextClear,
  ContextUndo,
} from '#/agent/contextMemory/contextEvents';
import type { Event2, Event2Class } from '#/app/event/event2';
import type { FoldContext } from '#/state/state';
import {
  TurnCancel,
  TurnEnded,
  turnKey,
  TurnPrompt,
  type TurnModelState,
} from '#/agent/loop/turnOps';

const foldContext: FoldContext = {
  silent: false,
  checkpoint: () => {},
  clearCheckpoints: () => {},
  undoToCheckpoint: () => {},
  emit: () => {},
};

function fold(s: TurnModelState, event: Event2): TurnModelState {
  const entry = turnKey.replayable.folds.get(event.constructor as Event2Class);
  if (entry === undefined) throw new Error(`turn model fold not registered for '${event.type}'`);
  return produce(s, (draft) => entry(draft, event, foldContext) as void);
}

function foldLoopEvent(s: TurnModelState, turnId: string): TurnModelState {
  return fold(s, new ContextAppendLoopEvent({ event: { type: 'step.begin', uuid: 'step-0', turnId } }));
}

describe('turnKey lastEnded', () => {
  it('keeps the stored outcome across prompts and queued cancels', () => {
    let s = turnKey.initial();
    s = fold(s, new TurnPrompt({ input: [], origin: { kind: 'user' } }));
    s = fold(s, new TurnEnded({ turnId: 0, reason: 'failed', durationMs: 10 }));
    expect(s.lastEnded).toMatchObject({ turnId: 0, reason: 'failed' });
    s = fold(s, new TurnPrompt({ input: [], origin: { kind: 'user' } }));
    expect(s.lastEnded?.reason).toBe('failed');
    s = fold(s, new TurnCancel({ turnId: 1, target: 'queued' }));
    expect(s.lastEnded?.reason).toBe('failed');
    s = fold(s, new TurnEnded({ turnId: 1, reason: 'completed' }));
    expect(s.lastEnded).toMatchObject({ turnId: 1, reason: 'completed' });
  });

  it('clears the stored outcome once a newer turn starts producing', () => {
    let s = turnKey.initial();
    s = fold(s, new TurnPrompt({ input: [], origin: { kind: 'user' } }));
    s = fold(s, new TurnEnded({ turnId: 0, reason: 'failed' }));
    s = fold(s, new TurnPrompt({ input: [], origin: { kind: 'user' } }));
    s = foldLoopEvent(s, '1');
    expect(s.lastEnded).toBeUndefined();
  });

  it('keeps the stored outcome on the same turn’s own events', () => {
    let s = turnKey.initial();
    s = fold(s, new TurnPrompt({ input: [], origin: { kind: 'user' } }));
    s = foldLoopEvent(s, '0');
    s = fold(s, new TurnEnded({ turnId: 0, reason: 'completed' }));
    s = foldLoopEvent(s, '0');
    expect(s.lastEnded?.reason).toBe('completed');
  });

  it('clears the stored outcome when an undo rewinds the turn it describes', () => {
    let s = turnKey.initial();
    s = fold(s, new TurnPrompt({ input: [], origin: { kind: 'user' } }));
    s = fold(s, new TurnEnded({ turnId: 0, reason: 'completed', durationMs: 10 }));
    s = fold(s, new TurnPrompt({ input: [], origin: { kind: 'user' } }));
    s = fold(s, new TurnEnded({ turnId: 1, reason: 'cancelled', durationMs: 10 }));
    s = fold(s, new ContextUndo({ count: 1 }));
    expect(s.anchorTurnIds).toEqual([0]);
    expect(s.lastEnded).toBeUndefined();
  });

  it('keeps the stored outcome when an undo rewinds only later turns', () => {
    let s = turnKey.initial();
    s = fold(s, new TurnPrompt({ input: [], origin: { kind: 'user' } }));
    s = fold(s, new TurnEnded({ turnId: 0, reason: 'completed', durationMs: 10 }));
    s = fold(s, new TurnPrompt({ input: [], origin: { kind: 'user' } }));
    s = fold(s, new ContextUndo({ count: 1 }));
    expect(s.lastEnded).toMatchObject({ turnId: 0, reason: 'completed' });
  });

  it('clears the stored outcome when the undo count exceeds the tracked anchors', () => {
    let s = turnKey.initial();
    s = fold(s, new TurnPrompt({ input: [], origin: { kind: 'user' } }));
    s = fold(s, new TurnEnded({ turnId: 0, reason: 'cancelled', durationMs: 10 }));
    s = fold(s, new ContextUndo({ count: 2 }));
    expect(s.anchorTurnIds).toEqual([]);
    expect(s.lastEnded).toBeUndefined();
  });

  it('starts without a stored outcome', () => {
    expect(turnKey.initial().lastEnded).toBeUndefined();
  });
});

describe('turnKey anchorTurnIds', () => {
  const cronOrigin = {
    kind: 'cron_job',
    jobId: 'j1',
    cron: '0 9 * * *',
    recurring: true,
    coalescedCount: 0,
    stale: false,
  } as const;

  it('records target undo-anchor origins and skips non-anchor turns', () => {
    let s = turnKey.initial();
    s = fold(s, new TurnPrompt({ input: [], origin: { kind: 'user' } }));
    s = fold(s, new TurnPrompt({ input: [], origin: cronOrigin }));
    s = fold(
      s,
      new TurnPrompt({
        input: [],
        origin: {
          kind: 'plugin_command',
          activationId: 'a1',
          pluginId: 'p',
          commandName: 'c',
          trigger: 'user-slash',
        },
      }),
    );
    s = fold(
      s,
      new TurnPrompt({
        input: [],
        origin: {
          kind: 'agent_message',
          messageId: 'm1',
          senderAgentId: 'peer',
          senderTaskName: 'task',
        },
      }),
    );
    expect(s.anchorTurnIds).toEqual([0, 2, 3]);
  });

  it('records the explicit consumed turn id and cancelled-queue holes', () => {
    let s = turnKey.initial();
    s = fold(s, new TurnPrompt({ turnId: 4, input: [], origin: { kind: 'user' } }));
    s = fold(s, new TurnCancel({ turnId: 5, target: 'queued' }));
    s = fold(s, new TurnPrompt({ turnId: 6, input: [], origin: { kind: 'user' } }));
    expect(s.anchorTurnIds).toEqual([4, 6]);
  });

  it('drops trailing anchors on undo and resets on compaction and clear', () => {
    let s = turnKey.initial();
    s = fold(s, new TurnPrompt({ input: [], origin: { kind: 'user' } }));
    s = fold(s, new TurnPrompt({ input: [], origin: { kind: 'user' } }));
    s = fold(s, new ContextUndo({ count: 1 }));
    expect(s.anchorTurnIds).toEqual([0]);

    s = fold(s, new ContextApplyCompaction({ summary: 'summary', compactedCount: 2 }));
    expect(s.anchorTurnIds).toEqual([]);

    s = fold(s, new TurnPrompt({ input: [], origin: { kind: 'user' } }));
    s = fold(s, new ContextClear({}));
    expect(s.anchorTurnIds).toEqual([]);
  });
});

describe('TurnEnded serialization', () => {
  it('emits the op record shape without the bus-only interruptReason', () => {
    const event = new TurnEnded(
      { turnId: 3, reason: 'cancelled', durationMs: 12, interruptReason: 'user_cancelled' },
      42,
    );
    expect(event.serialize()).toEqual({
      type: 'turn.ended',
      turnId: 3,
      reason: 'cancelled',
      durationMs: 12,
      time: 42,
    });
  });

  it('omits absent optional fields from the record', () => {
    const event = new TurnEnded({ turnId: 0, reason: 'completed' }, 7);
    expect(event.serialize()).toEqual({
      type: 'turn.ended',
      turnId: 0,
      reason: 'completed',
      time: 7,
    });
  });
});
