import { expect, it } from 'vitest';
import { AgentTranscript, TranscriptFactReducer, TranscriptWireAdapter, type TranscriptWireRecord } from '@kiki/transcript';

import { createViewState, projectAgentTranscriptView } from './transcript';

it('shows the edited user bubble and reply during live updates and after cold replay', () => {
  const message = (text: string) => ({
    id: 'message-1', role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text }],
  });
  const records: TranscriptWireRecord[] = [
    { type: 'turn.prompt', turnId: 0, promptId: 'message-1', origin: { kind: 'user' }, managed: true, time: 1_000 },
    { type: 'context.append_message', message: message('original'), delivery: { messageId: 'message-1', turnId: 0, stepId: 'step-0', step: 1, origin: 'user' }, time: 1_100 },
    { type: 'turn.ended', turnId: 0, reason: 'completed', time: 1_200 },
    { type: 'context.undo', count: 1, time: 2_000 },
    { type: 'context.append_message', message: message('edited'), time: 2_100 },
    { type: 'turn.prompt', turnId: 1, promptId: 'message-1', origin: { kind: 'user' }, managed: true, time: 2_200 },
    { type: 'context.append_loop_event', event: { type: 'step.begin', turnId: 1, step: 1, uuid: 'step-1' }, time: 2_300 },
    { type: 'context.append_loop_event', event: { type: 'content.part', turnId: 1, stepUuid: 'step-1', uuid: 'part-1', part: { type: 'text', text: 'edited reply' } }, time: 2_400 },
    { type: 'turn.ended', turnId: 1, reason: 'completed', time: 2_500 },
  ];
  const transcript = new AgentTranscript('main');
  const adapter = new TranscriptWireAdapter('main', { turn: (id) => transcript.getTurn(id) });
  const reducer = new TranscriptFactReducer(transcript);
  let live = createViewState('session_test');
  for (const record of records) {
    reducer.apply(adapter.add(record));
    live = projectAgentTranscriptView(live, 'main', transcript.snapshot());
    if (record.type === 'turn.prompt' && record['turnId'] === 1) {
      expect(live.blocks.filter((block) => block.kind === 'user')).toMatchObject([
        { text: 'edited', turnId: 't1' },
      ]);
    }
  }
  const coldTranscript = new AgentTranscript('main');
  const coldAdapter = new TranscriptWireAdapter('main', { turn: (id) => coldTranscript.getTurn(id) });
  const coldReducer = new TranscriptFactReducer(coldTranscript);
  for (const record of records) coldReducer.apply(coldAdapter.add(record));
  const cold = projectAgentTranscriptView(createViewState('session_test'), 'main', coldTranscript.snapshot());
  const visible = (blocks: typeof live.blocks) => blocks.filter((block) => block.kind === 'user' || block.kind === 'assistant')
    .map((block) => ({ kind: block.kind, text: block.text, turnId: block.turnId }));
  expect(visible(live.blocks)).toEqual([
    { kind: 'user', text: 'edited', turnId: 't1' },
    { kind: 'assistant', text: 'edited reply', turnId: 't1' },
  ]);
  expect(visible(cold.blocks)).toEqual(visible(live.blocks));
});
