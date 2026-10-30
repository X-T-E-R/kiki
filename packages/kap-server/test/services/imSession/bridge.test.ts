import { createTelegramSessionAdapter } from '@nb-im/core';
import type { UserMessageChannel } from '@kiki/agent-core-v2/app/bot/messageRouting';
import { describe, expect, it, vi } from 'vitest';

import type { ImInboundIdentity } from '../../../src/services/imSession/adapter';
import { ImSessionBridge } from '../../../src/services/imSession/bridge';
import { FakeImAdapter, fakeAdapterFactory } from '../../../src/services/imSession/fakeAdapter';
import { HubSessionAdapter } from '../../../src/services/imSession/hubAdapter';
import { parseImPaste } from '../../../src/services/imSession/paste';
import type { ImPendingApproval, ImPendingQuestion, ImSessionPorts, ImSubmitResult, ImVisibleReply } from '../../../src/services/imSession/ports';

const identity: ImInboundIdentity = { chatId: 'c1', senderId: 'u1', topicId: '0', chatTitle: 'Ada', senderName: 'Ada' };
const other: ImInboundIdentity = { chatId: 'c1', senderId: 'u2', topicId: '0' };

function ports(overrides: Partial<ImSessionPorts['sessions']> = {}, initialState = ''): { ports: ImSessionPorts; submitted: ImSubmitResult[]; decisions: string[]; answers: string[]; saved: string[]; saveCount: { value: number } } {
  const secrets = new Map<string, string>();
  const submitted: ImSubmitResult[] = [];
  const decisions: string[] = [];
  const answers: string[] = [];
  const saved: string[] = [];
  const saveCount = { value: 0 };
  let visible: ImVisibleReply = { text: 'Hello from the session', done: true, media: [] };
  let approvals: ImPendingApproval[] = [];
  let questions: ImPendingQuestion[] = [];
  let stored = initialState;
  const sessions: ImSessionPorts['sessions'] = {
    listPersonas: async () => [{ id: 'ada', name: 'Ada', homeSessionId: 'home' }],
    listSessions: async () => [{ id: 'sess', title: 'Notes', personaId: 'ada' }],
    owns: async (sessionId) => sessionId === 'sess' || sessionId === 'home',
    ensureHome: async () => ({ homeSessionId: 'home' }),
    setHome: async () => undefined,
    activity: async () => ({ busy: false, pending: 'none', queueLength: 0 }),
    submit: async (input) => {
      const result: ImSubmitResult = { duplicate: submitted.some((item) => item.promptId === input.promptId), promptId: input.promptId, turnId: 3, deliveryState: 'pending' };
      submitted.push(result);
      return result;
    },
    steer: async () => 'steered',
    abort: async () => false,
    saveMedia: async (input) => { saved.push(input.kind); return [{ type: 'text', text: input.text ?? input.name }]; },
    readVisible: async () => visible,
    listInteractions: async () => ({ approvals, questions }),
    decideApproval: async (input) => { decisions.push(input.decision); return 'decided'; },
    decideHostKey: async (input) => { decisions.push(`host:${input.decision}`); return 'decided'; },
    answerQuestion: async (input) => { answers.push(input.response.kind); return 'answered'; },
    ...overrides,
  };
  return {
    submitted, decisions, answers, saved, saveCount,
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
      save: async (value) => { saveCount.value += 1; stored = value; },
    },
  };
}

function bridgeFor(adapter: FakeImAdapter, sessionPorts = ports(), options: { wait?: (ms: number) => Promise<void> } = {}) {
  const bridge = new ImSessionBridge({
    ports: sessionPorts.ports,
    factories: [fakeAdapterFactory(adapter)],
    editIntervalMs: 0,
    now: () => 1_700_000_000_000,
    wait: options.wait ?? (() => Promise.resolve()),
  });
  return { bridge, ...sessionPorts };
}

describe('im session bridge', () => {
  it('splits a pasted blob and ignores a chat hint', () => {
    const parsed = parseImPaste('token=123456:abcdefghijklmnopqrstuvwxyz\nchat_id=9\nbusy=steer\nreply=edit\npersona=Ada\nextra=1');
    expect(parsed.providerKind).toBe('telegram');
    expect(parsed.credential).toBe('123456:abcdefghijklmnopqrstuvwxyz');
    expect(parsed.chatHintIgnored).toBe(true);
    expect(parsed.ignoredKeys).toEqual(['extra']);
    expect(parsed.busy).toBe('steer');
    expect(JSON.stringify(parsed)).not.toContain('extra=1');
  });

  it('pairs from a phone message, submits once, and sends the visible final text', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const harness = bridgeFor(adapter);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await adapter.emit({ eventId: '1', cursor: 1, identity, kind: 'text', text: 'hello' });
    expect(harness.submitted).toEqual([]);
    let snap = await harness.bridge.snapshot();
    expect(snap.discoveries).toHaveLength(1);
    expect(snap.discoveries[0]?.preview).toBe('hello');
    await harness.bridge.confirm(snap.discoveries[0]!.id, { target: { kind: 'persona', persona_id: 'ada' }, busy: 'queue', reply: 'final', mobile_interactions: true });
    await adapter.emit({ eventId: '2', cursor: 2, identity, kind: 'text', text: 'what is ready?' });
    await adapter.emit({ eventId: '2', cursor: 2, identity, kind: 'text', text: 'what is ready?' });
    expect(harness.submitted).toHaveLength(1);
    expect(harness.submitted[0]?.promptId).toBe('im:inst:2');
    await adapter.emit({ eventId: '8', cursor: 8, identity, kind: 'text', text: '1' });
    expect(harness.submitted).toHaveLength(2);
    await harness.bridge.close();
    expect(adapter.sent.some((item) => item.text === 'Hello from the session' && item.code === 'reply')).toBe(true);
    expect(adapter.sent.some((item) => item.text.includes('go look'))).toBe(false);
  });

  it('routes Telegram topics to separate sessions and pauses only the selected binding', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const routed: { sessionId: string; promptId: string }[] = [];
    const harness = bridgeFor(adapter, ports({
      submit: async ({ sessionId, promptId }) => {
        routed.push({ sessionId, promptId });
        return { duplicate: false, promptId, turnId: 3, deliveryState: 'pending' };
      },
    }));
    const first = { ...identity, topicId: '101' };
    const second = { ...identity, topicId: '202' };
    try {
      await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
      await harness.bridge.setListening('inst', true);
      await adapter.emit({ eventId: '1', cursor: 1, identity: first, kind: 'text', text: 'first topic' });
      await adapter.emit({ eventId: '2', cursor: 2, identity: second, kind: 'text', text: 'second topic' });
      const discovered = await harness.bridge.snapshot();
      expect(discovered.discoveries).toHaveLength(2);
      await harness.bridge.confirm(discovered.discoveries.find((item) => item.identity.topic_id === '101')!.id, { target: { kind: 'session', session_id: 'sess' } });
      await harness.bridge.confirm(discovered.discoveries.find((item) => item.identity.topic_id === '202')!.id, { target: { kind: 'session', session_id: 'home' } });
      const bound = await harness.bridge.snapshot();
      expect(bound.bindings).toHaveLength(2);
      expect(bound.bindings).toEqual(expect.arrayContaining([
        expect.objectContaining({ session_id: 'sess', identity: expect.objectContaining({ chat_id: 'c1', sender_id: 'u1', topic_id: '101' }) }),
        expect.objectContaining({ session_id: 'home', identity: expect.objectContaining({ chat_id: 'c1', sender_id: 'u1', topic_id: '202' }) }),
      ]));
      await adapter.emit({ eventId: '3', cursor: 3, identity: first, kind: 'text', text: 'route first' });
      await adapter.emit({ eventId: '4', cursor: 4, identity: second, kind: 'text', text: 'route second' });
      expect(routed).toEqual([{ sessionId: 'sess', promptId: 'im:inst:3' }, { sessionId: 'home', promptId: 'im:inst:4' }]);
      const paused = bound.bindings.find((item) => item.identity.topic_id === '101')!;
      await harness.bridge.updateBinding(paused.id, { sessionEnabled: false });
      await adapter.emit({ eventId: '5', cursor: 5, identity: first, kind: 'text', text: 'paused topic' });
      await adapter.emit({ eventId: '6', cursor: 6, identity: second, kind: 'text', text: 'still active' });
      expect(routed).toEqual([
        { sessionId: 'sess', promptId: 'im:inst:3' },
        { sessionId: 'home', promptId: 'im:inst:4' },
        { sessionId: 'home', promptId: 'im:inst:6' },
      ]);
      const after = await harness.bridge.snapshot();
      expect(after.instances[0]?.listening).toBe(true);
      expect(after.bindings.find((item) => item.identity.topic_id === '202')).toEqual(bound.bindings.find((item) => item.identity.topic_id === '202'));
    } finally {
      await harness.bridge.close();
    }
  });

  it('binds a persona-less session and preserves explicit direction switches on reconfirmation', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    let homes = 0;
    const harness = bridgeFor(adapter, ports({
      listPersonas: async () => [],
      listSessions: async () => [{ id: 'sess', title: 'No persona' }],
      ensureHome: async () => { homes += 1; return { homeSessionId: 'home' }; },
    }));
    try {
      await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
      await harness.bridge.setListening('inst', true);
      await adapter.emit({ eventId: '1', identity, kind: 'text', text: 'bind' });
      const discovery = (await harness.bridge.snapshot()).discoveries[0]!;
      await harness.bridge.confirm(discovery.id, { target: { kind: 'session', session_id: 'sess' }, input_enabled: false, output_enabled: false });
      expect(homes).toBe(0);
      expect((await harness.bridge.snapshot()).bindings[0]).toMatchObject({ session_id: 'sess', input_enabled: false, output_enabled: false });
      await adapter.emit({ eventId: '2', identity, kind: 'text', text: 'input is off' });
      expect(harness.submitted).toHaveLength(0);
      const reboundDiscovery = (await harness.bridge.snapshot()).discoveries[0]!;
      await harness.bridge.confirm(reboundDiscovery.id, { target: { kind: 'session', session_id: 'sess' } });
      const restored = (await harness.bridge.snapshot()).bindings[0]!;
      expect(restored).toMatchObject({ session_id: 'sess', input_enabled: false, output_enabled: false });
      await harness.bridge.updateBinding(restored.id, { inputEnabled: true, outputEnabled: false });
      await adapter.emit({ eventId: '3', identity, kind: 'text', text: 'input is on' });
      expect(harness.submitted).toHaveLength(1);
      expect((await harness.bridge.channelViews('sess')).find((channel) => channel.kind === 'im')).toMatchObject({ enabled: false });
      const internalOnly = await harness.bridge.sendUserMessage({ sessionId: 'sess', toolCallId: 'direction-check', text: 'internal only', attachments: [] });
      expect(internalOnly.channels?.map((channel) => channel.channelId)).toEqual(['internal']);
    } finally { await harness.bridge.close(); }
  });

  it('retains orphan bindings without manufacturing a persona home', async () => {
    let homes = 0;
    const raw = JSON.stringify({
      policy: { allowed: true, defaultEnabled: true },
      instances: [{ id: 'inst', providerKind: 'telegram', listening: false, virtual: false, accountId: '42' }],
      discoveries: [],
      bindings: [
        { id: 'dead', providerInstanceId: 'inst', providerKind: 'telegram', accountId: '42', identity, sessionId: 'gone', enabled: true, busy: 'queue', reply: 'final', mobileInteractions: true },
        { id: 'missing', providerInstanceId: 'inst', providerKind: 'telegram', accountId: '42', identity: { ...identity, topicId: 'missing' }, enabled: true, busy: 'queue', reply: 'final', mobileInteractions: true },
      ],
      strangers: [], seen: [], tickets: [], selections: {}, awaiting: {}, voiceFallbacks: 0, cursors: {}, notices: [], questionAnswers: {}, answeredQuestions: {}, replies: [], outbox: [],
    });
    const sessionPorts = ports({ ensureHome: async () => { homes += 1; return { homeSessionId: 'home' }; } }, raw);
    const bridge = new ImSessionBridge({ ports: sessionPorts.ports, factories: [], now: () => 1_700_000_000_000 });
    try {
      const snapshot = await bridge.snapshot();
      expect(snapshot.bindings).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'dead', session_id: 'gone', pending_reanchor: true })]));
      const missing = snapshot.bindings.find((item) => item.id === 'missing');
      expect(missing).toMatchObject({ id: 'missing', pending_reanchor: true });
      expect(missing?.session_id).toBeUndefined();
      expect(homes).toBe(0);
    } finally { await bridge.close(); }
  });

  it('keeps a stranger and a disabled binding off the model', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const harness = bridgeFor(adapter);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await adapter.emit({ eventId: '1', cursor: 1, identity, kind: 'text', text: 'hello' });
    const snap = await harness.bridge.snapshot();
    await harness.bridge.confirm(snap.discoveries[0]!.id, { target: { kind: 'session', session_id: 'sess' } });
    await adapter.emit({ eventId: '2', cursor: 2, identity: other, kind: 'text', text: 'nope' });
    const bound = (await harness.bridge.snapshot()).bindings[0]!;
    await harness.bridge.updateBinding(bound.id, { enabled: false });
    await adapter.emit({ eventId: '3', cursor: 3, identity, kind: 'text', text: 'again' });
    expect(harness.submitted).toEqual([]);
    const after = await harness.bridge.snapshot();
    expect(after.strangers[0]?.count).toBe(1);
    expect(after.discoveries.some((item) => item.preview === 'again')).toBe(true);
  });

  it('confirms a paused chat back onto its existing binding', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const harness = bridgeFor(adapter);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await adapter.emit({ eventId: '1', cursor: 1, identity, kind: 'text', text: 'hello' });
    const snap = await harness.bridge.snapshot();
    await harness.bridge.confirm(snap.discoveries[0]!.id, { target: { kind: 'session', session_id: 'sess' } });
    const bound = (await harness.bridge.snapshot()).bindings[0]!;
    await harness.bridge.updateBinding(bound.id, { sessionEnabled: false });
    await adapter.emit({ eventId: '2', cursor: 2, identity, kind: 'text', text: 'again' });
    const paused = await harness.bridge.snapshot();
    const discovery = paused.discoveries.find((item) => item.preview === 'again');
    expect(discovery).toBeDefined();
    const beforeConflict = await harness.bridge.snapshot();
    await expect(harness.bridge.confirm(discovery!.id, { target: { kind: 'session', session_id: 'home' }, busy: 'steer', reply: 'final' })).rejects.toMatchObject({ message: 'im_identity_already_bound', details: expect.objectContaining({ previous_session_id: 'sess', target_session_id: 'home' }) });
    expect(await harness.bridge.snapshot()).toEqual(beforeConflict);
    await harness.bridge.confirm(discovery!.id, { target: { kind: 'session', session_id: 'home' }, busy: 'steer', reply: 'final', rebind: true });
    const restored = await harness.bridge.snapshot();
    expect(restored.bindings).toHaveLength(1);
    expect(restored.bindings[0]).toMatchObject({ id: bound.id, session_id: 'home', busy: 'steer', enabled: true });
    expect(restored.bindings[0]?.session_enabled).toBe(false);
    await adapter.emit({ eventId: '3', cursor: 3, identity, kind: 'text', text: 'still paused' });
    expect(harness.submitted).toEqual([]);
    await harness.bridge.updateBinding(bound.id, { sessionEnabled: true });
    await adapter.emit({ eventId: '4', cursor: 4, identity, kind: 'text', text: 'explicitly resumed' });
    expect(harness.submitted.map((item) => item.promptId)).toEqual(['im:inst:4']);
  });

  it('requires explicit rebind before changing a binding session and preserves rejected state', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const harness = bridgeFor(adapter);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await adapter.emit({ eventId: '1', cursor: 1, identity, kind: 'text', text: 'hello' });
    await harness.bridge.confirm((await harness.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'persona', persona_id: 'ada' } });
    const bound = (await harness.bridge.snapshot()).bindings[0]!;
    const beforeRejectedMutations = harness.saveCount.value;
    await expect(harness.bridge.updateBinding(bound.id, { sessionId: 'unknown', enabled: false })).rejects.toThrow('unknown_session');
    expect(harness.saveCount.value).toBe(beforeRejectedMutations);
    expect((await harness.bridge.snapshot()).bindings[0]).toEqual(bound);
    await expect(harness.bridge.updateBinding(bound.id, { sessionId: 'sess', enabled: false })).rejects.toMatchObject({ message: 'im_identity_already_bound', details: expect.objectContaining({ previous_session_id: 'home', target_session_id: 'sess' }) });
    expect(harness.saveCount.value).toBe(beforeRejectedMutations);
    expect((await harness.bridge.snapshot()).bindings[0]).toEqual(bound);
    await harness.bridge.updateBinding(bound.id, { sessionId: 'sess', enabled: false, rebind: true });
    const changed = (await harness.bridge.snapshot()).bindings[0]!;
    expect(changed).toMatchObject({ session_id: 'sess', enabled: false });
    expect(changed.persona_id).toBeUndefined();
    await harness.bridge.close();
  });

  it('switches an existing chat to a persona home without adding a binding', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const harness = bridgeFor(adapter);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await adapter.emit({ eventId: '1', cursor: 1, identity, kind: 'text', text: 'hello' });
    await harness.bridge.confirm((await harness.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'session', session_id: 'sess' } });
    const bound = (await harness.bridge.snapshot()).bindings[0]!;
    await harness.bridge.updateBinding(bound.id, { target: { kind: 'persona', persona_id: 'ada' }, rebind: true });
    const changed = await harness.bridge.snapshot();
    expect(changed.bindings).toHaveLength(1);
    expect(changed.bindings[0]).toMatchObject({ id: bound.id, session_id: 'home', persona_id: 'ada' });
    await harness.bridge.close();
  });

  it('answers status, abort, and target without a prompt', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const harness = bridgeFor(adapter);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await adapter.emit({ eventId: '1', cursor: 1, identity, kind: 'text', text: 'hello' });
    const first = (await harness.bridge.snapshot()).discoveries[0]!;
    await harness.bridge.confirm(first.id, { target: { kind: 'persona', persona_id: 'ada' } });
    await adapter.emit({ eventId: '9', cursor: 9, identity: { ...identity, chatId: 'c2' }, kind: 'text', text: 'second' });
    const second = (await harness.bridge.snapshot()).discoveries[0]!;
    await harness.bridge.confirm(second.id, { target: { kind: 'session', session_id: 'sess' } });
    await adapter.emit({ eventId: '3', cursor: 3, identity, kind: 'text', text: ':status' });
    await adapter.emit({ eventId: '4', cursor: 4, identity, kind: 'text', text: ':abort' });
    await adapter.emit({ eventId: '5', cursor: 5, identity, kind: 'text', text: ':target' });
    await adapter.emit({ eventId: '6', cursor: 6, identity, kind: 'text', text: ':target 2' });
    expect(harness.submitted).toEqual([]);
    expect(adapter.sent.some((item) => item.code === 'status' && item.text.includes('Queue: 0'))).toBe(true);
    expect(adapter.sent.some((item) => item.code === 'no_turn')).toBe(true);
    expect(adapter.sent.some((item) => item.code === 'targets' && item.text.includes('home'))).toBe(true);
    const unchanged = (await harness.bridge.snapshot()).bindings.find((item) => item.identity.chat_id === 'c1');
    expect(unchanged?.session_id).toBe('home');
    expect(adapter.sent.some((item) => item.code === 'target_confirmation_required')).toBe(true);
  });

  it('defaults new bindings to immediate delivery while preserving explicit queue and saved settings', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const deliveries: string[] = [];
    let steers = 0;
    const harness = bridgeFor(adapter, ports({
      submit: async (input) => { deliveries.push(input.delivery); return { duplicate: false, promptId: input.promptId, deliveryState: 'queued' }; },
      steer: async () => { steers++; return 'steered'; },
    }));
    try {
      await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
      await harness.bridge.setListening('inst', true);
      await adapter.emit({ eventId: 'discover', identity, kind: 'text', text: 'hello' });
      const binding = (await harness.bridge.confirm((await harness.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'session', session_id: 'sess' } })).bindings[0]!;
      expect(binding.busy).toBe('immediate');
      await adapter.emit({ eventId: 'now', identity, kind: 'text', text: 'now' });
      expect(deliveries).toEqual(['immediate']);
      expect(steers).toBe(1);
      await harness.bridge.updateBinding(binding.id, { busy: 'queue' });
      await adapter.emit({ eventId: 'later', identity, kind: 'text', text: 'later' });
      expect(deliveries).toEqual(['immediate', 'queue']);
      expect(steers).toBe(1);
      expect(adapter.sent.some((item) => item.code === 'queued')).toBe(true);
      expect((await harness.bridge.snapshot()).bindings[0]?.busy).toBe('queue');
    } finally { await harness.bridge.close(); }
  });

  it('runs slash help and known commands locally, rejects unknown slash without a prompt', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const harness = bridgeFor(adapter);
    try {
      await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
      await harness.bridge.setListening('inst', true);
      await adapter.emit({ eventId: 'discover', identity, kind: 'text', text: 'hello' });
      await harness.bridge.confirm((await harness.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'session', session_id: 'sess' } });
      await adapter.emit({ eventId: 'help', identity, kind: 'text', text: '/help' });
      await adapter.emit({ eventId: 'status', identity, kind: 'text', text: '/status' });
      await adapter.emit({ eventId: 'unknown', identity, kind: 'text', text: '/nonexistent' });
      await adapter.emit({ eventId: 'denied', identity: other, kind: 'text', text: '/abort' });
      expect(harness.submitted).toHaveLength(0);
      expect(adapter.sent.find((item) => item.code === 'help')?.text).toContain('/status');
      expect(adapter.sent.some((item) => item.code === 'status')).toBe(true);
      expect(adapter.sent.some((item) => item.code === 'unknown_command')).toBe(true);
    } finally { await harness.bridge.close(); }
  });

  it('keeps current text distinct from a quoted private-chat message', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const submitted: { content: readonly import('@kiki/protocol').MessageContent[]; im?: import('@kiki/protocol').ImMessageMetadata }[] = [];
    const harness = bridgeFor(adapter, ports({ submit: async (input) => {
      submitted.push({ content: input.content, im: input.im });
      return { duplicate: false, promptId: input.promptId, deliveryState: 'pending' };
    } }));
    try {
      await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
      await harness.bridge.setListening('inst', true);
      await adapter.emit({ eventId: 'discover', identity, kind: 'text', text: 'hello' });
      await harness.bridge.confirm((await harness.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'session', session_id: 'sess' } });
      await adapter.emit({ eventId: 'reply', identity, kind: 'text', text: 'Current question', replyToMessageId: 'ref-1', quotedText: 'Earlier fact' });
      expect(submitted[0]?.im?.reply_to_message_id).toBe('ref-1');
      expect(submitted[0]?.content).toEqual([{ type: 'text', text: expect.stringContaining('Earlier fact') }, { type: 'text', text: 'Current question' }]);
      expect(JSON.stringify(submitted[0]?.content)).toContain('not the current message');
    } finally { await harness.bridge.close(); }
  });

  it('edits the same message, then sends a new one when the edit is gone', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    let step = 0;
    const harness = bridgeFor(adapter, ports({
      readVisible: async () => {
        step += 1;
        return step === 1 ? { text: 'Hel', done: false, media: [] } : { text: 'Hello', done: true, media: [] };
      },
    }));
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await adapter.emit({ eventId: '1', cursor: 1, identity, kind: 'text', text: 'hello' });
    await harness.bridge.confirm((await harness.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'persona', persona_id: 'ada' }, reply: 'edit' });
    adapter.failEdit = true;
    await adapter.emit({ eventId: '2', cursor: 2, identity, kind: 'text', text: 'go' });
    await vi.waitFor(() => expect(adapter.sent.some((item) => item.code === 'reply' && item.text === 'Hello')).toBe(true));
    await harness.bridge.close();
    expect(adapter.edits.some((item) => item.text === 'Hel' || item.text === 'Hello')).toBe(true);
    expect(adapter.sent.filter((item) => item.code === 'reply').length).toBeGreaterThan(0);
  });

  it('stops a multi-part reply before admitting any more text or media after close', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    adapter.textLimit = 4;
    const harness = bridgeFor(adapter, ports({ readVisible: async () => ({
      text: 'abcdefghijkl', done: true, media: [{ kind: 'file', name: 'result.txt', mediaType: 'text/plain', bytes: new Uint8Array([1]) }],
    }) }));
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await adapter.emit({ eventId: 'discover', identity, kind: 'text', text: 'hello' });
    await harness.bridge.confirm((await harness.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'session', session_id: 'sess' }, reply: 'final' });
    const original = adapter.sendText.bind(adapter);
    let release = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let signal: AbortSignal | undefined;
    const send = vi.fn(async (message: Parameters<FakeImAdapter['sendText']>[0]) => {
      signal = message.signal;
      await hold;
      return original(message);
    });
    adapter.sendText = send;
    await adapter.emit({ eventId: 'go', identity, kind: 'text', text: 'go' });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await harness.bridge.close();
    expect(signal?.aborted).toBe(true);
    release();
    await hold;
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    expect(adapter.files).toHaveLength(0);
    const persisted = JSON.parse(await harness.ports.load() ?? '{}') as { replies: { open: boolean }[] };
    expect(persisted.replies.map((reply) => reply.open)).toEqual([false]);
  });

  it('sends a full-text file after four segments and falls back to segments', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    adapter.textLimit = 4;
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const harness = bridgeFor(adapter, ports({ readVisible: async () => ({ text, done: true, media: [] }) }));
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await adapter.emit({ eventId: '1', cursor: 1, identity, kind: 'text', text: 'hello' });
    await harness.bridge.confirm((await harness.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'persona', persona_id: 'ada' }, reply: 'final' });
    await adapter.emit({ eventId: '2', cursor: 2, identity, kind: 'text', text: 'go' });
    await vi.waitFor(() => expect(adapter.files).toHaveLength(1));
    await harness.bridge.close();
    expect(new TextDecoder().decode(adapter.files[0]?.bytes)).toBe(text);
    adapter.failFile = true;
    adapter.files.splice(0);
    const second = new FakeImAdapter('telegram', '42');
    second.textLimit = 4;
    second.failFile = true;
    const again = bridgeFor(second, ports({ readVisible: async () => ({ text, done: true, media: [] }) }));
    await again.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await again.bridge.setListening('inst', true);
    await second.emit({ eventId: '1', cursor: 1, identity, kind: 'text', text: 'hello' });
    await again.bridge.confirm((await again.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'persona', persona_id: 'ada' } });
    await second.emit({ eventId: '2', cursor: 2, identity, kind: 'text', text: 'go' });
    await vi.waitFor(() => expect(second.sent.filter((item) => item.code === 'reply').map((item) => item.text).join('')).toBe(text));
    await again.bridge.close();
    const joined = second.sent.filter((item) => item.code === 'reply').map((item) => item.text).join('');
    expect(joined).toBe(text);
  });

  it('resolves approval and question buttons, and rejects expiry, replay, and another session', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const questions: ImPendingQuestion[] = [{ id: 'q1', questionIndex: 0, expiresAt: 1_700_000_000_000 + 1000, questionKey: 'Pick', options: [{ id: 'opt_0_0', label: 'One' }, { id: 'opt_0_1', label: 'Two' }], multi: false, allowOther: true }];
    const approvals: ImPendingApproval[] = [{ id: 'a1', expiresAt: 1_700_000_000_000 + 1000, toolName: 'Bash', action: 'run' }];
    const harness = bridgeFor(adapter, ports({
      listInteractions: async () => ({ approvals, questions }),
      submit: async (input) => ({ duplicate: false, promptId: input.promptId, deliveryState: 'pending' }),
    }));
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await adapter.emit({ eventId: '1', cursor: 1, identity, kind: 'text', text: 'hello' });
    await harness.bridge.confirm((await harness.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'persona', persona_id: 'ada' } });
    await harness.bridge.syncInteractions();
    const approval = adapter.sent.find((item) => item.code === 'approval');
    const question = adapter.sent.find((item) => item.code === 'question');
    expect(approval?.buttons?.map((button) => button.label)).toEqual(['Allow', 'Refuse']);
    await adapter.emit({ eventId: 'c1', cursor: 3, identity, kind: 'callback', callbackData: approval?.buttons?.[0]?.id, callbackQueryId: 'cb', text: '' });
    expect(harness.decisions).toEqual(['approved']);
    await adapter.emit({ eventId: 'c2', cursor: 4, identity, kind: 'callback', callbackData: approval?.buttons?.[0]?.id, callbackQueryId: 'cb2', text: '' });
    expect(adapter.sent.some((item) => item.code === 'resolved')).toBe(true);
    expect(harness.decisions).toEqual(['approved']);
    await adapter.emit({ eventId: 'n1', cursor: 5, identity, kind: 'text', text: '1' });
    expect(harness.answers).toEqual(['single']);
    const otherButton = question?.buttons?.find((button) => button.label === 'Other');
    await adapter.emit({ eventId: 'c3', cursor: 6, identity, kind: 'callback', callbackData: otherButton?.id, callbackQueryId: 'cb3', text: '' });
    await adapter.emit({ eventId: 'n2', cursor: 7, identity, kind: 'text', text: 'custom' });
    expect(harness.answers).toContain('other');
  });

  it('says expired and does not decide when the ticket is past its time', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const harness = bridgeFor(adapter, ports({
      listInteractions: async () => ({ approvals: [{ id: 'old', expiresAt: 1, toolName: 'Bash', action: 'run' }], questions: [] }),
    }));
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await adapter.emit({ eventId: '1', cursor: 1, identity, kind: 'text', text: 'hello' });
    await harness.bridge.confirm((await harness.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'persona', persona_id: 'ada' } });
    await harness.bridge.syncInteractions();
    const button = adapter.sent.find((item) => item.code === 'approval')?.buttons?.[0];
    await adapter.emit({ eventId: '2', cursor: 2, identity, kind: 'callback', callbackData: button?.id, callbackQueryId: 'cb', text: '' });
    expect(adapter.sent.some((item) => item.code === 'expired')).toBe(true);
    expect(harness.decisions).toEqual([]);
  });

  it('does not decide a login approval or a short id from another session', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const harness = bridgeFor(adapter, ports({
      listInteractions: async () => ({ approvals: [{ id: 'ssh', expiresAt: 1_700_000_000_000 + 1000, toolName: 'SSH', action: 'login', ssh: 'login' }], questions: [] }),
      decideApproval: async () => { throw new Error('must_not_decide'); },
    }));
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await adapter.emit({ eventId: '1', cursor: 1, identity, kind: 'text', text: 'hello' });
    await harness.bridge.confirm((await harness.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'persona', persona_id: 'ada' } });
    await harness.bridge.syncInteractions();
    expect(adapter.sent.some((item) => item.code === 'desktop_ssh')).toBe(true);
    expect(adapter.sent.some((item) => item.code === 'approval')).toBe(false);
    const otherAdapter = new FakeImAdapter('telegram', '42');
    const cross = bridgeFor(otherAdapter, ports({
      listInteractions: async () => ({ approvals: [{ id: 'a1', expiresAt: 1_700_000_000_000 + 1000, toolName: 'Bash', action: 'run' }], questions: [] }),
    }));
    await cross.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await cross.bridge.setListening('inst', true);
    await otherAdapter.emit({ eventId: '1', cursor: 1, identity, kind: 'text', text: 'hello' });
    await cross.bridge.confirm((await cross.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'session', session_id: 'sess' } });
    await otherAdapter.emit({ eventId: '2', cursor: 2, identity: { ...identity, chatId: 'c9' }, kind: 'text', text: 'other chat' });
    await cross.bridge.confirm((await cross.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'persona', persona_id: 'ada' } });
    await cross.bridge.syncInteractions();
    const button = otherAdapter.sent.find((item) => item.code === 'approval')?.buttons?.[0];
    await otherAdapter.emit({ eventId: '3', cursor: 3, identity: { ...identity, chatId: 'c9' }, kind: 'callback', callbackData: button?.id ?? 'missing', callbackQueryId: 'cb', text: '' });
    expect(otherAdapter.sent.some((item) => item.code === 'cross_session')).toBe(true);
    expect(cross.decisions).toEqual([]);
  });

  it('keeps an old interaction ticket on its original session after an explicit rebind', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const harness = bridgeFor(adapter, ports({
      listInteractions: async () => ({ approvals: [{ id: 'old-session-approval', expiresAt: 1_700_000_000_000 + 1000, toolName: 'Bash', action: 'run' }], questions: [] }),
      decideApproval: async () => { throw new Error('must_not_decide'); },
    }));
    try {
      await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
      await harness.bridge.setListening('inst', true);
      await adapter.emit({ eventId: 'pair', identity, kind: 'text', text: 'pair' });
      await harness.bridge.confirm((await harness.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'session', session_id: 'sess' } });
      await harness.bridge.syncInteractions();
      const ticket = adapter.sent.find((item) => item.code === 'approval')?.buttons?.[0]?.id;
      const binding = (await harness.bridge.snapshot()).bindings[0]!;
      await harness.bridge.updateBinding(binding.id, { sessionId: 'home', rebind: true });
      await adapter.emit({ eventId: 'late-callback', identity, kind: 'callback', callbackData: ticket, callbackQueryId: 'late-callback-query' });
      expect(harness.decisions).toEqual([]);
      expect(adapter.sent.some((item) => item.code === 'cross_session')).toBe(true);
    } finally { await harness.bridge.close(); }
  });

  it('does not publish a late reply through a newly rebound session', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    let markRead: () => void = () => undefined;
    let releaseRead: () => void = () => undefined;
    const readStarted = new Promise<void>((resolve) => { markRead = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const reads: string[] = [];
    const harness = bridgeFor(adapter, ports({
      readVisible: async (sessionId) => {
        reads.push(sessionId);
        markRead();
        await readGate;
        return { text: 'late old reply', done: true, media: [] };
      },
      submit: async ({ promptId }) => ({ duplicate: false, promptId, turnId: 3, deliveryState: 'pending' }),
    }));
    try {
      await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
      await harness.bridge.setListening('inst', true);
      await adapter.emit({ eventId: 'pair', identity, kind: 'text', text: 'pair' });
      await harness.bridge.confirm((await harness.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'session', session_id: 'sess' } });
      await adapter.emit({ eventId: 'prompt', identity, kind: 'text', text: 'old session prompt' });
      await readStarted;
      const binding = (await harness.bridge.snapshot()).bindings[0]!;
      await harness.bridge.updateBinding(binding.id, { sessionId: 'home', rebind: true });
      releaseRead();
      await harness.bridge.close();
      expect(reads).toEqual(['sess']);
      expect(adapter.sent.some((item) => item.text === 'late old reply')).toBe(false);
    } finally { releaseRead(); await harness.bridge.close(); }
  });

  it('counts a voice file fallback and rejects an oversized file before save', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    adapter.voice = false;
    const harness = bridgeFor(adapter, ports({
      readVisible: async () => ({ text: '', done: true, media: [{ kind: 'audio', name: 'note.wav', mediaType: 'audio/wav', bytes: new Uint8Array([1, 2]) }] }),
    }));
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await adapter.emit({ eventId: '1', cursor: 1, identity, kind: 'text', text: 'hello' });
    await harness.bridge.confirm((await harness.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'persona', persona_id: 'ada' } });
    await adapter.emit({ eventId: '2', cursor: 2, identity, kind: 'audio', media: { name: 'in.wav', mediaType: 'audio/wav', bytes: new Uint8Array([1]) }, text: '' });
    expect(harness.saved).toEqual(['file']);
    await adapter.emit({ eventId: '3', cursor: 3, identity, kind: 'file', tooLarge: true, text: '' });
    expect(adapter.sent.some((item) => item.code === 'rejected')).toBe(true);
    await harness.bridge.close();
    expect(adapter.files.some((item) => item.deliveredAs === 'file')).toBe(true);
    expect((await harness.bridge.snapshot()).voice_fallbacks).toBeGreaterThan(0);
  });

  it('shares one poller and stops it only when the last listener leaves', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const secrets = new Map<string, string>([['a', 'same-token'], ['b', 'same-token']]);
    const base = ports();
    base.ports.credentials.list = () => [...secrets.keys()].map((id) => ({ id, providerId: 'telegram', configured: true }));
    base.ports.credentials.read = (id) => secrets.get(id);
    const bridge = new ImSessionBridge({ ports: base.ports, factories: [fakeAdapterFactory(adapter)], editIntervalMs: 0, wait: () => Promise.resolve() });
    await bridge.setListening('a', true);
    await bridge.setListening('b', true);
    expect(adapter.started).toBe(1);
    const view = await bridge.snapshot();
    expect(view.instances.map((item) => item.adapter).sort()).toEqual(['running', 'shared']);
    await bridge.setListening('a', false);
    expect(adapter.stopped).toBe(0);
    await bridge.setListening('b', false);
    expect(adapter.stopped).toBe(1);
  });

  it('retains failed shared listeners for cleanup retry while closing the other listeners once', async () => {
    class FailingStopAdapter extends FakeImAdapter {
      attempts = 0;
      override async stop(): Promise<void> {
        this.attempts++;
        if (this.attempts === 1) throw new Error('example listener cleanup failed');
        await super.stop();
      }
    }
    const first = new FailingStopAdapter('telegram', 'first');
    const second = new FakeImAdapter('telegram', 'second');
    const secrets = new Map([['a', 'first-token'], ['alias', 'first-token'], ['b', 'second-token']]);
    const base = ports();
    base.ports.credentials.list = () => [...secrets.keys()].map((id) => ({ id, providerId: 'telegram', configured: true }));
    base.ports.credentials.read = (id) => secrets.get(id);
    const bridge = new ImSessionBridge({ ports: base.ports, factories: [{ ...fakeAdapterFactory(first),
      create: ({ credential }) => credential === 'first-token' ? first : second }], editIntervalMs: 0, wait: () => Promise.resolve() });
    try {
      for (const id of secrets.keys()) await bridge.setListening(id, true);
      expect(first.started).toBe(1);
      await expect(bridge.close()).rejects.toMatchObject({ name: 'AggregateError', errors: [expect.objectContaining({ message: 'example listener cleanup failed' })] });
      expect(first.attempts).toBe(1);
      expect(second.stopped).toBe(1);
      await bridge.close();
      expect(first.attempts).toBe(2);
      expect(first.stopped).toBe(1);
      expect(second.stopped).toBe(1);
      await bridge.close();
      expect(first.attempts).toBe(2);
      expect(second.stopped).toBe(1);
    } finally { await bridge.close(); }
  });

  it('reports a webhook without starting the poller', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    adapter.conflict = 'webhook';
    const harness = bridgeFor(adapter);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    expect(adapter.started).toBe(0);
    expect((await harness.bridge.snapshot()).instances[0]?.conflict).toBe('webhook');
  });

  it('does not call deleteWebhook when Telegram already has one', async () => {
    const methods: string[] = [];
    const adapter = createTelegramSessionAdapter({
      platform: 'telegram', instance_id: 'im_hook', token: '123456:abcdefghijklmnopqrstuvwxyz',
      transport: {
        async call(request) {
          methods.push(request.method);
          if (request.method === 'getMe') return { http_status: 200, body: { ok: true, result: { id: 7 } } };
          if (request.method === 'getWebhookInfo') return { http_status: 200, body: { ok: true, result: { url: 'https://example.invalid/hook' } } };
          return { http_status: 200, body: { ok: true, result: [] } };
        },
        async download() { return { ok: false }; },
      },
    }, { async load() { return undefined; }, async save() { return undefined; } });
    await adapter.start({ async admit() { return { decision: 'accepted' }; } });
    expect(adapter.state).toBe('conflict');
    expect(methods).not.toContain('deleteWebhook');
    expect(methods).not.toContain('getUpdates');
    await adapter.stop();
  });

  it('keeps the first acquire id when the same token is asked for again', async () => {
    const transport = {
      async call() { return { http_status: 200, body: { ok: true, result: [] } }; },
      async download() { return { ok: false as const }; },
    };
    const store = { async load() { return undefined; }, async save() { return undefined; } };
    const token = '123456:abcdefghijklmnopqrstuvwxyzAA';
    const first = createTelegramSessionAdapter({ platform: 'telegram', instance_id: 'im_first', token, transport }, store);
    const second = createTelegramSessionAdapter({ platform: 'telegram', instance_id: 'im_second', token, transport }, store);
    expect(second.instance_id).toBe('im_first');
    expect(second).toBe(first);
    await first.stop();
  });

  it('sends every question and falls back when edit, buttons, or files are unavailable', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    adapter.supportsEdit = false;
    adapter.supportsButtons = false;
    adapter.supportsFile = false;
    adapter.badVoiceFormat = true;
    const questions: ImPendingQuestion[] = [
      { id: 'q1', questionIndex: 0, expiresAt: 1_700_000_000_000 + 1000, questionKey: 'Pick', options: [{ id: 'opt_0_0', label: 'One' }], multi: false, allowOther: false },
      { id: 'q1', questionIndex: 1, expiresAt: 1_700_000_000_000 + 1000, questionKey: 'Where', options: [{ id: 'opt_1_0', label: 'Here' }], multi: false, allowOther: false },
    ];
    let releaseDone: () => void = () => undefined;
    const doneGate = new Promise<void>((resolve) => { releaseDone = resolve; });
    let reads = 0;
    const harness = bridgeFor(adapter, ports({
      listInteractions: async () => ({ approvals: [], questions }),
      readVisible: async () => {
        reads += 1;
        if (reads === 1) return { text: 'Hi', done: false, media: [] };
        await doneGate;
        return { text: 'Hello', done: true, media: [{ kind: 'audio' as const, name: 'note.wav', mediaType: 'audio/wav', bytes: new Uint8Array([1, 2]) }] };
      },
    }));
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await adapter.emit({ eventId: '1', cursor: 1, identity, kind: 'text', text: 'hello' });
    await harness.bridge.confirm((await harness.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'persona', persona_id: 'ada' }, reply: 'edit' });
    await harness.bridge.syncInteractions();
    const prompts = adapter.sent.filter((item) => item.code === 'question').map((item) => item.text);
    expect(prompts.some((item) => item.startsWith('Pick'))).toBe(true);
    expect(prompts.some((item) => item.startsWith('Where'))).toBe(true);
    expect(prompts.every((item) => item.includes('Send the number of a choice.'))).toBe(true);
    expect(adapter.sent.some((item) => item.buttons !== undefined && item.buttons.length > 0)).toBe(false);
    await adapter.emit({ eventId: '2', cursor: 2, identity, kind: 'text', text: 'go' });
    releaseDone();
    await vi.waitFor(() => expect(adapter.sent.some((item) => item.code === 'file_unsupported')).toBe(true));
    await harness.bridge.close();
    expect(adapter.edits).toEqual([]);
    expect(adapter.sent.filter((item) => item.code === 'reply').map((item) => item.text)).toEqual(['Hi', 'Hello']);
    expect(adapter.sent.some((item) => item.code === 'file_unsupported')).toBe(true);
    expect((await harness.bridge.snapshot()).voice_fallbacks).toBe(1);
  });
});

it('requires provider instance, account, chat, topic, and sender identity components to match', async () => {
  const credentials = new Map([['first', 'credential-first'], ['second', 'credential-second']]);
  const adapters = new Map<string, FakeImAdapter>();
  const routed: string[] = [];
  const base = ports({ submit: async ({ sessionId, promptId }) => { routed.push(`${sessionId}:${promptId}`); return { duplicate: false, promptId, deliveryState: 'pending' }; } });
  base.ports.credentials.list = () => [...credentials.keys()].map((id) => ({ id, providerId: 'telegram', configured: true }));
  base.ports.credentials.read = (id) => credentials.get(id);
  base.ports.credentials.check = async () => ({ ok: true, accountId: 'changed-account' });
  const bridge = new ImSessionBridge({ ports: base.ports, factories: [{ providerKind: 'telegram', create: ({ instanceId }) => {
    const adapter = new FakeImAdapter('telegram', instanceId === 'first' ? '42' : '99');
    adapters.set(instanceId, adapter);
    return adapter;
  } }], wait: async () => undefined });
  try {
    await bridge.setListening('first', true);
    await bridge.setListening('second', true);
    const first = adapters.get('first')!;
    const second = adapters.get('second')!;
    await first.emit({ eventId: 'pair', identity, kind: 'text', text: 'pair' });
    await bridge.confirm((await bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'session', session_id: 'sess' } });
    await first.emit({ eventId: 'exact', identity, kind: 'text', text: 'exact' });
    await first.emit({ eventId: 'sender', identity: { ...identity, senderId: 'other-sender' }, kind: 'text', text: 'sender mismatch' });
    await first.emit({ eventId: 'topic', identity: { ...identity, topicId: 'other-topic' }, kind: 'text', text: 'topic mismatch' });
    await first.emit({ eventId: 'chat', identity: { ...identity, chatId: 'other-chat' }, kind: 'text', text: 'chat mismatch' });
    await second.emit({ eventId: 'instance', identity, kind: 'text', text: 'instance mismatch' });
    await bridge.check('first');
    await first.emit({ eventId: 'account', identity, kind: 'text', text: 'account mismatch' });
    expect(routed).toEqual(['sess:im:first:exact']);
    const snapshot = await bridge.snapshot();
    expect(snapshot.strangers).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider_instance_id: 'first', identity: expect.objectContaining({ sender_id: 'other-sender' }) }),
      expect.objectContaining({ provider_instance_id: 'first', identity: expect.objectContaining({ sender_id: 'u1', topic_id: '0' }) }),
    ]));
    expect(snapshot.discoveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider_instance_id: 'first', identity: expect.objectContaining({ topic_id: 'other-topic' }) }),
      expect.objectContaining({ provider_instance_id: 'first', identity: expect.objectContaining({ chat_id: 'other-chat' }) }),
      expect.objectContaining({ provider_instance_id: 'second', account_id: '99', identity: expect.objectContaining({ chat_id: 'c1', sender_id: 'u1', topic_id: '0' }) }),
    ]));
  } finally { await bridge.close(); }
});

it('binds notification channels explicitly, borrows only by policy, and respects disabled candidates', async () => {
  const adapter = new FakeImAdapter('telegram', '42');
  const delivered: string[] = [];
  const channel = (id: string, enabled = true): UserMessageChannel => ({
    id, kind: 'notify', enabled, capabilities: [],
    send: async (input) => { delivered.push(`${id}:${input.text}`); return { status: 'delivered' }; },
  });
  const notifications = [channel('notify:mail'), channel('notify:other'), channel('notify:off', false)];
  const base = ports();
  const wired = { ...base, ports: { ...base.ports, notifications: { channels: (sessionId: string) => sessionId === 'sess' ? notifications : [] } } };
  const harness = bridgeFor(adapter, wired);
  try {
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await adapter.emit({ eventId: 'pair', identity, kind: 'text', text: 'pair' });
    await harness.bridge.confirm((await harness.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'session', session_id: 'sess' } });
    expect((await harness.bridge.snapshot()).policy.allow_channel_borrowing).toBe(false);
    const initial = await harness.bridge.channelViews('sess');
    expect(initial).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'notify:mail', kind: 'notify', bound: false, enabled: true }),
      expect.objectContaining({ id: 'notify:other', kind: 'notify', bound: false, enabled: true }),
      expect.objectContaining({ id: 'notify:off', kind: 'notify', bound: false, enabled: false }),
    ]));
    const before = await harness.bridge.sendUserMessage({ sessionId: 'sess', toolCallId: 'notify-before', text: 'bound only', attachments: [] });
    expect(before.channels?.map((item) => item.channelId)).not.toContain('notify:mail');
    await harness.bridge.setNotificationChannel('sess', 'mail', true);
    const bound = await harness.bridge.channelViews('sess');
    expect(bound.find((item) => item.id === 'notify:mail')).toMatchObject({ bound: true, enabled: true });
    const after = await harness.bridge.sendUserMessage({ sessionId: 'sess', toolCallId: 'notify-after', text: 'mail now', attachments: [] });
    expect(after.channels?.map((item) => item.channelId)).toContain('notify:mail');
    expect(delivered).toContain('notify:mail:mail now');
    const borrowingError = await harness.bridge.sendUserMessage({ sessionId: 'sess', toolCallId: 'borrow-off', channel: 'notify:other', text: 'not yet', attachments: [] }).then(() => undefined, (error: unknown) => error);
    expect(borrowingError).toMatchObject({ message: expect.stringContaining('channel_borrowing_disabled'), details: { reason: 'channel_borrowing_disabled', channelId: 'notify:other' } });
    const disabledError = await harness.bridge.sendUserMessage({ sessionId: 'sess', toolCallId: 'disabled-candidate', channel: 'notify:off', text: 'disabled', attachments: [] }).then(() => undefined, (error: unknown) => error);
    expect(disabledError).toMatchObject({ message: expect.stringContaining('channel_disabled'), details: { reason: 'channel_disabled', channelId: 'notify:off' } });
    await harness.bridge.setPolicy({ allowed: true, default_enabled: true, allow_channel_borrowing: true });
    await adapter.emit({ eventId: 'other-binding', identity: { ...identity, chatId: 'other-chat' }, kind: 'text', text: 'other' });
    await harness.bridge.confirm((await harness.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'session', session_id: 'home' } });
    const otherBinding = (await harness.bridge.snapshot()).bindings.find((item) => item.session_id === 'home')!;
    const defaultAfterOther = await harness.bridge.sendUserMessage({ sessionId: 'sess', toolCallId: 'default-other', text: 'bound only', attachments: [] });
    expect(defaultAfterOther.channels?.map((item) => item.channelId)).not.toContain(`im:${otherBinding.id}`);
    await harness.bridge.updateBinding(otherBinding.id, { outputEnabled: false });
    await expect(harness.bridge.sendUserMessage({ sessionId: 'sess', toolCallId: 'other-disabled', channel: `im:${otherBinding.id}`, text: 'other disabled', attachments: [] })).rejects.toThrow('channel_disabled');
    const borrowed = await harness.bridge.sendUserMessage({ sessionId: 'sess', toolCallId: 'borrow-on', channel: 'notify:other', text: 'borrowed', attachments: [] });
    expect(borrowed.channels).toEqual([expect.objectContaining({ channelId: 'notify:other', status: 'delivered', borrowed: true })]);
  } finally { await harness.bridge.close(); }
});

it('lets another session finish while an IM send is blocked and preserves session order and concurrent receipt reuse', async () => {
  const adapter = new FakeImAdapter('telegram', '42');
  const harness = bridgeFor(adapter);
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pending: Promise<unknown>[] = [];
  const attempts: string[] = [];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    for (const [chatId, sessionId] of [['chat-a', 'sess'], ['chat-b', 'home']] as const) {
      await adapter.emit({ eventId: chatId, identity: { ...identity, chatId }, kind: 'text', text: 'pair' });
      await harness.bridge.confirm((await harness.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'session', session_id: sessionId } });
    }
    const bindings = (await harness.bridge.snapshot()).bindings;
    const first = bindings.find((binding) => binding.session_id === 'sess')!;
    const second = bindings.find((binding) => binding.session_id === 'home')!;
    const send = adapter.sendTextParts.bind(adapter);
    adapter.sendTextParts = async (message) => {
      attempts.push(`${message.identity.chatId}:${message.parts.join('')}`);
      if (message.identity.chatId === 'chat-a' && attempts.length === 1) {
        entered();
        await gate;
      }
      return send(message);
    };
    const inputA = { sessionId: 'sess', toolCallId: 'shared-call', channel: `im:${first.id}`, text: 'first', attachments: [] };
    const inputB = { sessionId: 'home', toolCallId: 'shared-call', channel: `im:${second.id}`, text: 'independent', attachments: [] };
    const blocked = harness.bridge.sendUserMessage(inputA);
    pending.push(blocked);
    await started;
    const duplicate = harness.bridge.sendUserMessage(inputA);
    const next = harness.bridge.sendUserMessage({ ...inputA, toolCallId: 'next-call', text: 'next' });
    const independent = harness.bridge.sendUserMessage(inputB);
    pending.push(duplicate, next, independent);
    const independentReceipt = await Promise.race([
      independent,
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('unrelated_session_blocked')), 1000); }),
    ]);
    expect(independentReceipt.channels).toEqual([expect.objectContaining({ channelId: inputB.channel, status: 'delivered' })]);
    expect(attempts).toEqual(['chat-a:first', 'chat-b:independent']);
    release();
    const [firstReceipt, repeatedReceipt] = await Promise.all([blocked, duplicate]);
    expect(repeatedReceipt).toEqual(firstReceipt);
    await next;
    expect(attempts).toEqual(['chat-a:first', 'chat-b:independent', 'chat-a:next']);
    const restored = bridgeFor(new FakeImAdapter('telegram', '42'), harness).bridge;
    try {
      expect(await restored.sendUserMessage(inputA)).toEqual(firstReceipt);
      expect(await restored.sendUserMessage(inputB)).toEqual(independentReceipt);
    } finally { await restored.close(); }
    expect(attempts).toEqual(['chat-a:first', 'chat-b:independent', 'chat-a:next']);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    release();
    await Promise.allSettled(pending);
    await harness.bridge.close();
  }
});

it('serializes receipt snapshot writes across sessions without losing either receipt', async () => {
  const harness = ports();
  const save = harness.ports.save;
  let active = 0;
  let maximum = 0;
  let stored = '';
  harness.ports.save = async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await save(value);
      stored = value;
    } finally { active -= 1; }
  };
  const bridge = bridgeFor(new FakeImAdapter('telegram', '42'), harness).bridge;
  try {
    await Promise.all(['sess', 'home'].map((sessionId) => bridge.sendUserMessage({ sessionId, toolCallId: 'same-call', text: sessionId, attachments: [] })));
    expect(maximum).toBe(1);
    const receipts = (JSON.parse(stored) as { messageReceipts: Record<string, { channels: { internal: { status: string } } }> }).messageReceipts;
    expect(Object.keys(receipts)).toHaveLength(2);
    for (const sessionId of ['sess', 'home']) expect(receipts[JSON.stringify([sessionId, 'same-call'])]?.channels.internal.status).toBe('delivered');
  } finally { await bridge.close(); }
});

it('persists one receipt per requested target and never retries an unknown result', async () => {
  const adapter = new FakeImAdapter('telegram', '42');
  let imAttempts = 0;
  let notifyAttempts = 0;
  const notify: UserMessageChannel = {
    id: 'notify:mail', kind: 'notify', enabled: true, capabilities: [],
    send: async () => { notifyAttempts += 1; return { status: 'delivered' }; },
  };
  const base = ports();
  const wired = { ...base, ports: { ...base.ports, notifications: { channels: () => [notify] } } };
  const harness = bridgeFor(adapter, wired);
  try {
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await adapter.emit({ eventId: 'pair', identity, kind: 'text', text: 'pair' });
    await harness.bridge.confirm((await harness.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'session', session_id: 'sess' } });
    await harness.bridge.setNotificationChannel('sess', 'mail', true);
    const im = (await harness.bridge.channelViews('sess')).find((item) => item.kind === 'im')!;
    adapter.sendTextParts = async () => { imAttempts += 1; throw new Error('timeout'); };
    const input = { sessionId: 'sess', toolCallId: 'per-target', channels: [im.id, 'notify:mail'], text: 'once', attachments: [] } as const;
    const [first, second] = await Promise.all([harness.bridge.sendUserMessage(input), harness.bridge.sendUserMessage(input)]);
    expect(first.channels).toEqual([
      expect.objectContaining({ channelId: im.id, status: 'unknown' }),
      expect.objectContaining({ channelId: 'notify:mail', status: 'delivered' }),
    ]);
    expect(second.channels).toEqual(first.channels);
    const restored = bridgeFor(new FakeImAdapter('telegram', '42'), wired).bridge;
    try {
      const afterRestore = await restored.sendUserMessage(input);
      expect(afterRestore.channels).toEqual(first.channels);
    } finally { await restored.close(); }
    expect(imAttempts).toBe(1);
    expect(notifyAttempts).toBe(1);
  } finally { await harness.bridge.close(); }
});

describe('same-account channels on every platform', () => {
  it.each(['telegram', 'feishu_app', 'onebot_v11'] as const)('%s keeps contacts, groups and topics independent across target changes and removal', async (kind) => {
    const adapter = new FakeImAdapter(kind, 'account');
    const routed: { sessionId: string; promptId: string }[] = [];
    const harness = ports({ submit: async ({ sessionId, promptId }) => {
      routed.push({ sessionId, promptId });
      return { duplicate: false, promptId, deliveryState: 'pending' };
    } });
    harness.ports.credentials.list = () => [{ id: 'inst', providerId: kind, configured: true }];
    harness.ports.credentials.read = () => 'test-credential';
    const bridge = new ImSessionBridge({ ports: harness.ports, factories: [fakeAdapterFactory(adapter)], wait: async () => undefined });
    const channels = [
      { chatId: 'contact-a', senderId: 'sender', topicId: '0' },
      { chatId: 'contact-b', senderId: 'sender', topicId: '0' },
      { chatId: 'group-a', senderId: 'sender', topicId: '0', chatKind: 'group' as const },
      { chatId: 'group-a', senderId: 'sender', topicId: 'topic-a', chatKind: 'group' as const },
      { chatId: 'channel-b', senderId: 'sender', topicId: 'topic-a', chatKind: 'group' as const },
    ];
    try {
      await bridge.setListening('inst', true);
      for (const [index, identity] of channels.entries()) await adapter.emit({ eventId: `discover-${index}`, identity, kind: 'text', text: 'pair' });
      const discovered = await bridge.snapshot();
      expect(discovered.discoveries).toHaveLength(channels.length);
      for (const [index, item] of discovered.discoveries.entries()) await bridge.confirm(item.id, { target: index % 2 === 0 ? { kind: 'persona', persona_id: 'ada' } : { kind: 'session', session_id: 'sess' } });
      const bound = (await bridge.snapshot()).bindings;
      expect(new Set(bound.map((item) => item.id)).size).toBe(channels.length);
      for (const [index, identity] of channels.entries()) await adapter.emit({ eventId: `route-${index}`, identity, kind: 'text', text: 'route' });
      expect(routed.map((item) => item.sessionId)).toEqual(['home', 'sess', 'home', 'sess', 'home']);
      await bridge.updateBinding(bound[0]!.id, { enabled: false });
      await bridge.updateBinding(bound[0]!.id, { target: { kind: 'session', session_id: 'sess' }, rebind: true });
      await bridge.removeBinding(bound[1]!.id);
      await adapter.emit({ eventId: 'paused', identity: channels[0]!, kind: 'text', text: 'paused' });
      await adapter.emit({ eventId: 'removed', identity: channels[1]!, kind: 'text', text: 'removed' });
      await adapter.emit({ eventId: 'untrusted', identity: { ...channels[2]!, senderId: 'stranger' }, kind: 'text', text: 'untrusted' });
      await adapter.emit({ eventId: 'active', identity: channels[3]!, kind: 'text', text: 'active' });
      expect(routed).toHaveLength(6);
      expect(routed.at(-1)).toEqual({ sessionId: 'sess', promptId: 'im:inst:active' });
      const after = await bridge.snapshot();
      expect(after.bindings.find((item) => item.id === bound[0]!.id)).toMatchObject({ enabled: false, session_id: 'sess' });
      expect(after.bindings.find((item) => item.id === bound[3]!.id)).toEqual(bound[3]);
      expect(after.strangers).toHaveLength(1);
      expect(adapter.started).toBe(1);
      expect(adapter.stopped).toBe(0);
      expect(after.instances[0]?.listening).toBe(true);
    } finally { await bridge.close(); }
  });
});

it('keeps WeChat contacts separate and refuses unsupported group confirmation before resolving a target', async () => {
  const adapter = new FakeImAdapter('wechat_bridge', 'account');
  const routed: string[] = [];
  let homes = 0;
  const harness = ports({
    ensureHome: async () => { homes += 1; return { homeSessionId: 'home' }; },
    submit: async ({ sessionId, promptId }) => { routed.push(sessionId); return { duplicate: false, promptId, deliveryState: 'pending' }; },
  });
  harness.ports.credentials.list = () => [{ id: 'inst', providerId: 'wechat_bridge', configured: true }];
  harness.ports.credentials.read = () => 'test-credential';
  const bridge = new ImSessionBridge({ ports: harness.ports, factories: [fakeAdapterFactory(adapter)], wait: async () => undefined });
  const contacts = [{ chatId: 'contact-a', senderId: 'contact-a', topicId: '0' }, { chatId: 'contact-b', senderId: 'contact-b', topicId: '0' }];
  try {
    await bridge.setListening('inst', true);
    for (const [index, identity] of contacts.entries()) await adapter.emit({ eventId: `discover-${index}`, identity, kind: 'text', text: 'pair' });
    for (const [index, discovery] of (await bridge.snapshot()).discoveries.entries()) await bridge.confirm(discovery.id, { target: index === 0 ? { kind: 'persona', persona_id: 'ada' } : { kind: 'session', session_id: 'sess' } });
    for (const [index, identity] of contacts.entries()) await adapter.emit({ eventId: `route-${index}`, identity, kind: 'text', text: 'route' });
    expect(routed).toEqual(['home', 'sess']);
    const before = await bridge.snapshot();
    const resolved = homes;
    for (const [index, identity] of [{ chatId: 'sender', senderId: 'sender', topicId: 'group', chatKind: 'group' as const }, { chatId: 'group-zero', senderId: 'sender', topicId: '0', chatKind: 'group' as const }].entries()) {
      await adapter.emit({ eventId: `group-${index}`, identity, kind: 'text', text: 'group' });
      const discovery = (await bridge.snapshot()).discoveries.find((item) => item.identity.chat_id === identity.chatId)!;
      expect(discovery.identity.chat_kind).toBe('group');
      await expect(bridge.confirm(discovery.id, { target: { kind: 'persona', persona_id: 'ada' } })).rejects.toThrow('unsupported_wechat_group');
      expect((await bridge.snapshot()).discoveries.map((item) => item.id)).toContain(discovery.id);
    }
    const after = await bridge.snapshot();
    expect(homes).toBe(resolved);
    expect(after.bindings).toEqual(before.bindings);
    expect(routed).toEqual(['home', 'sess']);
    expect(adapter.started).toBe(1);
  } finally { await bridge.close(); }
});

it('retains the canonical binding and shared membership when an alias retries a stopped poller', async () => {
  class TerminalAdapter extends FakeImAdapter {
    phase: 'running' | 'stopped' = 'running';
    constructor(readonly canonicalInstanceId: string) { super('telegram', '42'); }
    connectionPhase() { return this.phase; }
    override async stop() { this.phase = 'stopped'; await super.stop(); }
  }
  const base = ports();
  base.ports.credentials.list = () => ['a', 'b'].map((id) => ({ id, providerId: 'telegram', configured: true }));
  base.ports.credentials.read = () => 'same-token';
  const adapters: TerminalAdapter[] = [];
  const bridge = new ImSessionBridge({ ports: base.ports, factories: [{ providerKind: 'telegram', create: ({ instanceId }) => {
    const adapter = new TerminalAdapter(instanceId); adapters.push(adapter); return adapter;
  } }], wait: async () => undefined });
  try {
    await bridge.setListening('a', true);
    await bridge.setListening('b', true);
    await adapters[0]!.emit({ eventId: 'pair', identity, kind: 'text', text: 'pair' });
    await bridge.confirm((await bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'session', session_id: 'sess' } });
    const before = (await bridge.snapshot()).bindings;
    adapters[0]!.phase = 'stopped';
    await bridge.setListening('b', true);
    expect(adapters).toHaveLength(2);
    expect(adapters[1]!.canonicalInstanceId).toBe('a');
    expect((await bridge.snapshot()).bindings).toEqual(before);
    await adapters[1]!.emit({ eventId: 'route', identity, kind: 'text', text: 'route' });
    expect(base.submitted.map((item) => item.promptId)).toEqual(['im:a:route']);
    await bridge.setListening('b', false);
    expect(adapters[1]!.stopped).toBe(0);
    await bridge.setListening('a', false);
    expect(adapters[1]!.stopped).toBe(1);
  } finally { await bridge.close(); }
});


describe('credential changes in a shared listener group', () => {
  class CredentialAdapter extends FakeImAdapter {
    phase: 'starting' | 'running' | 'auth_expired' | 'stopped' = 'running';
    late: Parameters<FakeImAdapter['start']>[0] | undefined;
    hold = false;
    complete: (() => void) | undefined;
    constructor(readonly canonicalInstanceId: string, readonly credential: string) { super('telegram', credential); }
    override start(listener: Parameters<FakeImAdapter['start']>[0]) {
      this.phase = 'running';
      this.late = listener;
      const started = super.start(listener);
      if (!this.hold) return started;
      this.phase = 'starting';
      return new Promise<{ accountId: string }>((resolve) => { this.complete = () => { this.phase = 'running'; resolve({ accountId: this.accountId }); }; });
    }
    override async stop() { this.complete?.(); this.phase = 'stopped'; await super.stop(); }
    connectionPhase() { return this.phase; }
  }

  function shared(holdFirst = false) {
    const credentials = new Map([['a', 'T1'], ['b', 'T1']]);
    const base = ports();
    base.ports.credentials.list = () => [...credentials.keys()].map((id) => ({ id, providerId: 'telegram', configured: true }));
    base.ports.credentials.read = (id) => credentials.get(id);
    const adapters: CredentialAdapter[] = [];
    const bridge = new ImSessionBridge({ ports: base.ports, factories: [{ providerKind: 'telegram', create: ({ instanceId, credential }) => {
      const adapter = new CredentialAdapter(instanceId, credential);
      adapter.hold = holdFirst && adapters.length === 0;
      adapters.push(adapter);
      return adapter;
    } }], wait: async () => undefined });
    return { bridge, credentials, adapters, ...base };
  }

  it.each([['a', false], ['a', true], ['b', false]] as const)('starts the new credential for %s (check=%s) and keeps the other member on the old account until its last stop', async (changed, check) => {
    const held = shared();
    const remaining = changed === 'a' ? 'b' : 'a';
    try {
      await held.bridge.setListening('a', true);
      await held.bridge.setListening('b', true);
      const old = held.adapters[0]!;
      await old.emit({ eventId: 'pair', identity, kind: 'text', text: 'pair' });
      await held.bridge.confirm((await held.bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'session', session_id: 'sess' } });
      held.ports.sessions.listInteractions = async () => ({ approvals: [{ id: 'rotation-approval', expiresAt: Date.now() + 100_000, toolName: 'Bash', action: 'run' }], questions: [] });
      await held.bridge.syncInteractions();
      const allow = old.sent.find((message) => message.code === 'approval')!.buttons![0]!.id;
      held.credentials.set(changed, 'T2');
      if (check) {
        held.ports.credentials.check = async () => ({ ok: true, accountId: 'T2' });
        await held.bridge.check(changed);
      }
      await held.bridge.setListening(changed, true);
      expect(held.adapters.map((adapter) => [adapter.credential, adapter.started])).toEqual([['T1', 1], ['T2', 1]]);
      expect(old.stopped).toBe(0);
      const snapshot = await held.bridge.snapshot();
      expect(snapshot.instances.find((item) => item.id === changed)).toMatchObject({ account_id: 'T2', adapter: 'running' });
      expect(snapshot.instances.find((item) => item.id === remaining)).toMatchObject({ account_id: 'T1', adapter: 'running' });
      expect(snapshot.bindings[0]).toMatchObject({ provider_instance_id: remaining, account_id: 'T1', enabled: true });
      await old.emit({ eventId: 'approve-after-reanchor', identity, kind: 'callback', callbackData: allow, callbackQueryId: 'rotation-callback' });
      expect(held.decisions).toEqual(['approved']);
      await old.emit({ eventId: 'old-account', identity, kind: 'text', text: 'route old' });
      const next = held.adapters[1]!;
      await next.emit({ eventId: 'new-discovery', identity, kind: 'text', text: 'pair new account' });
      expect(held.submitted.map((item) => item.promptId)).toEqual([`im:${remaining}:old-account`]);
      const discovery = (await held.bridge.snapshot()).discoveries.find((item) => item.provider_instance_id === changed)!;
      expect(discovery.account_id).toBe('T2');
      await held.bridge.confirm(discovery.id, { target: { kind: 'session', session_id: 'home' } });
      await next.emit({ eventId: 'new-account', identity, kind: 'text', text: 'route new' });
      expect(held.submitted.map((item) => item.promptId)).toEqual([`im:${remaining}:old-account`, `im:${changed}:new-account`]);
      await held.bridge.setListening(changed, false);
      expect(next.stopped).toBe(1);
      expect(old.stopped).toBe(0);
      await expect(next.late!({ eventId: 'late-new', identity, kind: 'text', text: 'late' })).rejects.toThrow('im_not_ready');
      await old.emit({ eventId: 'still-old', identity, kind: 'text', text: 'still live' });
      await held.bridge.setListening(remaining, false);
      expect(old.stopped).toBe(1);
      await expect(old.late!({ eventId: 'late-old', identity, kind: 'text', text: 'late' })).rejects.toThrow('im_not_ready');
    } finally { await held.bridge.close(); }
  });

  it.each([false, true])('keeps the old group independent when its canonical member changes while held=%s', async (pending) => {
    const held = shared(pending);
    try {
      await held.bridge.setListening('a', true);
      await held.bridge.setListening('b', true);
      const old = held.adapters[0]!;
      if (!pending) await held.bridge.setListening('a', false);
      held.credentials.set('a', 'T2');
      await held.bridge.setListening('a', true);
      expect(old.stopped).toBe(0);
      expect(held.adapters[1]).toMatchObject({ credential: 'T2', started: 1 });
      if (pending) {
        await expect(old.late!({ eventId: 'too-early', identity, kind: 'text', text: 'defer' })).rejects.toThrow('im_not_ready');
        old.complete!();
        for (let attempt = 0; attempt < 20 && (await held.bridge.snapshot()).instances.find((item) => item.id === 'b')?.adapter !== 'running'; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      await old.emit({ eventId: 'old-discovery', identity, kind: 'text', text: 'pair old' });
      const discovery = (await held.bridge.snapshot()).discoveries[0]!;
      expect(discovery).toMatchObject({ provider_instance_id: 'b', account_id: 'T1' });
      expect((await held.bridge.snapshot()).instances.find((item) => item.id === 'a')).toMatchObject({ account_id: 'T2', adapter: 'running' });
      await held.bridge.setListening('b', false);
      expect(old.stopped).toBe(1);
      expect(held.adapters[1]!.stopped).toBe(0);
    } finally { await held.bridge.close(); }
  });

  it.each(['1', 'custom answer'])('retains answered-question dedup after joining and reanchoring an old group (first answer=%s)', async (firstAnswer) => {
    const credentials = new Map([['a', 'T1'], ['b', 'T1']]);
    const answers: { questionIndex?: number; kind: string }[] = [];
    const questions: ImPendingQuestion[] = [0, 1].map((questionIndex) => ({ id: 'q', questionIndex, expiresAt: Date.now() + 100_000, questionKey: `Question ${questionIndex}`, options: [{ id: 'red', label: 'Red' }, { id: 'blue', label: 'Blue' }], multi: false, allowOther: true }));
    const base = ports({
      listInteractions: async () => ({ approvals: [], questions }),
      answerQuestion: async ({ response }) => { answers.push(response); return 'answered'; },
    });
    const aKey = `a:${identity.chatId}:${identity.senderId}:${identity.topicId}`;
    const bKey = `b:${identity.chatId}:${identity.senderId}:${identity.topicId}`;
    let persisted = JSON.stringify({ answeredQuestions: { [aKey]: ['target:0', 'shared:0'], [bKey]: ['source:0', 'shared:0'] } });
    base.ports.load = async () => persisted;
    base.ports.save = async (value) => { persisted = value; };
    base.ports.credentials.list = () => [...credentials.keys()].map((id) => ({ id, providerId: 'telegram', configured: true }));
    base.ports.credentials.read = (id) => credentials.get(id);
    const adapters: CredentialAdapter[] = [];
    const bridge = new ImSessionBridge({ ports: base.ports, factories: [{ providerKind: 'telegram', create: ({ instanceId, credential }) => {
      const adapter = new CredentialAdapter(instanceId, credential);
      adapters.push(adapter);
      return adapter;
    } }], wait: async () => undefined });
    try {
      await bridge.setListening('a', true);
      const old = adapters[0]!;
      await old.emit({ eventId: 'pair', identity, kind: 'text', text: 'pair' });
      await bridge.confirm((await bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'session', session_id: 'sess' } });
      await bridge.syncInteractions();
      await old.emit({ eventId: 'answer-0', identity, kind: 'text', text: firstAnswer });
      expect(answers).toEqual([expect.objectContaining({ questionIndex: 0, kind: firstAnswer === '1' ? 'single' : 'other' })]);
      await bridge.setListening('b', true);
      credentials.set('a', 'T2');
      await bridge.setListening('a', true);
      expect(old.stopped).toBe(0);
      expect((await bridge.snapshot()).bindings[0]?.provider_instance_id).toBe('b');
      await old.emit({ eventId: 'answer-1', identity, kind: 'text', text: '2' });
      expect(answers.map((answer) => answer.questionIndex)).toEqual([0, 1]);
      const saved = (JSON.parse(persisted) as { answeredQuestions: Record<string, string[]> }).answeredQuestions;
      expect(saved[aKey]).toBeUndefined();
      expect(saved[bKey]).toEqual(['target:0', 'shared:0', 'q:0', 'source:0', 'q:1']);
      expect(base.submitted).toEqual([]);
    } finally { await bridge.close(); }
  });

  it('does not merge changed credentials when retrying a terminal shared group', async () => {
    const held = shared();
    try {
      await held.bridge.setListening('a', true);
      await held.bridge.setListening('b', true);
      held.adapters[0]!.phase = 'auth_expired';
      held.credentials.set('a', 'T2');
      await held.bridge.setListening('b', true);
      expect(held.adapters.map((adapter) => [adapter.credential, adapter.started])).toEqual([['T1', 1], ['T1', 1]]);
      const afterRetry = await held.bridge.snapshot();
      expect(afterRetry.instances.find((item) => item.id === 'a')?.adapter).toBe('stopped');
      expect(afterRetry.instances.find((item) => item.id === 'b')).toMatchObject({ account_id: 'T1', adapter: 'running' });
      await held.bridge.setListening('a', true);
      expect(held.adapters[2]).toMatchObject({ credential: 'T2', started: 1 });
      expect((await held.bridge.snapshot()).instances.find((item) => item.id === 'a')).toMatchObject({ account_id: 'T2', adapter: 'running' });
    } finally { await held.bridge.close(); }
  });
});

function historyHarness(overrides: Partial<ImSessionPorts['sessions']> = {}) {
  const documents = new Map<string, unknown>();
  const base = ports(overrides);
  base.ports = { ...base.ports, history: {
    get: async <T>(key: string) => structuredClone(documents.get(key)) as T | undefined,
    set: async (key, value) => { documents.set(key, structuredClone(value)); },
    delete: async (key) => { documents.delete(key); },
  } };
  const adapter = new FakeImAdapter('telegram', '42');
  const harness = bridgeFor(adapter, base);
  return { ...harness, adapter, documents };
}

const group = { chatId: 'group-1', topicId: 'topic-1', senderId: 'owner', senderName: 'Same name', chatKind: 'group' as const };

async function bindHistoryGroup(harness: ReturnType<typeof historyHarness>, scope: 'chat' | 'topic' | 'sender' = 'topic') {
  await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
  await harness.bridge.setListening('inst', true);
  await harness.adapter.emit({ eventId: 'discover', sourceMessageId: 'discover-message', identity: group, kind: 'text', text: 'bind group' });
  const discovery = (await harness.bridge.snapshot()).discoveries[0]!;
  await harness.bridge.confirm(discovery.id, { target: { kind: 'session', session_id: 'sess' }, binding_scope: scope });
  return (await harness.bridge.snapshot()).bindings[0]!;
}

describe('IM group context vertical flow', () => {
  it('uses real packaged Telegram mentions and message IDs to wake the default group policy', async () => {
    const received: Parameters<ImSessionPorts['sessions']['submit']>[0][] = [];
    const base = ports({ submit: async (input) => { received.push(structuredClone(input)); return { duplicate: false, promptId: input.promptId, deliveryState: 'pending' }; } });
    const documents = new Map<string, unknown>();
    base.ports = { ...base.ports, history: {
      get: async <T>(key: string) => structuredClone(documents.get(key)) as T | undefined,
      set: async (key, value) => { documents.set(key, structuredClone(value)); },
      delete: async (key) => { documents.delete(key); },
    } };
    const updates: unknown[] = [];
    let notify: (() => void) | undefined;
    const accepted = new Map<string, () => void>();
    base.ports.logger.info = (fields) => { const id = (fields as { event_id?: string }).event_id; if (id !== undefined) accepted.get(id)?.(); };
    const raw = createTelegramSessionAdapter({ platform: 'telegram', instance_id: 'inst', token: '314159:abcdefghijklmnopqrstuvwxyz', retry_ms: 0, transport: {
      async call(request, signal) {
        if (request.method === 'getMe') return { http_status: 200, body: { ok: true, result: { id: 42, username: 'ExampleBot' } } };
        if (request.method === 'getWebhookInfo') return { http_status: 200, body: { ok: true, result: { url: '' } } };
        if (request.method === 'sendMessage') return { http_status: 200, body: { ok: true, result: { message_id: 9000 } } };
        if (request.method !== 'getUpdates') throw new Error('unexpected_transport_call');
        if (updates.length === 0) await new Promise<void>((resolve) => {
          const done = () => { signal.removeEventListener('abort', done); notify = undefined; resolve(); };
          notify = done;
          if (signal.aborted) done(); else signal.addEventListener('abort', done, { once: true });
        });
        return { http_status: 200, body: { ok: true, result: updates.splice(0) } };
      },
      async download() { throw new Error('unexpected_download'); },
    } }, { async load() { return undefined; }, async save() {} });
    const bridge = new ImSessionBridge({ ports: base.ports, factories: [{ providerKind: 'telegram', create: () => new HubSessionAdapter(raw) }], wait: async () => undefined });
    const emit = async (updateId: number, messageId: number, text: string, extra: Record<string, unknown> = {}, edit = false) => {
      const done = new Promise<void>((resolve) => { accepted.set(`tg:42:${updateId}`, resolve); });
      updates.push({ update_id: updateId, [edit ? 'edited_message' : 'message']: { message_id: messageId, date: 1_700_000_100, text, chat: { id: -100, type: 'supergroup', title: 'Study room' }, from: { id: 8, first_name: 'Alice', last_name: 'Member' }, message_thread_id: 12, ...extra } });
      notify?.();
      await done;
    };
    try {
      await bridge.paste({ text: '314159:abcdefghijklmnopqrstuvwxyz' });
      await bridge.setListening('inst', true);
      await emit(100, 1100, 'bind');
      await bridge.confirm((await bridge.snapshot()).discoveries[0]!.id, { target: { kind: 'session', session_id: 'sess' }, binding_scope: 'topic' });
      await emit(101, 1101, 'quiet discussion');
      await emit(102, 1101, 'corrected discussion', {}, true);
      await emit(103, 1102, 'self', { from: { id: 42, first_name: 'Example Bot' } });
      expect(received).toHaveLength(0);
      const text = 'Hi 😀 @eXaMpLeBoT summarize';
      await emit(138, 1138, text, { entities: [{ type: 'mention', offset: text.indexOf('@'), length: '@eXaMpLeBoT'.length }], reply_to_message: { message_id: 1101, forum_topic_created: { name: 'Plans' } } });
      expect(received).toHaveLength(1);
      expect(received[0]?.im).toMatchObject({ source_message_id: '1138', timestamp: 1_700_000_100_000, mentioned: true, mention_ids: ['42'], reply_to_message_id: '1101', is_self: false, identity: { chat_id: '-100', sender_id: '8', sender_name: 'Alice Member', chat_title: 'Study room', topic_title: 'Plans' }, context: { messages: [{ source_message_id: '1101', text: 'corrected discussion', operation: 'edit' }] } });
      const exact = await bridge.readMessageHistory('sess', { messageId: '1138' });
      expect(exact.status === 'ok' && exact.messages[0]?.text).toBe(text);
      const wrongId = await bridge.readMessageHistory('sess', { messageId: '138' });
      expect(wrongId.status === 'ok' && wrongId.messages).toEqual([]);
    } finally { await bridge.close(); }
  });

  it('quietly retains members, injects chronological context on mention, and preserves edits/retractions and scope', async () => {
    const received: Parameters<ImSessionPorts['sessions']['submit']>[0][] = [];
    const harness = historyHarness({ submit: async (input) => { received.push(structuredClone(input)); return { duplicate: false, promptId: input.promptId, deliveryState: 'pending' }; } });
    try {
      const binding = await bindHistoryGroup(harness);
      const peer = { ...group, senderId: 'peer', senderName: 'Same name' };
      await harness.adapter.emit({ eventId: 'one-event', sourceMessageId: 'one', identity: group, kind: 'text', text: 'first discussion' });
      await harness.adapter.emit({ eventId: 'two-event', sourceMessageId: 'two', identity: peer, kind: 'text', text: 'second discussion' });
      await harness.adapter.emit({ eventId: 'two-redelivery', sourceMessageId: 'two', identity: peer, kind: 'text', text: 'second discussion' });
      expect(received).toHaveLength(0);
      expect(harness.adapter.sent).toHaveLength(0);
      await harness.adapter.emit({ eventId: 'edit-event', sourceMessageId: 'one', operation: 'edit', identity: group, kind: 'text', text: 'revised discussion' });
      await harness.adapter.emit({ eventId: 'retract-event', sourceMessageId: 'two', operation: 'retract', identity: peer, kind: 'text' });
      await harness.adapter.emit({ eventId: 'trigger', sourceMessageId: 'three', identity: peer, kind: 'text', text: 'what happened?', mentioned: true, mentionIds: ['bot-real'], replyToMessageId: 'one', quotedText: 'revised discussion' });
      expect(received).toHaveLength(1);
      expect(received[0]?.content).toEqual([{ type: 'text', text: 'what happened?' }]);
      expect(received[0]?.im).toMatchObject({ identity: { sender_id: 'peer', sender_name: 'Same name' }, source_message_id: 'three', mentioned: true, context: { order: 'chronological', messages: [
        { source_message_id: 'one', text: 'revised discussion', operation: 'edit', identity: { sender_id: 'owner' } },
        { source_message_id: 'two', text: '', operation: 'retract', identity: { sender_id: 'peer' } },
      ] } });
      const page = await harness.bridge.readMessageHistory('sess', { channel: `im:${binding.id}`, keyword: 'discussion', senderId: 'owner' });
      expect(page.status === 'ok' && page.messages).toHaveLength(1);
      await harness.adapter.emit({ eventId: 'edit-consumed', sourceMessageId: 'one', operation: 'edit', identity: group, kind: 'text', text: 'revision after consumption' });
      await harness.adapter.emit({ eventId: 'wake-after-edit', sourceMessageId: 'wake-after-edit', identity: peer, kind: 'text', text: 'latest changes?', mentioned: true });
      expect(received[1]?.im?.context?.messages).toMatchObject([{ source_message_id: 'one', operation: 'edit', text: 'revision after consumption' }]);
      await harness.adapter.emit({ eventId: 'retract-consumed', sourceMessageId: 'one', operation: 'retract', identity: group, kind: 'text' });
      await harness.adapter.emit({ eventId: 'wake-after-retract', sourceMessageId: 'wake-after-retract', identity: peer, kind: 'text', text: 'latest changes?', mentioned: true });
      expect(received[2]?.im?.context?.messages).toMatchObject([{ source_message_id: 'one', operation: 'retract', text: '' }]);
      await harness.adapter.emit({ eventId: 'unseen-quote', sourceMessageId: 'unseen-quote', identity: peer, kind: 'text', text: 'Does this still hold?', mentioned: true, replyToMessageId: 'external-older', quotedText: 'Earlier external answer' });
      expect(received[3]?.content).toEqual([{ type: 'text', text: expect.stringContaining('Earlier external answer') }, { type: 'text', text: 'Does this still hold?' }]);
      await expect(harness.bridge.readMessageHistory('home', { channel: `im:${binding.id}` })).rejects.toThrow('history_channel_not_admitted');
      await expect(harness.bridge.readMessageHistory('sess', { topicId: 'other-topic' })).rejects.toThrow('history_topic_not_admitted');
      expect(await harness.bridge.readMessageHistory('sess', { source: 'platform' })).toEqual({ status: 'unsupported' });
      await harness.bridge.updateBinding(binding.id, { inputEnabled: false });
      await expect(harness.bridge.readMessageHistory('sess', {})).rejects.toThrow('history_channel_not_admitted');
    } finally { await harness.bridge.close(); }
  });

  it('retains arrivals during admission and freezes an uncertain retry body across new arrivals', async () => {
    const received: Parameters<ImSessionPorts['sessions']['submit']>[0][] = [];
    let fail = true;
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const harness = historyHarness({ submit: async (input) => {
      received.push(structuredClone(input));
      if (input.promptId === 'im:inst:trigger' && fail) { entered(); await releasePromise; fail = false; throw new Error('admission-outcome-unknown'); }
      return { duplicate: false, promptId: input.promptId, deliveryState: 'pending' };
    } });
    try {
      await bindHistoryGroup(harness);
      await harness.adapter.emit({ eventId: 'before', sourceMessageId: 'before', identity: group, kind: 'text', text: 'before wake' });
      const trigger = { eventId: 'trigger', sourceMessageId: 'trigger-message', identity: group, kind: 'text' as const, text: 'wake', mentioned: true };
      const pending = harness.adapter.emit(trigger);
      const failure = expect(pending).rejects.toThrow('admission-outcome-unknown');
      await enteredPromise;
      await harness.adapter.emit({ eventId: 'during', sourceMessageId: 'during', identity: { ...group, senderId: 'peer' }, kind: 'text', text: 'arrived during processing' });
      release();
      await failure;
      await harness.adapter.emit(trigger);
      expect(received[1]).toEqual(received[0]);
      await harness.adapter.emit({ eventId: 'next', sourceMessageId: 'next', identity: group, kind: 'text', text: 'next wake', mentioned: true });
      expect(received[2]?.im?.context?.messages.map((row) => row.source_message_id)).toEqual(['during']);
      const history = await harness.bridge.readMessageHistory('sess', {});
      expect(history.status === 'ok' && history.messages.length).toBe(4);
    } finally { await harness.bridge.close(); }
  });

  it('reuses exact ordered current parts and file IDs after an unknown complete-message submission without saving again', async () => {
    const received: Parameters<ImSessionPorts['sessions']['submit']>[0][] = [];
    let saved = 0;
    const harness = historyHarness({
      saveMedia: async () => [{ type: 'image', source: { kind: 'session_media', file_id: `generated-${++saved}` } }],
      submit: async (input) => {
        received.push(structuredClone(input));
        if (received.length === 1) throw new Error('complete-submission-unknown');
        return { duplicate: true, promptId: input.promptId, deliveryState: 'pending' };
      },
    });
    try {
      await bindHistoryGroup(harness);
      const event = { eventId: 'complete-retry', sourceMessageId: 'complete-source', identity: group, kind: 'message' as const, mentioned: true, parts: [
        { kind: 'text' as const, text: 'first' },
        { kind: 'image' as const, media: { name: 'first.png', mediaType: 'image/png', bytes: new Uint8Array([1]) } },
        { kind: 'audio' as const, text: 'unavailable audio; ASR: hello' },
        { kind: 'image' as const, media: { name: 'second.png', mediaType: 'image/png', bytes: new Uint8Array([2]) } },
      ] };
      await expect(harness.adapter.emit(event)).rejects.toThrow('complete-submission-unknown');
      expect(saved).toBe(2);
      const get = harness.ports.history!.get;
      harness.ports.history!.get = async (key) => { if (key.includes('/admission-')) throw new Error('snapshot-read-failed'); return get(key); };
      await expect(harness.adapter.emit(event)).rejects.toThrow('snapshot-read-failed');
      expect(saved).toBe(2);
      harness.ports.history!.get = get;
      await harness.adapter.emit(event);
      expect(saved).toBe(2);
      expect(received).toHaveLength(2);
      expect(received[1]).toEqual(received[0]);
      expect(received[1]?.content.map((part) => part.type)).toEqual(['text', 'image', 'text', 'image']);
      await harness.adapter.emit(event);
      expect(received).toHaveLength(2);
    } finally { await harness.bridge.close(); }
  });

  it('stops complete-message admission if the listener is withdrawn while saving media', async () => {
    let entered!: () => void;
    let release!: () => void;
    const saving = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    let saved = 0;
    const received: Parameters<ImSessionPorts['sessions']['submit']>[0][] = [];
    const harness = historyHarness({
      saveMedia: async () => { saved++; entered(); await resume; return [{ type: 'image', source: { kind: 'session_media', file_id: 'interrupted' } }]; },
      submit: async (input) => { received.push(input); return { duplicate: false, promptId: input.promptId, deliveryState: 'pending' }; },
    });
    try {
      await bindHistoryGroup(harness);
      const pending = harness.adapter.emit({ eventId: 'complete-interrupted', sourceMessageId: 'interrupted', identity: group, kind: 'message', mentioned: true, parts: [
        { kind: 'text', text: 'do not submit an incomplete message' },
        ...['first', 'second'].map((name) => ({ kind: 'image' as const, media: { name, mediaType: 'image/png', bytes: new Uint8Array([1]) } })),
      ] });
      const failure = expect(pending).rejects.toThrow('IM adapter was withdrawn while preparing input');
      await saving;
      await harness.bridge.setListening('inst', false);
      release();
      await failure;
      expect(saved).toBe(1);
      expect(received).toHaveLength(0);
      await harness.bridge.setListening('inst', true);
      const history = await harness.bridge.readMessageHistory('sess', { messageId: 'interrupted' });
      expect(history.status === 'ok' && history.messages).toEqual([]);
    } finally { release(); await harness.bridge.close(); }
  });

  it('retains one multipart original with full text and canonical media and enforces exact-read scope', async () => {
    const received: Parameters<ImSessionPorts['sessions']['submit']>[0][] = [];
    let mediaIndex = 0;
    const harness = historyHarness({
      saveMedia: async () => [{ type: 'image', source: { kind: 'session_media', file_id: `part-${++mediaIndex}` } }],
      submit: async (input) => { received.push(structuredClone(input)); return { duplicate: false, promptId: input.promptId, deliveryState: 'pending' }; },
    });
    try {
      const binding = await bindHistoryGroup(harness);
      const text = 'a'.repeat(16_384) + 'SOURCE_TAIL';
      const body = { eventId: 'multipart-text', sourceMessageId: 'multipart-source', identity: group, kind: 'text' as const, text };
      await harness.adapter.emit(body);
      for (let index = 0; index < 2; index++) await harness.adapter.emit({ eventId: `multipart-image-${index}`, sourceMessageId: 'multipart-source', identity: group, kind: 'image', media: { name: `part-${index}.png`, mediaType: 'image/png', bytes: new Uint8Array([index]) } });
      await harness.adapter.emit(body);
      expect(received).toHaveLength(0);
      const tail = await harness.bridge.readMessageHistory('sess', { messageId: 'multipart-source', textOffset: 16_384 });
      expect(tail.status === 'ok' && tail.messages[0]).toMatchObject({ text: 'SOURCE_TAIL', original: { message_id: 'multipart-source', text_length: text.length }, media: [{ name: 'part-0.png' }, { name: 'part-1.png' }] });
      expect((await harness.bridge.readMessageHistory('sess', { keyword: 'SOURCE_TAIL' })).status).toBe('ok');
      await harness.adapter.emit({ eventId: 'multipart-trigger', sourceMessageId: 'multipart-source', identity: group, kind: 'text', text: 'summarize', mentioned: true });
      expect(received[0]?.content).toEqual([{ type: 'text', text: `${text}\nsummarize` }, { type: 'image', source: { kind: 'session_media', file_id: 'part-1' } }, { type: 'image', source: { kind: 'session_media', file_id: 'part-2' } }]);
      expect(received[0]?.im?.source_message_id).toBe('multipart-source');
      expect(await harness.bridge.readMessageHistory('sess', { messageId: 'multipart-source', source: 'platform' })).toMatchObject({ status: 'unsupported' });
      await expect(harness.bridge.readMessageHistory('home', { channel: `im:${binding.id}`, messageId: 'multipart-source' })).rejects.toThrow('history_channel_not_admitted');
      await expect(harness.bridge.readMessageHistory('sess', { topicId: 'another-topic', messageId: 'multipart-source' })).rejects.toThrow('history_topic_not_admitted');
      await harness.bridge.updateBinding(binding.id, { bindingScope: 'sender' });
      await expect(harness.bridge.readMessageHistory('sess', { messageId: 'multipart-source', senderId: 'peer' })).rejects.toThrow('history_sender_not_admitted');
    } finally { await harness.bridge.close(); }
  });

  it('migrates an old sender binding explicitly and restores scope and input owners on persistence failure', async () => {
    const harness = historyHarness();
    try {
      const binding = await bindHistoryGroup(harness, 'sender');
      const secondGroup = { ...group, topicId: 'topic-2' };
      await harness.adapter.emit({ eventId: 'other-topic-discover', identity: secondGroup, kind: 'text', text: 'bind other topic' });
      const discovery = (await harness.bridge.snapshot()).discoveries[0]!;
      await harness.bridge.confirm(discovery.id, { target: { kind: 'session', session_id: 'home' } });
      const before = (await harness.bridge.snapshot()).bindings;
      await expect(harness.bridge.updateBinding(binding.id, { bindingScope: 'chat' })).rejects.toThrow();
      expect((await harness.bridge.snapshot()).bindings).toEqual(before);
      const save = harness.ports.save;
      harness.ports.save = async () => { throw new Error('scope-save-failed'); };
      await expect(harness.bridge.updateBinding(binding.id, { bindingScope: 'chat', rebind: true })).rejects.toThrow('scope-save-failed');
      expect((await harness.bridge.snapshot()).bindings).toEqual(before);
      harness.ports.save = save;
      const migrated = await harness.bridge.updateBinding(binding.id, { bindingScope: 'chat', rebind: true });
      expect(migrated.bindings.find((row) => row.id === binding.id)).toMatchObject({ binding_scope: 'chat', group_policy: { wake: 'mention_or_reply' } });
      expect(migrated.bindings.find((row) => row.id !== binding.id)?.input_enabled).toBe(false);
    } finally { await harness.bridge.close(); }
  });

  it('reuses only canonical same-session background images and leaves missing media explicit', async () => {
    const received: Parameters<ImSessionPorts['sessions']['submit']>[0][] = [];
    let mediaIndex = 0;
    const harness = historyHarness({
      saveMedia: async () => [{ type: 'image', source: { kind: 'session_media', file_id: `canonical-image-${++mediaIndex}` } }],
      historyMedia: async (_sessionId, content) => content.filter((part) => part.type === 'image' && part.source.kind === 'session_media' && part.source.file_id === 'canonical-image-1'),
      submit: async (input) => { received.push(structuredClone(input)); return { duplicate: false, promptId: input.promptId, deliveryState: 'pending' }; },
    });
    try {
      await bindHistoryGroup(harness);
      await harness.adapter.emit({ eventId: 'image', sourceMessageId: 'image-message', identity: group, kind: 'image', media: { name: 'photo.png', mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]) } });
      await harness.adapter.emit({ eventId: 'expired-image', sourceMessageId: 'expired-message', identity: group, kind: 'image', media: { name: 'expired.png', mediaType: 'image/png', bytes: new Uint8Array([4, 5]) } });
      expect(received).toHaveLength(0);
      await harness.adapter.emit({ eventId: 'wake-image', sourceMessageId: 'wake-image', identity: group, kind: 'text', text: 'describe previous image', mentioned: true });
      expect(received[0]?.content).toEqual(expect.arrayContaining([{ type: 'image', source: { kind: 'session_media', file_id: 'canonical-image-1' } }]));
      expect(received[0]?.im?.context?.messages[0]?.media).toEqual([{ kind: 'image', name: 'photo.png', media_type: 'image/png', available: true }]);
      expect(received[0]?.im?.context?.messages[1]?.media).toEqual([{ kind: 'image', name: 'expired.png', media_type: 'image/png', available: false }]);
      expect(received[0]?.content).not.toEqual(expect.arrayContaining([{ type: 'image', source: { kind: 'session_media', file_id: 'canonical-image-2' } }]));
    } finally { await harness.bridge.close(); }
  });
});

describe('IM group wake and reply routing', () => {
  it('keeps chat-scoped topics separate, recognizes real sent IDs and never grants a peer command authority', async () => {
    const received: Parameters<ImSessionPorts['sessions']['submit']>[0][] = [];
    let aborts = 0;
    const harness = historyHarness({
      submit: async (input) => { received.push(structuredClone(input)); return { duplicate: false, promptId: input.promptId, deliveryState: 'pending' }; },
      abort: async () => { aborts += 1; return true; },
    });
    try {
      const binding = await bindHistoryGroup(harness, 'chat');
      await harness.adapter.emit({ eventId: 'topic-one', sourceMessageId: 'topic-one', identity: group, kind: 'text', text: 'private to topic one background' });
      const peer = { ...group, topicId: 'topic-2', senderId: 'peer' };
      await harness.adapter.emit({ eventId: 'topic-two', sourceMessageId: 'topic-two', identity: peer, kind: 'text', text: 'topic two discussion' });
      await harness.bridge.updateBinding(binding.id, { groupPolicy: { wake: 'mention_or_reply', prefixes: ['Kiki:'] } });
      await harness.adapter.emit({ eventId: 'prefix', sourceMessageId: 'prefix', identity: peer, kind: 'text', text: 'Kiki: please summarize' });
      expect(received[0]?.im?.context?.messages.map((row) => row.source_message_id)).toEqual(['topic-two']);
      const topicTwo = await harness.bridge.readMessageHistory('sess', { topicId: 'topic-2' });
      expect(topicTwo.status === 'ok' && topicTwo.messages.length).toBe(2);
      await harness.bridge.updateBinding(binding.id, { groupPolicy: { wake: 'manual' } });
      await harness.adapter.emit({ eventId: 'peer-command', sourceMessageId: 'peer-command', identity: peer, kind: 'text', text: ':abort', mentioned: true });
      await harness.adapter.emit({ eventId: 'self', sourceMessageId: 'self', identity: peer, kind: 'text', text: 'self message', isSelf: true, mentioned: true });
      expect(aborts).toBe(0);
      expect(received).toHaveLength(1);
      await harness.bridge.updateBinding(binding.id, { groupPolicy: { wake: 'mention_or_reply' } });
      const sent = await harness.bridge.sendUserMessage({ sessionId: 'sess', toolCallId: 'group-sent', channel: `im:${binding.id}`, text: 'sent by this host', attachments: [] });
      const sentId = sent.channels?.find((channel) => channel.channelId === `im:${binding.id}`)?.messageIds?.[0];
      expect(sentId).toBeTruthy();
      await harness.adapter.emit({ eventId: 'reply-to-host', sourceMessageId: 'reply-to-host', identity: group, kind: 'text', text: 'follow up', replyToMessageId: sentId });
      expect(received).toHaveLength(2);
    } finally { await harness.bridge.close(); }
    expect(harness.adapter.sent.some((message) => message.code === 'reply' && message.identity.topicId === 'topic-2' && message.identity.senderId === 'peer')).toBe(true);
  });

  it('rejects a topic scope when the group has no topic and keeps sender bindings on every message', async () => {
    const received: string[] = [];
    const harness = historyHarness({ submit: async (input) => { received.push(input.promptId); return { duplicate: false, promptId: input.promptId, deliveryState: 'pending' }; } });
    try {
      const binding = await bindHistoryGroup(harness, 'sender');
      expect(binding.binding_scope).toBe('sender');
      expect(binding.group_policy).toBeUndefined();
      expect(binding.persona_id).toBeUndefined();
      await harness.adapter.emit({ eventId: 'plain', identity: group, kind: 'text', text: 'ordinary group message' });
      expect(received).toEqual(['im:inst:plain']);
      const noTopic = { ...group, chatId: 'group-2', topicId: '0' };
      await harness.adapter.emit({ eventId: 'no-topic', identity: noTopic, kind: 'text', text: 'bind the group' });
      const discovery = (await harness.bridge.snapshot()).discoveries[0]!;
      await expect(harness.bridge.confirm(discovery.id, { target: { kind: 'session', session_id: 'home' }, binding_scope: 'topic' })).rejects.toThrow('topic_scope_unavailable');
      expect((await harness.bridge.snapshot()).discoveries.map((item) => item.id)).toContain(discovery.id);
      expect((await harness.bridge.snapshot()).bindings).toHaveLength(1);
      const bound = await harness.bridge.confirm(discovery.id, { target: { kind: 'session', session_id: 'home' }, binding_scope: 'chat' });
      const chat = bound.bindings.find((row) => row.identity.topic_id === '0')!;
      expect(chat).toMatchObject({ session_id: 'home', binding_scope: 'chat', group_policy: { wake: 'mention_or_reply' } });
      expect(chat.persona_id).toBeUndefined();
      await expect(harness.bridge.updateBinding(chat.id, { bindingScope: 'topic' })).rejects.toThrow('topic_scope_unavailable');
      expect((await harness.bridge.snapshot()).bindings.find((row) => row.id === chat.id)?.binding_scope).toBe('chat');
      const before = received.length;
      await harness.adapter.emit({ eventId: 'quiet', identity: { ...noTopic, senderId: 'peer' }, kind: 'text', text: 'quiet member message' });
      expect(received).toHaveLength(before);
      await harness.adapter.emit({ eventId: 'wake', identity: { ...noTopic, senderId: 'peer' }, kind: 'text', text: 'please look', mentioned: true });
      expect(received).toEqual(['im:inst:plain', 'im:inst:wake']);
    } finally { await harness.bridge.close(); }
  });

  it('does not widen a stored no-topic topic binding beyond its sender', async () => {
    const storedIdentity = { chatId: 'g', senderId: 'owner', topicId: '0', chatKind: 'group' as const };
    const raw = JSON.stringify({
      policy: { allowed: true, defaultEnabled: true },
      instances: [{ id: 'inst', providerKind: 'telegram', listening: false, virtual: true, accountId: '42' }],
      discoveries: [],
      bindings: [{ id: 'legacy', providerInstanceId: 'inst', providerKind: 'telegram', accountId: '42', identity: storedIdentity, sessionId: 'sess', enabled: true, busy: 'queue', reply: 'final', mobileInteractions: true, bindingScope: 'topic' }],
      strangers: [], seen: [], tickets: [], selections: {}, awaiting: {}, voiceFallbacks: 0, cursors: {}, notices: [], questionAnswers: {}, answeredQuestions: {}, replies: [], outbox: [],
    });
    const seen: string[] = [];
    const sessionPorts = ports({ submit: async (input) => { seen.push(input.promptId); return { duplicate: false, promptId: input.promptId, deliveryState: 'pending' }; } }, raw);
    sessionPorts.ports.credentials.list = () => [{ id: 'inst', providerId: 'telegram', configured: true }];
    sessionPorts.ports.credentials.read = () => 'credential';
    const adapter = new FakeImAdapter('telegram', '42');
    const bridge = new ImSessionBridge({ ports: sessionPorts.ports, factories: [fakeAdapterFactory(adapter)], now: () => 1_700_000_000_000, wait: async () => undefined });
    try {
      await bridge.setListening('inst', true);
      await adapter.emit({ eventId: 'owner', identity: storedIdentity, kind: 'text', text: 'owner' });
      await adapter.emit({ eventId: 'peer', identity: { ...storedIdentity, senderId: 'peer' }, kind: 'text', text: 'peer' });
      expect(seen).toEqual(['im:inst:owner']);
      const snap = await bridge.snapshot();
      expect(snap.bindings).toHaveLength(1);
      expect(snap.discoveries).toEqual([]);
      expect(snap.strangers.some((item) => item.identity.sender_id === 'peer')).toBe(true);
    } finally { await bridge.close(); }
  });
});
