import { describe, expect, it } from 'vitest';

import type { Message, Session, SessionSnapshotResponse } from '@moonshot-ai/protocol';

import type { SessionEventFrame } from '../lib/types';
import {
  applyDelta,
  applyFrame,
  applySnapshot,
  appendLocalUserMessage,
  createViewState,
  markApprovalResolved,
  pendingApprovalCount,
  type AssistantBlock,
  type ApprovalBlock,
  type ToolBlock,
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
      queued: false,
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

  it('starts from an empty view state', () => {
    const state = createViewState('session_test');
    expect(state.loaded).toBe(false);
    expect(state.blocks).toHaveLength(0);
  });
});
