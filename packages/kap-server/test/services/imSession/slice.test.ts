import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IBotService, IConfigService, ISessionIndex, ISessionInteractionService, ISessionManager, ISessionQuestionService, type Scope } from '@kiki/agent-core-v2';
import { IPluginHostService } from '@kiki/agent-core-v2/app/plugin/pluginHostService';
import { FEISHU_TEXT_UTF8_BYTES, splitFeishuText, type SessionAdapter, type SessionInbound, type SessionOutbound, type SessionPlatformId, type SessionReceipt, type SessionSink } from '@nb-im/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NotificationService } from '../../../src/services/notifications/notificationService';
import type { ImProviderKind } from '@kiki/protocol';
import { ImSessionBridge } from '../../../src/services/imSession/bridge';
import { FakeImAdapter, fakeAdapterFactory } from '../../../src/services/imSession/fakeAdapter';
import { createImSessionHost } from '../../../src/services/imSession/host';
import { HubSessionAdapter } from '../../../src/services/imSession/hubAdapter';
import type { ImAdapterFactory, ImInboundIdentity } from '../../../src/services/imSession/adapter';
import type { ImPendingQuestion, ImSessionPorts, ImVisibleReply } from '../../../src/services/imSession/ports';
import { WechatQrLogin, type WechatLoginFetch, type WechatLoginResponse } from '../../../src/services/imSession/wechatLogin';

const TOKEN = 'wxtok-9f3a';
const SECRET = 'ctx-secret-value';
const NOW = 1_700_000_000_000;
const NOTICE = 'This platform rejected the message as too long and cannot take a file.';
const identity: ImInboundIdentity = { chatId: 'c1', senderId: 'u1', topicId: '0', senderName: 'Ada' };

const homes: string[] = [];
let service: NotificationService | undefined;

afterEach(async () => {
  await service?.close();
  service = undefined;
  await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'kiki-im-slice-'));
  homes.push(home);
  return home;
}

function requestText(body: RequestInit['body']): string {
  if (typeof body !== 'string') throw new Error('expected a string request body');
  return body;
}

function jsonResponse(body: unknown, status = 200): WechatLoginResponse {
  return { status, text: async () => JSON.stringify(body) };
}

function headerRecord(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

function openSession(platform: SessionPlatformId, instanceId: string): SessionAdapter & { sink?: SessionSink; sent: SessionOutbound[] } {
  const sent: SessionOutbound[] = [];
  const adapter = {
    platform,
    instance_id: instanceId,
    account: { platform, account_id: 'acct' },
    limits: { text_characters: null, text_utf8_bytes: platform === 'feishu_app' ? FEISHU_TEXT_UTF8_BYTES : null, callback_data_bytes: null, voice_mime: null, image_bytes: null, file_bytes: null },
    state: 'running' as const,
    sink: undefined as SessionSink | undefined,
    sent,
    start(sink: SessionSink) { adapter.sink = sink; return Promise.resolve(); },
    stop() { return Promise.resolve(); },
    send(message: SessionOutbound) {
      sent.push(message);
      const id = message.type === 'edit_text' ? message.message_id : 'm1';
      return Promise.resolve({ status: 'accepted' as const, message_ids: [id] });
    },
  };
  return adapter;
}

function admit(raw: { sink?: SessionSink }, platform: SessionPlatformId, text: string, extra: Partial<SessionInbound> = {}): Promise<unknown> {
  return raw.sink!.admit({
    event_key: extra.event_key ?? `e:${text}`,
    platform_event_id: '1',
    cursor: '{"v":1}',
    identity: { platform, account_id: 'acct', chat_id: 'c1', sender_id: 'u1', topic_id: '0', chat_kind: 'private' },
    payload: { type: 'text', text },
    ...extra,
  });
}

function memoryPorts(kind: ImProviderKind, questions: () => readonly ImPendingQuestion[] = () => []): { ports: ImSessionPorts; stored: () => string; logs: string[]; submitted: unknown[] } {
  const secrets = new Map<string, string>();
  const logs: string[] = [];
  const submitted: unknown[] = [];
  let stored = '';
  let frames: ImVisibleReply[] = [{ text: '', done: true, media: [] }];
  let frame = 0;
  const ports: ImSessionPorts = {
    credentials: {
      list: () => [...secrets.keys()].map((id) => ({ id, providerId: kind, configured: true })),
      read: (id) => secrets.get(id),
      write: async (id, value) => { secrets.set(id, value); },
      check: async () => ({ ok: true, accountId: 'acct' }),
      create: async ({ credential }) => { secrets.set('inst', credential); return { instanceId: 'inst' }; },
    },
    sessions: {
      listPersonas: async () => [{ id: 'ada', name: 'Ada', homeSessionId: 'home' }],
      listSessions: async () => [{ id: 'home', title: 'Home', personaId: 'ada' }],
      owns: async (sessionId) => sessionId === 'home',
      ensureHome: async () => ({ homeSessionId: 'home' }),
      setHome: async () => undefined,
      activity: async () => ({ busy: false, pending: 'none', queueLength: 0 }),
      submit: async (input) => { submitted.push(input); return { duplicate: false, promptId: input.promptId, turnId: 3, deliveryState: 'pending' }; },
      steer: async () => 'steered',
      abort: async () => false,
      saveMedia: async (input) => [{ type: 'text', text: input.name }],
      readVisible: async () => { const next = frames[Math.min(frame, frames.length - 1)]!; frame += 1; return next; },
      listInteractions: async () => ({ approvals: [], questions: questions() }),
      decideApproval: async () => 'decided',
      decideHostKey: async () => 'decided',
      answerQuestion: async () => 'answered',
    },
    logger: { info(fields, message) { logs.push(`${JSON.stringify(fields)} ${message}`); } },
    load: async () => stored === '' ? undefined : stored,
    save: async (value) => { stored = value; },
  };
  return {
    ports,
    stored: () => stored,
    logs,
    submitted,
    setFrames(next: ImVisibleReply[]) { frames = next; frame = 0; },
  } as { ports: ImSessionPorts; stored: () => string; logs: string[]; submitted: unknown[] };
}

function bridgeWith(factory: ImAdapterFactory, kind: ImProviderKind, questions?: () => readonly ImPendingQuestion[]) {
  const harness = memoryPorts(kind, questions);
  const bridge = new ImSessionBridge({ ports: harness.ports, factories: [factory], editIntervalMs: 0, now: () => NOW, wait: () => Promise.resolve() });
  return { bridge, ...harness };
}

async function hostCore(home: string): Promise<{ core: Scope; service: NotificationService }> {
  let stored: unknown;
  const config = {
    ready: Promise.resolve(),
    get: () => stored,
    replaceSections: async (sections: Record<string, unknown>) => { stored = sections['notifications']; },
  };
  const sessionGet = (key: unknown) => {
    if (key === ISessionInteractionService) return interactions;
    if (key === ISessionQuestionService) return questionService;
    throw new Error('unexpected_session_service');
  };
  const interactions = {
    listPending: (kind?: string) => kind !== undefined && kind !== 'question' ? [] : pending,
    isRecentlyResolved: () => false,
  };
  const questionService = { answer(id: string, result: unknown) { answered.push({ id, result }); } };
  const core = { instantiation: { provide() {} }, accessor: { get: (key: unknown) => {
    if (key === IConfigService) return config;
    if (key === ISessionIndex) return { get: async (id: string) => id === 'home' ? { id } : undefined };
    if (key === ISessionManager) return { list: () => [], acquire: async () => ({ handle: { accessor: { get: sessionGet } }, dispose: async () => undefined }) };
    if (key === IBotService) return { list: async () => [], ensureHomeSession: async () => ({ homeSessionId: 'home' }) };
    if (key === IPluginHostService) return { attachImAdapters: async () => undefined };
    throw new Error('unexpected_app_service');
  } } } as unknown as Scope;
  const opened = new NotificationService(core, home, () => false, () => undefined);
  await opened.start();
  return { core, service: opened };
}

const pending: { id: string; kind: 'question'; payload: { questions: { question: string; options: { label: string }[]; multiSelect?: boolean }[] }; origin: Record<string, never>; createdAt: number }[] = [];
const answered: { id: string; result: unknown }[] = [];

describe('wechat qr login', () => {
  it('stores a confirmed login, drops a bad base url, and keeps the token out of results', async () => {
    const home = await tempHome();
    const calls: { url: string; init: RequestInit }[] = [];
    const polls: unknown[] = [];
    let hang = false;
    const fetchImpl: WechatLoginFetch = (url, init) => {
      calls.push({ url, init });
      if (url.includes('get_bot_qrcode')) {
        const index = calls.filter((call) => call.url.includes('get_bot_qrcode')).length;
        return Promise.resolve(jsonResponse({ qrcode: `qr-secret-${index}`, qrcode_img_content: `img-${index}` }));
      }
      if (hang) {
        return new Promise((_resolve, reject) => {
          const fail = () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); };
          if (init.signal?.aborted) fail();
          else init.signal?.addEventListener('abort', fail, { once: true });
        });
      }
      const next = polls.shift();
      if (next === undefined) return Promise.resolve(jsonResponse({ status: 'wait' }));
      return Promise.resolve(jsonResponse(next));
    };
    const opened = await hostCore(home);
    service = opened.service;
    const bridge = await createImSessionHost({ core: opened.core, homeDir: home, notifications: service, logger: { info() {} }, wechatFetch: fetchImpl, factories: [] });
    const first = await bridge.startWechatQr();
    expect(first.image).toBe('img-1');
    expect(JSON.stringify(first)).not.toContain('qr-secret');
    expect(calls[0]?.url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
    expect(calls[0]?.init.method).toBe('POST');
    expect(headerRecord(calls[0]!.init)).toEqual({ 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': Buffer.from('kiki-im-wechat', 'utf8').toString('base64') });
    expect(JSON.parse(requestText(calls[0]?.init.body))).toEqual({ local_token_list: [] });
    expect(JSON.stringify(calls[0]?.init.headers)).not.toContain(TOKEN);
    polls.push({ status: 'wait' });
    await expect(bridge.pollWechatQr(first.login_id, '1234')).resolves.toEqual({ status: 'wait' });
    expect(calls.at(-1)?.url).toContain('verify_code=1234');
    expect(calls.at(-1)?.init.method).toBe('GET');
    expect(headerRecord(calls.at(-1)!.init)).toEqual({ 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '512' });
    polls.push({ status: 'expired' });
    await expect(bridge.pollWechatQr(first.login_id)).resolves.toEqual({ status: 'expired' });
    await expect(bridge.pollWechatQr(first.login_id)).rejects.toThrow('unknown_login');
    const second = await bridge.startWechatQr();
    expect(second.login_id).not.toBe(first.login_id);
    expect(second.image).toBe('img-2');
    await expect(bridge.cancelWechatQr(second.login_id)).resolves.toEqual({});
    await expect(bridge.pollWechatQr(second.login_id)).rejects.toThrow('unknown_login');
    const redirected = await bridge.startWechatQr();
    polls.push({ status: 'scaned_but_redirect', redirect_host: 'cdn.weixin.qq.com' });
    await expect(bridge.pollWechatQr(redirected.login_id)).resolves.toEqual({ status: 'scaned_but_redirect' });
    polls.push({ status: 'wait' });
    await bridge.pollWechatQr(redirected.login_id);
    expect(new URL(calls.at(-1)!.url).host).toBe('cdn.weixin.qq.com');
    polls.push({ status: 'scaned_but_redirect', redirect_host: 'https://user:pass@ilinkai.weixin.qq.com' });
    await expect(bridge.pollWechatQr(redirected.login_id)).rejects.toThrow('wechat_redirect_rejected');
    const before = Object.keys(service.getSettings().provider_instances);
    const rejected = await bridge.startWechatQr();
    polls.push({ status: 'confirmed', bot_token: TOKEN, ilink_bot_id: 'bot-x', baseurl: 'https://evil.example/bot' });
    await expect(bridge.pollWechatQr(rejected.login_id)).rejects.toThrow('wechat_base_url_rejected');
    expect(Object.keys(service.getSettings().provider_instances)).toEqual(before);
    const confirmed = await bridge.startWechatQr();
    polls.push({ status: 'confirmed', bot_token: TOKEN, ilink_bot_id: 'bot-9', baseurl: 'https://ilinkai.weixin.qq.com' });
    const stored = await bridge.pollWechatQr(confirmed.login_id);
    expect(stored).toMatchObject({ status: 'confirmed', account_id: 'bot-9' });
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    expect(existsSync(join(home, 'im-session-secrets.json'))).toBe(false);
    const settings = service.getSettings();
    const slot = settings.provider_instances[stored.provider_instance_id ?? '']?.options['token_slot'];
    expect(service.revealCredential(String(slot))).toBe(`${TOKEN}\nbot-9\nhttps://ilinkai.weixin.qq.com`);
    expect(JSON.stringify(settings)).not.toContain(TOKEN);
    const again = await bridge.startWechatQr();
    expect(again.login_id).not.toBe(confirmed.login_id);
    const posted = calls.filter((call) => call.url.includes('get_bot_qrcode')).at(-1)!;
    expect(JSON.parse(requestText(posted.init.body)).local_token_list).toEqual([TOKEN]);
    hang = true;
    const pendingPoll = bridge.pollWechatQr(again.login_id);
    await bridge.cancelWechatQr(again.login_id);
    await expect(pendingPoll).rejects.toThrow('wechat_login_cancelled');
    expect(calls.every((call) => call.url.startsWith('https://') && call.url.includes('.weixin.qq.com'))).toBe(true);
    await bridge.close();
  });

  it('sends at most ten stored tokens and scrubs a token from a store error', async () => {
    const tokens = Array.from({ length: 12 }, (_item, index) => `tok-${index}`);
    let body = '';
    const limited = new WechatQrLogin(async (_url, init) => {
      body = requestText(init.body);
      return jsonResponse({ qrcode: 'q', qrcode_img_content: 'img' });
    }, () => tokens, async () => ({ instanceId: 'x' }));
    await limited.start();
    expect(JSON.parse(body).local_token_list).toEqual(tokens.slice(0, 10));
    const login = new WechatQrLogin(async (url) => {
      if (url.includes('get_bot_qrcode')) return jsonResponse({ qrcode: 'qr-secret', qrcode_img_content: 'img' });
      return jsonResponse({ status: 'confirmed', bot_token: TOKEN, ilink_bot_id: 'bot-9', baseurl: 'https://ilinkai.weixin.qq.com' });
    }, () => [], async () => { throw new Error(`store failed ${TOKEN}`); });
    const started = await login.start();
    const failed = await login.poll(started.login_id).then(() => '', (error: unknown) => error instanceof Error ? error.message : '');
    expect(failed).toBe('store failed [redacted]');
    let saved = '';
    const omitted = new WechatQrLogin(async (url) => {
      if (url.includes('get_bot_qrcode')) return jsonResponse({ qrcode: 'q', qrcode_img_content: 'img' });
      return jsonResponse({ status: 'confirmed', bot_token: TOKEN, ilink_bot_id: 'bot-omit' });
    }, () => [], async (credential) => { saved = credential; return { instanceId: 'inst' }; });
    const startedOmit = await omitted.start();
    const omittedResult = await omitted.poll(startedOmit.login_id);
    expect(omittedResult).toMatchObject({ status: 'confirmed', account_id: 'bot-omit', provider_instance_id: 'inst' });
    expect(saved).toBe(`${TOKEN}\nbot-omit`);
    expect(JSON.stringify(omittedResult)).not.toContain(TOKEN);
    expect(failed).not.toContain(TOKEN);
  });
});

describe('im session restart and durable files', () => {
  it.each([
    { kind: 'wechat_bridge' as const, platform: 'personal_wechat' as const, paste: 'wechat_token=wxtok\nwechat_account=bot' },
    { kind: 'onebot_v11' as const, platform: 'qq_onebot_v11' as const, paste: 'onebot=ws://127.0.0.1:6700' },
  ])('uses stored chat kind and reply context on the next $kind send', async ({ kind, platform, paste }) => {
    const home = await tempHome();
    const questions: ImPendingQuestion[] = [];
    const harness = memoryPorts(kind, () => questions);
    let raw = openSession(platform, 'inst');
    const factory: ImAdapterFactory = { providerKind: kind, create: () => new HubSessionAdapter(raw, home) };
    const first = new ImSessionBridge({ ports: harness.ports, factories: [factory], editIntervalMs: 0, now: () => NOW, wait: () => Promise.resolve() });
    await first.paste({ text: paste });
    await first.setListening('inst', true);
    const chatKind = platform === 'personal_wechat' ? 'private' : 'group';
    await admit(raw, platform, 'hi', { reply_context: SECRET, identity: { platform, account_id: 'acct', chat_id: 'c1', sender_id: 'u1', topic_id: '0', chat_kind: chatKind } });
    const snap = await first.snapshot();
    expect(JSON.stringify(snap)).not.toContain(SECRET);
    expect(JSON.stringify(snap)).not.toContain('chatKind');
    expect(snap.discoveries[0]?.identity.chat_kind).toBe(chatKind);
    await first.confirm(snap.discoveries[0]!.id, { target: { kind: 'persona', persona_id: 'ada' } });
    expect(harness.stored()).toContain(`"chatKind":"${chatKind}"`);
    expect(harness.stored()).not.toContain(SECRET);
    expect(harness.logs.join('\n')).not.toContain(SECRET);
    expect(JSON.stringify(harness.submitted)).not.toContain(SECRET);
    const replyFile = await readFile(join(home, 'im-session-reply.json'), 'utf8');
    expect(replyFile).toContain(SECRET);
    await first.close();
    raw = openSession(platform, 'inst');
    questions.push({ id: 'q1', questionIndex: 0, expiresAt: NOW + 1000, questionKey: 'Status', options: [{ id: 'opt_0_0', label: 'Yes' }], multi: false, allowOther: false });
    const second = new ImSessionBridge({ ports: harness.ports, factories: [factory], editIntervalMs: 0, now: () => NOW, wait: () => Promise.resolve() });
    await second.setListening('inst', true);
    await second.syncInteractions();
    expect(harness.submitted).toEqual([]);
    expect(raw.sent).toHaveLength(1);
    expect(raw.sent[0]).toMatchObject({ type: 'text', target: { chat_id: 'c1', chat_kind: chatKind, reply_context: SECRET } });
    expect(harness.logs.join('\n')).not.toContain(SECRET);
    expect(JSON.stringify(await second.snapshot())).not.toContain(SECRET);
    await second.close();
  });

  it('does not replace an unreadable reply file', async () => {
    const home = await tempHome();
    const file = join(home, 'im-session-reply.json');
    await writeFile(file, '{', 'utf8');
    await chmod(file, 0o600);
    const raw = openSession('personal_wechat', 'inst');
    const hub = new HubSessionAdapter(raw, home);
    await expect(hub.sendText({ identity, text: 'yo', code: 'reply' })).rejects.toThrow('im_session_reply_unreadable');
    expect(await readFile(file, 'utf8')).toBe('{');
    expect(raw.sent).toEqual([]);
  });

  it('treats an empty bridge file as a first run and throws when the file cannot be read', async () => {
    const emptyHome = await tempHome();
    await writeFile(join(emptyHome, 'im-session-bridge.json'), '', 'utf8');
    const opened = await hostCore(emptyHome);
    service = opened.service;
    const bridge = await createImSessionHost({
      core: opened.core, homeDir: emptyHome, notifications: service, logger: { info() {} }, factories: [],
      wechatFetch: () => Promise.reject(new Error('wechat_fetch_blocked')),
    });
    expect((await bridge.snapshot()).bindings).toEqual([]);
    await bridge.close();
    await service.close();
    service = undefined;
    const blocked = await tempHome();
    await mkdir(join(blocked, 'im-session-bridge.json'));
    const again = await hostCore(blocked);
    service = again.service;
    await expect(createImSessionHost({
      core: again.core, homeDir: blocked, notifications: service, logger: { info() {} }, factories: [],
      wechatFetch: () => Promise.reject(new Error('wechat_fetch_blocked')),
    })).rejects.toThrow();
    expect((await stat(join(blocked, 'im-session-bridge.json'))).isDirectory()).toBe(true);
  });
});

describe('duplicate question stems', () => {
  it('answers two multi questions with the same text as separate indexes', async () => {
    const home = await tempHome();
    await writeFile(join(home, 'desktop.json'), JSON.stringify({ locale: 'en' }), 'utf8');
    pending.splice(0, pending.length, {
      id: 'ask1', kind: 'question', origin: {}, createdAt: Date.now(),
      payload: { questions: [
        { question: 'Pick one', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: true },
        { question: 'Pick one', options: [{ label: 'Red' }, { label: 'Green' }], multiSelect: true },
      ] },
    });
    answered.splice(0, answered.length);
    const adapter = new FakeImAdapter('telegram', '42');
    const opened = await hostCore(home);
    service = opened.service;
    const bridge = await createImSessionHost({
      core: opened.core, homeDir: home, notifications: service, logger: { info() {} },
      factories: [fakeAdapterFactory(adapter)],
      wechatFetch: () => Promise.reject(new Error('wechat_fetch_blocked')),
    });
    const pasted = await bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await bridge.setListening(pasted.provider_instance_id, true);
    await adapter.emit({ eventId: '1', identity, kind: 'text', text: 'hello' });
    await bridge.confirm((await bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'persona', persona_id: 'ada' } });
    await bridge.syncInteractions();
    const prompts = adapter.sent.filter((item) => item.code === 'question');
    expect(prompts.map((item) => item.text)).toEqual(['Pick one', 'Pick one']);
    const press = (message: (typeof prompts)[number] | undefined, label: string) => {
      const button = message?.buttons?.find((item) => item.label === label);
      if (button === undefined) throw new Error('missing_button');
      return adapter.emit({ eventId: `cb-${label}-${message?.text}-${prompts.indexOf(message!)}`, identity, kind: 'callback', callbackData: button.id, callbackQueryId: button.id });
    };
    await press(prompts[0], '1. Red');
    await press(prompts[0], 'Done');
    expect(answered).toEqual([]);
    await press(prompts[1], '2. Green');
    await press(prompts[1], 'Done');
    expect(answered).toEqual([{ id: 'ask1', result: { answers: { q_0: 'Red', q_1: 'Green' }, method: 'number_key' } }]);
    await bridge.close();
  });
});

describe('long replies', () => {
  async function watch(platform: SessionPlatformId, kind: ImProviderKind, paste: string, frames: ImVisibleReply[], send: (message: SessionOutbound, sent: SessionOutbound[]) => Promise<SessionReceipt>) {
    const raw = openSession(platform, 'inst');
    raw.send = (message) => { raw.sent.push(message); return send(message, raw.sent); };
    const harness = bridgeWith({ providerKind: kind, create: () => new HubSessionAdapter(raw) }, kind);
    const framed = harness as typeof harness & { setFrames: (next: ImVisibleReply[]) => void };
    framed.setFrames(frames);
    try {
      await harness.bridge.paste({ text: paste });
      await harness.bridge.setListening('inst', true);
      await admit(raw, platform, 'hello');
      await harness.bridge.confirm((await harness.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'persona', persona_id: 'ada' }, reply: 'edit' });
      await admit(raw, platform, 'go', { event_key: 'e:go' });
      await vi.waitFor(() => {
        const saved = JSON.parse(harness.stored()) as { replies: { open: boolean }[] };
        expect(saved.replies).toHaveLength(1);
        expect(saved.replies[0]?.open).toBe(false);
      });
      return raw.sent;
    } finally {
      await harness.bridge.close();
    }
  }

  it('keeps every accepted Feishu part and retries when a surplus edit fails', async () => {
    const text = 'a'.repeat(FEISHU_TEXT_UTF8_BYTES);
    const parts = splitFeishuText(text);
    expect(parts.length).toBeGreaterThan(1);
    let accepted = 0;
    const sent = await watch('feishu_app', 'feishu_app', 'app_id=cli_a\napp_secret=s3cr3t', [
      { text, done: false, media: [] },
      { text: 'hi', done: true, media: [] },
    ], async (message) => {
      if (message.type === 'text') {
        accepted += 1;
        return { status: 'accepted', message_ids: [`m${accepted}`] };
      }
      if (message.type === 'edit_text' && message.text === ' ') return { status: 'failed', message_ids: [], error_kind: 'unknown', diagnostic_code: 'edit_failed' };
      if (message.type === 'edit_text') return { status: 'accepted', message_ids: [message.message_id] };
      return { status: 'accepted', message_ids: ['other'] };
    });
    const texts = sent.filter((item) => item.type === 'text');
    expect(texts.map((item) => item.type === 'text' ? item.text : '')).toEqual(parts);
    expect(sent.some((item) => item.type === 'text_parts')).toBe(false);
    const spaces = sent.filter((item) => item.type === 'edit_text' && item.text === ' ');
    expect(spaces.length).toBeGreaterThanOrEqual(parts.length);
    expect(new Set(spaces.map((item) => item.type === 'edit_text' ? item.message_id : '')).size).toBe(parts.length - 1);
  });

  it('records only the Feishu id accepted before a failed part', async () => {
    const text = 'b'.repeat(FEISHU_TEXT_UTF8_BYTES);
    const parts = splitFeishuText(text);
    expect(parts.length).toBeGreaterThan(1);
    let texts = 0;
    const sent = await watch('feishu_app', 'feishu_app', 'app_id=cli_a\napp_secret=s3cr3t', [
      { text, done: false, media: [] },
      { text, done: true, media: [] },
    ], async (message) => {
      if (message.type === 'text') {
        texts += 1;
        if (texts === 2) return { status: 'failed', message_ids: ['tail'], error_kind: 'unknown', failed_part: 0 };
        return { status: 'accepted', message_ids: [texts === 1 ? 'm1' : 'm3'] };
      }
      if (message.type === 'edit_text') return { status: 'accepted', message_ids: [message.message_id] };
      return { status: 'accepted', message_ids: ['other'] };
    });
    const edits = sent.filter((item) => item.type === 'edit_text');
    expect(edits.map((item) => item.type === 'edit_text' ? item.message_id : '')).toEqual(['m1']);
    expect(sent.some((item) => item.type === 'edit_text' && item.message_id === 'tail')).toBe(false);
    const bodies = sent.filter((item) => item.type === 'text').map((item) => item.type === 'text' ? item.text : '');
    expect(bodies.filter((item) => item === parts[1]).length).toBeGreaterThanOrEqual(1);
    expect(bodies[0]).toBe(parts[0]);
  });

  it('accepts a WeChat send with no message id and sends a new message later', async () => {
    const sent = await watch('personal_wechat', 'wechat_bridge', 'wechat_token=wxtok\nwechat_account=bot', [
      { text: 'Hel', done: false, media: [] },
      { text: 'Hello', done: true, media: [] },
    ], async (message) => {
      if (message.type === 'edit_text') return { status: 'failed', message_ids: [], error_kind: 'unsupported', diagnostic_code: 'wechat_unsupported_edit' };
      if (message.type === 'text') return { status: 'accepted', message_ids: [] };
      return { status: 'accepted', message_ids: ['file'] };
    });
    expect(sent.filter((item) => item.type === 'edit_text')).toEqual([]);
    expect(sent.filter((item) => item.type === 'text').map((item) => item.type === 'text' ? item.text : '')).toEqual(['Hel', 'Hello']);
  });

  it('sends the original WeChat text as one file and does not keep a failed file', async () => {
    const text = 'exact-wechat-body';
    let media = 0;
    let failFile = true;
    const failed = await watch('personal_wechat', 'wechat_bridge', 'wechat_token=wxtok\nwechat_account=bot', [
      { text, done: false, media: [] },
      { text, done: true, media: [] },
    ], async (message) => {
      if (message.type === 'text' && message.text === text) return { status: 'failed', message_ids: [], error_kind: 'too_long' };
      if (message.type === 'media') { media += 1; return { status: 'failed', message_ids: [], error_kind: 'unknown' }; }
      return { status: 'accepted', message_ids: ['n1'] };
    });
    expect(media).toBeGreaterThanOrEqual(2);
    expect(failed.filter((item) => item.type === 'text').every((item) => item.type === 'text' && item.text === text)).toBe(true);
    expect(failed.some((item) => item.type === 'media' && item.media.kind === 'file' && item.media.filename === 'reply.txt')).toBe(true);
    media = 0;
    failFile = false;
    const sent = await watch('personal_wechat', 'wechat_bridge', 'wechat_token=wxtok\nwechat_account=bot', [
      { text, done: false, media: [] },
      { text, done: true, media: [] },
    ], async (message) => {
      if (message.type === 'text' && message.text === text) return { status: 'failed', message_ids: [], error_kind: 'too_long' };
      if (message.type === 'media') {
        media += 1;
        if (failFile) return { status: 'failed', message_ids: [], error_kind: 'unknown' };
        return { status: 'accepted', message_ids: ['file1'] };
      }
      return { status: 'accepted', message_ids: ['n1'] };
    });
    expect(media).toBe(1);
    const file = sent.find((item) => item.type === 'media');
    expect(file?.type === 'media' ? new TextDecoder().decode(file.media.bytes) : '').toBe(text);
    expect(file?.type === 'media' ? file.media.filename : '').toBe('reply.txt');
  });

  it('sends the whole QQ text after too_long and does not invent a shorter first send', async () => {
    const text = 'Q'.repeat(5000);
    const accepted: string[] = [];
    let full = 0;
    const sent = await watch('qq_onebot_v11', 'onebot_v11', 'onebot=ws://127.0.0.1:6700', [
      { text, done: false, media: [] },
      { text, done: true, media: [] },
    ], async (message) => {
      if (message.type === 'text' && message.text === text) { full += 1; return { status: 'failed', message_ids: [], error_kind: 'too_long' }; }
      if (message.type === 'text_parts') {
        if (message.parts.some((part) => part.length >= text.length)) return { status: 'failed', message_ids: [], error_kind: 'too_long', failed_part: 0 };
        accepted.push(...message.parts);
        return { status: 'accepted', message_ids: message.parts.map((_, index) => `p${accepted.length}-${index}`) };
      }
      if (message.type === 'media') return { status: 'failed', message_ids: [], error_kind: 'unsupported' };
      return { status: 'accepted', message_ids: ['n1'] };
    });
    expect(full).toBe(1);
    expect(accepted.join('')).toBe(text);
    expect(accepted.every((part) => part.length < text.length && part.length > 0)).toBe(true);
    expect(sent.some((item) => item.type === 'media')).toBe(false);
    expect(sent.some((item) => item.type === 'text' && item.text === NOTICE)).toBe(false);
    expect(sent.filter((item) => item.type === 'text_parts').flatMap((item) => item.type === 'text_parts' ? item.parts : []).join('')).toBe(text);
  });

  it('keeps accepted QQ segments and resumes only the unsent tail', async () => {
    const text = Array.from({ length: 5000 }, (_, index) => String.fromCharCode(33 + (index % 90))).join('');
    const accepted: string[] = [];
    let blocked = false;
    const sent = await watch('qq_onebot_v11', 'onebot_v11', 'onebot=ws://127.0.0.1:6700', [
      { text, done: false, media: [] },
      { text, done: true, media: [] },
    ], async (message) => {
      if (message.type === 'text' && message.text === text) return { status: 'failed', message_ids: [], error_kind: 'too_long' };
      if (message.type === 'text_parts') {
        if (message.parts.some((part) => part.length > 1000)) return { status: 'failed', message_ids: [], error_kind: 'too_long', failed_part: 0 };
        if (message.parts.length > 1 && !blocked) {
          blocked = true;
          const kept = message.parts.slice(0, 2);
          accepted.push(...kept);
          return { status: 'failed', message_ids: ['a', 'b'], error_kind: 'unknown', failed_part: 2 };
        }
        accepted.push(...message.parts);
        return { status: 'accepted', message_ids: message.parts.map((_, index) => `p${accepted.length}-${index}`) };
      }
      if (message.type === 'media') return { status: 'failed', message_ids: [], error_kind: 'unsupported' };
      return { status: 'accepted', message_ids: ['n1'] };
    });
    expect(accepted.join('')).toBe(text);
    expect(accepted.filter((part) => part === text.slice(0, 625)).length).toBe(1);
    expect(accepted.filter((part) => part === text.slice(625, 1250)).length).toBe(1);
    expect(accepted.filter((part) => part === text.slice(1250, 1875)).length).toBe(1);
    expect(sent.filter((item) => item.type === 'text' && item.text === text).length).toBe(1);
    expect(sent.some((item) => item.type === 'media')).toBe(false);
    expect(sent.some((item) => item.type === 'text' && item.text === NOTICE)).toBe(false);
    const failedBatch = sent.find((item) => item.type === 'text_parts' && item.parts.length > 1);
    expect(failedBatch?.type === 'text_parts' ? failedBatch.parts[2] : '').toBe(text.slice(1875, 2500));
  });

  it('sends one QQ notice when a single character is still too long', async () => {
    const text = 'QQQQ';
    let notice = 0;
    const sent = await watch('qq_onebot_v11', 'onebot_v11', 'onebot=ws://127.0.0.1:6700', [
      { text, done: false, media: [] },
      { text, done: true, media: [] },
    ], async (message) => {
      if (message.type === 'text' && message.text === NOTICE) { notice += 1; return { status: 'accepted', message_ids: ['n1'] }; }
      if (message.type === 'media') return { status: 'failed', message_ids: [], error_kind: 'unsupported' };
      return { status: 'failed', message_ids: [], error_kind: 'too_long', ...(message.type === 'text_parts' ? { failed_part: 0 } : {}) };
    });
    expect(notice).toBe(1);
    expect(sent.some((item) => item.type === 'media')).toBe(false);
    expect(sent.some((item) => item.type === 'text' && item.text === text)).toBe(true);
  });
});
