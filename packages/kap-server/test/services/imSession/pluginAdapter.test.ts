import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginHost } from '@kiki/agent-core-v2/app/plugin/host';
import { parsePluginImEvent } from '@kiki/agent-core-v2/app/plugin/imAdapter';
import type { IPluginHostService, PluginImAdapterRegistration, PluginImAdapterSink } from '@kiki/agent-core-v2/app/plugin/pluginHostService';
import { PLUGIN_IM_COMPLETE_LIMITS, pluginImAdapterDefinitionSchema } from '@kiki/protocol';
import type { PluginImEvent } from '@kiki/protocol';
import { ImSessionBridge } from '../../../src/services/imSession/bridge';
import { PluginImAdapterBridge } from '../../../src/services/imSession/pluginAdapter';
import type { ImAdapterFactory } from '../../../src/services/imSession/adapter';
import { FakeImAdapter, fakeAdapterFactory } from '../../../src/services/imSession/fakeAdapter';
import type { ImSessionPorts } from '../../../src/services/imSession/ports';

const roots: string[] = [];
const hosts: PluginHost[] = [];
const bridges: ImSessionBridge[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const host of hosts.splice(0)) await host.stopAndWait();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
});
const group = { chatId: 'group-1', senderId: 'member-1', topicId: 'topic-1', chatKind: 'group' as const, senderName: 'Member One' };
const privateChat = { chatId: 'private-1', senderId: 'member-1', topicId: '0', chatKind: 'private' as const };

async function fixture(pluginId: string, direction = { inbound: true, outbound: true }, maxInboundBytes = 1024) {
  await mkdir(resolve('.tmp/plugin-im-adapter'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp/plugin-im-adapter/run-'));
  roots.push(root);
  const definition = pluginImAdapterDefinitionSchema.parse({ schemaVersion: 1, id: 'account', label: 'Fixture account', ...direction, listenerRealm: pluginId, maxInboundBytes, supportsReply: true, supportsMentions: true,
    mediaCapabilities: direction.outbound ? ['image', 'voice', 'video'].map((kind) => ({ kind, mimeTypes: [kind === 'voice' ? 'audio/*' : `${kind}/*`] })) : [] });
  const tools = ['event', 'state'].map((name) => ({ schemaVersion: 1 as const, name, description: name, accesses: [{ kind: 'all' as const }], disclosure: 'deferred' as const }));
  await writeFile(join(root, 'entry.mjs'), `
    const definition = ${JSON.stringify(definition)};
    const tools = ${JSON.stringify(tools)};
    const contexts = [];
    let context;
    const state = { started: 0, stopped: 0, text: [], media: [] };
    export function register(api) {
      api.registerImAdapter(definition, {
        async start(value) { context = value; contexts.push(value); state.messageLimits = value.messageLimits; state.limitsFrozen = Object.isFrozen(value.messageLimits); state.started++; return { accountId: 'account-42', targets: definition.inbound ? undefined : [${JSON.stringify(privateChat)}] }; },
        async stop() { state.stopped++; },
        async sendText(message) { state.text.push(message); return message.text === 'uncertain' ? { status: 'unknown', messageIds: ['accepted-part'] } : { status: 'delivered', messageIds: [] }; },
        async sendMedia(message) { state.media.push({ ...message, bytes: [...message.bytes] }); return { status: 'delivered', messageIds: ['media-' + state.media.length] }; }
      });
      for (const tool of tools) api.registerTool(tool, async (args) => {
        if (tool.name === 'event') {
          const event = args.event ?? args;
          if (args.generateBytes !== undefined) for (const [index, part] of event.parts.entries()) if (part.media !== undefined) part.media.bytes = new Uint8Array(args.generateBytes).fill(index);
          if (args.generateText !== undefined) event.parts = [{ kind: 'text', text: args.generateText.character.repeat(args.generateText.length) }];
          if (args.incomplete) process.stdout.write(JSON.stringify({ method: 'im-adapter-message-chunk', params: { adapterId: definition.id, callId: 999999, index: 0, characters: context.messageLimits.chunkChars + 1, data: ' '.repeat(context.messageLimits.chunkChars) } }) + '\\n');
          else await (args.previous ? contexts.at(-2) : context).emit(event);
        }
        return { output: JSON.stringify(state) };
      });
    }
  `);
  const host = new PluginHost(pluginId, join(root, 'entry.mjs'), tools, [], [], undefined, undefined, [definition]);
  hosts.push(host);
  const registration: PluginImAdapterRegistration = { pluginId, definition, providerKind: `plugin:${pluginId}/account`, instanceId: `plugin:${pluginId}/account`, revision: 'fixture-1', connect: (listener, offset) => host.connectImAdapter('account', {}, `plugin:${pluginId}/account`, listener, offset) };
  const call = async (name: string, args?: unknown) => {
    const result = await host.execute(name, args, new AbortController().signal);
    if (typeof result.output !== 'string') throw new Error('Fixture returned non-text state');
    return JSON.parse(result.output);
  };
  return { host, registration, emit: (event: PluginImEvent) => call('event', event), generated: (event: PluginImEvent, generation: { generateBytes?: number; generateText?: { character: string; length: number }; previous?: boolean; incomplete?: boolean }) => call('event', { event, ...generation }), state: () => call('state') };
}

async function hostBridge(registrations: readonly PluginImAdapterRegistration[], builtin?: { adapter: FakeImAdapter; minSendIntervalMs?: number }, clock?: { now: () => number; wait: (ms: number) => Promise<void> }, overrides: { sessions?: Partial<ImSessionPorts['sessions']>; history?: ImSessionPorts['history'] } = {}) {
  const factories: ImAdapterFactory[] = builtin === undefined ? [] : [{ ...fakeAdapterFactory(builtin.adapter), minSendIntervalMs: builtin.minSendIntervalMs }];
  const registry = new PluginImAdapterBridge(factories);
  let sink: PluginImAdapterSink | undefined;
  const submitted: Parameters<ImSessionPorts['sessions']['submit']>[0][] = [];
  const abort = vi.fn(async () => true);
  const ports: ImSessionPorts = {
    credentials: { list: () => [...registry.credentials(), ...(builtin === undefined ? [] : [{ id: 'builtin', providerId: builtin.adapter.providerKind, configured: true }])], read: (id) => id === 'builtin' ? 'builtin-credential' : registry.credential(id), write: async () => undefined, check: async () => ({ ok: true }) },
    sessions: { listPersonas: async () => [], listSessions: async () => [], owns: async () => true, ensureHome: async () => ({ homeSessionId: 'session-1' }),
      activity: async () => ({ busy: false, pending: 'none', queueLength: 0 }),
      submit: async (input) => { submitted.push(input); return { duplicate: false, promptId: input.promptId, deliveryState: 'pending' }; },
      steer: async () => 'queued', abort, saveMedia: async () => [], readAttachment: async () => ({ bytes: new Uint8Array([1, 2, 3]), name: 'fixture' }),
      readVisible: async () => ({ text: '', done: true, media: [] }), listInteractions: async () => ({ approvals: [], questions: [] }),
      decideApproval: async () => 'decided', decideHostKey: async () => 'decided', answerQuestion: async () => 'answered', ...overrides.sessions },
    history: overrides.history,
    logger: { info() {} }, load: async () => undefined, save: async () => undefined,
  };
  const bridge = new ImSessionBridge({ ports, factories, editIntervalMs: 0, now: clock?.now, wait: clock?.wait });
  bridges.push(bridge);
  await bridge.whenReady();
  await registry.attach({ attachImAdapters: async (value: PluginImAdapterSink) => { sink = value; await value.replace(registrations); } } as IPluginHostService, (kinds) => bridge.reconcileAdapters(kinds));
  if (builtin !== undefined) await bridge.setListening('builtin', true);
  for (const item of registrations) await bridge.setListening(item.instanceId, true);
  return { bridge, registry, sink: sink!, submitted, abort };
}

async function bind(bridge: ImSessionBridge, plugin: Awaited<ReturnType<typeof fixture>>, identity: PluginImEvent['identity'] = group, scope: 'sender' | 'topic' | 'chat' = 'sender') {
  await vi.waitFor(async () => expect((await bridge.snapshot()).instances.find((item) => item.id === plugin.registration.instanceId)?.adapter).toBe('running'));
  await plugin.emit({ eventId: `discover-${identity.chatId}-${identity.senderId}`, identity, kind: 'text', text: 'bind me' });
  const discovery = (await bridge.snapshot()).discoveries.find((item) => item.provider_instance_id === plugin.registration.instanceId)!;
  await bridge.confirm(discovery.id, { target: { kind: 'session', session_id: 'session-1' }, binding_scope: scope });
}

function memoryRegistration(id: string, realm: string, accountId = '42', inbound = true) {
  const stop = vi.fn(async () => undefined);
  const request = vi.fn(async (): Promise<import('@kiki/protocol').PluginImDeliveryReceipt> => ({ status: 'delivered', messageIds: [] }));
  let listener: ((event: PluginImEvent) => Promise<void>) | undefined;
  const connect = vi.fn(async (callback: (event: PluginImEvent) => Promise<void>) => { listener = callback; return { accountId, stop, request }; });
  const entry: PluginImAdapterRegistration = { pluginId: id, definition: pluginImAdapterDefinitionSchema.parse({ schemaVersion: 1, id: 'account', label: id, inbound, outbound: true, listenerRealm: realm, maxInboundBytes: 1024, mediaCapabilities: [] }), providerKind: `plugin:${id}/account`, instanceId: `plugin:${id}/account`, revision: '1', connect };
  return { entry, connect, stop, request, emit: (event: PluginImEvent) => listener!(event) };
}

describe('plugin IM adapter contribution', () => {
  it('admits one complete source message with two 8 MiB images through the real child and replies once', async () => {
    const plugin = await fixture('fixture-complete', undefined, 8 * 1024 * 1024);
    const saved: { name: string; size: number; first: number | undefined }[] = [];
    const documents = new Map<string, unknown>();
    const { bridge, registry, submitted } = await hostBridge([plugin.registration], undefined, undefined, {
      history: {
        get: async <T>(key: string) => structuredClone(documents.get(key)) as T | undefined,
        set: async (key, value) => { documents.set(key, structuredClone(value)); },
        delete: async (key) => { documents.delete(key); },
      },
      sessions: {
        saveMedia: async (input) => {
          saved.push({ name: input.name, size: input.bytes.byteLength, first: input.bytes[0] });
          return [{ type: 'image', source: { kind: 'session_media', file_id: input.name } }];
        },
        readVisible: async () => ({ text: 'one complete answer', done: true, media: [] }),
      },
    });
    await bind(bridge, plugin, group, 'topic');
    const event: PluginImEvent = { eventId: 'root-event', sourceMessageId: 'platform-message-27', kind: 'message', identity: { ...group, senderId: 'member-2', senderName: 'Member Two' }, mentioned: true, mentionIds: ['account-42'], replyToMessageId: 'quote-26', parts: [
      { kind: 'text', text: 'Compare both pictures\nwithout splitting this line.' },
      { kind: 'image', media: { name: 'first.png', mediaType: 'image/png', bytes: new Uint8Array() } },
      { kind: 'audio', text: 'voice.ogg unavailable: platform path has no download URL; ASR: hello' },
      { kind: 'image', media: { name: 'second.png', mediaType: 'image/png', bytes: new Uint8Array() } },
    ] };
    const state = await plugin.generated(event, { generateBytes: 8 * 1024 * 1024 });
    expect(state.messageLimits).toEqual(PLUGIN_IM_COMPLETE_LIMITS);
    expect(state.limitsFrozen).toBe(true);
    expect(saved).toEqual([{ name: 'first.png', size: 8 * 1024 * 1024, first: 1 }, { name: 'second.png', size: 8 * 1024 * 1024, first: 3 }]);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.content).toEqual([
      { type: 'text', text: 'Compare both pictures\nwithout splitting this line.' },
      { type: 'image', source: { kind: 'session_media', file_id: 'first.png' } },
      { type: 'text', text: '[Unavailable external audio: voice.ogg unavailable: platform path has no download URL; ASR: hello]' },
      { type: 'image', source: { kind: 'session_media', file_id: 'second.png' } },
    ]);
    expect(submitted[0]?.im).toMatchObject({ source_message_id: 'platform-message-27', mentioned: true, mention_ids: ['account-42'], reply_to_message_id: 'quote-26', identity: { sender_id: 'member-2', sender_name: 'Member Two' } });
    await plugin.generated(event, { generateBytes: 8 * 1024 * 1024 });
    expect(saved).toHaveLength(2);
    expect(submitted).toHaveLength(1);
    const original = await bridge.readMessageHistory('session-1', { messageId: 'platform-message-27' });
    expect(original.status === 'ok' && original.messages[0]).toMatchObject({ media: [{ name: 'first.png' }, { name: 'second.png' }] });
    await vi.waitFor(async () => expect((await plugin.state()).text.filter((item: { code: string }) => item.code === 'reply')).toHaveLength(1));
    await plugin.generated({ ...event, eventId: 'incomplete' }, { incomplete: true });
    expect(submitted).toHaveLength(1);
    await registry.withdraw(['fixture-complete']);
    await registry.replace([plugin.registration]);
    await expect(plugin.generated({ ...event, eventId: 'stale-owner' }, { previous: true })).rejects.toThrow('IM connection is not receiving');
    expect(submitted).toHaveLength(1);
    await plugin.emit({ eventId: 'after-reconnect', sourceMessageId: 'after-reconnect', kind: 'message', identity: group, mentioned: true, parts: [{ kind: 'text', text: 'fresh complete message' }] });
    expect(submitted).toHaveLength(2);
    expect(submitted[1]?.content).toEqual([{ type: 'text', text: 'fresh complete message' }]);
  });

  it('rejects whole over-budget messages, preserves the escaped-text boundary, and never submits a tooLarge prefix', async () => {
    const plugin = await fixture('fixture-budgets', undefined, 8 * 1024 * 1024);
    const saveMedia = vi.fn(async () => []);
    const { bridge, submitted } = await hostBridge([plugin.registration], undefined, undefined, { sessions: { saveMedia } });
    await bind(bridge, plugin, privateChat);
    const event: PluginImEvent = { eventId: 'budget', sourceMessageId: 'budget-message', identity: privateChat, kind: 'message', parts: [{ kind: 'image', media: { name: 'fixture.png', mediaType: 'image/png', bytes: new Uint8Array() } }] };
    await expect(plugin.generated(event, { generateBytes: 8 * 1024 * 1024 + 1 })).rejects.toThrow('media byte limit');
    await expect(plugin.generated({ ...event, parts: Array.from({ length: 5 }, () => event.parts[0]!) }, { generateBytes: 8 * 1024 * 1024 })).rejects.toThrow('media byte limit');
    await expect(plugin.generated(event, { generateText: { character: 'x', length: PLUGIN_IM_COMPLETE_LIMITS.textChars + 1 } })).rejects.toThrow('text limit');
    await expect(plugin.emit({ ...event, parts: Array.from({ length: PLUGIN_IM_COMPLETE_LIMITS.parts + 1 }, () => ({ kind: 'text', text: 'x' })) })).rejects.toThrow('part count');
    const tooLarge = { ...event, parts: [{ kind: 'text' as const, text: 'must not submit this prefix' }, { kind: 'image' as const, tooLarge: true }] };
    expect(() => parsePluginImEvent(tooLarge, plugin.registration.definition)).toThrow('tooLarge part');
    await expect(plugin.emit({ ...tooLarge, parts: [tooLarge.parts[0]!, event.parts[0]!, tooLarge.parts[1]!] })).rejects.toThrow('tooLarge part');
    expect(saveMedia).not.toHaveBeenCalled();
    expect(submitted).toHaveLength(0);
    const legacy = { eventId: 'legacy-tooLarge', identity: privateChat, kind: 'image' as const, tooLarge: true };
    expect(parsePluginImEvent(legacy, plugin.registration.definition)).toMatchObject({ tooLarge: true });
    await expect(plugin.emit(legacy)).resolves.toBeDefined();
    expect(submitted).toHaveLength(0);
    await plugin.generated({ ...event, eventId: 'text-boundary', sourceMessageId: 'text-boundary' }, { generateText: { character: '\u0000', length: PLUGIN_IM_COMPLETE_LIMITS.textChars } });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.content).toEqual([{ type: 'text', text: '\u0000'.repeat(PLUGIN_IM_COMPLETE_LIMITS.textChars) }]);
  });

  it('keeps the first same-source account listener and frees its claim after unload, while other realms and output-only connections coexist', async () => {
    const builtin = new FakeImAdapter('telegram', '42');
    const duplicate = memoryRegistration('same-source', 'telegram');
    const otherRealm = memoryRegistration('different-source', 'qq');
    const output = memoryRegistration('output-only', 'telegram', '42', false);
    const { bridge, registry } = await hostBridge([duplicate.entry, otherRealm.entry, output.entry], { adapter: builtin });
    let snapshot = await bridge.snapshot();
    expect(snapshot.instances.find((item) => item.id === duplicate.entry.instanceId)).toMatchObject({ conflict: 'account_in_use', listening: true, adapter: 'stopped' });
    expect(duplicate.stop).toHaveBeenCalledTimes(1);
    await expect(duplicate.emit({ eventId: 'retired', identity: privateChat, kind: 'text', text: 'no' })).rejects.toThrow('im_not_ready');
    expect(builtin.stopped).toBe(0);
    for (const id of [otherRealm.entry.instanceId, output.entry.instanceId]) expect(snapshot.instances.find((item) => item.id === id)?.adapter).toBe('running');
    await bridge.setListening('builtin', false);
    await bridge.setListening(duplicate.entry.instanceId, true);
    snapshot = await bridge.snapshot();
    expect(snapshot.instances.find((item) => item.id === duplicate.entry.instanceId)).toMatchObject({ account_id: '42', adapter: 'running' });
    expect(snapshot.instances.find((item) => item.id === duplicate.entry.instanceId)?.conflict).toBeUndefined();
    const competitor = memoryRegistration('competitor', 'telegram');
    await registry.replace([duplicate.entry, otherRealm.entry, output.entry, competitor.entry]);
    await bridge.setListening(competitor.entry.instanceId, true);
    expect((await bridge.snapshot()).instances.find((item) => item.id === competitor.entry.instanceId)?.conflict).toBe('account_in_use');
    await registry.withdraw(['same-source']);
    expect((await bridge.snapshot()).instances.find((item) => item.id === competitor.entry.instanceId)?.adapter).toBe('running');
    expect(otherRealm.stop).not.toHaveBeenCalled();
  });

  it('paces explicit messages to a builtin target and cancels queued sends without changing newline boundaries', async () => {
    const builtin = new FakeImAdapter('telegram', '42');
    let now = 0;
    const waits: number[] = [];
    const { bridge } = await hostBridge([], { adapter: builtin, minSendIntervalMs: 1000 }, { now: () => now, wait: async (ms) => { waits.push(ms); now += ms; } });
    await builtin.emit({ eventId: 'discover', identity: privateChat, kind: 'text', text: 'hello' });
    const discovery = (await bridge.snapshot()).discoveries[0]!;
    await bridge.confirm(discovery.id, { target: { kind: 'session', session_id: 'session-1' } });
    const binding = (await bridge.snapshot()).bindings[0]!;
    for (const [index, text] of ['one\nline', 'two', 'three'].entries()) await bridge.sendUserMessage({ sessionId: 'session-1', toolCallId: `batch:item:${index}`, channel: `im:${binding.id}`, text, attachments: [] });
    expect(builtin.sent.filter((item) => item.code === 'send_message').map((item) => item.text)).toEqual(['one\nline', 'two', 'three']);
    expect(waits).toEqual([1000, 1000]);
    const controller = new AbortController();
    controller.abort();
    await bridge.sendUserMessage({ sessionId: 'session-1', toolCallId: 'cancelled', channel: `im:${binding.id}`, text: 'never', attachments: [], signal: controller.signal });
    expect(builtin.sent.some((item) => item.text === 'never')).toBe(false);
  });

  it('retries only explicit unaccepted rate limits, retaining accepted-empty, partial and unknown receipts', async () => {
    const plugin = memoryRegistration('rate-fixture', 'fixture');
    plugin.request.mockResolvedValueOnce({ status: 'failed', errorKind: 'rate_limited', retryAfterMs: 1 }).mockResolvedValueOnce({ status: 'delivered', messageIds: [] });
    const { bridge } = await hostBridge([plugin.entry]);
    await plugin.emit({ eventId: 'discover', identity: privateChat, kind: 'text', text: 'hello' });
    await bridge.confirm((await bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'session', session_id: 'session-1' } });
    const binding = (await bridge.snapshot()).bindings[0]!;
    const send = (id: string) => bridge.sendUserMessage({ sessionId: 'session-1', toolCallId: id, channel: `im:${binding.id}`, text: id, attachments: [] });
    expect((await send('rate')).channels?.[0]?.status).toBe('delivered');
    expect(plugin.request).toHaveBeenCalledTimes(2);
    plugin.request.mockResolvedValueOnce({ status: 'unknown', errorKind: 'rate_limited', retryAfterMs: 1 });
    expect((await send('unknown')).channels?.[0]?.status).toBe('unknown');
    await send('unknown');
    plugin.request.mockResolvedValueOnce({ status: 'partial', messageIds: ['part'], errorKind: 'rate_limited', retryAfterMs: 1 });
    expect((await send('partial')).channels?.[0]?.status).toBe('partial');
    plugin.request.mockResolvedValueOnce({ status: 'failed' });
    expect((await send('failed')).channels?.[0]?.status).toBe('failed');
    const unsupportedReply = await bridge.sendUserMessage({ sessionId: 'session-1', toolCallId: 'reply', channel: `im:${binding.id}`, text: 'quoted', attachments: [], replyTo: 'source-message' });
    expect(unsupportedReply.channels?.[0]).toMatchObject({ status: 'unsupported', unsupported: ['reply'] });
    const unsupportedMention = await bridge.sendUserMessage({ sessionId: 'session-1', toolCallId: 'mention', channel: `im:${binding.id}`, text: 'mentioned', attachments: [], mentionIds: ['member-2'] });
    expect(unsupportedMention.channels?.[0]).toMatchObject({ status: 'unsupported', unsupported: ['mentions'] });
    expect(plugin.request).toHaveBeenCalledTimes(5);
  });
  it('registers sandbox input, preserves group metadata and reuses Host bindings, media routing and owned withdrawal', async () => {
    const first = await fixture('fixture-im');
    const other = await fixture('fixture-other');
    const { bridge, registry, submitted, abort } = await hostBridge([first.registration, other.registration]);
    await bind(bridge, first, group, 'topic');
    const member = { ...group, senderId: 'member-2', senderName: 'Member Two' };
    await first.emit({ eventId: 'event-2', sourceMessageId: 'platform-message-9', mentioned: true, mentionIds: ['account-42'], replyToMessageId: 'quote-8', identity: member, kind: 'text', text: 'first line\nsecond line' });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ content: [{ type: 'text', text: 'first line\nsecond line' }], im: { identity: { sender_id: 'member-2', topic_id: 'topic-1' }, source_message_id: 'platform-message-9', mentioned: true, mention_ids: ['account-42'], reply_to_message_id: 'quote-8' } });
    await first.emit({ eventId: 'unauthorized-command', identity: member, kind: 'text', text: ':abort' });
    expect(abort).not.toHaveBeenCalled();
    await bind(bridge, first, privateChat);
    const bound = (await bridge.snapshot()).bindings.find((item) => item.identity.chat_kind === 'group')!;
    await expect(bridge.updateBinding(bound.id, { sessionId: 'session-2' })).rejects.toThrow();
    const media = ['voice', 'image', 'video'].map((kind) => ({ blobId: `fixture-${kind}`, path: `fixture.${kind}`, size: 3, mimeType: kind === 'voice' ? 'audio/ogg' : `${kind}/fixture`, kind }));
    const receipt = await bridge.sendUserMessage({ sessionId: 'session-1', toolCallId: 'send-1', channel: `im:${bound.id}`, text: 'sent text', attachments: media, replyTo: 'quote-target', mentionIds: ['member-2'] });
    expect(receipt.channels?.[0]).toMatchObject({ status: 'delivered', messageIds: ['media-1', 'media-2', 'media-3'] });
    const state = await first.state();
    expect(state.text.at(-1)).toMatchObject({ text: 'sent text', replyToMessageId: 'quote-target', mentionIds: ['member-2'] });
    expect(state.media.map((item: { kind: string }) => item.kind)).toEqual(['voice', 'image', 'video']);
    const uncertain = { sessionId: 'session-1', toolCallId: 'unknown-once', channel: `im:${bound.id}`, text: 'uncertain', attachments: [] };
    expect((await bridge.sendUserMessage(uncertain)).channels?.[0]).toMatchObject({ status: 'unknown', messageIds: ['accepted-part'] });
    await bridge.sendUserMessage(uncertain);
    expect((await first.state()).text.filter((item: { text: string }) => item.text === 'uncertain')).toHaveLength(1);
    await registry.withdraw(['fixture-im']);
    expect((await first.state()).stopped).toBe(1);
    expect((await other.state()).stopped).toBe(0);
    expect((await bridge.channelViews('session-1')).find((item) => item.id === `im:${bound.id}`)?.enabled).toBe(false);
    await registry.replace([first.registration, other.registration]);
    expect((await first.state()).started).toBe(2);
    expect((await other.state()).started).toBe(1);
    expect((await bridge.snapshot()).bindings).toHaveLength(2);
  });

  it('keeps old sender bindings narrow and enforces each single-direction connection', async () => {
    const narrow = await fixture('fixture-narrow');
    const output = await fixture('fixture-output', { inbound: false, outbound: true });
    const input = await fixture('fixture-input', { inbound: true, outbound: false });
    const { bridge, submitted } = await hostBridge([narrow.registration, output.registration, input.registration]);
    await bind(bridge, narrow);
    await narrow.emit({ eventId: 'other-member', identity: { ...group, senderId: 'member-2' }, kind: 'text', text: 'not authorized by the sender binding' });
    expect(submitted).toEqual([]);
    await vi.waitFor(async () => expect((await bridge.snapshot()).discoveries.some((item) => item.provider_instance_id === output.registration.instanceId)).toBe(true));
    const target = (await bridge.snapshot()).discoveries.find((item) => item.provider_instance_id === output.registration.instanceId)!;
    await expect(bridge.confirm(target.id, { target: { kind: 'session', session_id: 'session-1' }, input_enabled: true })).rejects.toThrow('input_unsupported');
    await bridge.confirm(target.id, { target: { kind: 'session', session_id: 'session-1' } });
    const snapshot = await bridge.snapshot();
    expect(snapshot.bindings.find((item) => item.provider_instance_id === output.registration.instanceId)).toMatchObject({ input_enabled: false });
    expect(snapshot.instances.find((item) => item.id === output.registration.instanceId)).toMatchObject({ inbound: false, outbound: true, listening: false, adapter: 'running' });
    await expect(output.emit({ eventId: 'fake-input', identity: privateChat, kind: 'text', text: 'no' })).rejects.toThrow();
    await bind(bridge, input, privateChat);
    const inputBinding = (await bridge.snapshot()).bindings.find((item) => item.provider_instance_id === input.registration.instanceId)!;
    expect(inputBinding).toMatchObject({ input_enabled: undefined, output_enabled: false });
    expect((await bridge.channelViews('session-1')).find((item) => item.id === `im:${inputBinding.id}`)?.enabled).toBe(false);
    await expect(bridge.sendUserMessage({ sessionId: 'session-1', toolCallId: 'blocked-output', channel: `im:${inputBinding.id}`, text: 'not sent', attachments: [] })).rejects.toThrow('channel_disabled');
    await input.emit({ eventId: 'accepted-input', identity: privateChat, kind: 'text', text: 'received' });
    expect(submitted).toHaveLength(1);
  });
});
