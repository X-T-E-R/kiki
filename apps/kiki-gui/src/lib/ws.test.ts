import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  terminalAttachMessageSchema,
  terminalDetachMessageSchema,
  terminalInputMessageSchema,
  terminalResizeMessageSchema,
} from '@moonshot-ai/protocol';

import { KikiSocket, type TerminalSignal, type WsEvents, type WsStatus } from './ws';

interface SentFrame {
  readonly type: string;
  readonly id?: string;
  readonly payload?: unknown;
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: SentFrame[] = [];
  deferCloseEvent = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string, readonly protocols?: string[]) {
    FakeWebSocket.instances.push(this);
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as SentFrame);
  }

  close(code = 1000): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    if (!this.deferCloseEvent) this.emitClose(code);
  }

  emitClose(code = 1000): void {
    this.onclose?.({ code } as CloseEvent);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
}

function makeSocket(signals: TerminalSignal[]) {
  const events: WsEvents = {
    onStatus: () => {},
    onFrame: () => {},
    onResyncRequired: () => {},
    onSubscribeAck: () => {},
  };
  const socket = new KikiSocket({ baseUrl: 'http://example.test', events });
  socket.onTerminalSignal((signal) => { signals.push(signal); });
  socket.connect();
  return { socket, wire: FakeWebSocket.instances.at(-1)! };
}

function hello(wire: FakeWebSocket): void {
  wire.open();
  wire.receive({ type: 'server_hello', payload: {} });
}

async function flushSocket(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('KikiSocket fatal recovery', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: FakeWebSocket,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, 'WebSocket');
  });

  function statusSocket(): { socket: KikiSocket; statuses: WsStatus[] } {
    const statuses: WsStatus[] = [];
    const events: WsEvents = {
      onStatus: (status) => { statuses.push(status); },
      onFrame: () => {},
      onResyncRequired: () => {},
      onSubscribeAck: () => {},
    };
    const socket = new KikiSocket({ baseUrl: 'http://example.test', events });
    socket.connect();
    return { socket, statuses };
  }

  /** Burn the pending reconnect timer (jitter keeps the delay under step*1.25). */
  const fireReconnect = () => vi.advanceTimersByTime(11_000);

  it('bounds repeated fatal retries and lets a foreground nudge recover', () => {
    vi.useFakeTimers();
    const { socket, statuses } = statusSocket();
    const wire = FakeWebSocket.instances.at(-1)!;
    hello(wire);

    wire.receive({ type: 'error', payload: { fatal: true, msg: 'protocol too old' } });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      fireReconnect();
      const retry = FakeWebSocket.instances.at(-1)!;
      expect(statuses.at(-1)).toBe('connecting');
      retry.receive({ type: 'error', payload: { fatal: true, msg: 'still incompatible' } });
      expect(statuses.at(-1)).toBe('closed');
    }
    expect(FakeWebSocket.instances).toHaveLength(5);

    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(5);

    socket.nudge();
    expect(FakeWebSocket.instances).toHaveLength(6);
    expect(statuses.at(-1)).toBe('connecting');
    socket.close();
  });

  it('clears fatal mode once a retry hello lands, restoring unbounded backoff', () => {
    vi.useFakeTimers();
    const { socket } = statusSocket();
    const wire = FakeWebSocket.instances.at(-1)!;
    hello(wire);
    wire.receive({ type: 'error', payload: { fatal: true, msg: 'restart required' } });

    fireReconnect();
    const retry = FakeWebSocket.instances.at(-1)!;
    hello(retry);
    expect(socket.ready).toBe(true);

    // A normal drop after recovery reconnects on the usual ladder (not the
    // fatal budget): closing and burning one timer opens a fresh transport.
    retry.close(1006);
    fireReconnect();
    expect(FakeWebSocket.instances.at(-1)).not.toBe(retry);
    socket.close();
  });

  it('stays down after a manual close even when nudged', () => {
    vi.useFakeTimers();
    const { socket } = statusSocket();
    const wire = FakeWebSocket.instances.at(-1)!;
    hello(wire);

    socket.close();
    fireReconnect();
    vi.advanceTimersByTime(60_000);
    socket.nudge();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('KikiSocket transport watchdog', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: FakeWebSocket,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, 'WebSocket');
  });

  function statusSocket(): { socket: KikiSocket; statuses: WsStatus[] } {
    const statuses: WsStatus[] = [];
    const events: WsEvents = {
      onStatus: (status) => { statuses.push(status); },
      onFrame: () => {},
      onResyncRequired: () => {},
      onSubscribeAck: () => {},
    };
    const socket = new KikiSocket({ baseUrl: 'http://example.test', events });
    socket.connect();
    return { socket, statuses };
  }

  it('uses one creation-to-hello deadline and ignores the detached socket', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { socket, statuses } = statusSocket();
    const first = FakeWebSocket.instances.at(-1)!;
    first.deferCloseEvent = true;

    vi.advanceTimersByTime(6000);
    first.open();
    vi.advanceTimersByTime(5999);
    expect(statuses.at(-1)).toBe('connecting');
    vi.advanceTimersByTime(1);
    expect(statuses.at(-1)).toBe('closed');

    first.emitClose(1006);
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const replacement = FakeWebSocket.instances.at(-1)!;
    hello(replacement);

    first.open();
    first.emitClose(1006);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(statuses.at(-1)).toBe('open');
    expect(socket.ready).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    socket.close();
  });
});

describe('KikiSocket terminal channel', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: FakeWebSocket,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'WebSocket');
  });

  it('sends protocol-valid controls and lifts terminal events out of the session stream', async () => {
    const signals: TerminalSignal[] = [];
    const { socket, wire } = makeSocket(signals);
    hello(wire);

    const attached = socket.terminalAttach('sess_a', 'term_a');
    const attachFrame = wire.sent.at(-1)!;
    expect(terminalAttachMessageSchema.safeParse(attachFrame).success).toBe(true);
    wire.receive({
      type: 'ack',
      id: attachFrame.id,
      code: 0,
      payload: { attached: true, replayed: 2, earliest_seq: 1, truncated: false },
    });
    await expect(attached).resolves.toEqual({ replayed: 2, earliestSeq: 1, truncated: false });

    socket.terminalInput('sess_a', 'term_a', 'echo ok\r');
    expect(terminalInputMessageSchema.safeParse(wire.sent.at(-1)).success).toBe(true);
    socket.terminalResize('sess_a', 'term_a', 120, 36);
    expect(terminalResizeMessageSchema.safeParse(wire.sent.at(-1)).success).toBe(true);

    wire.receive({
      type: 'terminal_output',
      seq: 3,
      session_id: 'sess_a',
      terminal_id: 'term_a',
      timestamp: '2026-08-11T00:00:00.000Z',
      payload: { data: 'ok\r\n' },
    });
    wire.receive({
      type: 'terminal_exit',
      session_id: 'sess_a',
      terminal_id: 'term_a',
      timestamp: '2026-08-11T00:00:01.000Z',
      payload: { exit_code: 0 },
    });
    expect(signals).toEqual([
      {
        kind: 'attached',
        sessionId: 'sess_a',
        terminalId: 'term_a',
        replayed: 2,
        earliestSeq: 1,
        truncated: false,
      },
      { kind: 'output', sessionId: 'sess_a', terminalId: 'term_a', seq: 3, data: 'ok\r\n' },
      { kind: 'exit', sessionId: 'sess_a', terminalId: 'term_a', exitCode: 0 },
    ]);

    socket.terminalDetach('sess_a', 'term_a');
    expect(terminalDetachMessageSchema.safeParse(wire.sent.at(-1)).success).toBe(true);
    socket.close();
  });

  it('attaches a terminal tracked before the first server hello', async () => {
    const signals: TerminalSignal[] = [];
    const { socket, wire } = makeSocket(signals);
    await expect(socket.terminalAttach('sess_a', 'term_early')).rejects.toThrow(
      'socket is not connected',
    );

    hello(wire);

    const attaches = wire.sent.filter((frame) => frame.type === 'terminal_attach');
    expect(attaches).toHaveLength(1);
    expect(attaches[0]?.payload).toEqual({
      session_id: 'sess_a',
      terminal_id: 'term_early',
    });
    wire.receive({
      type: 'ack',
      id: attaches[0]?.id,
      code: 40414,
      msg: 'terminal not found',
      payload: {},
    });
    await Promise.resolve();
    expect(signals).toEqual([
      { kind: 'unavailable', sessionId: 'sess_a', terminalId: 'term_early' },
    ]);
    socket.terminalDetach('sess_a', 'term_early');
    socket.close();
  });

  it('reattaches only tracked terminals and resumes from their last output sequence', async () => {
    const signals: TerminalSignal[] = [];
    const { socket, wire } = makeSocket(signals);
    hello(wire);
    const firstAttach = socket.terminalAttach('sess_a', 'term_a');
    const firstAttachFrame = wire.sent.at(-1)!;
    wire.receive({
      type: 'ack',
      id: firstAttachFrame.id,
      code: 0,
      payload: { attached: true, replayed: 0, earliest_seq: null, truncated: false },
    });
    await firstAttach;
    wire.receive({
      type: 'terminal_output',
      seq: 7,
      session_id: 'sess_a',
      terminal_id: 'term_a',
      timestamp: '2026-08-11T00:00:00.000Z',
      payload: { data: 'latest' },
    });
    const secondAttach = socket.terminalAttach('sess_b', 'term_b');
    const secondAttachFrame = wire.sent.at(-1)!;
    wire.receive({
      type: 'ack',
      id: secondAttachFrame.id,
      code: 0,
      payload: { attached: true, replayed: 0, earliest_seq: null, truncated: false },
    });
    await secondAttach;
    socket.terminalDetach('sess_b', 'term_b');

    wire.close(1006);
    socket.nudge();
    const reconnected = FakeWebSocket.instances.at(-1)!;
    hello(reconnected);

    const attaches = reconnected.sent.filter((frame) => frame.type === 'terminal_attach');
    expect(attaches).toHaveLength(1);
    expect(attaches[0]?.payload).toEqual({
      session_id: 'sess_a',
      terminal_id: 'term_a',
      since_seq: 7,
    });
    reconnected.close(1006);
    await Promise.resolve();
    expect(signals).not.toContainEqual({
      kind: 'unavailable',
      sessionId: 'sess_a',
      terminalId: 'term_a',
    });
    socket.terminalDetach('sess_a', 'term_a');
    socket.close();
  });
});

describe('KikiSocket transcript subscribe', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: FakeWebSocket,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'WebSocket');
  });

  it('drops stale frames after restartGeneration', () => {
    const frames: unknown[] = [];
    const transcripts: unknown[] = [];
    const events: WsEvents = {
      onStatus: () => {},
      onFrame: (frame) => { frames.push(frame); },
      onTranscript: (event) => { transcripts.push(event); },
      onResyncRequired: () => {},
      onSubscribeAck: () => {},
    };
    const socket = new KikiSocket({
      baseUrl: 'http://example.test',
      events,
    });
    socket.connect();
    const first = FakeWebSocket.instances.at(-1)!;
    hello(first);
    socket.subscribe('sess_1', { seq: 0, epoch: 'e1' });
    expect(first.sent.some((frame) => frame.type === 'subscribe')).toBe(true);
    expect(first.sent.some((frame) => frame.type === 'subscribe_v2')).toBe(true);
    first.receive({
      type: 'transcript.reset',
      seq: 0,
      payload: {
        type: 'transcript.reset',
        session_id: 'sess_1',
        agent_id: 'main',
        snapshot: { items: [], tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {} },
        grade: 'delta',
        coverage: { kind: 'full', hasMoreOlder: false },
        cursor: { seq: 0, epoch: 'e1' },
      },
    });
    expect(transcripts).toHaveLength(1);

    const firstGeneration = socket.connectionGeneration;
    socket.restartGeneration();
    const second = FakeWebSocket.instances.at(-1)!;
    expect(socket.connectionGeneration).toBeGreaterThan(firstGeneration);
    first.receive({
      type: 'transcript.ops',
      seq: 0,
      payload: {
        type: 'transcript.ops',
        session_id: 'sess_1',
        agent_id: 'main',
        ops: [],
        cursor: { seq: 1, epoch: 'e1' },
        through_seq: 1,
      },
    });
    expect(transcripts).toHaveLength(1);
    hello(second);
    second.receive({
      type: 'session_event',
      seq: 12,
      payload: { type: 'assistant.delta', turnId: 1, delta: 'stale' },
    });
    expect(frames).toHaveLength(1);
    socket.close();
  });

  it('sends subscribe_v2 with per-agent grades and omits empty transcript_since', async () => {
    const socket = new KikiSocket({
      baseUrl: 'http://example.test',
      events: {
        onStatus: () => {},
        onFrame: () => {},
        onResyncRequired: () => {},
        onSubscribeAck: () => {},
      },
    });
    socket.connect();
    const wire = FakeWebSocket.instances.at(-1)!;
    hello(wire);
    socket.subscribe('sess_1', { seq: 4, epoch: 'e1' }, { '*': 'turn', main: 'delta', 'agent-research': 'delta' });
    const v2 = wire.sent.find((frame) => frame.type === 'subscribe_v2');
    expect(v2).toMatchObject({
      type: 'subscribe_v2',
      payload: {
        session_id: 'sess_1',
        transcript: { '*': 'turn', main: 'delta', 'agent-research': 'delta' },
      },
    });
    expect((v2?.payload as { transcript_since?: unknown } | undefined)?.transcript_since).toBeUndefined();
    socket.updateTranscriptSince('sess_1', 'main', { seq: 4, epoch: 'e1' });
    socket.subscribe('sess_1', { seq: 4, epoch: 'e1' }, { '*': 'turn', main: 'delta' });
    const later = [...wire.sent].reverse().find((frame) => frame.type === 'subscribe_v2');
    expect(later).toMatchObject({
      payload: {
        session_id: 'sess_1',
        transcript_since: { main: { seq: 4, epoch: 'e1' } },
      },
    });
    socket.close();
  });

  it('sends unsubscribe_v2 when detaching a transcript session', () => {
    const socket = new KikiSocket({
      baseUrl: 'http://example.test',
      events: {
        onStatus: () => {},
        onFrame: () => {},
        onResyncRequired: () => {},
        onSubscribeAck: () => {},
      },
    });
    socket.connect();
    const wire = FakeWebSocket.instances.at(-1)!;
    hello(wire);
    socket.subscribe('sess_1', { seq: 0, epoch: 'e1' });
    socket.unsubscribe('sess_1');
    expect(wire.sent.some((frame) => frame.type === 'unsubscribe_v2')).toBe(true);
    const v2 = wire.sent.find((frame) => frame.type === 'unsubscribe_v2');
    expect(v2).toMatchObject({ payload: { session_id: 'sess_1' } });
    socket.close();
  });
});
