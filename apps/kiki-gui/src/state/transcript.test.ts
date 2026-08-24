import { describe, expect, it } from 'vitest';

import { AgentTranscript, type AgentTranscriptSnapshot, type TranscriptOperation } from '@moonshot-ai/transcript';
import type { Message, Session, SessionSnapshotResponse } from '@moonshot-ai/protocol';

import {
  CHILD_AGENT_ID,
  FIXED_AT,
  FIXED_AT_2,
  PROMPT_ID,
  TOOL_CALL_ID,
  USER_MESSAGE_ID,
  capabilityMatrixSnapshot,
  emptySnapshot,
  spawnChildOps,
  userTurnSnapshot,
} from './__fixtures__/canonicalTranscript';

import {
  applyTranscriptShell,
  assistantMessageIdFromBlock,
  assistantMessageIdFromBlockId,
  buildFloorEntries,
  classifyTranscriptText,
  createViewState,
  floorPreview,
  latestFinalAssistantBlockId,
  liveSourcesFromAgentSnapshots,
  prependOlderTranscriptSnapshot,
  projectAgentTranscriptView,
  resolveActiveFloorId,
  splitSystemReminders,
  type AssistantBlock,
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
  });
});

describe('canonical product gates via projectAgentTranscriptView', () => {
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
    expect(kinds).toContain('steer');
    expect(kinds).toContain('shell');
    expect(projected.turnTail).toMatchObject({ turnId: 't1', durationMs: 1800, ttftMs: 120 });
    expect(projected.blocks.find((block) => block.kind === 'approval')).toMatchObject({
      originAgentId: CHILD_AGENT_ID,
    });
    expect(kinds).toContain('notice');
    expect(projected.blocks.some((block) => block.id.includes('plan-1'))).toBe(true);
    expect(projected.blocks.some((block) => block.id.includes('swarm-1'))).toBe(true);
    expect(projected.blocks.some((block) => block.id.includes(`ref-${CHILD_AGENT_ID}`))).toBe(true);
    expect(projected.planMode).toBe(true);
    expect(projected.swarmMode).toBe(true);
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

  it('drops a steered prompt from the queue and paints a steer block', () => {
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
    expect(projected.blocks.find((block) => block.kind === 'steer')).toMatchObject({
      promptId: 'p-queued',
      text: 'B: steer me in.',
    });
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
