import { describe, expect, it, vi } from 'vitest';

import { HttpChannel } from '../src/transports/http/channel.js';
import { createKlient } from '../src/transports/http/index.js';
import { KlientValidationError } from '../src/core/validation.js';

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Listener = (event: unknown) => void;

class FakeWebSocketServer {
  readonly frames: Record<string, unknown>[] = [];
  readonly sockets: FakeSocket[] = [];
  lastUrl = '';
  lastProtocols: string[] | undefined;

  attach(socket: FakeSocket, url: string, protocols?: string | string[]): void {
    this.sockets.push(socket);
    this.lastUrl = url;
    this.lastProtocols = Array.isArray(protocols) ? protocols : protocols ? [protocols] : undefined;
    queueMicrotask(() => {
      socket.open();
    });
  }

  receive(socket: FakeSocket, raw: string): void {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    this.frames.push(frame);
    if (frame['type'] === 'subscribe') {
      socket.deliver({ type: 'subscribed', id: frame['id'] });
    }
  }

  pushEvent(data: unknown, socket = this.sockets.at(-1)): void {
    const subscribe = this.frames.toReversed().find((frame) => frame['type'] === 'subscribe');
    socket?.deliver({ type: 'event', id: subscribe?.['id'], data });
  }

  push(frame: Record<string, unknown>, socket = this.sockets.at(-1)): void {
    socket?.deliver(frame);
  }

  disconnect(): void {
    this.sockets.at(-1)?.serverClose();
  }
}

class FakeSocket {
  static readonly OPEN = 1;
  readyState = 0;
  private readonly handlers = new Map<string, Set<Listener>>();

  constructor(
    private readonly server: FakeWebSocketServer,
    url: string,
    protocols?: string | string[],
  ) {
    server.attach(this, url, protocols);
  }

  addEventListener(type: string, listener: Listener): void {
    const handlers = this.handlers.get(type) ?? new Set<Listener>();
    handlers.add(listener);
    this.handlers.set(type, handlers);
  }

  send(data: string): void {
    this.server.receive(this, data);
  }

  close(): void {
    this.serverClose();
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.fire('open', {});
  }

  serverClose(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire('close', {});
  }

  deliver(frame: Record<string, unknown>): void {
    queueMicrotask(() => {
      this.fire('message', { data: JSON.stringify(frame) });
    });
  }

  private fire(type: string, event: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
}

function fakeWebSocket(server: FakeWebSocketServer): typeof WebSocket {
  class BoundFakeSocket extends FakeSocket {
    static override readonly OPEN = FakeSocket.OPEN;

    constructor(url: string | URL, protocols?: string | string[]) {
      super(server, String(url), protocols);
    }
  }
  return BoundFakeSocket as unknown as typeof WebSocket;
}

function jsonResponse(envelope: Record<string, unknown>): Response {
  return { json: () => Promise.resolve(envelope) } as Response;
}

function okEnvelope(data: unknown): Record<string, unknown> {
  return { code: 0, msg: 'success', data, request_id: 'r1' };
}

describe('http transport', () => {
  it('POSTs one procedure with positional params and bearer auth', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(
          okEnvelope({
            id: 's1',
            workspaceId: 'w1',
            createdAt: 1,
            updatedAt: 2,
            archived: false,
          }),
        ),
      ),
    );
    const klient = createKlient({
      endpoint: 'http://127.0.0.1:58627/',
      token: 'tok',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const summary = await klient.global.sessions.get('s1');
    expect(summary?.id).toBe('s1');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:58627/api/klient/call');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({
      procedure: {
        scope: 'core',
        service: 'sessionIndex',
        method: 'get',
      },
      params: ['s1'],
    });
    await klient.close();
  });

  it('sends an empty params array for zero-argument procedures', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(okEnvelope({}))));
    const klient = createKlient({
      endpoint: 'http://127.0.0.1:58627',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await klient.global.config.getAll();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ params: [] });
    await klient.close();
  });

  it('unwraps non-zero envelopes and validates successful outputs', async () => {
    const errorFetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          code: 40001,
          msg: 'workspace not found',
          data: null,
          request_id: 'r',
          reason: 'request.invalid',
        }),
      ),
    );
    const errorKlient = createKlient({
      endpoint: 'http://127.0.0.1:58627',
      fetch: errorFetch as unknown as typeof fetch,
    });
    await expect(errorKlient.global.workspaces.get('nope')).rejects.toMatchObject({
      name: 'RPCError',
      code: 40001,
      reason: 'request.invalid',
    });
    await errorKlient.close();

    const driftFetch = vi.fn(() => Promise.resolve(jsonResponse(okEnvelope({ id: 42 }))));
    const driftKlient = createKlient({
      endpoint: 'http://127.0.0.1:58627',
      fetch: driftFetch as unknown as typeof fetch,
    });
    await expect(driftKlient.global.sessions.get('s1')).rejects.toBeInstanceOf(
      KlientValidationError,
    );
    await driftKlient.close();
  });

  it('maps deadlines and caller AbortSignal to fetch abort', async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    });
    const channel = new HttpChannel({
      endpoint: 'http://127.0.0.1:58627',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(channel.call({}, 'service', 'slow', [], { timeoutMs: 10 })).rejects.toThrow(
      'call timed out after 10ms',
    );
    expect(signals[0]?.aborted).toBe(true);

    const controller = new AbortController();
    const call = channel.call({}, 'service', 'cancelled', [], {
      timeoutMs: 0,
      signal: controller.signal,
    });
    controller.abort(new Error('caller cancelled'));
    await expect(call).rejects.toThrow('aborted');
    expect(signals[1]?.aborted).toBe(true);
    await channel.close();
  });

  it('shares one lazy event socket and restores active subscriptions after reconnect', async () => {
    const server = new FakeWebSocketServer();
    const klient = createKlient({
      endpoint: 'http://127.0.0.1:58627',
      token: 'tok',
      fetch: vi.fn() as unknown as typeof fetch,
      WebSocket: fakeWebSocket(server),
    });
    const events: unknown[] = [];
    const errors: Error[] = [];
    klient.events.onError((error) => errors.push(error));
    const subscription = klient.events.on('kosong.providers.changed', (event) => events.push(event));
    await tick(10);

    expect(server.lastUrl).toBe('ws://127.0.0.1:58627/api/klient/events');
    expect(server.lastProtocols).toEqual(['kimi-code.bearer.tok']);
    expect(server.frames.filter((frame) => frame['type'] === 'subscribe')).toHaveLength(1);
    expect(server.frames.find((frame) => frame['type'] === 'subscribe')).toMatchObject({
      scope: 'core',
      service: 'providerService',
      event: 'onDidChangeProviders',
    });

    server.pushEvent({ added: ['p1'], removed: [], changed: [] });
    await tick(10);
    expect(events).toEqual([{ added: ['p1'], removed: [], changed: [] }]);

    server.disconnect();
    await tick(550);
    await tick(10);
    expect(server.sockets).toHaveLength(2);
    expect(server.frames.filter((frame) => frame['type'] === 'subscribe')).toHaveLength(2);
    expect(errors).toHaveLength(1);

    server.pushEvent({ added: ['p2'], removed: [], changed: [] });
    await tick(10);
    expect(events).toHaveLength(2);

    subscription.dispose();
    expect(server.frames.at(-1)).toMatchObject({ type: 'unsubscribe' });
    await klient.close();
  });

  it('carries streaming procedures over the event socket', async () => {
    const server = new FakeWebSocketServer();
    const channel = new HttpChannel({
      endpoint: 'http://127.0.0.1:58627',
      fetch: vi.fn() as unknown as typeof fetch,
      WebSocket: fakeWebSocket(server),
    });
    const iterator = channel.stream({}, 'modelResolver', 'generate', ['m', {}, {}])[
      Symbol.asyncIterator
    ]();
    const first = iterator.next();
    await tick(10);
    const frame = server.frames.find((item) => item['type'] === 'stream');
    expect(frame).toMatchObject({
      scope: 'core',
      service: 'modelResolver',
      method: 'generate',
    });
    server.push({ type: 'stream_data', id: frame?.['id'], data: { type: 'text', text: 'ok' } });
    await expect(first).resolves.toEqual({
      done: false,
      value: { type: 'text', text: 'ok' },
    });
    const end = iterator.next();
    server.push({ type: 'stream_end', id: frame?.['id'] });
    await expect(end).resolves.toEqual({ done: true, value: undefined });
    await channel.close();
  });
});
