import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeWorkerWithTimeout, WORKER_CLOSE_TIMEOUT_MS } from '#/_base/node/workerClose';
import { QueryStoreWorker } from '#/persistence/backends/sqlite/host';
import { configureQueryStoreWorkerRuntime } from '#/persistence/backends/sqlite/protocol';
import { UsageReadModelWorker } from '#/persistence/backends/sqlite/usageHost';
import { configureUsageReadModelWorkerRuntime } from '#/persistence/backends/sqlite/usageProtocol';
import { MailboxWorker } from '#/persistence/backends/sqliteMailbox/host';
import { configureMailboxWorkerRuntime } from '#/persistence/backends/sqliteMailbox/protocol';
import { MemoryWorker } from '#/persistence/backends/sqliteMemory/host';
import { configureMemoryWorkerRuntime } from '#/persistence/backends/sqliteMemory/protocol';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  configureQueryStoreWorkerRuntime(undefined as unknown as string);
  configureMailboxWorkerRuntime(undefined as unknown as string);
  configureMemoryWorkerRuntime(undefined as unknown as string);
  configureUsageReadModelWorkerRuntime(undefined);
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('closeWorkerWithTimeout', () => {
  it('terminates a wedged worker at the default 5_000ms deadline and resolves cleanly', async () => {
    vi.useFakeTimers();
    let rejectDrain!: (error: Error) => void;
    let resolveExited!: () => void;
    const drain = new Promise<void>((_resolve, reject) => {
      rejectDrain = reject;
    });
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });
    const terminate = vi.fn(async () => {
      rejectDrain(new Error('worker exited (1)'));
      resolveExited();
      return 1;
    });

    const closing = closeWorkerWithTimeout({ terminate } as unknown as Worker, drain, exited);
    await vi.advanceTimersByTimeAsync(WORKER_CLOSE_TIMEOUT_MS - 1);
    expect(terminate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(closing).resolves.toBeUndefined();
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('settles after terminate and exit even when drain never settles', async () => {
    vi.useFakeTimers();
    let resolveExited!: () => void;
    const drain = new Promise<void>(() => {});
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });
    const terminate = vi.fn(async () => {
      resolveExited();
      return 1;
    });

    const closing = closeWorkerWithTimeout({ terminate } as unknown as Worker, drain, exited, 200);
    await vi.advanceTimersByTimeAsync(200);
    await expect(closing).resolves.toBeUndefined();
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('propagates a non-timeout drain error and clears its deadline timer', async () => {
    vi.useFakeTimers();
    const terminate = vi.fn(async () => 0);
    const failure = new Error('worker crashed early');
    const drain = Promise.reject(failure);
    drain.catch(() => {});

    await expect(
      closeWorkerWithTimeout({ terminate } as unknown as Worker, drain, Promise.resolve(), 1_000),
    ).rejects.toBe(failure);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(terminate).not.toHaveBeenCalled();
  });
});

describe('SQLite worker hosts bounded close()', () => {
  it('forces worker.terminate() on wedged workers across all 4 SQLite worker hosts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kiki-wedged-worker-'));
    tempDirs.push(dir);
    const wedgedEntry = join(dir, 'wedged-worker.mjs');
    await writeFile(
      wedgedEntry,
      [
        "import { parentPort } from 'node:worker_threads';",
        "parentPort.on('message', () => {});",
        'setInterval(() => {}, 60_000);',
      ].join('\n'),
    );

    configureQueryStoreWorkerRuntime(wedgedEntry);
    configureMailboxWorkerRuntime(wedgedEntry);
    configureMemoryWorkerRuntime(wedgedEntry);
    configureUsageReadModelWorkerRuntime(wedgedEntry);

    const dbPath = join(dir, 'index.sqlite');
    const queryWorker = new QueryStoreWorker(dbPath);
    const mailboxWorker = new MailboxWorker(dbPath, true, false);
    const memoryWorker = new MemoryWorker(dbPath);
    const usageWorker = new UsageReadModelWorker(dbPath, true);

    const started = Date.now();
    await Promise.all([
      queryWorker.close(100),
      mailboxWorker.close(100),
      memoryWorker.close(100),
      usageWorker.close(100),
    ]);
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(3_000);
    expect(queryWorker.isStopped).toBe(true);
    expect(memoryWorker.isStopped).toBe(true);
    expect(usageWorker.isStopped).toBe(true);
  });
});
