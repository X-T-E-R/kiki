import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IConnectionRegistry } from '../src/transport/ws/connectionRegistry';
import type { SessionEventBroadcaster } from '../src/transport/ws/v1/sessionEventBroadcaster';
import {
  type WsConnectionV1Options,
  WsConnectionV1,
  coalesceFrames,
} from '../src/transport/ws/v1/wsConnectionV1';

class FakeSocket {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  terminateCalls = 0;
  private readonly handlers = new Map<string, Array<(...a: unknown[]) => void>>();

  on(event: string, cb: (...a: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }

  readonly fragmentBytes: number[] = [];
  private fragments: Buffer[] = [];

  send(data: string | Buffer, options?: { fin: boolean }, callback?: (error?: Error) => void): void {
    if (options === undefined) this.sent.push(data.toString());
    else {
      this.fragmentBytes.push(Buffer.byteLength(data));
      this.fragments.push(Buffer.from(data));
      if (options.fin) {
        this.sent.push(Buffer.concat(this.fragments).toString());
        this.fragments = [];
      }
    }
    callback?.();
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = this.CLOSED;
    this.emit('close');
  }

  terminate(): void {
    this.terminateCalls += 1;
    this.readyState = this.CLOSED;
    this.emit('close');
  }

  emit(event: string, ...a: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...a);
  }

  frames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function makeBroadcaster(): SessionEventBroadcaster {
  return {
    subscribe: async () => true,
    unsubscribe: () => {},
    addGlobalTarget: () => {},
    removeGlobalTarget: () => {},
    getCursor: async () => ({ seq: 0, epoch: '' }),
    getBufferedSince: async () => ({
      events: [],
      resyncRequired: false,
      currentSeq: 0,
      epoch: '',
    }),
  } as unknown as SessionEventBroadcaster;
}

function makeRegistry(): IConnectionRegistry {
  return {
    add: () => {},
    remove: () => {},
    get: () => undefined,
    values: () => [],
    closeAll: () => {},
    size: () => 0,
  };
}

function makeConn(socket: FakeSocket, opts: Partial<WsConnectionV1Options> = {}): WsConnectionV1 {
  return new WsConnectionV1({
    socket: socket as unknown as WebSocket,
    broadcaster: makeBroadcaster(),
    connectionRegistry: makeRegistry(),
    remoteAddress: null,
    userAgent: null,
    ...opts,
  });
}

function delta(
  sessionId: string,
  agentId: string,
  turnId: number,
  text: string,
  offset: number,
  type: 'assistant.delta' | 'thinking.delta' = 'assistant.delta',
) {
  return {
    type,
    seq: 1,
    volatile: true as const,
    offset,
    session_id: sessionId,
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: { type, agentId, sessionId, turnId, delta: text },
  };
}

function durable(type: string, sessionId: string, seq: number) {
  return {
    type,
    seq,
    session_id: sessionId,
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: { type, agentId: 'main', sessionId },
  };
}

describe('large transcript transfers', () => {
  it('keeps a progressing real socket alive across heartbeat cycles', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('Expected TCP listener');
    const accepted = once(server, 'connection');
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const messages: Array<{ type: string; payload?: unknown }> = [];
    client.on('message', (data) => {
      const text = Buffer.isBuffer(data)
        ? data.toString()
        : Array.isArray(data)
          ? Buffer.concat(data).toString()
          : Buffer.from(data).toString();
      const message = JSON.parse(text);
      messages.push(message);
      if (message.type === 'ping') client.send(JSON.stringify({ type: 'pong' }));
    });
    const [socket] = await accepted as [WebSocket];
    const original = socket.send.bind(socket);
    const fragmentSend = vi.spyOn(socket, 'send').mockImplementation(((data: Buffer, options: { fin?: boolean }, callback?: (error?: Error) => void) => {
      if (typeof options?.fin === 'boolean') original(data, options, (error) => setTimeout(() => callback?.(error), 25));
      else original(data);
    }) as typeof socket.send);
    const conn = new WsConnectionV1({ socket, broadcaster: makeBroadcaster(), connectionRegistry: makeRegistry(), remoteAddress: null, userAgent: null, heartbeatIntervalMs: 10 });
    try {
      const frame = { ...durable('transcript.reset', 's1', 1), payload: { text: 'x'.repeat(256 * 1024) } };
      conn.send(frame);
      await conn.drain();
      await vi.waitFor(() => expect(messages).toContainEqual(frame));
      expect(socket.readyState).toBe(WebSocket.OPEN);
      expect(fragmentSend.mock.calls.filter((call) => typeof call[1] === 'object' && call[1]?.fin !== undefined).length).toBeGreaterThan(2);
    } finally {
      client.close();
      conn.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('fragments queued transcripts after another fragmented message and after backpressure', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { heartbeatIntervalMs: 0 });
    const a = { ...durable('transcript.reset', 's1', 1), payload: { text: 'a'.repeat(128 * 1024) } };
    const b = { ...durable('transcript.ops', 's2', 2), payload: { text: 'b'.repeat(128 * 1024) } };
    conn.send(a);
    conn.send(b);
    await conn.drain();
    expect(socket.frames().slice(1)).toEqual([a, b]);
    expect(socket.fragmentBytes.length).toBe(6);
    expect(Math.max(...socket.fragmentBytes)).toBeLessThanOrEqual(65536);
    socket.bufferedAmount = 2 << 20;
    conn.send(durable('before-transcript', 's1', 3));
    conn.send(b);
    socket.bufferedAmount = 0;
    conn.send(a);
    await conn.drain();
    expect(socket.fragmentBytes.length).toBe(12);
    expect(socket.frames().slice(-3)).toEqual([durable('before-transcript', 's1', 3), b, a]);
    expect(socket.terminateCalls).toBe(0);
    conn.close();
  });

  it('terminates a truly stalled fragment without injecting a JSON heartbeat', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const conn = makeConn(socket, { heartbeatIntervalMs: 10_000 });
    const original = socket.send.bind(socket);
    socket.send = (data, options) => original(data, options);
    try {
      conn.send({ ...durable('transcript.reset', 's1', 1), payload: { text: 'x'.repeat(128 * 1024) } });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(socket.closeCalls).toHaveLength(0);
      expect(socket.terminateCalls).toBe(0);
      expect(socket.frames().some((frame) => (frame as { type: string }).type === 'ping')).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(socket.terminateCalls).toBeGreaterThan(0);
    } finally {
      conn.close();
      vi.useRealTimers();
    }
  });
  it('drains a single oversized item atomically with bounded fragments and ordered following traffic', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { heartbeatIntervalMs: 0 });
    const envelope = { ...durable('transcript.reset', 'example-session', 1), payload: { text: '恢复😀'.repeat(600_000) } };
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeGreaterThan(4 << 20);
    conn.send(envelope);
    conn.send(durable('after-reset', 'example-session', 2));
    expect(socket.frames().some((frame) => (frame as { type: string }).type === 'transcript.reset')).toBe(false);
    await conn.drain();
    expect(socket.terminateCalls).toBe(0);
    expect(Math.max(...socket.fragmentBytes)).toBeLessThanOrEqual(64 * 1024);
    expect(socket.frames().slice(1)).toEqual([envelope, durable('after-reset', 'example-session', 2)]);
    conn.close();
  });

  it('does not enqueue the next fragment until the socket write completes', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { heartbeatIntervalMs: 0 });
    const original = socket.send.bind(socket);
    let complete: (() => void) | undefined;
    socket.send = (data, options, callback) => {
      original(data, options);
      complete = () => callback?.();
    };
    conn.send({ ...durable('transcript.reset', 'example-session', 1), payload: { text: 'x'.repeat(5 << 20) } });
    expect(socket.fragmentBytes).toHaveLength(1);
    await Promise.resolve();
    expect(socket.fragmentBytes).toHaveLength(1);
    complete?.();
    await Promise.resolve();
    expect(socket.fragmentBytes).toHaveLength(2);
    expect(socket.terminateCalls).toBe(0);
    conn.close();
    complete?.();
  });
});

describe('coalesceFrames', () => {
  it('merges adjacent compatible assistant deltas', () => {
    const out = coalesceFrames([
      delta('s1', 'main', 1, 'Hello', 0),
      delta('s1', 'main', 1, ' ', 5),
      delta('s1', 'main', 1, 'world', 6),
    ]);
    expect(out).toHaveLength(1);
    const f = out[0] as { offset: number; volatile: boolean; seq: number; payload: { delta: string } };
    expect(f.payload.delta).toBe('Hello world');
    expect(f.offset).toBe(0);
    expect(f.volatile).toBe(true);
    expect(f.seq).toBe(1);
  });

  it('does not merge across a durable frame', () => {
    const out = coalesceFrames([
      delta('s1', 'main', 1, 'a', 0),
      durable('turn.ended', 's1', 2),
      delta('s1', 'main', 1, 'b', 1),
    ]);
    expect(out).toHaveLength(3);
    expect((out[0] as { payload: { delta: string } }).payload.delta).toBe('a');
    expect((out[1] as { type: string }).type).toBe('turn.ended');
    expect((out[2] as { payload: { delta: string } }).payload.delta).toBe('b');
  });

  it('does not merge different delta types', () => {
    const out = coalesceFrames([
      delta('s1', 'main', 1, 'hi', 0, 'assistant.delta'),
      delta('s1', 'main', 1, 'think', 0, 'thinking.delta'),
    ]);
    expect(out).toHaveLength(2);
  });

  it('does not merge deltas from different sessions / agents / turns', () => {
    expect(
      coalesceFrames([delta('s1', 'main', 1, 'a', 0), delta('s2', 'main', 1, 'b', 0)]),
    ).toHaveLength(2);
    expect(
      coalesceFrames([delta('s1', 'main', 1, 'a', 0), delta('s1', 'sub', 1, 'b', 0)]),
    ).toHaveLength(2);
    expect(
      coalesceFrames([delta('s1', 'main', 1, 'a', 0), delta('s1', 'main', 2, 'b', 0)]),
    ).toHaveLength(2);
  });

  it('leaves non-volatile and non-text frames untouched', () => {
    const toolCallDelta = {
      type: 'tool.call.delta',
      seq: 1,
      volatile: true as const,
      session_id: 's1',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: { type: 'tool.call.delta', agentId: 'main', turnId: 1, args: { x: 1 } },
    };
    expect(coalesceFrames([toolCallDelta, toolCallDelta])).toHaveLength(2);
  });

  it('does not mutate the input frames', () => {
    const a = delta('s1', 'main', 1, 'a', 0);
    const b = delta('s1', 'main', 1, 'b', 1);
    const out = coalesceFrames([a, b]);
    expect(out).toHaveLength(1);
    expect(a.payload.delta).toBe('a');
    expect(b.payload.delta).toBe('b');
  });

  it('handles empty and single-element input', () => {
    expect(coalesceFrames([])).toEqual([]);
    const only = delta('s1', 'main', 1, 'x', 0);
    const out = coalesceFrames([only]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(only);
  });
});

describe('WsConnectionV1 transcript subscriptions (subscribe_v2)', () => {
  interface SubscribeCall {
    sessionId: string;
    filter: unknown;
    grades: unknown;
    opts?: {
      deferTranscriptReset?: boolean;
      transcriptSince?: Record<string, number>;
    };
  }

  function makeCapturingBroadcaster(): {
    broadcaster: SessionEventBroadcaster;
    calls: SubscribeCall[];
    detaches: { sessionId: string; agentIds?: readonly string[] }[];
  } {
    const calls: SubscribeCall[] = [];
    const detaches: { sessionId: string; agentIds?: readonly string[] }[] = [];
    const broadcaster = {
      subscribe: async (
        sessionId: string,
        _target: unknown,
        filter: unknown,
        grades: unknown,
        opts?: {
          deferTranscriptReset?: boolean;
          transcriptSince?: Record<string, number>;
        },
      ) => {
        calls.push({ sessionId, filter, grades, opts });
        return true;
      },
      unsubscribe: () => {},
      unsubscribeTranscript: (sessionId: string, _target: unknown, agentIds?: readonly string[]) => {
        detaches.push({ sessionId, agentIds });
      },
      addGlobalTarget: () => {},
      removeGlobalTarget: () => {},
      getCursor: async () => ({ seq: 0, epoch: '' }),
      getBufferedSince: async () => ({
        events: [],
        resyncRequired: false,
        currentSeq: 0,
        epoch: '',
      }),
    } as unknown as SessionEventBroadcaster;
    return { broadcaster, calls, detaches };
  }

  function controlFrame(type: string, payload: Record<string, unknown>): string {
    return JSON.stringify({ type, id: 'req-1', payload });
  }

  it('forwards subscribe_v2 grades and transcript_since to the broadcaster and stores them per session', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', {
        session_id: 's1',
        transcript: { '*': 'delta' },
        transcript_since: { main: 7, '*': 3 },
      }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0]).toMatchObject({
      sessionId: 's1',
      grades: { '*': 'delta' },
      opts: {
        transcriptSince: {
          main: { epoch: undefined, seq: 7 },
          '*': { epoch: undefined, seq: 3 },
        },
      },
    });
    expect(conn.subscriptions.get('s1')).toEqual({
      agentFilter: undefined,
      transcriptGrades: { '*': 'delta' },
    });
    await vi.waitFor(() =>
      expect(socket.sent.some((f) => JSON.parse(f).type === 'ack')).toBe(true),
    );
    const ack = socket.sent.map((f) => JSON.parse(f)).find((f) => f.type === 'ack');
    expect(ack).toMatchObject({ code: 0, payload: { accepted: ['s1'], not_found: [] } });
    conn.close();
  });

  it('ignores legacy transcript fields on client_hello and subscribe', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('client_hello', {
        client_id: 'c1',
        subscriptions: ['s1'],
        transcript: { s1: { '*': 'delta' } },
        transcript_since: { s1: { main: 7 } },
      }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ sessionId: 's1', grades: undefined });
    expect(calls[0]!.opts?.transcriptSince).toBeUndefined();
    expect(conn.subscriptions.get('s1')).toEqual({
      agentFilter: undefined,
      transcriptGrades: undefined,
    });

    socket.emit(
      'message',
      controlFrame('subscribe', {
        session_ids: ['s2'],
        transcript: { s2: { '*': 'delta' } },
      }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({ sessionId: 's2', grades: undefined });
    expect(conn.subscriptions.get('s2')).toEqual({
      agentFilter: undefined,
      transcriptGrades: undefined,
    });
    conn.close();
  });

  it('acks an invalid subscribe_v2 payload with an error and does not attach', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', {
        session_id: 's1',
        transcript: { main: 'everything' },
      }),
    );
    await vi.waitFor(() =>
      expect(socket.sent.some((f) => JSON.parse(f).type === 'ack')).toBe(true),
    );

    expect(calls).toHaveLength(0);
    expect(conn.subscriptions.size).toBe(0);
    const ack = socket.sent.map((f) => JSON.parse(f)).find((f) => f.type === 'ack');
    expect(ack.code).toBe(1);
    conn.close();
  });

  it('preserves the existing agent filter when subscribe_v2 updates the grades', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe', { session_ids: ['s1'], agent_filter: { s1: ['main'] } }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { main: 'block' } }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(calls[1]).toMatchObject({ sessionId: 's1', grades: { main: 'block' } });
    expect(calls[1]!.filter).toEqual(new Set(['main']));
    expect(conn.subscriptions.get('s1')).toEqual({
      agentFilter: new Set(['main']),
      transcriptGrades: { main: 'block' },
    });
    conn.close();
  });

  it('keeps subscribe_v2 grades across a plain re-subscribe and filters the cursor replay through them', async () => {
    const socket = new FakeSocket();
    const backlog = [
      durable('turn.started', 's1', 3),
      durable('assistant.delta', 's1', 4),
      durable('event.session.work_changed', 's1', 5),
    ];
    const PROJECTED = new Set(['turn.started', 'assistant.delta']);
    let seenGrades: unknown;
    const broadcaster = {
      subscribe: async (
        _sid: string,
        target: { send: (e: unknown) => void },
        _filter: unknown,
        _grades: unknown,
        opts?: { deferTranscriptReset?: boolean },
      ) => {
        if (opts?.deferTranscriptReset !== true) {
          target.send({ type: 'transcript.reset', seq: 10, session_id: 's1', payload: {} });
        }
        return true;
      },
      flushTranscriptSeed: async (_sid: string, target: { send: (e: unknown) => void }) => {
        target.send({ type: 'transcript.reset', seq: 10, session_id: 's1', payload: {} });
      },
      unsubscribe: () => {},
      addGlobalTarget: () => {},
      removeGlobalTarget: () => {},
      getCursor: async () => ({ seq: 10, epoch: 'e1' }),
      getBufferedSince: async (_sid: string, _cursor: unknown, _filter: unknown, grades: unknown) => {
        seenGrades = grades;
        return {
          events: backlog
            .filter((envelope) => grades === undefined || !PROJECTED.has(envelope.type))
            .map((envelope) => ({ seq: envelope.seq, envelope })),
          resyncRequired: false,
          currentSeq: 10,
          epoch: 'e1',
        };
      },
    } as unknown as SessionEventBroadcaster;
    const conn = makeConn(socket, { broadcaster, flushIntervalMs: 1 });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { '*': 'delta' } }),
    );
    await vi.waitFor(() => {
      const types = socket.frames().map((f) => (f as { type: string }).type);
      expect(types).toContain('transcript.reset');
    });
    expect(conn.subscriptions.get('s1')?.transcriptGrades).toEqual({ '*': 'delta' });

    socket.emit(
      'message',
      controlFrame('subscribe', {
        session_ids: ['s1'],
        cursors: { s1: { seq: 2, epoch: 'e1' } },
      }),
    );
    await vi.waitFor(() => expect(seenGrades).toEqual({ '*': 'delta' }));
    expect(conn.subscriptions.get('s1')?.transcriptGrades).toEqual({ '*': 'delta' });

    const types = socket.frames().map((f) => (f as { type: string }).type);
    expect(types).not.toContain('turn.started');
    expect(types).not.toContain('assistant.delta');
    expect(
      types.slice(types.indexOf('event.session.work_changed'), types.lastIndexOf('transcript.reset') + 1),
    ).toEqual(['event.session.work_changed', 'transcript.reset']);
    conn.close();
  });

  it('reports an unknown session in the subscribe_v2 ack not_found list', async () => {
    const socket = new FakeSocket();
    const { broadcaster } = makeCapturingBroadcaster();
    broadcaster.subscribe = async () => false;
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 'gone', transcript: { '*': 'delta' } }),
    );
    await vi.waitFor(() =>
      expect(socket.sent.some((f) => JSON.parse(f).type === 'ack')).toBe(true),
    );

    const ack = socket.sent.map((f) => JSON.parse(f)).find((f) => f.type === 'ack');
    expect(ack).toMatchObject({ code: 0, payload: { accepted: [], not_found: ['gone'] } });
    expect(conn.subscriptions.size).toBe(0);
    conn.close();
  });

  it('unsubscribe_v2 detaches listed agents with an explicit off, keeping the filter and other grades', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls, detaches } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe', { session_ids: ['s1'], agent_filter: { s1: ['main'] } }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { '*': 'delta' } }),
    );
    await vi.waitFor(() =>
      expect(conn.subscriptions.get('s1')?.transcriptGrades).toEqual({ '*': 'delta' }),
    );

    socket.emit(
      'message',
      controlFrame('unsubscribe_v2', { session_id: 's1', agent_ids: ['main'] }),
    );
    await vi.waitFor(() => expect(detaches).toHaveLength(1));

    expect(detaches[0]).toEqual({ sessionId: 's1', agentIds: ['main'] });
    expect(conn.subscriptions.get('s1')).toEqual({
      agentFilter: new Set(['main']),
      transcriptGrades: { '*': 'delta', main: 'off' },
    });
    const ack = socket.sent.map((f) => JSON.parse(f)).findLast((f) => f.type === 'ack');
    expect(ack).toMatchObject({ code: 0, payload: { accepted: ['s1'], not_found: [] } });
    conn.close();
  });

  it('unsubscribe_v2 without agent_ids detaches the whole transcript stream', async () => {
    const socket = new FakeSocket();
    const { broadcaster, detaches } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { '*': 'delta' } }),
    );
    await vi.waitFor(() =>
      expect(conn.subscriptions.get('s1')?.transcriptGrades).toEqual({ '*': 'delta' }),
    );

    socket.emit('message', controlFrame('unsubscribe_v2', { session_id: 's1' }));
    await vi.waitFor(() => expect(detaches).toHaveLength(1));

    expect(detaches[0]).toEqual({ sessionId: 's1', agentIds: undefined });
    expect(conn.subscriptions.get('s1')).toEqual({
      agentFilter: undefined,
      transcriptGrades: undefined,
    });
    conn.close();
  });

  it('unsubscribe_v2 is idempotent for an unsubscribed session and never touches the broadcaster', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls, detaches } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit('message', controlFrame('unsubscribe_v2', { session_id: 's1' }));
    await vi.waitFor(() =>
      expect(socket.sent.some((f) => JSON.parse(f).type === 'ack')).toBe(true),
    );

    expect(calls).toHaveLength(0);
    expect(detaches).toHaveLength(0);
    const ack = socket.sent.map((f) => JSON.parse(f)).find((f) => f.type === 'ack');
    expect(ack).toMatchObject({ code: 0, payload: { accepted: ['s1'] } });
    conn.close();
  });

  it('acks an invalid unsubscribe_v2 payload with an error', async () => {
    const socket = new FakeSocket();
    const { broadcaster, detaches } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit('message', controlFrame('unsubscribe_v2', { agent_ids: ['main'] }));
    socket.emit(
      'message',
      controlFrame('unsubscribe_v2', { session_id: 's1', agent_ids: [] }),
    );
    await vi.waitFor(() =>
      expect(socket.sent.filter((f) => JSON.parse(f).type === 'ack')).toHaveLength(2),
    );

    expect(detaches).toHaveLength(0);
    const acks = socket.sent.map((f) => JSON.parse(f)).filter((f) => f.type === 'ack');
    expect(acks.every((a) => a.code === 1)).toBe(true);
    conn.close();
  });

  it('serializes back-to-back control frames: subscribe then subscribe_v2 lands filter and grades', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe', { session_ids: ['s1'], agent_filter: { s1: ['main'] } }),
    );
    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { '*': 'delta' } }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(conn.subscriptions.get('s1')).toEqual({
      agentFilter: new Set(['main']),
      transcriptGrades: { '*': 'delta' },
    });
    conn.close();
  });

  it('re-subscribes an agent at full grade after it was detached', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { '*': 'delta' } }),
    );
    socket.emit('message', controlFrame('unsubscribe_v2', { session_id: 's1' }));
    await vi.waitFor(() =>
      expect(conn.subscriptions.get('s1')?.transcriptGrades).toBeUndefined(),
    );

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { main: 'turn' } }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(calls[1]).toMatchObject({ sessionId: 's1', grades: { main: 'turn' } });
    expect(conn.subscriptions.get('s1')?.transcriptGrades).toEqual({ main: 'turn' });
    conn.close();
  });
});

describe('WsConnectionV1 outbound buffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends server_hello immediately', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { flushIntervalMs: 16 });
    expect(socket.frames().map((f) => (f as { type: string }).type)).toEqual(['server_hello']);
    conn.close();
  });

  it('buffers subscribe_v2 transcript frames without merging them', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { flushIntervalMs: 16 });
    socket.sent = [];

    conn.send(durable('transcript.reset', 's1', 7));
    conn.send(durable('transcript.ops', 's1', 8));
    expect(socket.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(15);
    expect(socket.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    const frames = socket.frames() as Array<{ type: string; seq: number }>;
    expect(frames.map((frame) => frame.type)).toEqual(['transcript.reset', 'transcript.ops']);
    expect(frames.map((frame) => frame.seq)).toEqual([7, 8]);
    conn.close();
  });

  it('coalesces adjacent subscribed deltas into one socket.send', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { flushIntervalMs: 16 });
    socket.sent = [];

    conn.send(delta('s1', 'main', 1, 'Hello', 0));
    conn.send(delta('s1', 'main', 1, ' ', 5));
    conn.send(delta('s1', 'main', 1, 'world', 6));
    expect(socket.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(16);

    const frames = socket.frames();
    expect(frames).toHaveLength(1);
    const f = frames[0] as { type: string; offset: number; payload: { delta: string } };
    expect(f.type).toBe('assistant.delta');
    expect(f.offset).toBe(0);
    expect(f.payload.delta).toBe('Hello world');
    conn.close();
  });

  it('sends public events immediately and preserves FIFO with subscribed events', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { flushIntervalMs: 16 });
    socket.sent = [];

    conn.send(delta('s1', 'main', 1, 'before', 0));
    expect(socket.sent).toHaveLength(0);
    conn.send(durable('event.session.work_changed', 's1', 2), 'immediate');

    expect(socket.frames().map((f) => (f as { type: string }).type)).toEqual([
      'assistant.delta',
      'event.session.work_changed',
    ]);
    await vi.advanceTimersByTimeAsync(16);
    expect(socket.sent).toHaveLength(2);
    conn.close();
  });

  it('flushes immediately once the subscribed batch reaches maxBatchSize', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { flushIntervalMs: 1000, maxBatchSize: 3 });
    socket.sent = [];

    conn.send(delta('s1', 'main', 1, 'a', 0));
    conn.send(delta('s1', 'main', 1, 'b', 1));
    conn.send(delta('s1', 'main', 1, 'c', 2));

    const frames = socket.frames();
    expect(frames).toHaveLength(1);
    expect((frames[0] as { payload: { delta: string } }).payload.delta).toBe('abc');
    conn.close();
  });

  it('defers flushing while the peer is above the watermark, then coalesces on drain', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, {
      flushIntervalMs: 16,
      highWaterMarkBytes: 100,
    });
    socket.sent = [];

    socket.bufferedAmount = 200;
    conn.send(delta('s1', 'main', 1, 'Hello', 0));
    await vi.advanceTimersByTimeAsync(16);
    expect(socket.sent).toHaveLength(0);

    conn.send(delta('s1', 'main', 1, ' world', 5));
    await vi.advanceTimersByTimeAsync(5);
    expect(socket.sent).toHaveLength(0);

    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(5);
    const frames = socket.frames();
    expect(frames).toHaveLength(1);
    expect((frames[0] as { payload: { delta: string } }).payload.delta).toBe('Hello world');
    conn.close();
  });

  it('terminates when queued outbound bytes exceed the hard cap', () => {
    const socket = new FakeSocket();
    const warn = vi.fn();
    const broadcaster = makeBroadcaster();
    const removeGlobalTarget = vi.spyOn(broadcaster, 'removeGlobalTarget');
    const unsubscribe = vi.spyOn(broadcaster, 'unsubscribe');
    const conn = makeConn(socket, {
      broadcaster,
      flushIntervalMs: 1000,
      highWaterMarkBytes: 10,
      maxOutboundBufferBytes: 300,
      logger: { warn },
    });
    conn.subscriptions.set('s1', {});
    socket.sent = [];
    socket.bufferedAmount = 20;

    conn.send(delta('s1', 'main', 1, 'x'.repeat(1000), 0));

    expect(socket.terminateCalls).toBe(1);
    expect(socket.readyState).toBe(socket.CLOSED);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'slow_consumer', cause: 'queued_bytes' }),
      'terminating unhealthy websocket connection',
    );
    expect((conn as unknown as { outbound: unknown[] }).outbound).toEqual([]);
    expect(removeGlobalTarget).toHaveBeenCalledWith(conn);
    expect(unsubscribe).toHaveBeenCalledWith('s1', conn);
  });

  it('terminates after sustained socket backpressure above the hard cap', async () => {
    const socket = new FakeSocket();
    const warn = vi.fn();
    const conn = makeConn(socket, {
      flushIntervalMs: 1,
      highWaterMarkBytes: 100,
      maxOutboundBufferBytes: 1024,
      maxBackpressureRounds: 3,
      logger: { warn },
    });
    socket.sent = [];
    socket.bufferedAmount = 2048;

    conn.send(delta('s1', 'main', 1, 'slow', 0));
    await vi.advanceTimersByTimeAsync(11);

    expect(socket.terminateCalls).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'slow_consumer',
        cause: 'socket_buffered_bytes',
        rounds: 3,
      }),
      'terminating unhealthy websocket connection',
    );
    expect((conn as unknown as { outbound: unknown[] }).outbound).toEqual([]);
  });

  it('force-flushes buffered subscription frames on close', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { flushIntervalMs: 1000 });
    socket.sent = [];

    conn.send(delta('s1', 'main', 1, 'tail', 0));
    expect(socket.sent).toHaveLength(0);

    conn.close();
    const frames = socket.frames();
    expect(frames).toHaveLength(1);
    expect((frames[0] as { payload: { delta: string } }).payload.delta).toBe('tail');
  });

  it('drops buffered frames when the socket is already closed at flush time', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { flushIntervalMs: 16 });
    socket.sent = [];

    socket.readyState = socket.CLOSED;
    conn.send(delta('s1', 'main', 1, 'lost', 0));
    await vi.advanceTimersByTimeAsync(16);
    expect(socket.sent).toHaveLength(0);
  });
});

describe('WsConnectionV1 heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function sentTypes(socket: FakeSocket): string[] {
    return socket.frames().map((f) => (f as { type: string }).type);
  }

  function sentPings(
    socket: FakeSocket,
  ): Array<{ type: string; timestamp: string; payload: { nonce: string } }> {
    return socket.frames() as Array<{
      type: string;
      timestamp: string;
      payload: { nonce: string };
    }>;
  }

  it('advertises the heartbeat interval in server_hello', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { heartbeatIntervalMs: 10 });
    const hello = socket.frames()[0] as { type: string; payload: { heartbeat_ms?: number } };
    expect(hello.type).toBe('server_hello');
    expect(hello.payload.heartbeat_ms).toBe(10);
    conn.close();
  });

  it('defaults to a 10s heartbeat interval', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket);
    const hello = socket.frames()[0] as { payload: { heartbeat_ms?: number } };
    expect(hello.payload.heartbeat_ms).toBe(10_000);
    conn.close();
  });

  it('supports the legacy heartbeatMs option and zero disables the heartbeat', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { heartbeatMs: 25 });
    const hello = socket.frames()[0] as { payload: { heartbeat_ms?: number } };
    expect(hello.payload.heartbeat_ms).toBe(25);
    conn.close();

    const disabledSocket = new FakeSocket();
    const disabled = makeConn(disabledSocket, { heartbeatMs: 0 });
    const disabledHello = disabledSocket.frames()[0] as { payload: { heartbeat_ms?: number } };
    expect(disabledHello.payload.heartbeat_ms).toBeUndefined();
    disabledSocket.sent = [];
    vi.advanceTimersByTime(100);
    expect(disabledSocket.sent).toHaveLength(0);
    expect(disabledSocket.closeCalls).toHaveLength(0);
    disabled.close();
  });

  it('sends a ping every interval while the peer keeps answering', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { heartbeatIntervalMs: 10 });
    socket.sent = [];

    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(10);
      expect(sentTypes(socket)).toHaveLength(i + 1);
      socket.emit('message', JSON.stringify({ type: 'pong', payload: { nonce: 'n' } }));
    }

    const pings = sentPings(socket);
    expect(pings.every((f) => f.type === 'ping')).toBe(true);
    expect(pings.every((f) => !Number.isNaN(Date.parse(f.timestamp)))).toBe(true);
    expect(typeof pings[0]!.payload.nonce).toBe('string');
    expect(new Set(pings.map((f) => f.payload.nonce)).size).toBe(3);
    expect(socket.closeCalls).toHaveLength(0);
    conn.close();
  });

  it('reaps the connection after two silent cycles', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { heartbeatIntervalMs: 10 });
    socket.sent = [];

    vi.advanceTimersByTime(10);
    expect(sentTypes(socket)).toEqual(['ping']);
    expect(socket.closeCalls).toHaveLength(0);

    vi.advanceTimersByTime(10);
    expect(socket.closeCalls).toEqual([{ code: 1001, reason: 'heartbeat timeout' }]);
    expect(sentTypes(socket)).toEqual(['ping']);

    vi.advanceTimersByTime(100);
    expect(sentTypes(socket)).toEqual(['ping']);
    expect(socket.closeCalls).toHaveLength(1);
  });

  it('treats any inbound frame — not just pong — as proof of life', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { heartbeatIntervalMs: 10 });
    socket.sent = [];

    vi.advanceTimersByTime(15);
    socket.emit('message', JSON.stringify({ type: 'some_future_frame', payload: {} }));

    vi.advanceTimersByTime(20);
    expect(sentTypes(socket)).toEqual(['ping', 'ping', 'ping']);
    expect(socket.closeCalls).toHaveLength(0);

    vi.advanceTimersByTime(5);
    expect(socket.closeCalls).toEqual([{ code: 1001, reason: 'heartbeat timeout' }]);
  });

  it('stops heartbeating once the socket closes on its own', () => {
    const socket = new FakeSocket();
    makeConn(socket, { heartbeatIntervalMs: 10 });
    socket.sent = [];

    vi.advanceTimersByTime(10);
    expect(sentTypes(socket)).toEqual(['ping']);

    socket.terminate();
    vi.advanceTimersByTime(100);
    expect(sentTypes(socket)).toEqual(['ping']);
    expect(socket.closeCalls).toHaveLength(0);
  });
});

describe('WsConnectionV1 global target registration', () => {
  function makeGlobalTargetBroadcaster() {
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const broadcaster = {
      subscribe: async () => true,
      unsubscribe: () => {},
      addGlobalTarget: (target: unknown) => added.push(target),
      removeGlobalTarget: (target: unknown) => removed.push(target),
      getCursor: async () => ({ seq: 0, epoch: '' }),
      getBufferedSince: async () => ({
        events: [],
        resyncRequired: false,
        currentSeq: 0,
        epoch: '',
      }),
    } as unknown as SessionEventBroadcaster;
    return { broadcaster, added, removed };
  }

  it('registers the connection as a global target on construction and unregisters on close', () => {
    const socket = new FakeSocket();
    const { broadcaster, added, removed } = makeGlobalTargetBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    expect(added).toEqual([conn]);
    expect(removed).toEqual([]);

    conn.close();
    expect(removed).toEqual([conn]);
  });

  it('unregisters when the socket closes on its own', () => {
    const socket = new FakeSocket();
    const { broadcaster, added, removed } = makeGlobalTargetBroadcaster();
    const conn = makeConn(socket, { broadcaster });
    expect(added).toEqual([conn]);

    socket.emit('close');
    expect(removed).toEqual([conn]);
  });

});
