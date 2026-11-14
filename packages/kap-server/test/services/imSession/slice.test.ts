import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostProcessService, IAgentContextMemoryService, IAgentLifecycleService, IAgentLoopService, IAgentProfileService, IAgentPromptService, IBootstrapService, IBotService, IConfigService, IEventService, IFileService, IHostProcessService, ISessionContext, ISessionIndex, ISessionInteractionService, ISessionManager, ISessionMediaStore, ISessionMetadata, ISessionQuestionService, IWorkAdmissionService, ITelemetryService, promptAdmission, type Scope } from '@kiki/agent-core-v2';
import { IAtomicDocumentStore } from '@kiki/agent-core-v2/persistence/interface/atomicDocumentStore';
import { JsonAtomicDocumentStore } from '@kiki/agent-core-v2/persistence/backends/node-fs/atomicDocumentStore';
import { IFlagService } from '@kiki/agent-core-v2/app/flag/flag';
import { IPluginService } from '@kiki/agent-core-v2/app/plugin/plugin';
import { PluginService } from '@kiki/agent-core-v2/app/plugin/pluginService';
import { IPluginHostService, PluginHostService } from '@kiki/agent-core-v2/app/plugin/pluginHostService';
import { IPluginSettingsService, PluginSettingsService } from '@kiki/agent-core-v2/app/plugin/pluginSettingsService';
import { IPluginUsageService } from '@kiki/agent-core-v2/app/pluginUsage/pluginUsage';
import { IModelCatalog } from '@kiki/agent-core-v2/kosong/model/catalog';
import { IProviderService, type ProviderConfig } from '@kiki/agent-core-v2/kosong/provider/provider';
import { IOAuthService } from '@kiki/agent-core-v2/app/auth/auth';
import { IRequestIdentityCatalog, RequestIdentityCatalog } from '@kiki/agent-core-v2/app/requestIdentity/requestIdentityCatalog';
import { ISkillDiscovery } from '@kiki/agent-core-v2/app/skillCatalog/skillDiscovery';
import { IFileSystemStorageService } from '@kiki/agent-core-v2/persistence/interface/storage';
import { FileStorageService } from '@kiki/agent-core-v2/persistence/backends/node-fs/fileStorageService';
import { LifecycleScope } from '@kiki/agent-core-v2/app/scopes';
import { _clearScopedRegistryForTests, registerScopedService, ScopeActivation } from '@kiki/agent-core-v2/_base/di/scope';
import { createScopedTestHost, stubPair } from '@kiki/agent-core-v2/_base/di/test';
import { Event } from '@kiki/agent-core-v2/_base/event';
import { stubBootstrap } from '../../../../agent-core-v2/test/app/bootstrap/stubs';
import { createFeishuSessionAdapter, FEISHU_TEXT_UTF8_BYTES, splitFeishuText, type SessionAdapter, type SessionInbound, type SessionOutbound, type SessionPlatformId, type SessionReceipt, type SessionSink, type SessionSpec } from '@nb-corp/nb-im';
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
const pluginHosts: Array<{ dispose(): Promise<void> }> = [];
const hostProcesses: HostProcessService[] = [];
let service: NotificationService | undefined;

afterEach(async () => {
  await service?.close();
  service = undefined;
  await Promise.all(pluginHosts.splice(0).map((host) => host.dispose()));
  await Promise.all(hostProcesses.splice(0).map((host) => host.dispose()));
  _clearScopedRegistryForTests();
  await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'kiki-im-slice-'));
  homes.push(home);
  return home;
}

function pcmWav(sampleRate: number, channels: number, durationMs: number): Buffer {
  const bitsPerSample = 16;
  const frames = Math.round(sampleRate * durationMs / 1000);
  const dataBytes = frames * channels * bitsPerSample / 8;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.byteLength - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  wav.writeUInt16LE(channels * bitsPerSample / 8, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame++) {
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * frame / sampleRate) * 12_000);
    for (let channel = 0; channel < channels; channel++) wav.writeInt16LE(sample, 44 + (frame * channels + channel) * 2);
  }
  return wav;
}

async function createAsrPluginHost(home: string): Promise<IPluginHostService> {
  _clearScopedRegistryForTests();
  registerScopedService(LifecycleScope.App, IPluginService, PluginService, ScopeActivation.OnDemand, 'plugin');
  registerScopedService(LifecycleScope.App, IPluginSettingsService, PluginSettingsService, ScopeActivation.OnDemand, 'plugin');
  registerScopedService(LifecycleScope.App, IPluginHostService, PluginHostService, ScopeActivation.OnDemand, 'plugin');
  registerScopedService(LifecycleScope.App, IAtomicDocumentStore, JsonAtomicDocumentStore, ScopeActivation.OnDemand, 'storage');
  registerScopedService(LifecycleScope.App, IRequestIdentityCatalog, RequestIdentityCatalog, ScopeActivation.OnDemand, 'requestIdentity');
  const storage = new FileStorageService(home);
  const configSections = new Map<string, unknown>();
  const config = {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidSectionChange: Event.None,
    get: (key: string) => configSections.get(key) ?? {},
    set: async (key: string, value: unknown) => { configSections.set(key, value); },
    replace: async (key: string, value: unknown) => { configSections.set(key, value); },
    replaceSections: async (sections: Record<string, unknown>) => { for (const [key, value] of Object.entries(sections)) configSections.set(key, value); },
  } as unknown as IConfigService;
  const providers = {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeProviders: Event.None,
    onDidChangeDefaultProvider: Event.None,
    onDidChangeTransportDefaults: Event.None,
    get: () => undefined,
    list: () => ({} as Record<string, ProviderConfig>),
    getDefaultProvider: () => undefined,
    set: async () => undefined,
    delete: async () => undefined,
    loadAll: () => undefined,
    replaceAll: async () => undefined,
    setDefaultProvider: async () => undefined,
    transportDefaults: () => ({}),
    setTransportDefaults: () => undefined,
  } as unknown as IProviderService;
  const usage = {
    _serviceBrand: undefined,
    enabled: () => false,
    allows: async () => true,
    registerPluginStateReader: () => ({ dispose: () => undefined }),
    onDidChange: Event.None,
    onDidApply: Event.None,
  } as unknown as IPluginUsageService;
  const target = createScopedTestHost([
    stubPair(IBootstrapService, stubBootstrap(home)),
    stubPair(IConfigService, config),
    stubPair(IFlagService, { enabled: (id: string) => id !== 'plugin_app_lifecycle' } as unknown as IFlagService),
    stubPair(IPluginUsageService, usage),
    stubPair(ISessionIndex, { get: async () => undefined } as unknown as ISessionIndex),
    stubPair(ISessionManager, {} as ISessionManager),
    stubPair(IProviderService, providers),
    stubPair(IModelCatalog, { _serviceBrand: undefined, listModels: async () => [], listProviders: async () => [] } as unknown as IModelCatalog),
    stubPair(IOAuthService, { resolveTokenProvider: () => ({ getAccessToken: async () => 'fixture-token' }) } as unknown as IOAuthService),
    stubPair(ISkillDiscovery, { _serviceBrand: undefined, discover: async () => ({ skills: [], skipped: [], scannedRoots: [], scannedDirectories: [] }) } satisfies ISkillDiscovery),
    stubPair(IFileSystemStorageService, storage),
  ]);
  try {
    const source = fileURLToPath(new URL('../../../../agent-core-v2/test/fixtures/plugin-asr/', import.meta.url));
    const plugins = target.app.accessor.get(IPluginService);
    const plan = await plugins.previewPlugin({ source });
    await plugins.installPlugin({ source, fingerprint: plan.fingerprint, consent: true });
    await plugins.setPluginEnabled({ id: 'fixture-asr', enabled: true });
    const pluginHost = target.app.accessor.get(IPluginHostService);
    expect(await pluginHost.listAsrProviders()).toMatchObject([
      { pluginId: 'fixture-asr', definition: { id: 'speech' } },
      { pluginId: 'fixture-asr', definition: { id: 'alternate' } },
    ]);
    pluginHosts.push({
      dispose: async () => {
        await target.dispose();
        await storage.close();
        _clearScopedRegistryForTests();
      },
    });
    return pluginHost;
  } catch (error) {
    await target.dispose();
    await storage.close();
    _clearScopedRegistryForTests();
    throw error;
  }
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

  it('routes a Feishu post rich-text message through createImSessionHost saveMedia and submit into IAgentPromptService', async () => {
    const home = await tempHome();
    const pluginHost = await createAsrPluginHost(home);
    const listAsrProviders = vi.spyOn(pluginHost, 'listAsrProviders');
    const processService = new HostProcessService();
    hostProcesses.push(processService);
    const audioBytes = pcmWav(44_100, 2, 200);
    const configSections = new Map<string, unknown>();
    const docs = new Map<string, unknown>();
    const savedFiles = new Map<string, { id: string; name: string; media_type: string; size: number; bytes: Buffer; path: string }>();
    const submittedPrompts: unknown[] = [];
    let fileSeq = 0;

    const promptService = {
      lookup: () => undefined,
      list: () => ({ pending: [] }),
      [promptAdmission]: (promptId?: string) => ({
        id: promptId ?? 'reserved',
        submit: async (message: unknown) => {
          submittedPrompts.push(message);
          return {
            id: promptId ?? 'reserved',
            state: 'pending',
            launched: Promise.resolve(),
            completion: new Promise(() => {}),
          };
        },
        dispose: async () => undefined,
      }),
    };
    const agent = {
      accessor: {
        get: (key: unknown) => {
          if (key === IAgentPromptService) return promptService;
          if (key === IAgentProfileService) return { getModelProviderType: () => 'openai', data: () => ({ executorId: 'native' }) };
          if (key === IAgentLoopService) return { status: () => ({ activeTurnId: undefined }) };
          if (key === IAgentContextMemoryService) return { get: () => [] };
          throw new Error('unexpected_agent_service');
        },
      },
    };
    const sessionMediaStore = {
      materialize: async (input: { fileId: string; size: number; name: string; mimeType: string; stream: () => AsyncIterable<Uint8Array> }) => {
        const chunks: Buffer[] = [];
        for await (const chunk of input.stream()) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        const path = join(home, 'media', input.fileId);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
        savedFiles.set(input.fileId, { id: input.fileId, name: input.name, media_type: input.mimeType, size: input.size, bytes, path });
        return path;
      },
      retain: async () => undefined,
      open: async (id: string) => {
        const entry = savedFiles.get(id);
        return entry === undefined ? undefined : {
          path: entry.path, name: entry.name, size: entry.size, mediaType: entry.media_type,
          stream: async function* () { yield entry.bytes; },
        };
      },
      resolveDisplayPath: async (id: string) => savedFiles.get(id)?.path,
      read: async (id: string) => {
        const entry = savedFiles.get(id);
        return entry === undefined ? undefined : { name: entry.name, data: entry.bytes };
      },
      pathFor: () => undefined,
    };
    const sessionHandle = {
      accessor: {
        get: (key: unknown) => {
          if (key === IAgentLifecycleService) return { get: () => agent, create: async () => agent };
          if (key === ISessionContext) return { sessionDir: home };
          if (key === ISessionMediaStore) return sessionMediaStore;
          if (key === ISessionMetadata) return { read: async () => ({ title: 'Home', titleKind: 'custom' }), update: async () => undefined };
          if (key === ISessionInteractionService) return { listPending: () => [], isRecentlyResolved: () => false };
          throw new Error('unexpected_session_service');
        },
      },
    };
    const fileService = {
      save: async (stream: AsyncIterable< Uint8Array >, name: string, options?: { mimeType?: string }) => {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        const id = `file_${++fileSeq}`;
        const meta = { id, name, media_type: options?.mimeType ?? 'image/png', size: bytes.byteLength };
        savedFiles.set(id, { ...meta, bytes, path: join(home, `${id}-${name}`) });
        return meta;
      },
      get: async (id: string) => {
        const entry = savedFiles.get(id)!;
        return { meta: { id: entry.id, name: entry.name, media_type: entry.media_type, size: entry.size }, data: entry.bytes };
      },
      delete: async () => undefined,
    };
    const core = {
      instantiation: { provide() {} },
      accessor: {
        get: (key: unknown) => {
          if (key === IConfigService) {
            return {
              ready: Promise.resolve(),
              get: (section: string) => configSections.get(section),
              replace: async (section: string, value: unknown) => { configSections.set(section, value); },
              set: async (section: string, value: unknown) => { configSections.set(section, value); },
              replaceSections: async (sections: Record<string, unknown>) => { for (const [section, value] of Object.entries(sections)) configSections.set(section, value); },
            };
          }
          if (key === IBootstrapService) return { cacheDir: home, scope: () => 'store' };
          if (key === IAtomicDocumentStore) {
            return {
              get: async (_scope: string, k: string) => docs.get(k),
              set: async (_scope: string, k: string, v: unknown) => { docs.set(k, v); },
              delete: async (_scope: string, k: string) => { docs.delete(k); },
              read: async (_scope: string, k: string) => docs.get(k),
              write: async (_scope: string, k: string, v: unknown) => { docs.set(k, v); },
            };
          }
          if (key === ISessionIndex) return { get: async (id: string) => id === 'home' ? { id, title: 'Home' } : undefined, listRecent: async () => ({ items: [{ id: 'home', title: 'Home' }] }) };
          if (key === ISessionManager) return { list: () => [], get: () => sessionHandle, acquire: async () => ({ handle: sessionHandle, dispose: async () => undefined }) };
          if (key === IBotService) return { list: async () => [{ personaId: 'ada', name: 'Ada', homeSessionId: 'home' }], ensureHomeSession: async () => ({ homeSessionId: 'home' }) };
          if (key === IPluginHostService) return pluginHost;
          if (key === IHostProcessService) return processService;
          if (key === IWorkAdmissionService) return { run: (_category: string, work: () => Promise<unknown>) => work() };
          if (key === IFileService) return fileService;
          if (key === ITelemetryService) return { withContext: () => ({ track() {}, track2() {} }) };
          if (key === IEventService) return { publish() {} };
          throw new Error('unexpected_app_service');
        },
      },
    } as unknown as Scope;

    service = new NotificationService(core, home, () => false, () => undefined);
    await service.start();
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    let feishuHandlers: Parameters<NonNullable<Extract<SessionSpec, { platform: 'feishu_app' }>['connection']>['open']>[0] | undefined;
    const feishuRaw = createFeishuSessionAdapter({
      platform: 'feishu_app',
      instance_id: 'fs-host-slice',
      app_id: 'cli_0011223344556692',
      app_secret: 'secret',
      connection: {
        async open(next) {
          feishuHandlers = next;
          return { ok: true, bot_open_id: 'ou_bot_slice' };
        },
        async send(request) {
          if (request.op === 'download') {
            if (request.resource_key === 'img_fail') return { ok: false, http_status: 500 };
            if (request.resource_key === 'img_big') return { ok: false, too_large: true };
            if (request.resource_key === 'aud_ok' || request.resource_key === 'aud_explicit' || request.resource_key === 'aud_off') return { ok: true, bytes: Uint8Array.from(audioBytes) };
            return { ok: true, bytes: new Uint8Array(pngBytes) };
          }
          return { ok: true, message_id: 'om_sent' };
        },
      },
      retry_ms: 0,
    }, { async load() { return undefined; }, async save() {} });

    const asrWarnings = vi.fn();
    const bridge = await createImSessionHost({
      core,
      homeDir: home,
      notifications: service,
      logger: { info() {}, warn: asrWarnings },
      factories: [{ providerKind: 'feishu_app', create: () => new HubSessionAdapter(feishuRaw, home) }],
      wechatFetch: () => Promise.reject(new Error('wechat_fetch_blocked')),
    });
    try {
      const pasted = await bridge.paste({ text: 'app_id=cli_0011223344556692\napp_secret=secret' });
      await bridge.setListening(pasted.provider_instance_id, true);
      await feishuHandlers?.onMessage({
        event_id: 'ev-slice-pair',
        app_id: 'cli_0011223344556692',
        sender: { sender_id: { open_id: 'ou_user_1' } },
        message: {
          message_id: 'om_slice_pair',
          chat_id: 'oc_slice_p2p',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'pair' }),
        },
      });
      const discovery = (await bridge.snapshot()).discoveries[0]!;
      await bridge.confirm(discovery.id, { target: { kind: 'session', session_id: 'home' }, busy: 'queue' });

      await feishuHandlers?.onMessage({
        event_id: 'ev-slice-post',
        app_id: 'cli_0011223344556692',
        sender: { sender_id: { open_id: 'ou_user_1' } },
        message: {
          message_id: 'om_slice_post',
          chat_id: 'oc_slice_p2p',
          chat_type: 'p2p',
          message_type: 'post',
          content: JSON.stringify({
            title: 'Rich Post Title',
            content: [
              [{ tag: 'text', text: 'First paragraph before image' }],
              [{ tag: 'img', image_key: 'img_ok' }],
              [{ tag: 'text', text: 'Middle paragraph before failed and oversized images' }, { tag: 'img', image_key: 'img_fail' }, { tag: 'img', image_key: 'img_big' }],
              [{ tag: 'text', text: 'Closing paragraph' }],
            ],
          }),
        },
      });

      await feishuHandlers?.onMessage({
        event_id: 'ev-slice-single-big-caption',
        app_id: 'cli_0011223344556692',
        sender: { sender_id: { open_id: 'ou_user_1' } },
        message: {
          message_id: 'om_slice_big_cap',
          chat_id: 'oc_slice_p2p',
          chat_type: 'p2p',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_big', caption: 'Single oversized image with caption' }),
        },
      });
      await feishuHandlers?.onMessage({
        event_id: 'ev-slice-audio',
        app_id: 'cli_0011223344556692',
        sender: { sender_id: { open_id: 'ou_user_1' } },
        message: {
          message_id: 'om_slice_audio',
          chat_id: 'oc_slice_p2p',
          chat_type: 'p2p',
          message_type: 'audio',
          content: JSON.stringify({ file_key: 'aud_ok', caption: 'Listen to this voice note' }),
        },
      });
      expect(listAsrProviders).toHaveBeenCalledTimes(1);
      await bridge.setPolicy({ ...bridge.policy(), asr_mode: 'auto', asr_provider: 'fixture-asr' });
      await feishuHandlers?.onMessage({
        event_id: 'ev-slice-audio-explicit',
        app_id: 'cli_0011223344556692',
        sender: { sender_id: { open_id: 'ou_user_1' } },
        message: {
          message_id: 'om_slice_audio_explicit',
          chat_id: 'oc_slice_p2p',
          chat_type: 'p2p',
          message_type: 'audio',
          content: JSON.stringify({ file_key: 'aud_explicit', caption: 'Use explicit speech recognizer' }),
        },
      });
      await bridge.setPolicy({ ...bridge.policy(), asr_mode: 'off', asr_provider: null });
      await feishuHandlers?.onMessage({
        event_id: 'ev-slice-audio-off',
        app_id: 'cli_0011223344556692',
        sender: { sender_id: { open_id: 'ou_user_1' } },
        message: {
          message_id: 'om_slice_audio_off',
          chat_id: 'oc_slice_p2p',
          chat_type: 'p2p',
          message_type: 'audio',
          content: JSON.stringify({ file_key: 'aud_off', caption: 'Listen without transcription' }),
        },
      });

      expect(submittedPrompts).toHaveLength(5);
      const submitted = submittedPrompts[0] as {
        role: string;
        providerMessageId?: string;
        content: { type: string; text?: string; imageUrl?: { url: string } }[];
      };
      expect(submitted.role).toBe('user');
      expect(submitted.providerMessageId).toBe('om_slice_post');
      expect(submitted.content.map((part) => part.type)).toEqual(['text', 'text', 'image_url', 'text', 'text', 'text', 'text']);
      expect(submitted.content[0]?.text).toBe('Rich Post Title\nFirst paragraph before image');
      expect(submitted.content[1]?.text).toMatch(/^Attached image "image" \(image\/jpeg, 70 bytes\): .*f_[a-f0-9]{32}-image — already visible inline in this message; use this path only when passing the file to a script, subagent, or pixel-crop tool, do not re-read the whole image with ReadMediaFile$/u);
      expect(submitted.content[2]?.imageUrl?.url).toMatch(/^kimi-file:\/\/f_[a-f0-9]{32}$/u);
      expect(submitted.content[3]?.text).toBe('Middle paragraph before failed and oversized images');
      expect(submitted.content[4]?.text).toBe('[Unavailable external image: download_failed]');
      expect(submitted.content[5]?.text).toBe('[Unavailable external image: too_large]');
      expect(submitted.content[6]?.text).toBe('Closing paragraph');

      const submittedSingleBig = submittedPrompts[1] as {
        role: string;
        providerMessageId?: string;
        content: { type: string; text?: string }[];
      };
      expect(submittedSingleBig.providerMessageId).toBe('om_slice_big_cap');
      expect(submittedSingleBig.content).toEqual([
        { type: 'text', text: 'Single oversized image with caption', presentation: undefined },
        { type: 'text', text: '[Unavailable external image: too_large]', presentation: undefined },
      ]);
      const submittedAudio = submittedPrompts[2] as {
        providerMessageId?: string;
        content: { type: string; text?: string; audioUrl?: { url: string; name?: string } }[];
      };
      expect(submittedAudio.providerMessageId).toBe('om_slice_audio');
      expect(submittedAudio.content.map((part) => part.type)).toEqual(['text', 'text', 'text', 'audio_url', 'text']);
      expect(submittedAudio.content[0]?.text).toBe('Listen to this voice note');
      expect(submittedAudio.content[1]?.text).toMatch(/^Attached audio "voice\.opus" \(audio\/opus, 35324 bytes\): .*f_[a-f0-9]{32}-voice\.opus — listen with an audio-capable tool or use this path$/u);
      expect(submittedAudio.content[2]?.text).toMatch(/^Attached audio "voice\.wav" \(16 kHz mono 16-bit PCM WAV, \d+ bytes\): .*f_[a-f0-9]{32}\.wav — listen with an audio-capable tool or use this path$/u);
      expect(submittedAudio.content[3]?.audioUrl?.url).toMatch(/^kimi-file:\/\/f_[a-f0-9]{32}$/u);
      const wavPath = submittedAudio.content[2]?.text?.match(/: (.+f_[a-f0-9]{32}\.wav) —/u)?.[1];
      expect(wavPath).toBeDefined();
      const fileId = wavPath!.match(/f_[a-f0-9]{32}\.wav$/u)?.[0].slice(0, -4);
      expect(fileId).toMatch(/^f_[a-f0-9]{32}$/u);
      const exactFileId = fileId!;
      expect(wavPath).toBe(join(home, 'attachments', `${exactFileId}.wav`));
      const originalPath = join(home, 'attachments', `${exactFileId}-voice.opus`);
      expect(submittedAudio.content[1]?.text).toContain(originalPath);
      expect(await readFile(originalPath)).toEqual(audioBytes);
      const wav = await readFile(wavPath!);
      expect(wav.subarray(0, 4).toString()).toBe('RIFF');
      expect(wav.subarray(8, 12).toString()).toBe('WAVE');
      expect(wav.readUInt16LE(20)).toBe(1);
      expect(wav.readUInt16LE(22)).toBe(1);
      expect(wav.readUInt32LE(24)).toBe(16_000);
      expect(wav.readUInt16LE(34)).toBe(16);
      expect(wav.byteLength).toBeGreaterThan(44);
      expect(wav.byteLength).toBeLessThan(audioBytes.byteLength);
      expect(submittedAudio.content[4]?.text).toBe(`Audio transcription: audio/wav:auto:${wavPath}:${join(home, 'media', exactFileId)}::none`);

      const submittedAudioExplicit = submittedPrompts[3] as {
        providerMessageId?: string;
        content: { type: string; text?: string; audioUrl?: { url: string; name?: string } }[];
      };
      expect(submittedAudioExplicit.providerMessageId).toBe('om_slice_audio_explicit');
      expect(submittedAudioExplicit.content.map((part) => part.type)).toEqual(['text', 'text', 'text', 'audio_url', 'text']);
      expect(submittedAudioExplicit.content[0]?.text).toBe('Use explicit speech recognizer');
      expect(submittedAudioExplicit.content[4]?.text).toMatch(/^Audio transcription: audio\/wav:auto:/u);
      expect(listAsrProviders).toHaveBeenCalledTimes(1);

      const submittedAudioOff = submittedPrompts[4] as {
        providerMessageId?: string;
        content: { type: string; text?: string; audioUrl?: { url: string; name?: string } }[];
      };
      expect(submittedAudioOff.providerMessageId).toBe('om_slice_audio_off');
      expect(submittedAudioOff.content.map((part) => part.type)).toEqual(['text', 'text', 'text', 'audio_url']);
      expect(submittedAudioOff.content[0]?.text).toBe('Listen without transcription');
      expect(submittedAudioOff.content[2]?.text).toMatch(/16 kHz mono 16-bit PCM WAV/u);
      expect(submittedAudioOff.content[2]?.text).toMatch(/f_[a-f0-9]{32}\.wav/u);
      const offWavPath = submittedAudioOff.content[2]?.text?.match(/: (.+f_[a-f0-9]{32}\.wav) —/u)?.[1];
      expect(offWavPath).toBeDefined();
      const offWav = await readFile(offWavPath!);
      expect(offWav.byteLength).toBeGreaterThan(44);
      expect(offWav.readUInt32LE(24)).toBe(16_000);
      expect(asrWarnings).toHaveBeenCalledWith({ asr: 'off' }, 'IM audio transcription unavailable');
    } finally {
      await bridge.close();
    }
  });
});
