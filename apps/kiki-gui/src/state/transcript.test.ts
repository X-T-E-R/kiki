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
  preserveCapturedSubagents,
  reconcilePromptList,
  splitSystemReminders,
  type AssistantBlock,
  type ApprovalBlock,
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
  options: { seq?: number; volatile?: boolean; offset?: number } = {},
): SessionEventFrame {
  return {
    type: payload.type,
    seq: options.seq ?? 11,
    epoch: 'epoch-1',
    volatile: options.volatile,
    offset: options.offset,
    session_id: 'session_test',
    timestamp: '2026-01-01T00:00:01.000Z',
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
      'user',
      'thinking',
      'tool',
      'assistant',
    ]);
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
    const texts = state.blocks.filter((b) => b.kind === 'assistant').map((b) => (b as AssistantBlock).text);
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
      originAgentId: 'agent-x',
      resolution: undefined,
    });
    expect((pending as ApprovalBlock).request.approval_id).toBe('a-pending');
    expect((pending as ApprovalBlock).request.tool_name).toBe('Bash');
    const done = blocks.find((b) => b.id === 'approval-a-done') as ApprovalBlock;
    expect(done.resolution).toMatchObject({ decision: 'approved' });
    const question = blocks.find((b) => b.id === 'question-q-1');
    expect(question).toMatchObject({ kind: 'question', outcome: undefined });
    expect((question as { request: { questions: { id: string; options: { id: string }[] }[] } }).request.questions[0]?.options).toHaveLength(2);
  });
});
