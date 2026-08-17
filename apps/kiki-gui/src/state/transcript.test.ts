import { describe, expect, it } from 'vitest';

import type { Message, Session, SessionSnapshotResponse } from '@moonshot-ai/protocol';

import type { SessionEventFrame } from '../lib/types';
import {
  agentTranscriptToBlocks,
  applyDelta,
  applyFrame,
  applySnapshot,
  appendLocalUserMessage,
  createViewState,
  derivePendingInteraction,
  incrementSubagentToolCount,
  markApprovalResolved,
  markQuestionOutcome,
  pendingApprovalCount,
  prependOlderMessages,
  classifyTranscriptText,
  filterBlocksToDirectChildren,
  preserveCapturedSteers,
  preserveCapturedSubagents,
  queuedPromptPreviews,
  reconcilePromptList,
  sessionAgentForestFromTranscript,
  setOlderError,
  setSessionRecord,
  splitSystemReminders,
  type AssistantBlock,
  type ApprovalBlock,
  type SkillBlock,
  type SteerBlock,
  type SystemBlock,
  type SystemReminderBlock,
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

function snapshot(overrides: Partial<SessionSnapshotResponse> = {}): SessionSnapshotResponse {
  return {
    as_of_seq: 10,
    epoch: 'epoch-1',
    session,
    messages: { items: [], has_more: false },
    in_flight_turn: null,
    pending_approvals: [],
    pending_questions: [],
    ...overrides,
  };
}

function frame(
  payload: SessionEventFrame['payload'],
  options: { seq?: number; volatile?: boolean; offset?: number; timestamp?: string } = {},
): SessionEventFrame {
  return {
    type: payload.type,
    seq: options.seq ?? 11,
    epoch: 'epoch-1',
    volatile: options.volatile,
    offset: options.offset,
    session_id: 'session_test',
    timestamp: options.timestamp ?? '2026-01-01T00:00:01.000Z',
    payload,
  };
}

describe('applyDelta', () => {
  it('appends at the exact cumulative offset', () => {
    expect(applyDelta('hel', 'lo', 3)).toEqual({ text: 'hello', gap: false });
  });
  it('rewrites the tail when the offset rewinds (idempotent re-send)', () => {
    expect(applyDelta('hello!', 'lo?', 3)).toEqual({ text: 'hello?', gap: false });
  });
  it('reports a gap when the offset jumps ahead', () => {
    expect(applyDelta('hel', 'lo', 10)).toEqual({ text: 'hel', gap: true });
  });
  it('appends when no offset is present', () => {
    expect(applyDelta('a', 'b', undefined)).toEqual({ text: 'ab', gap: false });
  });
});

describe('applySnapshot', () => {
  it('rebuilds user/assistant/tool blocks from messages and pairs results', () => {
    const messages: Message[] = [
      {
        id: 'm1',
        session_id: 'session_test',
        role: 'user',
        content: [{ type: 'text', text: 'run ls' }],
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'm2',
        session_id: 'session_test',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Sure.' },
          { type: 'tool_use', tool_call_id: 'tc1', tool_name: 'Bash', input: { command: 'ls' } },
        ],
        created_at: '2026-01-01T00:00:00.100Z',
      },
      {
        id: 'm3',
        session_id: 'session_test',
        role: 'tool',
        content: [{ type: 'tool_result', tool_call_id: 'tc1', output: 'file.txt' }],
        created_at: '2026-01-01T00:00:00.200Z',
      },
    ];
    const state = applySnapshot('session_test', snapshot({ messages: { items: messages, has_more: false } }));
    expect(state.cursor).toEqual({ seq: 10, epoch: 'epoch-1' });
    expect(state.blocks.map((b) => b.kind)).toEqual(['user', 'thinking', 'assistant', 'tool']);
    const tool = state.blocks[3] as ToolBlock;
    expect(tool.name).toBe('Bash');
    expect(tool.status).toBe('done');
    expect(tool.output).toBe('file.txt');
  });

  it('restores the session model and subagent roster metadata from a snapshot', () => {
    const state = applySnapshot(
      'session_test',
      snapshot({
        session: { ...session, agent_config: { model: 'provider/session-model' } },
        subagents: [
          {
            id: 'agent-1',
            session_id: 'session_test',
            kind: 'subagent',
            description: 'Inspect API limits',
            status: 'completed',
            subagent_phase: 'completed',
            subagent_type: 'explore',
            parent_agent_id: 'main',
            parent_tool_call_id: 'tool-parent',
            label: 'API researcher',
            tool_call_count: 4,
            created_at: '2026-01-01T00:00:00.000Z',
            completed_at: '2026-01-01T00:00:05.000Z',
          },
        ] as never,
      }),
    );

    expect(state.model).toBe('provider/session-model');
    const card = state.blocks.find(
      (block): block is import('./transcript').SubagentBlock => block.kind === 'subagent',
    );
    expect(card).toMatchObject({
      subagentId: 'agent-1',
      parentAgentId: 'main',
      label: 'API researcher',
      toolCallCount: 4,
    });
    expect(sessionAgentForestFromTranscript(state, undefined).byId['agent-1']).toMatchObject({
      parentAgentId: 'main',
      label: 'API researcher',
      toolCallCount: 4,
    });
  });

  it('renders the in-flight turn as streaming blocks and pending approvals', () => {
    const state = applySnapshot(
      'session_test',
      snapshot({
        in_flight_turn: {
          turn_id: 3,
          assistant_text: 'partial',
          thinking_text: '',
          running_tools: [
            { tool_call_id: 'tc9', name: 'Bash', args: { command: 'sleep 5' } },
          ],
          current_prompt_id: 'p1',
        },
        pending_approvals: [
          {
            approval_id: 'a1',
            session_id: 'session_test',
            tool_call_id: 'tc9',
            tool_name: 'Bash',
            action: 'Run command',
            tool_input_display: { kind: 'command', command: 'sleep 5' },
            created_at: '2026-01-01T00:00:00.000Z',
            expires_at: '2026-01-01T00:05:00.000Z',
          },
        ],
      }),
    );
    const kinds = state.blocks.map((b) => b.kind);
    expect(kinds).toEqual(['assistant', 'tool', 'approval']);
    expect((state.blocks[0] as AssistantBlock).streaming).toBe(true);
    expect((state.blocks[1] as ToolBlock).status).toBe('running');
    expect(pendingApprovalCount(state)).toBe(1);
    expect(state.activePromptId).toBe('p1');
  });
});

describe('agentTranscriptToBlocks', () => {
  it('projects server transcript frames through the shared block renderers', () => {
    const blocks = agentTranscriptToBlocks({
      agent_id: 'child-1',
      has_more: false,
      items: [
        {
          kind: 'turn',
          turnId: 'turn-1',
          prompt: 'Inspect the wire.',
          steps: [
            {
              stepId: 'step-1',
              frames: [
                { kind: 'thinking', frameId: 'think-1', text: 'Checking.' },
                {
                  kind: 'tool',
                  frameId: 'tool-frame-1',
                  toolCallId: 'tool-1',
                  name: 'Read',
                  state: 'done',
                  input: { path: 'events.ts' },
                  output: 'ok',
                },
                { kind: 'text', frameId: 'text-1', role: 'assistant', text: 'Report.' },
              ],
            },
          ],
        },
      ],
    });
    expect(blocks.map((block) => block.kind)).toEqual([
      'system',
      'thinking',
      'tool',
      'assistant',
    ]);
    expect((blocks[0] as SystemBlock).variant).toBe('task');
  });

  it('renders a mid-turn task notification frame as left-lane system, never You', () => {
    const steps = [
      {
        stepId: 'step-1',
        frames: [
          { kind: 'text', frameId: 'asst-1', role: 'assistant', text: 'Working on it.' },
          // Patched server shape: origin rides the frame.
          {
            kind: 'text',
            frameId: 'note-1',
            role: 'user',
            text: 'Background process completed\npnpm test — 42 passed',
            taskId: 'task_1',
            origin: { kind: 'task', taskId: 'task_1' },
          },
          // Pre-patch shape: taskId only, no origin — still not You.
          {
            kind: 'text',
            frameId: 'note-2',
            role: 'user',
            text: 'Background agent completed\nreview finished',
            taskId: 'task_2',
          },
          // Positive control: a plain user frame in the user turn stays You.
          { kind: 'text', frameId: 'steer-1', role: 'user', text: 'also update the docs' },
        ],
      },
    ];
    const blocks = agentTranscriptToBlocks({
      agent_id: 'main',
      has_more: false,
      items: [
        {
          kind: 'turn',
          turnId: 't1',
          prompt: 'Fix the flaky test.',
          origin: { kind: 'user' },
          steps,
        } as never,
      ],
    });
    expect(blocks.map((block) => block.kind)).toEqual([
      'user',
      'assistant',
      'system',
      'system',
      'user',
    ]);
    const systemBlocks = blocks.filter((block): block is SystemBlock => block.kind === 'system');
    expect(systemBlocks.map((block) => block.variant)).toEqual(['task', 'task']);
    expect(systemBlocks[0]?.text).toContain('Background process completed');
    expect(systemBlocks[1]?.text).toContain('review finished');
    expect((blocks[4] as UserBlock).text).toBe('also update the docs');
  });

  it('does not render splice undo/clear markers as notice copy', () => {
    const blocks = agentTranscriptToBlocks({
      agent_id: 'child-1',
      has_more: false,
      items: [
        { kind: 'marker', markerId: 'm-undo', marker: 'undo' },
        { kind: 'marker', markerId: 'm-clear', marker: 'clear' },
        { kind: 'marker', markerId: 'm-note', marker: 'notice', payload: { text: 'Hook ran' } } as never,
        {
          kind: 'turn',
          turnId: 'turn-1',
          prompt: 'Inspect the wire.',
          steps: [],
        },
      ],
    });
    expect(blocks.map((block) => block.kind)).toEqual(['notice', 'system']);
    expect(blocks.find((block) => block.kind === 'notice')?.text).toBe('Hook ran');
    expect(blocks.some((block) => block.kind === 'notice' && block.text === 'undo')).toBe(false);
  });

  it('classifies a user-origin child prompt as You when origin is present', () => {
    const blocks = agentTranscriptToBlocks({
      agent_id: 'child-1',
      has_more: false,
      items: [
        {
          kind: 'turn',
          turnId: 'turn-1',
          prompt: 'User asked this.',
          origin: { kind: 'user' },
          steps: [],
        } as never,
      ],
    });
    expect(blocks.map((block) => block.kind)).toEqual(['user']);
  });

  it('does not inherit a task/system-trigger turn origin onto later user frames', () => {
    const blocks = agentTranscriptToBlocks({
      agent_id: 'child-1',
      has_more: false,
      items: [
        {
          kind: 'turn',
          turnId: 'turn-1',
          prompt: 'Continue the child task.',
          origin: { kind: 'system_trigger', name: 'subagent' },
          steps: [
            {
              stepId: 'step-1',
              frames: [
                { kind: 'text', frameId: 'steer-1', role: 'user', text: 'inject now' },
                { kind: 'text', frameId: 'asst-1', role: 'assistant', text: 'ok' },
              ],
            },
          ],
        } as never,
      ],
    });
    expect(blocks.map((block) => block.kind)).toEqual(['system', 'user', 'assistant']);
    expect((blocks[0] as SystemBlock).text).toBe('Continue the child task.');
    expect((blocks[1] as UserBlock).text).toBe('inject now');
  });

  it('renders hook/compaction markers without payload as localized notices, not undo copy', () => {
    const blocks = agentTranscriptToBlocks({
      agent_id: 'child-1',
      has_more: false,
      items: [
        { kind: 'marker', markerId: 'm-hook', marker: 'hook' },
        { kind: 'marker', markerId: 'm-compact', marker: 'compaction' },
        { kind: 'marker', markerId: 'm-undo', marker: 'undo' },
      ],
    });
    expect(blocks.map((block) => block.kind)).toEqual(['notice', 'notice']);
    expect(blocks[0]).toMatchObject({ i18n: { key: 'transcript.marker.hook' } });
    expect(blocks[1]).toMatchObject({ i18n: { key: 'transcript.marker.compaction' } });
  });
});

describe('applyFrame', () => {
  it('streams assistant deltas with cumulative offsets and finalizes on turn end', () => {
    let state = applySnapshot('session_test', snapshot());
    const d1 = applyFrame(
      state,
      frame(
        { type: 'assistant.delta', turnId: 1, delta: 'Hello' },
        { volatile: true, offset: 0 },
      ),
    );
    state = d1.state;
    const d2 = applyFrame(
      state,
      frame(
        { type: 'assistant.delta', turnId: 1, delta: ' world', },
        { volatile: true, offset: 5 },
      ),
    );
    state = d2.state;
    let block = state.blocks[0] as AssistantBlock;
    expect(block.text).toBe('Hello world');
    expect(block.streaming).toBe(true);
    // Volatile frames do not advance the durable cursor.
    expect(state.cursor.seq).toBe(10);

    const ended = applyFrame(
      state,
      frame({ type: 'turn.ended', turnId: 1, reason: 'completed' }, { seq: 11 }),
    );
    state = ended.state;
    block = state.blocks[0] as AssistantBlock;
    expect(block.streaming).toBe(false);
    expect(state.cursor.seq).toBe(11);
  });

  it('applies each thinking delta as cumulative streaming text', () => {
    let state = applySnapshot('session_test', snapshot());

    state = applyFrame(
      state,
      frame(
        { type: 'thinking.delta', turnId: 1, delta: 'think' },
        { volatile: true, offset: 0 },
      ),
    ).state;
    expect(state.blocks.find((block) => block.kind === 'thinking')).toMatchObject({
      text: 'think',
      streaming: true,
    });

    state = applyFrame(
      state,
      frame(
        { type: 'thinking.delta', turnId: 1, delta: 'ing' },
        { volatile: true, offset: 5 },
      ),
    ).state;
    expect(state.blocks.find((block) => block.kind === 'thinking')).toMatchObject({
      text: 'thinking',
      streaming: true,
    });
  });

  it('flags a gap when a delta offset is ahead of the local text', () => {
    const state = applySnapshot('session_test', snapshot());
    const result = applyFrame(
      state,
      frame({ type: 'assistant.delta', turnId: 1, delta: 'x' }, { volatile: true, offset: 42 }),
    );
    expect(result.gapDetected).toBe(true);
  });

  it('drops durable duplicates at or below the cursor', () => {
    const state = applySnapshot('session_test', snapshot());
    const result = applyFrame(
      state,
      frame({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }, { seq: 10 }),
    );
    expect(result.state).toBe(state);
  });

  it('handles the approval lifecycle from any client', () => {
    let state = applySnapshot('session_test', snapshot());
    const requested = applyFrame(
      state,
      frame(
        {
          type: 'event.approval.requested',
          agentId: 'main',
          sessionId: 'session_test',
          approval_id: 'a1',
          session_id: 'session_test',
          tool_call_id: 'tc1',
          tool_name: 'Bash',
          action: 'Run echo',
          tool_input_display: { kind: 'command', command: 'echo hi' },
          created_at: '2026-01-01T00:00:00.000Z',
          expires_at: '2026-01-01T00:05:00.000Z',
        },
        { seq: 11 },
      ),
    );
    state = requested.state;
    expect(pendingApprovalCount(state)).toBe(1);
    expect(state.pendingInteraction).toBe('approval');

    // Resolved by another client (e.g. the TUI).
    const resolved = applyFrame(
      state,
      frame(
        {
          type: 'event.approval.resolved',
          agentId: 'main',
          sessionId: 'session_test',
          approval_id: 'a1',
          decision: 'approved',
          resolved_at: '2026-01-01T00:00:10.000Z',
        },
        { seq: 12 },
      ),
    );
    state = resolved.state;
    expect(pendingApprovalCount(state)).toBe(0);
    const block = state.blocks.find((b) => b.id === 'approval-a1') as ApprovalBlock;
    expect(block.resolution?.decision).toBe('approved');
  });

  it('marks approvals resolved locally (incl. expired / elsewhere outcomes)', () => {
    let state = applySnapshot('session_test', snapshot());
    state = applyFrame(
      state,
      frame(
        {
          type: 'event.approval.requested',
          agentId: 'main',
          sessionId: 'session_test',
          approval_id: 'a1',
          session_id: 'session_test',
          tool_call_id: 'tc1',
          tool_name: 'Bash',
          action: 'Run echo',
          tool_input_display: { kind: 'command', command: 'echo hi' },
          created_at: '2026-01-01T00:00:00.000Z',
          expires_at: '2026-01-01T00:05:00.000Z',
        },
        { seq: 11 },
      ),
    ).state;
    state = markApprovalResolved(state, 'a1', {
      decision: 'resolved_elsewhere',
      resolvedAt: '2026-01-01T00:00:05.000Z',
    });
    expect(pendingApprovalCount(state)).toBe(0);
  });

  it('dedupes the local echo against prompt.submitted', () => {
    let state = applySnapshot('session_test', snapshot());
    state = appendLocalUserMessage(state, {
      userMessageId: 'm1',
      promptId: 'p1',
      text: 'hi',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'running',
    });
    expect(state.blocks.filter((b) => b.kind === 'user')).toHaveLength(1);
    const result = applyFrame(
      state,
      frame(
        {
          type: 'prompt.submitted',
          promptId: 'p1',
          userMessageId: 'm1',
          status: 'running',
          content: [{ type: 'text', text: 'hi' }],
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        { seq: 11 },
      ),
    );
    state = result.state;
    expect(state.blocks.filter((b) => b.kind === 'user')).toHaveLength(1);
    expect(state.activePromptId).toBe('p1');
    expect(state.busy).toBe(true);
  });

  it('reconciles the real v2 turn.started-before-REST sequence by stable prompt identity', () => {
    let state = applySnapshot('session_test', snapshot());
    state = applyFrame(
      state,
      frame(
        {
          type: 'turn.started',
          turnId: 1,
          origin: { kind: 'user' },
          prompt: 'same prompt',
        },
        { seq: 11 },
      ),
    ).state;
    expect(state.blocks.filter((block) => block.kind === 'user')).toHaveLength(1);

    state = appendLocalUserMessage(state, {
      userMessageId: 'prompt-1',
      promptId: 'prompt-1',
      text: 'same prompt',
      createdAt: '2026-01-01T00:00:01.000Z',
      status: 'running',
    });
    const users = state.blocks.filter((block): block is UserBlock => block.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: 'user-prompt-1',
      promptId: 'prompt-1',
      userMessageId: 'prompt-1',
    });

    // A later prompt may intentionally repeat the same text; stable ids keep it.
    state = appendLocalUserMessage(state, {
      userMessageId: 'prompt-2',
      promptId: 'prompt-2',
      text: 'same prompt',
      createdAt: '2026-01-01T00:01:01.000Z',
      status: 'queued',
    });
    expect(state.blocks.filter((block) => block.kind === 'user')).toHaveLength(2);
  });

  it('routes child-agent tools into one subagent bubble and tracks goal updates', () => {
    let state = applySnapshot('session_test', snapshot());
    state = applyFrame(
      state,
      frame(
        {
          type: 'subagent.spawned',
          subagentId: 'child-1',
          subagentName: 'Researcher',
          parentToolCallId: 'parent-call',
          runInBackground: false,
          model: 'kimi-code/k3',
        },
        { seq: 11 },
      ),
    ).state;
    state = applyFrame(
      state,
      frame(
        {
          type: 'tool.call.started',
          agentId: 'child-1',
          sessionId: 'session_test',
          turnId: 1,
          toolCallId: 'child-tool',
          name: 'Read',
          args: { path: 'events.ts' },
        } as SessionEventFrame['payload'],
        { seq: 12 },
      ),
    ).state;
    state = applyFrame(
      state,
      frame(
        {
          type: 'goal.updated',
          snapshot: {
            goalId: 'goal-1',
            objective: 'Ship the UI',
            status: 'active',
            turnsUsed: 1,
            tokensUsed: 100,
            wallClockMs: 1000,
            budget: {
              tokenBudget: null,
              turnBudget: 4,
              wallClockBudgetMs: null,
              remainingTokens: null,
              remainingTurns: 3,
              remainingWallClockMs: null,
              tokenBudgetReached: false,
              turnBudgetReached: false,
              wallClockBudgetReached: false,
              overBudget: false,
            },
          },
        },
        { seq: 13 },
      ),
    ).state;

    expect(state.blocks.filter((block) => block.kind === 'tool')).toHaveLength(0);
    const subagent = state.blocks.find(
      (block): block is import('./transcript').SubagentBlock => block.kind === 'subagent',
    );
    expect(subagent?.model).toBe('kimi-code/k3');
    expect(subagent?.toolCallCount).toBe(1);
    expect(subagent?.transcript.some((block) => block.kind === 'tool')).toBe(true);
    expect(state.goal?.objective).toBe('Ship the UI');

    const afterResync = preserveCapturedSubagents(
      applySnapshot('session_test', snapshot({ as_of_seq: 20 })),
      state,
    );
    const preserved = afterResync.blocks.find(
      (block): block is import('./transcript').SubagentBlock => block.kind === 'subagent',
    );
    expect(preserved?.transcript.some((block) => block.kind === 'tool')).toBe(true);
  });

  it('collects tool calls from deltas through results', () => {
    let state = applySnapshot('session_test', snapshot());
    state = applyFrame(
      state,
      frame(
        { type: 'tool.call.delta', turnId: 1, toolCallId: 'tc1', name: 'Bash', argumentsPart: '{"command":"ec' },
        { volatile: true },
      ),
    ).state;
    state = applyFrame(
      state,
      frame(
        { type: 'tool.call.delta', turnId: 1, toolCallId: 'tc1', argumentsPart: 'ho hi"}' },
        { volatile: true },
      ),
    ).state;
    state = applyFrame(
      state,
      frame(
        {
          type: 'tool.call.started',
          turnId: 1,
          toolCallId: 'tc1',
          name: 'Bash',
          args: { command: 'echo hi' },
          display: { kind: 'command', command: 'echo hi' },
        },
        { seq: 11 },
      ),
    ).state;
    state = applyFrame(
      state,
      frame(
        { type: 'tool.result', turnId: 1, toolCallId: 'tc1', output: 'hi\n' },
        { seq: 12 },
      ),
    ).state;
    const tool = state.blocks.find((b) => b.id === 'tool-tc1') as ToolBlock;
    expect(tool.status).toBe('done');
    expect(tool.output).toBe('hi\n');
    expect(tool.durationMs).toBeTypeOf('number');
  });

  it('starts a fresh block at a step boundary instead of clobbering step text', () => {
    let state = applySnapshot('session_test', snapshot());
    state = applyFrame(
      state,
      frame({ type: 'assistant.delta', turnId: 1, delta: 'step one text' }, { volatile: true, offset: 0 }),
    ).state;
    state = applyFrame(
      state,
      frame({ type: 'turn.step.started', turnId: 1, step: 2 }, { seq: 11 }),
    ).state;
    // Next step's stream restarts its cumulative offsets at 0 (per wire spec).
    state = applyFrame(
      state,
      frame({ type: 'assistant.delta', turnId: 1, delta: 'step two' }, { volatile: true, offset: 0 }),
    ).state;
    const texts = state.blocks.filter((b) => b.kind === 'assistant').map((b) => b.text);
    expect(texts).toEqual(['step one text', 'step two']);
  });

  it('starts from an empty view state', () => {
    const state = createViewState('session_test');
    expect(state.loaded).toBe(false);
    expect(state.blocks).toHaveLength(0);
  });

  it('renders turn.started.prompt as a user block and dedupes prompt.submitted', () => {
    let state = applySnapshot('session_test', snapshot());
    state = applyFrame(
      state,
      frame({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'hello from turn' }, { seq: 11 }),
    ).state;
    const userBlocks = state.blocks.filter((b): b is UserBlock => b.kind === 'user');
    expect(userBlocks).toHaveLength(1);
    expect(userBlocks[0]!.text).toBe('hello from turn');

    state = applyFrame(
      state,
      frame(
        {
          type: 'prompt.submitted',
          promptId: 'p1',
          userMessageId: 'm1',
          status: 'running',
          content: [{ type: 'text', text: 'hello from turn' }],
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        { seq: 12 },
      ),
    ).state;
    expect(state.blocks.filter((b): b is UserBlock => b.kind === 'user')).toHaveLength(1);
  });
});

describe('prependOlderMessages', () => {
  it('reverses newest-first server pages to oldest-first display order', () => {
    let state = applySnapshot(
      'session_test',
      snapshot({
        messages: {
          items: [
            { id: 'm3', session_id: 'session_test', role: 'user', content: [{ type: 'text', text: 'three' }], created_at: '2026-01-01T00:00:02.000Z' },
          ],
          has_more: true,
        },
      }),
    );
    // Server returns newest-first older page: m2 then m1.
    state = prependOlderMessages(
      state,
      [
        { id: 'm2', session_id: 'session_test', role: 'user', content: [{ type: 'text', text: 'two' }], created_at: '2026-01-01T00:00:01.500Z' },
        { id: 'm1', session_id: 'session_test', role: 'user', content: [{ type: 'text', text: 'one' }], created_at: '2026-01-01T00:00:01.000Z' },
      ],
      false,
    );
    const texts = state.blocks
      .filter((b): b is UserBlock => b.kind === 'user')
      .map((b) => b.text);
    expect(texts).toEqual(['one', 'two', 'three']);
    expect(state.oldestMessageId).toBe('m1');
    expect(state.olderError).toBeUndefined();
  });

  it('clears an older-page error when a later page lands', () => {
    let state = applySnapshot(
      'session_test',
      snapshot({
        messages: {
          items: [
            { id: 'm3', session_id: 'session_test', role: 'user', content: [{ type: 'text', text: 'three' }], created_at: '2026-01-01T00:00:02.000Z' },
          ],
          has_more: true,
        },
      }),
    );
    state = setOlderError(state, 'Could not load earlier messages');
    expect(state.olderError).toBe('Could not load earlier messages');
    expect(state.hasMoreHistory).toBe(true);
    expect(state.fetchedOlder).toBe(false);

    state = prependOlderMessages(
      state,
      [{ id: 'm2', session_id: 'session_test', role: 'user', content: [{ type: 'text', text: 'two' }], created_at: '2026-01-01T00:00:01.500Z' }],
      false,
    );
    expect(state.olderError).toBeUndefined();
    expect(state.fetchedOlder).toBe(true);
  });
});

describe('setSessionRecord', () => {
  it('merges list-poll metadata without overwriting live busy/pending/activePromptId', () => {
    let state = applySnapshot(
      'session_test',
      snapshot({
        session: { ...session, title: 'Live', busy: true, pending_interaction: 'approval' },
        in_flight_turn: {
          turn_id: 4,
          current_prompt_id: 'p-live',
          assistant_text: 'working',
          thinking_text: '',
          running_tools: [],
        },
      }),
    );
    expect(state.busy).toBe(true);
    expect(state.pendingInteraction).toBe('approval');
    expect(state.activePromptId).toBe('p-live');

    const polled: Session = {
      ...session,
      title: 'Polled title',
      updated_at: '2026-01-01T00:05:00.000Z',
      busy: false,
      pending_interaction: 'none',
      usage: { ...session.usage, context_tokens: 42 },
    };
    state = setSessionRecord(state, polled);
    expect(state.session?.title).toBe('Polled title');
    expect(state.session?.usage.context_tokens).toBe(42);
    expect(state.busy).toBe(true);
    expect(state.pendingInteraction).toBe('approval');
    expect(state.activePromptId).toBe('p-live');
  });
});

describe('derivePendingInteraction', () => {
  it('stays on approval/question while unresolved blocks remain', () => {
    let state = applySnapshot('session_test', snapshot());
    state = applyFrame(
      state,
      frame(
        {
          type: 'event.approval.requested',
          agentId: 'main',
          sessionId: 'session_test',
          approval_id: 'a1',
          session_id: 'session_test',
          tool_call_id: 'tc1',
          tool_name: 'Bash',
          action: 'Run echo',
          tool_input_display: { kind: 'command', command: 'echo hi' },
          created_at: '2026-01-01T00:00:00.000Z',
          expires_at: '2026-01-01T00:05:00.000Z',
        },
        { seq: 11 },
      ),
    ).state;
    state = applyFrame(
      state,
      frame(
        {
          type: 'event.question.requested',
          agentId: 'main',
          sessionId: 'session_test',
          question_id: 'q1',
          session_id: 'session_test',
          turn_id: 1,
          tool_call_id: 'tc1',
          questions: [{ id: 'q1-1', question: 'OK?', options: [{ id: 'yes', label: 'Yes' }] }],
          created_at: '2026-01-01T00:00:00.000Z',
        },
        { seq: 12 },
      ),
    ).state;
    expect(derivePendingInteraction(state)).toBe('approval');

    state = markApprovalResolved(state, 'a1', { decision: 'approved', resolvedAt: '2026-01-01T00:00:10.000Z' });
    expect(derivePendingInteraction(state)).toBe('question');

    state = markQuestionOutcome(state, 'q1', { kind: 'answered', at: '2026-01-01T00:00:15.000Z' });
    expect(derivePendingInteraction(state)).toBe('none');
  });
});

describe('splitSystemReminders', () => {
  it('peels embedded envelopes out of the user-visible text', () => {
    const split = splitSystemReminders(
      'Fix the test.\n\n<system-reminder>\nFirst note.\n</system-reminder>\nMore words.\n<system-reminder>Second note.</system-reminder>',
    );
    expect(split.text).toBe('Fix the test.\n\nMore words.');
    expect(split.reminders).toEqual(['First note.', 'Second note.']);
  });

  it('leaves reminder-free text untouched', () => {
    const split = splitSystemReminders('plain words');
    expect(split).toEqual({ text: 'plain words', reminders: [] });
  });
});

describe('reminder peel', () => {
  it('renders the user bubble without reminder text and keeps the peel as blocks', () => {
    const state = applySnapshot(
      'session_test',
      snapshot({
        messages: {
          items: [
            {
              id: 'm1',
              session_id: 'session_test',
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Do the thing.\n\n<system-reminder>\nDaemon note one.\n</system-reminder>',
                },
              ],
              created_at: '2026-01-01T00:00:00.000Z',
            },
            {
              id: 'm2',
              session_id: 'session_test',
              role: 'user',
              content: [{ type: 'text', text: '<system-reminder>\nStandalone note.\n</system-reminder>' }],
              created_at: '2026-01-01T00:01:00.000Z',
            },
          ],
          has_more: false,
        },
      }),
    );
    const users = state.blocks.filter((b): b is UserBlock => b.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]!.text).toBe('Do the thing.');
    const reminders = state.blocks.filter((b): b is SystemReminderBlock => b.kind === 'system-reminder');
    expect(reminders.map((b) => b.text)).toEqual(['Daemon note one.', 'Standalone note.']);
  });
});

describe('prompt queue', () => {
  it('does not mint a placeholder when turn.started matches a queued echo', () => {
    let state = applySnapshot('session_test', snapshot());
    state = appendLocalUserMessage(state, {
      userMessageId: 'm1',
      promptId: 'p1',
      text: 'queued words',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'queued',
    });
    state = applyFrame(
      state,
      frame(
        { type: 'turn.started', turnId: 7, origin: { kind: 'user' }, prompt: 'queued words' },
        { seq: 11 },
      ),
    ).state;
    const users = state.blocks.filter((b): b is UserBlock => b.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ promptId: 'p1', promptStatus: 'queued' });
    expect(state.busy).toBe(true);
  });

  it('appends a same-text queued echo after the running turn instead of rewriting its prompt', () => {
    let state = applySnapshot('session_test', snapshot());
    state = applyFrame(
      state,
      frame(
        { type: 'turn.started', turnId: 7, origin: { kind: 'user' }, prompt: 'repeat this' },
        { seq: 11 },
      ),
    ).state;
    state = applyFrame(
      state,
      frame(
        { type: 'assistant.delta', turnId: 7, delta: 'working' },
        { volatile: true, offset: 0 },
      ),
    ).state;

    state = appendLocalUserMessage(state, {
      userMessageId: 'm-next',
      promptId: 'p-next',
      text: 'repeat this',
      createdAt: '2026-01-01T00:00:02.000Z',
      status: 'queued',
    });

    expect(state.blocks.map((block) => block.kind)).toEqual(['user', 'assistant', 'user']);
    const users = state.blocks.filter((block): block is UserBlock => block.kind === 'user');
    expect(users[0]).toMatchObject({
      id: 'user-turn-7-prompt',
      promptId: undefined,
      text: 'repeat this',
    });
    expect(users[1]).toMatchObject({
      id: 'user-m-next',
      promptId: 'p-next',
      promptStatus: 'queued',
    });
  });

  it('does not mint a placeholder when a stale reconcile cleared the echo status', () => {
    // The queued prompt ran and finished before any refresh saw it active;
    // the empty list reconcile clears the chip — turn.started must still not
    // duplicate the block (queue proof flake, placeholder + echo pair).
    let state = applySnapshot('session_test', snapshot());
    state = appendLocalUserMessage(state, {
      userMessageId: 'm1',
      promptId: 'p1',
      text: 'queued words',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'queued',
    });
    state = reconcilePromptList(state, { active: null, queued: [] });
    expect(state.blocks.find((b): b is UserBlock => b.kind === 'user')?.promptStatus).toBeUndefined();
    state = applyFrame(
      state,
      frame(
        { type: 'turn.started', turnId: 7, origin: { kind: 'user' }, prompt: 'queued words' },
        { seq: 11 },
      ),
    ).state;
    const users = state.blocks.filter((b): b is UserBlock => b.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ promptId: 'p1' });
  });

  it('still mints a placeholder for a genuinely new prompt text', () => {
    let state = applySnapshot('session_test', snapshot());
    state = appendLocalUserMessage(state, {
      userMessageId: 'm1',
      promptId: 'p1',
      text: 'older words',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'queued',
    });
    state = applyFrame(
      state,
      frame(
        { type: 'turn.started', turnId: 9, origin: { kind: 'user' }, prompt: 'brand new words' },
        { seq: 11 },
      ),
    ).state;
    const users = state.blocks.filter((b): b is UserBlock => b.kind === 'user');
    expect(users).toHaveLength(2);
    expect(users[1]).toMatchObject({ id: 'user-turn-9-prompt', text: 'brand new words' });
  });

  it('reconciles queued → running → drained from the server prompt list', () => {
    let state = applySnapshot('session_test', snapshot());
    state = appendLocalUserMessage(state, {
      userMessageId: 'm2',
      promptId: 'p2',
      text: 'parked',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'queued',
    });
    expect(state.queuedPromptIds).toEqual(['p2']);

    const runningItem = {
      prompt_id: 'p2',
      user_message_id: 'm2',
      status: 'running' as const,
      content: [{ type: 'text' as const, text: 'parked' }],
      created_at: '2026-01-01T00:00:00.000Z',
    };
    state = reconcilePromptList(state, { active: runningItem, queued: [] });
    expect(state.activePromptId).toBe('p2');
    expect(state.queuedPromptIds).toEqual([]);
    expect(state.busy).toBe(true);
    const block = state.blocks.find((b): b is UserBlock => b.kind === 'user');
    expect(block?.promptStatus).toBe('running');

    // Drained list: the chip clears and busy falls back to the turn state.
    state = reconcilePromptList(state, { active: null, queued: [] });
    expect(state.activePromptId).toBeUndefined();
    expect(state.blocks.find((b): b is UserBlock => b.kind === 'user')?.promptStatus).toBeUndefined();
  });

  it('keeps a stable block identity when the prompt status is unchanged', () => {
    let state = applySnapshot('session_test', snapshot());
    state = appendLocalUserMessage(state, {
      userMessageId: 'm3',
      promptId: 'p3',
      text: 'steady',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'running',
    });
    const before = state.blocks;
    state = reconcilePromptList(state, {
      active: {
        prompt_id: 'p3',
        user_message_id: 'm3',
        status: 'running',
        content: [{ type: 'text', text: 'steady' }],
        created_at: '2026-01-01T00:00:00.000Z',
      },
      queued: [],
    });
    expect(state.blocks).toBe(before);
  });
});

describe('queuedPromptPreviews', () => {
  it('returns queue-strip rows in drain order with the user-block preview text', () => {
    let state = applySnapshot('session_test', snapshot());
    state = appendLocalUserMessage(state, {
      userMessageId: 'm1',
      promptId: 'p1',
      text: 'first parked',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'queued',
    });
    state = appendLocalUserMessage(state, {
      userMessageId: 'm2',
      promptId: 'p2',
      text: 'second parked',
      createdAt: '2026-01-01T00:00:01.000Z',
      status: 'queued',
    });
    expect(queuedPromptPreviews(state)).toEqual([
      { promptId: 'p1', text: 'first parked' },
      { promptId: 'p2', text: 'second parked' },
    ]);
  });

  it('previews an empty string when the prompt block has not landed yet', () => {
    const state = {
      ...applySnapshot('session_test', snapshot()),
      queuedPromptIds: ['p9'],
    };
    expect(queuedPromptPreviews(state)).toEqual([{ promptId: 'p9', text: '' }]);
  });
});

describe('incrementSubagentToolCount', () => {
  it('mints a card for an unknown agent and counts exactly once per call', () => {
    let state = applySnapshot('session_test', snapshot());
    state = incrementSubagentToolCount(state, 'agent-x', '2026-01-01T00:00:01.000Z');
    state = incrementSubagentToolCount(state, 'agent-x', '2026-01-01T00:00:02.000Z');
    const cards = state.blocks.filter((b) => b.kind === 'subagent');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ subagentId: 'agent-x', toolCallCount: 2 });
  });
});

describe('preserveCapturedSubagents', () => {
  it('keeps an unchanged historical card reference and transcript anchor across resync', () => {
    const snapshotWithAgent = snapshot({
      messages: {
        items: [
          {
            id: 'm-user',
            session_id: 'session_test',
            role: 'user',
            content: [{ type: 'text', text: 'delegate this' }],
            created_at: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'm-assistant',
            session_id: 'session_test',
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            created_at: '2026-01-01T00:00:02.000Z',
          },
        ],
        has_more: false,
      },
      subagents: [
        {
          id: 'agent-1',
          session_id: 'session_test',
          kind: 'subagent',
          description: 'Inspect the change',
          status: 'completed',
          subagent_phase: 'completed',
          subagent_type: 'explore',
          parent_agent_id: 'main',
          parent_tool_call_id: 'call-1',
          created_at: '2026-01-01T00:00:01.000Z',
          completed_at: '2026-01-01T00:00:02.000Z',
        },
      ] as never,
    });
    const initial = applySnapshot('session_test', snapshotWithAgent);
    const card = initial.blocks.find(
      (block): block is import('./transcript').SubagentBlock => block.kind === 'subagent',
    )!;
    const previous = {
      ...initial,
      blocks: [initial.blocks[0]!, card, initial.blocks[1]!],
    };

    const preserved = preserveCapturedSubagents(
      applySnapshot('session_test', snapshotWithAgent),
      previous,
    );

    expect(preserved.blocks.map((block) => block.kind)).toEqual(['user', 'subagent', 'assistant']);
    expect(preserved.blocks[1]).toBe(card);
  });
});

describe('child-origin interactions', () => {
  const childApproval = {
    type: 'event.approval.requested',
    agentId: 'agent-x',
    sessionId: 'session_test',
    approval_id: 'a-child',
    session_id: 'session_test',
    turn_id: 1,
    tool_call_id: 'tc-1',
    tool_name: 'Bash',
    action: 'Run: rm -rf build',
    tool_input_display: { kind: 'command', command: 'rm -rf build' },
    created_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2026-01-01T01:00:00.000Z',
  } as const;

  it('a child approval lands on the main block list, tagged with its origin', () => {
    let state = applySnapshot('session_test', snapshot());
    state = applyFrame(state, frame(childApproval, { seq: 11 })).state;
    const approvals = state.blocks.filter((b): b is ApprovalBlock => b.kind === 'approval');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ originAgentId: 'agent-x', resolution: undefined });
    expect(state.pendingInteraction).toBe('approval');
    // And the resolution frame from any client clears it again.
    state = applyFrame(
      state,
      frame(
        {
          type: 'event.approval.resolved',
          agentId: 'agent-x',
          sessionId: 'session_test',
          approval_id: 'a-child',
          decision: 'approved',
          resolved_at: '2026-01-01T00:00:30.000Z',
        },
        { seq: 12 },
      ),
    ).state;
    expect((state.blocks[0] as ApprovalBlock).resolution?.decision).toBe('approved');
    expect(derivePendingInteraction(state)).toBe('none');
  });

  it('agentTranscriptToBlocks projects the interactions array into card blocks', () => {
    const blocks = agentTranscriptToBlocks({
      agent_id: 'agent-x',
      has_more: false,
      items: [],
      interactions: [
        {
          interactionId: 'a-pending',
          interactionKind: 'approval',
          toolCallId: 'tc-1',
          state: 'pending',
          request: {
            turnId: 1,
            toolCallId: 'tc-1',
            toolName: 'Bash',
            action: 'Run: rm -rf build',
            display: { kind: 'command', command: 'rm -rf build' },
          },
        },
        {
          interactionId: 'a-done',
          interactionKind: 'approval',
          state: 'approved',
          request: { toolName: 'Read', action: 'Read a file' },
        },
        {
          interactionId: 'q-1',
          interactionKind: 'question',
          state: 'pending',
          request: {
            questions: [
              { question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] },
            ],
          },
        },
      ],
    });
    const pending = blocks.find((b) => b.id === 'approval-a-pending');
    expect(pending).toMatchObject({
      kind: 'approval',
      originUnknown: true,
      resolution: undefined,
    });
    expect((pending as ApprovalBlock).originAgentId).toBeUndefined();
    expect((pending as ApprovalBlock).request.approval_id).toBe('a-pending');
    expect((pending as ApprovalBlock).request.tool_name).toBe('Bash');
    const done = blocks.find((b) => b.id === 'approval-a-done') as ApprovalBlock;
    expect(done.resolution).toMatchObject({ decision: 'approved' });
    const question = blocks.find((b) => b.id === 'question-q-1');
    expect(question).toMatchObject({ kind: 'question', outcome: undefined });
    expect((question as { request: { questions: { id: string; options: { id: string }[] }[] } }).request.questions[0]?.options).toHaveLength(2);
  });
});

describe('classifyTranscriptText', () => {
  it('prefers origin over role so internal user-role records are not You', () => {
    const classified = classifyTranscriptText({
      text: 'goal continuation',
      role: 'user',
      origin: { kind: 'system_trigger', name: 'goal_continuation' },
    });
    expect(classified.lane).toBe('system');
    expect(classified.systemVariant).toBe('system_trigger');
  });

  it('keeps user-slash skill activations on the skill lane', () => {
    const classified = classifyTranscriptText({
      text: 'SKILL.md body',
      role: 'user',
      origin: { kind: 'skill_activation', skillName: 'review', trigger: 'user-slash', skillArgs: 'src' },
    });
    expect(classified.lane).toBe('skill');
    expect(classified.skill).toEqual({ source: 'skill', name: 'review', args: 'src' });
  });

  it('falls back to shell envelopes when origin is missing', () => {
    const classified = classifyTranscriptText({
      text: '<bash-input>ls</bash-input>\n<bash-stdout>a.txt</bash-stdout>',
      role: 'user',
    });
    expect(classified.lane).toBe('shell');
    expect(classified.shell?.output).toContain('$ ls');
    expect(classified.shell?.output).toContain('a.txt');
  });

  it('treats background_task as internal, not You', () => {
    const classified = classifyTranscriptText({
      text: 'bg agent finished',
      role: 'user',
      origin: { kind: 'background_task', taskId: 't-1' },
    });
    expect(classified.lane).toBe('system');
    expect(classified.systemVariant).toBe('task');
  });

  it('drops unknown origin kinds onto the system lane', () => {
    const classified = classifyTranscriptText({
      text: 'mystery payload',
      role: 'user',
      origin: { kind: 'future_kind' },
    });
    expect(classified.lane).toBe('system');
    expect(classified.systemVariant).toBe('system');
  });

  it('unwraps other/payload and still refuses unknown nested kinds as You', () => {
    const classified = classifyTranscriptText({
      text: 'wrapped unknown',
      role: 'user',
      origin: { kind: 'other', payload: { kind: 'mystery' } },
    });
    expect(classified.lane).toBe('system');
  });

  it('keeps a missing-origin role=user message as You', () => {
    const classified = classifyTranscriptText({
      text: 'plain user words',
      role: 'user',
    });
    expect(classified.lane).toBe('you');
  });

  it('reclassifies an origin-less <notification> envelope as system/task, never You', () => {
    const classified = classifyTranscriptText({
      text: '<notification id="n1" category="task" type="task.completed" source_kind="background_task" source_id="task_1">\nTitle: Background process completed\npnpm test — 42 passed\n</notification>',
      role: 'user',
    });
    expect(classified.lane).toBe('system');
    expect(classified.systemVariant).toBe('task');
    expect(classified.text).not.toContain('<notification');
    expect(classified.text).toContain('pnpm test — 42 passed');
  });

  it('keeps prose merely mentioning notifications on the You lane', () => {
    const classified = classifyTranscriptText({
      text: 'please add a <notification> element to the settings page',
      role: 'user',
    });
    expect(classified.lane).toBe('you');
  });
});

describe('origin-aware snapshot', () => {
  it('renders injection and cron origins as left-lane system, not You', () => {
    const state = applySnapshot(
      'session_test',
      snapshot({
        messages: {
          items: [
            {
              id: 'm-user',
              session_id: 'session_test',
              role: 'user',
              content: [{ type: 'text', text: 'hello' }],
              created_at: '2026-01-01T00:00:00.000Z',
              metadata: { origin: { kind: 'user' } },
            },
            {
              id: 'm-inject',
              session_id: 'session_test',
              role: 'user',
              content: [{ type: 'text', text: 'injected date context' }],
              created_at: '2026-01-01T00:00:01.000Z',
              metadata: { origin: { kind: 'injection', variant: 'date' } },
            },
            {
              id: 'm-cron',
              session_id: 'session_test',
              role: 'user',
              content: [{ type: 'text', text: '<cron-fire job="nightly">run</cron-fire>' }],
              created_at: '2026-01-01T00:00:02.000Z',
              metadata: { origin: { kind: 'cron_job', jobId: 'nightly' } },
            },
            {
              id: 'm-skill',
              session_id: 'session_test',
              role: 'user',
              content: [{ type: 'text', text: 'full skill body' }],
              created_at: '2026-01-01T00:00:03.000Z',
              metadata: {
                origin: {
                  kind: 'skill_activation',
                  skillName: 'review',
                  trigger: 'user-slash',
                },
              },
            },
            {
              id: 'm-shell',
              session_id: 'session_test',
              role: 'user',
              content: [{ type: 'text', text: '<bash-input>pwd</bash-input><bash-stdout>/tmp</bash-stdout>' }],
              created_at: '2026-01-01T00:00:04.000Z',
              metadata: { origin: { kind: 'shell_command', phase: 'output' } },
            },
          ],
          has_more: false,
        },
      }),
    );
    expect(state.blocks.map((block) => block.kind)).toEqual([
      'user',
      'system',
      'system',
      'skill',
      'shell',
    ]);
    expect((state.blocks[1] as SystemBlock).variant).toBe('injection');
    expect((state.blocks[2] as SystemBlock).variant).toBe('cron_job');
    expect((state.blocks[3] as SkillBlock).name).toBe('review');
    expect((state.blocks[4] as { output: string }).output).toContain('$ pwd');
  });
});

describe('turn.started classification', () => {
  it('peels reminders instead of writing the raw prompt as You', () => {
    let state = applySnapshot('session_test', snapshot());
    state = applyFrame(
      state,
      frame(
        {
          type: 'turn.started',
          turnId: 3,
          origin: { kind: 'user' },
          prompt: 'Do the thing.\n\n<system-reminder>\nDaemon note.\n</system-reminder>',
        },
        { seq: 11 },
      ),
    ).state;
    const users = state.blocks.filter((block): block is UserBlock => block.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]!.text).toBe('Do the thing.');
    const reminders = state.blocks.filter(
      (block): block is SystemReminderBlock => block.kind === 'system-reminder',
    );
    expect(reminders.map((block) => block.text)).toEqual(['Daemon note.']);
  });

  it('does not mint a You bubble for a system-trigger turn prompt', () => {
    let state = applySnapshot('session_test', snapshot());
    state = applyFrame(
      state,
      frame(
        {
          type: 'turn.started',
          turnId: 4,
          origin: { kind: 'system_trigger', name: 'subagent' },
          prompt: 'Continue the child task.',
        },
        { seq: 11 },
      ),
    ).state;
    expect(state.blocks.filter((block) => block.kind === 'user')).toHaveLength(0);
    expect(state.blocks.filter((block) => block.kind === 'system')).toHaveLength(1);
  });
});

describe('prompt.steered', () => {
  it('converts a queued user block into an in-turn steer, not a tail You', () => {
    let state = applySnapshot('session_test', snapshot());
    state = appendLocalUserMessage(state, {
      userMessageId: 'm1',
      promptId: 'p1',
      text: 'first',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'running',
    });
    state = appendLocalUserMessage(state, {
      userMessageId: 'm2',
      promptId: 'p2',
      text: 'inject now',
      createdAt: '2026-01-01T00:00:01.000Z',
      status: 'queued',
    });
    state = applyFrame(
      state,
      frame({ type: 'assistant.delta', turnId: 1, delta: 'working' }, { volatile: true, offset: 0 }),
    ).state;
    state = applyFrame(
      state,
      frame(
        {
          type: 'prompt.steered',
          activePromptId: 'p1',
          promptIds: ['p2'],
          content: [{ type: 'text', text: 'inject now' }],
          steeredAt: '2026-01-01T00:00:02.000Z',
        },
        { seq: 11 },
      ),
    ).state;
    expect(state.queuedPromptIds).toEqual([]);
    const users = state.blocks.filter((block): block is UserBlock => block.kind === 'user');
    expect(users.map((block) => block.promptId)).toEqual(['p1']);
    const steers = state.blocks.filter((block): block is SteerBlock => block.kind === 'steer');
    expect(steers).toHaveLength(1);
    expect(steers[0]).toMatchObject({ promptId: 'p2', text: 'inject now', activePromptId: 'p1' });
    const kinds = state.blocks.map((block) => block.kind);
    expect(kinds.indexOf('steer')).toBeLessThan(kinds.indexOf('assistant'));
    expect(kinds.lastIndexOf('steer')).toBeLessThan(kinds.indexOf('assistant'));

    const rebuilt = applySnapshot(
      'session_test',
      snapshot({
        messages: {
          items: [
            {
              id: 'm1',
              session_id: 'session_test',
              role: 'user',
              content: [{ type: 'text', text: 'first' }],
              created_at: '2026-01-01T00:00:00.000Z',
              prompt_id: 'p1',
              metadata: { origin: { kind: 'user' } },
            },
            {
              id: 'm2',
              session_id: 'session_test',
              role: 'user',
              content: [{ type: 'text', text: 'inject now' }],
              created_at: '2026-01-01T00:00:01.000Z',
              prompt_id: 'p2',
              metadata: { origin: { kind: 'user' } },
            },
          ],
          has_more: false,
        },
      }),
    );
    const preserved = preserveCapturedSteers(rebuilt, state);
    expect(preserved.blocks.filter((block) => block.kind === 'user')).toHaveLength(1);
    expect(preserved.blocks.filter((block) => block.kind === 'steer')).toHaveLength(1);
    expect(preserved.blocks.find((block) => block.kind === 'steer')).toMatchObject({
      promptId: 'p2',
      text: 'inject now',
    });
  });

  it('re-anchors a steered prompt before later assistant text after resync', () => {
    const previous = {
      ...createViewState('session_test'),
      loaded: true,
      activePromptId: 'p1',
      blocks: [
        {
          kind: 'user',
          id: 'user-m1',
          text: 'first',
          createdAt: '2026-01-01T00:00:00.000Z',
          promptId: 'p1',
          userMessageId: 'm1',
        },
        {
          kind: 'steer',
          id: 'steer-p2',
          text: 'inject now',
          createdAt: '2026-01-01T00:00:02.000Z',
          promptId: 'p2',
          userMessageId: 'm2',
          activePromptId: 'p1',
        },
        {
          kind: 'assistant',
          id: 'assistant-live-1',
          text: 'working',
          streaming: false,
          createdAt: '2026-01-01T00:00:03.000Z',
        },
      ] as const,
    };
    const rebuilt = applySnapshot(
      'session_test',
      snapshot({
        messages: {
          items: [
            {
              id: 'm1',
              session_id: 'session_test',
              role: 'user',
              content: [{ type: 'text', text: 'first' }],
              created_at: '2026-01-01T00:00:00.000Z',
              prompt_id: 'p1',
              metadata: { origin: { kind: 'user' } },
            },
            {
              id: 'm-asst',
              session_id: 'session_test',
              role: 'assistant',
              content: [{ type: 'text', text: 'working' }],
              created_at: '2026-01-01T00:00:03.000Z',
            },
            {
              id: 'm2',
              session_id: 'session_test',
              role: 'user',
              content: [{ type: 'text', text: 'inject now' }],
              created_at: '2026-01-01T00:00:01.000Z',
              prompt_id: 'p2',
              metadata: { origin: { kind: 'user' } },
            },
          ],
          has_more: false,
        },
      }),
    );
    expect(rebuilt.blocks.map((block) => block.kind)).toEqual(['user', 'assistant', 'user']);
    const preserved = preserveCapturedSteers(rebuilt, previous);
    expect(preserved.blocks.map((block) => block.kind)).toEqual(['user', 'steer', 'assistant']);
    expect(preserved.blocks.find((block) => block.kind === 'steer')).toMatchObject({
      promptId: 'p2',
      text: 'inject now',
    });
  });

  it('does not convert a same-text user without matching prompt identity', () => {
    const previous = {
      ...createViewState('session_test'),
      loaded: true,
      activePromptId: 'p1',
      blocks: [
        {
          kind: 'user',
          id: 'user-m1',
          text: 'same words',
          createdAt: '2026-01-01T00:00:00.000Z',
          promptId: 'p1',
          userMessageId: 'm1',
        },
        {
          kind: 'steer',
          id: 'steer-p2',
          text: 'same words',
          createdAt: '2026-01-01T00:00:02.000Z',
          promptId: 'p2',
          userMessageId: 'm2',
          activePromptId: 'p1',
        },
      ] as const,
    };
    const rebuilt = applySnapshot(
      'session_test',
      snapshot({
        messages: {
          items: [
            {
              id: 'm1',
              session_id: 'session_test',
              role: 'user',
              content: [{ type: 'text', text: 'same words' }],
              created_at: '2026-01-01T00:00:00.000Z',
              prompt_id: 'p1',
              metadata: { origin: { kind: 'user' } },
            },
            {
              id: 'm2',
              session_id: 'session_test',
              role: 'user',
              content: [{ type: 'text', text: 'same words' }],
              created_at: '2026-01-01T00:00:01.000Z',
              prompt_id: 'p2',
              metadata: { origin: { kind: 'user' } },
            },
            {
              id: 'm3',
              session_id: 'session_test',
              role: 'user',
              content: [{ type: 'text', text: 'same words' }],
              created_at: '2026-01-01T00:00:04.000Z',
              prompt_id: 'p3',
              metadata: { origin: { kind: 'user' } },
            },
          ],
          has_more: false,
        },
      }),
    );
    const preserved = preserveCapturedSteers(rebuilt, previous);
    const users = preserved.blocks.filter((block): block is UserBlock => block.kind === 'user');
    const steers = preserved.blocks.filter((block): block is SteerBlock => block.kind === 'steer');
    expect(users.map((block) => block.promptId)).toEqual(['p1', 'p3']);
    expect(steers).toHaveLength(1);
    expect(steers[0]!.promptId).toBe('p2');
  });
});

describe('agent tree projections', () => {
  it('keeps parentAgentId from subagent.spawned on the live card', () => {
    let state = applySnapshot('session_test', snapshot());
    state = applyFrame(
      state,
      frame(
        {
          type: 'subagent.spawned',
          subagentId: 'agent-1',
          subagentName: 'Child',
          parentToolCallId: 'call-1',
          parentAgentId: 'main',
          runInBackground: false,
        },
        { seq: 11 },
      ),
    ).state;
    const card = state.blocks.find((block) => block.kind === 'subagent');
    expect(card).toMatchObject({
      subagentId: 'agent-1',
      parentAgentId: 'main',
      parentToolCallId: 'call-1',
    });
  });

  it('keeps agentRefs on REST tool frames so Agent/AgentSwarm stay navigable', () => {
    const blocks = agentTranscriptToBlocks({
      agent_id: 'main',
      has_more: false,
      items: [
        {
          kind: 'turn',
          turnId: 'turn-1',
          steps: [
            {
              stepId: 'step-1',
              frames: [
                {
                  kind: 'tool',
                  frameId: 'f-agent',
                  toolCallId: 'call-agent',
                  name: 'Agent',
                  state: 'done',
                  agentRefs: [{ agentId: 'agent-1', role: 'child' }],
                },
              ],
            },
          ],
        },
      ],
    });
    const tool = blocks.find((block) => block.kind === 'tool') as ToolBlock;
    expect(tool.agentRefs).toEqual([{ agentId: 'agent-1', role: 'child' }]);
  });

  it('does not invent an origin agent for cold REST interactions', () => {
    const blocks = agentTranscriptToBlocks({
      agent_id: 'agent-x',
      has_more: false,
      items: [],
      interactions: [
        { interactionId: 'a1', interactionKind: 'approval', state: 'pending' },
      ],
    });
    expect(blocks[0]).toMatchObject({ kind: 'approval', originUnknown: true });
    expect((blocks[0] as ApprovalBlock).originAgentId).toBeUndefined();
  });

  it('builds one forest from live cards plus the transcript roster', () => {
    let state = applySnapshot('session_test', snapshot());
    state = applyFrame(
      state,
      frame(
        {
          type: 'subagent.spawned',
          subagentId: 'agent-1',
          subagentName: 'Child',
          parentToolCallId: 'call-1',
          parentAgentId: 'main',
          runInBackground: false,
        },
        { seq: 11 },
      ),
    ).state;
    const forest = sessionAgentForestFromTranscript(state, {
      agent_id: 'main',
      has_more: false,
      items: [],
      agents: [
        { agentId: 'main', type: 'main' },
        { agentId: 'agent-1', type: 'sub', parentAgentId: 'main', label: 'Child' },
        { agentId: 'agent-2', type: 'sub', parentAgentId: 'agent-1', label: 'Grandchild' },
      ],
    });
    expect(forest.byId['main']!.childIds).toEqual(['agent-1']);
    expect(forest.byId['agent-1']!.childIds).toEqual(['agent-2']);
    const visible = filterBlocksToDirectChildren(
      [
        ...state.blocks,
        {
          kind: 'subagent',
          id: 'subagent-agent-2',
          subagentId: 'agent-2',
          parentAgentId: 'agent-1',
          parentToolCallId: 'call-2',
          name: 'Grandchild',
          description: undefined,
          model: undefined,
          thinkingEffort: undefined,
          status: 'completed',
          summary: undefined,
          error: undefined,
          startedAt: '2026-01-01T00:00:00.000Z',
          endedAt: '2026-01-01T00:00:01.000Z',
          toolCallCount: 0,
          transcript: [],
        },
      ],
      forest,
      'main',
    );
    expect(visible.filter((block) => block.kind === 'subagent').map((block) => block.subagentId)).toEqual([
      'agent-1',
    ]);
  });
});

describe('turn timing and interruption', () => {
  it('tracks turn timing anchors and records the turn tail on end', () => {
    let state = applySnapshot('session_test', snapshot());
    state = applyFrame(
      state,
      frame(
        { type: 'turn.started', turnId: 1, origin: { kind: 'user' } },
        { seq: 11, timestamp: '2026-01-01T00:00:10.000Z' },
      ),
    ).state;
    expect(state.busy).toBe(true);
    expect(state.turnStartedAt).toBe(Date.parse('2026-01-01T00:00:10.000Z'));
    expect(state.turnFirstTokenAt).toBeUndefined();
    expect(state.turnTail).toBeUndefined();

    state = applyFrame(
      state,
      frame(
        { type: 'assistant.delta', turnId: 1, delta: 'Hi' },
        { volatile: true, offset: 0, timestamp: '2026-01-01T00:00:11.500Z' },
      ),
    ).state;
    expect(state.turnFirstTokenAt).toBe(Date.parse('2026-01-01T00:00:11.500Z'));

    // A second delta does not move the first-token anchor.
    state = applyFrame(
      state,
      frame(
        { type: 'assistant.delta', turnId: 1, delta: ' there' },
        { volatile: true, offset: 2, timestamp: '2026-01-01T00:00:12.000Z' },
      ),
    ).state;
    expect(state.turnFirstTokenAt).toBe(Date.parse('2026-01-01T00:00:11.500Z'));

    state = applyFrame(
      state,
      frame(
        { type: 'turn.ended', turnId: 1, reason: 'completed', durationMs: 4200 },
        { seq: 12, timestamp: '2026-01-01T00:00:14.200Z' },
      ),
    ).state;
    expect(state.busy).toBe(false);
    expect(state.turnStartedAt).toBeUndefined();
    expect(state.turnFirstTokenAt).toBeUndefined();
    expect(state.turnTail).toEqual({
      turnId: '1',
      endedAt: '2026-01-01T00:00:14.200Z',
      durationMs: 4200,
      ttftMs: 1500,
    });
  });

  it('derives the run duration from frame timestamps when the wire omits durationMs', () => {
    let state = applySnapshot('session_test', snapshot());
    state = applyFrame(
      state,
      frame(
        { type: 'turn.started', turnId: 1, origin: { kind: 'user' } },
        { seq: 11, timestamp: '2026-01-01T00:00:10.000Z' },
      ),
    ).state;
    state = applyFrame(
      state,
      frame(
        { type: 'turn.ended', turnId: 1, reason: 'completed' },
        { seq: 12, timestamp: '2026-01-01T00:00:16.800Z' },
      ),
    ).state;
    expect(state.turnTail?.durationMs).toBe(6800);
    expect(state.turnTail?.ttftMs).toBeUndefined();
  });

  it('marks the cancelled turn’s last assistant message stopped and running tools stopped', () => {
    let state = applySnapshot('session_test', snapshot());
    state = applyFrame(
      state,
      frame({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }, { seq: 11 }),
    ).state;
    state = applyFrame(
      state,
      frame(
        { type: 'tool.call.started', turnId: 1, toolCallId: 'tc1', name: 'Bash', args: { command: 'sleep 60' } },
        { seq: 12 },
      ),
    ).state;
    state = applyFrame(
      state,
      frame({ type: 'assistant.delta', turnId: 1, delta: 'partial answer' }, { volatile: true, offset: 0 }),
    ).state;
    state = applyFrame(
      state,
      frame({ type: 'turn.ended', turnId: 1, reason: 'cancelled' }, { seq: 13 }),
    ).state;

    const tool = state.blocks.find((b) => b.kind === 'tool') as ToolBlock;
    expect(tool.status).toBe('stopped');
    const assistant = state.blocks.find((b) => b.kind === 'assistant') as AssistantBlock;
    expect(assistant.stopped).toBe(true);
    expect(assistant.streaming).toBe(false);
    expect(assistant.text).toBe('partial answer');
  });

  it('leaves no stopped markers on a completed turn', () => {
    let state = applySnapshot('session_test', snapshot());
    state = applyFrame(
      state,
      frame({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }, { seq: 11 }),
    ).state;
    state = applyFrame(
      state,
      frame({ type: 'assistant.delta', turnId: 1, delta: 'done' }, { volatile: true, offset: 0 }),
    ).state;
    state = applyFrame(
      state,
      frame({ type: 'turn.ended', turnId: 1, reason: 'completed' }, { seq: 12 }),
    ).state;
    const assistant = state.blocks.find((b) => b.kind === 'assistant') as AssistantBlock;
    expect(assistant.stopped).toBeUndefined();
  });
});

describe('system row producer label', () => {
  it('carries the origin detail onto the system block as source', () => {
    const state = applySnapshot(
      'session_test',
      snapshot({
        messages: {
          items: [
            {
              id: 'm-inject',
              session_id: 'session_test',
              role: 'user',
              content: [{ type: 'text', text: 'injected date context' }],
              created_at: '2026-01-01T00:00:01.000Z',
              metadata: { origin: { kind: 'injection', variant: 'date' } },
            },
          ],
          has_more: false,
        },
      }),
    );
    const sys = state.blocks[0] as SystemBlock;
    expect(sys.kind).toBe('system');
    expect(sys.variant).toBe('injection');
    expect(sys.source).toBe('date');
  });

  it('omits the source when the origin carries no usable detail', () => {
    const state = applySnapshot(
      'session_test',
      snapshot({
        messages: {
          items: [
            {
              id: 'm-compact',
              session_id: 'session_test',
              role: 'user',
              content: [{ type: 'text', text: 'summary of earlier context' }],
              created_at: '2026-01-01T00:00:01.000Z',
              metadata: { origin: { kind: 'compaction_summary' } },
            },
          ],
          has_more: false,
        },
      }),
    );
    const sys = state.blocks[0] as SystemBlock;
    expect(sys.kind).toBe('system');
    expect(sys.source).toBeUndefined();
  });
});
