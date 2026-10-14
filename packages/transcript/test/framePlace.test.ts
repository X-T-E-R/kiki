import { describe, expect, it } from 'vitest';

import type { ContentRef } from '#/contract/content';
import { EMPTY_AGENT_STATE, applyOperation, type AgentState } from '#/ops/apply';
import type { TranscriptOperation } from '#/ops/operation';
import { transcriptOperationSchema } from '#/contract/schema';
import { AgentTranscript } from '#/store/agentTranscript';
import { AgentTranscriptDraft } from '#/store/agentTranscriptDraft';
import { TranscriptFactReducer } from '#/facts/reducer';
import { TranscriptWireAdapter, type TranscriptWireRecord } from '#/facts/wireAdapter';

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

function frameRefOf(state: AgentState): ContentRef | undefined {
  const item = state.items.find((entry) => entry.kind === 'turn');
  return item?.kind === 'turn' ? item.contentRefs?.[0] : undefined;
}

function boundaryOf(frames: readonly { kind: string; role?: string }[]): number {
  const index = frames.findIndex((frame) => frame.kind !== 'text' || frame.role !== 'user');
  return index < 0 ? frames.length : index;
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
    expect(dropped.changed).toBe(true);
    expect(idsOf(dropped.state)).toEqual(['user-b', 'reply']);
    expect(frameRefOf(dropped.state)).toMatchObject({ offset: 2, total: 4, revision: 'r', direction: 'backward' });
    const repeated = applyOperation(dropped.state, boundary('hidden', 0));
    expect(repeated.changed).toBe(false);
    expect(frameRefOf(repeated.state)).toMatchObject({ offset: 2, total: 4, revision: 'r' });
    const stillHidden = applyOperation(dropped.state, boundary('next-hidden', 1));
    expect(idsOf(stillHidden.state)).toEqual(['user-b', 'reply']);
    expect(frameRefOf(stillHidden.state)).toMatchObject({ offset: 3, total: 5, revision: 'r' });
    const inserted = applyOperation(windowed, boundary('visible-boundary', 1));
    expect(idsOf(inserted.state)).toEqual(['visible-boundary', 'user-b', 'reply']);
  });

  it('keeps a revised boundary frame at its splice after checkpoint restore', () => {
    const records: TranscriptWireRecord[] = [
      { type: 'context.append_loop_event', time: 1, event: { type: 'step.begin', turnId: 1, step: 1, uuid: 's1' } },
      { type: 'context.append_loop_event', time: 2, event: { type: 'content.part', turnId: 1, stepUuid: 's1', uuid: 'reply', part: { type: 'text', text: 'answer' } } },
      {
        type: 'context.append_message', time: 3,
        message: { id: 'echo', role: 'user', content: [{ type: 'text', text: '[Kiki memory]\nremember this' }], origin: { kind: 'injection', variant: 'memory', ownerPromptId: 'prompt-1' } },
        delivery: { messageId: 'echo', turnId: 1, stepId: 's1', step: 1, origin: 'injection', placement: 'safety_boundary' },
      },
      {
        type: 'context.append_message', time: 4,
        message: { id: 'echo', role: 'user', content: [{ type: 'text', text: '[Kiki memory]\nremember this TAILMARK' }], origin: { kind: 'injection', variant: 'memory', ownerPromptId: 'prompt-1' } },
        delivery: { messageId: 'echo', turnId: 1, stepId: 's1', step: 1, origin: 'injection' },
      },
    ];
    const transcript = new AgentTranscript('main');
    const adapter = new TranscriptWireAdapter('main');
    const reducer = new TranscriptFactReducer(transcript);
    for (const record of records) reducer.apply(adapter.add(record));
    const seeded = transcript.getTurn('t1')?.steps[0]?.frames ?? [];
    expect(seeded.map((frame) => frame.frameId)).toEqual(['echo', 'reply']);
    expect(seeded[0]).toMatchObject({ text: '[Kiki memory]\nremember this TAILMARK', origin: { kind: 'injection', variant: 'memory' } });
    const restored = new TranscriptWireAdapter('main');
    restored.restore(JSON.parse(JSON.stringify(adapter.checkpoint())));
    const next: TranscriptWireRecord = {
      type: 'context.append_message', time: 5,
      message: { id: 'next-boundary', role: 'user', content: [{ type: 'text', text: '[Kiki memory]\nremember this' }], origin: { kind: 'injection', variant: 'memory', ownerPromptId: 'prompt-1' } },
      delivery: { messageId: 'next-boundary', turnId: 1, stepId: 's1', step: 1, origin: 'injection', placement: 'safety_boundary' },
    };
    const liveIndex = adapter.add(next).flatMap((fact) => fact.operations).find((op) => op.op === 'frame.upsert' && op.frame.frameId === 'next-boundary');
    const restoredIndex = restored.add(next).flatMap((fact) => fact.operations).find((op) => op.op === 'frame.upsert' && op.frame.frameId === 'next-boundary');
    expect(liveIndex?.op === 'frame.upsert' && restoredIndex?.op === 'frame.upsert').toBe(true);
    if (liveIndex?.op !== 'frame.upsert' || restoredIndex?.op !== 'frame.upsert') return;
    expect(restoredIndex.frameIndex).toBe(liveIndex.frameIndex);
    expect(restoredIndex.frameIndex).toBe(boundaryOf(seeded));
    expect(restoredIndex.place).toBe('safety_boundary');
  });
});
