import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isVolatileEventType, VOLATILE_EVENT_TYPES } from '../events';
import {
  inFlightTurnSchema,
  sessionSnapshotResponseSchema,
  snapshotSubagentSchema,
} from '../rest/snapshot';

const TS = '2026-06-11T10:30:00.000Z';
const PRE_C_SNAPSHOT_SUBAGENT_SCHEMA = z
  .object({
    id: z.string().min(1),
    session_id: z.string().min(1),
    kind: z.enum(['subagent', 'bash', 'tool']),
    description: z.string(),
    status: z.enum(['running', 'completed', 'failed', 'cancelled']),
    created_at: z.string(),
    subagent_phase: z.enum(['queued', 'working', 'suspended', 'completed', 'failed']).optional(),
  })
  .passthrough();

const SESSION = {
  id: 'sess_1',
  workspace_id: 'wd_demo_0123456789ab',
  title: 'demo',
  created_at: TS,
  updated_at: TS,
  busy: true,
  metadata: { cwd: '/tmp/demo' },
  agent_config: { model: 'kimi' },
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
  message_count: 2,
  last_seq: 12,
};

describe('rest/snapshot — session snapshot', () => {
  it('parses a full snapshot with step-owned in-flight text', () => {
    const result = sessionSnapshotResponseSchema.safeParse({
      as_of_seq: 12,
      epoch: 'ep_01ABC',
      session: SESSION,
      messages: {
        items: [
          {
            id: 'msg_sess_1_000000',
            session_id: 'sess_1',
            role: 'user',
            content: [{ type: 'text', text: 'hi' }],
            created_at: TS,
          },
        ],
        has_more: false,
      },
      in_flight_turn: {
        turn_id: 3,
        step: 2,
        step_id: 'step_01KV589KCS5PG9ZYDNP8KFDQHZ',
        assistant_text: 'partial answer…',
        thinking_text: '',
        running_tools: [
          {
            tool_call_id: 'call_1',
            name: 'Bash',
            args: { command: 'ls' },
            last_progress: { kind: 'stdout', text: 'src\n' },
          },
        ],
      },
      pending_approvals: [],
      pending_questions: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.in_flight_turn).toMatchObject({
        step: 2,
        step_id: 'step_01KV589KCS5PG9ZYDNP8KFDQHZ',
      });
    }
  });

  it('parses an idle snapshot (no in-flight turn)', () => {
    const result = sessionSnapshotResponseSchema.safeParse({
      as_of_seq: 0,
      epoch: 'ep_01ABC',
      session: SESSION,
      messages: { items: [], has_more: false },
      in_flight_turn: null,
      pending_approvals: [],
      pending_questions: [],
    });
    expect(result.success).toBe(true);
  });

  it('parses an in-flight turn with current_prompt_id', () => {
    const result = sessionSnapshotResponseSchema.safeParse({
      as_of_seq: 12,
      epoch: 'ep_01ABC',
      session: SESSION,
      messages: { items: [], has_more: false },
      in_flight_turn: {
        turn_id: 3,
        assistant_text: 'partial answer…',
        thinking_text: '',
        running_tools: [],
        current_prompt_id: 'prompt_01KV589KCS5PG9ZYDNP8KFDQHZ',
      },
      pending_approvals: [],
      pending_questions: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.in_flight_turn?.current_prompt_id).toBe(
        'prompt_01KV589KCS5PG9ZYDNP8KFDQHZ',
      );
      expect(result.data.in_flight_turn?.step).toBeUndefined();
      expect(result.data.in_flight_turn?.step_id).toBeUndefined();
    }
  });

  it('parses a snapshot with a subagent roster', () => {
    const result = sessionSnapshotResponseSchema.safeParse({
      as_of_seq: 12,
      epoch: 'ep_01ABC',
      session: SESSION,
      messages: { items: [], has_more: false },
      in_flight_turn: null,
      subagents: [
        {
          id: 'agent_1',
          session_id: 'sess_1',
          kind: 'subagent',
          description: 'explore the auth flow',
          status: 'running',
          created_at: TS,
          started_at: TS,
          subagent_phase: 'working',
          subagent_type: 'explore',
          parent_tool_call_id: 'call_1',
          swarm_index: 0,
          run_in_background: false,
        },
        {
          id: 'agent_2',
          session_id: 'sess_1',
          kind: 'subagent',
          description: 'write tests',
          status: 'completed',
          created_at: TS,
          completed_at: TS,
          output_preview: 'done',
          subagent_phase: 'completed',
          swarm_index: 1,
        },
        {
          id: 'agent_3',
          session_id: 'sess_1',
          kind: 'subagent',
          description: 'cancelled task',
          status: 'cancelled',
          created_at: TS,
          completed_at: TS,
        },
      ],
      pending_approvals: [],
      pending_questions: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subagents).toHaveLength(3);
      expect(result.data.subagents?.[0]?.parent_tool_call_id).toBe('call_1');
      expect(result.data.subagents?.[1]?.subagent_phase).toBe('completed');
      expect(result.data.subagents?.[2]?.status).toBe('cancelled');
      expect(result.data.subagents?.[2]?.subagent_phase).toBeUndefined();
      for (const row of result.data.subagents ?? []) {
        expect(PRE_C_SNAPSHOT_SUBAGENT_SCHEMA.safeParse(row).success).toBe(true);
      }
    }
  });

  it('rejects unnegotiated unknown and cancelled phase enum values', () => {
    const base = {
      id: 'agent_1',
      session_id: 'sess_1',
      kind: 'subagent' as const,
      description: 'legacy relation',
      created_at: TS,
    };
    expect(
      snapshotSubagentSchema.safeParse({
        ...base,
        status: 'unknown',
        subagent_phase: 'unknown',
      }).success,
    ).toBe(false);
    expect(
      snapshotSubagentSchema.safeParse({
        ...base,
        status: 'cancelled',
        subagent_phase: 'cancelled',
      }).success,
    ).toBe(false);
  });

  it('rejects a snapshot missing the watermark', () => {
    const result = sessionSnapshotResponseSchema.safeParse({
      epoch: 'ep_01ABC',
      session: SESSION,
      messages: { items: [], has_more: false },
      in_flight_turn: null,
      pending_approvals: [],
      pending_questions: [],
    });
    expect(result.success).toBe(false);
  });

  it('in_flight_turn requires accumulated text fields', () => {
    expect(
      inFlightTurnSchema.safeParse({ turn_id: 1, running_tools: [] }).success,
    ).toBe(false);
  });
});

describe('events — volatile classification', () => {
  it('classifies stream fragments and periodic status as volatile', () => {
    for (const type of [
      'assistant.delta',
      'thinking.delta',
      'tool.call.delta',
      'tool.progress',
      'shell.output',
      'shell.started',
      'shell.completed',
      'agent.status.updated',
      'event.capability.changed',
    ]) {
      expect(isVolatileEventType(type)).toBe(true);
    }
    expect(VOLATILE_EVENT_TYPES).toHaveLength(9);
  });

  it('keeps timeline-bearing events durable', () => {
    for (const type of [
      'turn.started',
      'turn.ended',
      'tool.call.started',
      'tool.result',
      'session.meta.updated',
      'error',
    ]) {
      expect(isVolatileEventType(type)).toBe(false);
    }
  });
});
