import Fastify from 'fastify';
import { expect, it } from 'vitest';

import { registerImSessionRoutes } from '../../../src/routes/imSessions';
import type { ImSessionBridge } from '../../../src/services/imSession/bridge';

const snapshot = { policy: { allowed: true, default_enabled: true }, instances: [], discoveries: [], bindings: [], strangers: [], voice_fallbacks: 0 };

it('keeps the id in front of the action colon', async () => {
  const seen: string[] = [];
  const bridge = {
    snapshot: async () => snapshot,
    check: async (id: string) => { seen.push(`check:${id}`); return { ok: true, account_id: '7' }; },
    setListening: async (id: string, listening: boolean) => { seen.push(`listen:${id}:${String(listening)}`); return snapshot; },
    confirm: async (id: string) => { seen.push(`confirm:${id}`); return snapshot; },
    dismiss: async (id: string) => { seen.push(`dismiss:${id}`); return snapshot; },
    updateBinding: async (id: string) => { seen.push(`patch:${id}`); return snapshot; },
    removeBinding: async (id: string) => { seen.push(`delete:${id}`); return snapshot; },
  } as unknown as ImSessionBridge;
  const app = Fastify();
  registerImSessionRoutes(app, bridge);
  expect((await app.inject({ method: 'POST', url: '/im/sessions/instances/inst/check', payload: {} })).json().code).toBe(0);
  expect((await app.inject({ method: 'POST', url: '/im/sessions/instances/inst/listen', payload: { listening: true } })).json().code).toBe(0);
  expect((await app.inject({ method: 'POST', url: '/im/sessions/discoveries/d1/confirm', payload: { target: { kind: 'persona', persona_id: 'ada' } } })).json().code).toBe(0);
  expect((await app.inject({ method: 'POST', url: '/im/sessions/discoveries/d1/dismiss', payload: {} })).json().code).toBe(0);
  expect((await app.inject({ method: 'PATCH', url: '/im/sessions/bindings/b1', payload: { busy: 'steer' } })).json().code).toBe(0);
  expect((await app.inject({ method: 'DELETE', url: '/im/sessions/bindings/b1' })).json().code).toBe(0);
  expect(seen).toEqual(['check:inst', 'listen:inst:true', 'confirm:d1', 'dismiss:d1', 'patch:b1', 'delete:b1']);
  await app.close();
});

it('accepts persona or session targets while preserving the legacy binding patch', async () => {
  const patches: unknown[] = [];
  const bridge = { updateBinding: async (_id: string, patch: unknown) => { patches.push(patch); return snapshot; } } as unknown as ImSessionBridge;
  const app = Fastify();
  registerImSessionRoutes(app, bridge);
  try {
    for (const target of [{ kind: 'persona', persona_id: 'ada' }, { kind: 'session', session_id: 'sess' }]) {
      expect((await app.inject({ method: 'PATCH', url: '/im/sessions/bindings/b1', payload: { target } })).json().code).toBe(0);
    }
    expect((await app.inject({ method: 'PATCH', url: '/im/sessions/bindings/b1', payload: { session_id: 'legacy' } })).json().code).toBe(0);
    expect(patches).toEqual([
      expect.objectContaining({ target: { kind: 'persona', persona_id: 'ada' } }),
      expect.objectContaining({ target: { kind: 'session', session_id: 'sess' } }),
      expect.objectContaining({ sessionId: 'legacy' }),
    ]);
    expect((await app.inject({ method: 'PATCH', url: '/im/sessions/bindings/b1', payload: { target: { kind: 'session', session_id: 'a' }, session_id: 'b' } })).json().code).toBe(40001);
    expect(patches).toHaveLength(3);
  } finally {
    await app.close();
  }
});

it('returns unsupported WeChat group confirmation as a validation outcome', async () => {
  const bridge = { confirm: async () => { throw new Error('unsupported_wechat_group'); } } as unknown as ImSessionBridge;
  const app = Fastify();
  registerImSessionRoutes(app, bridge);
  try {
    const response = await app.inject({ method: 'POST', url: '/im/sessions/discoveries/d1/confirm', payload: { target: { kind: 'persona', persona_id: 'ada' } } });
    expect(response.json()).toMatchObject({ code: 40001, msg: 'unsupported_wechat_group' });
  } finally { await app.close(); }
});
