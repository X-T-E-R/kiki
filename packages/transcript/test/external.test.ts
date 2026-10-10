import { describe, expect, it } from 'vitest';

import { TranscriptFactReducer } from '#/facts/reducer';
import { transcriptFactsFromWire, transcriptWireFactId, TranscriptWireAdapter, type TranscriptWireRecord } from '#/facts/wireAdapter';
import { NavigationWireAdapter } from '#/facts/navigationWireAdapter';
import { AgentTranscript } from '#/store/agentTranscript';

const source = {
  connectionId: 'conn-1',
  clientName: 'Example Client',
  sessionRef: 'session-1',
  driver: 'external' as const,
};

const records: readonly TranscriptWireRecord[] = [
  {
    type: 'external.activity',
    activityId: 'op-1',
    phase: 'started',
    operationId: 'op-1',
    toolCallId: 'call-1',
    toolName: 'Read',
    turnId: 0,
    source,
    time: 1,
  },
  {
    type: 'context.append_loop_event',
    time: 2,
    event: { type: 'step.begin', uuid: 'external-step-0-op-1', turnId: '0', step: 1 },
  },
  {
    type: 'context.append_loop_event',
    time: 3,
    event: {
      type: 'tool.call',
      uuid: 'external-step-0-op-1:tool:call-1',
      stepUuid: 'external-step-0-op-1',
      turnId: '0',
      step: 1,
      toolCallId: 'call-1',
      name: 'Read',
      args: { path: 'example.txt' },
    },
  },
  {
    type: 'external.text',
    recordId: 'text-1',
    turnId: 0,
    text: 'A conclusion saved by the external client.',
    kind: 'assistant_excerpt',
    title: 'Conclusion',
    relatedOperationIds: ['op-1'],
    source,
    time: 4,
  },
  {
    type: 'context.append_loop_event',
    time: 5,
    event: {
      type: 'tool.result',
      parentUuid: 'external-step-0-op-1:tool:call-1',
      toolCallId: 'call-1',
      result: { output: 'file contents', isError: false },
    },
  },
  {
    type: 'external.activity',
    activityId: 'op-1',
    phase: 'completed',
    operationId: 'op-1',
    toolCallId: 'call-1',
    toolName: 'Read',
    turnId: 0,
    source,
    time: 6,
  },
  { type: 'turn.ended', turnId: 0, reason: 'completed', time: 7 },
];

function project(recordsToProject: readonly TranscriptWireRecord[]): AgentTranscript {
  const transcript = new AgentTranscript('main');
  const reducer = new TranscriptFactReducer(transcript);
  reducer.apply(transcriptFactsFromWire('main', recordsToProject));
  return transcript;
}

describe('external client transcript facts', () => {
  it('projects external activity and saved text through hot and cold paths without prompt bubbles', () => {
    const cold = project(records);
    const hot = new AgentTranscript('main');
    const reducer = new TranscriptFactReducer(hot);
    const adapter = new TranscriptWireAdapter('main');
    for (const record of records) reducer.apply(adapter.add(record));

    expect(hot.snapshot()).toEqual(cold.snapshot());
    const turn = hot.getTurn('t0');
    expect(turn).toMatchObject({
      origin: { kind: 'external' },
      state: 'completed',
      prompt: undefined,
      message: undefined,
      steps: [{ frames: [{ kind: 'tool', toolCallId: 'call-1', state: 'done', output: 'file contents' }] }],
    });
    expect(turn?.steps.some((step) => step.frames.some((frame) => frame.kind === 'text' && (frame.role === 'user' || frame.role === 'assistant')))).toBe(false);
    const saved = hot.getItems().find((item) => item.kind === 'marker' && item.marker === 'external.text');
    expect(saved).toMatchObject({
      kind: 'marker',
      payload: {
        recordId: 'text-1',
        kind: 'assistant_excerpt',
        title: 'Conclusion',
        relatedOperationIds: ['op-1'],
        source,
      },
    });
  });

  it('keeps public fact identity stable for external records and preserves optional ordinal semantics', () => {
    expect(transcriptWireFactId(records[0]!)).toBe('external.activity:op-1:started');
    expect(transcriptWireFactId(records[3]!)).toBe('external.text:text-1');
    expect(transcriptWireFactId({ type: 'legacy.record' })).toBeUndefined();
    expect(transcriptWireFactId({ type: 'legacy.record' }, 4)).toBe('wire:v2:r4:legacy.record');
  });

  it('does not deduplicate activity phases or text records with different durable identities', () => {
    const adapter = new TranscriptWireAdapter('main');
    const facts = records.flatMap((record) => adapter.add(record));
    expect(facts.filter((fact) => fact.factId.startsWith('external.activity:op-1:'))).toHaveLength(2);
    expect(facts.filter((fact) => fact.factId === 'external.text:text-1')).toHaveLength(1);
  });

  it('projects external activity and text into source-backed navigation effects without a prompt or role', () => {
    const adapter = new NavigationWireAdapter('main');
    const effects = records.flatMap((record) => adapter.add(record));
    expect(effects).toContainEqual(expect.objectContaining({
      op: 'turn.upsert',
      turn: { turnId: 't0', ordinal: 0, state: 'running', startedAt: expect.any(String) },
    }));
    expect(effects).toContainEqual(expect.objectContaining({
      op: 'frame.upsert',
      turnId: 't0',
      frame: expect.objectContaining({
        kind: 'record',
        recordId: 'text-1',
        recordKind: 'assistant_excerpt',
        text: 'A conclusion saved by the external client.',
        selector: 'external.text',
      }),
    }));
    const recordFrame = effects.find((effect) => effect.op === 'frame.upsert' && effect.frame.kind === 'record');
    expect(recordFrame?.op === 'frame.upsert' && recordFrame.frame.role).toBeUndefined();
  });
});
