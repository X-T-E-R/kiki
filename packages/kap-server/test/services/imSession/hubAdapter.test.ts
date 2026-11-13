import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeishuSessionAdapter, createOneBotSessionAdapter, createTelegramSessionAdapter, createWechatSessionAdapter, SESSION_CAPABILITIES, type SessionAdapter, type SessionInbound, type SessionOutbound, type SessionPlatformId, type SessionSink, type SessionSpec } from '@nb-im/core';
import { afterEach, describe, expect, it } from 'vitest';

import { checkRealtimeSessionAccount, fileCursorStore, HubSessionAdapter, mimeAllowed, sessionSpec } from '../../../src/services/imSession/hubAdapter';
import { mimeAllowed as sharedMimeAllowed } from '@kiki-dsh/im-bridge-core/adapter';
import { oneBotIdentityTransport, type OneBotIdentityLink } from '../../../src/services/imSession/oneBotIdentity';

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
  const start = hub.start(async (event) => { identities.push(event.identity); receivedEvents.push(event); if (identities.length === 2) admitted(); });
  try {
    await reconnecting;
    expect(hub.connectionPhase()).toBe('reconnecting');
    expect(hub.connectionDetail()).toMatchObject({ code: 'api_error', http_status: 200, ret: -2, failure_count: 1 });
    expect(JSON.stringify(hub.connectionDetail())).not.toContain('private-error');
    release(JSON.stringify({ get_updates_buf: 'next', msgs: ['a', 'b'].map((id) => ({ message_id: id, from_user_id: id, to_user_id: 'bot', message_type: 1, message_state: 2, context_token: `context-${id}`, item_list: [{ type: 1, text_item: { text: `current-${id}` }, ref_msg: id === 'a' ? { title: 'misleading title', message_item: { msg_id: 'older-a', type: 1, text_item: { text: 'actual quote' } } } : { title: 'title only', message_item: { msg_id: 'older-b', type: 2 } } }] })) }));
    await start;
    await received;
    expect(hub.connectionPhase()).toBe('running');
    expect(hub.connectionDetail()).toBeUndefined();
    expect(receivedEvents).toMatchObject([
      { kind: 'text', text: 'current-a', preview: 'current-a', replyToMessageId: 'older-a', quotedText: 'actual quote' },
      { kind: 'text', text: 'current-b', preview: 'current-b', replyToMessageId: 'older-b' },
    ]);
    expect(receivedEvents[1]?.quotedText).toBeUndefined();
    for (const identity of identities) await hub.sendText({ identity, text: 'reply', code: 'reply' });
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
  body = '{"ret":-2,"errmsg":"prepare failed"}';
  await expect(hub.sendText({ identity, text: 'pong', code: 'reply' })).rejects.toThrow('wechat_rejected');
  body = '';
  await expect(hub.sendText({ identity, text: 'pong', code: 'reply' })).rejects.toThrow('wechat_unconfirmed');
  expect(calls).toHaveLength(5);
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
  });
});
