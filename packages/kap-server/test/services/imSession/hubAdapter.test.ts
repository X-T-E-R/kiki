import dns from 'node:dns/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { getDefaultAutoSelectFamily, setDefaultAutoSelectFamily } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiscordSessionAdapter, createFeishuSessionAdapter, createOneBotSessionAdapter, createSafeHttpTransport, createTelegramSessionAdapter, createWechatSessionAdapter, SESSION_CAPABILITIES, telegramHttps, wecomHttps, type SessionAdapter, type SessionInbound, type SessionOutbound, type SessionPlatformId, type SessionSink, type SessionSpec } from '@nb-corp/nb-im';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkRealtimeSessionAccount, fileCursorStore, HubSessionAdapter, mimeAllowed, sessionSpec } from '../../../src/services/imSession/hubAdapter';
import * as privateFiles from '../../../src/services/auth/privateFiles';
import { mimeAllowed as sharedMimeAllowed } from '@nb-corp/im-bridge-core/adapter';
import { oneBotIdentityTransport, type OneBotIdentityLink } from '../../../src/services/imSession/oneBotIdentity';

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function session(): SessionAdapter & { sink?: SessionSink; sent: SessionOutbound[] } {
  const adapter = {
    platform: 'personal_wechat' as const,
    instance_id: 'im_first',
    account: { platform: 'personal_wechat' as const, account_id: 'wx' },
    limits: { text_characters: null, text_utf8_bytes: null, callback_data_bytes: null, voice_mime: ['audio/mpeg'] as const, image_bytes: null, file_bytes: null },
    state: 'running' as const,
    sink: undefined as SessionSink | undefined,
    sent: [] as SessionOutbound[],
    start(sink: SessionSink) { adapter.sink = sink; return Promise.resolve(); },
    stop() { return Promise.resolve(); },
    send(message: SessionOutbound) {
      adapter.sent.push(message);
      return Promise.resolve({ status: 'accepted' as const, message_ids: ['m1'] });
    },
  };
  return adapter;
}

describe('hub session adapter', () => {
  it('preserves the existing MIME helper export as the shared implementation', () => {
    expect(mimeAllowed).toBe(sharedMimeAllowed);
    expect(mimeAllowed({ kind: 'image', mimeTypes: ['image/*'] }, 'IMAGE/PNG')).toBe(true);
    expect(mimeAllowed({ kind: 'image', mimeTypes: ['image/png'] }, 'image/jpeg')).toBe(false);
  });

  it('preserves voice identity for native and generic audio parts from the session hub', async () => {
    const raw = session();
    const hub = new HubSessionAdapter(raw);
    const events: import('../../../src/services/imSession/adapter').ImInboundEvent[] = [];
    await hub.start(async (event) => { events.push(event); });
    const inbound: SessionInbound = {
      event_key: 'event-audio',
      platform_event_id: 'event-audio',
      identity: { platform: 'personal_wechat', account_id: 'wx', chat_id: 'group', sender_id: 'member', topic_id: '0', chat_kind: 'group' },
      payload: { type: 'parts', parts: [
        { type: 'media', media: { kind: 'voice', filename: 'voice.opus', mime: 'audio/opus', bytes: Uint8Array.of(1) } },
        { type: 'media', media: { kind: 'audio', filename: 'clip.wav', mime: 'audio/wav', bytes: Uint8Array.of(2) } },
      ] },
      cursor: '1',
    };
    await raw.sink?.admit(inbound);
    expect(events[0]?.parts).toMatchObject([{ kind: 'audio', voice: true, media: { name: 'voice.opus' } }, { kind: 'audio', voice: false, media: { name: 'clip.wav' } }]);
  });

  it('passes the delivery signal through to the session and rejects late sends after cancellation', async () => {
    const raw = session();
    const signals: (AbortSignal | undefined)[] = [];
    raw.send = async (_message, signal) => { signals.push(signal); return { status: 'accepted', message_ids: ['sent'] }; };
    const hub = new HubSessionAdapter(raw);
    const controller = new AbortController();
    const message = { identity: { chatId: 'c', senderId: 'u', topicId: '0' }, text: 'Reply', code: 'approval', signal: controller.signal };
    await hub.sendText(message);
    expect(signals).toEqual([controller.signal]);
    controller.abort();
    await expect(hub.sendText(message)).rejects.toThrow();
    expect(signals).toHaveLength(1);
  });

  it('learns the real OneBot listener account through the existing authenticated transport without rewriting binding identity', async () => {
    const frames: ((frame: unknown) => void)[] = [];
    let sent: unknown;
    const link: OneBotIdentityLink = { role: 'universal', send: (frame) => { sent = frame; }, onFrame: (callback) => { frames.push(callback); }, onClose() {}, close() {} };
    const source = oneBotIdentityTransport({ connect: async () => link, listen: async () => ({ port: 1 }) });
    const controller = new AbortController();
    await source.transport.connect({ url: 'ws://127.0.0.1:1', headers: {}, signal: controller.signal });
    expect(sent).toMatchObject({ action: 'get_login_info' });
    const echo = (sent as { echo: string }).echo;
    for (const callback of frames) callback({ echo, status: 'ok', retcode: 0, data: { user_id: 42 } });
    await source.ready;
    const raw = { ...session(), platform: 'qq_onebot_v11', account: { platform: 'qq_onebot_v11', account_id: '127.0.0.1:1' } } as SessionAdapter;
    const hub = new HubSessionAdapter(raw, undefined, source);
    expect(await hub.start(async () => undefined)).toEqual({ accountId: '127.0.0.1:1' });
    expect(hub.listenerRealm).toBe('qq-onebot');
    expect(hub.listenerAccountId).toBe('42');
    controller.abort();
  });

  it('uses only an authorized reverse OneBot self header and cancels an unidentified listener', async () => {
    let authorize!: (headers: Record<string, string | undefined>, url: string) => boolean;
    const source = oneBotIdentityTransport({ connect: async () => { throw new Error('unused'); }, listen: async (input) => { authorize = input.authorize; return { port: 1 }; } });
    const controller = new AbortController();
    await source.transport.listen({ host: '127.0.0.1', port: 1, signal: controller.signal, authorize: (headers) => headers['authorization'] === 'Bearer fixture', accept() {} });
    expect(authorize({ 'x-self-id': '99' }, '/event')).toBe(false);
    expect(source.accountId).toBeUndefined();
    expect(authorize({ 'x-self-id': '42', 'authorization': 'Bearer fixture' }, '/event')).toBe(true);
    await source.ready;
    expect(source.accountId).toBe('42');
    controller.abort();
    const cancelled = oneBotIdentityTransport({ connect: async () => { throw new Error('unused'); }, listen: async () => ({ port: 1 }) });
    const stopped = new AbortController();
    await cancelled.transport.listen({ host: '127.0.0.1', port: 1, signal: stopped.signal, authorize: () => false, accept() {} });
    stopped.abort();
    await expect(cancelled.ready).rejects.toThrow();
  });
  it('keeps a reply-context change made during persistence dirty until the newer revision is written', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-im-reply-race-'));
    const raw = session();
    const hub = new HubSessionAdapter(raw, home);
    const firstWriteEntered = deferred();
    const releaseFirstWrite = deferred();
    const originalWrite = privateFiles.writePrivateFile;
    const write = vi.spyOn(privateFiles, 'writePrivateFile');
    let writes = 0;
    write.mockImplementation(async (filePath, data) => {
      if (writes++ === 0) {
        firstWriteEntered.resolve();
        await releaseFirstWrite.promise;
      }
      await originalWrite(filePath, data);
    });
    try {
      await hub.start(async () => undefined);
      const admit = (eventId: string, replyContext: string) => raw.sink!.admit({
        event_key: eventId,
        platform_event_id: eventId,
        cursor: eventId,
        identity: { platform: 'personal_wechat', account_id: 'wx', chat_id: 'chat', sender_id: 'user', topic_id: '0' },
        payload: { type: 'text', text: 'hello' },
        reply_context: replyContext,
      });
      const first = admit('reply-one', 'older-context');
      await firstWriteEntered.promise;
      const second = admit('reply-two', 'newer-context');
      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseFirstWrite.resolve();
      await Promise.all([first, second]);
      const saved = JSON.parse(await readFile(join(home, 'im-session-reply.json'), 'utf8')) as Record<string, string>;
      expect(Object.values(saved)).toEqual(['newer-context']);
    } finally {
      releaseFirstWrite.resolve();
      write.mockRestore();
      await hub.stop();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps reply context on the send target and out of the admitted event', async () => {
    const raw = session();
    const hub = new HubSessionAdapter(raw);
    const seen: string[] = [];
    await hub.start(async (event) => { seen.push(JSON.stringify(event)); });
    await raw.sink?.admit({
      event_key: 'wx:1', platform_event_id: '1', cursor: '{"v":1}',
      identity: { platform: 'personal_wechat', account_id: 'wx', chat_id: 'c', sender_id: 'u', topic_id: '0', chat_kind: 'private' },
      payload: { type: 'text', text: 'hi' },
      reply_context: 'ctx-secret',
    });
    expect(seen.join('')).not.toContain('ctx-secret');
    await hub.sendText({ identity: { chatId: 'c', senderId: 'u', topicId: '0' }, text: 'yo', code: 'status' });
    expect(raw.sent[0]).toMatchObject({ type: 'text', target: { reply_context: 'ctx-secret', chat_kind: 'private' } });
  });

  it('reports a voice container mismatch as bad_format and does not send a file', async () => {
    const raw = session();
    raw.send = (message) => {
      raw.sent.push(message);
      return Promise.resolve({ status: 'failed', message_ids: [], error_kind: 'bad_format', diagnostic_code: 'wechat_voice_container' });
    };
    const hub = new HubSessionAdapter(raw);
    await expect(hub.sendFile({
      identity: { chatId: 'c', senderId: 'u', topicId: '0' }, name: 'note.wav', mediaType: 'audio/wav', bytes: new Uint8Array([1]), asVoice: true, asImage: false,
    })).rejects.toThrow('bad_format');
    expect(raw.sent).toHaveLength(1);
    expect(raw.sent[0]).toMatchObject({ type: 'media', media: { kind: 'voice' } });
  });

  it('passes an allowed WeChat base URL and accepts a send with no message id', async () => {
    expect(sessionSpec('wechat_bridge', 'im', 'tok\nbot\nhttps://ilinkai.weixin.qq.com')).toMatchObject({
      platform: 'personal_wechat', token: 'tok', account_id: 'bot', base_url: 'https://ilinkai.weixin.qq.com',
    });
    expect(sessionSpec('wechat_bridge', 'im', 'tok\nbot')).not.toHaveProperty('base_url');
    expect(sessionSpec('wechat_bridge', 'im', 'tok\nbot\nhttps://user:pass@ilinkai.weixin.qq.com')).not.toHaveProperty('base_url');
    expect(sessionSpec('wechat_bridge', 'im', 'tok\nbot\nhttp://evil.example')).not.toHaveProperty('base_url');
    const raw = session();
    raw.send = (message) => {
      raw.sent.push(message);
      return Promise.resolve({ status: 'accepted', message_ids: [] });
    };
    const hub = new HubSessionAdapter(raw);
    await expect(hub.sendText({ identity: { chatId: 'c', senderId: 'u', topicId: '0' }, text: 'yo', code: 'reply' })).resolves.toMatchObject({ messageId: '' });
  });

  it('retries a rejected WeChat send once without context and does not retry an auth failure', async () => {
    const raw = session();
    const hub = new HubSessionAdapter(raw);
    await hub.start(async () => undefined);
    await raw.sink?.admit({
      event_key: 'wx:1', platform_event_id: '1', cursor: '{"v":1}',
      identity: { platform: 'personal_wechat', account_id: 'wx', chat_id: 'c', sender_id: 'u', topic_id: '0', chat_kind: 'private' },
      payload: { type: 'text', text: 'hi' },
      reply_context: 'ctx-secret',
    });
    let calls = 0;
    raw.send = (message) => {
      calls += 1;
      raw.sent.push(message);
      if (calls === 1) return Promise.resolve({ status: 'failed', message_ids: [], error_kind: 'unknown', diagnostic_code: 'wechat_rejected' });
      return Promise.resolve({ status: 'accepted', message_ids: [] });
    };
    await expect(hub.sendText({ identity: { chatId: 'c', senderId: 'u', topicId: '0' }, text: 'yo', code: 'reply' })).resolves.toMatchObject({ messageId: '' });
    expect(raw.sent[0]).toMatchObject({ target: { reply_context: 'ctx-secret', chat_kind: 'private' } });
    expect(raw.sent[1]?.type === 'text' && raw.sent[1].target.reply_context).toBeUndefined();
    const auth = session();
    const authHub = new HubSessionAdapter(auth);
    await authHub.start(async () => undefined);
    await auth.sink?.admit({
      event_key: 'wx:2', platform_event_id: '2', cursor: '{"v":1}',
      identity: { platform: 'personal_wechat', account_id: 'wx', chat_id: 'c', sender_id: 'u', topic_id: '0', chat_kind: 'private' },
      payload: { type: 'text', text: 'hi' },
      reply_context: 'ctx-secret',
    });
    auth.send = (message) => {
      auth.sent.push(message);
      return Promise.resolve({ status: 'failed', message_ids: [], error_kind: 'auth', diagnostic_code: 'wechat_auth' });
    };
    await expect(authHub.sendText({ identity: { chatId: 'c', senderId: 'u', topicId: '0' }, text: 'again', code: 'reply' })).rejects.toThrow('wechat_auth');
    expect(auth.sent).toHaveLength(1);
    expect(auth.sent[0]).toMatchObject({ target: { reply_context: 'ctx-secret' } });
    expect(JSON.stringify(auth.sent)).not.toContain('tok');
  });
});

describe('im session cursor file', () => {
  let home = '';
  afterEach(async () => { if (home !== '') await rm(home, { recursive: true, force: true }); home = ''; });

  it('keeps a bad cursor file instead of replacing it', async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-im-cursor-'));
    const store = fileCursorStore(home);
    await store.save('scope', '1');
    const file = join(home, 'im-session-cursors.json');
    await writeFile(file, '{', 'utf8');
    await expect(store.load('scope')).rejects.toThrow('cursor_file_invalid');
    await expect(store.save('other', '2')).rejects.toThrow('cursor_file_invalid');
    expect(await readFile(file, 'utf8')).toBe('{');
    const missing = fileCursorStore(join(home, 'absent'));
    await expect(missing.load('none')).resolves.toBeUndefined();
  });
});

it('uses the packaged WeChat poller to recover optional-ret updates and keeps two contacts reply contexts separate', async () => {
  let entered: () => void = () => undefined;
  let release: (body: string) => void = () => undefined;
  const reconnecting = new Promise<void>((resolve) => { entered = resolve; });
  const recovered = new Promise<string>((resolve) => { release = resolve; });
  const requests: Record<string, unknown>[] = [];
  const identities: { chatId: string; senderId: string; topicId: string }[] = [];
  const receivedEvents: { text?: string; quotedText?: string; replyToMessageId?: string; preview?: string }[] = [];
  let polls = 0;
  let admitted: () => void = () => undefined;
  const received = new Promise<void>((resolve) => { admitted = resolve; });
  const transport: NonNullable<Extract<SessionSpec, { platform: 'personal_wechat' }>['transport']> = {
    async post(url, _headers, body, signal) {
      if (url.endsWith('getupdates')) {
        polls += 1;
        if (polls === 1) return { status: 200, body: '{"ret":-2,"errmsg":"private-error"}' };
        if (polls === 2) { entered(); return { status: 200, body: await recovered }; }
        await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
        throw new DOMException('Aborted', 'AbortError');
      }
      if (url.endsWith('sendmessage')) requests.push(JSON.parse(body) as Record<string, unknown>);
      return { status: 200, body: '{"ret":0}' };
    },
    async postBytes() { throw new Error('unexpected upload'); },
    async getBytes() { throw new Error('unexpected download'); },
  };
  const raw = createWechatSessionAdapter({ platform: 'personal_wechat', instance_id: 'packaged-wx', token: 'offline-test-only', account_id: 'bot', retry_ms: 0, transport }, {
    async load() { return undefined; }, async save() {},
  });
  const hub = new HubSessionAdapter(raw);
  const start = hub.start(async (event) => { identities.push(event.identity); receivedEvents.push(event); if (identities.length === 4) admitted(); });
  try {
    await reconnecting;
    expect(hub.connectionPhase()).toBe('reconnecting');
    expect(hub.connectionDetail()).toMatchObject({ code: 'api_error', http_status: 200, ret: -2, failure_count: 1 });
    expect(JSON.stringify(hub.connectionDetail())).not.toContain('private-error');
    release(JSON.stringify({
      get_updates_buf: 'next',
      msgs: [
        { message_id: 'a', from_user_id: 'a', to_user_id: 'bot', message_type: 1, message_state: 2, context_token: 'context-a', item_list: [{ type: 1, text_item: { text: 'current-a' }, ref_msg: { title: 'misleading title', message_item: { msg_id: 'older-a', type: 1, text_item: { text: 'actual quote' } } } }] },
        { message_id: 'b', from_user_id: 'b', to_user_id: 'bot', message_type: 1, message_state: 2, context_token: 'context-b', item_list: [{ type: 1, text_item: { text: 'current-b' }, ref_msg: { title: 'title only', message_item: { msg_id: 'older-b', type: 2 } } }] },
        { message_id: 'c', from_user_id: 'c', to_user_id: 'bot', message_type: 1, message_state: 2, context_token: 'context-c', item_list: [
          { type: 1, text_item: { text: 'current-c' }, ref_msg: { title: 'not quote', message_item: { msg_id: 'older-c', type: 1, text_item: { text: '😀'.repeat(1025) } } } },
          { type: 1, text_item: { text: 'current-d' }, ref_msg: { title: 'blank ref ignored', message_item: { msg_id: '   ', type: 1, text_item: { text: '   ' } } } },
        ] },
      ],
    }));
    await start;
    await received;
    expect(hub.connectionPhase()).toBe('running');
    expect(hub.connectionDetail()).toBeUndefined();
    expect(receivedEvents).toMatchObject([
      { kind: 'text', text: 'current-a', preview: 'current-a', replyToMessageId: 'older-a', quotedText: 'actual quote' },
      { kind: 'text', text: 'current-b', preview: 'current-b', replyToMessageId: 'older-b' },
      { kind: 'text', text: 'current-c', preview: 'current-c', replyToMessageId: 'older-c', quotedText: `${'😀'.repeat(1024)}…` },
      { kind: 'text', text: 'current-d', preview: 'current-d' },
    ]);
    expect(receivedEvents[1]?.quotedText).toBeUndefined();
    expect(receivedEvents[3]?.replyToMessageId).toBeUndefined();
    expect(receivedEvents[3]?.quotedText).toBeUndefined();
    for (const identity of identities.slice(0, 2)) await hub.sendText({ identity, text: 'reply', code: 'reply' });
    expect(requests.map((request) => request['msg'])).toEqual([
      expect.objectContaining({ to_user_id: 'a', context_token: 'context-a' }),
      expect.objectContaining({ to_user_id: 'b', context_token: 'context-b' }),
    ]);
  } finally { await hub.stop(); }
  expect(hub.connectionPhase()).toBe('stopped');
  expect(polls).toBeLessThanOrEqual(3);
});

it('returns the real packaged WeChat send receipt through the Kiki hub', async () => {
  let body = '{"message_id":7520810038038921608}';
  const calls: string[] = [];
  const transport: NonNullable<Extract<SessionSpec, { platform: 'personal_wechat' }>['transport']> = {
    async post(url) {
      if (url.endsWith('getuploadurl')) return { status: 200, body: '{"ret":0,"upload_param":"upload-test"}' };
      calls.push(url);
      return { status: 200, body };
    },
    async postBytes() { return { status: 200, body: '', headers: { 'x-encrypted-param': 'download-test' } }; },
    async getBytes() { throw new Error('unexpected download'); },
  };
  const raw = createWechatSessionAdapter({ platform: 'personal_wechat', instance_id: 'packaged-wx-send',
    token: 'offline-send-test', account_id: 'bot', transport }, { async load() { return undefined; }, async save() {} });
  const hub = new HubSessionAdapter(raw);
  const identity = { chatId: 'user', senderId: 'user', topicId: '0' };
  expect(await hub.sendText({ identity, text: 'pong', code: 'reply' })).toEqual({
    messageId: '7520810038038921608', messageIds: ['7520810038038921608'],
  });
  for (const [name, mediaType, asVoice, asImage] of [
    ['picture.png', 'image/png', false, true], ['note.silk', 'audio/silk', true, false],
  ] as const) {
    expect(await hub.sendFile({ identity, name, mediaType, bytes: Uint8Array.of(1), asVoice, asImage }))
      .toMatchObject({ messageId: '7520810038038921608' });
  }
  expect(calls).toHaveLength(3);
  body = '{"ret":-2,"errmsg":"prepare failed","message_id":7520810038038921608}';
  await expect(hub.sendText({ identity, text: 'pong', code: 'reply' })).rejects.toThrow('wechat_rejected');
  body = '{"message_id":"   "}';
  await expect(hub.sendText({ identity, text: 'pong', code: 'reply' })).rejects.toThrow('wechat_unconfirmed');
  body = '';
  await expect(hub.sendText({ identity, text: 'pong', code: 'reply' })).rejects.toThrow('wechat_unconfirmed');
  expect(calls).toHaveLength(6);
});

describe('strict session media', () => {
  it.each(['discord', 'slack', 'matrix'] as const)('keeps %s capabilities and media intents aligned with the package', async (platform) => {
    const raw = session();
    const adapter = { ...raw, platform, account: { platform, account_id: 'bot' } } satisfies SessionAdapter;
    const hub = new HubSessionAdapter(adapter);
    expect(hub.mediaCapabilities.map((item) => item.kind)).toEqual(SESSION_CAPABILITIES[platform].outbound.filter((item) => item !== 'text'));
    expect(hub.mediaCapabilities.find((item) => item.kind === 'audio')?.rendering).toBe(SESSION_CAPABILITIES[platform].audio_rendering);
    const identity = { chatId: 'chat', senderId: 'user', topicId: 'thread' };
    expect(await hub.sendMedia({ identity, name: 'voice.ogg', mediaType: 'audio/ogg', bytes: new Uint8Array([1]), kind: 'voice' })).toMatchObject({ status: 'unsupported' });
    expect(raw.sent).toHaveLength(0);
    for (const kind of ['audio', 'video'] as const) {
      expect(await hub.sendMedia({ identity, name: 'media', mediaType: `${kind}/test`, bytes: new Uint8Array([1]), kind })).toMatchObject({ status: 'delivered' });
      expect(raw.sent.at(-1)).toMatchObject({ type: 'media', media: { kind }, target: { topic_id: 'thread' } });
    }
  });

  it.each(['telegram', 'feishu_app', 'personal_wechat', 'qq_onebot_v11'] satisfies SessionPlatformId[])('does not overstate %s audio or video support', async (platform) => {
    const raw = session();
    const hub = new HubSessionAdapter({ ...raw, platform, account: { platform, account_id: 'bot' } });
    expect(hub.mediaCapabilities.map((item) => item.kind)).not.toContain('audio');
    if (platform === 'feishu_app') {
      expect(hub.mediaCapabilities.find((item) => item.kind === 'video')).toEqual({
        kind: 'video',
        mimeTypes: ['video/mp4'],
        maxBytes: undefined,
      });
    } else {
      expect(hub.mediaCapabilities.map((item) => item.kind)).not.toContain('video');
    }
  });

  it('sends Feishu mp4 file attachments as stream+file and native video as mp4+media without resending on unknown', async () => {
    const sent: Parameters<NonNullable<Extract<SessionSpec, { platform: 'feishu_app' }>['connection']>['send']>[0][] = [];
    let outcome: 'ok' | 'rejected' | 'unknown' = 'ok';
    let index = 0;
    const raw = createFeishuSessionAdapter({
      platform: 'feishu_app',
      instance_id: 'packaged-feishu-video',
      app_id: 'cli_0011223344556677',
      app_secret: 'offline-secret',
      connection: {
        async open() { return { ok: true }; },
        async send(request) {
          sent.push(request);
          if (request.op === 'upload_file') {
            if (outcome === 'rejected') return { ok: false, http_status: 400 };
            index += 1;
            return { ok: true, key: `fk_${index}` };
          }
          if (outcome === 'unknown') return { ok: false };
          return { ok: true, message_id: `om_${index}` };
        },
      },
      retry_ms: 0,
    }, { async load() { return undefined; }, async save() {} });
    const hub = new HubSessionAdapter(raw);
    await hub.start(async () => undefined);
    try {
      const identity = { chatId: 'oc_group', senderId: 'ou_user', topicId: '0' };
      expect(await hub.sendFile({ identity, name: 'clip.mp4', mediaType: 'video/mp4', bytes: Uint8Array.of(1, 2), asVoice: false, asImage: false })).toEqual({
        messageId: 'om_1',
        deliveredAs: 'file',
      });
      expect(sent.slice(0, 2)).toEqual([
        expect.objectContaining({ op: 'upload_file', file_type: 'stream', file_name: 'clip.mp4' }),
        expect.objectContaining({ op: 'create_message', chat_id: 'oc_group', msg_type: 'file', content: '{"file_key":"fk_1"}' }),
      ]);

      expect(await hub.sendMedia({ identity, name: 'native.mp4', mediaType: 'video/mp4', bytes: Uint8Array.of(3, 4), kind: 'video' })).toEqual({
        status: 'delivered',
        messageIds: ['om_2'],
        unsupported: undefined,
        detail: undefined,
      });
      expect(sent.slice(2, 4)).toEqual([
        expect.objectContaining({ op: 'upload_file', file_type: 'mp4', file_name: 'native.mp4' }),
        expect.objectContaining({ op: 'create_message', chat_id: 'oc_group', msg_type: 'media', content: '{"file_key":"fk_2"}' }),
      ]);

      expect(await hub.sendMedia({ identity, name: 'native.webm', mediaType: 'video/webm', bytes: Uint8Array.of(5), kind: 'video' })).toEqual({
        status: 'unsupported',
        unsupported: ['video'],
      });
      expect(sent).toHaveLength(4);

      outcome = 'rejected';
      expect(await hub.sendMedia({ identity, name: 'bad.mp4', mediaType: 'video/mp4', bytes: Uint8Array.of(6), kind: 'video' })).toMatchObject({
        status: 'failed',
        detail: 'feishu_bad_request',
      });
      expect(sent).toHaveLength(5);

      outcome = 'unknown';
      expect(await hub.sendMedia({ identity, name: 'uncertain.mp4', mediaType: 'video/mp4', bytes: Uint8Array.of(7), kind: 'video' })).toMatchObject({
        status: 'unknown',
        detail: 'feishu_rejected',
      });
      expect(sent).toHaveLength(7);
    } finally {
      await hub.stop();
    }
  });

  it('maps inbound Feishu native video and late bot identity updates onto ImInboundEvent', async () => {
    let handlers: Parameters<NonNullable<Extract<SessionSpec, { platform: 'feishu_app' }>['connection']>['open']>[0] | undefined;
    const downloadedKeys: string[] = [];
    const raw = createFeishuSessionAdapter({
      platform: 'feishu_app',
      instance_id: 'packaged-feishu-video-inbound',
      app_id: 'cli_0011223344556679',
      app_secret: 'offline-secret',
      connection: {
        async open(next) {
          handlers = next;
          return { ok: true };
        },
        async send(request) {
          if (request.op === 'download') {
            downloadedKeys.push(`${request.resource_type}:${request.resource_key}`);
            return { ok: true, bytes: Uint8Array.of(21, 22, 23) };
          }
          return { ok: true, message_id: 'om_vid_out' };
        },
      },
      retry_ms: 0,
    }, { async load() { return undefined; }, async save() {} });
    const hub = new HubSessionAdapter(raw);
    const events: import('../../../src/services/imSession/adapter').ImInboundEvent[] = [];
    await hub.start(async (event) => { events.push(event); });
    try {
      await handlers?.onMessage({
        event_id: 'ev-video-before-bot-id',
        app_id: 'cli_0011223344556679',
        sender: { sender_id: { open_id: 'ou_sender' } },
        message: {
          message_id: 'om_vid_in_1',
          chat_id: 'oc_group',
          chat_type: 'group',
          message_type: 'media',
          content: JSON.stringify({ file_key: 'fk_real_video', image_key: 'img_cover_ignored', file_name: 'walkthrough.mp4' }),
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_late_bot' }, name: 'Kiki' }],
        },
      });
      handlers?.onBotIdentity?.('ou_late_bot');
      await handlers?.onMessage({
        event_id: 'ev-text-after-bot-id',
        app_id: 'cli_0011223344556679',
        sender: { sender_id: { open_id: 'ou_sender' } },
        message: {
          message_id: 'om_text_in_2',
          chat_id: 'oc_group',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_1 now identified' }),
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_late_bot' }, name: 'Kiki' }],
        },
      });
      expect(downloadedKeys).toEqual(['file:fk_real_video']);
      expect(events[0]).toMatchObject({
        sourceMessageId: 'om_vid_in_1',
        kind: 'video',
        mentioned: undefined,
        mentionIds: ['ou_late_bot'],
        media: { name: 'walkthrough.mp4', mediaType: 'video/mp4', bytes: Uint8Array.of(21, 22, 23) },
      });
      expect(events[1]).toMatchObject({
        sourceMessageId: 'om_text_in_2',
        kind: 'text',
        mentioned: true,
        mentionIds: ['ou_late_bot'],
      });
    } finally {
      await hub.stop();
    }
  });

  it('preserves unknown, failed and unsupported transport outcomes without resending', async () => {
    const raw = session();
    const hub = new HubSessionAdapter(raw);
    const media = { identity: { chatId: 'c', senderId: 'u', topicId: '0' }, name: 'a', mediaType: 'application/octet-stream', bytes: new Uint8Array([1]), kind: 'file' };
    raw.send = async (message) => { raw.sent.push(message); return { status: 'unknown', message_ids: [] }; };
    expect(await hub.sendMedia(media)).toMatchObject({ status: 'unknown' });
    expect(raw.sent).toHaveLength(1);
    raw.send = async () => ({ status: 'failed', message_ids: [], error_kind: 'forbidden', diagnostic_code: 'matrix_encryption_unsupported' });
    expect(await hub.sendMedia(media)).toMatchObject({ status: 'failed', detail: 'matrix_encryption_unsupported' });
    raw.send = async () => ({ status: 'failed', message_ids: [], error_kind: 'unsupported', diagnostic_code: 'unsupported_media' });
    expect(await hub.sendMedia(media)).toMatchObject({ status: 'unsupported', unsupported: ['file'] });
  });

  it('preserves an unknown WeChat reply outcome without retrying or dropping its context', async () => {
    const raw = session();
    const hub = new HubSessionAdapter(raw);
    const identity = { chatId: 'c', senderId: 'u', topicId: '0' };
    await hub.start(async () => undefined);
    await raw.sink?.admit({
      event_key: 'wx:unknown', platform_event_id: 'unknown', cursor: 'next',
      identity: { platform: 'personal_wechat', account_id: 'wx', chat_id: 'c', sender_id: 'u', topic_id: '0' },
      payload: { type: 'text', text: 'hi' }, reply_context: 'reply-context',
    });
    raw.send = async (message) => {
      raw.sent.push(message);
      return { status: 'unknown', message_ids: [], diagnostic_code: 'wechat_rejected' };
    };
    await expect(hub.sendText({ identity, text: 'once', code: 'reply' })).rejects.toMatchObject({ outcome: 'unknown' });
    expect(raw.sent).toHaveLength(1);
    expect(raw.sent[0]).toMatchObject({ target: { reply_context: 'reply-context' } });
    raw.send = async (message) => { raw.sent.push(message); return { status: 'accepted', message_ids: [] }; };
    await hub.sendText({ identity, text: 'next', code: 'reply' });
    expect(raw.sent).toHaveLength(2);
    expect(raw.sent[1]).toMatchObject({ target: { reply_context: 'reply-context' } });
  });

  it('maps all new platform credentials without changing their identity or topic contract', () => {
    expect(sessionSpec('discord', 'd', 'bot')).toMatchObject({ platform: 'discord', bot_token: 'bot' });
    expect(sessionSpec('slack', 's', 'xoxb-test\nxapp-test')).toMatchObject({ platform: 'slack', bot_token: 'xoxb-test', app_token: 'xapp-test' });
    expect(sessionSpec('matrix', 'm', 'https://matrix.example.test\nsecret')).toMatchObject({ platform: 'matrix', homeserver: 'https://matrix.example.test', access_token: 'secret' });
  });

  it('checks Matrix identity through whoami and keeps credentials out of diagnostics', async () => {
    const requests: { url: string; authorization: string | null }[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      requests.push({ url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url, authorization: new Headers(init?.headers).get('authorization') });
      return Response.json({ user_id: '@bot:example.test' });
    };
    expect(await checkRealtimeSessionAccount('matrix', 'https://matrix.example.test\nsecret', fetcher)).toEqual({ ok: true, accountId: '@bot:example.test' });
    expect(requests).toEqual([{ url: 'https://matrix.example.test/_matrix/client/v3/account/whoami', authorization: 'Bearer secret' }]);
    const failing: typeof fetch = async () => { throw new Error('secret'); };
    expect(await checkRealtimeSessionAccount('matrix', 'https://matrix.example.test\nsecret', failing)).toEqual({ ok: false, detail: 'connection_failed' });
  });

  it('maps Feishu post rich-text, failed/oversized media with caption, Telegram failed caption and OneBot ordered parts into multipart ImInboundEvent', async () => {
    let feishuHandlers: Parameters<NonNullable<Extract<SessionSpec, { platform: 'feishu_app' }>['connection']>['open']>[0] | undefined;
    const feishuRaw = createFeishuSessionAdapter({
      platform: 'feishu_app',
      instance_id: 'packaged-feishu-rich',
      app_id: 'cli_0011223344556688',
      app_secret: 'offline-secret',
      connection: {
        async open(next) {
          feishuHandlers = next;
          return { ok: true, bot_open_id: 'ou_bot' };
        },
        async send(request) {
          if (request.op === 'download') {
            if (request.resource_key === 'img_fail') return { ok: false, http_status: 404 };
            if (request.resource_key === 'img_big') return { ok: false, too_large: true };
            if (request.resource_key === 'img_1') return { ok: true, bytes: Uint8Array.of(10, 11) };
            if (request.resource_key === 'img_2') return { ok: true, bytes: Uint8Array.of(12, 13) };
          }
          return { ok: true, message_id: 'om_out' };
        },
      },
      retry_ms: 0,
    }, { async load() { return undefined; }, async save() {} });
    const feishuHub = new HubSessionAdapter(feishuRaw);
    const feishuEvents: unknown[] = [];
    await feishuHub.start(async (event) => { feishuEvents.push(event); });
    try {
      await feishuHandlers?.onMessage({
        event_id: 'ev-feishu-post-rich',
        app_id: 'cli_0011223344556688',
        sender: { sender_id: { open_id: 'ou_alice' } },
        message: {
          message_id: 'om_post_rich',
          chat_id: 'oc_group',
          chat_type: 'group',
          message_type: 'post',
          content: JSON.stringify({
            zh_cn: {
              title: 'Release Check',
              content: [
                [{ tag: 'at', user_id: '@_user_1', user_name: 'Kiki' }, { tag: 'text', text: ' check both images:' }],
                [{ tag: 'img', image_key: 'img_1' }],
                [{ tag: 'text', text: 'second image failed:' }, { tag: 'img', image_key: 'img_fail' }, { tag: 'img', image_key: 'img_big' }, { tag: 'text', text: 'tail text stays' }],
              ],
            },
          }),
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Kiki' }],
        },
      });
      await feishuHandlers?.onMessage({
        event_id: 'ev-feishu-single-fail-caption',
        app_id: 'cli_0011223344556688',
        sender: { sender_id: { open_id: 'ou_alice' } },
        message: {
          message_id: 'om_img_fail_cap',
          chat_id: 'oc_group',
          chat_type: 'p2p',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_fail', caption: 'Caption survives failed image' }),
        },
      });
      await feishuHandlers?.onMessage({
        event_id: 'ev-feishu-single-too-large-caption',
        app_id: 'cli_0011223344556688',
        sender: { sender_id: { open_id: 'ou_alice' } },
        message: {
          message_id: 'om_img_big_cap',
          chat_id: 'oc_group',
          chat_type: 'p2p',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_big', caption: 'Too large image with caption' }),
        },
      });
      await feishuHandlers?.onMessage({
        event_id: 'ev-feishu-single-too-large-pure',
        app_id: 'cli_0011223344556688',
        sender: { sender_id: { open_id: 'ou_alice' } },
        message: {
          message_id: 'om_img_big_pure',
          chat_id: 'oc_group',
          chat_type: 'p2p',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_big' }),
        },
      });
      expect(feishuEvents).toHaveLength(4);
      expect(feishuEvents[0]).toMatchObject({
        eventId: 'feishu:cli_0011223344556688:ev-feishu-post-rich',
        sourceMessageId: 'om_post_rich',
        kind: 'message',
        mentioned: true,
        mentionIds: ['ou_bot'],
        parts: [
          { kind: 'text', text: 'Release Check\n@Kiki check both images:' },
          { kind: 'image', media: { name: 'image', mediaType: 'image/jpeg', bytes: Uint8Array.of(10, 11) } },
          { kind: 'text', text: 'second image failed:' },
          { kind: 'image', text: 'download_failed' },
          { kind: 'image', text: 'too_large' },
          { kind: 'text', text: 'tail text stays' },
        ],
      });
      expect(feishuEvents[1]).toMatchObject({
        kind: 'message',
        parts: [
          { kind: 'text', text: 'Caption survives failed image' },
          { kind: 'image', text: 'download_failed' },
        ],
        text: 'Caption survives failed image',
      });
      expect(feishuEvents[2]).toMatchObject({
        kind: 'message',
        parts: [
          { kind: 'text', text: 'Too large image with caption' },
          { kind: 'image', text: 'too_large' },
        ],
        text: 'Too large image with caption',
      });
      expect(feishuEvents[3]).toMatchObject({
        kind: 'image',
        tooLarge: true,
        text: '',
      });
    } finally {
      await feishuHub.stop();
    }

    let tgPolls = 0;
    let tgDone: () => void = () => undefined;
    const tgFinished = new Promise<void>((resolve) => { tgDone = resolve; });
    const tgRaw = createTelegramSessionAdapter({
      platform: 'telegram',
      instance_id: 'packaged-tg-rich',
      token: '777777:GGGGGGGGGGGGGGGGGGGG',
      retry_ms: 0,
      transport: {
        async call(request, signal) {
          if (request.method === 'getMe') return { http_status: 200, body: { ok: true, result: { id: 77, username: 'KikiTgBot' } } };
          if (request.method === 'getWebhookInfo') return { http_status: 200, body: { ok: true, result: { url: '' } } };
          if (request.method === 'getUpdates') {
            tgPolls += 1;
            if (tgPolls === 1) {
              return {
                http_status: 200,
                body: {
                  ok: true,
                  result: [
                    {
                      update_id: 201,
                      message: {
                        message_id: 501,
                        caption: 'Telegram caption with failed download',
                        photo: [{ file_id: 'bad_id', file_size: 8 }],
                        chat: { id: 9, type: 'private' },
                        from: { id: 8 },
                      },
                    },
                  ],
                },
              };
            }
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener('abort', () => resolve(), { once: true });
            });
            throw new DOMException('Aborted', 'AbortError');
          }
          if (request.method === 'getFile') {
            return { http_status: 500, body: { ok: false, error_code: 500, description: 'failed' } };
          }
          return { http_status: 200, body: { ok: true, result: {} } };
        },
        async download() {
          return { ok: true, bytes: Uint8Array.of(9, 8) };
        },
      },
    }, { async load() { return undefined; }, async save() {} });
    const tgHub = new HubSessionAdapter(tgRaw);
    const tgEvents: unknown[] = [];
    await tgHub.start(async (event) => {
      tgEvents.push(event);
      if (tgEvents.length === 1) tgDone();
    });
    try {
      await tgFinished;
      expect(tgEvents).toHaveLength(1);
      expect(tgEvents[0]).toMatchObject({
        sourceMessageId: '501',
        kind: 'message',
        parts: [
          { kind: 'text', text: 'Telegram caption with failed download' },
          { kind: 'image', text: 'download_failed' },
        ],
      });
    } finally {
      await tgHub.stop();
    }

    let onebotFrame: ((frame: unknown) => void) | undefined;
    let onebotClose: (() => void) | undefined;
    let onebotDone: () => void = () => undefined;
    const onebotFinished = new Promise<void>((resolve) => { onebotDone = resolve; });
    const onebotRaw = createOneBotSessionAdapter({
      platform: 'qq_onebot_v11',
      mode: 'forward',
      endpoint: 'ws://127.0.0.1:6710/',
      instance_id: 'packaged-qq-rich',
      retry_ms: 0,
      transport: {
        async connect() {
          return {
            role: 'universal',
            send() {},
            onFrame(handler) { onebotFrame = handler; },
            onClose(handler) { onebotClose = handler; },
            close() { onebotClose?.(); },
          };
        },
        async listen() { return { port: 1 }; },
      },
    }, { async load() { return undefined; }, async save() {} });
    const onebotHub = new HubSessionAdapter(onebotRaw);
    const onebotEvents: unknown[] = [];
    await onebotHub.start(async (event) => {
      onebotEvents.push(event);
      if (onebotEvents.length === 2) onebotDone();
    });
    try {
      onebotFrame?.({
        post_type: 'message',
        message_type: 'private',
        message_id: 87,
        self_id: 100,
        user_id: 200,
        message: [
          { type: 'text', data: { text: 'Before image ' } },
          { type: 'image', data: { file: 'base64://AQ==' } },
          { type: 'text', data: { text: ' after image' } },
        ],
      });
      onebotFrame?.({
        post_type: 'message',
        message_type: 'private',
        message_id: 88,
        self_id: 100,
        user_id: 200,
        message: [
          { type: 'text', data: { text: 'OneBot text ' } },
          { type: 'image', data: { file: 'base64://AQ==' } },
          { type: 'image', data: { file: 'file:///tmp/local.jpg' } },
        ],
      });
      await onebotFinished;
      expect(onebotEvents[0]).toMatchObject({
        eventId: 'qq:100:private:87',
        sourceMessageId: '87',
        kind: 'message',
        parts: [
          { kind: 'text', text: 'Before image ' },
          { kind: 'image', media: { name: 'image', mediaType: 'image/jpeg' } },
          { kind: 'text', text: ' after image' },
        ],
      });
      expect(onebotEvents[1]).toMatchObject({
        eventId: 'qq:100:private:88',
        sourceMessageId: '88',
        kind: 'message',
        parts: [
          { kind: 'text', text: 'OneBot text ' },
          { kind: 'image', media: { name: 'image', mediaType: 'image/jpeg' } },
          { kind: 'image', text: 'local_path_not_fetched' },
        ],
      });
    } finally {
      await onebotHub.stop();
    }

    let discordHandlers: Parameters<NonNullable<Extract<SessionSpec, { platform: 'discord' }>['connection']>['run']>[0] | undefined;
    const discordRaw = createDiscordSessionAdapter({
      platform: 'discord',
      instance_id: 'packaged-discord-rich',
      bot_token: 'discord-offline-token',
      retry_ms: 0,
      connection: {
        async run(handlers, _store, _scope, signal) {
          discordHandlers = handlers;
          handlers.onReady('bot');
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => { resolve(); }, { once: true });
          });
        },
        async send() { return ['d_out']; },
        async download(url) {
          if (url === 'https://cdn.discordapp.com/fail.png') throw new Error('download_failed');
          return Uint8Array.of(4, 5, 6);
        },
      },
    }, { async load() { return undefined; }, async save() {} });
    const discordHub = new HubSessionAdapter(discordRaw);
    const discordEvents: unknown[] = [];
    await discordHub.start(async (event) => { discordEvents.push(event); });
    try {
      await discordHandlers?.onEvent({
        id: '901',
        channel_id: '11',
        channel: { type: 1 },
        author: { id: 'user_1' },
        content: 'Discord caption survives failure',
        attachments: [{ url: 'https://cdn.discordapp.com/fail.png', filename: 'broken.png', content_type: 'image/png', size: 3 }],
      });
      await discordHandlers?.onEvent({
        id: '902',
        channel_id: '11',
        channel: { type: 1 },
        author: { id: 'user_1' },
        content: 'Two Discord attachments',
        attachments: [
          { url: 'https://cdn.discordapp.com/ok.png', filename: 'first.png', content_type: 'image/png', size: 3 },
          { url: 'https://cdn.discordapp.com/fail.png', filename: 'second.png', content_type: 'image/png', size: 3 },
        ],
      });
      expect(discordEvents).toHaveLength(2);
      expect(discordEvents[0]).toMatchObject({
        eventId: 'discord:bot:901:0',
        sourceMessageId: '901',
        kind: 'message',
        text: 'Discord caption survives failure',
        parts: [
          { kind: 'text', text: 'Discord caption survives failure' },
          { kind: 'image', text: 'download_failed' },
        ],
      });
      expect(discordEvents[1]).toMatchObject({
        eventId: 'discord:bot:902:0',
        sourceMessageId: '902',
        kind: 'message',
        parts: [
          { kind: 'text', text: 'Two Discord attachments' },
          { kind: 'image', media: { name: 'first.png', mediaType: 'image/png', bytes: Uint8Array.of(4, 5, 6) } },
          { kind: 'image', text: 'download_failed' },
        ],
      });
    } finally {
      await discordHub.stop();
    }
  });

  it('uses Node 24 single-address pinned IPv4 lookup for packaged Telegram session polling, media download, sends, and outbound notifications', async () => {
    const seen: [string | undefined, string | undefined][] = [];
    let updatesPolled = 0;
    const server = createServer((req, res) => {
      seen.push([req.method, req.url]);
      req.resume();
      res.setHeader('connection', 'close');
      if (req.method === 'GET') {
        res.end('pinned-photo-bytes');
        return;
      }
      if (req.url?.endsWith('/getMe')) {
        res.end('{"ok":true,"result":{"id":42,"username":"PinnedBot"}}');
        return;
      }
      if (req.url?.endsWith('/getWebhookInfo')) {
        res.end('{"ok":true,"result":{"url":""}}');
        return;
      }
      if (req.url?.endsWith('/getUpdates')) {
        updatesPolled += 1;
        if (updatesPolled === 1) {
          res.end(JSON.stringify({
            ok: true,
            result: [{
              update_id: 1,
              message: {
                message_id: 99,
                caption: 'Pinned photo',
                photo: [{ file_id: 'file_1', file_size: 18 }],
                chat: { id: 7, type: 'private' },
                from: { id: 8 },
              },
            }],
          }));
          return;
        }
        res.end('{"ok":true,"result":[]}');
        return;
      }
      if (req.url?.endsWith('/getFile')) {
        res.end('{"ok":true,"result":{"file_path":"photos/a.jpg","file_size":18}}');
        return;
      }
      res.end('{"ok":true,"result":{"message_id":42,"errcode":0}}');
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => { resolve(); }).once('error', reject);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server_port_missing');
    const port = address.port;
    const publicIp = '93.184.216.34';
    const previousAutoSelect = getDefaultAutoSelectFamily();
    setDefaultAutoSelectFamily(true);
    const resolve4Spy = vi.spyOn(dns, 'resolve4').mockImplementation((async (host: string) => {
      expect(['api.telegram.org', 'qyapi.weixin.qq.com', 'example.com']).toContain(host);
      return [publicIp];
    }) as typeof dns.resolve4);
    const resolve6Spy = vi.spyOn(dns, 'resolve6').mockImplementation((async () => []) as unknown as typeof dns.resolve6);
    const requestSpy = vi.spyOn(https, 'request').mockImplementation(((options: https.RequestOptions, onResponse?: (res: import('node:http').IncomingMessage) => void) => {
      expect(options.agent).toBe(false);
      expect(options.family).toBe(4);
      expect(typeof options.lookup).toBe('function');
      const pinnedLookup = options.lookup!;
      return httpRequest({
        ...options,
        protocol: 'http:',
        hostname: 'pinned.example.test',
        port,
        lookup: (_host, lookupOptions, done) => {
          expect(lookupOptions.all).not.toBe(true);
          pinnedLookup(options.hostname ?? '', lookupOptions, (error, resolvedAddress, resolvedFamily) => {
            if (error) {
              done(error, '', 4);
              return;
            }
            expect(resolvedAddress).toBe(publicIp);
            expect(resolvedFamily).toBe(4);
            done(null, '127.0.0.1', 4);
          });
        },
      }, onResponse);
    }) as typeof https.request);
    syncBuiltinESMExports();

    const token = '123456:AAAAAAAAAAAAAAAAAAAA';
    let photoReceived!: () => void;
    const photoPromise = new Promise<void>((resolve) => { photoReceived = resolve; });
    const admitted: import('../../../src/services/imSession/adapter').ImInboundEvent[] = [];
    const raw = createTelegramSessionAdapter({
      platform: 'telegram',
      instance_id: 'packaged-tg-pinned-ipv4',
      token,
      retry_ms: 50,
    }, { async load() { return undefined; }, async save() {} });
    const hub = new HubSessionAdapter(raw);
    try {
      await hub.start(async (event) => {
        admitted.push(event);
        photoReceived();
      });
      await photoPromise;
      expect(admitted[0]).toMatchObject({
        sourceMessageId: '99',
        kind: 'image',
        text: 'Pinned photo',
      });
      expect(Buffer.from(admitted[0]?.media?.bytes ?? []).toString('utf8')).toBe('pinned-photo-bytes');

      const sent = await hub.sendText({
        identity: { chatId: '7', senderId: '8', topicId: '0' },
        text: 'hello over pinned ipv4',
        code: 'reply',
      });
      expect(sent.messageId).toBe('42');

      expect(await telegramHttps.post(token, '{}', () => 'ready')).toMatchObject({ status: 200 });
      expect(await wecomHttps.post('fixture-key', '{}', () => 'ready')).toMatchObject({ status: 200 });
      expect(await createSafeHttpTransport().post({
        url: 'https://example.com/webhook',
        body: '{}',
        content_type: 'application/json',
      }, () => 'ready')).toMatchObject({ status: 200 });

      expect(seen).toEqual(expect.arrayContaining([
        ['POST', `/bot${token}/getMe`],
        ['POST', `/bot${token}/getWebhookInfo`],
        ['POST', `/bot${token}/getUpdates`],
        ['POST', `/bot${token}/getFile`],
        ['GET', `/file/bot${token}/photos/a.jpg`],
        ['POST', `/bot${token}/sendMessage`],
        ['POST', '/cgi-bin/webhook/send?key=fixture-key'],
        ['POST', '/webhook'],
      ]));
    } finally {
      await hub.stop().catch(() => undefined);
      requestSpy.mockRestore();
      resolve4Spy.mockRestore();
      resolve6Spy.mockRestore();
      syncBuiltinESMExports();
      setDefaultAutoSelectFamily(previousAutoSelect);
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    }
  });
});
