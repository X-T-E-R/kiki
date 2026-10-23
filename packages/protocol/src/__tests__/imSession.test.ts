import { describe, expect, it } from 'vitest';

import { imInstanceViewSchema, imSessionSnapshotSchema } from '../imSession';

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
