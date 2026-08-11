import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  terminalAttachMessageSchema,
  terminalDetachMessageSchema,
  terminalInputMessageSchema,
  terminalResizeMessageSchema,
} from '@moonshot-ai/protocol';

import { KikiSocket, type TerminalSignal, type WsEvents } from './ws';

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
