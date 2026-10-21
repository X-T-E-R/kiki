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
