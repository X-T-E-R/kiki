import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { AsyncQueue } from '../src/async-queue';
import { AcpProcessClient } from '../src/client';
import type { HostProcessLike, HostProcessServiceLike } from '../src/types';

function oversizedProcess(dispose: ReturnType<typeof vi.fn<() => void>>): HostProcessLike {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exitCode: number | null = null;
  let resolveExit!: (code: number) => void;
  const wait = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  setImmediate(() => stdout.write('x'.repeat(1024 * 1024 + 1)));
  return {
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
  };
}

describe('AcpProcessClient limits and observers', () => {
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
    const client = new AcpProcessClient(
      { spawn } as HostProcessServiceLike,
      { id: 'fixture', command: 'fixture' },
      {
        onStateChange: () => {
          throw new Error('observer failed');
        },
        logger,
      },
    );

    await expect(client.openSession({ cwd: 'C:/workspace' })).rejects.toThrow();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(client.status().state).toBe('broken');
    await client.shutdown();
    expect(client.status().state).toBe('closed');
    expect(logger.error).toHaveBeenCalled();
  });

  it('fails startup on an oversized pending stdout frame', async () => {
    const disposals: Array<ReturnType<typeof vi.fn<() => void>>> = [];
    const client = new AcpProcessClient(
      {
        spawn: async () => {
          const dispose = vi.fn<() => void>();
          disposals.push(dispose);
          return oversizedProcess(dispose);
        },
      },
      { id: 'fixture', command: 'fixture', startupTimeoutMs: 5_000 },
      { platform: 'linux' },
    );

    await expect(client.openSession({ cwd: 'C:/workspace' })).rejects.toThrow();
    expect(client.status().state).toBe('broken');
    expect(disposals).toHaveLength(2);
    expect(disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });
});
