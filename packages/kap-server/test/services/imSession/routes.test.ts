import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { ImSessionSetup } from '../../../src/services/imSession/setup';

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

it('exposes package-owned setup capabilities and saves structured new-platform fields without listening', async () => {
  const saved: unknown[] = [];
  const bridge = {
    snapshot: async () => ({ ...snapshot, instances: [{ id: 'existing', provider_kind: 'matrix' }] }),
    paste: async (input: unknown) => { saved.push(input); return { provider_instance_id: 'im_new', provider_kind: 'slack', ignored_keys: [], chat_hint_ignored: false }; },
  } as unknown as ImSessionBridge;
  const app = Fastify();
  registerImSessionRoutes(app, bridge);
  try {
    const catalog = (await app.inject({ method: 'GET', url: '/im/sessions/setup' })).json().data;
    expect(catalog.platforms.map((item: { provider_kind: string }) => item.provider_kind)).toEqual(['discord', 'slack', 'matrix']);
    for (const item of catalog.platforms) {
      expect(item.capabilities).toMatchObject({ voice_rendering: 'unsupported', encrypted_rooms: false });
      expect(item.capabilities.outbound).not.toContain('voice');
    }
    const response = await app.inject({ method: 'POST', url: '/im/sessions/setup', payload: { action: 'save', provider_kind: 'slack', fields: { bot_token: 'xoxb-example', app_token: 'xapp-example' } } });
    expect(response.json()).toMatchObject({ code: 0, data: { kind: 'saved', result: { provider_instance_id: 'im_new' } } });
    expect(response.body).not.toContain('xoxb-example');
    expect(saved).toEqual([{ instanceId: undefined, text: 'platform=slack\nbot_token=xoxb-example\napp_token=xapp-example' }]);
    const invalid = await app.inject({ method: 'POST', url: '/im/sessions/setup', payload: { action: 'save', provider_kind: 'discord', instance_id: 'existing', fields: { bot_token: 'example' } } });
    expect(invalid.json()).toMatchObject({ code: 40001, msg: 'setup_instance_provider_mismatch' });
    const missing = await app.inject({ method: 'POST', url: '/im/sessions/setup', payload: { action: 'save', provider_kind: 'slack', fields: { bot_token: 'example' } } });
    expect(missing.json()).toMatchObject({ code: 40001, msg: 'setup_fields_invalid' });
    expect(saved).toHaveLength(1);
    const link = (await app.inject({ method: 'POST', url: '/im/sessions/setup', payload: { action: 'slack_manifest' } })).json().data;
    const manifest = JSON.parse(new URL(link.url).searchParams.get('manifest')!);
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    const discord = (await app.inject({ method: 'POST', url: '/im/sessions/setup', payload: { action: 'discord_install', application_id: '12345' } })).json().data;
    expect(new URL(discord.url).searchParams.get('client_id')).toBe('12345');
  } finally { await app.close(); }
});

it('binds setup completion to a one-use attempt and validates the Matrix callback before exchanging a token', async () => {
  const app = Fastify();
  registerImSessionRoutes(app, {} as ImSessionBridge);
  try {
    const started = (await app.inject({ method: 'POST', url: '/im/sessions/setup', payload: { action: 'matrix_sso_begin', homeserver: 'https://matrix.example.test', redirect_uri: 'http://127.0.0.1/matrix-return' } })).json().data;
    expect(started).toMatchObject({ kind: 'link', attempt_id: expect.any(String) });
    expect(new URL(started.callback_uri).searchParams.get('kiki_im_state')).toBeTruthy();
    const complete = { action: 'matrix_sso_complete', attempt_id: started.attempt_id, callback_uri: 'http://127.0.0.1/wrong', login_token: 'not-sent' };
    expect((await app.inject({ method: 'POST', url: '/im/sessions/setup', payload: complete })).json()).toMatchObject({ code: 40001, msg: 'setup_callback_mismatch' });
    expect((await app.inject({ method: 'POST', url: '/im/sessions/setup', payload: complete })).json()).toMatchObject({ code: 40001, msg: 'setup_attempt_expired' });
    const slack = (await app.inject({ method: 'POST', url: '/im/sessions/setup', payload: { action: 'slack_oauth_begin', client_id: '123', redirect_uri: 'http://127.0.0.1/slack-return' } })).json().data;
    const callback = { action: 'slack_oauth_complete', attempt_id: slack.attempt_id, state: 'wrong-state', code: 'not-sent', client_secret: 'not-sent', app_token: 'xapp-example' };
    expect((await app.inject({ method: 'POST', url: '/im/sessions/setup', payload: callback })).json()).toMatchObject({ code: 40001, msg: 'setup_oauth_state_mismatch' });
  } finally { await app.close(); }
});

it('returns real per-session channel capabilities and keeps the internal switch separate', async () => {
  const switches: boolean[] = [];
  const bridge = {
    channelViews: async () => [{ id: 'internal', kind: 'internal', enabled: true, capabilities: [{ kind: 'voice', mimeTypes: ['audio/*'], rendering: 'audio_player' }] }, { id: 'im:b1', kind: 'im', enabled: true, capabilities: [{ kind: 'file' }] }],
    internalChannelEnabled: async () => true,
    setInternalChannel: async (_id: string, enabled: boolean) => { switches.push(enabled); return enabled; },
  } as unknown as ImSessionBridge;
  const app = Fastify();
  registerImSessionRoutes(app, bridge);
  try {
    expect((await app.inject({ method: 'GET', url: '/im/sessions/targets/sess/channels' })).json()).toMatchObject({ code: 0, data: { internal_enabled: true, channels: [{ id: 'internal', capabilities: [{ kind: 'voice', rendering: 'audio_player' }] }, { id: 'im:b1' }] } });
    expect((await app.inject({ method: 'PUT', url: '/im/sessions/targets/sess/internal', payload: { enabled: false } })).json()).toMatchObject({ code: 0, data: { enabled: false } });
    expect(switches).toEqual([false]);
  } finally { await app.close(); }
});

it('exchanges a matching Matrix SSO callback once and stores only its returned credential', async () => {
  const saved: unknown[] = [];
  const requests: unknown[] = [];
  const save = async (provider: string, fields: Readonly<Record<string, string>>, instanceId?: string) => {
    saved.push({ provider, fields, instanceId });
    return { provider_instance_id: 'im_matrix', provider_kind: 'matrix' as const, ignored_keys: [], chat_hint_ignored: false };
  };
  const setup = new ImSessionSetup(save);
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json({ access_token: 'returned-secret', user_id: '@bot:example.test', device_id: 'device' });
  });
  try {
    const begin = await setup.run({ action: 'matrix_sso_begin', homeserver: 'https://matrix.example.test', redirect_uri: 'http://127.0.0.1/return' });
    if (begin.kind !== 'link') throw new Error('Expected setup link');
    const callback = new URL(begin.callback_uri!);
    callback.searchParams.set('loginToken', 'one-use-token');
    const complete = { action: 'matrix_sso_complete' as const, attempt_id: begin.attempt_id!, callback_uri: callback.href, login_token: 'one-use-token' };
    expect(await setup.run(complete)).toMatchObject({ kind: 'saved', result: { provider_instance_id: 'im_matrix' } });
    expect(requests).toEqual([{ url: 'https://matrix.example.test/_matrix/client/v3/login', body: { type: 'm.login.token', token: 'one-use-token', initial_device_display_name: 'Kiki IM' } }]);
    expect(saved).toEqual([{ provider: 'matrix', fields: { homeserver: 'https://matrix.example.test', access_token: 'returned-secret' }, instanceId: undefined }]);
    await expect(setup.run(complete)).rejects.toThrow('setup_attempt_expired');
    expect(requests).toHaveLength(1);
  } finally { vi.unstubAllGlobals(); }
});
