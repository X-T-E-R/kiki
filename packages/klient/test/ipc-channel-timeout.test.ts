/**
 * Unit tests for the IPC channel's per-call deadline: ordinary calls keep the
 * 30s default while a caller-supplied override (e.g. `threads.wait`'s 70s) is
 * honored. `node:net.createConnection` is mocked so the deadline can be driven
 * with fake timers without a real socket.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeSocket {
  destroyed: boolean;
  writes: string[];
  on(event: string, handler: (...args: unknown[]) => void): FakeSocket;
  once(event: string, handler: (...args: unknown[]) => void): FakeSocket;
  off(event: string, handler: (...args: unknown[]) => void): FakeSocket;
  write(data: string): boolean;
  end(): void;
  emit(event: string, ...args: unknown[]): void;
}

const netMock = vi.hoisted(() => {
  const makeSocket = (): FakeSocket => {
    const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
    const onceHandlers = new Map<string, Set<(...args: unknown[]) => void>>();
    const socket: FakeSocket = {
      destroyed: false,
      writes: [],
      on(event, handler) {
        const set = handlers.get(event) ?? new Set();
        set.add(handler);
        handlers.set(event, set);
        return socket;
      },
      once(event, handler) {
        const set = onceHandlers.get(event) ?? new Set();
        set.add(handler);
        onceHandlers.set(event, set);
        return socket;
      },
      off(event, handler) {
        handlers.get(event)?.delete(handler);
        onceHandlers.get(event)?.delete(handler);
        return socket;
      },
      write(data) {
        socket.writes.push(data);
        return true;
      },
      end() {},
      emit(event, ...args) {
        for (const handler of [...(onceHandlers.get(event) ?? [])]) handler(...args);
        onceHandlers.delete(event);
        for (const handler of [...(handlers.get(event) ?? [])]) handler(...args);
      },
    };
    return socket;
  };
  return { makeSocket, current: null as FakeSocket | null };
});

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  return {
    ...actual,
    createConnection: vi.fn(() => {
      netMock.current = netMock.makeSocket();
      return netMock.current;
    }),
  };
});

import { IpcChannel } from '../src/transports/ipc/channel.js';

describe('IpcChannel call deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('times out an unresponsive call at the 30s default', async () => {
    const channel = new IpcChannel({ socketPath: '/tmp/klient-timeout' });
    const socket = netMock.current!;
    socket.emit('connect');

    const call = channel.call({}, 'service', 'method', []);
    // Let `call` get past `await this.ready` and arm its deadline timer.
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(29_999);
    await expect(Promise.race([call, Promise.resolve('pending')])).resolves.toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    await expect(call).rejects.toThrow('call timed out after 30000ms');

    await channel.close();
  });

  it('honors a caller-supplied per-call timeout override', async () => {
    const channel = new IpcChannel({ socketPath: '/tmp/klient-timeout' });
    const socket = netMock.current!;
    socket.emit('connect');

    const call = channel.call({}, 'service', 'method', [], { timeoutMs: 70_000 });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(69_999);
    await expect(Promise.race([call, Promise.resolve('pending')])).resolves.toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    await expect(call).rejects.toThrow('call timed out after 70000ms');

    await channel.close();
  });

  it('counts connection setup against the call budget and never sends an expired call', async () => {
    const channel = new IpcChannel({ socketPath: '/tmp/klient-timeout', callTimeoutMs: 50 });
    const socket = netMock.current!;
    const call = channel.call({}, 'service', 'write', []);
    const rejected = expect(call).rejects.toMatchObject({ message: 'call timed out after 50ms',
      reason: 'transport.timeout', details: { outcome: 'not_sent', phase: 'connect', timeoutMs: 50 } });
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    socket.emit('connect');
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.writes.map(frame => JSON.parse(frame).type)).toEqual(['hello']);
    await channel.close();
  });

  it('does not restart the budget after connecting', async () => {
    const channel = new IpcChannel({ socketPath: '/tmp/klient-timeout' });
    const socket = netMock.current!;
    const call = channel.call({}, 'service', 'write', [], { timeoutMs: 70_000 });
    const rejected = expect(call).rejects.toMatchObject({ message: 'call timed out after 70000ms',
      reason: 'transport.timeout', requestId: expect.any(String), details: { outcome: 'unknown', phase: 'response' } });
    await vi.advanceTimersByTimeAsync(40_000);
    socket.emit('connect');
    await vi.advanceTimersByTimeAsync(29_999);
    expect(socket.writes.map(frame => JSON.parse(frame).type)).toEqual(['hello', 'call']);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(socket.writes.map(frame => JSON.parse(frame).type)).toEqual(['hello', 'call', 'call_cancel']);
    await channel.close();
  });

  it('aborts a pre-connect caller without closing the shared connection or cancelling its peer', async () => {
    const channel = new IpcChannel({ socketPath: '/tmp/klient-timeout' });
    const socket = netMock.current!;
    const controller = new AbortController();
    const first = channel.call({}, 'service', 'first', [], { signal: controller.signal });
    const second = channel.call({}, 'service', 'second', []);
    const rejected = expect(first).rejects.toThrow('caller stopped');
    controller.abort(new Error('caller stopped'));
    await rejected;
    expect(socket.writes).toEqual([]);
    socket.emit('connect');
    await vi.advanceTimersByTimeAsync(0);
    const calls = socket.writes.map(frame => JSON.parse(frame)).filter(frame => frame.type === 'call');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('second');
    socket.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', id: calls[0].id, data: 'ok' })}\n`));
    await expect(second).resolves.toBe('ok');
    await channel.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['error', 'close', 'client-close'] as const)('settles all stream next waiters on pre-connect %s', async failure => {
    const channel = new IpcChannel({ socketPath: '/tmp/klient-timeout' });
    const socket = netMock.current!;
    const stream = channel.stream({}, 'service', 'stream', [])[Symbol.asyncIterator]();
    const first = expect(stream.next()).rejects.toThrow(failure === 'error' ? 'connect failed' : 'ipc closed');
    const second = expect(stream.next()).rejects.toThrow(failure === 'error' ? 'connect failed' : 'ipc closed');
    if (failure === 'client-close') await channel.close();
    else socket.emit(failure, ...(failure === 'error' ? [new Error('connect failed')] : []));
    await Promise.all([first, second]);
    await expect(stream.next()).resolves.toMatchObject({ done: true });
    expect(socket.writes).toEqual([]);
    await channel.close();
  });

  it('does not start a stream returned before connect', async () => {
    const channel = new IpcChannel({ socketPath: '/tmp/klient-timeout' });
    const socket = netMock.current!;
    const stream = channel.stream({}, 'service', 'stream', [])[Symbol.asyncIterator]();
    const next = stream.next();
    await stream.return!();
    await expect(next).resolves.toMatchObject({ done: true });
    socket.emit('connect');
    await vi.advanceTimersByTimeAsync(0);
    await expect(stream.next()).resolves.toMatchObject({ done: true });
    expect(socket.writes.map(frame => JSON.parse(frame).type)).toEqual(['hello']);
    await channel.close();
  });
});
