import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionRunState, SessionSink } from '@nb-im/core';
import { imSessionSnapshotSchema } from '@kiki/protocol';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import type { ImSessionAdapter } from '../../../src/services/imSession/adapter';
import { ImSessionBridge } from '../../../src/services/imSession/bridge';
import { FakeImAdapter } from '../../../src/services/imSession/fakeAdapter';
import { HubSessionAdapter, loadHubFactories } from '../../../src/services/imSession/hubAdapter';
import type { ImSessionPorts } from '../../../src/services/imSession/ports';

class PendingAdapter extends FakeImAdapter {
  phase: ReturnType<NonNullable<ImSessionAdapter['connectionPhase']>> = 'starting';
  private resolveStart: ((value: { accountId: string }) => void) | undefined;

  override start(listener: Parameters<ImSessionAdapter['start']>[0]): Promise<{ accountId: string }> {
    this.started += 1;
    void listener;
    return new Promise((resolve) => { this.resolveStart = resolve; });
  }

  override stop(): Promise<void> {
    this.stopped += 1;
    this.phase = 'stopped';
    this.resolveStart?.({ accountId: this.accountId });
    this.resolveStart = undefined;
    return Promise.resolve();
  }

  release(): void {
    this.phase = 'running';
    this.resolveStart?.({ accountId: this.accountId });
    this.resolveStart = undefined;
  }

  connectionPhase(): ReturnType<NonNullable<ImSessionAdapter['connectionPhase']>> {
    return this.phase;
  }

  connectionDetail(): ReturnType<NonNullable<ImSessionAdapter['connectionDetail']>> {
    return this.phase === 'auth_expired' ? { code: 'auth_expired', http_status: 200, errcode: -14 } : undefined;
  }
}

function connectionOf(value: object): string | undefined {
  if (!('connection' in value)) return undefined;
  const connection = value.connection;
  return typeof connection === 'string' ? connection : undefined;
}

async function until(read: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const started = Date.now();
  while (!await read()) {
    if (Date.now() - started > 5_000) throw new Error(label);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function storedState(openReply: boolean): string {
  return JSON.stringify({
    policy: { allowed: true, defaultEnabled: true },
    instances: [{ id: 'inst', providerKind: 'telegram', listening: true, virtual: true, accountId: '42' }],
    discoveries: [],
    bindings: [{
      id: 'b-kept', providerInstanceId: 'inst', providerKind: 'telegram', accountId: '42',
      identity: { chatId: 'c1', senderId: 'u1', topicId: '0' }, sessionId: 'sess-original',
      enabled: true, busy: 'queue', reply: 'final', mobileInteractions: true,
    }],
    strangers: [], seen: [], tickets: [], selections: {}, awaiting: {}, voiceFallbacks: 0, cursors: {}, notices: [],
    questionAnswers: {}, answeredQuestions: {},
    replies: openReply ? [{ bindingId: 'b-kept', promptId: 'im:inst:1', messageIds: [], lastText: '', fileSent: false, open: true }] : [],
    outbox: [],
  });
}

function harness(adapter: PendingAdapter, openReply: boolean) {
  let saved = storedState(openReply);
  const submitted: string[] = [];
  let reads = 0;
  const logs: string[] = [];
  const ports: ImSessionPorts = {
    credentials: {
      list: () => [{ id: 'inst', providerId: 'telegram', configured: true }],
      read: () => 'token-value',
      write: async () => undefined,
      check: async () => ({ ok: true, accountId: '42' }),
    },
    sessions: {
      listPersonas: async () => [{ id: 'ada', name: 'Ada', homeSessionId: 'home' }],
      listSessions: async () => [{ id: 'sess-original', title: 'Original' }, { id: 'sess-next', title: 'Next' }],
      owns: async (sessionId) => sessionId === 'sess-original' || sessionId === 'sess-next',
      ensureHome: async () => ({ homeSessionId: 'home' }),
      activity: async () => ({ busy: false, pending: 'none', queueLength: 0 }),
      submit: async (input) => { submitted.push(input.promptId); return { duplicate: false, promptId: input.promptId, deliveryState: 'pending' }; },
      steer: async () => 'steered',
      abort: async () => false,
      saveMedia: async () => [],
      readVisible: async () => { reads += 1; return { text: 'model-reply', done: true, media: [] }; },
      listInteractions: async () => ({ approvals: [], questions: [] }),
      decideApproval: async () => 'decided',
      decideHostKey: async () => 'decided',
      answerQuestion: async () => 'answered',
    },
    logger: { info(fields, message) { logs.push(`${message}:${String(fields['connection'] ?? '')}`); } },
    load: async () => saved,
    save: async (value) => { saved = value; },
  };
  const bridge = new ImSessionBridge({
    ports, factories: [{ providerKind: 'telegram', create: () => adapter }], editIntervalMs: 0, now: () => 1_700_000_000_000, wait: async () => undefined,
  });
  return { bridge, submitted, logs, reads: () => reads, saved: () => saved };
}

describe('im session startup reconnect', () => {
  const open: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    const closing = open.splice(0);
    for (const item of closing) await item.close();
  });

  it('retains startup authentication failure metadata after cleanup without clearing listening intent', async () => {
    class AuthAdapter extends PendingAdapter {
      override start(_listener: Parameters<ImSessionAdapter['start']>[0]) {
        this.started += 1;
        this.phase = 'auth_expired';
        return Promise.resolve({ accountId: this.accountId, failed: 'auth' as const });
      }
    }
    const adapter = new AuthAdapter('telegram', '42');
    const held = harness(adapter, false);
    open.push(held.bridge);
    await held.bridge.setListening('inst', true);
    const snapshot = imSessionSnapshotSchema.parse(await held.bridge.snapshot());
    expect(snapshot.instances[0]).toMatchObject({ listening: true, adapter: 'stopped', connection: 'auth_expired', connection_detail: { code: 'auth_expired', http_status: 200, errcode: -14 } });
    expect(snapshot.bindings[0]?.id).toBe('b-kept');
    expect(adapter.stopped).toBe(1);
    await held.bridge.setListening('inst', false);
    expect((await held.bridge.snapshot()).instances[0]?.connection).toBeUndefined();
  });

  it('coalesces concurrent start requests before asynchronous conflict inspection finishes', async () => {
    const adapter = new PendingAdapter('telegram', '42');
    let resolve: () => void = () => undefined;
    const inspected = new Promise<void>((done) => { resolve = done; });
    adapter.describeConflict = async () => { await inspected; return 'none'; };
    const held = harness(adapter, false);
    open.push(held.bridge);
    await held.bridge.whenReady();
    const starts = Promise.all([
      held.bridge.setListening('inst', true),
      held.bridge.setListening('inst', true),
      held.bridge.setPolicy({ allowed: true, default_enabled: true }),
    ]);
    resolve();
    await starts;
    expect(adapter.started).toBe(1);
    adapter.release();
    await until(async () => (await held.bridge.snapshot()).instances[0]?.adapter === 'running', 'concurrent start did not publish');
    expect(adapter.started).toBe(1);
  });

  it('does not start after stop or close interrupts conflict inspection', async () => {
    for (const close of [false, true]) {
      const adapter = new PendingAdapter('telegram', '42');
      let resolve: () => void = () => undefined;
      let inspecting: () => void = () => undefined;
      const began = new Promise<void>((done) => { inspecting = done; });
      const inspected = new Promise<void>((done) => { resolve = done; });
      adapter.describeConflict = async () => { inspecting(); await inspected; return 'none'; };
      const held = harness(adapter, false);
      await held.bridge.whenReady();
      const start = held.bridge.setListening('inst', true);
      await began;
      const stop = close ? held.bridge.close() : held.bridge.setListening('inst', false);
      resolve();
      await Promise.all([start, stop]);
      expect(adapter.started).toBe(0);
      expect((await held.bridge.snapshot()).instances[0]?.adapter).toBe('stopped');
      await held.bridge.close();
    }
  });

  it.each(['auth_expired', 'stopped'] as const)('projects a terminal %s poller without losing intent or bindings and allows explicit retry', async (phase) => {
    const adapter = new PendingAdapter('telegram', '42');
    const held = harness(adapter, false);
    open.push(held.bridge);
    await held.bridge.setListening('inst', true);
    adapter.release();
    await until(async () => (await held.bridge.snapshot()).instances[0]?.adapter === 'running', 'initial listener did not publish');
    adapter.phase = phase;
    const terminal = imSessionSnapshotSchema.parse(await held.bridge.snapshot());
    expect(terminal.instances[0]).toMatchObject({ listening: true, adapter: 'stopped', connection: phase });
    if (phase === 'auth_expired') expect(terminal.instances[0]?.connection_detail).toEqual({ code: 'auth_expired', http_status: 200, errcode: -14 });
    expect(terminal.bindings[0]?.id).toBe('b-kept');
    expect(adapter.sent).toEqual([]);
    await held.bridge.setListening('inst', true);
    expect(adapter.started).toBe(2);
    adapter.release();
    await until(async () => (await held.bridge.snapshot()).instances[0]?.adapter === 'running', 'retry listener did not publish');
    const recovered = await held.bridge.snapshot();
    expect(recovered.instances[0]?.connection).toBeUndefined();
    expect(recovered.instances[0]?.connection_detail).toBeUndefined();
    expect(recovered.bindings).toEqual(terminal.bindings);
  });

  it('lists and retargets a saved binding while a pending adapter is still reconnecting', async () => {
    const adapter = new PendingAdapter('telegram', '42');
    adapter.phase = 'reconnecting';
    const held = harness(adapter, true);
    open.push(held.bridge);
    const started = Date.now();
    const outcome = await Promise.race([
      held.bridge.whenReady().then(() => held.bridge.snapshot()).then((snapshot) => held.bridge.setPolicy(snapshot.policy)).then(() => 'ready' as const),
      new Promise<'blocked'>((resolve) => { setTimeout(() => resolve('blocked'), 1_000); }),
    ]);
    expect(outcome).toBe('ready');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(adapter.started).toBe(1);
    const snap = await held.bridge.snapshot();
    expect(snap.bindings.map((item) => [item.id, item.session_id])).toEqual([['b-kept', 'sess-original']]);
    expect(snap.instances[0]?.listening).toBe(true);
    expect(snap.instances[0]?.adapter).toBe('stopped');
    expect(connectionOf(snap.instances[0] ?? {})).toBe('reconnecting');
    expect(held.logs).toContain('im session connecting:reconnecting');
    await held.bridge.updateBinding('b-kept', { target: { kind: 'session', session_id: 'sess-next' } });
    expect(JSON.parse(held.saved()).bindings[0].sessionId).toBe('sess-next');
    expect(held.reads()).toBe(0);
    expect(held.submitted).toEqual([]);
    expect(adapter.sent).toEqual([]);
    adapter.release();
    await until(() => adapter.sent.some((item) => item.text === 'model-reply'), 'reply did not resume after connect');
    const restored = await held.bridge.snapshot();
    expect(restored.bindings.map((item) => [item.id, item.session_id])).toEqual([['b-kept', 'sess-next']]);
    expect(restored.instances.map((item) => item.adapter)).toEqual(['running']);
    expect(connectionOf(restored.instances[0] ?? {})).toBeUndefined();
    expect(adapter.started).toBe(1);
    expect(held.submitted).toEqual([]);
    adapter.phase = 'reconnecting';
    expect(connectionOf((await held.bridge.snapshot()).instances[0] ?? {})).toBe('reconnecting');
    expect(adapter.started).toBe(1);
  });

  it('does not start the poller or resend after listening is cleared during recovery', async () => {
    const adapter = new PendingAdapter('telegram', '42');
    const held = harness(adapter, true);
    open.push(held.bridge);
    await held.bridge.whenReady();
    await held.bridge.setPolicy({ allowed: true, default_enabled: true });
    expect(held.reads()).toBe(0);
    await held.bridge.setListening('inst', false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const snap = await held.bridge.snapshot();
    expect(snap.instances[0]?.listening).toBe(false);
    expect(snap.instances[0]?.adapter).toBe('stopped');
    expect(connectionOf(snap.instances[0] ?? {})).toBeUndefined();
    expect(adapter.stopped).toBeGreaterThan(0);
    expect(adapter.sent).toEqual([]);
    expect(held.reads()).toBe(0);
    expect(held.submitted).toEqual([]);
    expect(held.logs.some((item) => item.startsWith('im session connected'))).toBe(false);
  });

  it('defers an event admitted before start resolves and ingests that event once it is published', async () => {
    let state: SessionRunState = 'starting';
    let resolveStart: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => { resolveStart = resolve; });
    const raw = {
      platform: 'telegram' as const,
      instance_id: 'inst',
      account: { platform: 'telegram' as const, account_id: '42' },
      limits: { text_characters: 4096, text_utf8_bytes: null, callback_data_bytes: 64, voice_mime: ['audio/ogg'] as const, image_bytes: null, file_bytes: null },
      get state() { return state; },
      sink: undefined as SessionSink | undefined,
      start(sink: SessionSink) { raw.sink = sink; return pending; },
      stop() { state = 'stopped'; resolveStart(); return Promise.resolve(); },
      send() { return Promise.resolve({ status: 'accepted' as const, message_ids: ['m1'] }); },
    };
    const submitted: string[] = [];
    let saved = storedState(false);
    const ports: ImSessionPorts = {
      credentials: {
        list: () => [{ id: 'inst', providerId: 'telegram', configured: true }],
        read: () => 'token-value',
        write: async () => undefined,
        check: async () => ({ ok: true, accountId: '42' }),
      },
      sessions: {
        listPersonas: async () => [],
        listSessions: async () => [],
        owns: async () => true,
        ensureHome: async () => ({ homeSessionId: 'home' }),
        activity: async () => ({ busy: false, pending: 'none', queueLength: 0 }),
        submit: async (input) => { submitted.push(input.promptId); return { duplicate: false, promptId: input.promptId, deliveryState: 'pending' }; },
        steer: async () => 'steered',
        abort: async () => false,
        saveMedia: async () => [],
        readVisible: async () => ({ text: '', done: true, media: [] }),
        listInteractions: async () => ({ approvals: [], questions: [] }),
        decideApproval: async () => 'decided',
        decideHostKey: async () => 'decided',
        answerQuestion: async () => 'answered',
      },
      logger: { info() {} },
      load: async () => saved,
      save: async (value) => { saved = value; },
    };
    const bridge = new ImSessionBridge({
      ports,
      factories: [{ providerKind: 'telegram', create: () => new HubSessionAdapter(raw) }],
      editIntervalMs: 0,
      now: () => 1_700_000_000_000,
      wait: async () => undefined,
    });
    open.push(bridge);
    const inbound = (eventKey: string) => ({
      event_key: eventKey,
      platform_event_id: eventKey,
      cursor: '1',
      identity: { platform: 'telegram' as const, account_id: '42', chat_id: 'c1', sender_id: 'u1', topic_id: '0' },
      payload: { type: 'text' as const, text: 'hello' },
    });
    await bridge.whenReady();
    await bridge.setPolicy({ allowed: true, default_enabled: true });
    const sink = raw.sink;
    if (sink === undefined) throw new Error('sink missing');
    expect(await sink.admit(inbound('tg:1'))).toEqual({ decision: 'defer' });
    expect(submitted).toEqual([]);
    expect(imSessionSnapshotSchema.parse(await bridge.snapshot()).instances[0]?.connection).toBe('starting');
    state = 'running';
    resolveStart();
    await until(async () => (await bridge.snapshot()).instances[0]?.adapter === 'running', 'listener did not publish');
    expect((await sink.admit(inbound('tg:1'))).decision).toBe('accepted');
    expect(submitted).toEqual(['im:inst:tg:1']);
    expect((await sink.admit(inbound('tg:1'))).decision).toBe('accepted');
    expect(submitted).toEqual(['im:inst:tg:1']);
    expect(imSessionSnapshotSchema.parse(await bridge.snapshot()).instances[0]?.connection).toBeUndefined();
    await bridge.setListening('inst', false);
    expect(await sink.admit(inbound('tg:2'))).toEqual({ decision: 'defer' });
    expect(submitted).toEqual(['im:inst:tg:1']);
  });

  it('does not resume a model reply when the bridge closes during recovery', async () => {
    const adapter = new PendingAdapter('telegram', '42');
    const held = harness(adapter, true);
    await held.bridge.whenReady();
    await held.bridge.setPolicy({ allowed: true, default_enabled: true });
    const started = Date.now();
    await held.bridge.close();
    expect(Date.now() - started).toBeLessThan(1_000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(adapter.sent).toEqual([]);
    expect(held.reads()).toBe(0);
    expect(held.submitted).toEqual([]);
  });

  it('keeps one real OneBot poller across a refused socket and restores the saved target', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-im-reconnect-'));
    const port = await freePort();
    let server: WebSocketServer | undefined;
    let bridge: ImSessionBridge | undefined;
    try {
      bridge = oneBotBridge(home, port);
      open.push(bridge);
      const started = Date.now();
      await bridge.whenReady();
      await bridge.setPolicy({ allowed: true, default_enabled: true });
      expect(Date.now() - started).toBeLessThan(1_000);
      await until(async () => connectionOf((await bridge!.snapshot()).instances[0] ?? {}) === 'reconnecting', 'closed port did not report reconnecting');
      const offline = await bridge.snapshot();
      expect(offline.instances[0]?.listening).toBe(true);
      expect(offline.instances[0]?.adapter).toBe('stopped');
      expect(offline.bindings.map((item) => [item.id, item.session_id])).toEqual([['b-kept', 'sess-original']]);
      await bridge.updateBinding('b-kept', { target: { kind: 'session', session_id: 'sess-next' } });
      server = await listen(port);
      let sockets = 0;
      server.on('connection', () => { sockets += 1; });
      await until(async () => (await bridge!.snapshot()).instances[0]?.adapter === 'running', 'listener did not recover');
      const online = await bridge.snapshot();
      expect(online.bindings.map((item) => [item.id, item.session_id])).toEqual([['b-kept', 'sess-next']]);
      expect(connectionOf(online.instances[0] ?? {})).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(sockets).toBe(1);
      expect(server.clients.size).toBe(1);
    } finally {
      await bridge?.close();
      open.splice(0);
      if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });

  it('does not open a late OneBot socket after listening is cleared during reconnect', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-im-reconnect-'));
    const port = await freePort();
    let server: WebSocketServer | undefined;
    let bridge: ImSessionBridge | undefined;
    try {
      bridge = oneBotBridge(home, port);
      open.push(bridge);
      await bridge.whenReady();
      await bridge.setPolicy({ allowed: true, default_enabled: true });
      await until(async () => connectionOf((await bridge!.snapshot()).instances[0] ?? {}) === 'reconnecting', 'closed port did not report reconnecting');
      await bridge.setListening('inst', false);
      server = await listen(port);
      let sockets = 0;
      server.on('connection', () => { sockets += 1; });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const snap = await bridge.snapshot();
      expect(snap.instances[0]?.listening).toBe(false);
      expect(snap.instances[0]?.adapter).not.toBe('running');
      expect(sockets).toBe(0);
      expect(server.clients.size).toBe(0);
    } finally {
      await bridge?.close();
      open.splice(0);
      if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });
});

function oneBotBridge(home: string, port: number): ImSessionBridge {
  let saved = JSON.stringify({
    policy: { allowed: true, defaultEnabled: true },
    instances: [{ id: 'inst', providerKind: 'onebot_v11', listening: true, virtual: true, accountId: `127.0.0.1:${port}` }],
    discoveries: [],
    bindings: [{
      id: 'b-kept', providerInstanceId: 'inst', providerKind: 'onebot_v11', accountId: `127.0.0.1:${port}`,
      identity: { chatId: '20002', senderId: '20002', topicId: '0' }, sessionId: 'sess-original',
      enabled: true, busy: 'queue', reply: 'final', mobileInteractions: true,
    }],
    strangers: [], seen: [], tickets: [], selections: {}, awaiting: {}, voiceFallbacks: 0, cursors: {}, notices: [],
    questionAnswers: {}, answeredQuestions: {}, replies: [], outbox: [],
  });
  const ports: ImSessionPorts = {
    credentials: {
      list: () => [{ id: 'inst', providerId: 'onebot_v11', configured: true }],
      read: () => JSON.stringify({ mode: 'forward', endpoint: `ws://127.0.0.1:${port}/onebot` }),
      write: async () => undefined,
      check: async () => ({ ok: true, accountId: `127.0.0.1:${port}` }),
    },
    sessions: {
      listPersonas: async () => [],
      listSessions: async () => [],
      owns: async (sessionId) => sessionId === 'sess-original' || sessionId === 'sess-next',
      ensureHome: async () => ({ homeSessionId: 'home' }),
      activity: async () => ({ busy: false, pending: 'none', queueLength: 0 }),
      submit: async (input) => ({ duplicate: false, promptId: input.promptId, deliveryState: 'pending' }),
      steer: async () => 'steered',
      abort: async () => false,
      saveMedia: async () => [],
      readVisible: async () => ({ text: '', done: true, media: [] }),
      listInteractions: async () => ({ approvals: [], questions: [] }),
      decideApproval: async () => 'decided',
      decideHostKey: async () => 'decided',
      answerQuestion: async () => 'answered',
    },
    logger: { info() {} },
    load: async () => saved,
    save: async (value) => { saved = value; },
  };
  return new ImSessionBridge({
    ports, factories: loadHubFactories(home), editIntervalMs: 0, now: () => 1_700_000_000_000, wait: async () => undefined,
  });
}

async function freePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', () => resolve()));
  const address = reservation.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  return port;
}

function listen(port: number): Promise<WebSocketServer> {
  const server = new WebSocketServer({ host: '127.0.0.1', port });
  return new Promise((resolve, reject) => {
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}
