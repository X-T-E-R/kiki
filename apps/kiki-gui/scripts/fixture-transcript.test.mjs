import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TranscriptProjector,
  filterOpsForGrade,
  gradeFor,
  redactSnapshotForGrade,
  seedMessages,
} from './fixture-transcript.mjs';

test('projects a basic stream of session_event frames into reset/ops', () => {
  const projector = new TranscriptProjector('session_fixture_basic');
  const started = projector.ingestFrame({
    type: 'turn.started',
    payload: { turnId: 1, origin: { kind: 'user' }, prompt: 'hello' },
  }, { promptId: 'p1', userMessageId: 'um1' });
  assert.equal(started.length, 1);
  assert.equal(started[0].ops.some((op) => op.op === 'turn.upsert'), true);

  const deltas = projector.ingestFrame({
    type: 'assistant.delta',
    offset: 0,
    payload: { turnId: 1, delta: 'Hi' },
  });
  assert.equal(deltas[0].ops.some((op) => op.op === 'append' || op.op === 'frame.upsert'), true);

  const reset = projector.resetEvent('main');
  assert.equal(reset.type, 'transcript.reset');
  assert.equal(reset.agent_id, 'main');
  assert.equal(reset.snapshot.items[0].turnId, 't1');
  assert.equal(reset.cursor.seq, projector.latestSeq('main'));
});

test('filters ops and redacts snapshots by grade', () => {
  const ops = [
    { op: 'turn.upsert', turn: { kind: 'turn', turnId: 't1', ordinal: 1, state: 'running', origin: { kind: 'user' } } },
    { op: 'frame.upsert', turnId: 't1', stepId: 't1.1', frame: { kind: 'text', frameId: 'f1', role: 'assistant', text: 'x' } },
    { op: 'append', target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'f1' }, offset: 1, text: 'y' },
  ];
  assert.deepEqual(filterOpsForGrade('turn', ops).map((op) => op.op), ['turn.upsert']);
  assert.deepEqual(filterOpsForGrade('block', ops).map((op) => op.op), ['turn.upsert', 'frame.upsert']);
  assert.deepEqual(filterOpsForGrade('delta', ops).map((op) => op.op), ['turn.upsert', 'frame.upsert', 'append']);
  assert.equal(gradeFor({ '*': 'turn', main: 'delta' }, 'main'), 'delta');
  const redacted = redactSnapshotForGrade('turn', {
    items: [{ kind: 'turn', turnId: 't1', steps: [{ kind: 'step', stepId: 't1.1', frames: [{ kind: 'text', frameId: 'f1' }] }] }],
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: {},
  });
  assert.deepEqual(redacted.items[0].steps, []);
});

test('seeds journaled messages with stable user identities', () => {
  const projector = new TranscriptProjector('session_fixture_rewrite');
  seedMessages(projector, [
    {
      id: 'um-1',
      role: 'user',
      content: [{ type: 'text', text: 'First fixture question' }],
      created_at: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'am-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'First fixture answer.' }],
      created_at: '2026-01-01T00:00:01.000Z',
    },
  ]);
  const snapshot = projector.snapshot('main');
  assert.equal(snapshot.items[0].origin.payload.userMessageId, 'um-1');
  assert.equal(snapshot.items[0].prompt, 'First fixture question');
  assert.equal(snapshot.items[0].steps[0].frames[0].text, 'First fixture answer.');
  assert.equal(snapshot.items[0].steps[0].frames[0].part.messageId, 'am-1');
});

test('regenerate turn origin keeps the journal userMessageId instead of the new promptId', () => {
  const projector = new TranscriptProjector('session_fixture_rewrite');
  projector.ingestFrame({
    type: 'turn.started',
    payload: { turnId: 1, origin: { kind: 'user' }, prompt: 'First fixture question — edited resend.' },
  }, { promptId: 'p-regen', userMessageId: 'um-anchor', content: [{ type: 'text', text: 'First fixture question — edited resend.' }] });
  const turn = projector.snapshot('main').items[0];
  assert.equal(turn.origin.payload.userMessageId, 'um-anchor');
  assert.equal(turn.origin.payload.promptId, 'p-regen');
});

test('history_rewritten reseeds the journal user and regenerate turn.started keeps that identity without prompt.completed', () => {
  const projector = new TranscriptProjector('session_fixture_rewrite');
  seedMessages(projector, [
    {
      id: 'um-anchor',
      role: 'user',
      content: [{ type: 'text', text: 'First fixture question — edited resend.' }],
      created_at: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'am-edit',
      role: 'assistant',
      content: [{ type: 'text', text: 'EDITED-REPLY landed after the rewrite.' }],
      created_at: '2026-01-01T00:00:01.000Z',
    },
  ]);
  const rewritten = projector.ingestFrame({
    type: 'event.session.history_rewritten',
    payload: { reason: 'regenerate', target_message_id: 'am-edit' },
  }, { promptId: 'p-regen', userMessageId: 'um-anchor' });
  assert.equal(rewritten.length, 0);
  assert.equal(
    projector.catchup('main', 0).batches.some((batch) =>
      batch.ops.some((op) => op.op === 'items.remove'),
    ),
    false,
  );
  seedMessages(projector, [
    {
      id: 'um-anchor',
      role: 'user',
      content: [{ type: 'text', text: 'First fixture question — edited resend.' }],
      created_at: '2026-01-01T00:00:00.000Z',
    },
  ]);
  projector.ingestFrame({
    type: 'turn.started',
    payload: { turnId: 1, origin: { kind: 'user' }, prompt: 'First fixture question — edited resend.' },
  }, { promptId: 'p-regen', userMessageId: 'um-anchor' });
  const snapshot = projector.snapshot('main');
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].origin.payload.userMessageId, 'um-anchor');
  assert.equal(snapshot.items[0].origin.payload.promptId, 'p-regen');
  const running = snapshot.prompts.find((prompt) => prompt.promptId === 'p-regen');
  assert.equal(running?.userMessageId, 'um-anchor');
});

test('appends a later stream segment onto the same live frame instead of overwriting it', () => {
  const projector = new TranscriptProjector('session_fixture_reconnect');
  projector.ingestFrame({
    type: 'turn.started',
    payload: { turnId: 1, origin: { kind: 'user' }, prompt: 'Start the two-segment stream.' },
  }, { promptId: 'p1', userMessageId: 'um1' });
  projector.ingestFrame({
    type: 'assistant.delta',
    offset: 0,
    payload: { turnId: 1, delta: 'Segment A — this part streamed live before the drop.' },
  });
  projector.ingestFrame({
    type: 'assistant.delta',
    offset: 0,
    payload: { turnId: 1, delta: ' Segment B — this part landed while the socket was down.' },
  });
  const frame = projector.snapshot('main').items[0].steps[0].frames[0];
  assert.equal(
    frame.text,
    'Segment A — this part streamed live before the drop. Segment B — this part landed while the socket was down.',
  );
  assert.equal(typeof frame.part.messageId, 'string');
});

test('names spawned subagents from the tool input subagentType', () => {
  const projector = new TranscriptProjector('session_fixture_subagents');
  projector.ingestFrame({
    type: 'turn.started',
    payload: { turnId: 1, origin: { kind: 'user' } },
  }, { promptId: 'p1' });
  projector.ingestFrame({
    type: 'subagent.spawned',
    payload: {
      subagentId: 'agent-research',
      subagentName: 'Researcher',
      parentToolCallId: 'call-agent-research',
      description: 'Map the protocol surface',
    },
  });
  const tool = projector.snapshot('main').items[0].steps[0].frames.find((frame) => frame.kind === 'tool');
  assert.equal(tool.input.subagentType, 'Researcher');
});

test('prompt.steered completes parked promptIds and does not rewrite the running extras.promptId', () => {
  const projector = new TranscriptProjector('session_fixture_queue');
  projector.ingestFrame({
    type: 'turn.started',
    payload: { turnId: 1, origin: { kind: 'user' }, prompt: 'A: hold the floor.' },
  }, { promptId: 'p-a', userMessageId: 'um-a', content: [{ type: 'text', text: 'A: hold the floor.' }] });
  projector.ingestFrame({
    type: 'prompt.queued',
    payload: {
      promptId: 'p-b',
      userMessageId: 'um-b',
      content: [{ type: 'text', text: 'B: steer me in.' }],
      createdAt: '2026-01-01T00:00:02.000Z',
    },
  });
  projector.ingestFrame({
    type: 'prompt.steered',
    payload: {
      activePromptId: 'p-a',
      promptIds: ['p-b'],
      content: [{ type: 'text', text: 'B: steer me in.' }],
      steeredAt: '2026-01-01T00:00:03.000Z',
    },
  }, { promptId: 'p-a', userMessageId: 'um-a', content: [{ type: 'text', text: 'A: hold the floor.' }] });
  const prompts = projector.snapshot('main').prompts;
  const parked = prompts.find((prompt) => prompt.promptId === 'p-b');
  const running = prompts.find((prompt) => prompt.promptId === 'p-a');
  assert.equal(parked?.status, 'completed');
  assert.equal(parked?.steeredAt, '2026-01-01T00:00:03.000Z');
  assert.equal(parked?.userMessageId, 'um-b');
  assert.equal(running?.status, 'running');
  assert.equal(running?.steeredAt, undefined);
});
