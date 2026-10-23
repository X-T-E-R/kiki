import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWechatSessionAdapter, type SessionAdapter, type SessionOutbound, type SessionSink, type SessionSpec } from '@nb-im/core';
import { afterEach, describe, expect, it } from 'vitest';

import { fileCursorStore, HubSessionAdapter, sessionSpec } from '../../../src/services/imSession/hubAdapter';

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
  const start = hub.start(async (event) => { identities.push(event.identity); if (identities.length === 2) admitted(); });
  try {
    await reconnecting;
    expect(hub.connectionPhase()).toBe('reconnecting');
    expect(hub.connectionDetail()).toMatchObject({ code: 'api_error', http_status: 200, ret: -2, failure_count: 1 });
    expect(JSON.stringify(hub.connectionDetail())).not.toContain('private-error');
    release(JSON.stringify({ get_updates_buf: 'next', msgs: ['a', 'b'].map((id) => ({ message_id: id, from_user_id: id, to_user_id: 'bot', message_type: 1, message_state: 2, context_token: `context-${id}`, item_list: [{ type: 1, text_item: { text: 'pair' } }] })) }));
    await start;
    await received;
    expect(hub.connectionPhase()).toBe('running');
    expect(hub.connectionDetail()).toBeUndefined();
    for (const identity of identities) await hub.sendText({ identity, text: 'reply', code: 'reply' });
    expect(requests.map((request) => request['msg'])).toEqual([
      expect.objectContaining({ to_user_id: 'a', context_token: 'context-a' }),
      expect.objectContaining({ to_user_id: 'b', context_token: 'context-b' }),
    ]);
  } finally { await hub.stop(); }
  expect(hub.connectionPhase()).toBe('stopped');
  expect(polls).toBeLessThanOrEqual(3);
});
