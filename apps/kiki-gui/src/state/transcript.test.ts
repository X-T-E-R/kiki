import { describe, expect, it } from 'vitest';

import { AgentTranscript, type AgentTranscriptSnapshot, type TranscriptOperation } from '@moonshot-ai/transcript';
import type { Message, Session, SessionSnapshotResponse, SnapshotSubagent } from '@moonshot-ai/protocol';

import {
  CHILD_AGENT_ID,
  FIXED_AT,
  FIXED_AT_1,
  FIXED_AT_2,
  PROMPT_ID,
  TOOL_CALL_ID,
  USER_MESSAGE_ID,
  capabilityMatrixSnapshot,
  emptySnapshot,
  spawnChildOps,
  userTurnSnapshot,
} from './__fixtures__/canonicalTranscript';

import type { AgentTranscriptResponse } from '../lib/client';

import { buildAgentForest } from './agentTree';

import {
  appendLocalUserMessage,
  agentTranscriptToBlocks,
  applyTranscriptShell,
  assistantMessageIdFromBlock,
  assistantMessageIdFromBlockId,
  buildFloorEntries,
  classifyTranscriptText,
  createViewState,
  filterBlocksToDirectChildren,
  floorPreview,
  latestFinalAssistantBlockId,
  liveSourcesFromAgentSnapshots,
  overlayLiveSourcesWithSnapshotSubagents,
  overlaySnapshotSubagentFields,
  prependOlderTranscriptSnapshot,
  projectAgentTranscriptView,
  resolveActiveFloorId,
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

describe('classifyTranscriptText', () => {
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
    ).toMatchObject({ lane: 'system', systemVariant: 'cron_job' });
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
    ).toBe('system');
    expect(
      classifyTranscriptText({
        text: 'Continue toward the goal',
        role: 'user',
        origin: { kind: 'system_trigger', name: 'goal_continuation' },
      }),
    ).toMatchObject({ lane: 'system', systemVariant: 'system_trigger' });
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

  it('anchors Agent/AgentSwarm entries on the real tool frame agentRefs', () => {
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
      model: 'provider/kimi-for-coding',
      thinkingEffort: 'high',
      toolCallCount: 7,
      label: 'research',
    });
    expect(forest.byId['ghost-child']).toBeUndefined();
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
      output: 'partial',
      done: false,
    });
    expect(second.find((block) => block.kind === 'shell')).toMatchObject({
      output: 'complete',
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

  it('projects attachments, steer, shell, turn tail, origin agent, and plan/swarm/taskref markers', () => {
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
    expect(projected.blocks.some((block) => block.id.includes('swarm-1'))).toBe(true);
    expect(projected.blocks.some((block) => block.kind === 'subagent' && block.subagentId === CHILD_AGENT_ID)).toBe(
      true,
    );
    expect(projected.blocks.some((block) => block.id.includes(`ref-${CHILD_AGENT_ID}`))).toBe(false);
    expect(projected.planMode).toBe(true);
    expect(projected.swarmMode).toBe(true);
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
                      input: { target: 'Researcher', message: 'also check the wire envelope' },
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
      expect(sent).toMatchObject({
        id: 'subagent-event-agent-1-send-call-send-1',
        subagentId: 'agent-1',
        at: '2026-01-01T00:00:03.000Z',
        turnId: 't1',
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

    it('addresses resume/send refs by the explicit spawn name, never the shared profile label', () => {
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
              agentId: 'agent-1',
              outputTail: '',
              startedAt: '2026-01-01T00:00:01.000Z',
            },
            {
              taskId: 'task-beta',
              kind: 'subagent',
              state: 'running',
              detached: false,
              agentId: 'agent-2',
              outputTail: '',
              startedAt: '2026-01-01T00:00:02.000Z',
            },
          ],
        }),
      );
      // Both cards carry the shared profile label — display-name matching
      // alone would cross-wire the two agents.
      const names = projected.blocks
        .filter((block) => block.kind === 'subagent')
        .map((block) => (block.kind === 'subagent' ? block.name : ''));
      expect(names).toEqual(['coder', 'coder']);
      const resumed = projected.blocks.find(
        (block) => block.kind === 'subagent-event' && block.event === 'resumed',
      );
      const sent = projected.blocks.find(
        (block) => block.kind === 'subagent-event' && block.event === 'sent',
      );
      expect(resumed).toMatchObject({ subagentId: 'agent-2', at: '2026-01-01T00:00:05.000Z' });
      expect(sent).toMatchObject({ subagentId: 'agent-1', at: '2026-01-01T00:00:06.000Z' });
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

    it('resolves a cold-page AgentSend target from the successful result payload', () => {
      // Spawn turn paged out; the current window only shows the AgentSend
      // call. Its success output names the canonical target id.
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
                      output: JSON.stringify({
                        message_id: 'msg-1',
                        status: 'queued',
                        deduplicated: false,
                        target: { task_name: 'alpha', agent_id: 'agent-1' },
                      }),
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

  it('clears the queued chip when the matching prompt is aborted', () => {
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
        },
      },
    ]);
    const projected = projectAgentTranscriptView(withQueued, 'main', aborted);
    expect(
      projected.blocks.some((block) => block.kind === 'user' && block.promptId === 'p-queued' && block.promptStatus === 'queued'),
    ).toBe(false);
    expect(projected.blocks.some((block) => block.id === 'notice-aborted-p-queued')).toBe(true);
    expect(
      projected.blocks.some((block) => block.kind === 'user' && block.promptId === 'p-queued' && block.text === 'B: cancel me.'),
    ).toBe(true);
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

  it('drops a steered prompt from the queue and keeps it as a settled user bubble', () => {
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
    expect(projected.blocks.find((block) => block.kind === 'user' && block.promptId === 'p-queued')).toMatchObject({
      text: 'B: steer me in.',
      promptStatus: undefined,
    });
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
    expect(projected.blocks.filter((block) => block.kind === 'system')).toHaveLength(4);
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
