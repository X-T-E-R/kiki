import { describe, expect, it } from 'vitest';

import {
  editMessageRequestSchema,
  getMessageResponseSchema,
  listMessagesQuerySchema,
  listMessagesResponseSchema,
  regenerateMessageRequestSchema,
} from '../rest/message';
import {
  promptAbortResponseSchema,
  promptListResponseSchema,
  promptMoveRequestSchema,
  promptMoveResultSchema,
  promptReplaceRequestSchema,
  promptReplaceResultSchema,
  promptSteerRequestSchema,
  promptSteerResultSchema,
  promptSteerSubmissionRequestSchema,
  promptSubmissionSchema,
  promptSubmitResultSchema,
  promptTimingRequestSchema,
  promptTimingResultSchema,
} from '../rest/prompt';
import { activateSkillRequestSchema } from '../rest/skill';

describe('promptSubmissionSchema', () => {
  it('normalizes inline image_url data on submission and content steering', () => {
    const input = { agent_id: 'example-child', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } }] };
    const normalized = { agent_id: 'example-child', content: [{ type: 'image', source: { kind: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }] };
    expect(promptSubmissionSchema.parse(input)).toEqual(normalized);
    expect(promptSteerSubmissionRequestSchema.parse(input)).toEqual(normalized);
    for (const url of ['file:///example.png', 'https://example.test/image.png', 'data:image/png;base64,', 'data:image/png;base64,@@', 'data:text/plain;base64,aW1hZ2U=']) {
      expect(promptSubmissionSchema.safeParse({ content: [{ type: 'image_url', image_url: { url } }] }).success).toBe(false);
    }
  });

  it.each(['engine-default', 'specialist', null])(
    'carries native agent %s through public executor selection',
    (nativeAgent) => {
      const input = {
        content: [{ type: 'text', text: 'Neutral task' }],
        execution: { executor: 'neutral-harness', overrides: { native_agent: nativeAgent, inject_kiki_mcp: false } },
      };
      expect(promptSubmissionSchema.parse(input)).toEqual(input);
      expect(
        promptSubmissionSchema.safeParse({ ...input, execution: { executor: 'neutral-harness', overrides: { native_agent: ' ' } } }).success,
      ).toBe(false);
    },
  );

  it('preserves immediate delivery intent and distinguishes admission from steering', () => {
    const body = { admission: 'durable', delivery_mode: 'steer', prompt_id: 'immediate-example', content: [{ type: 'text', text: 'Apply this note.' }] };
    expect(promptSubmissionSchema.parse(body)).toEqual(body);
    expect(promptSubmissionSchema.safeParse({ ...body, delivery_mode: 'unknown' }).success).toBe(false);
    const receipt = {
      prompt_id: body.prompt_id,
      user_message_id: body.prompt_id,
      status: 'queued',
      admission: 'admitted',
      delivery_state: 'steered',
      content: body.content,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    expect(promptSubmitResultSchema.parse(receipt)).toEqual(receipt);
  });

  it('distinguishes null thinking (restore default) from omitted thinking and invalid values', () => {
    const cleared = promptSubmissionSchema.parse({ content: [{ type: 'text', text: 'hi' }], thinking: null });
    expect(cleared.thinking).toBeNull();
    const kept = promptSubmissionSchema.parse({ content: [{ type: 'text', text: 'hi' }] });
    expect(kept.thinking).toBeUndefined();
    expect(kept.model).toBeUndefined();
    expect(kept.permission_mode).toBeUndefined();
    expect(kept.plan_gate).toBeUndefined();
    expect(kept.plan_mode).toBeUndefined();
    expect(promptSubmissionSchema.safeParse({ content: [{ type: 'text', text: 'hi' }], thinking: 'mega' }).success).toBe(true);
    expect(promptSubmissionSchema.safeParse({ content: [{ type: 'text', text: 'hi' }], thinking: '' }).success).toBe(false);
  });

  it.each([
    ['model switch mode', { content: [{ type: 'text', text: 'Continue.' }], model: 'example/model', thinking: 'high', model_switch_mode: 'compact' }],
    ['bundled skill input', { content: [{ type: 'text', text: '/kiki-ops Help.' }], model: 'example/model', thinking: 'high', skills: [{ name: 'kiki-ops', args: 'Help.' }] }],
    ['after_model_switch', { content: [{ type: 'text', text: 'continue' }], after_model_switch: 'switch-1' }],
    ['metadata', { content: [{ type: 'text', text: 'hi' }], metadata: { source: 'cli' } }],
    ['timing and goal controls', { content: [{ type: 'text', text: 'hi' }], append_timing: 'tasks_done', goal_follow_up_timing: 'subagents_done', goal_initial_status: 'paused' }],
    ['image + text content', { content: [{ type: 'text', text: 'see attached' }, { type: 'image', source: { kind: 'url', url: 'https://a.png' } }] }],
    ['video + text content', { content: [{ type: 'text', text: 'describe' }, { type: 'video', source: { kind: 'url', url: 'https://example.com/a.mp4' } }] }],
    ['profile + partial model', { content: [{ type: 'text', text: 'hi' }], profile: 'reviewer', model: 'kimi-code/k2' }],
    ['full control bundle', { content: [{ type: 'text', text: 'hi' }], model: 'kimi-code/k2', thinking: 'off', permission_mode: 'manual', plan_gate: 'gated', plan_mode: false, prompt_id: 'client-prompt-1' }],
  ] as const)('accepts %s', (_label, payload) => {
    expect(promptSubmissionSchema.parse(payload)).toEqual(payload);
  });

  it.each([
    ['unknown model_switch_mode', { content: [{ type: 'text', text: 'hi' }], model_switch_mode: 'unknown' }],
    ['empty skills array', { content: [{ type: 'text', text: 'hi' }], skills: [] }],
    ['empty skill name', { content: [{ type: 'text', text: 'hi' }], skills: [{ name: '' }] }],
    ['empty after_model_switch', { content: [{ type: 'text', text: 'hi' }], after_model_switch: '' }],
    ['unknown append_timing', { content: [{ type: 'text', text: 'hi' }], append_timing: 'immediate' }],
    ['agent_idle goal_follow_up_timing', { content: [{ type: 'text', text: 'hi' }], goal_follow_up_timing: 'agent_idle' }],
    ['empty profile', { content: [{ type: 'text', text: 'hi' }], profile: '' }],
    ['empty prompt_id', { content: [{ type: 'text', text: 'hi' }], prompt_id: '' }],
    ['empty content array', { content: [] }],
    ['missing content', {}],
    ['unknown permission_mode', { content: [{ type: 'text', text: 'hi' }], permission_mode: 'unrestricted' }],
    ['unknown plan_gate', { content: [{ type: 'text', text: 'hi' }], plan_gate: 'automatic' }],
    ['empty model', { content: [{ type: 'text', text: 'hi' }], model: '' }],
  ] as const)('rejects %s', (_label, payload) => {
    expect(promptSubmissionSchema.safeParse(payload).success).toBe(false);
  });
});

describe('prompt lifecycle & list schemas', () => {
  it.each(['running', 'blocked'] as const)('parses %s promptSubmitResult', (status) => {
    const parsed = promptSubmitResultSchema.parse({
      prompt_id: `prompt_${status}`,
      user_message_id: `msg_${status}`,
      status,
      content: [{ type: 'text', text: status }],
      created_at: '2026-06-09T00:00:00.000Z',
    });
    expect(parsed.status).toBe(status);
  });

  it('rejects empty prompt_id on promptSubmitResult', () => {
    expect(promptSubmitResultSchema.safeParse({ prompt_id: '', user_message_id: 'msg' }).success).toBe(false);
  });

  it('preserves opaque origins on list while stripping origin from submission', () => {
    const origins = [
      { kind: 'merged', origins: [{ kind: 'user', skillActivations: [{ skillName: 'review' }] }, { kind: 'task_notification', taskId: 'example-task' }] },
      { kind: 'unknown' },
      { kind: 'external_thread', messageId: 'example-message' },
      { kind: 'system_trigger', name: 'thread_create' },
      { kind: 'future_source', opaque: true },
    ];
    for (const origin of origins) {
      const item = { prompt_id: 'p-source', user_message_id: 'm-source', status: 'queued', origin, content: [{ type: 'text', text: 'payload' }], created_at: '2026-06-09T00:00:00.000Z' };
      expect(promptListResponseSchema.parse({ active: null, queued: [item] }).queued[0]?.origin).toEqual(origin);
      expect(promptSubmissionSchema.parse({ content: item.content, origin })).not.toHaveProperty('origin');
    }

    const list = promptListResponseSchema.parse({
      active: { prompt_id: 'prompt_active', user_message_id: 'msg_active', status: 'running', content: [{ type: 'text', text: 'active' }], created_at: '2026-06-09T00:00:00.000Z' },
      queued: [{ prompt_id: 'prompt_queued', user_message_id: 'msg_queued', status: 'queued', content: [{ type: 'text', text: 'queued' }], created_at: '2026-06-09T00:00:01.000Z' }],
      recovery_hold: { reason: 'recovery', count: 1 },
    });
    expect(list.active?.status).toBe('running');
    expect(list.queued[0]?.status).toBe('queued');
    expect(list.recovery_hold).toEqual({ reason: 'recovery', count: 1 });
  });

  it('validates prompt replace, move, steer, abort, and timing operations', () => {
    expect(promptReplaceRequestSchema.parse({ content: [{ type: 'text', text: 'replacement' }], replace_attachments: true }))
      .toEqual({ content: [{ type: 'text', text: 'replacement' }], replace_attachments: true });
    expect(promptReplaceRequestSchema.safeParse({ content: [] }).success).toBe(false);
    expect(
      promptReplaceResultSchema.parse({
        prompt_id: 'prompt_queued',
        user_message_id: 'prompt_queued',
        status: 'queued',
        content: [{ type: 'text', text: 'replacement' }],
        created_at: '2026-06-09T00:00:01.000Z',
      }),
    ).toMatchObject({ prompt_id: 'prompt_queued', status: 'queued' });

    expect(promptMoveRequestSchema.parse({ target_index: 1 })).toEqual({ target_index: 1 });
    expect(promptMoveRequestSchema.safeParse({ target_index: -1 }).success).toBe(false);
    expect(promptMoveResultSchema.parse({ moved: true, prompt_id: 'prompt_b', target_index: 0, queued_prompt_ids: ['prompt_b', 'prompt_a'] }))
      .toEqual({ moved: true, prompt_id: 'prompt_b', target_index: 0, queued_prompt_ids: ['prompt_b', 'prompt_a'] });

    expect(promptSteerRequestSchema.parse({ prompt_ids: ['prompt_a'] }).prompt_ids).toEqual(['prompt_a']);
    expect(promptSteerRequestSchema.safeParse({ prompt_ids: [] }).success).toBe(false);
    expect(
      promptSteerResultSchema.parse({ steered: true, prompt_ids: ['prompt_a', 'prompt_b'], delivery_state: 'queued', delivery_reason: 'executor_deferred' }),
    ).toMatchObject({ steered: true, delivery_reason: 'executor_deferred' });

    expect(promptAbortResponseSchema.parse({ aborted: true, at_seq: 7 })).toEqual({ aborted: true, at_seq: 7 });
    expect(promptAbortResponseSchema.parse({ aborted: false })).toEqual({ aborted: false });

    expect(promptTimingRequestSchema.parse({ append_timing: 'subagents_done' })).toEqual({ append_timing: 'subagents_done' });
    expect(promptTimingRequestSchema.parse({ append_timing: 'agent_idle', expected_revision: 2 }))
      .toEqual({ append_timing: 'agent_idle', expected_revision: 2 });
    for (const bad of [{}, { append_timing: 'later' }, { append_timing: 'agent_idle', expected_revision: -1 }]) {
      expect(promptTimingRequestSchema.safeParse(bad).success).toBe(false);
    }
    expect(
      promptTimingResultSchema.parse({
        prompt_id: 'prompt_queued',
        user_message_id: 'prompt_queued',
        status: 'queued',
        content: [{ type: 'text', text: 'queued' }],
        created_at: '2026-06-09T00:00:01.000Z',
        append_timing: 'tasks_done',
        revision: 3,
      }),
    ).toMatchObject({ append_timing: 'tasks_done', revision: 3 });
  });
});

describe('skill activation & message REST schemas', () => {
  it('validates activateSkillRequestSchema targets and rejects empty ids', () => {
    const input = {
      agent_id: 'child-1',
      prompt_id: 'skill-1',
      after_model_switch: 'switch-1',
      args: '--fix',
      user_input: '/review --fix',
      attachments: [{ type: 'file' as const, file_id: 'file-1', name: 'notes.txt', media_type: 'text/plain', size: 5 }],
    };
    expect(activateSkillRequestSchema.parse(input)).toEqual(input);
    expect(activateSkillRequestSchema.parse({})).toEqual({});
    expect(activateSkillRequestSchema.parse({ agent_id: 'main' })).toEqual({ agent_id: 'main' });
    expect(activateSkillRequestSchema.safeParse({ agent_id: '' }).success).toBe(false);
    expect(activateSkillRequestSchema.safeParse({ after_model_switch: '' }).success).toBe(false);
  });

  it('validates message list queries, rejects mutually exclusive cursors, and parses pages', () => {
    expect(listMessagesQuerySchema.parse({})).toEqual({});
    expect(listMessagesQuerySchema.parse({ before_id: 'msg_abc', page_size: 25, role: 'assistant' }))
      .toEqual({ before_id: 'msg_abc', page_size: 25, role: 'assistant' });
    for (const bad of [{ before_id: 'a', after_id: 'b' }, { page_size: 101 }, { role: 'critter' }]) {
      expect(listMessagesQuerySchema.safeParse(bad).success).toBe(false);
    }

    expect(listMessagesResponseSchema.parse({ items: [], has_more: false })).toEqual({ items: [], has_more: false });
    const msg = {
      id: 'msg_01',
      session_id: 'sess_1',
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'hi' }],
      created_at: '2026-06-04T10:30:00.000Z',
    };
    expect(listMessagesResponseSchema.parse({ items: [msg], has_more: true }).has_more).toBe(true);
    expect(getMessageResponseSchema.parse({ ...msg, role: 'assistant', prompt_id: 'prompt_01' }).prompt_id).toBe('prompt_01');
  });

  it('validates message edit/regenerate actions and rejects non-editable parts or missing cursors', () => {
    const expected_cursor = { seq: 12, epoch: 'ep_test' };
    expect(
      editMessageRequestSchema.parse({
        content: [{ type: 'text', text: 'replacement' }],
        model: 'example-model',
        plan_mode: true,
        expected_cursor,
      }),
    ).toMatchObject({ model: 'example-model', plan_mode: true, expected_cursor });

    expect(
      editMessageRequestSchema.safeParse({ content: [{ type: 'thinking', thinking: 'hidden' }], expected_cursor }).success,
    ).toBe(false);
    expect(regenerateMessageRequestSchema.safeParse({}).success).toBe(false);
  });
});
