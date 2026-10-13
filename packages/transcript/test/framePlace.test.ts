import { describe, expect, it } from 'vitest';

import type { ContentRef } from '#/contract/content';
import { EMPTY_AGENT_STATE, applyOperation, type AgentState } from '#/ops/apply';
import type { TranscriptOperation } from '#/ops/operation';
import { transcriptOperationSchema } from '#/contract/schema';
import { AgentTranscript } from '#/store/agentTranscript';
import { AgentTranscriptDraft } from '#/store/agentTranscriptDraft';

const turn: TranscriptOperation = {
  op: 'turn.upsert',
  turn: { kind: 'turn', turnId: 't1', ordinal: 0, state: 'running', origin: { kind: 'user' } },
};
const step: TranscriptOperation = {
  op: 'step.upsert',
  turnId: 't1',
  step: { kind: 'step', stepId: 's1', turnId: 't1', ordinal: 0, state: 'running' },
};
const text = (frameId: string, role: 'user' | 'assistant', body: string): TranscriptOperation => ({
  op: 'frame.upsert', turnId: 't1', stepId: 's1',
  frame: { kind: 'text', frameId, role, text: body },
});
const tool: TranscriptOperation = {
  op: 'frame.upsert', turnId: 't1', stepId: 's1',
  frame: { kind: 'tool', frameId: 'tool', toolCallId: 'tool', name: 'Read', state: 'done' },
};
const boundary = (frameId: string, frameIndex?: number): TranscriptOperation => ({
  op: 'frame.upsert', turnId: 't1', stepId: 's1', place: 'safety_boundary', frameIndex,
  frame: { kind: 'text', frameId, role: 'user', text: frameId, origin: { kind: 'injection', variant: 'memory' } },
});

function idsOf(snapshot: { items: readonly { kind: string; steps?: readonly { frames: readonly { frameId: string }[] }[] }[] }): string[] {
  const item = snapshot.items.find((entry) => entry.kind === 'turn');
  return item?.steps?.[0]?.frames.map((frame) => frame.frameId) ?? [];
}

function reduce(ops: readonly TranscriptOperation[], state: AgentState = EMPTY_AGENT_STATE): AgentState {
  return ops.reduce((current, op) => applyOperation(current, op).state, state);
}

describe('safety-boundary frame placement', () => {
  const prefix = [turn, step, text('user-a', 'user', 'already'), text('reply', 'assistant', 'answer'), tool];

  it('inserts on both transcript stores and keeps an ordinary append at the end', () => {
    const ops = [...prefix, boundary('injection'), text('follow-up', 'user', 'later')];
    const live = new AgentTranscript('main');
    const draft = new AgentTranscriptDraft('main');
    live.apply(ops);
    draft.apply(ops);
    expect(idsOf(live.snapshot())).toEqual(['user-a', 'injection', 'reply', 'tool', 'follow-up']);
    expect(idsOf(draft.snapshot())).toEqual(idsOf(live.snapshot()));
    expect(transcriptOperationSchema.parse(boundary('injection', 1))).toMatchObject({
      place: 'safety_boundary', frameIndex: 1,
    });
  });

  it('recomputes the boundary on a full step even when frameIndex is stale', () => {
    const state = reduce([...prefix, boundary('injection', 0)]);
    expect(idsOf(state)).toEqual(['user-a', 'injection', 'reply', 'tool']);
  });

  it('drops a boundary frame that belongs in an omitted prefix and splices one that is visible', () => {
    const tail = reduce([turn, step, text('user-b', 'user', 'visible'), text('reply', 'assistant', 'answer')]);
    const omitted: ContentRef = {
      source: { kind: 'turn', id: 't1' }, revision: 'r', path: ['steps', 0, 'frames'],
      kind: 'array', offset: 1, total: 3, direction: 'backward',
    };
    const windowed: AgentState = {
      ...tail,
      items: tail.items.map((item) => item.kind === 'turn' ? { ...item, contentRefs: [omitted] } : item),
    };
    const dropped = applyOperation(windowed, boundary('hidden', 0));
    expect(dropped.changed).toBe(false);
    expect(idsOf(dropped.state)).toEqual(['user-b', 'reply']);
    const inserted = applyOperation(windowed, boundary('visible-boundary', 1));
    expect(idsOf(inserted.state)).toEqual(['visible-boundary', 'user-b', 'reply']);
  });
});
