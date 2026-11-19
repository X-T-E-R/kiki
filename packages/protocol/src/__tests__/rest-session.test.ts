import { describe, expect, it } from 'vitest';

import {
  archiveSessionResponseSchema,
  compactSessionRequestSchema,
  compactSessionResponseSchema,
  createSessionChildRequestSchema,
  createSessionChildResponseSchema,
  createSessionRequestSchema,
  exportSessionParamsSchema,
  exportSessionRequestSchema,
  forkSessionRequestSchema,
  forkSessionResponseSchema,
  getSessionProfileResponseSchema,
  listSessionChildrenQuerySchema,
  listSessionChildrenResponseSchema,
  listSessionsQuerySchema,
  restoreSessionResponseSchema,
  sessionStatusResponseSchema,
  undoSessionRequestSchema,
  undoSessionResponseSchema,
  updateSessionProfileRequestSchema,
  updateSessionRequestSchema,
} from '../rest/session';

function makeSessionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess_abc',
    workspace_id: 'wd_kimi_0123456789ab',
    title: 'Profile',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    busy: true,
    metadata: { cwd: '/tmp/foo' },
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
    ...overrides,
  };
}

describe('session export & creation schemas', () => {
  it('validates export params, web_log UTF-8 byte limits, and desktop flag', () => {
    expect(exportSessionParamsSchema.parse({ session_id: 'sess_abc' })).toEqual({ session_id: 'sess_abc' });
    expect(exportSessionParamsSchema.safeParse({ session_id: '' }).success).toBe(false);

    expect(exportSessionRequestSchema.parse({})).toEqual({});
    expect(exportSessionRequestSchema.parse({ web_log: '{"event":"connected"}\n' })).toEqual({ web_log: '{"event":"connected"}\n' });
    expect(exportSessionRequestSchema.parse({ desktop: true })).toEqual({ desktop: true });
    expect(exportSessionRequestSchema.safeParse({ web_log: 'a'.repeat(256 * 1024) }).success).toBe(true);
    expect(exportSessionRequestSchema.safeParse({ web_log: `${'a'.repeat(256 * 1024)}b` }).success).toBe(false);
    expect(exportSessionRequestSchema.safeParse({ web_log: '你'.repeat(87_382) }).success).toBe(false);
    expect(exportSessionRequestSchema.safeParse({ outputPath: '/tmp/export.zip' }).success).toBe(false);
  });

  it('validates createSessionRequestSchema addresses, applied modes, and rejects legacy/unknown keys', () => {
    expect(createSessionRequestSchema.parse({ metadata: { cwd: '/tmp/foo' } }).metadata?.cwd).toBe('/tmp/foo');
    const byWorkspace = createSessionRequestSchema.parse({ workspace_id: 'wd_kimi_0123456789ab' });
    expect(byWorkspace.workspace_id).toBe('wd_kimi_0123456789ab');
    expect(byWorkspace.metadata).toBeUndefined();
    expect(createSessionRequestSchema.safeParse({ metadata: {} }).success).toBe(false);

    const unknownRes = createSessionRequestSchema.safeParse({
      metadata: { cwd: '/tmp/foo' },
      agent_config: { model: 'm', unknown_key: 'x' },
    });
    expect(unknownRes.success).toBe(false);
    expect(unknownRes.error?.issues[0]).toMatchObject({ code: 'unrecognized_keys', path: ['agent_config'], keys: ['unknown_key'] });

    for (const key of ['system_prompt', 'tools', 'mcp_servers', 'goal_objective', 'goal_control']) {
      expect(
        createSessionRequestSchema.safeParse({ metadata: { cwd: '/tmp/foo' }, agent_config: { model: 'm', [key]: 'x' } }).success,
      ).toBe(false);
    }

    const agent_config = { model: 'm', profile: 'reviewer', thinking: 'high', permission_mode: 'yolo' as const, plan_mode: true };
    expect(createSessionRequestSchema.parse({ metadata: { cwd: '/tmp/foo' }, agent_config }).agent_config).toEqual(agent_config);
  });
});

describe('session list & profile schemas', () => {
  it.each([
    ['empty query', {}, {}],
    ['before_id + page_size', { before_id: 'sess_abc', page_size: 20 }, { before_id: 'sess_abc', page_size: 20 }],
    ['busy boolean', { busy: true }, { busy: true }],
    ['include_archive string true', { include_archive: 'true' }, { include_archive: true }],
    ['include_archive string false', { include_archive: 'false' }, { include_archive: false }],
    ['include_archive boolean/numeric', { include_archive: true, archived_only: 0 }, { include_archive: true, archived_only: false }],
    ['archived_only string true', { archived_only: 'true' }, { archived_only: true }],
    ['private filters', { include_private: 'true', private_only: '1' }, { include_private: true, private_only: true }],
    ['private_only alone', { private_only: true }, { private_only: true }],
    ['exclude_empty string true', { exclude_empty: 'true' }, { exclude_empty: true }],
    ['exclude_empty string false', { exclude_empty: 'false' }, { exclude_empty: false }],
  ] as const)('parses listSessionsQuery (%s)', (_label, input, expected) => {
    expect(listSessionsQuerySchema.parse(input)).toEqual(expected);
  });

  it('rejects mutually exclusive cursors, conflicting privacy flags, and invalid query values', () => {
    expect(listSessionsQuerySchema.safeParse({ before_id: 'a', after_id: 'b' }).success).toBe(false);
    expect(listSessionsQuerySchema.safeParse({ page_size: 101 }).success).toBe(false);
    expect(listSessionsQuerySchema.safeParse({ busy: 'frozen' }).success).toBe(false);
    const conflict = listSessionsQuerySchema.safeParse({ private_only: true, include_private: false });
    expect(conflict.success).toBe(false);
    expect(conflict.error?.issues[0]).toMatchObject({ path: ['private_only'], message: 'private_only and include_private are mutually exclusive' });
    expect(listSessionChildrenQuerySchema.parse({ exclude_empty: true })).not.toHaveProperty('exclude_empty');
  });

  it('parses session profile, fork, child, and restore payloads', () => {
    expect(getSessionProfileResponseSchema.parse(makeSessionFixture()).id).toBe('sess_abc');
    expect(forkSessionRequestSchema.parse({})).toEqual({});
    expect(forkSessionRequestSchema.parse({ title: 'Fork: source', metadata: { origin: 'web', depth: 1 } }))
      .toEqual({ title: 'Fork: source', metadata: { origin: 'web', depth: 1 } });
    expect(forkSessionRequestSchema.safeParse({ metadata: 'x' }).success).toBe(false);
    expect(forkSessionResponseSchema.parse(makeSessionFixture({ id: 'sess_fork', title: 'Fork: source', metadata: { cwd: '/tmp/foo', origin: 'web' } })).id)
      .toBe('sess_fork');

    expect(createSessionChildRequestSchema.parse({ title: 'Side question', metadata: { origin: 'web', topic: 'btw' } }))
      .toEqual({ title: 'Side question', metadata: { origin: 'web', topic: 'btw' } });
    expect(createSessionChildRequestSchema.safeParse({ metadata: 'x' }).success).toBe(false);
    const child = makeSessionFixture({ id: 'sess_child', title: 'Child: source', metadata: { cwd: '/tmp/foo', parent_session_id: 'sess_parent' } });
    expect(createSessionChildResponseSchema.parse(child).metadata['parent_session_id']).toBe('sess_parent');
    expect(listSessionChildrenResponseSchema.parse({ items: [child], has_more: false }).items).toHaveLength(1);
    expect(restoreSessionResponseSchema.parse(makeSessionFixture({ title: 'Restored', archived: false })).archived).toBe(false);
  });

  it('validates updateSessionProfileRequestSchema and legacy updateSessionRequestSchema', () => {
    for (const payload of [
      {},
      { metadata: { custom_field: 'x' } },
      { private: true },
      { agent_config: { model: 'moonshot-v1-128k' } },
      { agent_config: { thinking: 'medium', permission_mode: 'auto', plan_mode: false } },
      { agent_config: { goal_control: 'cancel' } },
    ]) {
      expect(updateSessionProfileRequestSchema.parse(payload)).toEqual(payload);
    }
    expect(updateSessionRequestSchema.parse({ metadata: { custom_field: 'x' } }))
      .toEqual(updateSessionProfileRequestSchema.parse({ metadata: { custom_field: 'x' } }));

    for (const key of ['system_prompt', 'tools', 'mcp_servers', 'unknown_key']) {
      const result = updateSessionProfileRequestSchema.safeParse({ agent_config: { [key]: 'x' } });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]).toMatchObject({ code: 'unrecognized_keys', keys: [key] });
    }
  });
});

describe('session status, compact, undo, and archive schemas', () => {
  const baseStatus = {
    busy: false,
    model_name: null,
    thinking_level: 'off',
    permission: 'auto',
    plan_mode: false,
    context_tokens: 0,
    max_context_tokens: 0,
    context_usage: 0,
  };

  it.each([
    ['full with model', { ...baseStatus, busy: true, model: 'example-model', thinking_level: 'on', permission: 'ask', plan_mode: true, context_tokens: 1024, max_context_tokens: 128000, context_usage: 0.008 }],
    ['configured model_name', { ...baseStatus, model: 'example-model', model_name: 'Example Model', thinking_level: '' }],
    ['without model', baseStatus],
    ['without max_context_tokens', (({ max_context_tokens: _, ...rest }) => rest)(baseStatus)],
  ] as const)('accepts sessionStatusResponse (%s)', (_label, payload) => {
    expect(sessionStatusResponseSchema.parse(payload)).toEqual(payload);
  });

  it.each([
    ['non-string model_name', { ...baseStatus, model_name: 42 }],
    ['missing busy', (({ busy: _, ...rest }) => rest)(baseStatus)],
    ['invalid busy', { ...baseStatus, busy: 'unknown' }],
    ['negative context_tokens', { ...baseStatus, context_tokens: -1 }],
    ['context_usage > 1', { ...baseStatus, context_tokens: 10, max_context_tokens: 5, context_usage: 2 }],
  ] as const)('rejects sessionStatusResponse (%s)', (_label, payload) => {
    expect(sessionStatusResponseSchema.safeParse(payload).success).toBe(false);
  });

  it('validates compact, undo, and archive/delete session contracts', () => {
    expect(compactSessionRequestSchema.parse({})).toEqual({});
    expect(compactSessionRequestSchema.parse(undefined)).toEqual({});
    expect(compactSessionRequestSchema.parse({ instruction: '  focus on decisions  ' })).toEqual({ instruction: '  focus on decisions  ' });
    expect(compactSessionRequestSchema.safeParse({ instruction: 123 }).success).toBe(false);

    expect(compactSessionResponseSchema.parse({})).toEqual({});
    for (const status of ['queued', 'running'] as const) {
      const receipt = { accepted: true, status, source: 'manual' };
      expect(compactSessionResponseSchema.parse(receipt)).toEqual(receipt);
    }
    expect(compactSessionResponseSchema.safeParse({ status: 'completed' }).success).toBe(false);
    expect(compactSessionResponseSchema.safeParse({ source: 'auto' }).success).toBe(false);

    expect(undoSessionRequestSchema.parse(undefined)).toEqual({ count: 1 });
    expect(undoSessionRequestSchema.parse({ count: 2, page_size: 25 })).toEqual({ count: 2, page_size: 25 });
    expect(undoSessionRequestSchema.safeParse({ count: 0 }).success).toBe(false);
    expect(undoSessionRequestSchema.safeParse({ page_size: 101 }).success).toBe(false);

    const undoResp = undoSessionResponseSchema.parse({
      messages: {
        items: [{ id: 'msg_sess_abc_000000', session_id: 'sess_abc', role: 'user', content: [{ type: 'text', text: 'kept' }], created_at: '2026-01-01T00:00:00.000Z' }],
        has_more: false,
      },
      status: { ...baseStatus, busy: true, model: 'kimi-k2', thinking_level: 'auto', permission: 'manual', context_tokens: 10, max_context_tokens: 100, context_usage: 0.1 },
    });
    expect(undoResp.messages.items).toHaveLength(1);
    expect(undoResp.status.context_tokens).toBe(10);

    expect(archiveSessionResponseSchema.parse({ archived: true })).toEqual({ archived: true });
    const familyFailure = {
      archived: false,
      outcomes: [
        { id: 'session-a', ok: true as const },
        { id: 'session-b', ok: false as const, reason: 'error' as const, message: 'Archive failed' },
      ],
    };
    expect(archiveSessionResponseSchema.parse(familyFailure)).toEqual(familyFailure);
    expect(archiveSessionResponseSchema.safeParse({ archived: 'false' }).success).toBe(false);
  });
});
