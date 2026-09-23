import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TranscriptProjector,
  filterOpsForGrade,
  gradeFor,
  redactSnapshotForGrade,
  seedMessages,
  seedSnapshotEntities,
} from './fixture-transcript.mjs';

/** Every user-role text frame in the canonical main turn, in step order. */
function userFrames(snapshot) {
  return (snapshot.items.find((item) => item.kind === 'turn')?.steps ?? []).flatMap((step) =>
    step.frames
      .filter((frame) => frame.kind === 'text' && frame.role === 'user')
      .map((frame) => ({
        stepId: step.stepId,
        frameId: frame.frameId,
        text: frame.text,
        deliveredAt: frame.delivery?.deliveredAt,
      })),
  );
}

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

test('full tool result upserts retain the started tool name and display metadata', () => {
  const projector = new TranscriptProjector('session_fixture_tool_name');
  projector.ingestFrame({
    type: 'turn.started',
    payload: { turnId: 1, origin: { kind: 'user' }, prompt: 'Run the tool.' },
  });
  projector.ingestFrame({
    type: 'tool.call.started',
    payload: {
      turnId: 1,
      toolCallId: 'call-edit',
      name: 'Edit',
      args: { file_path: 'C:/fixture/plan.ts' },
      display: { kind: 'file_io', operation: 'edit', path: 'C:/fixture/plan.ts' },
    },
  });
  projector.ingestFrame({
    type: 'tool.result',
    payload: { turnId: 1, toolCallId: 'call-edit', output: 'updated' },
  });
  const frame = projector.snapshot('main').items[0].steps[0].frames[0];
  assert.equal(frame.name, 'Edit');
  assert.deepEqual(frame.input, { file_path: 'C:/fixture/plan.ts' });
  assert.deepEqual(frame.display, { kind: 'file_io', operation: 'edit', path: 'C:/fixture/plan.ts' });
  assert.equal(frame.state, 'done');
  assert.equal(frame.output, 'updated');
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

test('seedMessages keeps metadata.origin instead of forcing kind user', () => {
  const projector = new TranscriptProjector('session_fixture_injection_lanes');
  seedMessages(projector, [
    {
      id: 'um-typed',
      role: 'user',
      content: [{ type: 'text', text: 'Keep an eye on the nightly job.' }],
      created_at: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'am-watch',
      role: 'assistant',
      content: [{ type: 'text', text: 'Watching it.' }],
      created_at: '2026-01-01T00:00:01.000Z',
    },
    {
      id: 'um-cron',
      role: 'user',
      content: [{ type: 'text', text: '<cron-fire job="nightly">Run the nightly report.</cron-fire>' }],
      created_at: '2026-01-01T00:00:02.000Z',
      metadata: { origin: { kind: 'cron_job', jobId: 'nightly' } },
    },
    {
      id: 'um-summary',
      role: 'user',
      content: [{ type: 'text', text: 'Earlier context summarized' }],
      created_at: '2026-01-01T00:00:03.000Z',
      metadata: { origin: { kind: 'compaction_summary' } },
    },
    {
      id: 'um-skill',
      role: 'user',
      content: [{ type: 'text', text: 'SKILL.md body' }],
      created_at: '2026-01-01T00:00:04.000Z',
      metadata: { origin: { kind: 'skill_activation', skillName: 'review', trigger: 'auto' } },
    },
    {
      id: 'um-goal',
      role: 'user',
      content: [{ type: 'text', text: 'Continue toward the goal' }],
      created_at: '2026-01-01T00:00:05.000Z',
      metadata: { origin: { kind: 'system_trigger', name: 'goal_continuation' } },
    },
  ]);
  const origins = projector.snapshot('main').items.map((item) => item.origin);
  assert.equal(origins[0].kind, 'user');
  assert.equal(origins[0].payload.userMessageId, 'um-typed');
  assert.equal(origins[1].kind, 'cron');
  assert.equal(origins[1].payload.kind, 'cron_job');
  assert.equal(origins[2].kind, 'compaction');
  assert.equal(origins[2].payload.kind, 'compaction_summary');
  assert.equal(origins[3].kind, 'other');
  assert.equal(origins[3].payload.kind, 'skill_activation');
  assert.equal(origins[4].kind, 'other');
  assert.equal(origins[4].payload.kind, 'system_trigger');
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
  assert.equal(snapshot.items[0].prompt, 'First fixture question — edited resend.');
  projector.ingestFrame({
    type: 'turn.ended',
    payload: { turnId: 1, reason: 'completed', durationMs: 4200 },
  });
  const ended = projector.snapshot('main');
  assert.equal(ended.items[0].prompt, 'First fixture question — edited resend.');
  assert.equal(ended.items[0].origin.payload.userMessageId, 'um-anchor');
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
  const snapshot = projector.snapshot('main');
  const tool = snapshot.items[0].steps[0].frames.find((frame) => frame.kind === 'tool');
  assert.equal(tool.input.subagentType, 'Researcher');
  assert.equal(snapshot.tasks[0].subagentName, 'Researcher');
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

test('a steer receipt stays strip-only until the canonical delivery lands', () => {
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
  // The receipt clears the queue row and settles the parked prompt. It is not a
  // delivery, so no user frame may exist yet — even though the prompt now reads
  // as completed + steered.
  projector.ingestFrame({
    type: 'prompt.steered',
    payload: {
      activePromptId: 'p-a',
      promptIds: ['p-b'],
      content: [{ type: 'text', text: 'B: steer me in.' }],
      steeredAt: '2026-01-01T00:00:03.000Z',
    },
  }, { promptId: 'p-a', userMessageId: 'um-a' });
  assert.deepEqual(userFrames(projector.snapshot('main')), []);

  // The running turn's next step is the delivery point: the step boundary opens
  // first, then the accepted message is appended to that step's context.
  projector.ingestFrame({ type: 'turn.step.completed', payload: { turnId: 1, step: 1 } });
  projector.ingestFrame({ type: 'turn.step.started', payload: { turnId: 1, step: 2 } });
  projector.ingestFrame({
    type: 'context.append_message',
    payload: {
      message: {
        id: 'um-b',
        role: 'user',
        content: [{ type: 'text', text: 'B: steer me in.' }],
        origin: { kind: 'user' },
      },
      delivery: {
        deliveryId: 'dlv-1',
        messageId: 'um-b',
        turnId: 1,
        step: 2,
        deliveredAt: '2026-01-01T00:00:04.000Z',
        origin: 'queue',
      },
    },
  });

  const snapshot = projector.snapshot('main');
  const turn = snapshot.items.find((item) => item.kind === 'turn');
  assert.deepEqual(userFrames(snapshot), [
    { stepId: 't1.2', frameId: 'um-b', text: 'B: steer me in.', deliveredAt: '2026-01-01T00:00:04.000Z' },
  ]);
  // Anchored on the boundary step, not the step the turn was parked in.
  assert.equal(turn.steps.find((step) => step.stepId === 't1.1').frames.length, 0);

  // Replaying the same delivery re-upserts the one frame instead of stacking a
  // duplicate user message.
  projector.ingestFrame({
    type: 'context.append_message',
    payload: {
      message: {
        id: 'um-b',
        role: 'user',
        content: [{ type: 'text', text: 'B: steer me in.' }],
        origin: { kind: 'user' },
      },
      delivery: {
        deliveryId: 'dlv-1',
        messageId: 'um-b',
        turnId: 1,
        step: 2,
        deliveredAt: '2026-01-01T00:00:04.000Z',
        origin: 'queue',
      },
    },
  });
  assert.equal(userFrames(projector.snapshot('main')).length, 1);
});

test('a delivery without a step boundary is dropped, not invented', () => {
  const projector = new TranscriptProjector('session_fixture_queue');
  projector.ingestFrame({
    type: 'turn.started',
    payload: { turnId: 1, origin: { kind: 'user' }, prompt: 'A: hold the floor.' },
  }, { promptId: 'p-a', userMessageId: 'um-a' });
  // Step 2 never opened: the message has nowhere to become durable context.
  projector.ingestFrame({
    type: 'context.append_message',
    payload: {
      message: {
        id: 'um-b',
        role: 'user',
        content: [{ type: 'text', text: 'B: steer me in.' }],
        origin: { kind: 'user' },
      },
      delivery: { deliveryId: 'dlv-1', messageId: 'um-b', turnId: 1, step: 2, origin: 'queue' },
    },
  });
  assert.deepEqual(userFrames(projector.snapshot('main')), []);
});

test('seeds legacy snapshot tasks and approvals into the canonical main transcript', () => {
  const projector = new TranscriptProjector('session_fixture_seed');
  seedSnapshotEntities(projector, {
    tasks: [
      {
        id: 'task-1',
        kind: 'bash',
        status: 'running',
        description: 'fixture build (vite)',
        created_at: '2026-01-01T00:00:00.000Z',
        started_at: '2026-01-01T00:00:01.000Z',
        output_preview: 'building',
      },
    ],
    pending_approvals: [
      {
        approval_id: 'approval-1',
        turn_id: 1,
        tool_call_id: 'call-1',
        tool_name: 'Bash',
        action: 'Run pnpm test',
        tool_input_display: { kind: 'command', command: 'pnpm test' },
        created_at: '2026-01-01T00:00:02.000Z',
        expires_at: '2026-01-01T01:00:02.000Z',
      },
    ],
    pending_questions: [
      {
        question_id: 'question-1',
        turn_id: 1,
        tool_call_id: 'call-2',
        questions: [{ id: 'q-1', question: 'Continue?', options: [] }],
        created_at: '2026-01-01T00:00:03.000Z',
      },
    ],
  });
  const snapshot = projector.snapshot('main');
  assert.deepEqual(snapshot.tasks[0], {
    taskId: 'task-1',
    kind: 'shell',
    state: 'running',
    detached: true,
    description: 'fixture build (vite)',
    agentId: undefined,
    outputTail: 'building',
    startedAt: '2026-01-01T00:00:01.000Z',
    endedAt: undefined,
    stateReason: undefined,
  });
  assert.equal(snapshot.interactions[0].interactionId, 'approval-1');
  assert.equal(snapshot.interactions[0].state, 'pending');
  assert.equal(snapshot.interactions[1].interactionId, 'question-1');
  assert.equal(snapshot.interactions[1].state, 'pending');
});

test('synthesizes hidden child turn structure for isolated tool deltas and closes it at turn end', () => {
  const projector = new TranscriptProjector('session_fixture_burst');
  projector.ingestFrame({
    type: 'tool.call.delta',
    agentId: 'agent-hidden',
    payload: { turnId: 900, toolCallId: 'burst-call', name: 'Write', argumentsPart: 'x' },
  });
  let turn = projector.snapshot('agent-hidden').items[0];
  assert.equal(turn.turnId, 't900');
  assert.equal(turn.steps[0].frames[0].state, 'running');
  projector.ingestFrame({
    type: 'turn.ended',
    agentId: 'agent-hidden',
    payload: { turnId: 900, reason: 'completed' },
  });
  turn = projector.snapshot('agent-hidden').items[0];
  assert.equal(turn.state, 'completed');
  assert.equal(turn.steps[0].state, 'interrupted');
  assert.equal(turn.steps[0].frames[0].state, 'interrupted');
});

test('mirrors child interactions onto the main transcript with the origin agent', () => {
  const projector = new TranscriptProjector('session_fixture_approval');
  projector.ingestFrame({
    type: 'event.approval.requested',
    agentId: 'agent-worker',
    payload: {
      approval_id: 'approval-child',
      turn_id: 2,
      tool_call_id: 'call-child',
      tool_name: 'Bash',
      action: 'Run cleanup',
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-01-01T01:00:00.000Z',
    },
  });
  assert.deepEqual(projector.snapshot('main').interactions[0].origin, {
    agentId: 'agent-worker',
  });
  assert.equal(projector.snapshot('agent-worker').interactions[0].state, 'pending');
  projector.ingestFrame({
    type: 'event.approval.resolved',
    agentId: 'agent-worker',
    payload: {
      approval_id: 'approval-child',
      tool_call_id: 'call-child',
      decision: 'approved',
    },
  });
  assert.equal(projector.snapshot('main').interactions[0].state, 'approved');
  assert.equal(projector.snapshot('agent-worker').interactions[0].state, 'approved');
});

test('projects a terminated foreground task-id subagent as cancelled', () => {
  const projector = new TranscriptProjector('session_fixture_terminated');
  projector.ingestFrame({
    type: 'subagent.spawned',
    agentId: 'main',
    payload: {
      subagentId: 'agent-worker',
      subagentName: 'explore',
      name: 'worker',
      parentToolCallId: 'call-worker',
      description: 'Inspect',
      runInBackground: false,
      taskId: 'task-foreground',
    },
  });
  projector.ingestFrame({
    type: 'subagent.failed',
    agentId: 'main',
    payload: {
      subagentId: 'agent-worker',
      taskId: 'task-foreground',
      error: 'terminated',
    },
  });

  assert.deepEqual(projector.snapshot('main').tasks[0], {
    taskId: 'task-foreground',
    kind: 'subagent',
    state: 'killed',
    detached: false,
    name: 'worker',
    subagentName: 'explore',
    description: 'Inspect',
    agentId: 'agent-worker',
    outputTail: '',
    resultSummary: undefined,
    error: undefined,
    stateReason: 'terminated',
    startedAt: projector.snapshot('main').tasks[0].startedAt,
    endedAt: projector.snapshot('main').tasks[0].endedAt,
    usage: undefined,
  });
  assert.equal(projector.snapshot('agent-worker').meta.agent.phase.reason, 'cancelled');
});
