import { describe, expect, it } from 'vitest';

import { AgentTranscript, type AgentTranscriptSnapshot, type TranscriptOperation } from '@kiki/transcript';
import type { Message, Session, SessionSnapshotResponse, SnapshotSubagent } from '@kiki/protocol';

import {
  CHILD_AGENT_ID,
  FIXED_AT,
  FIXED_AT_1,
  FIXED_AT_2,
  PROMPT_ID,
  TOOL_CALL_ID,
  USER_MESSAGE_ID,
  capabilityMatrixSnapshot,
  childRetryWireRecords,
  childFailureWireRecords,
  childCancellationWireRecords,
  replayAgentWire,
  emptySnapshot,
  spawnChildOps,
  userTurnSnapshot,
} from './__fixtures__/canonicalTranscript';

import type { AgentTranscriptResponse } from '../transport';

import { buildAgentForest } from './agentTree';
import { groupBlocks } from './grouping';

import {
  agentTranscriptPageFromResponse,
  appendLocalUserMessage,
  agentTranscriptToBlocks,
  applyTranscriptShell,
  assistantMessageIdFromBlock,
  assistantMessageIdFromBlockId,
  buildFloorEntries,
  classifyTranscriptText,
  createViewState,
  EARLIER_PROMPT_OUTCOMES_ID,
  filterBlocksToDirectChildren,
  floorPreview,
  latestFinalAssistantBlockId,
  liveSourcesFromAgentSnapshots,
  overlayLiveSourcesWithSnapshotSubagents,
  overlaySnapshotSubagentFields,
  prependOlderTranscriptSnapshot,
  projectAgentTranscriptView,
  reminderCategory,
  queuedPromptPreviews,
  resolveActiveFloorId,
  rosterFromSnapshotSubagents,
  sessionAgentForestFromAgentSnapshots,
  splitSystemReminders,
  turnExecutionFromItem,
  type AssistantBlock,
  type SubagentBlock,
  type ToolBlock,
  type UserBlock,
} from './transcript';

const session: Session = {
  id: 'session_test',
  workspace_id: 'wd_test_000000000000',
  title: 'Test',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  busy: false,
  metadata: { cwd: 'C:/tmp' },
  agent_config: { model: '' },
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_cost_usd: 0,
    context_tokens: 0,
    context_limit: 0,
    turn_count: 0,
  },
  permission_rules: [],
  message_count: 0,
  last_seq: 0,
};

function compactSnapshotSubagent(
  overrides: Partial<SnapshotSubagent> & Pick<SnapshotSubagent, 'id'>,
): SnapshotSubagent {
  return {
    session_id: 'session_test',
    kind: 'subagent',
    description: 'Inspect the protocol',
    status: 'completed',
    created_at: FIXED_AT,
    ...overrides,
  };
}

function unknownChildBlock(agentId = CHILD_AGENT_ID): SubagentBlock {
  return {
    kind: 'subagent',
    id: `subagent-${agentId}`,
    subagentId: agentId,
    parentAgentId: 'main',
    parentToolCallId: undefined,
    name: agentId,
    description: undefined,
    model: undefined,
    thinkingEffort: undefined,
    status: 'unknown',
    summary: undefined,
    error: undefined,
    endedAt: undefined,
    toolCallCount: 0,
    transcript: [],
  };
}

describe('classifyTranscriptText', () => {
  it('separates image compression captions from user text in occurrence order', () => {
    const caption = 'Image compressed to fit model limits: original 4500x2800 -> sent 2000x1244. Fine detail may be lost.';
    const text = `Look at these.\n<system>${caption}</system>\n<system-reminder>Daemon note.</system-reminder>\n<system>${caption} The original is at "/example/second.png".</system>`;
    expect(classifyTranscriptText({ text, role: 'user', origin: { kind: 'user' } })).toMatchObject({
      lane: 'you', text: 'Look at these.',
      reminders: [caption, 'Daemon note.', `${caption} The original is at "/example/second.png".`],
    });
    expect(splitSystemReminders(`<system>${caption}</system>`)).toEqual({ text: '', reminders: [caption] });
  });

  it('preserves unrelated system envelopes and incomplete compression captions', () => {
    const text = 'Literal <system>user-provided text</system>\n<system>Image compressed to fit model limits: unfinished';
    expect(splitSystemReminders(text)).toEqual({ text, reminders: [] });
  });

  it('splits system reminders and classifies user, skill, and shell lanes', () => {
    const split = splitSystemReminders('Do the thing.\n<system-reminder>\nDaemon note.\n</system-reminder>');
    expect(split.text).toBe('Do the thing.');
    expect(split.reminders).toEqual(['Daemon note.']);
    expect(classifyTranscriptText({ text: 'hello', role: 'user', origin: { kind: 'user' } }).lane).toBe('you');
    expect(
      classifyTranscriptText({
        text: 'full skill body',
        role: 'user',
        origin: { kind: 'skill_activation', skillName: 'review', trigger: 'user-slash' },
      }).lane,
    ).toBe('skill');
    expect(
      classifyTranscriptText({
        text: '<cron-fire job="nightly">Run the nightly report.</cron-fire>',
        role: 'user',
        origin: { kind: 'cron_job' },
      }),
    ).toMatchObject({
      lane: 'system',
      systemVariant: 'cron_job',
      text: 'Run the nightly report.',
    });
    expect(
      classifyTranscriptText({
        text: 'Earlier context summarized',
        role: 'user',
        origin: { kind: 'compaction_summary' },
      }),
    ).toMatchObject({ lane: 'system', systemVariant: 'compaction_summary' });
    expect(
      classifyTranscriptText({
        text: 'SKILL.md body',
        role: 'user',
        origin: { kind: 'skill_activation', skillName: 'review', trigger: 'auto' },
      }).lane,
    ).toBe('skill');
    expect(
      classifyTranscriptText({
        text: 'Continue toward the goal',
        role: 'user',
        origin: { kind: 'system_trigger', name: 'goal_continuation' },
      }),
    ).toMatchObject({ lane: 'system', systemVariant: 'system_trigger' });
    expect(
      classifyTranscriptText({
        text: 'Inspect the renderer',
        role: 'user',
        origin: { kind: 'system_trigger', name: 'subagent' },
        subagentPromptAsUser: true,
      }),
    ).toMatchObject({ lane: 'you', text: 'Inspect the renderer' });
  });

  it('projects agent mailbox messages into attributed user blocks', () => {
    const origin = {
      kind: 'agent_message',
      senderAgentId: 'main',
      senderTaskName: 'root',
    } as const;
    expect(classifyTranscriptText({ text: 'review this', role: 'user', origin })).toMatchObject({
      lane: 'peer',
      origin,
    });

    const blocks = agentTranscriptToBlocks({
      agent_id: 'agent-target',
      items: [
        {
          kind: 'turn',
          turnId: 't0',
          ordinal: 0,
          state: 'running',
          origin: { kind: 'other', payload: origin },
          prompt: 'Message from agent "root" (main):\n\nreview this',
          steps: [],
        },
      ],
    });
    expect(blocks).toEqual([
      expect.objectContaining({
        kind: 'user',
        text: 'Message from agent "root" (main):\n\nreview this',
        agentMessage: { senderAgentId: 'main', senderTaskName: 'root' },
      }),
    ]);
  });

  it('carries peer-thread provenance onto the user block', () => {
    const origin = {
      kind: 'peer_thread',
      source: { hostId: 'local', workspaceId: 'ws-a', sessionId: 'sess-source' },
      messageId: 'thread-message-1',
      acceptedAt: 1_700_000_000_000,
    } as const;
    expect(classifyTranscriptText({ text: 'ping', role: 'user', origin })).toMatchObject({
      lane: 'peer',
      origin,
    });

    const blocks = agentTranscriptToBlocks({
      agent_id: 'main',
      items: [
        {
          kind: 'turn',
          turnId: 't0',
          ordinal: 0,
          state: 'running',
          origin: { kind: 'other', payload: origin },
          prompt: 'Message from thread "Design review" (sess-source):\n\nping',
          steps: [],
        },
      ],
    });
    expect(blocks).toEqual([
      expect.objectContaining({
        kind: 'user',
        text: 'Message from thread "Design review" (sess-source):\n\nping',
        peerThread: { sessionId: 'sess-source', messageId: 'thread-message-1', personaId: undefined, senderName: undefined },
      }),
    ]);
  });

  it('renders unanchored deliveries and uses acceptance times without reordering the timeline', () => {
    const transcript = new AgentTranscript('main');
    const origin = { kind: 'agent_message', senderAgentId: 'worker', senderTaskName: 'review' };
    transcript.apply([
      { op: 'marker.upsert', item: { kind: 'marker', markerId: 'message-delivery:idle', marker: 'message.delivery', at: FIXED_AT, payload: { messageId: 'idle', text: 'idle mailbox', origin } } },
      { op: 'turn.upsert', turn: {
        kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' }, prompt: 'opening', startedAt: FIXED_AT,
        delivery: { deliveryId: 'open-delivery', messageId: 'opening', deliveredAt: FIXED_AT_2, origin: 'user' },
      } },
      { op: 'step.upsert', turnId: 't0', step: { kind: 'step', turnId: 't0', stepId: 'step-1', ordinal: 1, state: 'completed', startedAt: FIXED_AT } },
      { op: 'frame.upsert', turnId: 't0', stepId: 'step-1', frame: {
        kind: 'text', frameId: 'during', role: 'user', text: 'during mailbox', origin,
        delivery: { deliveryId: 'during-delivery', messageId: 'during', deliveredAt: FIXED_AT_1, origin: 'mailbox' },
      } },
    ]);
    const users = agentTranscriptToBlocks({ agent_id: 'main', ...transcript.snapshot() }).filter((block) => block.kind === 'user');
    expect(users.map((block) => [block.text, block.createdAt])).toEqual([
      ['idle mailbox', FIXED_AT], ['opening', FIXED_AT_2], ['during mailbox', FIXED_AT_1],
    ]);
    expect(users[0]).toMatchObject({ agentMessage: { senderAgentId: 'worker', senderTaskName: 'review' } });
    expect(users[0]?.turnId).toBeUndefined();
  });

  it('keeps historical shell commands separate from their output', () => {
    const classified = classifyTranscriptText({
      text: '<bash-input>\necho hello\n</bash-input><bash-stdout>hello\n</bash-stdout>',
      role: 'user',
      origin: { kind: 'shell_command', phase: 'output' },
    });
    expect(classified).toMatchObject({
      lane: 'shell',
      shell: { commandId: 'history-echo hello', command: 'echo hello', output: 'hello\n' },
    });

    const outputOnly = classifyTranscriptText({
      text: '<bash-stdout>only output</bash-stdout>',
      role: 'user',
      origin: { kind: 'shell_command', phase: 'output' },
    });
    expect(outputOnly.shell?.command).toBeUndefined();
    expect(outputOnly.shell?.output).toBe('only output');
  });

  it('keeps task notification envelopes off the user lane', () => {
    const notification =
      '<notification id="task:task-2:completed" category="task" type="task.completed" source_kind="background_task" source_id="task-2">\n' +
      'Title: Background agent completed\nreview finished\n</notification>';
    expect(
      classifyTranscriptText({ text: notification, role: 'user', origin: { kind: 'user' } }),
    ).toMatchObject({
      lane: 'system',
      systemVariant: 'task',
      text: 'Title: Background agent completed\nreview finished',
    });
    expect(
      classifyTranscriptText({
        text: '<notification category="product">ordinary user text</notification>',
        role: 'user',
        origin: { kind: 'user' },
      }).lane,
    ).toBe('you');
  });
});

describe('message-closure anchors', () => {
  const user = (id: string, text = 'q'): UserBlock => ({
    kind: 'user',
    id,
    text,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const assistant = (id: string, streaming = false): AssistantBlock => ({
    kind: 'assistant',
    id,
    text: 'a',
    streaming,
    createdAt: '2026-01-01T00:00:01.000Z',
  });

  it('latestFinalAssistantBlockId picks the last settled assistant block', () => {
    expect(latestFinalAssistantBlockId([])).toBeUndefined();
    expect(
      latestFinalAssistantBlockId([user('u1'), assistant('a1'), assistant('a2')]),
    ).toBe('a2');
    // A streaming tail never qualifies — regenerate/fork wait for it to settle.
    expect(
      latestFinalAssistantBlockId([user('u1'), assistant('a1'), assistant('live', true)]),
    ).toBe('a1');
  });

  it('assistantMessageIdFromBlockId unwraps snapshot ids and rejects live ids', () => {
    expect(assistantMessageIdFromBlockId('assistant-msg_42-0')).toBe('msg_42');
    expect(assistantMessageIdFromBlockId('assistant-msg_42-media')).toBe('msg_42');
    expect(assistantMessageIdFromBlockId('assistant-live-1-final-end@42')).toBeUndefined();
    expect(assistantMessageIdFromBlockId('assistant-live-7')).toBeUndefined();
    expect(assistantMessageIdFromBlockId('user-msg_1')).toBeUndefined();
  });
});

describe('floor navigation model', () => {
  const user = (id: string, text: string): UserBlock => ({
    kind: 'user',
    id,
    text,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const assistant = (id: string): AssistantBlock => ({
    kind: 'assistant',
    id,
    text: 'a',
    streaming: false,
    createdAt: '2026-01-01T00:00:01.000Z',
  });

  it('builds one floor per user message with a codepoint-safe preview', () => {
    const entries = buildFloorEntries([
      user('user-1', 'first question\nwith a second line'),
      assistant('assistant-1'),
      user('user-2', 'emoji 😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀 tail'),
    ]);
    expect(entries.map((entry) => entry.blockId)).toEqual(['user-1', 'user-2']);
    expect(entries[0]?.preview).toBe('first question');
    // 24 codepoints + ellipsis, never a split surrogate.
    expect(entries[1]?.preview.endsWith('…')).toBe(true);
    expect(Array.from(entries[1]?.preview ?? '').length).toBe(25);
  });

  it('floorPreview trims and keeps short text intact', () => {
    expect(floorPreview('  hello  ')).toBe('hello');
    expect(floorPreview('short')).toBe('short');
  });

  it('resolveActiveFloorId lands on the last row at or above the viewport', () => {
    const positions = [
      { blockId: 'user-1', top: -200 },
      { blockId: 'user-2', top: 40 },
      { blockId: 'user-3', top: 400 },
    ];
    expect(resolveActiveFloorId(positions, 0)).toBe('user-2');
    expect(resolveActiveFloorId(positions, 500)).toBe('user-3');
    expect(resolveActiveFloorId([{ blockId: 'user-1', top: 500 }], 0)).toBeUndefined();
  });
});

describe('transcript authority projection', () => {
  it.each([
    { origin: { kind: 'cron' as const }, promptId: 'p-cron' },
    { origin: { kind: 'other' as const, payload: { kind: 'agent_message', senderAgentId: 'peer' } }, promptId: 'p-mailbox' },
  ])('keeps a running $origin.kind prompt abortable without a visible prompt row', ({ origin, promptId }) => {
    const running = projectAgentTranscriptView(createViewState('session_test'), 'main', emptySnapshot({
      items: [{ kind: 'turn', turnId: 't1', ordinal: 1, state: 'running', origin, promptId, steps: [] }],
      prompts: [],
    }));
    expect(running.busy).toBe(true);
    expect(running.activePromptId).toBeUndefined();
    expect(running.queuedPromptIds).toEqual([]);
    expect(running.abortablePromptId).toBe(promptId);
    expect(running.abortableTurnId).toBe(1);

    const idle = projectAgentTranscriptView(running, 'main', emptySnapshot());
    expect(idle.busy).toBe(false);
    expect(idle.abortablePromptId).toBeUndefined();
    expect(idle.abortableTurnId).toBeUndefined();
  });

  it('projects the active turn id when a task notification has no prompt id', () => {
    const running = projectAgentTranscriptView(createViewState('session_test'), 'main', emptySnapshot({
      items: [{ kind: 'turn', turnId: 't7', ordinal: 7, state: 'running', origin: { kind: 'other', payload: { kind: 'task_notification' } }, steps: [] }],
      prompts: [],
    }));
    expect(running).toMatchObject({ busy: true, activePromptId: undefined, abortablePromptId: undefined, abortableTurnId: 7 });
    const idle = projectAgentTranscriptView(running, 'main', emptySnapshot());
    expect(idle.abortableTurnId).toBeUndefined();
  });

  it('prefers a running task turn over a newer prompt row or optimistic submit echo', () => {
    const current = projectAgentTranscriptView(createViewState('session_test'), 'main', emptySnapshot({
      items: [{ kind: 'turn', turnId: 't7', ordinal: 7, state: 'running', origin: { kind: 'other', payload: { kind: 'task_notification' } }, steps: [] }],
      prompts: userTurnSnapshot({ streaming: true }).prompts,
      meta: { activity: 'turn' },
    }));
    expect(current.abortableTurnId).toBe(7);
    expect(current.abortablePromptId).toBeUndefined();
    const optimistic = appendLocalUserMessage(current, {
      promptId: 'p-next', userMessageId: 'um-next', text: 'follow up', createdAt: FIXED_AT, status: 'running',
    });
    expect(optimistic.abortableTurnId).toBe(7);
    expect(optimistic.abortablePromptId).toBeUndefined();
  });

  it('keeps visible user prompts abortable and clears their id at completion', () => {
    const running = projectAgentTranscriptView(createViewState('session_test'), 'main', userTurnSnapshot({ streaming: true }));
    expect(running.activePromptId).toBe(PROMPT_ID);
    expect(running.abortablePromptId).toBe(PROMPT_ID);
    const completed = projectAgentTranscriptView(running, 'main', userTurnSnapshot());
    expect(completed.activePromptId).toBeUndefined();
    expect(completed.abortablePromptId).toBeUndefined();
  });

  it('does not invent a binding for an unbound main or child with sparse transcript metadata', () => {
    for (const agentId of ['main', CHILD_AGENT_ID]) {
      const state = projectAgentTranscriptView(createViewState('session_test'), agentId, emptySnapshot());
      expect(state.model).toBeUndefined();
    }
  });

  it('does not adopt snapshot messages or in-flight text in the transcript shell', () => {
    const state = applyTranscriptShell('session_test', {
      as_of_seq: 4,
      epoch: 'e1',
      session,
      messages: {
        items: [
          {
            id: 'm1',
            role: 'assistant',
            content: [{ type: 'text', text: 'should not appear' }],
            created_at: '2026-01-01T00:00:00.000Z',
          } as Message,
        ],
        has_more: true,
      },
      in_flight_turn: {
        turn_id: 1,
        assistant_text: 'live',
        thinking_text: 'think',
        running_tools: [],
      } as SessionSnapshotResponse['in_flight_turn'],
      pending_approvals: [],
      pending_questions: [],
    });
    expect(state.blocks).toEqual([]);
    expect(state.cursor).toEqual({ seq: 4, epoch: 'e1' });
  });

  it('does not rewind a live session cursor behind a stale snapshot', () => {
    const previous = applyTranscriptShell('session_test', {
      as_of_seq: 4,
      epoch: 'e1',
      session,
      messages: { items: [], has_more: false },
      in_flight_turn: null,
      pending_approvals: [],
      pending_questions: [],
    });
    const live = { ...previous, cursor: { seq: 20, epoch: 'e1' } };
    const next = applyTranscriptShell(
      'session_test',
      {
        as_of_seq: 4,
        epoch: 'e1',
        session,
        messages: { items: [], has_more: false },
        in_flight_turn: null,
        pending_approvals: [],
        pending_questions: [],
      },
      live,
    );
    expect(next.cursor).toEqual({ seq: 20, epoch: 'e1' });
  });

  it('does not treat background-only session work as an active main turn on attach', () => {
    const state = applyTranscriptShell('session_test', {
      as_of_seq: 4,
      epoch: 'e1',
      session: { ...session, busy: true, main_turn_active: false },
      messages: { items: [], has_more: false },
      in_flight_turn: null,
      pending_approvals: [],
      pending_questions: [],
    });

    expect(state.session?.busy).toBe(true);
    expect(state.busy).toBe(false);
  });

  it('uses the in-flight main turn as the old-server attach fallback', () => {
    const idle = applyTranscriptShell('session_test', {
      as_of_seq: 4,
      epoch: 'e1',
      session: { ...session, busy: true },
      messages: { items: [], has_more: false },
      in_flight_turn: null,
      pending_approvals: [],
      pending_questions: [],
    });
    const active = applyTranscriptShell('session_test', {
      as_of_seq: 4,
      epoch: 'e1',
      session: { ...session, busy: true },
      messages: { items: [], has_more: false },
      in_flight_turn: {
        turn_id: 1,
        assistant_text: '',
        thinking_text: '',
        running_tools: [],
      } as SessionSnapshotResponse['in_flight_turn'],
      pending_approvals: [],
      pending_questions: [],
    });

    expect(idle.busy).toBe(false);
    expect(active.busy).toBe(true);
  });

  it('restores an in-flight continuation id on attach and clears it on idle resync', () => {
    const base = {
      as_of_seq: 4,
      epoch: 'e1',
      session: { ...session, main_turn_active: true },
      messages: { items: [], has_more: false },
      pending_approvals: [],
      pending_questions: [],
    };
    const running = applyTranscriptShell('session_test', {
      ...base,
      in_flight_turn: {
        turn_id: 1,
        assistant_text: '',
        thinking_text: '',
        running_tools: [],
        current_prompt_id: 'p-cron',
      },
    });
    expect(running.busy).toBe(true);
    expect(running.activePromptId).toBeUndefined();
    expect(running.abortablePromptId).toBe('p-cron');
    expect(running.abortableTurnId).toBe(1);

    const promptless = applyTranscriptShell('session_test', {
      ...base,
      in_flight_turn: {
        turn_id: 2,
        assistant_text: '',
        thinking_text: '',
        running_tools: [],
      },
    }, running);
    expect(promptless.abortablePromptId).toBeUndefined();
    expect(promptless.abortableTurnId).toBe(2);

    const idle = applyTranscriptShell('session_test', {
      ...base,
      session: { ...session, main_turn_active: false },
      in_flight_turn: null,
    }, promptless);
    expect(idle.abortablePromptId).toBeUndefined();
    expect(idle.abortableTurnId).toBeUndefined();
    expect(idle.busy).toBe(false);
  });

  it('keeps compact snapshot.subagents on the transcript shell', () => {
    const state = applyTranscriptShell('session_test', {
      as_of_seq: 4,
      epoch: 'e1',
      session,
      messages: { items: [], has_more: false },
      in_flight_turn: null,
      pending_approvals: [],
      pending_questions: [],
      subagents: [
        compactSnapshotSubagent({
          id: CHILD_AGENT_ID,
          agent_id: CHILD_AGENT_ID,
          model: 'provider/kimi-for-coding',
          thinking_effort: 'high',
          tool_call_count: 7,
          label: 'research',
          profile: 'researcher',
        }),
      ],
    });
    expect(state.blocks).toEqual([]);
    expect(state.snapshotSubagents).toEqual([
      expect.objectContaining({
        id: CHILD_AGENT_ID,
        model: 'provider/kimi-for-coding',
        thinking_effort: 'high',
        tool_call_count: 7,
      }),
    ]);
  });

  it('prepends older pages by entity id and stays idempotent', () => {
    const current = {
      items: [
        { kind: 'turn' as const, turnId: 't2', ordinal: 2, state: 'completed' as const, origin: { kind: 'user' as const }, steps: [] },
      ],
      tasks: [],
      interactions: [],
      attachments: [{ attachmentId: 'a2', mediaType: 'text/plain' }],
      todos: [],
      prompts: [],
      meta: {},
      hasMoreOlder: true,
    };
    const older = {
      items: [
        { kind: 'turn' as const, turnId: 't1', ordinal: 1, state: 'completed' as const, origin: { kind: 'user' as const }, steps: [] },
        { kind: 'turn' as const, turnId: 't2', ordinal: 2, state: 'completed' as const, origin: { kind: 'user' as const }, steps: [] },
      ],
      attachments: [
        { attachmentId: 'a1', mediaType: 'text/plain' },
        { attachmentId: 'a2', mediaType: 'text/plain' },
      ],
      has_more: false,
    };
    const first = prependOlderTranscriptSnapshot(current, older);
    const second = prependOlderTranscriptSnapshot(first, older);
    expect(first.items.map((item) => (item.kind === 'turn' ? item.turnId : item.kind))).toEqual(['t1', 't2']);
    expect(second.items).toEqual(first.items);
    expect(first.attachments.map((attachment) => attachment.attachmentId)).toEqual(['a1', 'a2']);
  });

  it('keeps leading marker and taskref page boundaries in source order while prepending', () => {
    const at = (minute: number) => `2026-10-01T00:${String(minute).padStart(2, '0')}:00.000Z`;
    const turn = (ordinal: number) => ({ kind: 'turn' as const, turnId: `t${ordinal}`, ordinal,
      startedAt: at(ordinal * 10), state: 'completed' as const, origin: { kind: 'user' as const }, steps: [] });
    const marker = { kind: 'marker' as const, markerId: 'm4', marker: 'message.delivery', at: at(40) };
    const ref = { kind: 'taskref' as const, refId: 'r4', taskId: 'task4', at: at(41) };
    const latest = { ...emptySnapshot(), items: [marker, ref, turn(5)] };
    const middle = [turn(3), { kind: 'marker' as const, markerId: 'm3', marker: 'message.delivery', at: at(35) }];
    const first = [turn(0), turn(1)];
    const merged = prependOlderTranscriptSnapshot(prependOlderTranscriptSnapshot(latest,
      { items: middle, attachments: [], hasMoreOlder: true }), { items: first, attachments: [], hasMoreOlder: false });
    expect(merged.items).toEqual([...first, ...middle, ...latest.items]);
    expect(merged.items.at(-1)).toBe(latest.items.at(-1));
    expect(prependOlderTranscriptSnapshot(merged, { items: middle, attachments: [], hasMoreOlder: true }).items).toEqual(merged.items);
  });

  it('places a recovered middle gap before the following turn’s leading activity without moving earlier activity', () => {
    const turn = (ordinal: number) => ({ kind: 'turn' as const, turnId: `t${ordinal}`, ordinal,
      startedAt: `2026-10-01T00:0${ordinal}:00.000Z`, state: 'completed' as const, origin: { kind: 'user' as const }, steps: [] });
    const marker = (ordinal: number) => ({ kind: 'marker' as const, markerId: `m${ordinal}`, marker: 'message.delivery',
      at: `2026-10-01T00:0${ordinal}:30.000Z` });
    const current = { ...emptySnapshot(), items: [turn(0), marker(0), turn(1), marker(3), turn(4)] };
    const gap = [turn(2), marker(2), turn(3)];
    expect(prependOlderTranscriptSnapshot(current, { items: gap, attachments: [], hasMoreOlder: true }).items)
      .toEqual([...current.items.slice(0, 3), ...gap, ...current.items.slice(3)]);
  });

  it('anchors Agent entries on the real tool frame agentRefs', () => {
    const snapshots = new Map([
      [
        'main',
        {
          items: [
            {
              kind: 'turn' as const,
              turnId: 't1',
              ordinal: 1,
              state: 'running' as const,
              origin: { kind: 'user' as const },
              steps: [
                {
                  kind: 'step' as const,
                  stepId: 't1.1',
                  turnId: 't1',
                  ordinal: 1,
                  state: 'running' as const,
                  frames: [
                    {
                      kind: 'tool' as const,
                      frameId: 'spawn',
                      toolCallId: 'tc-agent',
                      name: 'Agent',
                      state: 'running' as const,
                      agentRefs: [{ agentId: 'child-1', role: 'child' as const }],
                    },
                  ],
                },
              ],
            },
          ],
          tasks: [
            {
              taskId: 'task-1',
              kind: 'subagent' as const,
              state: 'running' as const,
              detached: false,
              name: 'smoke_explore',
              agentId: 'child-1',
              outputTail: '',
            },
          ],
          interactions: [],
          attachments: [],
          todos: [],
          prompts: [],
          meta: {},
        },
      ],
    ]);
    const live = liveSourcesFromAgentSnapshots(snapshots);
    expect(live).toEqual([
      expect.objectContaining({
        subagentId: 'child-1',
        parentAgentId: 'main',
        name: 'smoke_explore',
        parentToolCallId: 'tc-agent',
        status: 'running',
      }),
    ]);
    const forest = sessionAgentForestFromAgentSnapshots(snapshots, [
      compactSnapshotSubagent({
        id: 'child-1',
        agent_id: 'child-1',
        model: 'provider/kimi-for-coding',
        thinking_effort: 'high',
        tool_call_count: 7,
        label: 'research',
      }),
      compactSnapshotSubagent({
        id: 'ghost-child',
        agent_id: 'ghost-child',
        model: 'provider/should-not-appear',
        tool_call_count: 9,
      }),
    ]);
    expect(forest.byId['child-1']).toMatchObject({
      name: 'smoke_explore',
      model: 'provider/kimi-for-coding',
      thinkingEffort: 'high',
      toolCallCount: 7,
      label: 'research',
    });
    expect(forest.byId['ghost-child']).toBeUndefined();
  });

  it('keeps a resumed child visible before its new task reaches the main transcript without reviving retained ghosts', () => {
    const previous = compactSnapshotSubagent({
      id: CHILD_AGENT_ID,
      parent_agent_id: 'main',
      status: 'completed',
      subagent_phase: 'completed',
      live: false,
      model: 'provider/kimi-for-coding',
      started_at: FIXED_AT_1,
      completed_at: FIXED_AT_2,
    });
    expect(sessionAgentForestFromAgentSnapshots(new Map(), [previous]).byId[CHILD_AGENT_ID]).toMatchObject({
      status: 'completed',
      model: 'provider/kimi-for-coding',
      endedAt: FIXED_AT_2,
    });

    const snapshots = new Map<string, AgentTranscriptSnapshot>([['main', emptySnapshot()]]);
    expect(sessionAgentForestFromAgentSnapshots(snapshots, [previous]).byId[CHILD_AGENT_ID]).toBeUndefined();
    const refreshingUntil = new Date(Date.now() + 120_000).toISOString();
    const refreshing = { ...previous, live: undefined, refreshing: true, refreshing_until: refreshingUntil };
    expect(sessionAgentForestFromAgentSnapshots(snapshots, [refreshing]).byId[CHILD_AGENT_ID]).toMatchObject({
      status: 'completed', refreshing: true, refreshingUntil,
      model: 'provider/kimi-for-coding', endedAt: FIXED_AT_2,
    });
    expect(sessionAgentForestFromAgentSnapshots(snapshots, [{ ...refreshing, live: false }]).byId[CHILD_AGENT_ID]).toBeUndefined();
    expect(sessionAgentForestFromAgentSnapshots(snapshots, [{
      ...refreshing, refreshing_until: new Date(Date.now() - 1).toISOString(),
    }]).byId[CHILD_AGENT_ID]).toBeUndefined();

    const previousTask = emptySnapshot({
      tasks: [{
        taskId: 'task-previous', kind: 'subagent', state: 'completed', detached: true,
        agentId: CHILD_AGENT_ID, startedAt: FIXED_AT_1, endedAt: FIXED_AT_2, outputTail: '',
      }],
    });
    snapshots.set('main', previousTask);
    expect(sessionAgentForestFromAgentSnapshots(snapshots, [refreshing]).byId[CHILD_AGENT_ID]).toMatchObject({
      status: 'completed', refreshing: true, endedAt: FIXED_AT_2,
    });
    snapshots.set('main', emptySnapshot());

    const resumedAt = '2026-01-01T00:00:03.000Z';
    const resumed = {
      ...previous,
      status: 'running' as const,
      subagent_phase: 'working' as const,
      live: undefined,
      started_at: resumedAt,
      completed_at: undefined,
    };
    expect(sessionAgentForestFromAgentSnapshots(snapshots, [resumed]).byId[CHILD_AGENT_ID]).toMatchObject({
      status: 'running',
      busy: true,
      model: 'provider/kimi-for-coding',
      startedAt: resumedAt,
      endedAt: undefined,
    });
    expect(sessionAgentForestFromAgentSnapshots(snapshots, [{
      ...resumed, refreshing: true, refreshing_until: refreshingUntil,
    }]).byId[CHILD_AGENT_ID]).toMatchObject({
      status: 'running', refreshing: true, refreshingUntil,
    });
    expect(sessionAgentForestFromAgentSnapshots(snapshots, [{ ...resumed, live: false }]).byId[CHILD_AGENT_ID]).toBeUndefined();

    snapshots.set('main', emptySnapshot({
      tasks: [{
        taskId: 'task-resumed',
        kind: 'subagent',
        state: 'completed',
        detached: true,
        agentId: CHILD_AGENT_ID,
        startedAt: resumedAt,
        endedAt: '2026-01-01T00:00:04.000Z',
        outputTail: '',
      }],
    }));
    const completedAt = '2026-01-01T00:00:04.000Z';
    const completed = {
      ...resumed,
      status: 'completed' as const,
      subagent_phase: 'completed' as const,
      completed_at: completedAt,
    };
    expect(sessionAgentForestFromAgentSnapshots(snapshots, [completed]).byId[CHILD_AGENT_ID]).toMatchObject({
      status: 'completed',
      refreshing: undefined,
      model: 'provider/kimi-for-coding',
      endedAt: completedAt,
    });
  });

  it('carries a child snapshot full-history count through the forest without requiring agent meta', () => {
    const main = applyOpsToSnapshot(emptySnapshot(), spawnChildOps());
    const snapshots = new Map<string, AgentTranscriptSnapshot>([
      ['main', main],
      [CHILD_AGENT_ID, emptySnapshot({ toolCallCount: 7, hasMoreOlder: true })],
    ]);
    expect(liveSourcesFromAgentSnapshots(snapshots).find((entry) => entry.subagentId === CHILD_AGENT_ID)).toMatchObject({
      toolCallCount: 7,
      toolCallCountKnown: true,
    });
    expect(sessionAgentForestFromAgentSnapshots(snapshots).byId[CHILD_AGENT_ID]).toMatchObject({
      toolCallCount: 7,
      toolCallCountKnown: true,
    });
  });

  it('overlays snapshot.subagents onto live sources without inventing missing counts', () => {
    const overlaid = overlayLiveSourcesWithSnapshotSubagents(
      [
        {
          subagentId: 'child-1',
          parentAgentId: 'main',
          name: 'child-1',
          status: 'completed',
          toolCallCount: 0,
        },
      ],
      [
        compactSnapshotSubagent({
          id: 'child-1',
          description: 'Inspect the protocol',
          profile: 'researcher',
        }),
      ],
    );
    expect(overlaid).toEqual([
      expect.objectContaining({
        subagentId: 'child-1',
        model: undefined,
        thinkingEffort: undefined,
        toolCallCount: 0,
        name: 'Inspect the protocol',
      }),
    ]);
  });

  it('stops a retained snapshot row from claiming a live run in the forest', () => {
    const retained = [
      compactSnapshotSubagent({
        id: CHILD_AGENT_ID,
        agent_id: CHILD_AGENT_ID,
        status: 'running',
        subagent_phase: 'working',
        live: false,
        started_at: FIXED_AT_1,
      }),
    ];
    expect(rosterFromSnapshotSubagents(retained)[0]).toMatchObject({
      agentId: CHILD_AGENT_ID,
      status: 'running',
      startedAt: FIXED_AT_1,
      disposedAt: FIXED_AT_1,
    });

    const snapshots = new Map<string, AgentTranscriptSnapshot>([
      ['main', applyOpsToSnapshot(emptySnapshot(), spawnChildOps())],
    ]);
    const forest = sessionAgentForestFromAgentSnapshots(snapshots, retained);
    expect(forest.byId[CHILD_AGENT_ID]).toMatchObject({
      status: 'unknown',
      busy: false,
      name: 'Inspect the protocol',
    });
  });

  it('keeps a queued retained row out of the active state', () => {
    const queued = [
      compactSnapshotSubagent({
        id: CHILD_AGENT_ID,
        agent_id: CHILD_AGENT_ID,
        status: 'running',
        subagent_phase: 'queued',
        live: false,
        started_at: FIXED_AT_1,
      }),
    ];
    const snapshots = new Map<string, AgentTranscriptSnapshot>([
      ['main', applyOpsToSnapshot(emptySnapshot(), spawnChildOps())],
    ]);
    const forest = sessionAgentForestFromAgentSnapshots(snapshots, queued);
    expect(forest.byId[CHILD_AGENT_ID]).toMatchObject({ status: 'unknown', busy: false });
  });

  it('does not let a retained snapshot row promote an unknown subagent block to active', () => {
    const queued = [
      compactSnapshotSubagent({
        id: 'agent-queued',
        status: 'running',
        subagent_phase: 'queued',
        live: false,
        started_at: FIXED_AT_1,
      }),
    ];
    expect(overlaySnapshotSubagentFields([unknownChildBlock('agent-queued')], queued)[0]).toMatchObject({
      status: 'unknown',
    });

    const olderServerRow = [
      compactSnapshotSubagent({
        id: 'agent-queued',
        status: 'running',
        subagent_phase: 'queued',
        started_at: FIXED_AT_1,
      }),
    ];
    expect(
      overlaySnapshotSubagentFields([unknownChildBlock('agent-queued')], olderServerRow)[0],
    ).toMatchObject({ status: 'running' });
  });

  it('preserves terminal snapshot evidence after its live scope is disposed', () => {
    const completed = [compactSnapshotSubagent({
      id: CHILD_AGENT_ID,
      status: 'completed',
      subagent_phase: 'completed',
      live: false,
      started_at: FIXED_AT_1,
      completed_at: FIXED_AT_2,
      output_preview: 'finished before disposal',
    })];
    expect(overlaySnapshotSubagentFields([unknownChildBlock()], completed)[0]).toMatchObject({
      status: 'completed',
      summary: 'finished before disposal',
    });
  });

  it('keeps a running snapshot row active when the server sends no liveness field', () => {
    const olderServerRow = [
      compactSnapshotSubagent({
        id: CHILD_AGENT_ID,
        agent_id: CHILD_AGENT_ID,
        status: 'running',
        subagent_phase: 'working',
        started_at: FIXED_AT_1,
      }),
    ];
    const snapshots = new Map<string, AgentTranscriptSnapshot>([
      ['main', applyOpsToSnapshot(emptySnapshot(), spawnChildOps())],
    ]);
    expect(rosterFromSnapshotSubagents(olderServerRow)[0]?.disposedAt).toBeUndefined();
    expect(sessionAgentForestFromAgentSnapshots(snapshots, olderServerRow).byId[CHILD_AGENT_ID]).toMatchObject({
      status: 'running',
      busy: true,
    });
  });

  it('lets a run that starts after the retained row revive the forest node', () => {
    const snapshots = new Map<string, AgentTranscriptSnapshot>([
      [
        'main',
        applyOpsToSnapshot(emptySnapshot(), [
          ...spawnChildOps(),
          {
            op: 'task.upsert',
            task: {
              taskId: `task-${CHILD_AGENT_ID}`,
              kind: 'subagent',
              state: 'running',
              detached: false,
              description: 'Inspect the protocol',
              agentId: CHILD_AGENT_ID,
              outputTail: '',
              startedAt: FIXED_AT_2,
            },
          },
        ]),
      ],
    ]);
    const retained = [
      compactSnapshotSubagent({
        id: CHILD_AGENT_ID,
        agent_id: CHILD_AGENT_ID,
        status: 'running',
        subagent_phase: 'working',
        live: false,
        started_at: FIXED_AT_1,
      }),
    ];

    const sources = overlayLiveSourcesWithSnapshotSubagents(
      liveSourcesFromAgentSnapshots(snapshots),
      retained,
    );
    const child = sources.find((entry) => entry.subagentId === CHILD_AGENT_ID);
    expect(child).toMatchObject({ startedAt: FIXED_AT_2, disposedAt: FIXED_AT_1 });
    expect(sessionAgentForestFromAgentSnapshots(snapshots, retained).byId[CHILD_AGENT_ID]).toMatchObject({
      status: 'running',
      busy: true,
      startedAt: FIXED_AT_2,
    });
  });
});

describe('transcript response selectors', () => {
  it('uses REST tool-call aggregates without losing visible tool blocks', () => {
    const blocks: ToolBlock[] = [
      {
        kind: 'tool',
        id: 'tool-1',
        toolCallId: 'call-1',
        name: 'Bash',
        argsText: '',
        args: {},
        display: undefined,
        description: undefined,
        status: 'done',
        output: undefined,
        isError: undefined,
        durationMs: undefined,
        progressText: undefined,
      },
    ];
    const response: AgentTranscriptResponse = {
      agent_id: 'main',
      items: [],
      has_more: true,
      tool_call_count: 5,
    };
    const supplied = agentTranscriptPageFromResponse(response, blocks);
    expect(supplied.toolCallCount).toBe(5);
    expect(supplied.toolCallCountKnown).toBe(true);

    const absent = agentTranscriptPageFromResponse({ ...response, tool_call_count: undefined }, blocks);
    expect(absent.toolCallCount).toBe(1);
    expect(absent.toolCallCountKnown).toBe(false);

    const oldestPage = agentTranscriptPageFromResponse(
      { ...response, has_more: false, tool_call_count: undefined },
      [],
    );
    expect(oldestPage.toolCallCount).toBe(0);
    expect(oldestPage.toolCallCountKnown).toBe(false);
    const knownZero = agentTranscriptPageFromResponse({ ...response, has_more: false, tool_call_count: 0 }, []);
    expect(knownZero.toolCallCountKnown).toBe(true);
  });
});

describe('subagent invocation details', () => {
  const prompt = `  Inspect the complete input.\n${'detail '.repeat(700)}\nDo not trim.  `;
  const advisory = {
    version: 1,
    code: 'effort_pin_overridden',
    dimension: 'thinking_effort',
    ruleSource: 'profile:reviewer.thinking_effort',
    ruleValue: 'low',
    requestedValue: 'high',
    effectiveValue: 'high',
    valueSource: 'dispatch-explicit',
    message: 'Keep the explicitly requested effort.',
  };
  const runOutput = `task_id: task_detail\nagent_id: agent_detail\nactual_profile: reviewer\nbinding_advisories: ${JSON.stringify([advisory])}\nstatus: completed\n\n[summary]\nStanding directives in effect: legacy receipt text\n${prompt}`;
  const calls = [
    { name: 'AgentRun', args: { profile: 'reviewer', name: 'detail_child', model_alias: 'large-model', effort: 'high', background: true, prompt, description: 'Inspect detail' }, output: runOutput },
    { name: 'AgentRun', args: { resume: 'agent_detail', model_alias: 'large-model', effort: 'high', background: false, prompt, description: 'Resume detail' }, output: runOutput },
    { name: 'AgentSend', args: { target: 'agent_detail', message: prompt }, output: JSON.stringify({ message_id: 'message_detail', status: 'queued', resumed: false, deduplicated: false, target: { task_name: 'detail_child', agent_id: 'agent_detail' } }) },
    { name: 'AgentList', args: { include_finished: true }, output: JSON.stringify({ agents: [{ agent_id: 'agent_detail', name: 'detail_child', profile: 'reviewer', status: 'completed' }] }) },
  ];

  it.each(calls)('retains complete $name input and output independently of the agent card', ({ name, args, output }) => {
    const inputText = JSON.stringify(args, null, 2);
    const blocks = agentTranscriptToBlocks({
      agent_id: 'main',
      items: [{
        kind: 'turn', turnId: 't-detail', ordinal: 1, state: 'completed', origin: { kind: 'user' }, steps: [{
          kind: 'step', stepId: 't-detail.1', turnId: 't-detail', ordinal: 1, state: 'completed', frames: [{
            kind: 'tool', frameId: 'f-detail', toolCallId: 'call_detail', name, state: 'done',
            input: args, inputText, output,
            agentRefs: name === 'AgentRun' ? [{ agentId: 'agent_detail', role: 'child' }] : undefined,
          }],
        }],
      }],
    });
    const tool = blocks.find((block) => block.kind === 'tool');
    expect(tool).toMatchObject({ toolCallId: 'call_detail', name, argsText: inputText, args, output });
    if (name === 'AgentRun') {
      const card = blocks.find((block) => block.kind === 'subagent');
      expect(card).toMatchObject({ subagentId: 'agent_detail', parentToolCallId: 'call_detail' });
    }
  });
});

describe('transcript projection cache', () => {
  it('reuses blocks projected from unchanged settled transcript items', () => {
    const item: AgentTranscriptSnapshot['items'][number] = {
      kind: 'turn',
      turnId: 't-cache',
      ordinal: 1,
      state: 'completed',
      origin: { kind: 'user' },
      prompt: 'cached prompt',
      startedAt: FIXED_AT,
      endedAt: FIXED_AT_2,
      steps: [
        {
          kind: 'step',
          stepId: 't-cache.1',
          turnId: 't-cache',
          ordinal: 1,
          state: 'completed',
          frames: [
            { kind: 'text', frameId: 'f-cache', role: 'assistant', text: 'cached answer' },
          ],
        },
      ],
    };

    const first = agentTranscriptToBlocks({ agent_id: 'main', items: [item] });
    const second = agentTranscriptToBlocks({ agent_id: 'main', items: [item] });

    expect(second).not.toBe(first);
    expect(second).toHaveLength(first.length);
    for (let index = 0; index < first.length; index += 1) {
      expect(second[index]).toBe(first[index]);
    }
  });

  it('reprojects attachment-bearing items when attachment metadata changes', () => {
    const item = {
      kind: 'turn' as const,
      turnId: 't-media',
      ordinal: 1,
      state: 'completed' as const,
      origin: { kind: 'user' as const },
      prompt: 'see attachment',
      attachmentIds: ['att-1'],
      startedAt: FIXED_AT,
      steps: [],
    };
    const first = agentTranscriptToBlocks({
      agent_id: 'main',
      items: [item],
      attachments: [
        { attachmentId: 'att-1', mediaType: 'image/png', source: { kind: 'url', url: 'https://example.com/one.png' } },
      ],
    });
    const second = agentTranscriptToBlocks({
      agent_id: 'main',
      items: [item],
      attachments: [
        { attachmentId: 'att-1', mediaType: 'image/png', source: { kind: 'url', url: 'https://example.com/two.png' } },
      ],
    });

    expect(first[0]).toMatchObject({ kind: 'user', media: [{ url: 'https://example.com/one.png' }] });
    expect(second[0]).toMatchObject({ kind: 'user', media: [{ url: 'https://example.com/two.png' }] });
    expect(second[0]).not.toBe(first[0]);
  });

  it('routes history attachments with blobrefs through agent-scoped session media', () => {
    const hash = 'a'.repeat(64);
    const items = [{
      kind: 'turn' as const, turnId: 't-media-blob', ordinal: 1, state: 'completed' as const,
      origin: { kind: 'user' as const }, prompt: 'see image', attachmentIds: ['att-blob'],
      startedAt: FIXED_AT, steps: [],
    }];
    const blocks = agentTranscriptToBlocks({
      agent_id: 'main', items,
      attachments: [{ attachmentId: 'att-blob', mediaType: 'image/*', source: { kind: 'url', url: `blobref:image/png;${hash}` } }],
    });
    expect(blocks.find((block) => block.kind === 'user')).toMatchObject({
      media: [{ kind: 'image', blobHash: hash, mime: 'image/png', fileId: `blobref:main:${hash}` }],
    });
  });

  it('reprojects a settled task-backed shell when the global task entity changes', () => {
    const item: AgentTranscriptSnapshot['items'][number] = {
      kind: 'turn',
      turnId: 't-task-cache',
      ordinal: 1,
      state: 'completed',
      origin: { kind: 'user' },
      prompt: 'run it',
      startedAt: FIXED_AT,
      steps: [
        {
          kind: 'step',
          stepId: 't-task-cache.1',
          turnId: 't-task-cache',
          ordinal: 1,
          state: 'completed',
          startedAt: FIXED_AT_1,
          frames: [
            {
              kind: 'tool',
              frameId: 'f-task-cache',
              toolCallId: 'command-task-cache',
              taskId: 'task-cache',
              name: 'Bash',
              state: 'done',
              input: { command: 'pwd' },
            },
          ],
        },
      ],
    };
    const task = {
      taskId: 'task-cache',
      kind: 'shell' as const,
      detached: false,
      startedAt: FIXED_AT_1,
    };
    const first = agentTranscriptToBlocks({
      agent_id: 'main',
      items: [item],
      tasks: [{ ...task, state: 'running', outputTail: 'partial' }],
    });
    const second = agentTranscriptToBlocks({
      agent_id: 'main',
      items: [item],
      tasks: [{ ...task, state: 'completed', outputTail: 'complete' }],
    });

    expect(first.find((block) => block.kind === 'shell')).toMatchObject({
      command: 'pwd',
      output: 'partial',
      done: false,
    });
    expect(second.find((block) => block.kind === 'shell')).toMatchObject({
      command: 'pwd',
      output: 'complete',
      done: true,
    });
  });

  it('retains a previously projected command when a result refresh omits the input', () => {
    const item: AgentTranscriptSnapshot['items'][number] = {
      kind: 'turn',
      turnId: 't-task-refresh',
      ordinal: 1,
      state: 'completed',
      origin: { kind: 'user' },
      startedAt: FIXED_AT,
      steps: [
        {
          kind: 'step',
          stepId: 't-task-refresh.1',
          turnId: 't-task-refresh',
          ordinal: 1,
          state: 'completed',
          frames: [
            {
              kind: 'tool',
              frameId: 'f-task-refresh',
              toolCallId: 'command-task-refresh',
              name: 'Bash',
              state: 'running',
              input: { command: 'printf retained' },
            },
          ],
        },
      ],
    };
    const initial = agentTranscriptToBlocks({ agent_id: 'main', items: [item] });
    const resultOnly = {
      ...item,
      steps: item.steps.map((step) => ({
        ...step,
        frames: step.frames.map((frame) =>
          frame.kind === 'tool'
            ? { ...frame, state: 'done' as const, input: undefined, output: 'result' }
            : frame,
        ),
      })),
    };
    const refreshed = agentTranscriptToBlocks({ agent_id: 'main', items: [resultOnly] }, initial);
    expect(refreshed.find((block) => block.kind === 'shell')).toMatchObject({
      command: 'printf retained',
      output: 'result',
      done: true,
    });
  });
});

describe('canonical product gates via projectAgentTranscriptView', () => {
  it('updates an optimistic prompt when only its media changes', () => {
    const initial = appendLocalUserMessage(createViewState('session_test'), {
      userMessageId: 'um-media',
      promptId: 'p-media',
      text: 'same caption',
      createdAt: FIXED_AT,
      status: 'running',
      media: [{ kind: 'image', fileId: 'file-old', name: 'old.png' }],
    });
    const updated = appendLocalUserMessage(initial, {
      userMessageId: 'um-media',
      promptId: 'p-media',
      text: 'same caption',
      createdAt: FIXED_AT,
      status: 'running',
      media: [{ kind: 'image', fileId: 'file-new', name: 'new.png' }],
    });
    expect(updated.blocks.find((block) => block.kind === 'user')).toMatchObject({
      media: [{ kind: 'image', fileId: 'file-new', name: 'new.png' }],
    });
  });

  it('keeps the real user message identity so edit/fork do not parse block ids', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      userTurnSnapshot(),
    );
    const user = projected.blocks.find((block) => block.kind === 'user');
    expect(user).toMatchObject({
      kind: 'user',
      userMessageId: USER_MESSAGE_ID,
      promptId: PROMPT_ID,
    });
    expect(user?.id).toBe(`user-${USER_MESSAGE_ID}`);
  });

  it('anchors turn timing only to a running turn with a valid startedAt timestamp', () => {
    const running = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      userTurnSnapshot({ streaming: true }),
    );
    expect(running.turnStartedAt).toBe(Date.parse(FIXED_AT));

    const completed = projectAgentTranscriptView(running, 'main', userTurnSnapshot());
    expect(completed.turnStartedAt).toBeUndefined();

    const invalid = projectAgentTranscriptView(
      completed,
      'main',
      emptySnapshot({
        items: [
          {
            kind: 'turn',
            turnId: 't2',
            ordinal: 2,
            state: 'running',
            origin: { kind: 'user' },
            startedAt: 'not-an-iso-timestamp',
            steps: [],
          },
        ],
        meta: { activity: 'turn' },
      }),
    );
    expect(invalid.turnStartedAt).toBeUndefined();
  });

  it('gives regenerate/fork a durable assistant message identity without parsing block ids', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      userTurnSnapshot(),
    );
    const assistant = projected.blocks.find((block) => block.kind === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant?.messageId).toBe('msg-asst-canonical');
    expect(assistantMessageIdFromBlock(assistant!)).toBe('msg-asst-canonical');
    expect(assistant!.id.startsWith('assistant-live-')).toBe(false);
  });

  it('surfaces a provider retry on the live step as turnRetry and clears it once the retry lifts', () => {
    const retryingSnapshot = emptySnapshot({
      items: [
        {
          kind: 'turn',
          turnId: 't1',
          ordinal: 1,
          state: 'running',
          origin: { kind: 'user', payload: { promptId: PROMPT_ID, userMessageId: USER_MESSAGE_ID } },
          prompt: 'retry me',
          startedAt: FIXED_AT,
          steps: [
            {
              kind: 'step',
              stepId: 't1.1',
              turnId: 't1',
              ordinal: 1,
              state: 'running',
              frames: [],
              retry: {
                failedAttempt: 3,
                nextAttempt: 4,
                maxAttempts: 10,
                delayMs: 60_000,
                errorName: 'APIStatusError',
                errorMessage: '504 gateway timeout',
                statusCode: 504,
              },
            },
          ],
        },
      ],
    });
    const retrying = projectAgentTranscriptView(createViewState('session_test'), 'main', retryingSnapshot);
    expect(retrying.turnRetry).toEqual({
      failedAttempt: 3,
      maxAttempts: 10,
      delayMs: 60_000,
      errorName: 'APIStatusError',
      statusCode: 504,
    });

    const recovered = projectAgentTranscriptView(retrying, 'main', userTurnSnapshot({ streaming: true }));
    expect(recovered.turnRetry).toBeUndefined();
  });

  it('keeps a live frame streaming when the v1 compatibility phase has an empty step id', () => {
    const base = userTurnSnapshot({ streaming: true });
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      {
        ...base,
        meta: {
          ...base.meta,
          agent: {
            ...base.meta.agent,
            phase: {
              kind: 'streaming',
              turnId: 1,
              step: 1,
              stepId: '',
              stream: 'assistant',
              since: 0,
            },
          },
        },
      },
    );
    expect(projected.blocks.find((block) => block.kind === 'assistant')).toMatchObject({
      streaming: true,
    });
  });

  it('anchors interaction cards directly after their tool instead of at the transcript bottom', () => {
    const snapshot = applyOpsToSnapshot(userTurnSnapshot({ streaming: true }), [
      ...spawnChildOps(),
      {
        op: 'interaction.upsert',
        interaction: {
          interactionId: 'apr-tool',
          interactionKind: 'approval',
          toolCallId: TOOL_CALL_ID,
          anchor: { kind: 'tool_call', toolCallId: TOOL_CALL_ID },
          state: 'pending',
          request: { toolName: 'Agent', action: 'Spawn reviewer' },
        },
      },
    ]);
    const projected = projectAgentTranscriptView(createViewState('session_test'), 'main', snapshot);
    const toolIndex = projected.blocks.findIndex(
      (block) => block.kind === 'tool' && block.toolCallId === TOOL_CALL_ID,
    );
    const approvalIndex = projected.blocks.findIndex((block) => block.id === 'approval-apr-tool');
    const subagentIndex = projected.blocks.findIndex(
      (block) => block.kind === 'subagent' && block.parentToolCallId === TOOL_CALL_ID,
    );
    expect(approvalIndex).toBe(toolIndex + 1);
    expect(subagentIndex).toBe(toolIndex + 2);
  });

  it('keeps the pending card request when a resolution upsert omits it', () => {
    const pendingSnapshot = applyOpsToSnapshot(userTurnSnapshot({ streaming: true }), [
      {
        op: 'interaction.upsert',
        interaction: {
          interactionId: 'apr-resolve',
          interactionKind: 'approval',
          toolCallId: TOOL_CALL_ID,
          state: 'pending',
          request: { turnId: 1, toolName: 'grok__bash', action: 'Run shell command' },
        },
      },
    ]);
    const pending = projectAgentTranscriptView(createViewState('session_test'), 'main', pendingSnapshot);
    // Mirror of the wire: a terminal interaction.upsert carries only the
    // resolution, not the request (the store replaces the record wholesale).
    const resolvedSnapshot = applyOpsToSnapshot(pendingSnapshot, [
      {
        op: 'interaction.upsert',
        interaction: {
          interactionId: 'apr-resolve',
          interactionKind: 'approval',
          toolCallId: TOOL_CALL_ID,
          state: 'approved',
          response: { decision: 'approved', resolvedAt: FIXED_AT_2 },
        },
      },
    ]);
    const resolved = projectAgentTranscriptView(pending, 'main', resolvedSnapshot);
    const block = resolved.blocks.find((candidate) => candidate.id === 'approval-apr-resolve');
    expect(block).toMatchObject({
      kind: 'approval',
      request: { tool_name: 'grok__bash', action: 'Run shell command' },
      resolution: { decision: 'approved' },
    });
  });

  it('retains an optimistic queued prompt at its previous structural slot', () => {
    const canonical = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      userTurnSnapshot({ streaming: true }),
    );
    const assistantIndex = canonical.blocks.findIndex((block) => block.kind === 'assistant');
    const pending: UserBlock = {
      kind: 'user',
      id: 'user-um-queued-local',
      text: 'queued while the turn is live',
      createdAt: FIXED_AT_2,
      promptId: 'p-queued-local',
      userMessageId: 'um-queued-local',
      promptStatus: 'queued',
    };
    const previous = {
      ...canonical,
      blocks: [
        ...canonical.blocks.slice(0, assistantIndex),
        pending,
        ...canonical.blocks.slice(assistantIndex),
      ],
    };
    const projected = projectAgentTranscriptView(
      previous,
      'main',
      userTurnSnapshot({ streaming: true }),
    );
    const queuedIndex = projected.blocks.findIndex((block) => block.id === pending.id);
    const nextAssistantIndex = projected.blocks.findIndex((block) => block.kind === 'assistant');
    expect(queuedIndex).toBeGreaterThanOrEqual(0);
    expect(queuedIndex).toBeLessThan(nextAssistantIndex);
    expect(queuedIndex).not.toBe(projected.blocks.length - 1);
  });

  it('projects one operation identity and state without labeling pending switches as completed', () => {
    const pending = { operationId: 'switch-example', agentId: 'main', fromModel: 'example/old', toModel: 'example/new', mode: 'fresh', state: 'pending' };
    const journal = [{ type: 'prompt.model_switch_queued', entry: { receipt: pending }, queueIndex: 0, time: 1000 }];
    const queued = projectAgentTranscriptView(createViewState('session_test'), 'main', replayAgentWire('main', journal));
    expect(queued.blocks).toEqual([expect.objectContaining({ kind: 'notice', id: 'agent-marker-model-switch:switch-example',
      modelSwitch: { operationId: 'switch-example', from: 'example/old', to: 'example/new', mode: 'fresh', state: 'pending' }, i18n: undefined })]);
    const committedJournal = [...journal,
      { type: 'agent.model_switch', operationId: 'switch-example', fromModel: 'example/old', toModel: 'example/new', mode: 'fresh', newEpoch: 1, summaryGenerated: false, time: 2000 },
    ];
    const preparing = projectAgentTranscriptView(createViewState('session_test'), 'main', replayAgentWire('main', committedJournal));
    expect(preparing.blocks).toEqual([expect.objectContaining({ kind: 'notice', modelSwitch: expect.objectContaining({ state: 'preparing', windowEpoch: 1 }), i18n: undefined })]);
    const completed = projectAgentTranscriptView(createViewState('session_test'), 'main', replayAgentWire('main', [...committedJournal,
      { type: 'prompt.model_switch_status', operationId: 'switch-example', receipt: { ...pending, state: 'completed', windowEpoch: 1, summaryGenerated: false }, time: 3000 },
    ]));
    expect(completed.blocks).toEqual([expect.objectContaining({ kind: 'notice', id: 'agent-marker-model-switch:switch-example',
      modelSwitch: { operationId: 'switch-example', from: 'example/old', to: 'example/new', mode: 'fresh', state: 'completed', windowEpoch: 1, summaryGenerated: false },
      i18n: { key: 'transcript.marker.modelSwitch', params: { from: 'example/old', to: 'example/new' } } })]);
  });

  it('projects model changes to a neutral divider notice with ordered alias parameters', () => {
    const snapshot = replayAgentWire('main', [
      { type: 'profile.bind', modelAlias: 'example/old', time: 1000 },
      { type: 'config.update', modelAlias: 'example/old', thinkingEffort: 'high', time: 2000 },
      { type: 'config.update', modelAlias: 'example/new', time: 3000 },
    ]);
    const projected = projectAgentTranscriptView(createViewState('session_test'), 'main', snapshot);
    expect(projected.blocks).toEqual([expect.objectContaining({
      kind: 'notice', tone: 'neutral', text: 'model.switch', createdAt: new Date(3000).toISOString(),
      i18n: { key: 'transcript.marker.modelSwitch', params: { from: 'example/old', to: 'example/new' } },
    })]);
  });

  it('folds token-accounting goal markers from cold replay without changing canonical history', () => {
    const records = [
      { type: 'goal.create', goalId: 'goal-example', objective: 'Ship', time: 1000 },
      ...Array.from({ length: 12 }, (_, index) => ({ type: 'goal.update', tokensUsed: index + 1, time: 2000 + index })),
    ];
    const snapshot = replayAgentWire('main', records);
    const first = projectAgentTranscriptView(createViewState('session_test'), 'main', snapshot);
    expect(snapshot.items).toHaveLength(13);
    const latest = snapshot.items.at(-1);
    expect(first.blocks).toEqual([expect.objectContaining({
      id: `agent-marker-${latest?.kind === 'marker' ? latest.markerId : ''}`,
      kind: 'notice', text: 'goal', markerRepeatCount: 13, createdAt: new Date(2011).toISOString(),
    })]);
    expect(snapshot.meta.goal?.budgetUsed).toBe(12);
    const reset = projectAgentTranscriptView(first, 'main', snapshot);
    expect(reset.blocks).toEqual(first.blocks);
    const appended = projectAgentTranscriptView(reset, 'main', replayAgentWire('main', [
      ...records, { type: 'goal.update', tokensUsed: 13, time: 3000 },
    ]));
    expect(appended.blocks).toEqual([expect.objectContaining({ markerRepeatCount: 14, createdAt: new Date(3000).toISOString() })]);
  });

  it('folds live marker operations idempotently and recomputes counts when older history arrives', () => {
    const store = new AgentTranscript('main');
    const ops: TranscriptOperation[] = Array.from({ length: 12 }, (_, index) => ({
      op: 'marker.upsert', item: { kind: 'marker', marker: 'goal', markerId: `live-${index}`, at: FIXED_AT },
    }));
    store.apply(ops);
    const first = projectAgentTranscriptView(createViewState('session_test'), 'main', store.snapshot());
    store.apply(ops);
    const duplicate = projectAgentTranscriptView(first, 'main', store.snapshot());
    expect(duplicate.blocks).toEqual([expect.objectContaining({ id: 'agent-marker-live-11', markerRepeatCount: 12 })]);
    const older = emptySnapshot({ items: [
      { kind: 'marker', markerId: 'older-1', marker: 'goal' },
      { kind: 'marker', markerId: 'older-2', marker: 'goal' },
      ...store.snapshot().items,
    ] });
    const prepended = projectAgentTranscriptView(duplicate, 'main', older);
    expect(prepended.blocks).toEqual([expect.objectContaining({ id: 'agent-marker-live-11', markerRepeatCount: 14 })]);
  });

  it.each(['goal', 'skill'])('folds consecutive %s dividers but not across messages, tools or other markers', (marker) => {
    const item = (markerId: string, name = marker) => ({ kind: 'marker' as const, markerId, marker: name, at: FIXED_AT });
    const turn = userTurnSnapshot();
    const blocks = projectAgentTranscriptView(createViewState('session_test'), 'main', emptySnapshot({ items: [
      item('a'), item('b'), ...turn.items, item('c'), item('d'), item('boundary', marker === 'goal' ? 'skill' : 'goal'), item('e'), item('f'),
    ] })).blocks;
    expect(blocks.filter((block) => block.kind === 'notice')).toMatchObject([
      { id: 'agent-marker-b', markerRepeatCount: 2 }, { id: 'agent-marker-d', markerRepeatCount: 2 },
      { id: 'agent-marker-boundary' }, { id: 'agent-marker-f', markerRepeatCount: 2 },
    ]);
    expect(blocks.some((block) => block.kind === 'user')).toBe(true);
    expect(blocks.some((block) => block.kind === 'assistant')).toBe(true);
    const toolTurn = { kind: 'turn' as const, turnId: 't2', ordinal: 2, state: 'completed' as const, origin: { kind: 'user' as const },
      steps: [{ kind: 'step' as const, stepId: 't2.1', turnId: 't2', ordinal: 1, state: 'completed' as const, frames: [{ kind: 'tool' as const, frameId: 'tool-example', toolCallId: 'tc-example', name: 'Read', state: 'done' as const }] }] };
    const withTool = projectAgentTranscriptView(createViewState('session_test'), 'main', emptySnapshot({ items: [item('before'), toolTurn, item('after')] })).blocks;
    expect(withTool.map((block) => block.kind)).toEqual(['notice', 'tool', 'notice']);
    expect(withTool.filter((block) => block.kind === 'notice').every((block) => block.markerRepeatCount === undefined)).toBe(true);
  });

  it('retains distinct marker labels and the latest compaction details', () => {
    const blocks = projectAgentTranscriptView(createViewState('session_test'), 'main', emptySnapshot({ items: [
      { kind: 'marker', markerId: 'm1', marker: 'model.switch', payload: { from: 'example/a', to: 'example/b' } },
      { kind: 'marker', markerId: 'm2', marker: 'model.switch', payload: { from: 'example/b', to: 'example/c' } },
      { kind: 'marker', markerId: 'c1', marker: 'compaction', payload: { reasonCodes: ['notes_missing'] } },
      { kind: 'marker', markerId: 'c2', marker: 'compaction', at: FIXED_AT_2, payload: { reasonCodes: ['tool_error'] } },
    ] })).blocks;
    expect(blocks).toHaveLength(3);
    expect(blocks.at(-1)).toMatchObject({ id: 'agent-marker-c2', createdAt: FIXED_AT_2, reasonCodes: ['tool_error'], markerRepeatCount: 2 });
  });

  it('summarizes skill markers even when their payload contains the full loaded document', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        items: [
          {
            kind: 'marker',
            markerId: 'skill-loaded-1',
            marker: 'skill',
            payload: { text: 'full skill document\n'.repeat(1000) },
            at: FIXED_AT,
          },
        ],
      }),
    );
    expect(projected.blocks).toEqual([
      expect.objectContaining({
        kind: 'notice',
        id: 'agent-marker-skill-loaded-1',
        text: 'skill',
        i18n: { key: 'transcript.marker.skill' },
      }),
    ]);
  });

  it('exposes current agent notes, revision and covered step alongside todos', () => {
    const notesMeta = {
      rev: 3, hash: '1234', writtenTurn: 5, writtenStep: 't5.2',
      coveredMessageId: 'msg-5', windowEpoch: 2,
    };
    const projected = projectAgentTranscriptView(createViewState('session_test'), 'main', emptySnapshot({
      todos: [{ todoId: 'todo', items: [{ title: 'Ship', status: 'in_progress' }], notes: { goal: 'Ship feature', next: 'Run tests' }, notesMeta }],
    }));
    expect(projected).toMatchObject({
      todos: [{ title: 'Ship', status: 'in_progress' }],
      todoNotes: { goal: 'Ship feature', next: 'Run tests' }, todoNotesMeta: notesMeta,
    });
    const cleared = projectAgentTranscriptView(projected, 'main', emptySnapshot());
    expect(cleared.todoNotes).toBeUndefined();
    expect(cleared.todoNotesMeta).toBeUndefined();
  });

  it('names the renewal strategy on compaction markers, including fallbacks', () => {
    const marker = (markerId: string, payload?: Record<string, unknown>) => ({ kind: 'marker' as const, markerId, marker: 'compaction', payload, at: FIXED_AT });
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        items: [
          marker('c-legacy', { summary: 'older record without a strategy' }),
          marker('c-summarize', { strategy: 'summarize', summary: 'the summary text' }),
          marker('c-fresh', { strategy: 'relay' }),
          marker('c-fallback', { strategy: 'summarize', fallbackFrom: 'relay', reasonCodes: ['notes_missing'] }),
          marker('c-rescue', { strategy: 'relay', fallbackFrom: 'summarize' }),
        ],
      }),
    );
    const keys = projected.blocks.map((block) => (block.kind === 'notice' ? block.i18n?.key : undefined));
    expect(keys).toEqual([
      'transcript.marker.compactionSummarize',
      'transcript.marker.compactionFresh',
      'transcript.marker.compactionFallback',
      'transcript.marker.compactionRescue',
    ]);
    expect(projected.blocks[2]).toMatchObject({ reasonCodes: ['notes_missing'] });
    expect(projected.blocks[0]).toMatchObject({ id: 'agent-marker-c-summarize', markerRepeatCount: 2 });
    expect(projected.blocks[0]).not.toHaveProperty('reasonCodes', expect.any(Array));
  });

  it('renders each compaction once, at the durable record, across live and replayed markers', () => {
    const marker = (markerId: string, at: string, payload: Record<string, unknown>) => ({ kind: 'marker' as const, markerId, marker: 'compaction', payload, at });
    const turn = (turnId: string) => ({ kind: 'turn' as const, turnId, ordinal: Number(turnId.slice(1)), steps: [], state: 'completed' as const });
    const durable = (summary: string, time: number) => ({ type: 'context.apply_compaction', summary, strategy: 'summarize', fallbackFrom: 'relay', time });
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        items: [
          turn('t1'),
          marker('wire:v2:r10:compaction', '2026-01-01T00:01:00.000Z', durable('first', 1)),
          turn('t2'),
          marker('live-m1', '2026-01-01T00:02:00.000Z', { phase: 'started', trigger: 'auto' }),
          marker('live-m2', '2026-01-01T00:02:00.001Z', { phase: 'blocked', turnId: 2 }),
          marker('wire:v2:r603:compaction', '2026-01-01T00:02:30.000Z', durable('second', 2)),
          marker('live-m3', '2026-01-01T00:02:30.100Z', { phase: 'completed', result: { summary: 'second' } }),
          marker('wire:v2:r13241:compaction', '2026-01-01T00:02:30.000Z', durable('second', 2)),
          turn('t3'),
          marker('live-m4', '2026-01-01T00:03:00.000Z', { phase: 'started', trigger: 'manual' }),
        ] as never,
      }),
    );
    const notices = projected.blocks
      .filter((block) => block.kind === 'notice')
      .map((block) => [block.id, block.kind === 'notice' ? block.i18n?.key : undefined]);
    expect(notices).toEqual([
      ['agent-marker-wire:v2:r603:compaction', 'transcript.marker.compactionFallback'],
      ['agent-marker-live-m4', 'notice.compacting'],
    ]);
    expect(projected.blocks[0]).toMatchObject({ markerRepeatCount: 2 });
  });

  it('carries external-engine records as executor notes on their turn', () => {
    const marker = (markerId: string, name: string, payload: Record<string, unknown>) => ({ kind: 'marker' as const, markerId, marker: name, payload, at: FIXED_AT });
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        items: [
          marker('d-1', 'executor.degradation', { turnId: 2, kind: 'unknown', value: { updateType: 'thread/rateLimits/updated' } }),
          marker('h-1', 'executor.prompt.delivery', { turnId: 2, origin: 'user', method: 'next_turn_preamble', status: 'queued' }),
          marker('h-bad', 'executor.prompt.delivery', { method: 'teleport', status: 'delivered' }),
          marker('c-1', 'executor.compaction', { turnId: 2, kind: 'compaction', value: { threadId: 'thr' } }),
          marker('x-1', 'executor.diff', { turnId: 2, kind: 'diff', value: '@@ -1 +1 @@\n-a\n+b' }),
        ],
      }),
    );
    const notes = projected.blocks.map((block) => (block.kind === 'notice' ? [block.turnId, block.executor] : undefined));
    expect(notes).toEqual([
      ['t2', { kind: 'unknown', updateType: 'thread/rateLimits/updated' }],
      ['t2', { kind: 'hint', method: 'next_turn_preamble', status: 'queued', origin: 'user' }],
      // An unrecognized delivery shape falls back to a plain marker notice.
      [undefined, undefined],
      ['t2', { kind: 'compaction' }],
      ['t2', { kind: 'diff', diff: '@@ -1 +1 @@\n-a\n+b' }],
    ]);
  });

  it('suppresses the redundant live cron marker and preserves interruption ownership', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        items: [
          {
            kind: 'marker',
            markerId: 'cron-fired-1',
            marker: 'cron.fired',
            payload: { origin: { kind: 'cron_job', jobId: 'nightly' } },
            at: FIXED_AT,
          },
          {
            kind: 'marker',
            markerId: 'turn:7:interruption',
            marker: 'interruption',
            payload: { turnId: 7, reason: 'user_cancelled' },
            at: FIXED_AT_1,
          },
        ],
      }),
    );
    expect(projected.blocks).toEqual([
      expect.objectContaining({
        kind: 'notice',
        id: 'agent-marker-turn:7:interruption',
        createdAt: FIXED_AT_1,
        turnId: 't7',
        i18n: { key: 'transcript.marker.interruption' },
      }),
    ]);
  });

  it('places an inline subagent card after the parent tool with nested child facts', () => {
    const previous = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      userTurnSnapshot({ streaming: true, assistantText: 'delegating' }),
    );
    const withSpawn = applyOpsToSnapshot(userTurnSnapshot({ streaming: true, assistantText: 'delegating' }), spawnChildOps());
    const projected = projectAgentTranscriptView(previous, 'main', withSpawn);
    const toolIndex = projected.blocks.findIndex((block) => block.kind === 'tool' && block.toolCallId === TOOL_CALL_ID);
    const cardIndex = projected.blocks.findIndex((block) => block.kind === 'subagent' && block.subagentId === CHILD_AGENT_ID);
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(cardIndex).toBe(toolIndex + 1);
    expect(projected.blocks[cardIndex]).toMatchObject({
      kind: 'subagent',
      subagentId: CHILD_AGENT_ID,
      description: 'Inspect the protocol',
      parentToolCallId: TOOL_CALL_ID,
    });
  });

  it('fills inline subagent cards from compact snapshot.subagents when live fields are missing', () => {
    const shell = applyTranscriptShell('session_test', {
      as_of_seq: 4,
      epoch: 'e1',
      session,
      messages: { items: [], has_more: false },
      in_flight_turn: null,
      pending_approvals: [],
      pending_questions: [],
      subagents: [
        compactSnapshotSubagent({
          id: CHILD_AGENT_ID,
          agent_id: CHILD_AGENT_ID,
          model: 'provider/kimi-for-coding',
          thinking_effort: 'high',
          tool_call_count: 7,
          label: 'research',
          profile: 'researcher',
          parent_agent_id: 'main',
          parent_tool_call_id: TOOL_CALL_ID,
        }),
      ],
    });
    const withSpawn = applyOpsToSnapshot(userTurnSnapshot({ streaming: true, assistantText: 'delegating' }), spawnChildOps());
    const projected = projectAgentTranscriptView(shell, 'main', withSpawn);
    expect(projected.blocks.find((block) => block.kind === 'subagent' && block.subagentId === CHILD_AGENT_ID)).toMatchObject({
      kind: 'subagent',
      subagentId: CHILD_AGENT_ID,
      model: 'provider/kimi-for-coding',
      thinkingEffort: 'high',
      toolCallCount: 7,
      label: 'research',
    });
  });

  it('does not invent model or tool counts when compact snapshot.subagents omit them', () => {
    const withSpawn = applyOpsToSnapshot(userTurnSnapshot({ streaming: true, assistantText: 'delegating' }), spawnChildOps());
    const previous = { ...createViewState('session_test'), snapshotSubagents: [compactSnapshotSubagent({ id: CHILD_AGENT_ID })] };
    const projected = projectAgentTranscriptView(previous, 'main', withSpawn);
    const card = projected.blocks.find(
      (block): block is SubagentBlock => block.kind === 'subagent' && block.subagentId === CHILD_AGENT_ID,
    );
    expect(card?.model).toBeUndefined();
    expect(card?.thinkingEffort).toBeUndefined();
    expect(card?.toolCallCount).toBe(0);
    expect(card?.toolCallCountKnown).toBe(false);
  });

  it('prefers live card fields over compact snapshot.subagents', () => {
    const live: SubagentBlock = {
      kind: 'subagent',
      id: `subagent-${CHILD_AGENT_ID}`,
      subagentId: CHILD_AGENT_ID,
      parentAgentId: 'main',
      parentToolCallId: TOOL_CALL_ID,
      name: 'live-name',
      model: 'provider/live-model',
      thinkingEffort: 'low',
      status: 'running',
      description: 'live description',
      summary: undefined,
      error: undefined,
      startedAt: FIXED_AT,
      endedAt: undefined,
      toolCallCount: 3,
      transcript: [],
    };
    const overlaid = overlaySnapshotSubagentFields(
      [live],
      [
        compactSnapshotSubagent({
          id: CHILD_AGENT_ID,
          model: 'provider/snapshot-model',
          thinking_effort: 'high',
          tool_call_count: 1,
          label: 'snapshot-label',
        }),
      ],
    );
    expect(overlaid[0]).toMatchObject({
      name: 'live-name',
      model: 'provider/live-model',
      thinkingEffort: 'low',
      toolCallCount: 3,
      label: 'snapshot-label',
    });
  });

  it('projects attachments, steer, shell, turn tail, origin agent, and plan/taskref markers', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      capabilityMatrixSnapshot(),
    );
    const kinds = projected.blocks.map((block) => block.kind);
    expect(projected.blocks.find((block) => block.kind === 'user')?.media).toEqual([
      expect.objectContaining({ name: 'diagram.png' }),
    ]);
    expect(kinds).toContain('shell');
    expect(
      projected.blocks.some((block) => block.kind === 'tool' && block.toolCallId === 'bash-1'),
    ).toBe(false);
    expect(projected.turnTail).toMatchObject({ turnId: 't1', durationMs: 1800, ttftMs: 120 });
    expect(projected.blocks.find((block) => block.kind === 'approval')).toMatchObject({
      originAgentId: CHILD_AGENT_ID,
    });
    expect(kinds).toContain('notice');
    expect(projected.blocks.some((block) => block.id.includes('plan-1'))).toBe(true);
    expect(projected.blocks.some((block) => block.kind === 'subagent' && block.subagentId === CHILD_AGENT_ID)).toBe(
      true,
    );
    expect(projected.blocks.some((block) => block.id.includes(`ref-${CHILD_AGENT_ID}`))).toBe(false);
    expect(projected.planMode).toBe(true);
  });

  it('does not render a second user bubble for a prompt echo with the same message id', () => {
    const projected = projectAgentTranscriptView(createViewState('session_test'), 'main', {
      items: [
        {
          kind: 'turn',
          turnId: 't1',
          ordinal: 1,
          state: 'completed',
          origin: { kind: 'user' },
          prompt: '注意不能一次并发过多…',
          message: {
            messageId: 'msg_01M0KR389HMPV4350ZWVBTZ0YF',
            role: 'user',
            revision: 0,
            provenance: { source: 'engine' },
          },
          startedAt: FIXED_AT,
          steps: [
            {
              kind: 'step',
              stepId: 't1.1',
              turnId: 't1',
              ordinal: 1,
              state: 'completed',
              frames: [
                {
                  kind: 'text',
                  frameId: 'echo-1',
                  role: 'user',
                  text: '注意不能一次并发过多…',
                  part: {
                    partId: 'echo-1',
                    messageId: 'msg_01M0KR389HMPV4350ZWVBTZ0YF',
                    revision: 0,
                    provenance: { source: 'engine' },
                  },
                },
                {
                  kind: 'text',
                  frameId: 'asst-1',
                  role: 'assistant',
                  text: 'ok',
                },
              ],
            },
          ],
        },
      ],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      meta: {},
    });
    const users = projected.blocks.filter((block) => block.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      text: '注意不能一次并发过多…',
      userMessageId: 'msg_01M0KR389HMPV4350ZWVBTZ0YF',
    });
  });

  it('keeps identical prompt text separate when the prompt identities differ', () => {
    const turn = (ordinal: number, messageId: string) => ({
      kind: 'turn' as const,
      turnId: `t${ordinal}`,
      ordinal,
      state: 'completed' as const,
      origin: { kind: 'user' as const },
      prompt: 'same prompt',
      message: {
        messageId,
        role: 'user' as const,
        revision: 0,
        provenance: { source: 'engine' as const },
      },
      startedAt: FIXED_AT,
      steps: [],
    });
    const projected = projectAgentTranscriptView(createViewState('session_test'), 'main', {
      items: [turn(0, 'prompt-1'), turn(1, 'prompt-2')],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      meta: {},
    });

    expect(projected.blocks.filter((block) => block.kind === 'user')).toMatchObject([
      { id: 'user-prompt-1', userMessageId: 'prompt-1', text: 'same prompt' },
      { id: 'user-prompt-2', userMessageId: 'prompt-2', text: 'same prompt' },
    ]);
  });

  it('keeps a user frame as the only body when the legacy turn prompt is missing', () => {
    const projected = projectAgentTranscriptView(createViewState('session_test'), 'main', {
      items: [
        {
          kind: 'turn',
          turnId: 't-legacy',
          ordinal: 1,
          state: 'completed',
          origin: { kind: 'user' },
          message: {
            messageId: 'msg-legacy-user',
            role: 'user',
            revision: 0,
            provenance: { source: 'engine' },
          },
          startedAt: FIXED_AT,
          steps: [
            {
              kind: 'step',
              stepId: 't-legacy.1',
              turnId: 't-legacy',
              ordinal: 1,
              state: 'completed',
              frames: [
                {
                  kind: 'text',
                  frameId: 'legacy-user-frame',
                  role: 'user',
                  text: 'Only the legacy user frame has this body.',
                  part: {
                    partId: 'legacy-user-frame',
                    messageId: 'msg-legacy-user',
                    revision: 0,
                    provenance: { source: 'engine' },
                  },
                },
              ],
            },
          ],
        },
      ],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      meta: {},
    });
    expect(projected.blocks.filter((block) => block.kind === 'user')).toEqual([
      expect.objectContaining({
        text: 'Only the legacy user frame has this body.',
        userMessageId: 'msg-legacy-user',
      }),
    ]);
  });

  it('keeps canonical tool and shell identities without changing card or locator ids', () => {
    const projected = projectAgentTranscriptView(createViewState('session_test'), 'main', {
      items: [{ kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' }, steps: [
        { kind: 'step', stepId: 's1', turnId: 't1', ordinal: 1, state: 'completed', frames: [
          { kind: 'tool', frameId: 'read-frame', toolCallId: 'read-call', name: 'Read', state: 'done', output: 'read output' },
          { kind: 'tool', frameId: 'bash-task-frame', toolCallId: 'bash-task-call', name: 'Bash', state: 'done', taskId: 'shell-task', input: { command: 'echo fixture' }, output: 'frame output' },
          { kind: 'tool', frameId: 'bash-frame', toolCallId: 'bash-call', name: 'Bash', state: 'done', input: { command: 'echo fixture' }, output: 'frame-only output' },
        ] },
      ] }, { kind: 'taskref', refId: 'task-ref', taskId: 'standalone-shell' }],
      tasks: [
        { taskId: 'shell-task', kind: 'shell', state: 'completed', detached: false, outputTail: 'task output' },
        { taskId: 'standalone-shell', kind: 'shell', state: 'completed', detached: true, outputTail: 'standalone output' },
      ], interactions: [], attachments: [], todos: [], prompts: [], meta: {},
    });
    expect(projected.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool', id: 'tool-read-call', toolCallId: 'read-call', frameId: 'read-frame', stepId: 's1', turnId: 't1', output: 'read output' }),
      expect.objectContaining({ kind: 'shell', id: 'shell-bash-task-call', commandId: 'bash-task-call', frameId: 'bash-task-frame', stepId: 's1', turnId: 't1', outputTaskId: 'shell-task', output: 'task output' }),
      expect.objectContaining({ kind: 'shell', id: 'shell-bash-call', commandId: 'bash-call', frameId: 'bash-frame', stepId: 's1', turnId: 't1', outputTaskId: undefined, output: 'frame-only output' }),
      expect.objectContaining({ kind: 'shell', id: 'shell-standalone-shell', commandId: 'standalone-shell', outputTaskId: 'standalone-shell', output: 'standalone output' }),
    ]));
    const taskOnly = projected.blocks.find((block) => block.id === 'shell-standalone-shell');
    expect(taskOnly).not.toHaveProperty('frameId');
    expect(taskOnly).not.toHaveProperty('stepId');
  });

  it('projects a shell taskref as a shell card instead of a bare task id', () => {
    const projected = projectAgentTranscriptView(createViewState('session_test'), 'main', {
      items: [
        {
          kind: 'taskref',
          refId: 'ref-bash-1',
          taskId: 'bash-xxxxxxxx',
          at: FIXED_AT,
        },
      ],
      tasks: [
        {
          taskId: 'bash-xxxxxxxx',
          kind: 'shell',
          state: 'completed',
          detached: true,
          description: '$ sleep 2',
          outputTail: 'done',
          startedAt: FIXED_AT,
          endedAt: FIXED_AT_1,
        },
      ],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      meta: {},
    });
    expect(projected.blocks).toEqual([
      expect.objectContaining({
        kind: 'shell',
        id: 'shell-bash-xxxxxxxx',
        commandId: 'bash-xxxxxxxx',
        output: 'done',
        done: true,
        isError: false,
      }),
    ]);
  });

  it('keeps the settled user bubble when a regenerate reset drops the turn prompt', () => {
    const previous = projectAgentTranscriptView(createViewState('session_test'), 'main', {
      items: [
        {
          kind: 'turn',
          turnId: 't1',
          ordinal: 1,
          state: 'completed',
          origin: { kind: 'user', payload: { promptId: 'p-edit', userMessageId: 'um-anchor' } },
          prompt: 'First fixture question — edited resend.',
          startedAt: FIXED_AT,
          steps: [
            {
              kind: 'step',
              stepId: 't1.1',
              turnId: 't1',
              ordinal: 1,
              state: 'completed',
              frames: [{ kind: 'text', frameId: 'asst-t1', role: 'assistant', text: 'EDITED-REPLY' }],
            },
          ],
        },
      ],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [
        {
          promptId: 'p-edit',
          status: 'completed',
          userMessageId: 'um-anchor',
          content: [{ type: 'text', text: 'First fixture question — edited resend.' }],
          createdAt: FIXED_AT,
        },
      ],
      meta: {},
    });
    const regenerating = projectAgentTranscriptView(previous, 'main', {
      items: [
        {
          kind: 'turn',
          turnId: 't1',
          ordinal: 1,
          state: 'completed',
          origin: { kind: 'user', payload: { promptId: 'p-regen', userMessageId: 'um-anchor' } },
          startedAt: FIXED_AT,
          endedAt: FIXED_AT_1,
          steps: [
            {
              kind: 'step',
              stepId: 't1.1',
              turnId: 't1',
              ordinal: 1,
              state: 'completed',
              frames: [{ kind: 'text', frameId: 'asst-t1', role: 'assistant', text: 'REGENERATED-REPLY' }],
            },
          ],
        },
      ],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [
        {
          promptId: 'p-regen',
          status: 'running',
          userMessageId: 'um-anchor',
          content: [{ type: 'text', text: 'First fixture question — edited resend.' }],
          createdAt: FIXED_AT_1,
        },
      ],
      meta: {},
    });
    const users = regenerating.blocks.filter((block) => block.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: 'user-um-anchor',
      text: 'First fixture question — edited resend.',
      userMessageId: 'um-anchor',
      promptStatus: undefined,
    });
  });


  it('preserves unchanged block identities across streaming projections', () => {
    const snapshot = (tail: string): AgentTranscriptSnapshot => ({
      items: [
        {
          kind: 'turn',
          turnId: 't1',
          ordinal: 1,
          state: 'completed',
          origin: { kind: 'user' },
          prompt: 'settled prompt',
          startedAt: FIXED_AT,
          steps: [
            {
              kind: 'step',
              stepId: 't1.1',
              turnId: 't1',
              ordinal: 1,
              state: 'completed',
              frames: [
                { kind: 'text', frameId: 'f-settled', role: 'assistant', text: 'settled answer' },
              ],
            },
          ],
        },
        {
          kind: 'turn',
          turnId: 't2',
          ordinal: 2,
          state: 'running',
          origin: { kind: 'user' },
          prompt: 'live prompt',
          startedAt: FIXED_AT_2,
          steps: [
            {
              kind: 'step',
              stepId: 't2.1',
              turnId: 't2',
              ordinal: 1,
              state: 'running',
              frames: [{ kind: 'text', frameId: 'f-live', role: 'assistant', text: tail }],
            },
          ],
        },
      ],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      meta: {},
      hasMoreOlder: false,
    });
    const first = projectAgentTranscriptView(createViewState('session_test'), 'main', snapshot('a'));
    const second = projectAgentTranscriptView(first, 'main', snapshot('ab'));

    for (let index = 0; index < first.blocks.length - 1; index += 1) {
      expect(second.blocks[index]).toBe(first.blocks[index]);
    }
    expect(second.blocks.at(-1)).not.toBe(first.blocks.at(-1));
    expect(second.blocks.at(-1)).toMatchObject({ kind: 'assistant', text: 'ab' });
    expect(projectAgentTranscriptView(second, 'main', snapshot('ab')).blocks).toBe(second.blocks);
  });

  it('reuses settled turn block objects across streaming projection refreshes', () => {
    const snapshot = userTurnSnapshot();
    const first = projectAgentTranscriptView(createViewState('session_test'), 'main', snapshot);
    const firstAssistant = first.blocks.find((block) => block.kind === 'assistant');

    const second = projectAgentTranscriptView(first, 'main', snapshot);
    const secondAssistant = second.blocks.find((block) => block.kind === 'assistant');

    expect(firstAssistant).toBeDefined();
    expect(secondAssistant).toBe(firstAssistant);
  });

  it('places a tool-anchored interaction inline instead of at the transcript bottom', () => {
    const source = capabilityMatrixSnapshot();
    const projected = projectAgentTranscriptView(createViewState('session_test'), 'main', {
      ...source,
      interactions: [
        {
          interactionId: 'apr-bash',
          interactionKind: 'approval',
          toolCallId: 'bash-1',
          anchor: { kind: 'tool_call', toolCallId: 'bash-1' },
          state: 'pending',
          request: {
            turnId: 1,
            toolCallId: 'bash-1',
            toolName: 'Bash',
            action: 'Run ls',
            createdAt: FIXED_AT_1,
          },
        },
      ],
    });
    const shellIndex = projected.blocks.findIndex(
      (block) => block.kind === 'shell' && block.commandId === 'bash-1',
    );
    const approvalIndex = projected.blocks.findIndex((block) => block.id === 'approval-apr-bash');
    expect(shellIndex).toBeGreaterThanOrEqual(0);
    expect(approvalIndex).toBe(shellIndex + 1);
  });

  it('keeps an optimistic queued prompt at its previous timeline position during reconciliation', () => {
    const snapshot = userTurnSnapshot();
    const projected = projectAgentTranscriptView(createViewState('session_test'), 'main', snapshot);
    const assistantIndex = projected.blocks.findIndex((block) => block.kind === 'assistant');
    const queued: UserBlock = {
      kind: 'user',
      id: 'user-um-queued-local',
      text: 'queued while the turn is active',
      createdAt: FIXED_AT_1,
      promptId: 'p-queued-local',
      userMessageId: 'um-queued-local',
      promptStatus: 'queued',
    };
    const previous = {
      ...projected,
      blocks: [
        ...projected.blocks.slice(0, assistantIndex),
        queued,
        ...projected.blocks.slice(assistantIndex),
      ],
    };
    const reconciled = projectAgentTranscriptView(previous, 'main', snapshot);
    const queuedIndex = reconciled.blocks.findIndex((block) => block.id === queued.id);
    const nextAssistantIndex = reconciled.blocks.findIndex((block) => block.kind === 'assistant');
    expect(queuedIndex).toBe(nextAssistantIndex - 1);
  });

  it('uses a late taskref timestamp to place a subagent before a later turn', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'first',
            startedAt: '2026-01-01T00:00:00.000Z',
            endedAt: '2026-01-01T00:00:02.000Z',
            steps: [
              {
                kind: 'step',
                stepId: 't1.1',
                turnId: 't1',
                ordinal: 1,
                state: 'completed',
                endedAt: '2026-01-01T00:00:02.000Z',
                frames: [{ kind: 'text', frameId: 'a1', role: 'assistant', text: 'first answer' }],
              },
            ],
          },
          {
            kind: 'turn',
            turnId: 't2',
            ordinal: 2,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'second',
            startedAt: '2026-01-01T00:00:10.000Z',
            endedAt: '2026-01-01T00:00:12.000Z',
            steps: [],
          },
          {
            kind: 'taskref',
            refId: 'ref-orphan',
            taskId: 'task-orphan',
            at: '2026-01-01T00:00:05.000Z',
          },
        ],
        tasks: [
          {
            taskId: 'task-orphan',
            kind: 'subagent',
            state: 'completed',
            detached: false,
            agentId: 'agent-orphan',
            description: 'between turns',
            outputTail: 'done',
            endedAt: '2026-01-01T00:00:06.000Z',
          },
        ],
      }),
    );
    const subagentIndex = projected.blocks.findIndex((block) => block.id === 'subagent-agent-orphan');
    const secondTurnIndex = projected.blocks.findIndex(
      (block) => block.kind === 'user' && block.turnId === 't2',
    );
    expect(subagentIndex).toBeGreaterThanOrEqual(0);
    expect(subagentIndex).toBeLessThan(secondTurnIndex);
  });

  it('does not append page-global subagent tasks whose taskref and parent frame are outside the page', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        items: [
          {
            kind: 'turn',
            turnId: 't2',
            ordinal: 2,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'visible page',
            startedAt: FIXED_AT_2,
            steps: [],
          },
        ],
        tasks: [
          {
            taskId: 'task-outside-page',
            kind: 'subagent',
            state: 'completed',
            detached: false,
            agentId: 'agent-outside-page',
            description: 'belongs to an older page',
            outputTail: 'done',
            startedAt: FIXED_AT,
          },
        ],
      }),
    );

    expect(projected.blocks.some((block) => block.id === 'subagent-agent-outside-page')).toBe(false);
  });

  describe('subagent lifecycle event blocks', () => {
    it('emits in-place spawned and terminal compact entries for a taskref-backed subagent', () => {
      const projected = projectAgentTranscriptView(
        createViewState('session_test'),
        'main',
        emptySnapshot({
          items: [
            {
              kind: 'turn',
              turnId: 't1',
              ordinal: 1,
              state: 'completed',
              origin: { kind: 'user' },
              prompt: 'delegate',
              startedAt: '2026-01-01T00:00:00.000Z',
              steps: [
                {
                  kind: 'step',
                  stepId: 't1.1',
                  turnId: 't1',
                  ordinal: 1,
                  state: 'completed',
                  startedAt: '2026-01-01T00:00:01.000Z',
                  frames: [
                    {
                      kind: 'tool',
                      frameId: 'frame-spawn',
                      toolCallId: 'call-spawn-1',
                      name: 'AgentRun',
                      state: 'done',
                      input: { profile: 'Researcher', prompt: 'map the surface' },
                      agentRefs: [{ agentId: 'agent-1', role: 'child' }],
                      startedAt: '2026-01-01T00:00:01.000Z',
                    },
                  ],
                },
              ],
            },
            {
              kind: 'taskref',
              refId: 'ref-agent-1',
              taskId: 'task-agent-1',
              at: '2026-01-01T00:00:01.000Z',
            },
            {
              kind: 'turn',
              turnId: 't2',
              ordinal: 2,
              state: 'completed',
              origin: { kind: 'user' },
              prompt: 'meanwhile',
              startedAt: '2026-01-01T00:00:10.000Z',
              steps: [],
            },
          ],
          tasks: [
            {
              taskId: 'task-agent-1',
              kind: 'subagent',
              state: 'completed',
              detached: false,
              subagentName: 'Researcher',
              agentId: 'agent-1',
              description: 'map the surface',
              outputTail: '',
              startedAt: '2026-01-01T00:00:01.000Z',
              endedAt: '2026-01-01T00:00:20.000Z',
              resultSummary: 'Surface mapped.',
            },
          ],
        }),
      );
      const spawned = projected.blocks.find(
        (block) => block.id === 'subagent-event-agent-1-spawned-task-agent-1',
      );
      const terminal = projected.blocks.find(
        (block) => block.id === 'subagent-event-agent-1-completed-task-agent-1',
      );
      expect(spawned).toMatchObject({
        kind: 'subagent-event',
        subagentId: 'agent-1',
        name: 'Researcher',
        event: 'spawned',
        status: 'completed',
        at: '2026-01-01T00:00:01.000Z',
      });
      expect(terminal).toMatchObject({
        kind: 'subagent-event',
        subagentId: 'agent-1',
        event: 'completed',
        at: '2026-01-01T00:00:20.000Z',
      });
      // In-place accounting: spawned lands before the intervening turn, the
      // terminal entry lands after it (its own end timestamp).
      const t2Index = projected.blocks.findIndex(
        (block) => block.kind === 'user' && block.turnId === 't2',
      );
      expect(projected.blocks.indexOf(spawned!)).toBeLessThan(t2Index);
      expect(projected.blocks.indexOf(terminal!)).toBeGreaterThan(t2Index);
    });

    it('emits send-injection and resume entries from parent tool frames', () => {
      const projected = projectAgentTranscriptView(
        createViewState('session_test'),
        'main',
        emptySnapshot({
          items: [
            {
              kind: 'turn',
              turnId: 't1',
              ordinal: 1,
              state: 'completed',
              origin: { kind: 'user' },
              prompt: 'delegate',
              startedAt: '2026-01-01T00:00:00.000Z',
              steps: [
                {
                  kind: 'step',
                  stepId: 't1.1',
                  turnId: 't1',
                  ordinal: 1,
                  state: 'completed',
                  startedAt: '2026-01-01T00:00:01.000Z',
                  frames: [
                    {
                      kind: 'tool',
                      frameId: 'frame-spawn',
                      toolCallId: 'call-spawn-1',
                      name: 'AgentRun',
                      state: 'done',
                      input: { profile: 'Researcher', prompt: 'map the surface' },
                      agentRefs: [{ agentId: 'agent-1', role: 'child' }],
                      startedAt: '2026-01-01T00:00:01.000Z',
                    },
                    {
                      kind: 'tool',
                      frameId: 'frame-send',
                      toolCallId: 'call-send-1',
                      name: 'AgentSend',
                      state: 'done',
                      input: { target: 'agent-1', message: 'also check the wire envelope' },
                      output: JSON.stringify({ status: 'queued' }),
                      startedAt: '2026-01-01T00:00:03.000Z',
                    },
                    {
                      kind: 'tool',
                      frameId: 'frame-resume',
                      toolCallId: 'call-resume-1',
                      name: 'AgentRun',
                      state: 'done',
                      input: { resume_agent_ids: { 'agent-1': 'keep going' } },
                      startedAt: '2026-01-01T00:00:05.000Z',
                    },
                    {
                      kind: 'tool',
                      frameId: 'frame-stray-send',
                      toolCallId: 'call-send-stray',
                      name: 'AgentSend',
                      state: 'done',
                      input: { target: 'nobody-known', message: 'hi' },
                      startedAt: '2026-01-01T00:00:06.000Z',
                    },
                  ],
                },
              ],
            },
          ],
          tasks: [
            {
              taskId: 'task-agent-1',
              kind: 'subagent',
              state: 'running',
              detached: false,
              subagentName: 'Researcher',
              agentId: 'agent-1',
              description: 'map the surface',
              outputTail: '',
              startedAt: '2026-01-01T00:00:01.000Z',
            },
          ],
        }),
      );
      const sent = projected.blocks.find(
        (block) => block.kind === 'subagent-event' && block.event === 'sent',
      );
      const resumed = projected.blocks.find(
        (block) => block.kind === 'subagent-event' && block.event === 'resumed',
      );
      for (const id of ['tool-call-send-1', 'tool-call-resume-1']) {
        expect(projected.blocks.find((block) => block.id === id)).toMatchObject({
          agentRefs: [{ agentId: 'agent-1' }],
        });
      }
      expect(sent).toMatchObject({
        id: 'subagent-event-agent-1-send-call-send-1',
        subagentId: 'agent-1',
        at: '2026-01-01T00:00:03.000Z',
        turnId: 't1',
        message: 'also check the wire envelope',
        delivery: 'queued',
      });
      expect(resumed).toMatchObject({
        id: 'subagent-event-agent-1-resume-call-resume-1',
        subagentId: 'agent-1',
        at: '2026-01-01T00:00:05.000Z',
      });
      // Unknown send targets produce no entry; a running agent has no terminal entry.
      expect(
        projected.blocks.some(
          (block) => block.kind === 'subagent-event' && block.id.includes('call-send-stray'),
        ),
      ).toBe(false);
      expect(
        projected.blocks.some(
          (block) => block.kind === 'subagent-event' && block.event === 'completed',
        ),
      ).toBe(false);
    });

    it('anchors sent/resumed entries after their triggering tool block without splitting the tool fold', () => {
      const projected = projectAgentTranscriptView(
        createViewState('session_test'),
        'main',
        emptySnapshot({
          items: [
            {
              kind: 'turn',
              turnId: 't1',
              ordinal: 1,
              state: 'completed',
              origin: { kind: 'user' },
              prompt: 'delegate',
              startedAt: '2026-01-01T00:00:00.000Z',
              steps: [
                {
                  kind: 'step',
                  stepId: 't1.1',
                  turnId: 't1',
                  ordinal: 1,
                  state: 'completed',
                  startedAt: '2026-01-01T00:00:01.000Z',
                  frames: [
                    {
                      kind: 'tool',
                      frameId: 'frame-read',
                      toolCallId: 'call-read-1',
                      name: 'Read',
                      state: 'done',
                      input: { file_path: 'a.ts' },
                      startedAt: '2026-01-01T00:00:01.000Z',
                    },
                    {
                      kind: 'tool',
                      frameId: 'frame-edit',
                      toolCallId: 'call-edit-1',
                      name: 'Edit',
                      state: 'done',
                      input: { file_path: 'a.ts' },
                      startedAt: '2026-01-01T00:00:02.000Z',
                    },
                    {
                      kind: 'tool',
                      frameId: 'frame-spawn-1',
                      toolCallId: 'call-spawn-1',
                      name: 'AgentRun',
                      state: 'done',
                      input: { profile: 'Researcher', prompt: 'map the surface' },
                      agentRefs: [{ agentId: 'agent-1', role: 'child' }],
                      startedAt: '2026-01-01T00:00:03.000Z',
                    },
                    {
                      kind: 'tool',
                      frameId: 'frame-spawn-2',
                      toolCallId: 'call-spawn-2',
                      name: 'AgentRun',
                      state: 'done',
                      input: { profile: 'Scout', prompt: 'probe the edges' },
                      agentRefs: [{ agentId: 'agent-2', role: 'child' }],
                      startedAt: '2026-01-01T00:00:04.000Z',
                    },
                    {
                      kind: 'tool',
                      frameId: 'frame-send',
                      toolCallId: 'call-send-1',
                      name: 'AgentSend',
                      state: 'done',
                      input: { target: 'agent-1', message: 'also check the wire envelope' },
                      startedAt: '2026-01-01T00:00:05.000Z',
                    },
                    {
                      kind: 'tool',
                      frameId: 'frame-resume',
                      toolCallId: 'call-resume-1',
                      name: 'AgentRun',
                      state: 'done',
                      input: { resume_agent_ids: { 'agent-1': 'keep going', 'agent-2': 'you too' } },
                      startedAt: '2026-01-01T00:00:06.000Z',
                    },
                  ],
                },
              ],
            },
          ],
          tasks: [],
        }),
      );
      const indexOf = (id: string) => projected.blocks.findIndex((block) => block.id === id);
      // Causality: each lifecycle entry follows the tool call that caused it,
      // never leads it (the timeline id tiebreak orders `subagent-event-…`
      // before `tool-…` at equal timestamps).
      const sendTool = indexOf('tool-call-send-1');
      const resumeTool = indexOf('tool-call-resume-1');
      expect(sendTool).toBeGreaterThanOrEqual(0);
      expect(resumeTool).toBeGreaterThanOrEqual(0);
      expect(indexOf('subagent-event-agent-1-send-call-send-1')).toBe(sendTool + 1);
      // One tool deriving several entries keeps their derivation order.
      expect(indexOf('subagent-event-agent-1-resume-call-resume-1')).toBe(resumeTool + 1);
      expect(indexOf('subagent-event-agent-2-resume-call-resume-1')).toBe(resumeTool + 2);
      // Folding is reserved for pure-read runs: an Edit or a dispatch is an
      // action the reader must see, so this run stays unfolded and the
      // anchored entries keep their place right after their own tools.
      const nodes = groupBlocks(projected.blocks);
      expect(nodes.some((node) => node.kind === 'tool-group')).toBe(false);
      expect(nodes).toEqual(projected.blocks);
    });

    it('scopes compact entries to direct children when filtering a page', () => {
      const state = projectAgentTranscriptView(
        createViewState('session_test'),
        'main',
        emptySnapshot({
          items: [
            {
              kind: 'taskref',
              refId: 'ref-agent-1',
              taskId: 'task-agent-1',
              at: '2026-01-01T00:00:01.000Z',
            },
            {
              kind: 'taskref',
              refId: 'ref-agent-2',
              taskId: 'task-agent-2',
              at: '2026-01-01T00:00:02.000Z',
            },
          ],
          tasks: [
            {
              taskId: 'task-agent-1',
              kind: 'subagent',
              state: 'running',
              detached: false,
              agentId: 'agent-1',
              outputTail: '',
            },
            {
              taskId: 'task-agent-2',
              kind: 'subagent',
              state: 'running',
              detached: false,
              agentId: 'agent-2',
              outputTail: '',
            },
          ],
        }),
      );
      const forest = buildAgentForest(
        [],
        [
          { agentId: 'main', name: 'main' },
          { agentId: 'agent-1', parentAgentId: 'main', name: 'Child' },
          { agentId: 'agent-2', parentAgentId: 'agent-1', name: 'Grandchild' },
        ],
      );
      const filtered = filterBlocksToDirectChildren(state.blocks, forest, 'main');
      expect(
        filtered.some((block) => block.kind === 'subagent-event' && block.subagentId === 'agent-1'),
      ).toBe(true);
      expect(
        filtered.some((block) => block.kind === 'subagent-event' && block.subagentId === 'agent-2'),
      ).toBe(false);
      const childFiltered = filterBlocksToDirectChildren(state.blocks, forest, 'agent-1');
      expect(
        childFiltered.some((block) => block.kind === 'subagent-event' && block.subagentId === 'agent-2'),
      ).toBe(true);
    });

    it('keeps per-run history across an AgentRun(resume) re-prompt: spawn → completed → resumed → completed', () => {
      const projected = projectAgentTranscriptView(
        createViewState('session_test'),
        'main',
        emptySnapshot({
          items: [
            {
              kind: 'turn',
              turnId: 't1',
              ordinal: 1,
              state: 'completed',
              origin: { kind: 'user' },
              prompt: 'delegate',
              startedAt: '2026-01-01T00:00:00.000Z',
              steps: [
                {
                  kind: 'step',
                  stepId: 't1.1',
                  turnId: 't1',
                  ordinal: 1,
                  state: 'completed',
                  startedAt: '2026-01-01T00:00:01.000Z',
                  frames: [
                    {
                      kind: 'tool',
                      frameId: 'frame-spawn',
                      toolCallId: 'call-spawn-1',
                      name: 'AgentRun',
                      state: 'done',
                      input: { profile: 'Researcher', prompt: 'map the surface' },
                      agentRefs: [{ agentId: 'agent-1', role: 'child' }],
                      startedAt: '2026-01-01T00:00:01.000Z',
                    },
                  ],
                },
              ],
            },
            {
              kind: 'taskref',
              refId: 'ref-run-1',
              taskId: 'task-agent-1-run-1',
              at: '2026-01-01T00:00:01.000Z',
            },
            {
              kind: 'turn',
              turnId: 't2',
              ordinal: 2,
              state: 'completed',
              origin: { kind: 'user' },
              prompt: 'resume it',
              startedAt: '2026-01-01T00:00:29.000Z',
              steps: [
                {
                  kind: 'step',
                  stepId: 't2.1',
                  turnId: 't2',
                  ordinal: 1,
                  state: 'completed',
                  startedAt: '2026-01-01T00:00:30.000Z',
                  frames: [
                    {
                      kind: 'tool',
                      frameId: 'frame-resume',
                      toolCallId: 'call-resume-1',
                      name: 'AgentRun',
                      state: 'done',
                      // Plain AgentRun resume refs the agent by stable name and
                      // must resolve to the canonical id.
                      input: { resume: 'Researcher', prompt: 'one more pass' },
                      startedAt: '2026-01-01T00:00:30.000Z',
                    },
                  ],
                },
              ],
            },
            {
              kind: 'taskref',
              refId: 'ref-run-2',
              taskId: 'task-agent-1-run-2',
              at: '2026-01-01T00:00:30.000Z',
            },
          ],
          tasks: [
            {
              taskId: 'task-agent-1-run-1',
              kind: 'subagent',
              state: 'completed',
              detached: false,
              name: 'Researcher',
              subagentName: 'Researcher',
              agentId: 'agent-1',
              description: 'map the surface',
              outputTail: '',
              startedAt: '2026-01-01T00:00:01.000Z',
              endedAt: '2026-01-01T00:00:20.000Z',
              resultSummary: 'First pass done.',
            },
            {
              taskId: 'task-agent-1-run-2',
              kind: 'subagent',
              state: 'completed',
              detached: false,
              name: 'Researcher',
              subagentName: 'Researcher',
              agentId: 'agent-1',
              description: 'one more pass',
              outputTail: '',
              startedAt: '2026-01-01T00:00:30.000Z',
              endedAt: '2026-01-01T00:00:45.000Z',
              resultSummary: 'Second pass done.',
            },
          ],
        }),
      );
      const events = projected.blocks.filter((block) => block.kind === 'subagent-event');
      // Exactly four entries: the re-run's taskref must not re-emit a second
      // "spawned", and each run keeps its own terminal entry.
      expect(
        events.map((block) => (block.kind === 'subagent-event' ? block.event : undefined)),
      ).toEqual(['spawned', 'completed', 'resumed', 'completed']);
      expect(events.map((block) => block.id)).toEqual([
        'subagent-event-agent-1-spawned-task-agent-1-run-1',
        'subagent-event-agent-1-completed-task-agent-1-run-1',
        'subagent-event-agent-1-resume-call-resume-1',
        'subagent-event-agent-1-completed-task-agent-1-run-2',
      ]);
      // In-place timeline accounting: entries sit at their own event time.
      expect(events[0]).toMatchObject({ at: '2026-01-01T00:00:01.000Z' });
      expect(events[1]).toMatchObject({ at: '2026-01-01T00:00:20.000Z' });
      expect(events[2]).toMatchObject({ at: '2026-01-01T00:00:30.000Z', turnId: 't2' });
      expect(events[3]).toMatchObject({ at: '2026-01-01T00:00:45.000Z' });
      const t2Index = projected.blocks.findIndex(
        (block) => block.kind === 'user' && block.turnId === 't2',
      );
      expect(projected.blocks.indexOf(events[1]!)).toBeLessThan(t2Index);
      expect(projected.blocks.indexOf(events[2]!)).toBeGreaterThan(t2Index);
    });

    it('uses the latest task state when a foreground task-id run has no taskref', () => {
      const projected = projectAgentTranscriptView(
        createViewState('session_test'),
        'main',
        emptySnapshot({
          items: [
            {
              kind: 'taskref',
              refId: 'ref-background-run',
              taskId: 'task-background-run',
              at: '2026-01-01T00:00:01.000Z',
            },
            {
              kind: 'turn',
              turnId: 't2',
              ordinal: 2,
              state: 'completed',
              origin: { kind: 'user' },
              prompt: 'run it in the foreground',
              startedAt: '2026-01-01T00:00:10.000Z',
              steps: [
                {
                  kind: 'step',
                  stepId: 't2.1',
                  turnId: 't2',
                  ordinal: 1,
                  state: 'completed',
                  frames: [
                    {
                      kind: 'tool',
                      frameId: 'frame-foreground-run',
                      toolCallId: 'call-foreground-run',
                      name: 'AgentRun',
                      state: 'done',
                      input: { resume: 'worker', prompt: 'finish' },
                      agentRefs: [{ agentId: 'agent-1', role: 'child' }],
                      startedAt: '2026-01-01T00:00:11.000Z',
                      endedAt: '2026-01-01T00:00:12.000Z',
                    },
                  ],
                },
              ],
            },
          ],
          tasks: [
            {
              taskId: 'task-background-run',
              kind: 'subagent',
              state: 'running',
              detached: true,
              name: 'worker',
              agentId: 'agent-1',
              description: 'first run',
              outputTail: '',
              startedAt: '2026-01-01T00:00:01.000Z',
            },
            {
              taskId: 'task-foreground-run',
              kind: 'subagent',
              state: 'completed',
              detached: false,
              name: 'worker',
              agentId: 'agent-1',
              description: 'finish',
              outputTail: 'done',
              resultSummary: 'Foreground run completed.',
              startedAt: '2026-01-01T00:00:11.000Z',
              endedAt: '2026-01-01T00:00:20.000Z',
            },
          ],
        }),
      );

      expect(projected.blocks.find((block) => block.id === 'subagent-agent-1')).toMatchObject({
        kind: 'subagent',
        status: 'completed',
        summary: 'Foreground run completed.',
        startedAt: '2026-01-01T00:00:11.000Z',
        endedAt: '2026-01-01T00:00:20.000Z',
      });
    });

    it('addresses resume/send refs by the projected stable name, never tool input labels', () => {
      const spawnFrame = (
        frameId: string,
        toolCallId: string,
        name: string,
        agentId: string,
        startedAt: string,
      ) => ({
        kind: 'tool' as const,
        frameId,
        toolCallId,
        name: 'AgentRun',
        state: 'done' as const,
        input: { profile: 'coder', name, prompt: 'work' },
        agentRefs: [{ agentId, role: 'child' as const }],
        startedAt,
      });
      const projected = projectAgentTranscriptView(
        createViewState('session_test'),
        'main',
        emptySnapshot({
          items: [
            {
              kind: 'turn',
              turnId: 't1',
              ordinal: 1,
              state: 'completed',
              origin: { kind: 'user' },
              prompt: 'delegate',
              startedAt: '2026-01-01T00:00:00.000Z',
              steps: [
                {
                  kind: 'step',
                  stepId: 't1.1',
                  turnId: 't1',
                  ordinal: 1,
                  state: 'completed',
                  startedAt: '2026-01-01T00:00:01.000Z',
                  frames: [
                    spawnFrame('frame-spawn-1', 'call-spawn-1', 'alpha', 'agent-1', '2026-01-01T00:00:01.000Z'),
                    spawnFrame('frame-spawn-2', 'call-spawn-2', 'beta', 'agent-2', '2026-01-01T00:00:02.000Z'),
                    {
                      kind: 'tool',
                      frameId: 'frame-resume',
                      toolCallId: 'call-resume-1',
                      name: 'AgentRun',
                      state: 'done',
                      input: { resume: 'beta', prompt: 'one more pass' },
                      startedAt: '2026-01-01T00:00:05.000Z',
                    },
                    {
                      kind: 'tool',
                      frameId: 'frame-send',
                      toolCallId: 'call-send-1',
                      name: 'AgentSend',
                      state: 'done',
                      input: { target: 'alpha', message: 'ping' },
                      startedAt: '2026-01-01T00:00:06.000Z',
                    },
                  ],
                },
              ],
            },
          ],
          tasks: [
            {
              taskId: 'task-alpha',
              kind: 'subagent',
              state: 'running',
              detached: false,
              name: 'alpha',
              subagentName: 'coder',
              agentId: 'agent-1',
              outputTail: '',
              startedAt: '2026-01-01T00:00:01.000Z',
            },
            {
              taskId: 'task-beta',
              kind: 'subagent',
              state: 'running',
              detached: false,
              name: 'beta',
              subagentName: 'coder',
              agentId: 'agent-2',
              outputTail: '',
              startedAt: '2026-01-01T00:00:02.000Z',
            },
          ],
        }),
      );
      const names = projected.blocks
        .filter((block) => block.kind === 'subagent')
        .map((block) => (block.kind === 'subagent' ? block.name : ''));
      expect(names).toEqual(['alpha', 'beta']);
      const resumed = projected.blocks.find(
        (block) => block.kind === 'subagent-event' && block.event === 'resumed',
      );
      const sent = projected.blocks.find(
        (block) => block.kind === 'subagent-event' && block.event === 'sent',
      );
      expect(resumed).toMatchObject({ subagentId: 'agent-2', at: '2026-01-01T00:00:05.000Z' });
      expect(sent).toMatchObject({ subagentId: 'agent-1', at: '2026-01-01T00:00:06.000Z' });
    });

    it('does not address an anonymous child through its profile fallback', () => {
      const projected = projectAgentTranscriptView(
        createViewState('session_test'),
        'main',
        emptySnapshot({
          items: [
            {
              kind: 'taskref',
              refId: 'ref-named',
              taskId: 'task-named',
              at: '2026-01-01T00:00:01.000Z',
            },
            {
              kind: 'taskref',
              refId: 'ref-anonymous',
              taskId: 'task-anonymous',
              at: '2026-01-01T00:00:02.000Z',
            },
            {
              kind: 'turn',
              turnId: 't1',
              ordinal: 1,
              state: 'completed',
              origin: { kind: 'user' },
              startedAt: '2026-01-01T00:00:03.000Z',
              steps: [
                {
                  kind: 'step',
                  stepId: 't1.1',
                  turnId: 't1',
                  ordinal: 1,
                  state: 'completed',
                  frames: [
                    {
                      kind: 'tool',
                      frameId: 'frame-send-coder',
                      toolCallId: 'call-send-coder',
                      name: 'AgentSend',
                      state: 'done',
                      input: { target: 'coder', message: 'ping' },
                      startedAt: '2026-01-01T00:00:04.000Z',
                    },
                    {
                      kind: 'tool',
                      frameId: 'frame-resume-coder',
                      toolCallId: 'call-resume-coder',
                      name: 'AgentRun',
                      state: 'done',
                      input: { resume: 'coder', prompt: 'continue' },
                      startedAt: '2026-01-01T00:00:05.000Z',
                    },
                  ],
                },
              ],
            },
          ],
          tasks: [
            {
              taskId: 'task-named',
              kind: 'subagent',
              state: 'running',
              detached: false,
              name: 'coder',
              subagentName: 'coder',
              agentId: 'agent-named',
              outputTail: '',
            },
            {
              taskId: 'task-anonymous',
              kind: 'subagent',
              state: 'running',
              detached: false,
              subagentName: 'coder',
              agentId: 'agent-anonymous',
              outputTail: '',
            },
          ],
        }),
      );

      const names = projected.blocks
        .filter((block) => block.kind === 'subagent')
        .map((block) => (block.kind === 'subagent' ? block.name : ''));
      expect(names).toEqual(['coder', 'coder']);
      expect(
        projected.blocks.find(
          (block) => block.kind === 'subagent-event' && block.id.includes('send-coder'),
        ),
      ).toMatchObject({ subagentId: 'agent-named', event: 'sent' });
      expect(
        projected.blocks.find(
          (block) => block.kind === 'subagent-event' && block.id.includes('resume-coder'),
        ),
      ).toMatchObject({ subagentId: 'agent-named', event: 'resumed' });
    });

    it('emits no card or lifecycle events for a roster task whose run never entered the page', () => {
      const projected = projectAgentTranscriptView(
        createViewState('session_test'),
        'main',
        emptySnapshot({
          items: [
            {
              kind: 'turn',
              turnId: 't1',
              ordinal: 1,
              state: 'completed',
              origin: { kind: 'user' },
              prompt: 'just chatting',
              startedAt: '2026-01-01T00:00:30.000Z',
              steps: [],
            },
          ],
          tasks: [
            {
              taskId: 'task-off-page',
              kind: 'subagent',
              state: 'completed',
              detached: false,
              agentId: 'agent-1',
              outputTail: '',
              startedAt: '2026-01-01T00:00:01.000Z',
              endedAt: '2026-01-01T00:00:20.000Z',
              resultSummary: 'done long ago',
            },
          ],
        }),
      );
      expect(projected.blocks.some((block) => block.kind === 'subagent')).toBe(false);
      expect(projected.blocks.some((block) => block.kind === 'subagent-event')).toBe(false);
    });

    it('renders a resume-only page without a fake spawned entry until the older page loads', () => {
      const resumeTurn = {
        kind: 'turn' as const,
        turnId: 't2',
        ordinal: 2,
        state: 'completed' as const,
        origin: { kind: 'user' as const },
        prompt: 'resume it',
        startedAt: '2026-01-01T00:00:29.000Z',
        steps: [
          {
            kind: 'step' as const,
            stepId: 't2.1',
            turnId: 't2',
            ordinal: 1,
            state: 'completed' as const,
            startedAt: '2026-01-01T00:00:30.000Z',
            frames: [
              {
                kind: 'tool' as const,
                frameId: 'frame-resume',
                toolCallId: 'call-resume-1',
                name: 'AgentRun',
                state: 'done' as const,
                input: { resume: 'agent-1', prompt: 'one more pass' },
                startedAt: '2026-01-01T00:00:30.000Z',
              },
            ],
          },
        ],
      };
      const resumeTaskref = {
        kind: 'taskref' as const,
        refId: 'ref-run-2',
        taskId: 'task-agent-1-run-2',
        at: '2026-01-01T00:00:30.000Z',
      };
      const tasks = [
        {
          taskId: 'task-agent-1-run-1',
          kind: 'subagent' as const,
          state: 'completed' as const,
          detached: false,
          agentId: 'agent-1',
          outputTail: '',
          startedAt: '2026-01-01T00:00:01.000Z',
          endedAt: '2026-01-01T00:00:20.000Z',
        },
        {
          taskId: 'task-agent-1-run-2',
          kind: 'subagent' as const,
          state: 'completed' as const,
          detached: false,
          agentId: 'agent-1',
          outputTail: '',
          startedAt: '2026-01-01T00:00:30.000Z',
          endedAt: '2026-01-01T00:00:45.000Z',
        },
      ];
      // Fresh window: only the resume turn + its taskref are in `items`.
      const pageTwo = projectAgentTranscriptView(
        createViewState('session_test'),
        'main',
        emptySnapshot({ items: [resumeTurn, resumeTaskref], tasks }),
      );
      const pageTwoEvents = pageTwo.blocks.filter((block) => block.kind === 'subagent-event');
      expect(pageTwoEvents.map((block) => block.id)).toEqual([
        'subagent-event-agent-1-resume-call-resume-1',
        'subagent-event-agent-1-completed-task-agent-1-run-2',
      ]);

      // After the older page loads, the original run's spawn + terminal appear.
      const olderItems = [
        {
          kind: 'turn' as const,
          turnId: 't1',
          ordinal: 1,
          state: 'completed' as const,
          origin: { kind: 'user' as const },
          prompt: 'delegate',
          startedAt: '2026-01-01T00:00:00.000Z',
          steps: [
            {
              kind: 'step' as const,
              stepId: 't1.1',
              turnId: 't1',
              ordinal: 1,
              state: 'completed' as const,
              startedAt: '2026-01-01T00:00:01.000Z',
              frames: [
                {
                  kind: 'tool' as const,
                  frameId: 'frame-spawn',
                  toolCallId: 'call-spawn-1',
                  name: 'AgentRun',
                  state: 'done' as const,
                  input: { profile: 'Researcher', prompt: 'map the surface' },
                  agentRefs: [{ agentId: 'agent-1', role: 'child' as const }],
                  startedAt: '2026-01-01T00:00:01.000Z',
                },
              ],
            },
          ],
        },
        {
          kind: 'taskref' as const,
          refId: 'ref-run-1',
          taskId: 'task-agent-1-run-1',
          at: '2026-01-01T00:00:01.000Z',
        },
      ];
      const full = projectAgentTranscriptView(
        createViewState('session_test'),
        'main',
        emptySnapshot({ items: [...olderItems, resumeTurn, resumeTaskref], tasks }),
      );
      const fullEvents = full.blocks.filter((block) => block.kind === 'subagent-event');
      expect(fullEvents.map((block) => block.id)).toEqual([
        'subagent-event-agent-1-spawned-task-agent-1-run-1',
        'subagent-event-agent-1-completed-task-agent-1-run-1',
        'subagent-event-agent-1-resume-call-resume-1',
        'subagent-event-agent-1-completed-task-agent-1-run-2',
      ]);
    });

    it('resolves a cold-page AgentSend target from the projected stable name', () => {
      const projected = projectAgentTranscriptView(
        createViewState('session_test'),
        'main',
        emptySnapshot({
          items: [
            {
              kind: 'turn',
              turnId: 't2',
              ordinal: 2,
              state: 'completed',
              origin: { kind: 'user' },
              prompt: 'nudge the child',
              startedAt: '2026-01-01T00:00:30.000Z',
              steps: [
                {
                  kind: 'step',
                  stepId: 't2.1',
                  turnId: 't2',
                  ordinal: 1,
                  state: 'completed',
                  startedAt: '2026-01-01T00:00:31.000Z',
                  frames: [
                    {
                      kind: 'tool',
                      frameId: 'frame-send',
                      toolCallId: 'call-send-1',
                      name: 'AgentSend',
                      state: 'done',
                      input: { target: 'alpha', message: 'ping' },
                      startedAt: '2026-01-01T00:00:31.000Z',
                    },
                  ],
                },
              ],
            },
          ],
          tasks: [
            {
              taskId: 'task-alpha',
              kind: 'subagent',
              state: 'running',
              detached: false,
              name: 'alpha',
              subagentName: 'coder',
              agentId: 'agent-1',
              outputTail: '',
              startedAt: '2026-01-01T00:00:01.000Z',
            },
          ],
        }),
      );
      const sent = projected.blocks.find(
        (block) => block.kind === 'subagent-event' && block.event === 'sent',
      );
      expect(sent).toMatchObject({
        id: 'subagent-event-agent-1-send-call-send-1',
        subagentId: 'agent-1',
        at: '2026-01-01T00:00:31.000Z',
        turnId: 't2',
      });
    });

    it('never crowns a timed resume run as the first spawn when the original run has no clock', () => {
      // Roster order: run-1 first, without startedAt; run-2 timed. The page
      // only carries run-2's taskref — an unknown clock must not demote run-1,
      // so no spawned entry may appear for the resume run.
      const projected = projectAgentTranscriptView(
        createViewState('session_test'),
        'main',
        emptySnapshot({
          items: [
            {
              kind: 'turn',
              turnId: 't2',
              ordinal: 2,
              state: 'completed',
              origin: { kind: 'user' },
              prompt: 'resume it',
              startedAt: '2026-01-01T00:00:29.000Z',
              steps: [],
            },
            {
              kind: 'taskref',
              refId: 'ref-run-2',
              taskId: 'task-agent-1-run-2',
              at: '2026-01-01T00:00:30.000Z',
            },
          ],
          tasks: [
            {
              taskId: 'task-agent-1-run-1',
              kind: 'subagent',
              state: 'completed',
              detached: false,
              agentId: 'agent-1',
              outputTail: '',
              endedAt: '2026-01-01T00:00:20.000Z',
            },
            {
              taskId: 'task-agent-1-run-2',
              kind: 'subagent',
              state: 'completed',
              detached: false,
              agentId: 'agent-1',
              outputTail: '',
              startedAt: '2026-01-01T00:00:30.000Z',
              endedAt: '2026-01-01T00:00:45.000Z',
            },
          ],
        }),
      );
      const events = projected.blocks.filter((block) => block.kind === 'subagent-event');
      expect(events.some((block) => block.kind === 'subagent-event' && block.event === 'spawned')).toBe(false);
      expect(events.map((block) => block.id)).toEqual([
        'subagent-event-agent-1-completed-task-agent-1-run-2',
      ]);
    });
  });

  it('does not invent page-global cards from snapshot.subagents alone', () => {
    const previous = {
      ...createViewState('session_test'),
      snapshotSubagents: [
        compactSnapshotSubagent({
          id: 'agent-outside-page',
          agent_id: 'agent-outside-page',
          model: 'provider/kimi-for-coding',
          tool_call_count: 4,
        }),
      ],
    };
    const projected = projectAgentTranscriptView(
      previous,
      'main',
      emptySnapshot({
        items: [
          {
            kind: 'turn',
            turnId: 't2',
            ordinal: 2,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'visible page',
            startedAt: FIXED_AT_2,
            steps: [],
          },
        ],
      }),
    );
    expect(projected.blocks.some((block) => block.id === 'subagent-agent-outside-page')).toBe(false);
  });

  it('places a late shell taskref by its reading-flow timestamp', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'first',
            startedAt: '2026-01-01T00:00:00.000Z',
            steps: [],
          },
          {
            kind: 'turn',
            turnId: 't2',
            ordinal: 2,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'second',
            startedAt: '2026-01-01T00:00:10.000Z',
            steps: [],
          },
          {
            kind: 'taskref',
            refId: 'ref-shell-late',
            taskId: 'task-shell-late',
            at: '2026-01-01T00:00:05.000Z',
          },
        ],
        tasks: [
          {
            taskId: 'task-shell-late',
            kind: 'shell',
            state: 'completed',
            detached: true,
            description: '$ sleep 2',
            outputTail: 'done',
          },
        ],
      }),
    );
    const shellIndex = projected.blocks.findIndex((block) => block.id === 'shell-task-shell-late');
    const secondTurnIndex = projected.blocks.findIndex(
      (block) => block.kind === 'user' && block.turnId === 't2',
    );
    expect(shellIndex).toBeGreaterThanOrEqual(0);
    expect(shellIndex).toBeLessThan(secondTurnIndex);
  });

  it('does not turn a task description into a missing shell command', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        items: [{ kind: 'taskref', refId: 'ref-shell-missing-command', taskId: 'task-shell-missing-command', at: FIXED_AT }],
        tasks: [
          {
            taskId: 'task-shell-missing-command',
            kind: 'shell',
            state: 'completed',
            detached: true,
            description: '$ description is not a command fact',
            outputTail: '',
          },
        ],
      }),
    );
    const shell = projected.blocks.find((block) => block.kind === 'shell');
    expect(shell).toMatchObject({ output: '', done: true });
    expect(shell?.command).toBeUndefined();
  });

  it('merges a task-backed shell into its command frame and anchors interactions by command id', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'run it',
            startedAt: FIXED_AT,
            steps: [
              {
                kind: 'step',
                stepId: 't1.1',
                turnId: 't1',
                ordinal: 1,
                state: 'completed',
                startedAt: FIXED_AT_1,
                frames: [
                  {
                    kind: 'tool',
                    frameId: 'frame-shell-command',
                    toolCallId: 'command-1',
                    taskId: 'task-shell-command',
                    name: 'Bash',
                    state: 'done',
                    input: { command: 'pwd' },
                    output: 'stale frame output',
                  },
                ],
              },
            ],
          },
          {
            kind: 'taskref',
            refId: 'ref-shell-command',
            taskId: 'task-shell-command',
            at: FIXED_AT_1,
          },
        ],
        tasks: [
          {
            taskId: 'task-shell-command',
            kind: 'shell',
            state: 'completed',
            detached: false,
            outputTail: 'canonical task output',
            startedAt: FIXED_AT_1,
          },
        ],
        interactions: [
          {
            interactionId: 'approval-shell-command',
            interactionKind: 'approval',
            toolCallId: 'command-1',
            state: 'pending',
            request: {
              toolCallId: 'command-1',
              toolName: 'Bash',
              action: 'Run pwd',
              createdAt: FIXED_AT_1,
            },
          },
        ],
      }),
    );
    const shells = projected.blocks.filter((block) => block.kind === 'shell');
    expect(shells).toEqual([
      expect.objectContaining({
        id: 'shell-command-1',
        commandId: 'command-1',
        command: 'pwd',
        output: 'canonical task output',
      }),
    ]);
    const shellIndex = projected.blocks.findIndex((block) => block.id === 'shell-command-1');
    expect(projected.blocks[shellIndex + 1]?.id).toBe('approval-approval-shell-command');
  });

  it('falls back from an empty interaction tool id to its command anchor', () => {
    const source = capabilityMatrixSnapshot();
    const projected = projectAgentTranscriptView(createViewState('session_test'), 'main', {
      ...source,
      interactions: [
        {
          interactionId: 'approval-empty-tool-id',
          interactionKind: 'approval',
          toolCallId: '',
          anchor: { kind: 'tool_call', toolCallId: 'bash-1' },
          state: 'pending',
          request: {
            toolName: 'Bash',
            action: 'Run ls',
            createdAt: FIXED_AT_1,
          },
        },
      ],
    });
    const shellIndex = projected.blocks.findIndex(
      (block) => block.kind === 'shell' && block.commandId === 'bash-1',
    );
    expect(projected.blocks[shellIndex + 1]?.id).toBe('approval-approval-empty-tool-id');
  });

  it('derives busy state from canonical running structures when phase metadata is missing', () => {
    const source = userTurnSnapshot({ streaming: true });
    const projected = projectAgentTranscriptView(createViewState('session_test'), 'main', {
      ...source,
      meta: {},
    });
    expect(projected.busy).toBe(true);
    expect(projected.blocks.find((block) => block.kind === 'assistant')).toMatchObject({
      streaming: true,
    });
  });

  it('removes the queued user block when the prompt is aborted before start', () => {
    const previous = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      userTurnSnapshot({ streaming: true }),
    );
    const queued = applyOpsToSnapshot(userTurnSnapshot({ streaming: true }), [
      {
        op: 'prompt.upsert',
        prompt: {
          promptId: 'p-queued',
          status: 'queued',
          userMessageId: 'um-queued',
          content: [{ type: 'text', text: 'B: cancel me.' }],
          createdAt: '2026-01-01T00:00:03.000Z',
        },
      },
    ]);
    const withQueued = projectAgentTranscriptView(previous, 'main', queued);
    expect(
      withQueued.blocks.some((block) => block.kind === 'user' && block.promptStatus === 'queued' && block.promptId === 'p-queued'),
    ).toBe(true);
    const aborted = applyOpsToSnapshot(queued, [
      {
        op: 'prompt.upsert',
        prompt: {
          promptId: 'p-queued',
          status: 'aborted',
          userMessageId: 'um-queued',
          createdAt: '2026-01-01T00:00:03.000Z',
          abortedBeforeStart: true,
        },
      },
    ]);
    const projected = projectAgentTranscriptView(withQueued, 'main', aborted);
    expect(projected.queuedPromptIds).toEqual([]);
    expect(
      projected.blocks.some((block) => block.kind === 'user' && block.promptId === 'p-queued'),
    ).toBe(false);
    expect(projected.blocks.some((block) => block.id === 'notice-aborted-p-queued')).toBe(false);

    const replayed = projectAgentTranscriptView(createViewState('session_test'), 'main', aborted);
    expect(replayed.blocks.some((block) => block.kind === 'user' && block.promptId === 'p-queued')).toBe(false);
    expect(replayed.blocks.some((block) => block.id === 'notice-aborted-p-queued')).toBe(false);
  });

  it('keeps the settled user bubble and marks it when the matching prompt fails', () => {
    const previous = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      userTurnSnapshot({ streaming: true }),
    );
    const queued = applyOpsToSnapshot(userTurnSnapshot({ streaming: true }), [
      {
        op: 'prompt.upsert',
        prompt: {
          promptId: 'p-queued',
          status: 'queued',
          userMessageId: 'um-queued',
          content: [{ type: 'text', text: 'B: fail me.' }],
          createdAt: '2026-01-01T00:00:03.000Z',
        },
      },
    ]);
    const withQueued = projectAgentTranscriptView(previous, 'main', queued);
    expect(
      withQueued.blocks.some((block) => block.kind === 'user' && block.promptStatus === 'queued' && block.promptId === 'p-queued'),
    ).toBe(true);
    const failed = applyOpsToSnapshot(queued, [
      {
        op: 'prompt.upsert',
        prompt: {
          promptId: 'p-queued',
          status: 'failed',
          userMessageId: 'um-queued',
          createdAt: '2026-01-01T00:00:03.000Z',
        },
      },
    ]);
    const projected = projectAgentTranscriptView(withQueued, 'main', failed);
    expect(
      projected.blocks.some((block) => block.kind === 'user' && block.promptId === 'p-queued' && block.promptStatus === 'queued'),
    ).toBe(false);
    expect(projected.blocks.some((block) => block.kind === 'notice')).toBe(false);
    expect(
      projected.blocks.find((block) => block.kind === 'user' && block.promptId === 'p-queued'),
    ).toMatchObject({ promptOutcome: { status: 'failed', delivered: false } });
    expect(
      projected.blocks.some((block) => block.kind === 'user' && block.promptId === 'p-queued' && block.text === 'B: fail me.'),
    ).toBe(true);
  });

  it('hangs a terminal prompt outcome on its materialized turn bubble', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        items: [
          {
            kind: 'turn',
            turnId: 't9',
            ordinal: 9,
            state: 'failed',
            origin: {
              kind: 'user',
              payload: { promptId: 'p-failed', userMessageId: 'um-failed' },
            },
            prompt: 'fail this turn',
            startedAt: FIXED_AT,
            endedAt: FIXED_AT_1,
            steps: [],
          },
        ],
        prompts: [
          {
            promptId: 'p-failed',
            status: 'failed',
            userMessageId: 'um-failed',
            createdAt: FIXED_AT,
            finishedAt: FIXED_AT_1,
          },
        ],
      }),
    );
    expect(projected.blocks.some((block) => block.kind === 'notice')).toBe(false);
    expect(projected.blocks.find((block) => block.kind === 'user' && block.turnId === 't9')).toMatchObject({
      promptId: 'p-failed',
      promptOutcome: { status: 'failed', at: FIXED_AT_1, delivered: true },
    });
  });

  // Shapes from a real long session: the reset window carries the last turns
  // only, while `prompts` carries every prompt the agent ever ran.
  function windowedFailureSnapshot(extraPrompts: readonly Record<string, unknown>[] = []) {
    const turn = (n: number, state: 'completed' | 'failed', error?: string) => ({
      kind: 'turn' as const,
      turnId: `t${n}`,
      ordinal: n,
      state,
      origin: { kind: 'user' as const, payload: { promptId: `p${n}`, userMessageId: `p${n}` } },
      prompt: `message ${n}`,
      startedAt: `2026-01-02T00:${String(n).padStart(2, '0')}:00.000Z`,
      endedAt: `2026-01-02T00:${String(n).padStart(2, '0')}:30.000Z`,
      error,
      steps: [],
    });
    const prompt = (id: string, status: string, createdAt: string, finishedAt: string, text = `text ${id}`) => ({
      promptId: id,
      userMessageId: id,
      status,
      createdAt,
      finishedAt,
      content: [{ type: 'text', text }],
    });
    return emptySnapshot({
      items: [turn(40, 'completed'), turn(41, 'failed', 'Connection error.'), turn(42, 'completed')],
      hasMoreOlder: true,
      prompts: [
        prompt('p17', 'failed', '2026-01-01T01:00:00.000Z', '2026-01-01T01:04:00.000Z'),
        prompt('p18', 'aborted', '2026-01-01T02:00:00.000Z', '2026-01-01T02:01:00.000Z'),
        prompt('p19', 'failed', '2026-01-01T03:00:00.000Z', '2026-01-01T03:02:00.000Z'),
        prompt('p40', 'completed', '2026-01-02T00:40:00.000Z', '2026-01-02T00:40:30.000Z'),
        prompt('p41', 'failed', '2026-01-02T00:41:00.000Z', '2026-01-02T00:41:30.000Z'),
        prompt('p42', 'completed', '2026-01-02T00:42:00.000Z', '2026-01-02T00:42:30.000Z'),
        ...extraPrompts,
      ] as never,
    });
  }

  it('keeps image captions and system reminders out of earlier failed prompt previews', () => {
    const projected = projectAgentTranscriptView(createViewState('session_test'), 'main', windowedFailureSnapshot([{
      promptId: 'p-old-image', userMessageId: 'um-old-image', status: 'failed',
      createdAt: '2026-01-01T04:00:00.000Z', finishedAt: '2026-01-01T04:01:00.000Z',
      content: [{ type: 'text', text: '<system>Image compressed to fit model limits: original 4500x2800 -> sent 2000x1244.</system>\nReview this.\n<system-reminder>Daemon note.</system-reminder>' }],
    }]));
    const earlier = projected.blocks.find((block) => block.id === EARLIER_PROMPT_OUTCOMES_ID);
    expect(earlier?.kind === 'notice' && earlier.earlierPromptOutcomes?.find((outcome) => outcome.promptId === 'p-old-image')?.text).toBe('Review this.');
  });

  it('merges prompts settled outside the loaded window into one neutral row', () => {
    const projected = projectAgentTranscriptView(createViewState('session_test'), 'main', windowedFailureSnapshot());
    const notices = projected.blocks.filter((block) => block.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      id: EARLIER_PROMPT_OUTCOMES_ID,
      tone: 'neutral',
      i18n: { key: 'notice.earlierPromptOutcomes', params: { count: 3 } },
    });
    expect(notices[0]!.kind === 'notice' && notices[0]!.earlierPromptOutcomes?.map((outcome) => `${outcome.promptId}:${outcome.status}`))
      .toEqual(['p17:failed', 'p18:aborted', 'p19:failed']);
    expect(projected.blocks[0]?.id).toBe(EARLIER_PROMPT_OUTCOMES_ID);
    expect(projected.blocks.some((block) => block.id.startsWith('notice-failed-') || block.id.startsWith('notice-aborted-'))).toBe(false);
  });

  it('marks the in-window failure on its bubble with the turn error', () => {
    const projected = projectAgentTranscriptView(createViewState('session_test'), 'main', windowedFailureSnapshot());
    const users = projected.blocks.filter((block) => block.kind === 'user');
    expect(users.map((block) => block.kind === 'user' && block.promptOutcome?.status)).toEqual([undefined, 'failed', undefined]);
    expect(users[1]).toMatchObject({
      turnId: 't41',
      promptOutcome: { status: 'failed', error: 'Connection error.', delivered: true },
    });
  });

  it('counts a message that failed more than once as one outcome', () => {
    const repeat = [
      { promptId: 'p19-retry', userMessageId: 'p19', status: 'failed', createdAt: '2026-01-01T03:05:00.000Z', finishedAt: '2026-01-01T03:06:00.000Z', content: [{ type: 'text', text: 'text p19' }] },
      { promptId: 'p41-retry', userMessageId: 'p41', status: 'failed', createdAt: '2026-01-02T00:41:40.000Z', finishedAt: '2026-01-02T00:41:50.000Z' },
    ];
    const projected = projectAgentTranscriptView(createViewState('session_test'), 'main', windowedFailureSnapshot(repeat));
    const earlier = projected.blocks.find((block) => block.id === EARLIER_PROMPT_OUTCOMES_ID);
    expect(earlier?.kind === 'notice' && earlier.earlierPromptOutcomes?.map((outcome) => outcome.promptId))
      .toEqual(['p17', 'p18', 'p19-retry']);
    expect(earlier).toMatchObject({ i18n: { params: { count: 3 } } });
    const marked = projected.blocks.filter((block) => block.kind === 'user' && block.promptOutcome !== undefined);
    expect(marked).toHaveLength(1);
  });

  it('clears an earlier failure once the same message completes', () => {
    const recovered = [
      { promptId: 'p17-regen', userMessageId: 'p17', status: 'completed', createdAt: '2026-01-01T01:10:00.000Z', finishedAt: '2026-01-01T01:12:00.000Z' },
    ];
    const projected = projectAgentTranscriptView(createViewState('session_test'), 'main', windowedFailureSnapshot(recovered));
    const earlier = projected.blocks.find((block) => block.id === EARLIER_PROMPT_OUTCOMES_ID);
    expect(earlier?.kind === 'notice' && earlier.earlierPromptOutcomes?.map((outcome) => outcome.promptId))
      .toEqual(['p18', 'p19']);
  });

  it('drops the earlier row when every settled prompt is on the page', () => {
    const snapshot = windowedFailureSnapshot();
    const inWindow = { ...snapshot, prompts: snapshot.prompts.filter((prompt) => !['p17', 'p18', 'p19'].includes(prompt.promptId)) };
    const projected = projectAgentTranscriptView(createViewState('session_test'), 'main', inWindow);
    expect(projected.blocks.some((block) => block.kind === 'notice')).toBe(false);
  });

  it('shows a danger taskref notice with the error for lost and timed_out background tasks', () => {
    for (const state of ['lost', 'timed_out'] as const) {
      const projected = projectAgentTranscriptView(
        createViewState('session_test'),
        'main',
        emptySnapshot({
          items: [{ kind: 'taskref', refId: 'ref-bg-1', taskId: 'task-bg-1', at: FIXED_AT }],
          tasks: [
            {
              taskId: 'task-bg-1',
              kind: 'other',
              state,
              detached: true,
              description: 'background probe',
              outputTail: '',
              error: 'worker quota exhausted',
              startedAt: FIXED_AT,
              endedAt: FIXED_AT_1,
            },
          ],
        }),
      );
      expect(projected.blocks).toEqual([
        expect.objectContaining({
          kind: 'notice',
          id: 'agent-taskref-ref-bg-1',
          tone: 'danger',
          text: 'background probe — worker quota exhausted',
        }),
      ]);
    }
  });

  it('clears a running chip once the matching prompt completes so edit/fork return', () => {
    const previous = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      userTurnSnapshot({ streaming: true }),
    );
    const user = previous.blocks.find((block) => block.kind === 'user') as UserBlock | undefined;
    expect(user?.promptStatus).toBe('running');
    const completed = applyOpsToSnapshot(userTurnSnapshot({ streaming: true }), [
      {
        op: 'prompt.upsert',
        prompt: {
          promptId: PROMPT_ID,
          status: 'completed',
          userMessageId: USER_MESSAGE_ID,
          createdAt: '2026-01-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:00:04.000Z',
        },
      },
    ]);
    const projected = projectAgentTranscriptView(previous, 'main', completed);
    expect(
      projected.blocks.find((block) => block.kind === 'user' && block.userMessageId === USER_MESSAGE_ID),
    ).toMatchObject({ promptStatus: undefined, userMessageId: USER_MESSAGE_ID });
  });

  it('binds journal user identity onto a regenerate turn that only had a prompt string', () => {
    const snapshot = emptySnapshot({
      items: [
        {
          kind: 'turn',
          turnId: 't1',
          ordinal: 1,
          state: 'completed',
          origin: { kind: 'user', payload: { promptId: 'p-regen' } },
          prompt: 'First fixture question — edited resend.',
          startedAt: FIXED_AT,
          endedAt: FIXED_AT_2,
          steps: [
            {
              kind: 'step',
              stepId: 't1.1',
              turnId: 't1',
              ordinal: 1,
              state: 'completed',
              startedAt: FIXED_AT,
              endedAt: FIXED_AT_2,
              frames: [
                {
                  kind: 'text',
                  frameId: 'asst-t1-t1.1',
                  role: 'assistant',
                  text: 'REGENERATED-REPLY replaced the old tail.',
                  part: {
                    partId: 'part-asst',
                    messageId: 'msg-asst',
                    revision: 1,
                    provenance: { source: 'engine' },
                  },
                },
              ],
            },
          ],
        },
      ],
      prompts: [
        {
          promptId: 'p-regen',
          status: 'completed',
          userMessageId: USER_MESSAGE_ID,
          content: [{ type: 'text', text: 'First fixture question — edited resend.' }],
          createdAt: FIXED_AT,
          finishedAt: FIXED_AT_2,
        },
      ],
    });
    const projected = projectAgentTranscriptView(createViewState('session_test'), 'main', snapshot);
    expect(projected.blocks.find((block) => block.kind === 'user')).toMatchObject({
      text: 'First fixture question — edited resend.',
      userMessageId: USER_MESSAGE_ID,
      promptStatus: undefined,
    });
  });

  it('keeps a settled journal user settled when regenerate reissues a running prompt against it', () => {
    const previous = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user', payload: { promptId: 'p-edit', userMessageId: USER_MESSAGE_ID } },
            prompt: 'First fixture question — edited resend.',
            startedAt: FIXED_AT,
            endedAt: FIXED_AT_2,
            steps: [],
          },
        ],
        prompts: [
          {
            promptId: 'p-edit',
            status: 'completed',
            userMessageId: USER_MESSAGE_ID,
            content: [{ type: 'text', text: 'First fixture question — edited resend.' }],
            createdAt: FIXED_AT,
            finishedAt: FIXED_AT_2,
          },
        ],
      }),
    );
    expect(previous.blocks.find((block) => block.kind === 'user')).toMatchObject({
      userMessageId: USER_MESSAGE_ID,
      promptStatus: undefined,
    });
    const regenerating = emptySnapshot({
      items: [
        {
          kind: 'turn',
          turnId: 't1',
          ordinal: 1,
          state: 'running',
          origin: { kind: 'user', payload: { promptId: 'p-regen', userMessageId: USER_MESSAGE_ID } },
          prompt: 'First fixture question — edited resend.',
          startedAt: FIXED_AT,
          steps: [],
        },
      ],
      prompts: [
        {
          promptId: 'p-regen',
          status: 'running',
          userMessageId: USER_MESSAGE_ID,
          content: [{ type: 'text', text: 'First fixture question — edited resend.' }],
          createdAt: FIXED_AT,
        },
      ],
    });
    const projected = projectAgentTranscriptView(previous, 'main', regenerating);
    expect(projected.blocks.filter((block) => block.kind === 'user')).toHaveLength(1);
    expect(projected.blocks.find((block) => block.kind === 'user')).toMatchObject({
      userMessageId: USER_MESSAGE_ID,
      promptStatus: undefined,
    });
  });

  it('projects a regenerate reset from empty previous as a running user until it settles', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'running',
            origin: { kind: 'user', payload: { promptId: 'p-regen', userMessageId: USER_MESSAGE_ID } },
            prompt: 'First fixture question — edited resend.',
            startedAt: FIXED_AT,
            steps: [],
          },
        ],
        prompts: [
          {
            promptId: 'p-regen',
            status: 'running',
            userMessageId: USER_MESSAGE_ID,
            content: [{ type: 'text', text: 'First fixture question — edited resend.' }],
            createdAt: FIXED_AT,
          },
        ],
      }),
    );
    expect(projected.blocks.find((block) => block.kind === 'user')).toMatchObject({
      userMessageId: USER_MESSAGE_ID,
      promptStatus: 'running',
    });
  });

  it('orders queued prompt ids by the projected move positions', () => {
    const snapshot = emptySnapshot({
      prompts: [
        {
          promptId: 'p1',
          status: 'queued',
          userMessageId: 'm1',
          content: [{ type: 'text', text: 'one' }],
          createdAt: FIXED_AT,
          queuePosition: 2,
        },
        {
          promptId: 'p2',
          status: 'queued',
          userMessageId: 'm2',
          content: [{ type: 'text', text: 'two' }],
          createdAt: FIXED_AT_1,
          queuePosition: 0,
        },
        {
          promptId: 'p3',
          status: 'queued',
          userMessageId: 'm3',
          content: [{ type: 'text', text: 'three' }],
          createdAt: FIXED_AT_2,
          queuePosition: 1,
        },
      ],
    });

    const projected = projectAgentTranscriptView(createViewState('session_test'), 'main', snapshot);
    expect(projected.queuedPromptIds).toEqual(['p2', 'p3', 'p1']);
  });

  it('does not settle a queued bubble at the bottom before a steer is actually delivered', () => {
    const opening = userTurnSnapshot({ streaming: true });
    const queued = applyOpsToSnapshot(opening, [{
      op: 'prompt.upsert',
      prompt: {
        promptId: 'p-late-steer', status: 'queued', userMessageId: 'um-late-steer',
        content: [{ type: 'text', text: 'Steer awaiting the next step' }],
        createdAt: '2026-01-01T00:00:03.000Z',
      },
    }]);
    const pending = projectAgentTranscriptView(createViewState('session_test'), 'main', queued);
    const steered = applyOpsToSnapshot(queued, [{
      op: 'prompt.upsert',
      prompt: {
        promptId: 'p-late-steer', status: 'completed', userMessageId: 'um-late-steer',
        content: [{ type: 'text', text: 'Steer awaiting the next step' }],
        createdAt: '2026-01-01T00:00:03.000Z',
        finishedAt: '2026-01-01T00:00:04.000Z', steeredAt: '2026-01-01T00:00:04.000Z',
      },
    }]);
    const beforeDelivery = projectAgentTranscriptView(pending, 'main', steered);
    expect(beforeDelivery.queuedPromptIds).toEqual([]);
    expect(beforeDelivery.blocks.filter((block) => block.kind === 'user' && block.text === 'Steer awaiting the next step')).toEqual([]);

    const delivered = applyOpsToSnapshot(steered, [{
      op: 'frame.upsert', turnId: 't1', stepId: 't1.1',
      frame: {
        kind: 'text', frameId: 'um-late-steer', role: 'user', text: 'Steer awaiting the next step',
        origin: { kind: 'user' },
        part: { partId: 'um-late-steer', messageId: 'um-late-steer', revision: 0, provenance: { source: 'engine' } },
      },
    }]);
    const afterDelivery = projectAgentTranscriptView(beforeDelivery, 'main', delivered);
    expect(afterDelivery.blocks.filter((block) => block.kind === 'user' && block.text === 'Steer awaiting the next step')).toEqual([
      expect.objectContaining({ turnId: 't1', promptStatus: undefined }),
    ]);
  });

  it('removes a steered prompt from the queue without inventing a delivered bubble', () => {
    const previous = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      userTurnSnapshot({ streaming: true }),
    );
    const queued = applyOpsToSnapshot(userTurnSnapshot({ streaming: true }), [
      {
        op: 'prompt.upsert',
        prompt: {
          promptId: 'p-queued',
          status: 'queued',
          userMessageId: 'um-queued',
          content: [{ type: 'text', text: 'B: steer me in.' }],
          createdAt: '2026-01-01T00:00:03.000Z',
        },
      },
    ]);
    const withQueued = projectAgentTranscriptView(previous, 'main', queued);
    expect(withQueued.queuedPromptIds).toEqual(['p-queued']);
    const steered = applyOpsToSnapshot(queued, [
      {
        op: 'prompt.upsert',
        prompt: {
          promptId: 'p-queued',
          status: 'completed',
          userMessageId: 'um-queued',
          content: [{ type: 'text', text: 'B: steer me in.' }],
          createdAt: '2026-01-01T00:00:03.000Z',
          finishedAt: '2026-01-01T00:00:04.000Z',
          steeredAt: '2026-01-01T00:00:04.000Z',
        },
      },
    ]);
    const projected = projectAgentTranscriptView(withQueued, 'main', steered);
    expect(projected.queuedPromptIds).toEqual([]);
    expect(projected.blocks.some((block) => block.kind === 'user' && block.promptId === 'p-queued')).toBe(false);
  });

  it('does not rewrite the original user bubble when the active prompt is steered', () => {
    const previous = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      userTurnSnapshot({ streaming: true }),
    );
    const steered = applyOpsToSnapshot(userTurnSnapshot({ streaming: true }), [
      {
        op: 'prompt.upsert',
        prompt: {
          promptId: PROMPT_ID,
          status: 'running',
          userMessageId: USER_MESSAGE_ID,
          content: [{ type: 'text', text: 'canonical user prompt\nB: steer me in.' }],
          createdAt: FIXED_AT,
          steeredAt: '2026-01-01T00:00:04.000Z',
        },
      },
    ]);
    const projected = projectAgentTranscriptView(previous, 'main', steered);
    expect(projected.blocks.filter((block) => block.kind === 'user')).toHaveLength(1);
    expect(projected.blocks.find((block) => block.kind === 'user')).toMatchObject({
      text: 'canonical user prompt',
      userMessageId: USER_MESSAGE_ID,
    });
  });

  it('collapses a queued bubble onto the canonical steer user frame', () => {
    const previous = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      userTurnSnapshot({ streaming: true }),
    );
    const queued = applyOpsToSnapshot(userTurnSnapshot({ streaming: true }), [
      {
        op: 'prompt.upsert',
        prompt: {
          promptId: 'p-queued',
          status: 'queued',
          userMessageId: 'um-queued',
          content: [{ type: 'text', text: 'B: steer me in.' }],
          createdAt: '2026-01-01T00:00:03.000Z',
        },
      },
    ]);
    const withQueued = projectAgentTranscriptView(previous, 'main', queued);
    const withSteerFrame = applyOpsToSnapshot(queued, [
      {
        op: 'prompt.upsert',
        prompt: {
          promptId: 'p-queued',
          status: 'completed',
          userMessageId: 'um-queued',
          content: [{ type: 'text', text: 'B: steer me in.' }],
          createdAt: '2026-01-01T00:00:03.000Z',
          finishedAt: '2026-01-01T00:00:04.000Z',
          steeredAt: '2026-01-01T00:00:04.000Z',
        },
      },
      {
        op: 'frame.upsert',
        turnId: 't1',
        stepId: 't1.1',
        frame: {
          kind: 'text',
          frameId: 'p-queued',
          role: 'user',
          text: 'B: steer me in.',
          origin: { kind: 'user' },
          part: {
            partId: 'p-queued',
            messageId: 'p-queued',
            revision: 0,
            provenance: { source: 'engine' },
          },
        },
      },
    ]);
    const projected = projectAgentTranscriptView(withQueued, 'main', withSteerFrame);
    const users = projected.blocks.filter((block) => block.kind === 'user' && block.text === 'B: steer me in.');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ promptStatus: undefined });
  });

  it('projects injection-origin user messages onto the system lane', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user', payload: { promptId: 'p-typed', userMessageId: 'um-typed' } },
            prompt: 'Keep an eye on the nightly job.',
            startedAt: FIXED_AT,
            steps: [{ kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'completed', frames: [] }],
          },
          {
            kind: 'turn',
            turnId: 't2',
            ordinal: 2,
            state: 'completed',
            origin: { kind: 'cron', payload: { kind: 'cron_job', jobId: 'nightly' } },
            prompt: '<cron-fire job="nightly">Run the nightly report.</cron-fire>',
            startedAt: FIXED_AT_1,
            steps: [{ kind: 'step', stepId: 't2.1', turnId: 't2', ordinal: 1, state: 'completed', frames: [] }],
          },
          {
            kind: 'turn',
            turnId: 't3',
            ordinal: 3,
            state: 'completed',
            origin: { kind: 'compaction', payload: { kind: 'compaction_summary' } },
            prompt: 'Earlier context summarized: the user asked about the nightly job schedule.',
            startedAt: FIXED_AT_1,
            steps: [{ kind: 'step', stepId: 't3.1', turnId: 't3', ordinal: 1, state: 'completed', frames: [] }],
          },
          {
            kind: 'turn',
            turnId: 't4',
            ordinal: 4,
            state: 'completed',
            origin: { kind: 'other', payload: { kind: 'skill_activation', skillName: 'review', trigger: 'auto' } },
            prompt: 'SKILL.md body: review the diff for regressions before merging.',
            startedAt: FIXED_AT_1,
            steps: [{ kind: 'step', stepId: 't4.1', turnId: 't4', ordinal: 1, state: 'completed', frames: [] }],
          },
          {
            kind: 'turn',
            turnId: 't5',
            ordinal: 5,
            state: 'completed',
            origin: { kind: 'other', payload: { kind: 'system_trigger', name: 'goal_continuation' } },
            prompt: 'Continue toward the goal: finish the migration checklist.',
            startedAt: FIXED_AT_1,
            steps: [{ kind: 'step', stepId: 't5.1', turnId: 't5', ordinal: 1, state: 'completed', frames: [] }],
          },
        ],
      }),
    );
    expect(projected.blocks.filter((block) => block.kind === 'user')).toHaveLength(1);
    expect(projected.blocks.find((block) => block.kind === 'user')?.text).toBe('Keep an eye on the nightly job.');
    expect(projected.blocks.filter((block) => block.kind === 'system')).toHaveLength(3);
    expect(projected.blocks.find((block) => block.kind === 'skill')).toMatchObject({ name: 'review' });
  });

  it('projects historical image captions outside the user block without changing the source', () => {
    const caption = 'Image compressed to fit model limits: original 4500x2800 -> sent 2000x1244. The original is at "/example/original.png".';
    const prompt = `Look at this.\n<system>${caption}</system>`;
    const snapshot = emptySnapshot({ items: [{
      kind: 'turn', turnId: 't-image', ordinal: 1, state: 'completed',
      origin: { kind: 'user' }, prompt, startedAt: FIXED_AT, steps: [],
    }] });
    const projected = projectAgentTranscriptView(createViewState('session_test'), 'main', snapshot);
    expect(projected.blocks.filter((block) => block.kind === 'user').map((block) => block.text)).toEqual(['Look at this.']);
    expect(projected.blocks.filter((block) => block.kind === 'system-reminder')).toEqual([
      expect.objectContaining({ text: caption, turnId: 't-image' }),
    ]);
    expect(snapshot.items[0]).toMatchObject({ prompt });
  });

  it('keeps injected reminders as their own quiet rows, never empty', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'other', payload: { kind: 'injection', variant: 'todo_list_reminder', disclosure: { kind: 'directive', triggers: ['E1'], epoch: 1 } } },
            prompt: '<system-reminder>\nTodoList has not been updated recently.\n</system-reminder>',
            startedAt: FIXED_AT_1,
            steps: [{ kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'completed', frames: [] }],
          },
          {
            kind: 'turn',
            turnId: 't2',
            ordinal: 2,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'Ship it.\n<system-reminder>\nImage compressed to fit.\n</system-reminder>',
            startedAt: FIXED_AT_1,
            steps: [{ kind: 'step', stepId: 't2.1', turnId: 't2', ordinal: 1, state: 'completed', frames: [] }],
          },
        ],
      }),
    );
    const reminders = projected.blocks.filter((block) => block.kind === 'system-reminder');
    expect(reminders.map((block) => block.text)).toEqual(['TodoList has not been updated recently.', 'Image compressed to fit.']);
    expect(reminders[0]).toMatchObject({ variant: 'todo_list_reminder', disclosure: { kind: 'directive', triggers: ['E1'], epoch: 1 } });
    expect(reminders[0]).toMatchObject({ category: { kind: 'directive', triggers: ['E1'], epoch: 1 } });
    expect(reminders[1]?.disclosure).toBeUndefined();
    expect(reminders[1]?.category).toBeUndefined();
    expect(projected.blocks.find((block) => block.kind === 'user')?.text).toBe('Ship it.');
    expect(projected.blocks.some((block) => block.kind === 'system' && block.text === '')).toBe(false);
  });

  it('reads a reminder category only from a known disclosure kind', () => {
    for (const kind of ['directive', 'renew', 'rebuild', 'history', 'progress'] as const) {
      expect(reminderCategory({ kind, triggers: ['T2'], epoch: 3, userTurn: 't4' })).toEqual({ kind, triggers: ['T2'], epoch: 3, userTurn: 't4' });
    }
    expect(reminderCategory({ kind: 'progress', triggers: ['T0', 7], epoch: 'x', userTurn: '' })).toEqual({ kind: 'progress', triggers: ['T0'], epoch: undefined, userTurn: undefined });
    expect(reminderCategory({ kind: 'handoff' })).toBeUndefined();
    expect(reminderCategory('directive')).toBeUndefined();
    expect(reminderCategory(undefined)).toBeUndefined();
  });

  it('keeps the author slash input separate from loaded instructions in opening and delivered skills', () => {
    const userInput = ' /skill:review --fix\nPlease keep this second line. ';
    const prompt = 'User activated the skill "review".\n\n<skill-loaded name="review">\n# Review instructions\n</skill-loaded>';
    const origin = { kind: 'skill_activation', trigger: 'user-slash', skillName: 'review', skillArgs: '--fix\nPlease keep this second line.', userInput };
    const opening = agentTranscriptToBlocks({ agent_id: 'main', items: [{
      kind: 'turn', turnId: 't-slash', ordinal: 0, state: 'completed', prompt, origin: { kind: 'other', payload: origin }, startedAt: FIXED_AT, steps: [],
    }] });
    expect(opening.map(block => block.kind)).toEqual(['user', 'skill']);
    expect(opening[0]).toMatchObject({ kind: 'user', text: userInput });
    expect(opening[1]).toMatchObject({ kind: 'skill', text: '# Review instructions', name: 'review' });
    const delivered = agentTranscriptToBlocks({ agent_id: 'main', items: [{
      kind: 'turn', turnId: 't-slash', ordinal: 0, state: 'completed', origin: { kind: 'user' }, startedAt: FIXED_AT, steps: [{
        kind: 'step', stepId: 's-slash', turnId: 't-slash', ordinal: 1, state: 'completed', frames: [{
          kind: 'text', frameId: 'skill-delivery', role: 'user', text: prompt, origin: { kind: 'other', payload: origin },
        }],
      }],
    }] });
    expect(delivered.map(block => block.kind)).toEqual(['user', 'skill']);
    expect(delivered[0]).toMatchObject({ kind: 'user', text: userInput });
    for (const trigger of ['model-tool', 'nested-skill']) {
      expect(classifyTranscriptText({ text: prompt, origin: { ...origin, trigger } }).userInput).toBeUndefined();
    }
    expect(classifyTranscriptText({ text: prompt, origin: { ...origin, userInput: undefined } }).userInput).toBeUndefined();
  });

  it('names a model-loaded skill from its envelope and drops the XML', () => {
    const classified = classifyTranscriptText({
      text: 'Skill loaded for this request.\n\n<skill-loaded name="kiki-desktop-ops" trigger="model-tool" source="project" args="">\n# Ops\n\nBuild, promote, launch.\n</skill-loaded>',
      role: 'user',
      origin: { kind: 'skill_activation', trigger: 'model-tool' },
    });
    expect(classified.lane).toBe('skill');
    expect(classified.skill).toEqual({ source: 'skill', name: 'kiki-desktop-ops', args: undefined });
    expect(classified.text).toBe('# Ops\n\nBuild, promote, launch.');
  });

  it('projects a no-origin turn prompt as a user block, not a fake task system block', () => {
    // REST replay turns carry no origin field at all; the projection must not
    // invent { kind: 'task' } for them.
    const item: AgentTranscriptResponse['items'][number] = {
      kind: 'turn',
      turnId: 't-no-origin',
      prompt: 'a prompt without any origin metadata',
      startedAt: FIXED_AT,
      steps: [],
    };
    const blocks = agentTranscriptToBlocks({ agent_id: 'main', items: [item] });
    expect(blocks.find((block) => block.kind === 'user')).toMatchObject({
      text: 'a prompt without any origin metadata',
    });
    expect(blocks.some((block) => block.kind === 'system' && block.variant === 'task')).toBe(false);
  });

  it('still classifies genuine task notification text without origin as a task system block', () => {
    const item: AgentTranscriptResponse['items'][number] = {
      kind: 'turn',
      turnId: 't-notify',
      prompt: '<notification task_id="task-9" status="completed">nightly finished</notification>',
      startedAt: FIXED_AT,
      steps: [],
    };
    const blocks = agentTranscriptToBlocks({ agent_id: 'main', items: [item] });
    expect(blocks.find((block) => block.kind === 'system')).toMatchObject({
      variant: 'task',
      text: 'nightly finished',
    });
  });

  it('marks only the final assistant frame of a cancelled turn as stopped', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        items: [
          {
            kind: 'turn',
            turnId: 't-cancelled',
            ordinal: 1,
            state: 'cancelled',
            origin: { kind: 'user' },
            prompt: 'Abort me mid-stream.',
            startedAt: FIXED_AT,
            endedAt: FIXED_AT_1,
            steps: [
              {
                kind: 'step',
                stepId: 't-cancelled.1',
                turnId: 't-cancelled',
                ordinal: 1,
                state: 'interrupted',
                frames: [
                  { kind: 'text', frameId: 'text-1', role: 'assistant', text: 'first' },
                ],
              },
              {
                kind: 'step',
                stepId: 't-cancelled.2',
                turnId: 't-cancelled',
                ordinal: 2,
                state: 'interrupted',
                frames: [
                  {
                    kind: 'text',
                    frameId: 'text-2',
                    role: 'assistant',
                    text: 'half-finished sentence',
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const assistant = projected.blocks.filter(
      (block): block is AssistantBlock => block.kind === 'assistant',
    );
    expect(assistant).toHaveLength(2);
    expect(assistant[0]?.stopped).toBe(false);
    expect(assistant[1]?.stopped).toBe(true);
  });
});

describe('honest unknown timing', () => {
  it('leaves a taskref subagent card start time undefined instead of an empty-string sentinel', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'go',
            startedAt: FIXED_AT,
            steps: [],
          },
          { kind: 'taskref', refId: 'ref-no-clock', taskId: 'task-no-clock' },
        ],
        tasks: [
          {
            taskId: 'task-no-clock',
            kind: 'subagent',
            state: 'completed',
            detached: false,
            agentId: 'agent-no-clock-ref',
            description: 'no clocks anywhere',
            outputTail: 'done',
          },
        ],
      }),
    );
    const card = projected.blocks.find(
      (block): block is SubagentBlock => block.kind === 'subagent' && block.subagentId === 'agent-no-clock-ref',
    );
    expect(card).toBeDefined();
    expect(card?.startedAt).toBeUndefined();
  });

  it('leaves inline subagent and tool timing undefined instead of fabricating empty-string / 0ms', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'delegate',
            durationMs: 1200,
            steps: [
              {
                kind: 'step',
                stepId: 't1.1',
                turnId: 't1',
                ordinal: 1,
                state: 'completed',
                frames: [
                  {
                    kind: 'tool',
                    frameId: 'f-agent',
                    toolCallId: 'call-agent',
                    name: 'AgentRun',
                    state: 'done',
                    agentRefs: [{ agentId: 'agent-no-clock-inline' }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const tool = projected.blocks.find(
      (block): block is ToolBlock => block.kind === 'tool' && block.toolCallId === 'call-agent',
    );
    expect(tool?.startedAt).toBeUndefined();
    expect(tool?.durationMs).toBe(1200);
    expect(tool?.durationSource).toBe('turn');
    const card = projected.blocks.find(
      (block): block is SubagentBlock => block.kind === 'subagent' && block.subagentId === 'agent-no-clock-inline',
    );
    expect(card).toBeDefined();
    expect(card?.startedAt).toBeUndefined();
  });

  it('keeps tool duration sourced from the turn when only the frame start exists', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'half-timed',
            durationMs: 9000,
            steps: [
              {
                kind: 'step',
                stepId: 't1.1',
                turnId: 't1',
                ordinal: 1,
                state: 'completed',
                frames: [
                  {
                    kind: 'tool',
                    frameId: 'f-half',
                    toolCallId: 'call-half',
                    name: 'Read',
                    state: 'done',
                    startedAt: '2026-01-01T00:00:01.000Z',
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const tool = projected.blocks.find(
      (block): block is ToolBlock => block.kind === 'tool' && block.toolCallId === 'call-half',
    );
    expect(tool?.startedAt).toBe(Date.parse('2026-01-01T00:00:01.000Z'));
    expect(tool?.durationMs).toBe(9000);
    expect(tool?.durationSource).toBe('turn');
  });

  it('prefers the spawning frame startedAt over step/turn boundaries for inline subagents', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'delegate',
            startedAt: '2026-01-01T00:00:00.000Z',
            steps: [
              {
                kind: 'step',
                stepId: 't1.1',
                turnId: 't1',
                ordinal: 1,
                state: 'completed',
                startedAt: '2026-01-01T00:00:10.000Z',
                frames: [
                  {
                    kind: 'tool',
                    frameId: 'f-agent',
                    toolCallId: 'call-agent',
                    name: 'AgentRun',
                    state: 'done',
                    startedAt: '2026-01-01T00:00:20.000Z',
                    agentRefs: [{ agentId: 'agent-frame-clock' }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const card = projected.blocks.find(
      (block): block is SubagentBlock => block.kind === 'subagent' && block.subagentId === 'agent-frame-clock',
    );
    expect(card?.startedAt).toBe('2026-01-01T00:00:20.000Z');
  });

  it('leaves inline subagent timing undefined when only step/turn boundaries exist', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'delegate',
            startedAt: '2026-01-01T00:00:00.000Z',
            steps: [
              {
                kind: 'step',
                stepId: 't1.1',
                turnId: 't1',
                ordinal: 1,
                state: 'completed',
                startedAt: '2026-01-01T00:00:10.000Z',
                frames: [
                  {
                    kind: 'tool',
                    frameId: 'f-agent',
                    toolCallId: 'call-agent',
                    name: 'AgentRun',
                    state: 'done',
                    agentRefs: [{ agentId: 'agent-step-clock' }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const card = projected.blocks.find(
      (block): block is SubagentBlock => block.kind === 'subagent' && block.subagentId === 'agent-step-clock',
    );
    expect(card).toBeDefined();
    expect(card?.startedAt).toBeUndefined();
  });

  it('does not promote snapshot created_at to the execution start time', () => {
    const live: SubagentBlock = {
      kind: 'subagent',
      id: 'subagent-agent-y',
      subagentId: 'agent-y',
      parentAgentId: 'main',
      parentToolCallId: undefined,
      name: 'agent-y',
      description: undefined,
      model: undefined,
      thinkingEffort: undefined,
      status: 'running',
      summary: undefined,
      error: undefined,
      endedAt: undefined,
      toolCallCount: 0,
      transcript: [],
    };
    const overlaid = overlaySnapshotSubagentFields(
      [live],
      [compactSnapshotSubagent({ id: 'agent-y', status: 'running', created_at: '2026-01-01T00:00:05.000Z' })],
    );
    const overlaidY = overlaid[0];
    expect(overlaidY?.kind === 'subagent' ? overlaidY.startedAt : 'not-subagent').toBeUndefined();
  });

  it('prefers real frame startedAt/endedAt over step and turn fallbacks', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'timed',
            startedAt: FIXED_AT,
            durationMs: 9999,
            steps: [
              {
                kind: 'step',
                stepId: 't1.1',
                turnId: 't1',
                ordinal: 1,
                state: 'completed',
                startedAt: FIXED_AT,
                frames: [
                  {
                    kind: 'tool',
                    frameId: 'f-timed',
                    toolCallId: 'call-timed',
                    name: 'Read',
                    state: 'done',
                    startedAt: '2026-01-01T00:00:01.000Z',
                    endedAt: '2026-01-01T00:00:03.500Z',
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const tool = projected.blocks.find(
      (block): block is ToolBlock => block.kind === 'tool' && block.toolCallId === 'call-timed',
    );
    expect(tool?.startedAt).toBe(Date.parse('2026-01-01T00:00:01.000Z'));
    expect(tool?.durationMs).toBe(2500);
  });

  it('keeps start/end unknown when the snapshot overlay has no real timestamps either', () => {
    const live: SubagentBlock = {
      kind: 'subagent',
      id: 'subagent-agent-x',
      subagentId: 'agent-x',
      parentAgentId: 'main',
      parentToolCallId: undefined,
      name: 'agent-x',
      description: undefined,
      model: undefined,
      thinkingEffort: undefined,
      status: 'running',
      summary: undefined,
      error: undefined,
      endedAt: undefined,
      toolCallCount: 0,
      transcript: [],
    };
    const overlaid = overlaySnapshotSubagentFields(
      [live],
      [compactSnapshotSubagent({ id: 'agent-x', status: 'running', created_at: '' })],
    );
    expect(overlaid[0]).toMatchObject({ startedAt: undefined, endedAt: undefined });
  });
});

function applyOpsToSnapshot(
  snapshot: AgentTranscriptSnapshot,
  ops: readonly TranscriptOperation[],
): AgentTranscriptSnapshot {
  const store = new AgentTranscript('main');
  store.apply([{ op: 'reset', agentId: 'main', snapshot }, ...ops]);
  return store.snapshot();
}

describe('external executor turn metadata', () => {
  const execution = {
    executorId: 'grok',
    protocol: 'acp-v1',
    resumeMode: 'resume',
    fidelity: 'degraded',
    losses: ['acp_no_step_boundaries', 'tool_output_summary_only'],
  };

  function snapshotWithExecution(value: unknown): AgentTranscriptSnapshot {
    const base = userTurnSnapshot();
    return emptySnapshot({
      ...base,
      items: base.items.map((item) =>
        item.kind === 'turn' ? ({ ...item, execution: value } as typeof item) : item,
      ),
    });
  }

  it('parses the executor.turn.metadata projection defensively', () => {
    expect(turnExecutionFromItem({ kind: 'turn', execution })).toEqual({
      executorId: 'grok',
      protocol: 'acp-v1',
      resumeMode: 'resume',
      fidelity: 'degraded',
      losses: ['acp_no_step_boundaries', 'tool_output_summary_only'],
    });
    // snake_case REST passthrough is accepted too.
    expect(
      turnExecutionFromItem({
        execution: { executor_id: 'codex', protocol: 'acp-v1', resume_mode: 'new' },
      }),
    ).toMatchObject({ executorId: 'codex', fidelity: 'full', losses: [] });
    // Malformed payloads degrade to "no badge", never break the projection.
    expect(turnExecutionFromItem({ execution: { protocol: 'acp-v1' } })).toBeUndefined();
    expect(turnExecutionFromItem({ execution: 'grok' })).toBeUndefined();
    expect(turnExecutionFromItem({ execution: null })).toBeUndefined();
    expect(turnExecutionFromItem({})).toBeUndefined();
  });

  it('collects turnExecutions keyed by turnId and reuses unchanged entries', () => {
    const first = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      snapshotWithExecution(execution),
    );
    expect(first.turnExecutions['t1']).toEqual({
      executorId: 'grok',
      protocol: 'acp-v1',
      resumeMode: 'resume',
      fidelity: 'degraded',
      losses: ['acp_no_step_boundaries', 'tool_output_summary_only'],
    });

    const second = projectAgentTranscriptView(first, 'main', snapshotWithExecution(execution));
    expect(second.turnExecutions['t1']).toBe(first.turnExecutions['t1']);
  });

  it('drops the entry when the turn loses its execution metadata', () => {
    const first = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      snapshotWithExecution(execution),
    );
    const second = projectAgentTranscriptView(first, 'main', userTurnSnapshot());
    expect(second.turnExecutions['t1']).toBeUndefined();
  });

  it('ignores malformed execution payloads', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      snapshotWithExecution({ executorId: '', protocol: 'acp-v1' }),
    );
    expect(projected.turnExecutions['t1']).toBeUndefined();
  });
});

describe('queued prompt scheduling projection', () => {
  it('projects appendTiming + revision per queued prompt and falls back to agent_idle', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        prompts: [
          {
            promptId: 'p-timed',
            status: 'queued',
            createdAt: FIXED_AT,
            queuePosition: 0,
            appendTiming: 'tasks_done',
            revision: 4,
          },
          { promptId: 'p-plain', status: 'queued', createdAt: FIXED_AT_1, queuePosition: 1 },
        ],
      }),
    );
    expect(projected.queuedPromptIds).toEqual(['p-timed', 'p-plain']);
    expect(projected.queuedPromptMeta['p-timed']).toEqual({ appendTiming: 'tasks_done', revision: 4, queuePosition: 0 });
    expect(projected.queuedPromptMeta['p-plain']).toEqual({ appendTiming: 'agent_idle', revision: undefined, queuePosition: 1 });
    const previews = queuedPromptPreviews(projected);
    expect(previews[0]?.appendTiming).toBe('tasks_done');
    expect(previews[0]?.revision).toBe(4);
    expect(previews[1]?.appendTiming).toBe('agent_idle');
  });

  it('shows the media and exact content of an attachment-only queued prompt', () => {
    const content = [{ type: 'image' as const, source: { kind: 'url' as const, url: 'https://example.test/photo.png' } }];
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({ prompts: [{
        promptId: 'p-photo', userMessageId: 'um-photo', status: 'queued',
        createdAt: FIXED_AT, queuePosition: 0, content,
      }] }),
    );
    expect(queuedPromptPreviews(projected)).toEqual([expect.objectContaining({
      promptId: 'p-photo', text: '', content,
      media: [{ kind: 'image', url: 'https://example.test/photo.png', mime: undefined }],
    })]);
  });

  it('keeps captions and system reminders out of queued and running message updates', () => {
    const caption = 'Image compressed to fit model limits: original 4500x2800 -> sent 2000x1244.';
    const image = { type: 'image' as const, source: { kind: 'url' as const, url: 'https://example.test/photo.png' } };
    const content = [{ type: 'text' as const, text: 'review' }, { type: 'text' as const, text: `<system>${caption}</system>\n<system-reminder>Daemon note.</system-reminder>` }, image];
    const echo = (status: 'queued' | 'running', parts = content) => ({
      promptId: 'p-photo', userMessageId: 'um-photo', text: 'review', status, createdAt: FIXED_AT, content: parts,
    });
    let state = appendLocalUserMessage(createViewState('session_test'), echo('queued', [content[0]!, image]));
    for (const status of ['queued', 'queued', 'running'] as const) {
      state = appendLocalUserMessage(state, echo(status));
      expect(state.blocks.filter((block) => block.kind === 'user')).toEqual([
        expect.objectContaining({ text: 'review', promptStatus: status, media: [expect.objectContaining({ kind: 'image' })] }),
      ]);
      expect(state.blocks.filter((block) => block.kind === 'system-reminder').map((block) => block.text)).toEqual([caption, 'Daemon note.']);
      if (status === 'queued') expect(queuedPromptPreviews(state)[0]).toMatchObject({ text: 'review', content });
    }
    const cleared = appendLocalUserMessage(state, echo('running', [content[0]!, image]));
    expect(cleared.blocks.filter((block) => block.kind === 'system-reminder')).toEqual([]);
    expect(content[1]).toMatchObject({ type: 'text', text: `<system>${caption}</system>\n<system-reminder>Daemon note.</system-reminder>` });
  });

  it('keeps an image-only prompt visible without making its caption a user bubble', () => {
    const caption = 'Image compressed to fit model limits: original 4500x2800 -> sent 2000x1244.';
    const state = appendLocalUserMessage(createViewState('session_test'), {
      promptId: 'p-image', userMessageId: 'um-image', text: '', status: 'running', createdAt: FIXED_AT,
      content: [{ type: 'text', text: `<system>${caption}</system>` }, { type: 'image', source: { kind: 'url', url: 'https://example.test/photo.png' } }],
    });
    expect(state.blocks.find((block) => block.kind === 'user')).toMatchObject({ text: '', media: [expect.objectContaining({ kind: 'image' })] });
    expect(state.blocks.find((block) => block.kind === 'system-reminder')).toMatchObject({ text: caption });
  });

  it('updates exact queued parts even when their projected text and media match, then clears them on launch', () => {
    const image = { type: 'image' as const, source: { kind: 'url' as const, url: 'https://example.test/photo.png' } };
    const initialContent = [{ type: 'text' as const, text: 'review' }, image];
    const replacementContent = [image, { type: 'text' as const, text: 'review' }];
    const echo = (status: 'queued' | 'running', content: typeof initialContent | typeof replacementContent) => ({
      promptId: 'p-photo', userMessageId: 'um-photo', text: 'review', status,
      createdAt: FIXED_AT, content,
    });
    const queued = appendLocalUserMessage(createViewState('session_test'), echo('queued', initialContent));
    const replaced = appendLocalUserMessage(queued, echo('queued', replacementContent));
    expect(queuedPromptPreviews(replaced)[0]?.content).toEqual(replacementContent);
    const running = appendLocalUserMessage(replaced, echo('running', replacementContent));
    expect(running.blocks.find((block): block is UserBlock => block.kind === 'user')?.queuedContent).toBeUndefined();
  });

  it('clears queued attachment parts when a prompt settles without a transcript turn', () => {
    const queued = appendLocalUserMessage(createViewState('session_test'), {
      promptId: 'p-photo', userMessageId: 'um-photo', text: '', status: 'queued', createdAt: FIXED_AT,
      content: [{ type: 'image', source: { kind: 'url', url: 'https://example.test/photo.png' } }],
    });
    const finished = projectAgentTranscriptView(queued, 'main', emptySnapshot({ prompts: [{
      promptId: 'p-photo', userMessageId: 'um-photo', status: 'completed', createdAt: FIXED_AT,
    }] }));
    const user = finished.blocks.find((block): block is UserBlock => block.kind === 'user');
    expect(user).toBeDefined();
    expect(user?.queuedContent).toBeUndefined();
  });

  it('projects and clears the recovery queue hold from transcript meta', () => {
    const held = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({ meta: { promptQueueHold: { reason: 'recovery', count: 2 } } }),
    );
    expect(held.promptQueueHold).toEqual({ reason: 'recovery', count: 2 });
    const released = projectAgentTranscriptView(held, 'main', emptySnapshot());
    expect(released.promptQueueHold).toBeUndefined();
  });

  it('marks the transcript ready only once a snapshot projects, not at shell load', () => {
    const fresh = createViewState('session_test');
    expect(fresh.loaded).toBe(false);
    expect(fresh.transcriptReady).toBe(false);
    const shell = applyTranscriptShell('session_test', {
      as_of_seq: 4,
      epoch: 'e1',
      session,
      messages: { items: [], has_more: false },
      in_flight_turn: null,
      pending_approvals: [],
      pending_questions: [],
    }, fresh);
    expect(shell.loaded).toBe(true);
    expect(shell.transcriptReady).toBe(false);
    const projected = projectAgentTranscriptView(shell, 'main', emptySnapshot());
    expect(projected.transcriptReady).toBe(true);
  });

  it('drops the meta entry once the prompt leaves the queue', () => {
    const queued = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        prompts: [
          { promptId: 'p-timed', status: 'queued', createdAt: FIXED_AT, appendTiming: 'tasks_done', revision: 4 },
        ],
      }),
    );
    const drained = projectAgentTranscriptView(
      queued,
      'main',
      emptySnapshot({
        prompts: [{ promptId: 'p-timed', status: 'running', createdAt: FIXED_AT }],
      }),
    );
    expect(drained.queuedPromptIds).toEqual([]);
    expect(drained.queuedPromptMeta['p-timed']).toBeUndefined();
  });

  it('seeds the meta entry from a local echo so the strip shows the pick before reconcile', () => {
    const state = appendLocalUserMessage(createViewState('session_test'), {
      userMessageId: 'um-timed',
      promptId: 'p-timed',
      text: 'queued with a timing pick',
      createdAt: FIXED_AT,
      status: 'queued',
      appendTiming: 'subagents_done',
    });
    expect(state.queuedPromptMeta['p-timed']).toEqual({ appendTiming: 'subagents_done', revision: undefined });
    const running = appendLocalUserMessage(state, {
      userMessageId: 'um-timed',
      promptId: 'p-timed',
      text: 'queued with a timing pick',
      createdAt: FIXED_AT,
      status: 'running',
    });
    expect(running.queuedPromptMeta['p-timed']).toBeUndefined();
  });

  it('carries goal followUpTiming and controlRevision into the projected snapshot', () => {
    const projected = projectAgentTranscriptView(
      createViewState('session_test'),
      'main',
      emptySnapshot({
        meta: {
          goal: {
            objective: 'Ship the batch',
            status: 'paused',
            followUpTiming: 'tasks_done',
            controlRevision: 9,
          },
        },
      }),
    );
    expect(projected.goal?.objective).toBe('Ship the batch');
    expect(projected.goal?.status).toBe('paused');
    expect(projected.goal?.followUpTiming).toBe('tasks_done');
    expect(projected.goal?.controlRevision).toBe(9);
  });
});

describe('AgentSend delivery receipts', () => {
  const sendTurn = (output: boolean) => ({
    kind: 'turn' as const, turnId: 't1', ordinal: 1, state: 'completed' as const,
    origin: { kind: 'user' as const },
    steps: [{
      kind: 'step' as const, stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'completed' as const,
      frames: ['message-one', 'message-two'].map((messageId) => ({
        kind: 'tool' as const, frameId: messageId, toolCallId: messageId,
        name: 'AgentSend', state: output ? 'done' as const : 'running' as const,
        input: { target: 'worker', message: messageId },
        output: output ? JSON.stringify({ message_id: messageId, status: 'queued', target: { agent_id: 'agent-child' } }) : undefined,
      })),
    }],
  });
  const receipt = (messageId: string, targetAgentId = 'agent-child', status = 'delivered') => ({
    kind: 'marker' as const, markerId: `receipt-${messageId}-${targetAgentId}-${status}`,
    marker: 'agent_message.delivered',
    payload: { type: 'agent_message.delivered', messageId, targetAgentId, status, deliveredAt: FIXED_AT_2 },
  });
  const project = (items: AgentTranscriptSnapshot['items'], previous = createViewState('session_test')) =>
    projectAgentTranscriptView(previous, 'main', emptySnapshot({ items, tasks: [{
      taskId: 'task-child', kind: 'subagent', state: 'running', detached: true,
      agentId: 'agent-child', name: 'worker', outputTail: '',
    }] }));
  const sent = (state: ReturnType<typeof project>) => state.blocks.flatMap((block) =>
    block.kind === 'subagent-event' && block.event === 'sent' ? [block] : []);

  it('updates queued to delivered by exact identity independently for the same target', () => {
    const queued = project([sendTurn(true)]);
    expect(sent(queued).map((block) => block.delivery)).toEqual(['queued', 'queued']);
    const delivered = project([sendTurn(true), receipt('message-one'), receipt('message-two', 'other-agent')], queued);
    expect(sent(delivered).map((block) => [block.messageId, block.delivery])).toEqual([
      ['message-one', 'delivered'], ['message-two', 'queued'],
    ]);
    expect(sent(delivered)[0]).toMatchObject({ deliveredAt: FIXED_AT_2 });
    expect(delivered.blocks.some((block) => block.id.startsWith('agent-marker-receipt'))).toBe(false);
  });

  it('retains a receipt that arrives before the tool result, including duplicate and invalid receipts', () => {
    const early = project([receipt('message-one'), sendTurn(false)]);
    expect(sent(early)[0]?.delivery).toBeUndefined();
    const result = project([receipt('message-one'), sendTurn(true), receipt('message-one'), receipt('message-one', 'agent-child', 'queued')], early);
    expect(sent(result).map((block) => block.delivery)).toEqual(['delivered', 'queued']);
    const lateQueued = project([receipt('message-one'), sendTurn(true)], result);
    expect(sent(lateQueued)[0]?.delivery).toBe('delivered');
  });

  it('restores delivered from a serialized sender snapshot after reload without child transcript state', () => {
    const items = [sendTurn(true), receipt('message-one')];
    const restored = project(JSON.parse(JSON.stringify(items)) as AgentTranscriptSnapshot['items']);
    expect(sent(restored).map((block) => block.delivery)).toEqual(['delivered', 'queued']);
  });
});

describe('durable subagent turn outcomes', () => {
  const parent = applyOpsToSnapshot(emptySnapshot(), spawnChildOps());
  const forestFor = (child: AgentTranscriptSnapshot) => sessionAgentForestFromAgentSnapshots(
    new Map([['main', parent], [CHILD_AGENT_ID, child]]),
  );

  it('keeps a failed turn and its error after replacing live state with a cold wire rebuild', () => {
    const live = replayAgentWire(CHILD_AGENT_ID, childFailureWireRecords);
    const cold = replayAgentWire(CHILD_AGENT_ID, childFailureWireRecords, true);
    const expected = { turnId: 't0', state: 'failed', error: 'Connection closed' };
    expect(forestFor(live).byId[CHILD_AGENT_ID]?.turnOutcome).toMatchObject(expected);
    expect(forestFor(cold).byId[CHILD_AGENT_ID]?.turnOutcome).toMatchObject(expected);
    const fresh = projectAgentTranscriptView(createViewState('session_reopened'), CHILD_AGENT_ID, cold);
    expect(fresh.blocks).toContainEqual(expect.objectContaining({
      id: 'agent-turn-outcome-t0', kind: 'notice', text: 'Connection closed',
      i18n: { key: 'notice.turnFailedDetail', params: { detail: ': Connection closed' } },
    }));
    expect(fresh.turnRetry).toBeUndefined();
  });

  it('retains an earlier failure when a later turn was cancelled', () => {
    const cold = replayAgentWire(CHILD_AGENT_ID, childCancellationWireRecords, true);
    const fresh = projectAgentTranscriptView(createViewState('session_reopened'), CHILD_AGENT_ID, cold);
    expect(forestFor(cold).byId[CHILD_AGENT_ID]?.turnOutcome).toMatchObject({ turnId: 't1', state: 'cancelled' });
    expect(fresh.blocks.filter((block) => block.id.startsWith('agent-turn-outcome-')).map((block) => block.id))
      .toEqual(['agent-turn-outcome-t0', 'agent-turn-outcome-t1']);
    expect(fresh.blocks.find((block) => block.id === 'agent-turn-outcome-t0')).toMatchObject({ text: 'Connection closed' });
  });

  it('recovers a running retry from wire without claiming it still runs after a cold interruption', () => {
    const active = replayAgentWire(CHILD_AGENT_ID, childRetryWireRecords);
    const live = projectAgentTranscriptView(createViewState('session_test'), CHILD_AGENT_ID, active);
    expect(live.turnRetry).toMatchObject({ failedAttempt: 2, maxAttempts: 5, errorName: 'APIConnectionError' });
    const reset = projectAgentTranscriptView(createViewState('session_reopened'), CHILD_AGENT_ID, active);
    expect(reset.turnRetry).toEqual(live.turnRetry);
    const interrupted = replayAgentWire(CHILD_AGENT_ID, childRetryWireRecords, true);
    const cold = projectAgentTranscriptView(createViewState('session_reopened'), CHILD_AGENT_ID, interrupted);
    expect(cold.turnRetry).toBeUndefined();
    expect(cold.busy).toBe(false);
    expect(sessionAgentForestFromAgentSnapshots(new Map([[CHILD_AGENT_ID, interrupted]])).byId[CHILD_AGENT_ID])
      .toMatchObject({ status: 'cancelled', busy: false });
    expect(forestFor(interrupted).byId[CHILD_AGENT_ID]?.turnOutcome).toMatchObject({
      state: 'cancelled', lastRetry: { failedAttempt: 2, maxAttempts: 5, errorMessage: 'Connection closed' },
    });
    expect(cold.blocks.find((block) => block.id === 'agent-turn-last-retry-t0')).toMatchObject({
      i18n: { key: 'transcript.lastRetryFailed' },
    });
  });

  it('keeps failed and cancelled roster facts before their child transcript loads', () => {
    const forest = sessionAgentForestFromAgentSnapshots(new Map([['main', emptySnapshot()]]), [
      compactSnapshotSubagent({ id: 'failed-child', status: 'failed', live: false, output_preview: 'Connection closed' }),
      compactSnapshotSubagent({ id: 'cancelled-child', status: 'cancelled', live: false }),
    ]);
    expect(forest.byId['failed-child']).toMatchObject({ status: 'failed', error: 'Connection closed' });
    expect(forest.byId['cancelled-child']).toMatchObject({ status: 'cancelled' });
  });

  it('clears the last turn outcome when the child starts a newer turn', () => {
    const resumed = replayAgentWire(CHILD_AGENT_ID, [
      ...childFailureWireRecords,
      { type: 'turn.prompt', turnId: 1, input: [{ type: 'text', text: 'Continue' }], origin: { kind: 'other' }, time: Date.parse(FIXED_AT) + 5_000 },
    ]);
    expect(forestFor(resumed).byId[CHILD_AGENT_ID]?.turnOutcome).toBeUndefined();
  });
});


describe('question history answers', () => {
  const questions = [{ id: 'q1', question: 'Which checks?', options: [
    { id: 'a', label: 'Typecheck' }, { id: 'b', label: 'Visual proof' },
  ] }];

  it.each([
    { name: 'saved text keyed by question', answers: { 'Which checks?': 'Typecheck, Visual proof' }, expected: 'Typecheck, Visual proof' },
    { name: 'single click', answers: { q1: { kind: 'single', option_id: 'a' } }, expected: 'Typecheck' },
    { name: 'multiple selections', answers: { q1: { kind: 'multi', option_ids: ['a', 'b'] } }, expected: 'Typecheck, Visual proof' },
    { name: 'selections and a note', answers: { q1: { kind: 'multi_with_other', option_ids: ['b'], other_text: 'Include mobile.' } }, expected: 'Visual proof, Include mobile.' },
    { name: 'free text', answers: { q1: { kind: 'other', text: 'Read the appendix.' } }, expected: 'Read the appendix.' },
  ])('preserves $name across projection and replay', ({ answers, expected }) => {
    const transcript = new AgentTranscript('main');
    transcript.apply([{ op: 'interaction.upsert', interaction: {
      interactionId: 'question-history', interactionKind: 'question', state: 'answered',
      request: { questions, createdAt: FIXED_AT }, response: { answers, resolved_at: FIXED_AT_1 },
    } }]);
    const state = projectAgentTranscriptView(createViewState('session_test'), 'main', transcript.snapshot());
    expect(state.blocks.find((block) => block.kind === 'question')).toMatchObject({
      outcome: { kind: 'answered', at: FIXED_AT_1, answers: { q1: expected } },
    });
    const replay = projectAgentTranscriptView(createViewState('session_test'), 'main', transcript.snapshot());
    expect(replay.blocks).toEqual(state.blocks);
  });

  it.each([undefined, {}, { q1: { kind: 'skipped' } }, { q1: { kind: 'single', option_id: 'missing-option' } }, { q1: true }])('does not invent missing answers from %j', (answers) => {
    const transcript = new AgentTranscript('main');
    transcript.apply([{ op: 'interaction.upsert', interaction: {
      interactionId: 'question-history', interactionKind: 'question', state: 'answered',
      request: { questions, createdAt: FIXED_AT }, response: { answers },
    } }]);
    const state = projectAgentTranscriptView(createViewState('session_test'), 'main', transcript.snapshot());
    const block = state.blocks.find((entry) => entry.kind === 'question');
    expect(block?.kind === 'question' && block.outcome?.kind === 'answered' ? block.outcome.answers : 'wrong state').toBeUndefined();
  });
});
