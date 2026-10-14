import { describe, expect, it } from 'vitest';
import {
  EMPTY_AGENT_STATE,
  applyOperation,
  transcriptTurnSchema,
  type AgentState,
  type ContentRef,
  type TranscriptFrame,
  type TranscriptOperation,
  type TranscriptTurn,
} from '@kiki/transcript';
import { boundedEntity, readContentSegment } from '../src/transport/klient/boundedContent';

const turnOp: TranscriptOperation = {
  op: 'turn.upsert',
  turn: { kind: 'turn', turnId: 't1', ordinal: 0, state: 'running', origin: { kind: 'user' } },
};
const stepOp: TranscriptOperation = {
  op: 'step.upsert',
  turnId: 't1',
  step: { kind: 'step', stepId: 's1', turnId: 't1', ordinal: 0, state: 'running' },
};
const text = (frameId: string, role: 'user' | 'assistant', body: string): TranscriptOperation => ({
  op: 'frame.upsert', turnId: 't1', stepId: 's1',
  frame: { kind: 'text', frameId, role, text: body },
});
const boundary = (frameId: string, frameIndex: number): TranscriptOperation => ({
  op: 'frame.upsert', turnId: 't1', stepId: 's1', place: 'safety_boundary', frameIndex,
  frame: { kind: 'text', frameId, role: 'user', text: frameId, origin: { kind: 'injection', variant: 'memory' } },
});

function reduce(ops: readonly TranscriptOperation[], state: AgentState = EMPTY_AGENT_STATE): AgentState {
  return ops.reduce((current, op) => applyOperation(current, op).state, state);
}

function turnOf(state: AgentState): TranscriptTurn {
  const turn = state.items.find((item) => item.kind === 'turn');
  if (turn?.kind !== 'turn') throw new Error('missing turn');
  return turn;
}

function idsOf(turn: TranscriptTurn): string[] {
  return turn.steps[0]?.frames.map((frame) => frame.frameId) ?? [];
}

function boundaryOf(frames: readonly { kind: string; role?: string }[]): number {
  const index = frames.findIndex((frame) => frame.kind !== 'text' || frame.role !== 'user');
  return index < 0 ? frames.length : index;
}

function frameRef(turn: TranscriptTurn): ContentRef {
  const ref = turn.contentRefs?.find((candidate) => candidate.direction === 'backward' && candidate.path.length === 3 && candidate.path[2] === 'frames');
  if (ref === undefined) throw new Error('missing backward frame ref');
  return ref;
}

function mintTail(turn: TranscriptTurn): { preview: TranscriptTurn; ref: ContentRef; maxBytes: number } {
  for (let maxBytes = 250; maxBytes <= 12000; maxBytes += 25) {
    const preview = boundedEntity(turn, { kind: 'turn', id: turn.turnId }, maxBytes, 'main', 'tail');
    const ref = preview.contentRefs?.find((candidate) => candidate.direction === 'backward' && candidate.path.length === 3 && candidate.path[2] === 'frames');
    if (ref?.offset === 1 && ref.total === 3) return { preview, ref, maxBytes };
  }
  throw new Error('boundedEntity did not mint a backward frame ref at offset 1 total 3');
}

describe('hidden boundary insert against a real tail ref', () => {
  it('bumps the omitted watermark without minting a new revision, and the next boundary stays aligned with a fresh store', () => {
    const fresh = reduce([
      turnOp, stepOp,
      text('omitted-reply', 'assistant', 'answer '.repeat(40)),
      text('user-b', 'user', 'visible '.repeat(40)),
      text('reply', 'assistant', 'tail '.repeat(40)),
    ]);
    const full = transcriptTurnSchema.parse(turnOf(fresh));
    const { preview, ref } = mintTail(full);
    expect(idsOf(preview)).toEqual(idsOf(full).slice(ref.offset));
    expect(() => readContentSegment(full, ref)).not.toThrow();

    const hiddenAt = boundaryOf(turnOf(fresh).steps[0]?.frames ?? []);
    expect(hiddenAt).toBe(0);
    const hidden = boundary('hidden', hiddenAt);
    const dropped = applyOperation({ ...EMPTY_AGENT_STATE, items: [preview] }, hidden);
    expect(dropped.changed).toBe(true);
    expect(idsOf(turnOf(dropped.state))).toEqual(['user-b', 'reply']);
    expect(frameRef(turnOf(dropped.state))).toMatchObject({
      offset: ref.offset + 1, total: ref.total + 1, revision: ref.revision, direction: 'backward',
    });
    const repeated = applyOperation(dropped.state, hidden);
    expect(repeated.changed).toBe(false);
    expect(frameRef(turnOf(repeated.state)).offset).toBe(ref.offset + 1);

    const withHidden = applyOperation(fresh, hidden);
    const nextAt = boundaryOf(turnOf(withHidden.state).steps[0]?.frames ?? []);
    expect(nextAt).toBe(1);
    const shifted = applyOperation(dropped.state, boundary('next-hidden', nextAt));
    expect(idsOf(turnOf(shifted.state))).toEqual(['user-b', 'reply']);
    expect(frameRef(turnOf(shifted.state))).toMatchObject({ offset: ref.offset + 2, total: ref.total + 2, revision: ref.revision });
    const follow = text('follow-up', 'user', 'later');
    const client = applyOperation(shifted.state, follow);
    const rebuilt = applyOperation(applyOperation(withHidden.state, boundary('next-hidden', nextAt)).state, follow);
    const offset = frameRef(turnOf(client.state)).offset;
    expect(idsOf(turnOf(client.state))).toEqual(idsOf(turnOf(rebuilt.state)).slice(offset));
    expect(idsOf(turnOf(client.state))).toEqual(['user-b', 'reply', 'follow-up']);

    const hiddenFrame: TranscriptFrame = {
      kind: 'text', frameId: 'hidden', role: 'user', text: 'hidden', origin: { kind: 'injection', variant: 'memory' },
    };
    const inserted = {
      ...full,
      steps: full.steps.map((step, index) => index === 0 ? { ...step, frames: [hiddenFrame, ...step.frames] } : step),
    };
    expect(() => readContentSegment(inserted, ref)).toThrow('Content changed');
    expect(frameRef(turnOf(client.state)).revision).toBe(ref.revision);
  });
});
