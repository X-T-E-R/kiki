import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrap, IConfigService, ISessionManager, logSeed, resolveLoggingConfig, type Scope } from '@kiki/agent-core-v2';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { TEST_HOST_IDENTITY } from '../../helpers/hostIdentity';
import { createImSessionHost } from '../../../src/services/imSession/host';
import { FakeImAdapter, fakeAdapterFactory } from '../../../src/services/imSession/fakeAdapter';
import { NotificationService } from '../../../src/services/notifications/notificationService';
import { ImSessionSetup } from '../../../src/services/imSession/setup';

import { registerImSessionRoutes } from '../../../src/routes/imSessions';
import { ImIdentityAlreadyBoundError, ImSessionBridge } from '../../../src/services/imSession/bridge';
import type { ImSessionPorts } from '../../../src/services/imSession/ports';

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
    expect((await app.inject({ method: 'PATCH', url: '/im/sessions/bindings/b1', payload: { session_id: 'legacy', rebind: true, input_enabled: false, output_enabled: true } })).json().code).toBe(0);
    expect(patches).toEqual([
      expect.objectContaining({ target: { kind: 'persona', persona_id: 'ada' } }),
      expect.objectContaining({ target: { kind: 'session', session_id: 'sess' } }),
      expect.objectContaining({ sessionId: 'legacy', rebind: true, inputEnabled: false, outputEnabled: true }),
    ]);
    expect((await app.inject({ method: 'PATCH', url: '/im/sessions/bindings/b1', payload: { target: { kind: 'session', session_id: 'a' }, session_id: 'b' } })).json().code).toBe(40001);
    expect(patches).toHaveLength(3);
  } finally {
    await app.close();
  }
});

it('maps confirm rebind and direction fields from snake case to the bridge contract', async () => {
  const requests: unknown[] = [];
  const bridge = { confirm: async (_id: string, request: unknown) => { requests.push(request); return snapshot; } } as unknown as ImSessionBridge;
  const app = Fastify();
  registerImSessionRoutes(app, bridge);
  try {
    expect((await app.inject({ method: 'POST', url: '/im/sessions/discoveries/d1/confirm', payload: { target: { kind: 'session', session_id: 'bare' }, rebind: true, input_enabled: false, output_enabled: true } })).json().code).toBe(0);
    expect(requests).toEqual([expect.objectContaining({ target: { kind: 'session', session_id: 'bare' }, rebind: true, input_enabled: false, output_enabled: true })]);
  } finally { await app.close(); }
});

it('returns structured identity rebind conflicts without hiding the target details', async () => {
  const bridge = {
    updateBinding: async () => {
      throw new ImIdentityAlreadyBoundError({ existing_binding_id: 'b1', previous_session_id: 'old', target_session_id: 'new', variant_key: { provider_instance_id: 'inst', account_id: 'account', chat_id: 'chat', topic_id: 'topic', sender_id: 'sender' } });
    },
  } as unknown as ImSessionBridge;
  const app = Fastify();
  registerImSessionRoutes(app, bridge);
  try {
    const response = await app.inject({ method: 'PATCH', url: '/im/sessions/bindings/b1', payload: { session_id: 'new' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ code: 40949, msg: 'im_identity_already_bound', details: { previous_session_id: 'old', target_session_id: 'new', variant_key: { provider_instance_id: 'inst', account_id: 'account', chat_id: 'chat', topic_id: 'topic', sender_id: 'sender' } } });
  } finally { await app.close(); }
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

it('returns channel candidates, keeps internal permanently enabled, and manages notification bindings', async () => {
  const switches: boolean[] = [];
  const notifications: string[] = [];
  const channels = [
    { id: 'internal', kind: 'internal', enabled: true, capabilities: [{ kind: 'voice', mimeTypes: ['audio/*'], rendering: 'audio_player' }] },
    { id: 'im:b1', kind: 'im', bound: false, enabled: true, capabilities: [{ kind: 'file' }] },
    { id: 'notify:mail', kind: 'notify', bound: false, enabled: true, capabilities: [{ kind: 'text' }] },
  ];
  const bridge = {
    channelViews: async () => channels,
    internalChannelEnabled: async () => true,
    setInternalChannel: async (_id: string, enabled: boolean) => { switches.push(enabled); if (!enabled) throw new Error('unsupported_internal_channel_disable'); return true; },
    setNotificationChannel: async (_sessionId: string, channelId: string, enabled: boolean) => { notifications.push(`set:${channelId}:${String(enabled)}`); const channel = channels.find((item) => item.id === `notify:${channelId}`)!; channel.bound = true; channel.enabled = enabled; return channels; },
    removeNotificationChannel: async (_sessionId: string, channelId: string) => { notifications.push(`remove:${channelId}`); channels.find((item) => item.id === `notify:${channelId}`)!.bound = false; return channels; },
  } as unknown as ImSessionBridge;
  const app = Fastify();
  registerImSessionRoutes(app, bridge);
  try {
    expect((await app.inject({ method: 'GET', url: '/im/sessions/targets/sess/channels' })).json()).toMatchObject({ code: 0, data: { internal_enabled: true, channels: [{ id: 'internal', capabilities: [{ kind: 'voice', rendering: 'audio_player' }] }, { id: 'im:b1', bound: false }, { id: 'notify:mail', kind: 'notify', bound: false }] } });
    expect((await app.inject({ method: 'PUT', url: '/im/sessions/targets/sess/internal', payload: { enabled: false } })).json()).toMatchObject({ code: 40001, msg: 'unsupported_internal_channel_disable' });
    const added = (await app.inject({ method: 'PUT', url: '/im/sessions/targets/sess/notify/mail', payload: { enabled: true } })).json();
    expect(added.code).toBe(0);
    expect(added.data.channels).toContainEqual(expect.objectContaining({ id: 'notify:mail', bound: true, enabled: true }));
    const removed = (await app.inject({ method: 'DELETE', url: '/im/sessions/targets/sess/notify/mail' })).json();
    expect(removed.code).toBe(0);
    expect(removed.data.channels).toContainEqual(expect.objectContaining({ id: 'notify:mail', bound: false, enabled: true }));
    expect(switches).toEqual([false]);
    expect(notifications).toEqual(['set:mail:true', 'remove:mail']);
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
    if (typeof init.body !== 'string') throw new Error('Expected a JSON request body.');
    requests.push({ url, body: JSON.parse(init.body) });
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

it('binds an existing indexed session through native routes and reopens the saved target without a model call', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiki-im-binding-route-'));
  let core: Scope | undefined;
  let notifications: NotificationService | undefined;
  let bridge: ImSessionBridge | undefined;
  let app: ReturnType<typeof Fastify> | undefined;
  const open = async () => {
    core = bootstrap({ homeDir: home, cwd: home, osHomeDir: home, userAgentProfileHomeDir: home, modelAccountHomeDir: home, env: {}, clientIdentity: TEST_HOST_IDENTITY }, logSeed(resolveLoggingConfig({ homeDir: home, env: {} }))).app;
    await core.accessor.get(IConfigService).ready;
    notifications = new NotificationService(core, home, () => false, () => undefined);
    await notifications.start();
    const adapter = new FakeImAdapter('wechat_bridge', 'test-account');
    bridge = await createImSessionHost({ core, homeDir: home, notifications, logger: { info() {} }, factories: [fakeAdapterFactory(adapter)] });
    app = Fastify();
    registerImSessionRoutes(app, bridge);
    return adapter;
  };
  const close = async () => { await app?.close(); await bridge?.close(); await notifications?.close(); await core?.dispose(); };
  try {
    await writeFile(join(home, 'desktop.json'), JSON.stringify({ locale: 'en' }));
    await open();
    const manager = core!.accessor.get(ISessionManager);
    await manager.create({ sessionId: 'im-existing', workDir: home });
    await manager.create({ sessionId: 'im-replacement', workDir: home });
    const adapter = await (async () => {
      await close();
      return open();
    })();
    const pasted = await bridge!.paste({ text: 'wechat_token=example-test-token\nwechat_account=test-account' });
    await bridge!.setListening(pasted.provider_instance_id, true);
    const identity = { chatId: 'test-chat', senderId: 'test-sender', topicId: '0', chatKind: 'private' as const };
    await adapter.emit({ eventId: 'test-discovery', identity, kind: 'text', text: 'Kiki binding test' });
    const catalog = (await app!.inject({ method: 'GET', url: '/im/sessions/catalog' })).json().data;
    expect(catalog.sessions.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining(['im-existing', 'im-replacement']));
    const discoveryId = (await bridge!.snapshot()).discoveries[0]!.id;
    const confirmed = (await app!.inject({ method: 'POST', url: `/im/sessions/discoveries/${discoveryId}/confirm`, payload: { target: { kind: 'session', session_id: 'im-existing' } } })).json();
    expect(confirmed.code).toBe(0);
    const bindingId = confirmed.data.bindings[0].id as string;
    const changed = (await app!.inject({ method: 'PATCH', url: `/im/sessions/bindings/${bindingId}`, payload: { target: { kind: 'session', session_id: 'im-replacement' }, rebind: true } })).json();
    expect(changed).toMatchObject({ code: 0, data: { bindings: [{ id: bindingId, session_id: 'im-replacement' }] } });
    const rejected = (await app!.inject({ method: 'PATCH', url: `/im/sessions/bindings/${bindingId}`, payload: { target: { kind: 'session', session_id: 'missing' }, enabled: false } })).json();
    expect(rejected).toMatchObject({ code: 40001, msg: 'unknown_session' });
    const stored = JSON.parse(await readFile(join(home, 'im-session-bridge.json'), 'utf8'));
    expect(stored.bindings).toEqual([expect.objectContaining({ id: bindingId, sessionId: 'im-replacement', enabled: true })]);
    await close();
    const reopenedAdapter = await open();
    const reread = (await app!.inject({ method: 'GET', url: '/im/sessions' })).json();
    expect(reread).toMatchObject({ code: 0, data: { bindings: [{ id: bindingId, session_id: 'im-replacement', identity: { chat_id: 'test-chat', sender_id: 'test-sender' } }] } });
    const test = (await app!.inject({ method: 'POST', url: `/im/sessions/bindings/${bindingId}/test`, payload: {} })).json();
    expect(test).toMatchObject({ code: 0, data: { binding_id: bindingId, status: 'delivered', message_ids: [expect.any(String)] } });
    expect(reopenedAdapter.sent).toHaveLength(1);
    expect(reopenedAdapter.sent[0]).toMatchObject({ identity, text: 'Kiki binding test: this is a test message.' });
    const invalid = (await app!.inject({ method: 'POST', url: `/im/sessions/bindings/${bindingId}/test`, payload: { text: 'arbitrary', target: 'other' } })).json();
    expect(invalid.code).toBe(40001);
    expect(reopenedAdapter.sent).toHaveLength(1);
  } finally { await close(); await rm(home, { recursive: true, force: true }); }
});

it('serves group confirm and PATCH on the envelope, including scope conflicts and failed saves', async () => {
  const topic = { chatId: 'g1', senderId: 'owner', topicId: '12', chatKind: 'group' as const };
  const peer = { chatId: 'g1', senderId: 'peer', topicId: '12', chatKind: 'group' as const };
  const noTopic = { chatId: 'g2', senderId: 'owner', topicId: '0', chatKind: 'group' as const };
  const isolated = { chatId: 'g9', senderId: 'member', topicId: '12', chatKind: 'group' as const };
  const otherAccount = { chatId: 'g9', senderId: 'outsider', topicId: '12', chatKind: 'group' as const };
  const privateChat = { chatId: 'p1', senderId: 'owner', topicId: '0', chatKind: 'private' as const };
  const binding = (id: string, identity: { chatId: string; senderId: string; topicId: string; chatKind: 'private' | 'group' }, accountId: string, sessionId: string) => ({
    id, providerInstanceId: 'inst', providerKind: 'telegram' as const, accountId, identity, sessionId,
    enabled: true, busy: 'queue' as const, reply: 'final' as const, mobileInteractions: true, bindingScope: 'sender' as const,
  });
  const discovery = (id: string, identity: { chatId: string; senderId: string; topicId: string; chatKind: 'private' | 'group' }, accountId = '42') => ({
    id, providerInstanceId: 'inst', providerKind: 'telegram' as const, accountId, identity, preview: id, at: 1,
  });
  const initial = JSON.stringify({
    policy: { allowed: true, defaultEnabled: true },
    instances: [{ id: 'inst', providerKind: 'telegram', listening: false, virtual: true }],
    discoveries: [discovery('d-same', topic), discovery('d-peer', peer), discovery('d-zero', noTopic), discovery('d-private', privateChat), discovery('d-iso', isolated)],
    bindings: [binding('b1', topic, '42', 'sess'), binding('b2', { ...topic, topicId: '13', senderId: 'other' }, '42', 'home'), binding('b-iso', otherAccount, '99', 'home')],
    replies: [{ bindingId: 'b1', promptId: 'p1', messageIds: ['m1'], lastText: 'partial', fileSent: false, open: true }],
  });
  let saved = '';
  let failSave = false;
  const ports: ImSessionPorts = {
    credentials: { list: () => [{ id: 'inst', providerId: 'telegram', configured: true }], read: () => 'credential', write: async () => undefined, check: async () => ({ ok: true, accountId: '42' }) },
    sessions: {
      listPersonas: async () => [], listSessions: async () => [{ id: 'sess', title: 'Notes' }, { id: 'home', title: 'Home' }],
      owns: async (id) => id === 'sess' || id === 'home', ensureHome: async () => ({ homeSessionId: 'home' }),
      activity: async () => ({ busy: false, pending: 'none', queueLength: 0 }),
      submit: async (input) => ({ duplicate: false, promptId: input.promptId, deliveryState: 'pending' }),
      steer: async () => 'steered', abort: async () => false, saveMedia: async () => [],
      readVisible: async () => ({ text: '', done: true, media: [] }), listInteractions: async () => ({ approvals: [], questions: [] }),
      decideApproval: async () => 'decided', decideHostKey: async () => 'decided', answerQuestion: async () => 'answered',
    },
    logger: { info() {} }, load: async () => initial, save: async (value) => { if (failSave) throw new Error('scope-save-failed'); saved = value; },
  };
  const bridge = new ImSessionBridge({ ports, factories: [fakeAdapterFactory(new FakeImAdapter('telegram', '42'))], editIntervalMs: 0, now: () => 1_700_000_000_000, wait: async () => undefined });
  const app = Fastify();
  registerImSessionRoutes(app, bridge);
  const send = (method: 'POST' | 'PATCH', url: string, payload: Record<string, unknown>) => app.inject({ method, url, payload });
  try {
    const forum = await send('POST', '/im/sessions/discoveries/d-zero/confirm', { target: { kind: 'session', session_id: 'sess' }, binding_scope: 'forum' });
    expect(forum.statusCode).toBe(200);
    expect(forum.json().code).toBe(40001);
    const topicRejected = await send('POST', '/im/sessions/discoveries/d-zero/confirm', { target: { kind: 'session', session_id: 'sess' }, binding_scope: 'topic' });
    expect(topicRejected.statusCode).toBe(200);
    expect(topicRejected.json()).toMatchObject({ code: 40001, msg: 'topic_scope_unavailable', data: null });
    const privateScope = await send('POST', '/im/sessions/discoveries/d-private/confirm', { target: { kind: 'session', session_id: 'sess' }, binding_scope: 'chat' });
    expect(privateScope.statusCode).toBe(200);
    expect(privateScope.json()).toMatchObject({ code: 40001, msg: 'group_binding_scope_required', data: null });
    const overlap = await send('POST', '/im/sessions/discoveries/d-peer/confirm', { target: { kind: 'session', session_id: 'home' }, binding_scope: 'topic' });
    expect(overlap.statusCode).toBe(200);
    expect(overlap.json()).toMatchObject({ code: 40949, msg: 'im_identity_already_bound', data: null, details: { existing_binding_id: 'b1', previous_session_id: 'sess', target_session_id: 'home', variant_key: { provider_instance_id: 'inst', account_id: '42', chat_id: 'g1', topic_id: '12', sender_id: 'owner' } } });
    const transfer = await send('POST', '/im/sessions/discoveries/d-same/confirm', { target: { kind: 'session', session_id: 'home' } });
    expect(transfer.statusCode).toBe(200);
    expect(transfer.json()).toMatchObject({ code: 40949, msg: 'im_identity_already_bound', details: { existing_binding_id: 'b1', previous_session_id: 'sess', target_session_id: 'home' } });
    failSave = true;
    const failedConfirm = await send('POST', '/im/sessions/discoveries/d-peer/confirm', { target: { kind: 'session', session_id: 'home' }, binding_scope: 'topic', rebind: true });
    expect(failedConfirm.statusCode).toBe(200);
    expect(failedConfirm.json()).toMatchObject({ code: 50001, msg: 'scope-save-failed', data: null });
    const failedPatch = await send('PATCH', '/im/sessions/bindings/b1', { binding_scope: 'chat', rebind: true });
    expect(failedPatch.statusCode).toBe(200);
    expect(failedPatch.json()).toMatchObject({ code: 50001, msg: 'scope-save-failed', data: null });
    const afterFailure = (await app.inject({ method: 'GET', url: '/im/sessions' })).json();
    expect(afterFailure.data.discoveries.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining(['d-same', 'd-peer', 'd-zero', 'd-private', 'd-iso']));
    expect(afterFailure.data.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'b1', session_id: 'sess', binding_scope: 'sender' }),
      expect.objectContaining({ id: 'b2', session_id: 'home', binding_scope: 'sender' }),
      expect.objectContaining({ id: 'b-iso', account_id: '99', binding_scope: 'sender' }),
    ]));
    expect(afterFailure.data.bindings.find((item: { id: string }) => item.id === 'b1').input_enabled).toBeUndefined();
    expect(afterFailure.data.bindings.find((item: { id: string }) => item.id === 'b2').input_enabled).toBeUndefined();
    failSave = false;
    const kept = await send('PATCH', '/im/sessions/bindings/b1', { busy: 'steer' });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().code).toBe(0);
    const persisted = JSON.parse(saved) as { replies: { open: boolean }[]; bindings: { id: string; sessionId: string; bindingScope?: string; inputEnabled?: boolean }[] };
    expect(persisted.replies).toEqual([expect.objectContaining({ bindingId: 'b1', open: true })]);
    expect(persisted.bindings.find((item) => item.id === 'b1')).toMatchObject({ sessionId: 'sess', bindingScope: 'sender' });
    expect(persisted.bindings.find((item) => item.id === 'b2')?.inputEnabled).toBeUndefined();
    const chat = await send('POST', '/im/sessions/discoveries/d-zero/confirm', { target: { kind: 'session', session_id: 'sess' }, binding_scope: 'chat' });
    expect(chat.statusCode).toBe(200);
    expect(chat.json().code).toBe(0);
    const chatBinding = chat.json().data.bindings.find((item: { identity: { topic_id: string } }) => item.identity.topic_id === '0');
    expect(chatBinding).toMatchObject({ session_id: 'sess', binding_scope: 'chat', group_policy: { wake: 'mention_or_reply' } });
    expect(chatBinding.persona_id).toBeUndefined();
    const stillNoTopic = await send('PATCH', `/im/sessions/bindings/${chatBinding.id}`, { binding_scope: 'topic' });
    expect(stillNoTopic.statusCode).toBe(200);
    expect(stillNoTopic.json()).toMatchObject({ code: 40001, msg: 'topic_scope_unavailable', data: null });
    const promoted = await send('PATCH', '/im/sessions/bindings/b1', { binding_scope: 'topic' });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().code).toBe(0);
    expect(promoted.json().data.bindings.find((item: { id: string }) => item.id === 'b1')).toMatchObject({ binding_scope: 'topic', group_policy: { wake: 'mention_or_reply' }, session_id: 'sess' });
    expect(promoted.json().data.bindings.find((item: { id: string }) => item.id === 'b2').input_enabled).toBeUndefined();
    const separateAccount = await send('POST', '/im/sessions/discoveries/d-iso/confirm', { target: { kind: 'session', session_id: 'sess' }, binding_scope: 'topic' });
    expect(separateAccount.statusCode).toBe(200);
    expect(separateAccount.json().code).toBe(0);
    const isolatedBinding = separateAccount.json().data.bindings.find((item: { id: string }) => item.id === 'b-iso');
    expect(isolatedBinding).toMatchObject({ account_id: '99', binding_scope: 'sender' });
    expect(isolatedBinding.input_enabled).toBeUndefined();
    expect(separateAccount.json().data.bindings.find((item: { identity: { sender_id: string } }) => item.identity.sender_id === 'member')).toMatchObject({ binding_scope: 'topic', account_id: '42' });
  } finally { await app.close(); await bridge.close(); }
});

it('returns unsupported directions as validation envelopes and does not take input', async () => {
  const identity = { chatId: 'p1', senderId: 'owner', topicId: '0', chatKind: 'private' as const };
  const initial = JSON.stringify({
    policy: { allowed: true, defaultEnabled: true },
    instances: [{ id: 'inst', providerKind: 'telegram', listening: false, virtual: true }],
    discoveries: [{ id: 'd1', providerInstanceId: 'inst', providerKind: 'telegram', accountId: '42', identity, preview: 'hello', at: 1 }],
    bindings: [],
  });
  const ports: ImSessionPorts = {
    credentials: { list: () => [{ id: 'inst', providerId: 'telegram', configured: true }], read: () => 'credential', write: async () => undefined, check: async () => ({ ok: true, accountId: '42' }) },
    sessions: {
      listPersonas: async () => [], listSessions: async () => [{ id: 'sess', title: 'Notes' }],
      owns: async (id) => id === 'sess', ensureHome: async () => ({ homeSessionId: 'home' }),
      activity: async () => ({ busy: false, pending: 'none', queueLength: 0 }),
      submit: async (input) => ({ duplicate: false, promptId: input.promptId, deliveryState: 'pending' }),
      steer: async () => 'steered', abort: async () => false, saveMedia: async () => [],
      readVisible: async () => ({ text: '', done: true, media: [] }), listInteractions: async () => ({ approvals: [], questions: [] }),
      decideApproval: async () => 'decided', decideHostKey: async () => 'decided', answerQuestion: async () => 'answered',
    },
    logger: { info() {} }, load: async () => initial, save: async () => undefined,
  };
  const bridge = new ImSessionBridge({ ports, factories: [{ ...fakeAdapterFactory(new FakeImAdapter('telegram', '42')), inbound: false, outbound: false }], now: () => 1_700_000_000_000, wait: async () => undefined });
  const app = Fastify();
  registerImSessionRoutes(app, bridge);
  try {
    const input = await app.inject({ method: 'POST', url: '/im/sessions/discoveries/d1/confirm', payload: { target: { kind: 'session', session_id: 'sess' }, input_enabled: true } });
    expect(input.statusCode).toBe(200);
    expect(input.json()).toMatchObject({ code: 40001, msg: 'input_unsupported', data: null });
    const output = await app.inject({ method: 'POST', url: '/im/sessions/discoveries/d1/confirm', payload: { target: { kind: 'session', session_id: 'sess' }, output_enabled: true } });
    expect(output.statusCode).toBe(200);
    expect(output.json()).toMatchObject({ code: 40001, msg: 'output_unsupported', data: null });
    expect((await app.inject({ method: 'GET', url: '/im/sessions' })).json().data.bindings).toEqual([]);
    const confirmed = await app.inject({ method: 'POST', url: '/im/sessions/discoveries/d1/confirm', payload: { target: { kind: 'session', session_id: 'sess' } } });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().code).toBe(0);
    const created = confirmed.json().data.bindings[0];
    expect(created).toMatchObject({ input_enabled: false, output_enabled: false, session_id: 'sess' });
    expect(created.persona_id).toBeUndefined();
    const patchInput = await app.inject({ method: 'PATCH', url: `/im/sessions/bindings/${created.id}`, payload: { input_enabled: true } });
    expect(patchInput.json()).toMatchObject({ code: 40001, msg: 'input_unsupported' });
    const patchOutput = await app.inject({ method: 'PATCH', url: `/im/sessions/bindings/${created.id}`, payload: { output_enabled: true } });
    expect(patchOutput.json()).toMatchObject({ code: 40001, msg: 'output_unsupported' });
    const after = (await app.inject({ method: 'GET', url: '/im/sessions' })).json().data.bindings[0];
    expect(after).toMatchObject({ input_enabled: false, output_enabled: false });
  } finally { await app.close(); await bridge.close(); }
});
