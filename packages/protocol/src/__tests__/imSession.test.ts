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
  it('accepts a listener that is starting or reconnecting and rejects other phases', () => {
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
    for (const connection of ['running', 'stopped', 'idle', '']) {
      expect(imInstanceViewSchema.safeParse({ ...view, connection }).success).toBe(false);
    }
  });
});
