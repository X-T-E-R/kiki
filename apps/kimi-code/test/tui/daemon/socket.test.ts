import { describe, expect, it, vi } from 'vitest';

import { DaemonSocket } from '#/tui/daemon/socket';

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  readonly url: string;
  readonly protocols: string[];
  readyState = FakeWebSocket.OPEN;
  private readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>();

  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = String(url);
    this.protocols = typeof protocols === 'string' ? [protocols] : (protocols ?? []);
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }

  message(value: unknown): void {
    this.emit('message', { data: JSON.stringify(value) });
  }

  private emit(type: string, event: { data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe('DaemonSocket', () => {
  it('handshakes, subscribes transcript grades, and routes transcript ops', () => {
    FakeWebSocket.instances = [];
    const onTranscript = vi.fn();
    const onFrame = vi.fn();
    const socket = new DaemonSocket({
      url: 'http://127.0.0.1:57580',
      token: 'secret',
      WebSocket: FakeWebSocket as never,
      events: {
        onTranscript,
        onFrame,
        onResyncRequired: vi.fn(),
        onSubscribeAck: vi.fn(),
      },
    });

    socket.connect();
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe('ws://127.0.0.1:57580/api/v1/ws');
    expect(ws.protocols).toEqual(['kimi-code.bearer.secret']);

    socket.subscribe('session-1', { seq: 7, epoch: 'session-epoch' });
    expect(ws.sent).toEqual([]);
    ws.message({ type: 'server_hello', payload: {} });

    const sent = ws.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
    expect(sent.map((frame) => frame['type'])).toEqual([
      'client_hello',
      'subscribe',
      'subscribe_v2',
    ]);
    expect(sent[2]?.['payload']).toMatchObject({
      session_id: 'session-1',
      transcript: { '*': 'turn', main: 'delta' },
    });

    ws.message({
      type: 'transcript.ops',
      seq: 8,
      epoch: 'session-epoch',
      volatile: true,
      session_id: 'session-1',
      payload: {
        type: 'transcript.ops',
        session_id: 'session-1',
        agent_id: 'main',
        ops: [],
        cursor: { seq: 3, epoch: 'transcript-epoch' },
        through_seq: 3,
      },
    });
    expect(onTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'transcript.ops', session_id: 'session-1' }),
      1,
    );

    ws.message({
      type: 'event.session.work_changed',
      seq: 9,
      epoch: 'session-epoch',
      session_id: 'session-1',
      payload: { type: 'event.session.work_changed' },
    });
    expect(onFrame).toHaveBeenCalledWith(
      expect.objectContaining({ seq: 9, session_id: 'session-1' }),
      1,
    );
    socket.close();
  });
});
