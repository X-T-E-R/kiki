import { describe, expect, it } from 'vitest';

import { ImSessionBridge } from '../../../src/services/imSession/bridge';
import { FakeImAdapter, fakeAdapterFactory } from '../../../src/services/imSession/fakeAdapter';
import { parseImPaste } from '../../../src/services/imSession/paste';
import type { ImPendingApproval, ImPendingQuestion, ImSessionPorts, ImSubmitResult, ImVisibleReply } from '../../../src/services/imSession/ports';
import { TelegramPollingAdapter } from '../../../src/services/imSession/telegramAdapter';
import type { ImHttpTransport, ImInboundIdentity } from '../../../src/services/imSession/adapter';

const identity: ImInboundIdentity = { chatId: 'c1', senderId: 'u1', topicId: '0', chatTitle: 'Ada', senderName: 'Ada' };
const other: ImInboundIdentity = { chatId: 'c1', senderId: 'u2', topicId: '0' };

function ports(overrides: Partial<ImSessionPorts['sessions']> = {}): { ports: ImSessionPorts; submitted: ImSubmitResult[]; decisions: string[]; answers: string[]; saved: string[] } {
  const secrets = new Map<string, string>();
  const submitted: ImSubmitResult[] = [];
  const decisions: string[] = [];
  const answers: string[] = [];
  const saved: string[] = [];
  let visible: ImVisibleReply = { text: 'Hello from the session', done: true, media: [] };
  let approvals: ImPendingApproval[] = [];
  let questions: ImPendingQuestion[] = [];
  let stored = '';
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
    submitted, decisions, answers, saved,
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

function bridgeFor(adapter: FakeImAdapter, sessionPorts = ports()) {
  const bridge = new ImSessionBridge({
    ports: sessionPorts.ports,
    factories: [fakeAdapterFactory(adapter)],
    editIntervalMs: 0,
    now: () => 1_700_000_000_000,
    wait: () => Promise.resolve(),
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
    const switched = (await harness.bridge.snapshot()).bindings.find((item) => item.identity.chat_id === 'c1');
    expect(switched?.session_id).toBe('sess');
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
    await harness.bridge.close();
    expect(adapter.edits.some((item) => item.text === 'Hel' || item.text === 'Hello')).toBe(true);
    expect(adapter.sent.filter((item) => item.code === 'reply').length).toBeGreaterThan(0);
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
    await again.bridge.close();
    const joined = second.sent.filter((item) => item.code === 'reply').map((item) => item.text).join('');
    expect(joined).toBe(text);
  });

  it('resolves approval and question buttons, and rejects expiry, replay, and another session', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const questions: ImPendingQuestion[] = [{ id: 'q1', expiresAt: 1_700_000_000_000 + 1000, questionKey: 'Pick', options: [{ id: 'opt_0_0', label: 'One' }, { id: 'opt_0_1', label: 'Two' }], multi: false, allowOther: true }];
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
    const transport: ImHttpTransport = {
      async call(method) {
        methods.push(method);
        if (method === 'getMe') return { status: 200, body: { ok: true, result: { id: 7 } } };
        if (method === 'getWebhookInfo') return { status: 200, body: { ok: true, result: { url: 'https://example.invalid/hook' } } };
        return { status: 200, body: { ok: true, result: [] } };
      },
      async download() { return new Uint8Array(); },
    };
    const started = await new TelegramPollingAdapter(transport, 100, 0).start(async () => undefined);
    expect(started.conflict).toBe('webhook');
    expect(methods).not.toContain('deleteWebhook');
    expect(methods).not.toContain('getUpdates');
  });
});
