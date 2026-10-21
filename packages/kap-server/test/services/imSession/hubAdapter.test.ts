import type { SessionAdapter, SessionOutbound, SessionSink } from '@nb-im/core';
import { describe, expect, it } from 'vitest';

import { HubSessionAdapter } from '../../../src/services/imSession/hubAdapter';

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
});
