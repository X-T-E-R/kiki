import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { AsyncQueue } from '../src/asyncQueue';
import { CodexAppServerClient } from '../src/client';
import type { HostProcessLike, HostProcessServiceLike } from '../src/types';

function scriptedProcess(): {
  readonly process: HostProcessLike;
  readonly stdout: PassThrough;
  readonly dispose: ReturnType<typeof vi.fn>;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exitCode: number | null = null;
  let resolveExit!: (code: number) => void;
  const wait = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  let input = '';
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      input += chunk.toString();
      let newline = input.indexOf('\n');
      while (newline >= 0) {
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        const frame = JSON.parse(line) as { id?: string; method?: string; params?: unknown };
        if (frame.method === 'initialize' && frame.id !== undefined) {
          stdout.write(`${JSON.stringify({ id: frame.id, result: {} })}\n`);
        }
        if (frame.method === 'model/list' && frame.id !== undefined) {
          stdout.write(`${JSON.stringify({
            id: frame.id,
            result: {
              data: [{ id: 'model-a' }],
              nextCursor: 'repeat',
            },
          })}\n`);
        }
        newline = input.indexOf('\n');
      }
      callback();
    },
  });
  const dispose = vi.fn();
  return {
    stdout,
    dispose,
    process: {
      pid: 1,
      get exitCode() {
        return exitCode;
      },
      stdin,
      stdout,
      stderr,
      wait: () => wait,
      kill: async () => {
        if (exitCode === null) {
          exitCode = 0;
          resolveExit(0);
        }
      },
      dispose,
    },
  };
}

describe('CodexAppServerClient limits and observers', () => {
  it('bounds and clears event queue backlog on failure', async () => {
    const queue = new AsyncQueue<number>(1);
    queue.push(1);
    expect(() => queue.push(2)).toThrow(/backlog limit/);
    queue.fail(new Error('protocol failure'));
    await expect(queue[Symbol.asyncIterator]().next()).rejects.toThrow('protocol failure');
  });

  it('isolates state observer failures during startup and shutdown', async () => {
    const logger = { error: vi.fn() };
    const spawn = vi.fn(async () => {
      throw new Error('spawn failed');
    });
    const client = new CodexAppServerClient(
      { spawn } as HostProcessServiceLike,
      { id: 'fixture', command: 'fixture' },
      {
        onStateChange: () => {
          throw new Error('observer failed');
        },
        logger,
      },
    );

    await expect(client.connect()).rejects.toThrow('spawn failed');
    expect(spawn).toHaveBeenCalledOnce();
    expect(client.status().state).toBe('broken');
    await client.shutdown();
    expect(client.status().state).toBe('closed');
    expect(logger.error).toHaveBeenCalled();
  });

  it('fails the connection on repeated model cursors', async () => {
    const fixture = scriptedProcess();
    const client = new CodexAppServerClient(
      { spawn: async () => fixture.process },
      { id: 'fixture', command: 'fixture' },
    );
    await client.connect();

    await expect(client.listModels()).rejects.toMatchObject({ code: 'protocol' });
    expect(client.status().state).toBe('broken');
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('fails the connection when early notifications exceed the limit', async () => {
    const fixture = scriptedProcess();
    const client = new CodexAppServerClient(
      { spawn: async () => fixture.process },
      { id: 'fixture', command: 'fixture' },
    );
    await client.connect();

    const turn = client.startTurn(
      { threadId: 'thread-1', input: [] },
      new AbortController().signal,
    );
    const notification = `${JSON.stringify({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'item-1', type: 'agentMessage' },
      },
    })}\n`;
    fixture.stdout.write(notification.repeat(1025));

    await expect(turn).rejects.toMatchObject({ code: 'protocol' });
    expect(client.status().state).toBe('broken');
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('fails the connection on an oversized pending stdout frame', async () => {
    const fixture = scriptedProcess();
    const client = new CodexAppServerClient(
      { spawn: async () => fixture.process },
      { id: 'fixture', command: 'fixture' },
    );
    await client.connect();

    fixture.stdout.write('x'.repeat(1024 * 1024 + 1));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(client.status().state).toBe('broken');
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });
});
