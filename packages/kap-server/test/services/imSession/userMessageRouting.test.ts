import { describe, expect, it } from 'vitest';

import type { MessageAttachmentReceipt } from '@kiki/agent-core-v2/app/bot/messageRouting';
import { ImSessionBridge } from '../../../src/services/imSession/bridge';
import { FakeImAdapter, fakeAdapterFactory } from '../../../src/services/imSession/fakeAdapter';
import { ImSendError } from '../../../src/services/imSession/adapter';
import type { ImSessionPorts } from '../../../src/services/imSession/ports';

const identity = { chatId: 'c1', senderId: 'u1', topicId: '0' };
const image: MessageAttachmentReceipt = { blobId: 'blobref:main:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', path: '/tmp/a.png', mimeType: 'image/png', size: 4, kind: 'image' };
const voice: MessageAttachmentReceipt = { blobId: 'blobref:main:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', path: '/tmp/a.ogg', mimeType: 'audio/ogg', size: 4, kind: 'voice' };

function ports(overrides: Partial<ImSessionPorts['sessions']> = {}): { ports: ImSessionPorts; saved: string[] } {
  const secrets = new Map<string, string>();
  const saved: string[] = [];
  let stored = '';
  const sessions: ImSessionPorts['sessions'] = {
    listPersonas: async () => [{ id: 'ada', name: 'Ada', homeSessionId: 'home' }],
    listSessions: async () => [{ id: 'sess', title: 'Notes', personaId: 'ada' }],
    owns: async (sessionId) => sessionId === 'sess' || sessionId === 'home',
    ensureHome: async () => ({ homeSessionId: 'home' }),
    activity: async () => ({ busy: false, pending: 'none', queueLength: 0 }),
    submit: async ({ promptId }) => ({ duplicate: false, promptId, turnId: 1, deliveryState: 'pending' }),
    steer: async () => 'steered',
    abort: async () => false,
    saveMedia: async () => [],
    readAttachment: async ({ blobId }) => saved.includes(blobId) ? { bytes: new Uint8Array([1, 2, 3, 4]), name: 'a' } : undefined,
    readVisible: async () => ({ text: '', done: true, media: [] }),
    listInteractions: async () => ({ approvals: [], questions: [] }),
    decideApproval: async () => 'decided',
    decideHostKey: async () => 'decided',
    answerQuestion: async () => 'answered',
    ...overrides,
  };
  return {
    saved,
    ports: {
      credentials: {
        list: () => [...secrets.keys()].map((id) => ({ id, providerId: 'telegram', configured: true })),
        read: (id) => secrets.get(id),
        write: async (id, value) => { secrets.set(id, value); },
        check: async () => ({ ok: true, accountId: '42' }),
        create: async ({ credential }) => { secrets.set('inst', credential); return { instanceId: 'inst' }; },
      },
      sessions,
      logger: { info() {} },
      load: async () => stored === '' ? undefined : stored,
      save: async (value) => { stored = value; },
    },
  };
}

async function boundBridge(adapter = new FakeImAdapter('telegram', '42'), sessionPorts = ports()) {
  const bridge = new ImSessionBridge({ ports: sessionPorts.ports, factories: [fakeAdapterFactory(adapter)], editIntervalMs: 0, now: () => 1_700_000_000_000, wait: () => Promise.resolve() });
  await bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
  await bridge.setListening('inst', true);
  await adapter.emit({ eventId: '1', cursor: 1, identity, kind: 'text', text: 'hello' });
  const discovery = (await bridge.snapshot()).discoveries[0]!;
  await bridge.confirm(discovery.id, { target: { kind: 'session', session_id: 'sess' } });
  return { bridge, adapter, sessionPorts };
}

describe('im session user message channels', () => {
  it('keeps the in-app channel on by default and reports it with the bound IM channel', async () => {
    const { bridge } = await boundBridge();
    try {
      const views = await bridge.channelViews('sess');
      expect(views).toEqual([
        expect.objectContaining({ id: 'internal', kind: 'internal', enabled: true }),
        expect.objectContaining({ id: expect.stringMatching(/^im:/u), kind: 'im', enabled: true }),
      ]);
      expect(views[1]!.capabilities.map((capability) => capability.kind)).toEqual(expect.arrayContaining(['file', 'image', 'audio', 'voice']));
    } finally { await bridge.close(); }
  });

  it('keeps the in-app channel permanently enabled and rejects an explicit opt-out', async () => {
    const sessionPorts = ports();
    const { bridge, adapter } = await boundBridge(new FakeImAdapter('telegram', '42'), sessionPorts);
    try {
      await expect(bridge.setInternalChannel('sess', false)).rejects.toThrow('unsupported_internal_channel_disable');
      const reopened = new ImSessionBridge({ ports: sessionPorts.ports, factories: [fakeAdapterFactory(adapter)], editIntervalMs: 0 });
      await reopened.whenReady();
      expect(await bridge.internalChannelEnabled('sess')).toBe(true);
      expect(await reopened.internalChannelEnabled('sess')).toBe(true);
      expect((await reopened.channelViews('sess'))[0]).toMatchObject({ id: 'internal', enabled: true });
      await reopened.close();
      await bridge.removeBinding((await bridge.snapshot()).bindings[0]!.id);
      const receipt = await bridge.sendUserMessage({ sessionId: 'sess', toolCallId: 'c1', text: 'only internal', attachments: [] });
      expect(receipt.channels?.map((channel) => channel.channelId)).toEqual(['internal']);
    } finally { await bridge.close(); }
  });

  it('keeps an internal destination after the last IM binding is removed', async () => {
    const { bridge } = await boundBridge();
    try {
      const binding = (await bridge.snapshot()).bindings[0]!;
      await bridge.removeBinding(binding.id);
      const receipt = await bridge.sendUserMessage({ sessionId: 'sess', toolCallId: 'c1', text: 'internal fallback', attachments: [] });
      expect(receipt.channels).toEqual([expect.objectContaining({ channelId: 'internal', status: 'delivered' })]);
      expect(receipt.delivery).toBe('delivered');
    } finally { await bridge.close(); }
  });

  it('sends text and supported media to a bound IM channel', async () => {
    const sessionPorts = ports();
    sessionPorts.saved.push(image.blobId);
    const { bridge, adapter } = await boundBridge(new FakeImAdapter('telegram', '42'), sessionPorts);
    try {
      const receipt = await bridge.sendUserMessage({ sessionId: 'sess', toolCallId: 'c1', text: 'look', attachments: [image] });
      expect(receipt.deliveredTo).toEqual(['user']);
      expect(receipt.channels?.map((channel) => channel.status)).toEqual(['delivered', 'delivered']);
      expect(adapter.sent.some((message) => message.text === 'look')).toBe(true);
      expect(adapter.files.at(-1)).toMatchObject({ asImage: true, mediaType: 'image/png' });
    } finally { await bridge.close(); }
  });

  it('marks unsupported voice per channel instead of downgrading it to a file', async () => {
    const sessionPorts = ports();
    sessionPorts.saved.push(voice.blobId);
    const adapter = new FakeImAdapter('telegram', '42');
    adapter.voice = false;
    const { bridge } = await boundBridge(adapter, sessionPorts);
    try {
      const receipt = await bridge.sendUserMessage({ sessionId: 'sess', toolCallId: 'c1', text: '', attachments: [voice] });
      const im = receipt.channels?.find((channel) => channel.channelId !== 'internal');
      expect(im).toMatchObject({ status: 'unsupported', unsupported: ['voice'] });
      expect(adapter.files).toHaveLength(0);
      expect(adapter.sent.at(-1)?.text).toContain('This channel cannot take: voice.');
      expect(receipt.channels?.find((channel) => channel.channelId === 'internal')?.status).toBe('delivered');
    } finally { await bridge.close(); }
  });

  it('keeps an unavailable attachment a failure rather than a silent drop', async () => {
    const { bridge } = await boundBridge();
    try {
      const im = (await bridge.channelViews('sess')).find((channel) => channel.kind === 'im')!;
      const receipt = await bridge.sendUserMessage({ sessionId: 'sess', toolCallId: 'c1', channel: im.id, text: '', attachments: [image] });
      expect(receipt.delivery).toBe('undeliverable');
      expect(receipt.channels).toEqual([expect.objectContaining({ channelId: im.id, status: 'failed', detail: 'attachment_unavailable' })]);
    } finally { await bridge.close(); }
  });
});

it('retains a disconnected enabled binding as a failed destination rather than claiming no destination', async () => {
  const { bridge } = await boundBridge();
  try {
    await bridge.setListening('inst', false);
    const views = await bridge.channelViews('sess');
    expect(views).toHaveLength(2);
    const im = views.find((channel) => channel.kind === 'im')!;
    expect(im).toMatchObject({ enabled: true });
    const receipt = await bridge.sendUserMessage({ sessionId: 'sess', toolCallId: 'offline', channel: im.id, text: 'still bound', attachments: [] });
    expect(receipt.channels).toEqual([expect.objectContaining({ channelId: im.id, status: 'failed', detail: 'channel_not_connected' })]);
    expect(receipt.deliveredTo).toEqual([]);
  } finally { await bridge.close(); }
});

it('rejects voice before any send when the only enabled IM channel cannot take voice', async () => {
  const adapter = new FakeImAdapter('telegram', '42');
  adapter.voice = false;
  const { bridge } = await boundBridge(adapter);
  try {
    const im = (await bridge.channelViews('sess')).find((channel) => channel.kind === 'im')!;
    const before = adapter.sent.length;
    await expect(bridge.sendUserMessage({ sessionId: 'sess', toolCallId: 'unsupported', channel: im.id, text: 'voice', attachments: [voice] })).rejects.toThrow('media_unsupported');
    expect(adapter.sent).toHaveLength(before);
    expect(adapter.files).toHaveLength(0);
  } finally { await bridge.close(); }
});

it('keeps an uncertain channel unknown and does not resend even when another channel succeeds', async () => {
  const adapter = new FakeImAdapter('telegram', '42');
  const { bridge } = await boundBridge(adapter);
  let attempts = 0;
  adapter.sendTextParts = async () => { attempts += 1; throw new Error('timeout'); };
  try {
    const receipt = await bridge.sendUserMessage({ sessionId: 'sess', toolCallId: 'unknown', text: 'hello', attachments: [] });
    expect(receipt.channels).toEqual([expect.objectContaining({ channelId: 'internal', status: 'delivered' }), expect.objectContaining({ status: 'unknown' })]);
    expect(attempts).toBe(1);
    expect(receipt.delivery).toBe('delivered');
  } finally { await bridge.close(); }
});

it('notifies a channel when a runtime refusal makes its declared media unavailable', async () => {
  const sessionPorts = ports();
  sessionPorts.saved.push(image.blobId);
  const adapter = new FakeImAdapter('telegram', '42');
  const { bridge } = await boundBridge(adapter, sessionPorts);
  adapter.sendMedia = async () => ({ status: 'unsupported', unsupported: ['image'], detail: 'rejected_by_platform' });
  try {
    const receipt = await bridge.sendUserMessage({ sessionId: 'sess', toolCallId: 'dynamic', text: '', attachments: [image] });
    expect(receipt.channels?.find((channel) => channel.channelId !== 'internal')).toMatchObject({ status: 'unsupported', unsupported: ['image'] });
    expect(adapter.sent.at(-1)).toMatchObject({ code: 'media_unsupported', text: expect.stringContaining('image') });
  } finally { await bridge.close(); }
});

it('does not replace an uncertain send with a definite failure when its unsupported-media notice fails', async () => {
  const sessionPorts = ports();
  sessionPorts.saved.push(image.blobId);
  const adapter = new FakeImAdapter('telegram', '42');
  const { bridge } = await boundBridge(adapter, sessionPorts);
  const attempts: string[] = [];
  adapter.sendTextParts = async () => { attempts.push('text'); throw new ImSendError('timeout', [], undefined, 'unknown'); };
  adapter.sendMedia = async () => { attempts.push('image'); return { status: 'unsupported', unsupported: ['image'] }; };
  adapter.sendText = async () => { attempts.push('notice'); throw new ImSendError('notice_rejected'); };
  try {
    const im = (await bridge.channelViews('sess')).find((channel) => channel.kind === 'im')!;
    const receipt = await bridge.sendUserMessage({ sessionId: 'sess', toolCallId: 'uncertain-refusal', channel: im.id, text: 'look', attachments: [image] });
    expect(receipt.delivery).toBe('pending');
    expect(receipt.channels).toEqual([expect.objectContaining({ status: 'unknown', unsupported: ['image'] })]);
    expect(attempts).toEqual(['text', 'image', 'notice']);
  } finally { await bridge.close(); }
});

it('returns a partial receipt when the IM target skips one attachment that internal can carry', async () => {
  const sessionPorts = ports();
  sessionPorts.saved.push(image.blobId, voice.blobId);
  const adapter = new FakeImAdapter('telegram', '42');
  adapter.voice = false;
  const { bridge } = await boundBridge(adapter, sessionPorts);
  try {
    const receipt = await bridge.sendUserMessage({ sessionId: 'sess', toolCallId: 'partial', text: 'mixed media', attachments: [image, voice] });
    expect(receipt.delivery).toBe('delivered');
    expect(receipt.channels).toEqual([
      expect.objectContaining({ channelId: 'internal', status: 'delivered' }),
      expect.objectContaining({ status: 'partial', unsupported: ['voice'] }),
    ]);
    expect(adapter.files).toEqual([expect.objectContaining({ asImage: true, mediaType: 'image/png' })]);
  } finally { await bridge.close(); }
});

it('tests only an enabled confirmed binding and preserves an uncertain outcome without retry', async () => {
  const { bridge, adapter } = await boundBridge();
  try {
    const binding = (await bridge.snapshot()).bindings[0]!;
    await expect(bridge.testBinding('missing')).rejects.toThrow('unknown_binding');
    await bridge.updateBinding(binding.id, { sessionEnabled: false });
    expect(await bridge.testBinding(binding.id)).toMatchObject({ status: 'failed', detail: 'binding_disabled', message_ids: [] });
    expect(adapter.sent).toHaveLength(0);
    await bridge.updateBinding(binding.id, { enabled: false, sessionEnabled: true });
    expect(await bridge.testBinding(binding.id)).toMatchObject({ status: 'failed', detail: 'binding_disabled' });
    expect(adapter.sent).toHaveLength(0);
    await bridge.updateBinding(binding.id, { enabled: true });
    let attempts = 0;
    adapter.sendTextParts = async () => { attempts += 1; throw new ImSendError('rejected'); };
    expect(await bridge.testBinding(binding.id)).toEqual({ binding_id: binding.id, status: 'failed', message_ids: [], detail: 'rejected' });
    expect(attempts).toBe(1);
    adapter.sendTextParts = async () => { attempts += 1; throw new ImSendError('timeout', ['accepted-part'], undefined, 'unknown'); };
    expect(await bridge.testBinding(binding.id)).toEqual({ binding_id: binding.id, status: 'unknown', message_ids: ['accepted-part'], detail: 'timeout' });
    expect(attempts).toBe(2);
    await bridge.setListening('inst', false);
    expect(await bridge.testBinding(binding.id)).toMatchObject({ status: 'failed', detail: 'channel_not_connected' });
    expect(attempts).toBe(2);
  } finally { await bridge.close(); }
});
