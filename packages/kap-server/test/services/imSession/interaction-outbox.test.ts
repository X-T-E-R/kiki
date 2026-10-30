import { createFeishuSessionAdapter, createWechatSessionAdapter, type SessionSpec } from '@nb-im/core';
import { describe, expect, it, vi } from 'vitest';

import { HubSessionAdapter } from '../../../src/services/imSession/hubAdapter';
import { ImSessionBridge } from '../../../src/services/imSession/bridge';
import { FakeImAdapter, fakeAdapterFactory } from '../../../src/services/imSession/fakeAdapter';
import type { ImInboundIdentity } from '../../../src/services/imSession/adapter';
import type { ImPendingApproval, ImPendingQuestion, ImSessionPorts } from '../../../src/services/imSession/ports';

type FeishuConnection = NonNullable<Extract<SessionSpec, { platform: 'feishu_app' }>['connection']>;
type FeishuHandlers = Parameters<FeishuConnection['open']>[0];
type FeishuRequest = Parameters<FeishuConnection['send']>[0];

const NOW = 1_700_000_000_000;
const identity: ImInboundIdentity = { chatId: 'c1', senderId: 'u1', topicId: '0' };
const other: ImInboundIdentity = { chatId: 'c2', senderId: 'u2', topicId: '0' };

function memoryPorts(pending: { approvals: ImPendingApproval[]; questions: ImPendingQuestion[] }) {
  const secrets = new Map<string, string>();
  const decisions: string[] = [];
  let stored = '';
  const ports: ImSessionPorts = {
    credentials: {
      list: () => [...secrets.keys()].map((id) => ({ id, providerId: 'telegram', configured: true })),
      read: (id) => secrets.get(id),
      write: async (id, value) => { secrets.set(id, value); },
      check: async () => ({ ok: true, accountId: 'acct' }),
      create: async ({ credential }) => { secrets.set('inst', credential); return { instanceId: 'inst' }; },
    },
    sessions: {
      listPersonas: async () => [{ id: 'ada', name: 'Ada', homeSessionId: 'home' }],
      listSessions: async () => [{ id: 'sess', title: 'Other', personaId: 'ada' }],
      owns: async (sessionId) => sessionId === 'sess',
      ensureHome: async () => ({ homeSessionId: 'home' }),
      setHome: async () => undefined,
      activity: async () => ({ busy: false, pending: 'none', queueLength: 0 }),
      submit: async (input) => ({ duplicate: false, promptId: input.promptId, turnId: 3, deliveryState: 'pending' }),
      steer: async () => 'steered',
      abort: async () => false,
      saveMedia: async () => [],
      readVisible: async () => ({ text: '', done: true, media: [] }),
      listInteractions: async () => pending,
      decideApproval: async (input) => { decisions.push(`${input.interactionId}:${input.decision}`); return 'decided'; },
      decideHostKey: async (input) => { decisions.push(`${input.interactionId}:${input.decision}`); return 'decided'; },
      answerQuestion: async () => 'answered',
    },
    logger: { info() {} },
    load: async () => stored === '' ? undefined : stored,
    save: async (value) => { stored = value; },
  };
  return { ports, stored: () => stored, decisions };
}

function bridgeFor(adapter: FakeImAdapter, pending: { approvals: ImPendingApproval[]; questions: ImPendingQuestion[] }) {
  const harness = memoryPorts(pending);
  const bridge = new ImSessionBridge({ ports: harness.ports, factories: [fakeAdapterFactory(adapter)], editIntervalMs: 0, now: () => NOW, wait: () => Promise.resolve() });
  return { bridge, ...harness };
}

async function pair(bridge: ImSessionBridge, adapter: FakeImAdapter, who: ImInboundIdentity, eventId: string) {
  await adapter.emit({ eventId, identity: who, kind: 'text', text: 'hello' });
  const discovery = (await bridge.snapshot()).discoveries.find((item) => item.identity.sender_id === who.senderId);
  if (discovery === undefined) throw new Error('missing_discovery');
  await bridge.confirm(discovery.id, { target: { kind: 'session', session_id: 'sess' } });
}

function saved(raw: string): { tickets: { id: string; action: string; consumed: boolean; interactionId: string }[]; outbox: { key: string; delivery: 'pending' | 'sending' | 'sent' | 'unknown'; buttons: { id: string; label: string }[]; code: string }[] } {
  return JSON.parse(raw) as { tickets: { id: string; action: string; consumed: boolean; interactionId: string }[]; outbox: { key: string; delivery: 'pending' | 'sending' | 'sent' | 'unknown'; buttons: { id: string; label: string }[]; code: string }[] };
}

function failOnce(adapter: FakeImAdapter, codes: readonly string[]) {
  const original = adapter.sendText.bind(adapter);
  let failed = false;
  adapter.sendText = (message) => {
    if (!failed && codes.includes(message.code)) {
      failed = true;
      return Promise.reject(new Error('send_failed'));
    }
    return original(message);
  };
}

describe('phone interaction outbox', () => {
  it('sends a failed approval on the next sync with the same ticket ids and decides once', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const pending = { approvals: [{ id: 'a1', expiresAt: NOW + 10_000, toolName: 'Bash', action: 'run' }] as ImPendingApproval[], questions: [] as ImPendingQuestion[] };
    const harness = bridgeFor(adapter, pending);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await pair(harness.bridge, adapter, identity, 'e1');
    failOnce(adapter, ['approval']);
    await expect(harness.bridge.syncInteractions()).rejects.toThrow('send_failed');
    const first = saved(harness.stored());
    expect(first.tickets.map((ticket) => ticket.action).sort()).toEqual(['approve', 'reject']);
    expect(first.outbox.map((item) => item.delivery)).toEqual(['pending']);
    expect(adapter.sent.filter((item) => item.code === 'approval')).toEqual([]);
    await harness.bridge.syncInteractions();
    const approval = adapter.sent.filter((item) => item.code === 'approval');
    expect(approval).toHaveLength(1);
    expect(approval[0]?.buttons?.map((button) => button.id).sort()).toEqual(first.tickets.map((ticket) => ticket.id).sort());
    expect(saved(harness.stored()).outbox.map((item) => item.delivery)).toEqual(['sent']);
    await harness.bridge.syncInteractions();
    expect(adapter.sent.filter((item) => item.code === 'approval')).toHaveLength(1);
    const allow = first.tickets.find((ticket) => ticket.action === 'approve');
    await adapter.emit({ eventId: 'click', identity, kind: 'callback', callbackData: allow!.id, callbackQueryId: 'cb' });
    await adapter.emit({ eventId: 'again', identity, kind: 'callback', callbackData: allow!.id, callbackQueryId: 'cb2' });
    expect(harness.decisions).toEqual(['a1:approved']);
    expect(adapter.sent.some((item) => item.code === 'resolved')).toBe(true);
    expect(saved(harness.stored()).tickets.find((ticket) => ticket.id === allow!.id)?.consumed).toBe(true);
    await harness.bridge.close();
  });

  it('rejects callbacks when input is off or the listening account changed without consuming the ticket', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const pending = { approvals: [{ id: 'a1', expiresAt: NOW + 10_000, toolName: 'Bash', action: 'run' }] as ImPendingApproval[], questions: [] as ImPendingQuestion[] };
    const harness = bridgeFor(adapter, pending);
    try {
      await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
      await harness.bridge.setListening('inst', true);
      await pair(harness.bridge, adapter, identity, 'pair');
      await harness.bridge.syncInteractions();
      const ticket = saved(harness.stored()).tickets.find((item) => item.action === 'approve')!;
      const binding = (await harness.bridge.snapshot()).bindings[0]!;
      await harness.bridge.updateBinding(binding.id, { inputEnabled: false });
      await adapter.emit({ eventId: 'input-off', identity, kind: 'callback', callbackData: ticket.id, callbackQueryId: 'off' });
      expect(harness.decisions).toEqual([]);
      expect(saved(harness.stored()).tickets.find((item) => item.id === ticket.id)?.consumed).toBe(false);
      await harness.bridge.updateBinding(binding.id, { inputEnabled: true });
      harness.ports.credentials.check = async () => ({ ok: true, accountId: 'different-account' });
      await harness.bridge.check('inst');
      await harness.bridge.updateBinding(binding.id, { enabled: true });
      expect((await harness.bridge.channelViews('sess')).find((channel) => channel.id === `im:${binding.id}`)?.enabled).toBe(false);
      await expect(harness.bridge.sendUserMessage({ sessionId: 'sess', toolCallId: 'different-account-output', text: 'must not send', attachments: [], channel: `im:${binding.id}` })).rejects.toThrow('channel_disabled');
      await adapter.emit({ eventId: 'different-account', identity, kind: 'callback', callbackData: ticket.id, callbackQueryId: 'different' });
      expect(harness.decisions).toEqual([]);
      expect(saved(harness.stored()).tickets.find((item) => item.id === ticket.id)?.consumed).toBe(false);
      harness.ports.credentials.check = async () => ({ ok: true, accountId: '42' });
      await harness.bridge.check('inst');
      await harness.bridge.updateBinding(binding.id, { enabled: true });
      await adapter.emit({ eventId: 'owner', identity, kind: 'callback', callbackData: ticket.id, callbackQueryId: 'owner' });
      expect(harness.decisions).toEqual(['a1:approved']);
    } finally { await harness.bridge.close(); }
  });

  it('sends a pending approval after restart with the same ticket ids', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const pending = { approvals: [{ id: 'a1', expiresAt: NOW + 10_000, toolName: 'Bash', action: 'run' }] as ImPendingApproval[], questions: [] as ImPendingQuestion[] };
    const harness = bridgeFor(adapter, pending);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await pair(harness.bridge, adapter, identity, 'e1');
    failOnce(adapter, ['approval']);
    await expect(harness.bridge.syncInteractions()).rejects.toThrow('send_failed');
    const ids = saved(harness.stored()).tickets.map((ticket) => ticket.id).sort();
    await harness.bridge.close();
    const nextAdapter = new FakeImAdapter('telegram', '42');
    const next = new ImSessionBridge({ ports: harness.ports, factories: [fakeAdapterFactory(nextAdapter)], editIntervalMs: 0, now: () => NOW, wait: () => Promise.resolve() });
    await next.setListening('inst', true);
    await next.syncInteractions();
    const approval = nextAdapter.sent.filter((item) => item.code === 'approval');
    expect(approval).toHaveLength(1);
    expect(approval[0]?.buttons?.map((button) => button.id).sort()).toEqual(ids);
    await next.syncInteractions();
    expect(nextAdapter.sent.filter((item) => item.code === 'approval')).toHaveLength(1);
    await next.close();
  });

  it('does not send an approval again after the send is confirmed', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const pending = { approvals: [{ id: 'a1', expiresAt: NOW + 10_000, toolName: 'Bash', action: 'run' }] as ImPendingApproval[], questions: [] as ImPendingQuestion[] };
    const harness = bridgeFor(adapter, pending);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await pair(harness.bridge, adapter, identity, 'e1');
    await harness.bridge.syncInteractions();
    await harness.bridge.syncInteractions();
    expect(adapter.sent.filter((item) => item.code === 'approval')).toHaveLength(1);
    expect(saved(harness.stored()).outbox.map((item) => item.delivery)).toEqual(['sent']);
    await harness.bridge.close();
  });

  it('does not send a pending approval while the binding is disabled', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const pending = { approvals: [{ id: 'a1', expiresAt: NOW + 10_000, toolName: 'Bash', action: 'run' }] as ImPendingApproval[], questions: [] as ImPendingQuestion[] };
    const harness = bridgeFor(adapter, pending);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await pair(harness.bridge, adapter, identity, 'e1');
    failOnce(adapter, ['approval']);
    await expect(harness.bridge.syncInteractions()).rejects.toThrow('send_failed');
    const binding = (await harness.bridge.snapshot()).bindings[0];
    await harness.bridge.updateBinding(binding!.id, { enabled: false });
    await harness.bridge.syncInteractions();
    expect(adapter.sent.filter((item) => item.code === 'approval')).toEqual([]);
    expect((await harness.bridge.snapshot()).bindings[0]?.enabled).toBe(false);
    expect(saved(harness.stored()).outbox.map((item) => item.delivery)).toEqual(['pending']);
    await harness.bridge.close();
  });

  it('retries a failed host-key prompt and a failed question with the original ids', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const pending = {
      approvals: [{ id: 'hk', expiresAt: NOW + 10_000, toolName: 'SSH', action: 'trust', ssh: 'host_key' as const }],
      questions: [{ id: 'q1', questionIndex: 0, expiresAt: NOW + 10_000, questionKey: 'Pick', options: [{ id: 'opt_0_0', label: 'Red' }], multi: false, allowOther: false }],
    };
    const harness = bridgeFor(adapter, pending);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await pair(harness.bridge, adapter, identity, 'e1');
    failOnce(adapter, ['host_key', 'question']);
    await expect(harness.bridge.syncInteractions()).rejects.toThrow('send_failed');
    const staged = saved(harness.stored());
    expect(staged.outbox.map((item) => item.delivery)).toEqual(['pending', 'pending']);
    expect(adapter.sent.filter((item) => item.code === 'host_key' || item.code === 'question')).toEqual([]);
    await harness.bridge.syncInteractions();
    const hostKey = adapter.sent.find((item) => item.code === 'host_key');
    const question = adapter.sent.find((item) => item.code === 'question');
    expect(hostKey?.buttons?.map((button) => button.id).sort()).toEqual(staged.outbox.find((item) => item.code === 'host_key')?.buttons.map((button) => button.id).sort());
    expect(question?.buttons?.map((button) => button.id)).toEqual(staged.outbox.find((item) => item.code === 'question')?.buttons.map((button) => button.id));
    await harness.bridge.syncInteractions();
    expect(adapter.sent.filter((item) => item.code === 'host_key')).toHaveLength(1);
    expect(adapter.sent.filter((item) => item.code === 'question')).toHaveLength(1);
    await harness.bridge.close();
  });

  it('does not let a second paired sender or an overlapping sync deliver the same approval', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const pending = { approvals: [{ id: 'a1', expiresAt: NOW + 10_000, toolName: 'Bash', action: 'run' }] as ImPendingApproval[], questions: [] as ImPendingQuestion[] };
    const harness = bridgeFor(adapter, pending);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await pair(harness.bridge, adapter, identity, 'e1');
    await pair(harness.bridge, adapter, other, 'e2');
    const reads = vi.fn(async () => pending);
    harness.ports.sessions.listInteractions = reads;
    const original = adapter.sendText.bind(adapter);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    adapter.sendText = (message) => {
      calls += 1;
      if (message.code === 'approval' && calls === 1) return gate.then(() => original(message));
      return original(message);
    };
    const first = harness.bridge.syncInteractions();
    const second = harness.bridge.syncInteractions();
    for (let attempt = 0; attempt < 20 && calls < 1; attempt += 1) await Promise.resolve();
    expect(calls).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(adapter.sent.filter((item) => item.code === 'approval')).toHaveLength(1);
    const allow = saved(harness.stored()).tickets.find((ticket) => ticket.action === 'approve');
    await adapter.emit({ eventId: 'other', identity: other, kind: 'callback', callbackData: allow!.id, callbackQueryId: 'cb-other' });
    expect(harness.decisions).toEqual([]);
    expect(adapter.sent.some((item) => item.code === 'cross_session')).toBe(true);
    expect(saved(harness.stored()).tickets.find((ticket) => ticket.id === allow!.id)?.consumed).toBe(false);
    await adapter.emit({ eventId: 'owner', identity, kind: 'callback', callbackData: allow!.id, callbackQueryId: 'cb-owner' });
    expect(harness.decisions).toEqual(['a1:approved']);
    await harness.bridge.close();
  });

  it('coalesces 100 overlapping polls, isolates a blocked binding and retains unknown across restart', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const pending = { approvals: [{ id: 'a1', expiresAt: NOW + 10_000, toolName: 'Bash', action: 'run' }] as ImPendingApproval[], questions: [] as ImPendingQuestion[] };
    const harness = bridgeFor(adapter, pending);
    harness.ports.sessions.owns = async () => true;
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await pair(harness.bridge, adapter, identity, 'first');
    await pair(harness.bridge, adapter, other, 'second');
    const binding = (await harness.bridge.snapshot()).bindings.find((item) => item.identity.sender_id === other.senderId)!;
    await harness.bridge.updateBinding(binding.id, { sessionId: 'other-session', rebind: true });
    const reads = vi.fn(async () => pending);
    harness.ports.sessions.listInteractions = reads;
    let release = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const original = adapter.sendText.bind(adapter);
    adapter.sendText = async (message) => {
      if (message.identity.chatId === identity.chatId && message.code === 'approval') await hold;
      return original(message);
    };
    const first = harness.bridge.syncInteractions();
    const joined = Array.from({ length: 100 }, () => harness.bridge.syncInteractions());
    expect(joined.every((flight) => flight === first)).toBe(true);
    await vi.waitFor(() => expect(adapter.sent.filter((item) => item.code === 'approval')).toHaveLength(1));
    expect(adapter.sent.find((item) => item.code === 'approval')?.identity.chatId).toBe(other.chatId);
    expect(reads).toHaveBeenCalledTimes(2);
    const started = performance.now();
    await harness.bridge.close();
    expect(performance.now() - started).toBeLessThan(1500);
    await Promise.all([first, ...joined]);
    expect(saved(harness.stored()).outbox.map((item) => item.delivery).sort()).toEqual(['sent', 'unknown']);
    const nextAdapter = new FakeImAdapter('telegram', '42');
    const next = new ImSessionBridge({ ports: harness.ports, factories: [fakeAdapterFactory(nextAdapter)], now: () => NOW });
    await next.setListening('inst', true);
    await next.syncInteractions();
    expect(nextAdapter.sent.filter((item) => item.code === 'approval')).toHaveLength(0);
    await next.close();
    const interrupted = saved(harness.stored());
    for (const job of interrupted.outbox) if (job.delivery === 'unknown') job.delivery = 'sending';
    harness.ports.load = async () => JSON.stringify(interrupted);
    const restoredAdapter = new FakeImAdapter('telegram', '42');
    const restored = new ImSessionBridge({ ports: harness.ports, factories: [fakeAdapterFactory(restoredAdapter)], now: () => NOW });
    await restored.setListening('inst', true);
    await restored.syncInteractions();
    expect(saved(harness.stored()).outbox.map((item) => item.delivery).sort()).toEqual(['sent', 'unknown']);
    expect(restoredAdapter.sent.filter((item) => item.code === 'approval')).toHaveLength(0);
    release();
    await restored.close();
  });

  it('runs one dirty follow-up after overlapping reads rather than one poll per call', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const pending = { approvals: [] as ImPendingApproval[], questions: [] as ImPendingQuestion[] };
    const harness = bridgeFor(adapter, pending);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await pair(harness.bridge, adapter, identity, 'pair');
    let release = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    harness.ports.sessions.listInteractions = async () => { reads += 1; if (reads === 1) await hold; return pending; };
    const first = harness.bridge.syncInteractions();
    await vi.waitFor(() => expect(reads).toBe(1));
    const joined = Array.from({ length: 100 }, () => harness.bridge.syncInteractions());
    release();
    await Promise.all([first, ...joined]);
    expect(reads).toBe(2);
    await harness.bridge.close();
  });

  it('aborts a blocked interaction read on close and admits no dirty follow-up', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const pending = { approvals: [] as ImPendingApproval[], questions: [] as ImPendingQuestion[] };
    const harness = bridgeFor(adapter, pending);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await pair(harness.bridge, adapter, identity, 'pair');
    let received: AbortSignal | undefined;
    const read = vi.fn((_session: string, signal?: AbortSignal) => { received = signal; return new Promise<typeof pending>(() => {}); });
    harness.ports.sessions.listInteractions = read;
    const first = harness.bridge.syncInteractions();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const joined = harness.bridge.syncInteractions();
    await harness.bridge.close();
    await Promise.all([first, joined]);
    expect(received?.aborted).toBe(true);
    await harness.bridge.syncInteractions();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('expires a stalled session read after ten seconds and permits a later poll', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const pending = { approvals: [] as ImPendingApproval[], questions: [] as ImPendingQuestion[] };
    const harness = bridgeFor(adapter, pending);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await pair(harness.bridge, adapter, identity, 'pair');
    let received: AbortSignal | undefined;
    harness.ports.sessions.listInteractions = (_session, signal) => { received = signal; return new Promise<typeof pending>(() => {}); };
    vi.useFakeTimers();
    try {
      const flight = harness.bridge.syncInteractions();
      const result = expect(flight).rejects.toThrow('Aborted');
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
      expect(received?.aborted).toBe(true);
      harness.ports.sessions.listInteractions = async () => pending;
      await expect(harness.bridge.syncInteractions()).resolves.toBeUndefined();
    } finally { vi.useRealTimers(); await harness.bridge.close(); }
  });

  it('marks a timed-out send unknown and does not retry it on the next poll', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const pending = { approvals: [{ id: 'a1', expiresAt: NOW + 10_000, toolName: 'Bash', action: 'run' }] as ImPendingApproval[], questions: [] as ImPendingQuestion[] };
    const harness = bridgeFor(adapter, pending);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await pair(harness.bridge, adapter, identity, 'pair');
    const send = vi.fn((_message: Parameters<FakeImAdapter['sendText']>[0]) => new Promise<{ messageId: string; messageIds: readonly string[] }>(() => {}));
    adapter.sendText = send;
    vi.useFakeTimers();
    try {
      const flight = harness.bridge.syncInteractions();
      const result = expect(flight).rejects.toThrow('im_send_outcome_unknown');
      await vi.advanceTimersByTimeAsync(60_000);
      await result;
      expect(saved(harness.stored()).outbox[0]?.delivery).toBe('unknown');
      await harness.bridge.syncInteractions();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.length).toBe(1);
    } finally { vi.useRealTimers(); await harness.bridge.close(); }
  });

  it('rechecks a binding replaced while the staged delivery is being saved', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const pending = { approvals: [{ id: 'a1', expiresAt: NOW + 10_000, toolName: 'Bash', action: 'run' }] as ImPendingApproval[], questions: [] as ImPendingQuestion[] };
    const harness = bridgeFor(adapter, pending);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await pair(harness.bridge, adapter, identity, 'pair');
    const binding = (await harness.bridge.snapshot()).bindings[0]!;
    let release = () => {};
    let saving = false;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const save = harness.ports.save;
    harness.ports.save = async (raw) => { if (!saving) { saving = true; await hold; } await save(raw); };
    const flight = harness.bridge.syncInteractions();
    await vi.waitFor(() => expect(saving).toBe(true));
    const changed = harness.bridge.updateBinding(binding.id, { outputEnabled: false });
    await vi.waitFor(async () => expect((await harness.bridge.snapshot()).bindings[0]?.output_enabled).toBe(false));
    release();
    await Promise.all([flight, changed]);
    expect(adapter.sent.filter((item) => item.code === 'approval')).toHaveLength(0);
    await harness.bridge.close();
  });

  it('rejects a queued delivery when its binding is disabled before dispatch', async () => {
    const adapter = new FakeImAdapter('telegram', '42');
    const pending = { approvals: [{ id: 'a1', expiresAt: NOW + 10_000, toolName: 'Bash', action: 'run' }] as ImPendingApproval[], questions: [] as ImPendingQuestion[] };
    const harness = bridgeFor(adapter, pending);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await pair(harness.bridge, adapter, identity, 'pair');
    const binding = (await harness.bridge.snapshot()).bindings[0]!;
    let release = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const original = adapter.sendText.bind(adapter);
    let helping = false;
    adapter.sendText = async (message) => { if (message.code === 'help') { helping = true; await hold; } return original(message); };
    const command = adapter.emit({ eventId: 'help', identity, kind: 'text', text: '/help' });
    await vi.waitFor(() => expect(helping).toBe(true));
    const flight = harness.bridge.syncInteractions();
    const result = expect(flight).rejects.toThrow('im_send_cancelled');
    await vi.waitFor(() => expect(saved(harness.stored()).outbox[0]?.delivery).toBe('sending'));
    await harness.bridge.updateBinding(binding.id, { outputEnabled: false });
    release();
    await Promise.all([command, result]);
    expect(adapter.sent.filter((item) => item.code === 'approval')).toHaveLength(0);
    expect(saved(harness.stored()).outbox[0]?.delivery).toBe('pending');
    await harness.bridge.close();
  });

  it('drops a pending approval that is no longer open and still sends an expired one once', async () => {
    const gone = new FakeImAdapter('telegram', '42');
    const gonePending = { approvals: [{ id: 'a1', expiresAt: NOW + 10_000, toolName: 'Bash', action: 'run' }] as ImPendingApproval[], questions: [] as ImPendingQuestion[] };
    const goneHarness = bridgeFor(gone, gonePending);
    await goneHarness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await goneHarness.bridge.setListening('inst', true);
    await pair(goneHarness.bridge, gone, identity, 'e1');
    failOnce(gone, ['approval']);
    await expect(goneHarness.bridge.syncInteractions()).rejects.toThrow('send_failed');
    gonePending.approvals = [];
    await goneHarness.bridge.syncInteractions();
    expect(gone.sent.filter((item) => item.code === 'approval')).toEqual([]);
    expect(saved(goneHarness.stored()).outbox).toEqual([]);
    await goneHarness.bridge.close();

    const adapter = new FakeImAdapter('telegram', '42');
    const pending = { approvals: [{ id: 'old', expiresAt: NOW - 1, toolName: 'Bash', action: 'run' }] as ImPendingApproval[], questions: [] as ImPendingQuestion[] };
    const harness = bridgeFor(adapter, pending);
    await harness.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await harness.bridge.setListening('inst', true);
    await pair(harness.bridge, adapter, identity, 'e1');
    await harness.bridge.syncInteractions();
    await harness.bridge.syncInteractions();
    expect(adapter.sent.filter((item) => item.code === 'approval')).toHaveLength(1);
    await harness.bridge.close();
  });
});


describe('upgraded bindings with unavailable delivery targets', () => {
  it.each(['feishu_app', 'wechat_bridge'] as const)('isolates a legacy %s target, retains pending outbox without hot retries, and serves later channels', async (providerKind) => {
    const harness = memoryPorts({ approvals: [], questions: [] });
    const requests: FeishuRequest[] = [];
    const wechatSends: Record<string, unknown>[] = [];
    let handlers: FeishuHandlers | undefined;
    let polls = 0;
    const store = { load: async () => undefined, save: async () => undefined };
    const raw = providerKind === 'feishu_app' ? createFeishuSessionAdapter({
      platform: 'feishu_app', instance_id: 'legacy-fs', app_id: 'cli_legacy', app_secret: 'offline-secret', retry_ms: 0,
      connection: {
        async open(next) { handlers = next; return { ok: true }; },
        async send(request) { requests.push(request); return { ok: true, message_id: 'om_sent' }; },
      },
    }, store) : createWechatSessionAdapter({
      platform: 'personal_wechat', instance_id: 'legacy-wx', account_id: 'bot', token: 'offline-legacy-test', retry_ms: 0,
      transport: {
        async post(url, _headers, body, signal) {
          if (url.endsWith('getupdates')) {
            if (polls++ === 0) return { status: 200, body: '{"msgs":[],"get_updates_buf":"legacy"}' };
            await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
            throw new DOMException('Aborted', 'AbortError');
          }
          if (url.endsWith('sendmessage')) wechatSends.push(JSON.parse(body) as Record<string, unknown>);
          return { status: 200, body: '{"ret":0}' };
        },
        async postBytes() { throw new Error('unexpected upload'); },
        async getBytes() { throw new Error('unexpected download'); },
      } satisfies NonNullable<Extract<SessionSpec, { platform: 'personal_wechat' }>['transport']>,
    }, store);
    const adapter = new HubSessionAdapter(raw);
    const unavailable = providerKind === 'feishu_app' ? { chatId: 'oc', senderId: 'sender', topicId: 'omt_old', chatKind: 'group' as const } : { chatId: 'group', senderId: 'sender', topicId: '0', chatKind: 'group' as const };
    const good = providerKind === 'feishu_app' ? { chatId: 'oc', senderId: 'sender', topicId: '0', chatKind: 'group' as const } : { chatId: 'private', senderId: 'private', topicId: '0', chatKind: 'private' as const };
    let persisted = JSON.stringify({
      policy: { allowed: true, defaultEnabled: true },
      instances: [{ id: 'inst', providerKind, listening: true, virtual: false }],
      bindings: [unavailable, good].map((identity, index) => ({ id: `binding-${index}`, providerInstanceId: 'inst', providerKind, accountId: providerKind === 'feishu_app' ? 'cli_legacy' : 'bot', identity, sessionId: `session-${index}`, enabled: true, busy: 'queue', reply: 'final', mobileInteractions: true })),
    });
    let saves = 0;
    const diagnostics: Record<string, string | number | boolean>[] = [];
    harness.ports.load = async () => persisted;
    harness.ports.save = async (value) => { saves += 1; persisted = value; };
    harness.ports.credentials.list = () => [{ id: 'inst', providerId: providerKind, configured: true }];
    harness.ports.credentials.read = () => 'offline-credential';
    harness.ports.logger.info = (fields, message) => { if (message === 'im interaction delivery blocked') diagnostics.push(fields); };
    harness.ports.sessions.owns = async (sessionId) => sessionId === 'session-0' || sessionId === 'session-1' || sessionId === 'sess';
    harness.ports.sessions.listInteractions = async (sessionId) => ({
      approvals: [{ id: `approval-${sessionId}`, expiresAt: NOW + 100_000, toolName: 'Bash', action: 'run' }],
      questions: [{ id: `question-${sessionId}`, questionIndex: 0, expiresAt: NOW + 100_000, questionKey: 'Pick', options: [{ id: 'red', label: 'Red' }], multi: false, allowOther: false }],
    });
    const bridge = new ImSessionBridge({ ports: harness.ports, factories: [{ providerKind, create: () => adapter }], now: () => NOW, wait: async () => undefined });
    try {
      await bridge.setListening('inst', true);
      await expect(bridge.syncInteractions()).resolves.toBeUndefined();
      const failure = providerKind === 'feishu_app' ? 'feishu_thread_context_missing' : 'wechat_group_unsupported';
      const first = JSON.parse(persisted) as { bindings: { interactionFailure?: string }[]; outbox: { bindingId: string; delivery: string }[]; tickets: { id: string }[] };
      expect(first.bindings[0]?.interactionFailure).toBe(failure);
      expect(first.outbox.filter((job) => job.bindingId === 'binding-0').map((job) => job.delivery)).toEqual(['pending', 'pending']);
      expect(first.outbox.filter((job) => job.bindingId === 'binding-1').map((job) => job.delivery)).toEqual(['sent', 'sent']);
      expect(diagnostics).toEqual([expect.objectContaining({ binding_id: 'binding-0', diagnostic_code: failure })]);
      const stable = saves;
      await bridge.syncInteractions();
      await bridge.syncInteractions();
      expect(saves).toBe(stable);
      expect(JSON.parse(persisted).tickets).toEqual(first.tickets);
      if (providerKind === 'feishu_app') {
        expect(requests.map((request) => request.op)).toEqual(['create_message', 'create_message']);
        await handlers!.onMessage({ event_id: 'fresh-context', app_id: 'cli_legacy', sender: { sender_id: { open_id: 'sender' } }, message: { message_id: 'om_fresh', chat_id: 'oc', chat_type: 'group', thread_id: 'omt_old', message_type: 'text', content: '{"text":" "}' } });
        await bridge.syncInteractions();
        expect(requests.filter((request) => request.op === 'reply_message').map((request) => request.message_id)).toEqual(['om_fresh', 'om_fresh']);
        expect(JSON.parse(persisted).bindings[0].interactionFailure).toBeUndefined();
        expect(JSON.parse(persisted).tickets).toEqual(first.tickets);
      } else {
        expect(wechatSends.map((request) => (request['msg'] as Record<string, unknown>)['to_user_id'])).toEqual(['private', 'private']);
      }
    } finally { await bridge.close(); }
  });
});


it('attempts a later binding before reporting a transient delivery failure and retries the original outbox', async () => {
  const adapter = new FakeImAdapter('telegram', '42');
  const held = bridgeFor(adapter, { approvals: [], questions: [] });
  held.ports.sessions.owns = async () => true;
  held.ports.sessions.listInteractions = async (sessionId) => ({ approvals: [{ id: `approval-${sessionId}`, expiresAt: NOW + 10_000, toolName: 'Bash', action: 'run' }], questions: [] });
  try {
    await held.bridge.paste({ text: '123456:abcdefghijklmnopqrstuvwxyz' });
    await held.bridge.setListening('inst', true);
    await pair(held.bridge, adapter, identity, 'first');
    await pair(held.bridge, adapter, other, 'second');
    const second = (await held.bridge.snapshot()).bindings.find((binding) => binding.identity.sender_id === other.senderId)!;
    await held.bridge.updateBinding(second.id, { sessionId: 'home', rebind: true });
    failOnce(adapter, ['approval']);
    await expect(held.bridge.syncInteractions()).rejects.toThrow('send_failed');
    expect(adapter.sent.filter((message) => message.code === 'approval').map((message) => message.identity.chatId)).toEqual([other.chatId]);
    const before = saved(held.stored());
    await held.bridge.syncInteractions();
    expect(adapter.sent.filter((message) => message.code === 'approval').map((message) => message.identity.chatId)).toEqual([other.chatId, identity.chatId]);
    expect(saved(held.stored()).tickets).toEqual(before.tickets);
  } finally { await held.bridge.close(); }
});
