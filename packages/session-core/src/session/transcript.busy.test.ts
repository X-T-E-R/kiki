import { describe, expect, it } from 'vitest';

import { AgentTranscript, type AgentTranscriptSnapshot, type TranscriptOperation, type TurnHeader } from '@kiki/transcript';

import { FIXED_AT, FIXED_AT_1, FIXED_AT_2, emptySnapshot } from './__fixtures__/canonicalTranscript';
import {
  agentBusyFromMeta,
  createViewState,
  projectAgentTranscriptView,
  sessionAgentForestFromAgentSnapshots,
} from './transcript';

const endedTurn: TurnHeader = {
  kind: 'turn',
  turnId: 't313',
  ordinal: 313,
  state: 'completed',
  origin: { kind: 'user' },
  startedAt: FIXED_AT,
  endedAt: FIXED_AT_1,
  durationMs: 253_000,
  usage: { inputTokens: 10, outputTokens: 20 },
};

/** The ops a cold wire replay emits: t313 ends (with a terminal meta phase), t314 opens without meta. */
function staleEndedPhaseOps(nextTurn: Partial<TurnHeader> = {}): TranscriptOperation[] {
  return [
    { op: 'turn.upsert', turn: endedTurn },
    {
      op: 'meta.merge',
      meta: {
        activity: 'idle',
        agent: { phase: { kind: 'ended', turnId: 313, reason: 'completed', durationMs: 253_000, at: 0 } },
      },
    },
    {
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId: 't314',
        ordinal: 314,
        state: 'running',
        origin: { kind: 'other', payload: { kind: 'task_notification' } },
        startedAt: FIXED_AT_2,
        ...nextTurn,
      },
    },
  ];
}

function replay(agentId: string, ops: readonly TranscriptOperation[]): AgentTranscriptSnapshot {
  const store = new AgentTranscript(agentId);
  store.apply([{ op: 'reset', agentId, snapshot: emptySnapshot() }, ...ops]);
  return store.snapshot();
}

describe('one busy signal for a turn opened after a terminal phase', () => {
  it('keeps cold historical running evidence without presenting a live loop and restores busy after live attachment', () => {
    const snapshot = replay('main', staleEndedPhaseOps());
    const cold = projectAgentTranscriptView(createViewState('session_test'), 'main', snapshot, { cold: true });
    expect(cold.busy).toBe(false);
    expect(cold.abortableTurnId).toBeUndefined();
    expect(snapshot.items.at(-1)).toMatchObject({ state: 'running' });
    const snapshots = new Map([['main', snapshot]]);
    const coldForest = sessionAgentForestFromAgentSnapshots(snapshots, undefined, new Set(['main']));
    expect(coldForest.byId['main']).toMatchObject({ busy: false, status: 'unknown' });
    const live = projectAgentTranscriptView(cold, 'main', snapshot);
    expect(live.busy).toBe(true);
    expect(live.abortableTurnId).toBe(314);
    expect(sessionAgentForestFromAgentSnapshots(snapshots).byId['main']).toMatchObject({ busy: true, status: 'running' });
  });
  it.each([
    { name: 'task notification', origin: { kind: 'other' as const, payload: { kind: 'task_notification' } } },
    { name: 'agent message', origin: { kind: 'other' as const, payload: { kind: 'agent_message', senderAgentId: 'ops_m1' } } },
  ])('is busy as soon as a $name turn is running, even while meta still names the ended turn', ({ origin }) => {
    const snapshot = replay('main', staleEndedPhaseOps({ origin }));
    expect(snapshot.meta.agent?.phase).toMatchObject({ kind: 'ended', turnId: 313 });
    expect(agentBusyFromMeta({ agent_id: 'main', ...snapshot })).toBe(true);

    const view = projectAgentTranscriptView(createViewState('session_test'), 'main', snapshot);
    expect(view.busy).toBe(true);
    expect(view.abortableTurnId).toBe(314);
    // The previous turn's end divider must not stand in for the running turn.
    expect(view.turnTail).toBeUndefined();
  });

  it('stays busy midway through a long tool call with no fresh activity event', () => {
    const snapshot = replay('main', [
      ...staleEndedPhaseOps(),
      {
        op: 'step.upsert',
        turnId: 't314',
        step: { kind: 'step', stepId: 't314.1', turnId: 't314', ordinal: 1, state: 'running' },
      },
      {
        op: 'frame.upsert',
        turnId: 't314',
        stepId: 't314.1',
        frame: { kind: 'tool', frameId: 'tool-bash-long', toolCallId: 'bash-long', name: 'Bash', state: 'running', input: { command: 'pnpm test' } },
      },
    ]);
    const view = projectAgentTranscriptView(createViewState('session_test'), 'main', snapshot);
    expect(view.busy).toBe(true);
    expect(view.turnTail).toBeUndefined();
  });

  it('keeps the ended tail and idle state once the new turn itself has ended', () => {
    const view = projectAgentTranscriptView(createViewState('session_test'), 'main', replay('main', [
      { op: 'turn.upsert', turn: endedTurn },
      { op: 'meta.merge', meta: { activity: 'idle', agent: { phase: { kind: 'ended', turnId: 313, reason: 'completed', durationMs: 253_000, at: 0 } } } },
    ]));
    expect(view.busy).toBe(false);
    expect(view.turnTail).toMatchObject({ turnId: 't313', durationMs: 253_000 });
  });

  it('does not revive a turn the terminal phase already ended', () => {
    const snapshot = replay('main', [
      { op: 'turn.upsert', turn: { ...endedTurn, state: 'running', endedAt: undefined } },
      { op: 'meta.merge', meta: { activity: 'idle', agent: { phase: { kind: 'ended', turnId: 313, reason: 'completed', durationMs: 1, at: 0 } } } },
    ]);
    expect(agentBusyFromMeta({ agent_id: 'main', ...snapshot })).toBe(false);
  });

  it('shows a resumed subagent as running before its first message or token arrives', () => {
    const child = replay('child-1', staleEndedPhaseOps({
      origin: { kind: 'other', payload: { kind: 'agent_message', senderAgentId: 'main' } },
    }));
    const forest = sessionAgentForestFromAgentSnapshots(new Map([['main', emptySnapshot()], ['child-1', child]]));
    expect(forest.byId['child-1']).toMatchObject({ status: 'running', busy: true });
  });
});
