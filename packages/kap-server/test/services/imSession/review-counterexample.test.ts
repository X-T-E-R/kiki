import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IBotService, IConfigService, ISessionIndex, ISessionInteractionService, ISessionManager, ISessionQuestionService, type Scope } from '@kiki/agent-core-v2';
import { IPluginHostService } from '@kiki/agent-core-v2/app/plugin/pluginHostService';
import type { SessionAdapter, SessionInbound, SessionOutbound, SessionPlatformId, SessionSink } from '@nb-im/core';
import { afterEach, describe, expect, it } from 'vitest';

import type { ImProviderKind } from '@kiki/protocol';
import { ImSessionBridge } from '../../../src/services/imSession/bridge';
import { FakeImAdapter, fakeAdapterFactory } from '../../../src/services/imSession/fakeAdapter';
import { createImSessionHost } from '../../../src/services/imSession/host';
import { HubSessionAdapter } from '../../../src/services/imSession/hubAdapter';
import type { ImAdapterFactory, ImInboundIdentity } from '../../../src/services/imSession/adapter';
import type { ImPendingApproval, ImPendingQuestion, ImQuestionAnswer, ImSessionPorts, ImVisibleReply } from '../../../src/services/imSession/ports';
import { WechatQrLogin } from '../../../src/services/imSession/wechatLogin';
import { NotificationService } from '../../../src/services/notifications/notificationService';

const NOW = 1_700_000_000_000;
const identity: ImInboundIdentity = { chatId: 'c1', senderId: 'u1', topicId: '0' };
const other: ImInboundIdentity = { chatId: 'c2', senderId: 'u2', topicId: '0' };
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'kiki-im-review-'));
  homes.push(home);
  return home;
}

function memoryPorts(kind: ImProviderKind, pending: { approvals: ImPendingApproval[]; questions: ImPendingQuestion[] }) {
  const secrets = new Map<string, string>();
  const submitted: { sessionId: string; promptId: string; text: string }[] = [];
  const answers: ImQuestionAnswer[] = [];
  const decisions: string[] = [];
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
      listSessions: async () => [{ id: 'home', title: 'Home', personaId: 'ada' }, { id: 'sess', title: 'Other', personaId: 'ada' }],
      owns: async (sessionId) => sessionId === 'home' || sessionId === 'sess',
      ensureHome: async () => ({ homeSessionId: 'home' }),
      setHome: async () => undefined,
      activity: async () => ({ busy: false, pending: 'none', queueLength: 0 }),
      submit: async (input) => {
        submitted.push({ sessionId: input.sessionId, promptId: input.promptId, text: input.content.map((part) => part.type === 'text' ? part.text : '').join('') });
        return { duplicate: false, promptId: input.promptId, turnId: 3, deliveryState: 'pending' };
      },
      steer: async () => 'steered',
      abort: async () => false,
      saveMedia: async () => [],
      readVisible: async () => { const next = frames[Math.min(frame, frames.length - 1)]!; frame += 1; return next; },
      listInteractions: async () => pending,
      decideApproval: async (input) => { decisions.push(`${input.interactionId}:${input.decision}`); return 'decided'; },
      decideHostKey: async () => 'decided',
      answerQuestion: async (input) => { answers.push(input.response); return 'answered'; },
    },
    logger: { info() {} },
    load: async () => stored === '' ? undefined : stored,
    save: async (value) => { stored = value; },
  };
  return {
    ports,
    stored: () => stored,
    submitted,
    answers,
    decisions,
    setFrames(next: ImVisibleReply[]) { frames = next; frame = 0; },
  };
}

function bridgeFor(adapter: FakeImAdapter, kind: ImProviderKind, pending: { approvals: ImPendingApproval[]; questions: ImPendingQuestion[] }) {
  const harness = memoryPorts(kind, pending);
  const bridge = new ImSessionBridge({ ports: harness.ports, factories: [fakeAdapterFactory(adapter)], editIntervalMs: 0, now: () => NOW, wait: () => Promise.resolve() });
  return { bridge, ...harness };
}

async function pair(bridge: ImSessionBridge, adapter: FakeImAdapter, who: ImInboundIdentity, session: { kind: 'persona'; persona_id: string } | { kind: 'session'; session_id: string }, eventId: string) {
  await adapter.emit({ eventId, identity: who, kind: 'text', text: 'hello' });
  const discovery = (await bridge.snapshot()).discoveries.find((item) => item.identity.chat_id === who.chatId && item.identity.sender_id === who.senderId);
  if (discovery === undefined) throw new Error('missing_discovery');
  await bridge.confirm(discovery.id, { target: session.kind === 'persona' ? { kind: 'persona', persona_id: session.persona_id } : { kind: 'session', session_id: session.session_id } });
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30 && !check(); attempt += 1) await Promise.resolve();
}

describe('phone bridge restart', () => {
  it('keeps binding ids unique after restart so a rail change hits one session', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const harness = bridgeFor(adapter, 'telegram', { approvals: [], questions: [] });
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await pair(harness.bridge, adapter, identity, { kind: 'persona', persona_id: 'ada' }, 'e1');
    const first = (await harness.bridge.snapshot()).bindings[0]!;
    const restarted = new ImSessionBridge({ ports: harness.ports, factories: [fakeAdapterFactory(adapter)], editIntervalMs: 0, now: () => NOW, wait: () => Promise.resolve() });
    await restarted.setListening('inst', true);
    await pair(restarted, adapter, other, { kind: 'session', session_id: 'sess' }, 'e2');
    const bindings = (await restarted.snapshot()).bindings;
    expect(new Set(bindings.map((item) => item.id)).size).toBe(2);
    expect(bindings.map((item) => item.id)).toContain(first.id);
    await restarted.updateBinding(first.id, { sessionEnabled: false });
    const after = await restarted.snapshot();
    expect(after.bindings.map((item) => ({ session: item.session_id, sessionEnabled: item.session_enabled ?? null }))).toEqual([
      { session: 'home', sessionEnabled: false },
      { session: 'sess', sessionEnabled: null },
    ]);
    await restarted.removeBinding(bindings[1]!.id);
    expect((await restarted.snapshot()).bindings.map((item) => item.session_id)).toEqual(['home']);
    await restarted.close();
  });

  it('keeps a projected ticket across restart and reports an unknown click once', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const pending = { approvals: [{ id: 'a1', expiresAt: NOW + 10_000, toolName: 'Bash', action: 'run' }] as ImPendingApproval[], questions: [] as ImPendingQuestion[] };
    const harness = bridgeFor(adapter, 'telegram', pending);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await pair(harness.bridge, adapter, identity, { kind: 'persona', persona_id: 'ada' }, 'e1');
    await harness.bridge.syncInteractions();
    const button = adapter.sent.find((item) => item.code === 'approval')?.buttons?.[0]?.id;
    expect(button).toBeTruthy();
    const tickets = JSON.parse(harness.stored()).tickets as { interactionId: string; consumed: boolean; action: string }[];
    expect(tickets.map((item) => item.action).sort()).toEqual(['approve', 'reject']);
    expect(tickets.every((item) => item.interactionId === 'a1' && item.consumed === false)).toBe(true);
    const restarted = new ImSessionBridge({ ports: harness.ports, factories: [fakeAdapterFactory(adapter)], editIntervalMs: 0, now: () => NOW, wait: () => Promise.resolve() });
    await restarted.setListening('inst', true);
    await adapter.emit({ eventId: 'click', identity, kind: 'callback', callbackData: button, callbackQueryId: 'cb' });
    expect(harness.decisions).toEqual(['a1:approved']);
    await adapter.emit({ eventId: 'click', identity, kind: 'callback', callbackData: button, callbackQueryId: 'cb2' });
    expect(harness.decisions).toEqual(['a1:approved']);
    await adapter.emit({ eventId: 'again', identity, kind: 'callback', callbackData: button, callbackQueryId: 'cb3' });
    expect(harness.decisions).toEqual(['a1:approved']);
    expect(adapter.sent.some((item) => item.code === 'resolved')).toBe(true);
    await adapter.emit({ eventId: 'missing', identity, kind: 'callback', callbackData: 'no-such-ticket', callbackQueryId: 'cb4' });
    expect(adapter.sent.filter((item) => item.code === 'unknown')).toHaveLength(1);
    await adapter.emit({ eventId: 'missing', identity, kind: 'callback', callbackData: 'no-such-ticket', callbackQueryId: 'cb5' });
    expect(adapter.sent.filter((item) => item.code === 'unknown')).toHaveLength(1);
    expect(harness.decisions).toEqual(['a1:approved']);
    await restarted.close();
  });

  it('does not reuse a consumed ticket id for the next question', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const pending = {
      approvals: [{ id: 'a1', expiresAt: NOW + 10_000, toolName: 'Bash', action: 'run' }] as ImPendingApproval[],
      questions: [] as ImPendingQuestion[],
    };
    const harness = bridgeFor(adapter, 'telegram', pending);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await pair(harness.bridge, adapter, identity, { kind: 'persona', persona_id: 'ada' }, 'e1');
    await harness.bridge.syncInteractions();
    const oldAllow = adapter.sent.find((item) => item.code === 'approval')?.buttons?.[0]?.id;
    await adapter.emit({ eventId: 'old', identity, kind: 'callback', callbackData: oldAllow, callbackQueryId: 'old' });
    expect(harness.decisions).toEqual(['a1:approved']);
    const savedIds = (JSON.parse(harness.stored()) as { tickets: { id: string; consumed: boolean }[] }).tickets.map((ticket) => `${ticket.id}:${ticket.consumed}`);
    pending.approvals = [];
    pending.questions = [{ id: 'ask', questionIndex: 0, expiresAt: NOW + 10_000, questionKey: 'Pick one', options: [{ id: 'opt_0_0', label: 'Red' }, { id: 'opt_0_1', label: 'Blue' }], multi: false, allowOther: true }];
    const restarted = new ImSessionBridge({ ports: harness.ports, factories: [fakeAdapterFactory(adapter)], editIntervalMs: 0, now: () => NOW, wait: () => Promise.resolve() });
    await restarted.setListening('inst', true);
    adapter.sent.splice(0);
    await restarted.syncInteractions();
    const option = adapter.sent.find((item) => item.code === 'question')?.buttons?.[0]?.id;
    expect(option).toBeTruthy();
    expect(savedIds.includes(`${option}:true`)).toBe(false);
    await adapter.emit({ eventId: 'new', identity, kind: 'callback', callbackData: option, callbackQueryId: 'new' });
    expect(harness.answers).toEqual([expect.objectContaining({ questionIndex: 0, optionIds: ['opt_0_0'] })]);
    expect(adapter.sent.some((item) => item.code === 'resolved')).toBe(false);
    await restarted.close();
  });

  it('restores a partial same-stem answer and completes it on the next press', async () => {
    const home = await tempHome();
    const pending = [{
      id: 'ask1', kind: 'question' as const, origin: {}, createdAt: Date.now(),
      payload: { questions: [
        { question: 'Pick one', options: [{ label: 'Red' }, { label: 'Blue' }] },
        { question: 'Pick one', options: [{ label: 'Red' }, { label: 'Green' }] },
      ] },
    }];
    const answered: { id: string; result: unknown }[] = [];
    const holder = { stored: undefined as unknown };
    const core = stubCore(pending, answered, holder);
    const service = new NotificationService(core, home, () => false, () => undefined);
    await service.start();
    const open = async (adapter: FakeImAdapter) => createImSessionHost({
      core, homeDir: home, notifications: service, logger: { info() {} },
      factories: [fakeAdapterFactory(adapter)],
      wechatFetch: () => Promise.reject(new Error('wechat_fetch_blocked')),
    });
    const firstAdapter = new FakeImAdapter('telegram', '42');
    const firstBridge = await open(firstAdapter);
    const pasted = await firstBridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await firstBridge.setListening(pasted.provider_instance_id, true);
    await firstAdapter.emit({ eventId: '1', identity, kind: 'text', text: 'hello' });
    await firstBridge.confirm((await firstBridge.snapshot()).discoveries[0]!.id, { target: { kind: 'persona', persona_id: 'ada' } });
    await firstBridge.syncInteractions();
    const prompts = firstAdapter.sent.filter((item) => item.code === 'question');
    const press = (message: (typeof prompts)[number] | undefined, label: string, bus: FakeImAdapter, eventId: string) => {
      const button = message?.buttons?.find((item) => item.label === label);
      if (button === undefined) throw new Error('missing_button');
      return bus.emit({ eventId, identity, kind: 'callback', callbackData: button.id, callbackQueryId: button.id });
    };
    await press(prompts[0], '1. Red', firstAdapter, 'cb0');
    expect(answered).toEqual([]);
    const saved = JSON.parse(await readFile(join(home, 'im-session-bridge.json'), 'utf8')) as { questionAnswers: Record<string, Record<string, string>>; tickets: { questionIndex?: number; consumed: boolean }[] };
    expect(saved.tickets.some((ticket) => ticket.questionIndex === 0 && ticket.consumed)).toBe(true);
    expect(saved.questionAnswers['ask1']?.['q_0']).toBe('Red');
    await firstBridge.close();
    const secondAdapter = new FakeImAdapter('telegram', '42');
    const secondBridge = await open(secondAdapter);
    await secondBridge.setListening(pasted.provider_instance_id, true);
    await press(prompts[1], '2. Green', secondAdapter, 'cb1');
    expect(answered).toEqual([{ id: 'ask1', result: { answers: { q_0: 'Red', q_1: 'Green' }, method: 'number_key' } }]);
    await secondBridge.close();
    await service.close();
  });

  it('advances numbered QQ answers by question and keeps a written answer with that question', async () => {
    const adapter = new FakeImAdapter('onebot_v11', '42');
    adapter.supportsButtons = false;
    adapter.supportsEdit = false;
    adapter.supportsFile = false;
    const questions: ImPendingQuestion[] = [
      { id: 'ask', questionIndex: 0, expiresAt: NOW + 10_000, questionKey: 'Pick one', options: [{ id: 'opt_0_0', label: 'Red' }, { id: 'opt_0_1', label: 'Blue' }], multi: false, allowOther: true },
      { id: 'ask', questionIndex: 1, expiresAt: NOW + 10_000, questionKey: 'Pick one', options: [{ id: 'opt_1_0', label: 'Red' }, { id: 'opt_1_1', label: 'Green' }], multi: false, allowOther: true },
    ];
    const harness = bridgeFor(adapter, 'onebot_v11', { approvals: [], questions });
    await harness.bridge.paste({ text: 'onebot=ws://127.0.0.1:6700' });
    await harness.bridge.setListening('inst', true);
    await pair(harness.bridge, adapter, identity, { kind: 'persona', persona_id: 'ada' }, 'e1');
    await harness.bridge.syncInteractions();
    await adapter.emit({ eventId: 'n1', identity, kind: 'text', text: '1' });
    await adapter.emit({ eventId: 'n2', identity, kind: 'text', text: 'custom' });
    expect(harness.answers.map((item) => item.questionIndex)).toEqual([0, 1]);
    expect(harness.answers[1]).toMatchObject({ kind: 'other', text: 'custom' });
    expect(harness.submitted).toEqual([]);
    await harness.bridge.close();
  });

  it('consumes one multi-select number message without starting a prompt', async () => {
    const adapter = new FakeImAdapter('onebot_v11', '42');
    adapter.supportsButtons = false;
    const questions: ImPendingQuestion[] = [
      { id: 'ask', questionIndex: 0, expiresAt: NOW + 10_000, questionKey: 'Pick', options: [{ id: 'opt_0_0', label: 'Red' }, { id: 'opt_0_1', label: 'Blue' }, { id: 'opt_0_2', label: 'Green' }], multi: true, allowOther: false },
    ];
    const harness = bridgeFor(adapter, 'onebot_v11', { approvals: [], questions });
    await harness.bridge.paste({ text: 'onebot=ws://127.0.0.1:6700' });
    await harness.bridge.setListening('inst', true);
    await pair(harness.bridge, adapter, identity, { kind: 'persona', persona_id: 'ada' }, 'e1');
    await harness.bridge.syncInteractions();
    await adapter.emit({ eventId: 'n0', identity, kind: 'text', text: 'later' });
    expect(harness.submitted).toEqual([]);
    expect(harness.answers).toEqual([]);
    await adapter.emit({ eventId: 'n1', identity, kind: 'text', text: '1 3' });
    expect(harness.answers).toEqual([expect.objectContaining({ kind: 'multi', questionIndex: 0, optionIds: ['opt_0_0', 'opt_0_2'] })]);
    expect(harness.submitted).toEqual([]);
    await harness.bridge.close();
  });

  it('refuses a ticket from another paired sender in the same session', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const pending = { approvals: [{ id: 'a1', expiresAt: NOW + 10_000, toolName: 'Bash', action: 'run' }] as ImPendingApproval[], questions: [] as ImPendingQuestion[] };
    const harness = bridgeFor(adapter, 'telegram', pending);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await pair(harness.bridge, adapter, identity, { kind: 'session', session_id: 'sess' }, 'e1');
    await pair(harness.bridge, adapter, other, { kind: 'session', session_id: 'sess' }, 'e2');
    await harness.bridge.syncInteractions();
    const firstButton = adapter.sent.find((item) => item.code === 'approval' && item.identity.senderId === 'u1')?.buttons?.[0]?.id;
    expect(firstButton).toBeTruthy();
    await adapter.emit({ eventId: 'cross', identity: other, kind: 'callback', callbackData: firstButton, callbackQueryId: 'cb' });
    expect(harness.decisions).toEqual([]);
    expect(adapter.sent.some((item) => item.code === 'cross_session')).toBe(true);
    await adapter.emit({ eventId: 'owner', identity, kind: 'callback', callbackData: firstButton, callbackQueryId: 'cb2' });
    expect(harness.decisions).toEqual(['a1:approved']);
    await harness.bridge.close();
  });

  it('does not submit a stranger in a bound chat', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const harness = bridgeFor(adapter, 'telegram', { approvals: [], questions: [] });
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await pair(harness.bridge, adapter, identity, { kind: 'persona', persona_id: 'ada' }, 'e1');
    await adapter.emit({ eventId: 's1', identity: { ...identity, senderId: 'stranger' }, kind: 'text', text: 'run tools' });
    expect(harness.submitted).toEqual([]);
    expect((await harness.bridge.snapshot()).strangers).toHaveLength(1);
    await harness.bridge.close();
  });

  it('merges reply context from two accounts in one file', async () => {
    const home = await tempHome();
    const first = openSession('personal_wechat', 'wx-a');
    const second = openSession('personal_wechat', 'wx-b');
    const adapterA = new HubSessionAdapter(first, home);
    const adapterB = new HubSessionAdapter(second, home);
    await adapterA.start(async () => undefined);
    await adapterB.start(async () => undefined);
    await admit(first, 'personal_wechat', 'hi', { reply_context: 'ctx-a', identity: { platform: 'personal_wechat', account_id: 'acct', chat_id: 'ca', sender_id: 'ua', topic_id: '0', chat_kind: 'group' } });
    await admit(second, 'personal_wechat', 'hi', { reply_context: 'ctx-b', identity: { platform: 'personal_wechat', account_id: 'acct', chat_id: 'cb', sender_id: 'ub', topic_id: '0', chat_kind: 'private' } });
    const file = JSON.parse(await readFile(join(home, 'im-session-reply.json'), 'utf8')) as Record<string, string>;
    expect(Object.values(file).sort()).toEqual(['ctx-a', 'ctx-b']);
    const reloadedRaw = openSession('personal_wechat', 'wx-a');
    const reloaded = new HubSessionAdapter(reloadedRaw, home);
    await reloaded.sendText({ identity: { chatId: 'ca', senderId: 'ua', topicId: '0', chatKind: 'group' }, text: 'again', code: 'reply' });
    expect(reloadedRaw.sent[0]).toMatchObject({ target: { chat_id: 'ca', chat_kind: 'group', reply_context: 'ctx-a' } });
    expect(JSON.stringify(reloadedRaw.sent[0])).not.toContain('ctx-b');
  });

  it('isolates chat kind across two chats of one adapter and reloads it from the binding', async () => {
    const home = await tempHome();
    const harness = memoryPorts('onebot_v11', { approvals: [], questions: [] });
    let raw = openSession('qq_onebot_v11', 'inst');
    const factory: ImAdapterFactory = { providerKind: 'onebot_v11', create: () => new HubSessionAdapter(raw, home) };
    const first = new ImSessionBridge({ ports: harness.ports, factories: [factory], editIntervalMs: 0, now: () => NOW, wait: () => Promise.resolve() });
    await first.paste({ text: 'onebot=ws://127.0.0.1:6700' });
    await first.setListening('inst', true);
    await admit(raw, 'qq_onebot_v11', 'one', { event_key: 'e1', reply_context: 'ctx-1', identity: { platform: 'qq_onebot_v11', account_id: 'acct', chat_id: 'c1', sender_id: 'u1', topic_id: '0', chat_kind: 'group' } });
    await admit(raw, 'qq_onebot_v11', 'two', { event_key: 'e2', reply_context: 'ctx-2', identity: { platform: 'qq_onebot_v11', account_id: 'acct', chat_id: 'c2', sender_id: 'u2', topic_id: '0', chat_kind: 'private' } });
    const snap = await first.snapshot();
    await first.confirm(snap.discoveries.find((item) => item.identity.chat_id === 'c1')!.id, { target: { kind: 'persona', persona_id: 'ada' } });
    await first.confirm(snap.discoveries.find((item) => item.identity.chat_id === 'c2')!.id, { target: { kind: 'session', session_id: 'sess' } });
    await first.close();
    raw = openSession('qq_onebot_v11', 'inst');
    const questions: ImPendingQuestion[] = [{ id: 'q', questionIndex: 0, expiresAt: NOW + 1000, questionKey: 'Status', options: [{ id: 'opt_0_0', label: 'Yes' }], multi: false, allowOther: false }];
    const pending = { approvals: [] as ImPendingApproval[], questions };
    const ports = harness.ports;
    ports.sessions.listInteractions = async (sessionId) => sessionId === 'home' ? pending : { approvals: [], questions: [] };
    const second = new ImSessionBridge({ ports, factories: [{ providerKind: 'onebot_v11', create: () => new HubSessionAdapter(raw, home) }], editIntervalMs: 0, now: () => NOW, wait: () => Promise.resolve() });
    await second.setListening('inst', true);
    await second.syncInteractions();
    expect(raw.sent[0]).toMatchObject({ target: { chat_id: 'c1', chat_kind: 'group', reply_context: 'ctx-1' } });
    expect(JSON.stringify(raw.sent[0])).not.toContain('ctx-2');
    await second.close();
  });

  it('resumes an unfinished reply after restart and does not resume a disabled binding', async () => {
    const adapter = new FakeImAdapter('feishu_app', '42');
    const harness = bridgeFor(adapter, 'feishu_app', { approvals: [], questions: [] });
    let phase: 'partial' | 'final' = 'partial';
    harness.ports.sessions.readVisible = async () => ({
      text: phase === 'partial' ? 'partial-answer' : 'final-answer',
      done: phase === 'final',
      media: [],
    });
    await harness.bridge.paste({ text: 'app_id=cli_a\napp_secret=s3cr3t' });
    await harness.bridge.setListening('inst', true);
    await pair(harness.bridge, adapter, identity, { kind: 'persona', persona_id: 'ada' }, 'e1');
    const bindingId = (await harness.bridge.snapshot()).bindings[0]!.id;
    await harness.bridge.updateBinding(bindingId, { reply: 'edit' });
    await adapter.emit({ eventId: 'go', identity, kind: 'text', text: 'go' });
    await until(() => adapter.sent.some((item) => item.text === 'partial-answer'));
    expect(adapter.sent.some((item) => item.text === 'partial-answer')).toBe(true);
    await harness.bridge.setPolicy({ allowed: false, default_enabled: true });
    await harness.bridge.close();
    phase = 'final';
    const replacement = new ImSessionBridge({ ports: harness.ports, factories: [fakeAdapterFactory(adapter)], editIntervalMs: 0, now: () => NOW, wait: () => Promise.resolve() });
    await replacement.setPolicy({ allowed: true, default_enabled: true });
    await replacement.setListening('inst', true);
    const delivered = () => [...adapter.sent, ...adapter.edits].some((item) => item.text === 'final-answer');
    await until(delivered);
    expect(delivered()).toBe(true);
    expect(harness.submitted.map((item) => item.text)).toEqual(['go']);
    await replacement.close();

    const quiet = new FakeImAdapter('feishu_app', '42');
    const second = bridgeFor(quiet, 'feishu_app', { approvals: [], questions: [] });
    let quietPhase: 'partial' | 'final' = 'partial';
    second.ports.sessions.readVisible = async () => ({ text: quietPhase === 'partial' ? 'partial-answer' : 'final-answer', done: quietPhase === 'final', media: [] });
    await second.bridge.paste({ text: 'app_id=cli_a\napp_secret=s3cr3t' });
    await second.bridge.setListening('inst', true);
    await pair(second.bridge, quiet, identity, { kind: 'persona', persona_id: 'ada' }, 'e1');
    const quietId = (await second.bridge.snapshot()).bindings[0]!.id;
    await second.bridge.updateBinding(quietId, { reply: 'edit' });
    await quiet.emit({ eventId: 'go', identity, kind: 'text', text: 'go' });
    await until(() => quiet.sent.some((item) => item.text === 'partial-answer'));
    await second.bridge.updateBinding(quietId, { enabled: false });
    await second.bridge.close();
    quietPhase = 'final';
    const held = new ImSessionBridge({ ports: second.ports, factories: [fakeAdapterFactory(quiet)], editIntervalMs: 0, now: () => NOW, wait: () => Promise.resolve() });
    await held.setPolicy({ allowed: true, default_enabled: true });
    await held.setListening('inst', true);
    await until(() => false);
    expect([...quiet.sent, ...quiet.edits].some((item) => item.text === 'final-answer')).toBe(false);
    expect((await held.snapshot()).bindings[0]?.enabled).toBe(false);
    await held.close();
  });

  it('does not store a token when the scan is cancelled or the base url is rejected, and keeps an existing credential', async () => {
    const stored: string[] = [];
    let release: ((value: { status: number; text(): Promise<string> }) => void) | undefined;
    const login = new WechatQrLogin(async (url) => {
      if (url.includes('get_bot_qrcode')) return { status: 200, text: async () => JSON.stringify({ qrcode: 'qr-secret', qrcode_img_content: 'img' }) };
      return new Promise((resolve) => { release = resolve; });
    }, () => ['existing-token'], async (credential) => { stored.push(credential); return { instanceId: 'inst' }; });
    const started = await login.start();
    const pending = login.poll(started.login_id);
    await login.cancel(started.login_id);
    release?.({ status: 200, text: async () => JSON.stringify({ status: 'confirmed', bot_token: 'new-token', ilink_bot_id: 'bot', baseurl: 'https://ilinkai.weixin.qq.com' }) });
    await expect(pending).rejects.toThrow('wechat_login_cancelled');
    expect(stored).toEqual([]);
  });
});

function stubCore(pending: { id: string; kind: 'question'; payload: { questions: { question: string; options: { label: string }[] }[] }; origin: Record<string, never>; createdAt: number }[], answered: { id: string; result: unknown }[], holder: { stored: unknown }): Scope {
  const config = { ready: Promise.resolve(), get: () => holder.stored, replaceSections: async (sections: Record<string, unknown>) => { holder.stored = sections['notifications']; } };
  const interactions = { listPending: () => pending, isRecentlyResolved: () => false };
  const questionService = { answer(id: string, result: unknown) { answered.push({ id, result }); } };
  const sessionGet = (key: unknown) => {
    if (key === ISessionInteractionService) return interactions;
    if (key === ISessionQuestionService) return questionService;
    throw new Error('unexpected_session_service');
  };
  return { instantiation: { provide() {} }, accessor: { get: (key: unknown) => {
    if (key === IConfigService) return config;
    if (key === ISessionIndex) return { get: async (id: string) => id === 'home' ? { id } : undefined };
    if (key === ISessionManager) return { list: () => [], acquire: async () => ({ handle: { accessor: { get: sessionGet } }, dispose: async () => undefined }) };
    if (key === IBotService) return { list: async () => [], ensureHomeSession: async () => ({ homeSessionId: 'home' }) };
    if (key === IPluginHostService) return { attachImAdapters: async () => {} };
    throw new Error('unexpected_app_service');
  } } } as unknown as Scope;
}

function openSession(platform: SessionPlatformId, instanceId: string): SessionAdapter & { sink?: SessionSink; sent: SessionOutbound[] } {
  const sent: SessionOutbound[] = [];
  const adapter = {
    platform,
    instance_id: instanceId,
    account: { platform, account_id: 'acct' },
    limits: { text_characters: null, text_utf8_bytes: null, callback_data_bytes: null, voice_mime: null, image_bytes: null, file_bytes: null },
    state: 'running' as const,
    sink: undefined as SessionSink | undefined,
    sent,
    start(sink: SessionSink) { adapter.sink = sink; return Promise.resolve(); },
    stop() { return Promise.resolve(); },
    send(message: SessionOutbound) {
      sent.push(message);
      return Promise.resolve({ status: 'accepted' as const, message_ids: ['m1'] });
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
