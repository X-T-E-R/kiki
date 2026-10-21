import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionAdapter, SessionOutbound, SessionSink } from '@nb-im/core';
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
