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

    const call = channel.call({}, 'service', 'method', [], 70_000);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(69_999);
    await expect(Promise.race([call, Promise.resolve('pending')])).resolves.toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    await expect(call).rejects.toThrow('call timed out after 70000ms');

    await channel.close();
  });
});
