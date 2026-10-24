import { describe, expect, it } from 'vitest';

import { imBindingPatchSchema, imBindingSchema, imConfirmRequestSchema, imInstanceViewSchema, imPolicySchema, imSessionSnapshotSchema, imTargetChannelsSchema } from '../imSession';
import { ErrorCode } from '../error-codes';

const view = {
  id: 'inst',
  provider_kind: 'onebot_v11' as const,
  listening: true,
  configured: true,
  adapter: 'stopped' as const,
};

describe('imInstanceViewSchema connection', () => {
  it('accepts active and terminal listener phases and rejects unknown phases', () => {
    expect(imInstanceViewSchema.parse(view).connection).toBeUndefined();
    expect(imInstanceViewSchema.parse({ ...view, connection: 'starting' }).connection).toBe('starting');
    expect(imInstanceViewSchema.parse({ ...view, connection: 'reconnecting' }).connection).toBe('reconnecting');
    expect(imSessionSnapshotSchema.parse({
      policy: { allowed: true, default_enabled: true },
      instances: [{ ...view, connection: 'reconnecting', adapter: 'running' }],
      discoveries: [],
      bindings: [],
      strangers: [],
      voice_fallbacks: 0,
    }).instances[0]?.connection).toBe('reconnecting');
    for (const connection of ['auth_expired', 'stopped']) {
      expect(imInstanceViewSchema.parse({ ...view, connection }).connection).toBe(connection);
    }
    for (const connection of ['running', 'idle', '']) {
      expect(imInstanceViewSchema.safeParse({ ...view, connection }).success).toBe(false);
    }
  });
});

describe('IM connection metadata', () => {
  it('accepts finite diagnostic codes and rejects private data and invalid counters', () => {
    const connection_detail = { code: 'api_error', http_status: 200, ret: -2, errcode: 9, failure_count: 3, retry_in_ms: 4000 };
    expect(imInstanceViewSchema.parse({ ...view, connection_detail }).connection_detail).toEqual(connection_detail);
    for (const extra of [{ errmsg: 'private' }, { token: 'private' }, { body: 'private' }, { cursor: 'private' }, { code: 'arbitrary' }, { retry_in_ms: -1 }, { failure_count: 1.5 }, { ret: Infinity }]) {
      expect(imInstanceViewSchema.safeParse({ ...view, connection_detail: { ...connection_detail, ...extra } }).success).toBe(false);
    }
  });
});


describe('thread channel contracts', () => {
  it('keeps optional Persona and missing legacy session provenance while exposing paused ownership', () => {
    const binding = { id: 'b1', provider_instance_id: 'account', provider_kind: 'telegram', account_id: 'bot',
      identity: { chat_id: 'room', sender_id: 'user', topic_id: '41' }, enabled: true, busy: 'queue', reply: 'final', mobile_interactions: true };
    expect(imBindingSchema.parse({ ...binding, session_id: 'thread', input_enabled: false, output_enabled: true }).persona_id).toBeUndefined();
    expect(imBindingSchema.parse({ ...binding, persona_id: 'legacy', pending_reanchor: true }).session_id).toBeUndefined();
    expect(imBindingPatchSchema.parse({ input_enabled: null, output_enabled: false, rebind: true, session_id: 'target' })).toMatchObject({ input_enabled: null, output_enabled: false });
    expect(imConfirmRequestSchema.parse({ target: { kind: 'session', session_id: 'thread' }, rebind: true, input_enabled: true })).toMatchObject({ rebind: true });
  });

  it('distinguishes unbound notify candidates from bound outputs without colliding with session creation errors', () => {
    expect(imPolicySchema.parse({ allowed: true, default_enabled: true, allow_channel_borrowing: true }).allow_channel_borrowing).toBe(true);
    expect(imTargetChannelsSchema.parse({ internal_enabled: true, channels: [{ id: 'notify:updates', kind: 'notify', enabled: true, bound: false, capabilities: [] }] }).channels[0]?.bound).toBe(false);
    expect(ErrorCode.IM_IDENTITY_ALREADY_BOUND).toBe(40949);
    expect(ErrorCode.SESSION_CREATE_IDEMPOTENCY_CONFLICT).toBe(40948);
  });
});
