import { ChildProcess, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { join, resolve } from 'pathe';
import { afterEach, describe, expect, it, vi } from 'vitest';

const schedule = vi.hoisted(() => ({
  beforeRename: undefined as undefined | ((source: string, target: string) => Promise<void>),
  afterRename: undefined as undefined | ((source: string, target: string) => void),
  afterReaddir: undefined as undefined | ((path: string) => void),
  beforeUnlink: undefined as undefined | ((path: string) => Promise<void>),
  beforeLink: undefined as undefined | ((source: string, target: string) => void),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (source: string, target: string) => {
      await schedule.beforeRename?.(source, target);
      await actual.rename(source, target);
      schedule.afterRename?.(source, target);
    },
    readdir: async (path: string) => {
      const entries = await actual.readdir(path);
      schedule.afterReaddir?.(path);
      return entries;
    },
    unlink: async (path: string) => {
      await schedule.beforeUnlink?.(path);
      return actual.unlink(path);
    },
    link: async (source: string, target: string) => {
      schedule.beforeLink?.(source, target);
      return actual.link(source, target);
    },
  };
});

import {
  acquireFileLock,
  acquireSharedReadLease,
  cleanupExpiredSessionLocks,
  sharedReadDirectory,
  trackReaderWorkerThread,
  waitSharedReadIdle,
  withColdReaderGate,
} from '#/persistence/backends/node-fs/fileLock';
import { openPinnedLogicalRead } from '#/persistence/coldSegmentLog';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { closeSparseFileWorker } from '#/persistence/backends/node-fs/sparseFile';

describe('FileStorageService — stale takeover scheduling', () => {
  let directory: string | undefined;

  afterEach(async () => {
    schedule.beforeRename = undefined;
    schedule.afterRename = undefined;
    schedule.afterReaddir = undefined;
    schedule.beforeUnlink = undefined;
    schedule.beforeLink = undefined;
    if (directory !== undefined) await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    directory = undefined;
  });

  it('does not let a paused stale contender overwrite another owner after its watch lease expires', async () => {
    directory = await mkdtemp(join(tmpdir(), 'fss-takeover-race-'));
    const lockDir = join(directory, 'session-locks');
    const lockPath = join(lockDir, 'session.lock');
    await mkdir(lockDir);
    await writeFile(lockPath, JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      processStartedAt: 0,
      token: 'dead-owner',
      acquiredAt: Date.now() - 10_000,
      leaseMs: 1_000,
    }));
    const expiredAt = new Date(Date.now() - 5_000);
    await utimes(lockPath, expiredAt, expiredAt);

    let pauseFirst: () => void = () => {};
    const firstPaused = new Promise<void>((resolve) => { pauseFirst = resolve; });
    let resumeFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => { resumeFirst = resolve; });
    let firstRenamed: () => void = () => {};
    const firstRenameDone = new Promise<void>((resolve) => { firstRenamed = resolve; });
    let secondWaiting: () => void = () => {};
    const secondWaitingForFirst = new Promise<void>((resolve) => { secondWaiting = resolve; });
    let firstBid: string | undefined;
    let secondRenamed = false;
    let secondWatchScans = 0;
    schedule.beforeRename = async (source, target) => {
      if (target !== lockPath || !source.includes('.bid-') || firstBid !== undefined) return;
      firstBid = source;
      pauseFirst();
      await firstGate;
    };
    schedule.afterRename = (source) => {
      if (source === firstBid) firstRenamed();
      else if (source.includes('.bid-')) secondRenamed = true;
    };
    schedule.afterReaddir = (path) => {
      if (path === lockDir && secondRenamed && ++secondWatchScans === 2) secondWaiting();
    };

    const first = new FileStorageService(directory).acquireLock('session-locks', 'session.lock', {
      leaseMs: 1_000, owner: { contender: 'first' },
    });
    let secondAttempt: Promise<{
      lock: Awaited<ReturnType<FileStorageService['acquireLock']>> | undefined;
      error: unknown;
    }> | undefined;
    try {
      await firstPaused;
      const watches = (await readdir(lockDir)).filter((entry) => entry.startsWith('session.lock.watch-'));
      expect(watches).toHaveLength(1);
      await utimes(join(lockDir, watches[0]!), expiredAt, expiredAt);

      secondAttempt = new FileStorageService(directory)
        .acquireLock('session-locks', 'session.lock', { leaseMs: 1_000, owner: { contender: 'second' } })
        .then((lock) => ({ lock, error: undefined }), (error: unknown) => ({ lock: undefined, error }));
      const observed = await Promise.race([
        secondAttempt.then((result) => ({ kind: 'completed' as const, result })),
        secondWaitingForFirst.then(() => ({ kind: 'waiting' as const })),
      ]);
      if (observed.kind === 'completed') {
        expect(observed.result.lock).toBeDefined();
        const secondToken = (JSON.parse(await readFile(lockPath, 'utf8')) as { token: string }).token;
        resumeFirst();
        await firstRenameDone;
        expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({ token: secondToken });
      } else {
        resumeFirst();
        const firstResult = await first.then(
          (lock) => ({ lock, error: undefined }),
          (error: unknown) => ({ lock: undefined, error }),
        );
        const secondResult = await secondAttempt;
        const winners = [firstResult.lock, secondResult.lock].filter((lock) => lock !== undefined);
        expect(winners).toHaveLength(1);
        expect(firstResult.lock === undefined ? firstResult.error : secondResult.error)
          .toMatchObject({ code: 'storage.locked' });
        const current = JSON.parse(await readFile(lockPath, 'utf8')) as { owner: { contender: string } };
        expect(current.owner.contender).toBe(firstResult.lock === undefined ? 'second' : 'first');
        expect((await readdir(lockDir)).filter((entry) => entry.startsWith('session.lock.watch-'))).toHaveLength(1);
        await winners[0]!.release();
        expect((await readdir(lockDir)).filter((entry) => entry.startsWith('session.lock.watch-'))).toHaveLength(0);
        const replacement = await new FileStorageService(directory).acquireLock('session-locks', 'session.lock');
        await replacement.release();
      }
    } finally {
      resumeFirst();
      await first.catch(() => undefined).then(async (lock) => { await lock?.release(); });
      await secondAttempt?.then(async (result) => { await result.lock?.release(); });
    }
  });

  it.each(['dead owner', 'zero-filled', 'truncated'])('does not let a paused %s lock reaper unlink a new owner', async (kind) => {
    directory = await mkdtemp(join(tmpdir(), 'fss-reap-race-'));
    const lockDir = join(directory, 'session-locks');
    const lockPath = join(lockDir, 'session.lock');
    await mkdir(lockDir);
    const contents = kind === 'zero-filled' ? Buffer.alloc(188) : kind === 'truncated'
      ? Buffer.from('{"version":1,"pid":')
      : Buffer.from(JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        processStartedAt: 0,
        token: 'dead-owner',
        acquiredAt: Date.now() - 10_000,
        leaseMs: 1_000,
      }));
    await writeFile(lockPath, contents);
    const expiredAt = new Date(Date.now() - 5_000);
    await utimes(lockPath, expiredAt, expiredAt);

    let notifyPaused: () => void = () => {};
    const paused = new Promise<void>((resolve) => { notifyPaused = resolve; });
    let resume: () => void = () => {};
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let intercepted = false;
    schedule.beforeUnlink = async (path) => {
      if (path !== lockPath || intercepted) return;
      intercepted = true;
      notifyPaused();
      await gate;
    };
    const reaping = cleanupExpiredSessionLocks(directory);
    try {
      await paused;
      expect((await readdir(lockDir)).filter((entry) => entry.endsWith('.reap'))).toHaveLength(1);
      await expect(new FileStorageService(directory).acquireLock('session-locks', 'session.lock'))
        .rejects.toMatchObject({ code: 'storage.locked' });
      expect(await readFile(lockPath)).toEqual(contents);
      resume();
      expect(await reaping).toBe(1);
      const replacement = await new FileStorageService(directory).acquireLock('session-locks', 'session.lock');
      await replacement.release();
    } finally {
      resume();
      await reaping.catch(() => undefined);
    }
  });

  it('does not reap a malformed lock whose contents changed after inspection', async () => {
    directory = await mkdtemp(join(tmpdir(), 'fss-malformed-reap-race-'));
    const lockDir = join(directory, 'session-locks');
    const lockPath = join(lockDir, 'session.lock');
    await mkdir(lockDir);
    await writeFile(lockPath, Buffer.alloc(188));
    const changed = Buffer.alloc(188, 1);
    schedule.beforeLink = (_source, target) => {
      if (target.endsWith('.reap')) writeFileSync(lockPath, changed);
    };
    expect(await cleanupExpiredSessionLocks(directory)).toBe(0);
    expect(await readFile(lockPath)).toEqual(changed);
    expect(await readdir(lockDir)).toEqual(['session.lock']);
    schedule.beforeLink = undefined;
    expect(await cleanupExpiredSessionLocks(directory)).toBe(1);
  });

  it('acquires an absent lock without scanning foreign watches', async () => {
    directory = await mkdtemp(join(tmpdir(), 'fss-uncontended-'));
    schedule.afterReaddir = () => { throw new Error('uncontended acquisition scanned watches'); };
    const holder = await new FileStorageService(directory).acquireLock('session-locks', 'session.lock');
    await holder.release();
    expect(await readFile(join(directory, 'session-locks', 'session.lock')).catch(() => undefined)).toBeUndefined();
  });

  it('cancels a contended acquisition without removing its holder or leaking a watch', async () => {
    directory = await mkdtemp(join(tmpdir(), 'fss-contended-cancel-'));
    const storage = new FileStorageService(directory);
    const holder = await storage.acquireLock('session-locks', 'session.lock');
    const lockDir = join(directory, 'session-locks');
    const original = await readFile(join(lockDir, 'session.lock'), 'utf8');
    const controller = new AbortController();
    schedule.afterReaddir = () => { controller.abort(new Error('cancel queued lock')); };
    try {
      await expect(storage.acquireLock('session-locks', 'session.lock', { waitForMs: 60_000, signal: controller.signal }))
        .rejects.toThrow('cancel queued lock');
      expect(await readFile(join(lockDir, 'session.lock'), 'utf8')).toBe(original);
      expect((await readdir(lockDir)).filter((entry) => entry.includes('.watch-'))).toHaveLength(1);
    } finally { await holder.release(); }
  });

  it.each(['rename', 'settle', 'replacement'] as const)('cleans only its own stale takeover after cancellation during %s', async (phase) => {
    directory = await mkdtemp(join(tmpdir(), 'fss-takeover-cancel-'));
    const lockDir = join(directory, 'session-locks');
    const lockPath = join(lockDir, 'session.lock');
    await mkdir(lockDir);
    await writeFile(lockPath, JSON.stringify({ version: 1, pid: 2_147_483_647, processStartedAt: 0,
      token: 'dead-owner', acquiredAt: Date.now(), leaseMs: 1000 }));
    const controller = new AbortController();
    let entered = false;
    const replacement = JSON.stringify({ version: 1, pid: process.pid,
      processStartedAt: Math.floor(Date.now() - process.uptime() * 1000),
      token: 'replacement-owner', acquiredAt: Date.now(), leaseMs: 120_000 });
    if (phase === 'rename') schedule.beforeRename = async (source, target) => {
      if (!source.includes('.bid-') || target !== lockPath) return;
      entered = true;
      controller.abort(new Error('cancel takeover'));
    };
    else schedule.afterRename = (source, target) => {
      if (!source.includes('.bid-') || target !== lockPath) return;
      entered = true;
      if (phase === 'replacement') writeFileSync(lockPath, replacement);
      if (phase === 'settle') setTimeout(() => { controller.abort(new Error('cancel takeover')); }, 5);
      else controller.abort(new Error('cancel takeover'));
    };
    await expect(new FileStorageService(directory).acquireLock('session-locks', 'session.lock', { signal: controller.signal }))
      .rejects.toThrow('cancel takeover');
    expect(entered).toBe(true);
    expect((await readdir(lockDir)).filter((entry) => entry.includes('.watch-') || entry.includes('.bid-'))).toEqual([]);
    if (phase === 'replacement') expect(await readFile(lockPath, 'utf8')).toBe(replacement);
    else {
      expect(await readdir(lockDir)).toEqual([]);
      const next = await new FileStorageService(directory).acquireLock('session-locks', 'session.lock');
      await next.release();
    }
  });
});

describe('FileStorageService — transient access denial during acquisition', () => {
  let directory: string | undefined;

  afterEach(async () => {
    schedule.beforeLink = undefined;
    if (directory !== undefined) await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    directory = undefined;
  });

  function accessDenial(): NodeJS.ErrnoException {
    return Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM', errno: -4048 });
  }

  it('reports contention instead of a permission failure when the denial is transient', async () => {
    directory = await mkdtemp(join(tmpdir(), 'fss-transient-denial-'));
    const service = new FileStorageService(directory);
    const holder = await service.acquireLock('session-locks', 'session.lock', { owner: { contender: 'holder' } });
    try {
      let denials = 0;
      schedule.beforeLink = (_source, target) => {
        if (target.includes('.watch-') && denials++ === 0) throw accessDenial();
      };
      const error: unknown = await new FileStorageService(directory)
        .acquireLock('session-locks', 'session.lock', { owner: { contender: 'contender' } })
        .then(() => undefined, (thrown: unknown) => thrown);
      expect(denials).toBe(2);
      expect(error).toMatchObject({ code: 'storage.locked' });
      expect((await readdir(join(directory, 'session-locks'))).filter((entry) => entry.startsWith('session.lock.watch-')))
        .toHaveLength(1);
    } finally {
      schedule.beforeLink = undefined;
      await holder.release();
    }
    const replacement = await new FileStorageService(directory).acquireLock('session-locks', 'session.lock');
    await replacement.release();
  });

  it('still reports a permission failure when the access denial persists', async () => {
    directory = await mkdtemp(join(tmpdir(), 'fss-persistent-denial-'));
    let attempts = 0;
    schedule.beforeLink = () => {
      attempts += 1;
      throw accessDenial();
    };
    await expect(new FileStorageService(directory).acquireLock('session-locks', 'session.lock'))
      .rejects.toMatchObject({
        code: 'storage.permission_denied',
        details: { op: 'lock', errno: 'EPERM' },
      });
    expect(attempts).toBe(5);
    expect((await readdir(join(directory, 'session-locks'))).filter((entry) => entry.startsWith('session.lock.')))
      .toHaveLength(0);
  });

  it('checks foreign Windows PID creation times via windows-process-helper without spawning powershell.exe (Round-3 R2-1b)', async () => {
    directory = await mkdtemp(join(tmpdir(), 'fss-r3-proctime-'));
    const wirePath = join(directory, 'wire.jsonl');
    await writeFile(wirePath, '{"ok":1}\n');
    const lockPath = `${wirePath}.cold.lock`;
    const readersDir = sharedReadDirectory(wirePath);
    await mkdir(readersDir, { recursive: true });

    const spawned: string[] = [];
    closeSparseFileWorker();
    const childProto = ChildProcess.prototype as unknown as {
      spawn(options: { file: string; args: string[] }): number;
    };
    const origSpawn = childProto.spawn;
    const spawnSpy = vi.spyOn(childProto, 'spawn');
    spawnSpy.mockImplementation(function (this: ChildProcess, options: { file: string; args: string[] }) {
      spawned.push(options.file);
      return origSpawn.call(this, options);
    });

    const child = spawn(
      process.execPath,
      [
        '-e',
        `
        process.stdout.write(JSON.stringify({
          pid: process.pid,
          startedAt: Math.floor(Date.now() - process.uptime() * 1000),
        }) + "\\n");
        setInterval(() => {}, 10000);
        `,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );

    try {
      const childInfo = await new Promise<{ pid: number; startedAt: number }>((resolveInfo, rejectInfo) => {
        let buf = '';
        child.stdout!.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          const nl = buf.indexOf('\n');
          if (nl >= 0) resolveInfo(JSON.parse(buf.slice(0, nl)) as { pid: number; startedAt: number });
        });
        child.once('error', rejectInfo);
      });

      await writeFile(
        lockPath,
        JSON.stringify({
          version: 1,
          pid: childInfo.pid,
          processStartedAt: childInfo.startedAt,
          token: 'child-live-lock',
          acquiredAt: Date.now(),
          leaseMs: 60_000,
        }),
      );
      const foreignReaderPath = join(readersDir, 'child-live.reader');
      await writeFile(
        foreignReaderPath,
        JSON.stringify({
          version: 1,
          pid: childInfo.pid,
          processStartedAt: childInfo.startedAt,
          token: 'child-live-reader',
          acquiredAt: Date.now(),
          leaseMs: 60_000,
        }),
      );

      spawned.length = 0;
      await expect(acquireFileLock(lockPath, { waitForMs: 80 })).rejects.toMatchObject({
        code: 'storage.locked',
      });
      await expect(waitSharedReadIdle(wirePath, AbortSignal.timeout(80))).rejects.toThrow();

      setTimeout(() => {
        void rm(lockPath, { force: true });
      }, 90);
      const storage = new FileStorageService(directory);
      try {
        const pinned = await openPinnedLogicalRead(storage, '', 'wire.jsonl');
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of pinned.read()) chunks.push(Buffer.from(chunk));
          expect(Buffer.concat(chunks).toString('utf8')).toBe('{"ok":1}\n');
        } finally {
          await pinned.close();
        }
      } finally {
        await storage.close();
      }

      for (const exe of spawned) {
        expect(exe.toLowerCase()).not.toContain('powershell');
        expect(exe.toLowerCase()).not.toContain('pwsh');
      }

      if (process.platform === 'win32') {
        await writeFile(
          lockPath,
          JSON.stringify({
            version: 1,
            pid: childInfo.pid,
            processStartedAt: childInfo.startedAt - 600_000,
            token: 'child-recycled-pid-lock',
            acquiredAt: Date.now() - 600_000,
            leaseMs: 60_000,
          }),
        );
        const reclaimed = await acquireFileLock(lockPath, { waitForMs: 2_000 });
        await reclaimed.release();
      }
    } finally {
      child.kill('SIGKILL');
      await new Promise<void>((done) => {
        if (child.exitCode !== null) done();
        else child.once('exit', () => done());
      });
      closeSparseFileWorker();
      spawnSpy.mockRestore();
    }
  }, 20_000);

  it('recovers wire.jsonl.cold.lock and .watch sidecars immediately when a worker_threads owner is terminated (Round-3 R2-6a)', async () => {
    directory = await mkdtemp(join(tmpdir(), 'fss-r3-worker-gate-'));
    const wirePath = join(directory, 'wire.jsonl');
    await writeFile(wirePath, '{"ok":1}\n');
    const coldLockPath = `${wirePath}.cold.lock`;

    const probeLock = await acquireFileLock(coldLockPath);
    const basePayload = JSON.parse(await readFile(coldLockPath, 'utf8')) as Record<string, unknown>;
    await probeLock.release();

    let untrackedWorker: Worker | undefined;
    let trackedWorker: Worker | undefined;
    try {
      untrackedWorker = new Worker(
        `
        const { threadId, parentPort } = require('node:worker_threads');
        process.on('workerMessage', () => {});
        parentPort.postMessage({ threadId });
        setInterval(() => {}, 10000);
        `,
        { eval: true },
      );
      const { threadId: tid1 } = await new Promise<{ threadId: number }>((res, rej) => {
        untrackedWorker!.once('message', res);
        untrackedWorker!.once('error', rej);
      });

      const watchPath1 = `${coldLockPath}.watch-${process.pid}-dead-${tid1}`;
      await writeFile(
        coldLockPath,
        JSON.stringify({ ...basePayload, threadId: tid1, token: `gate-${tid1}` }),
      );
      await writeFile(
        watchPath1,
        JSON.stringify({ ...basePayload, threadId: tid1, token: `gate-${tid1}` }),
      );

      await expect(acquireFileLock(coldLockPath, { waitForMs: 60 })).rejects.toMatchObject({
        code: 'storage.locked',
      });

      await untrackedWorker.terminate();
      untrackedWorker = undefined;

      const result = await withColdReaderGate(wirePath, async () => 'gate-recovered', AbortSignal.timeout(3_000));
      expect(result).toBe('gate-recovered');
      await expect(stat(coldLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(watchPath1)).rejects.toMatchObject({ code: 'ENOENT' });

      trackedWorker = new Worker(
        `
        const { threadId, parentPort } = require('node:worker_threads');
        process.on('workerMessage', () => {});
        parentPort.postMessage({ threadId });
        setInterval(() => {}, 10000);
        `,
        { eval: true },
      );
      const { threadId: tid2 } = await new Promise<{ threadId: number }>((res, rej) => {
        trackedWorker!.once('message', res);
        trackedWorker!.once('error', rej);
      });
      trackReaderWorkerThread(trackedWorker, wirePath);
      const readersDir = sharedReadDirectory(wirePath);
      await mkdir(readersDir, { recursive: true });
      const trackedReaderFile = join(readersDir, `tracked-${tid2}.reader`);
      const trackedWatchFile = `${coldLockPath}.watch-${process.pid}-tracked-${tid2}`;
      await writeFile(
        trackedReaderFile,
        JSON.stringify({ ...basePayload, threadId: tid2, token: `reader-tracked-${tid2}` }),
      );
      await writeFile(
        trackedWatchFile,
        JSON.stringify({ ...basePayload, threadId: tid2, token: `gate-tracked-${tid2}` }),
      );
      await writeFile(
        coldLockPath,
        JSON.stringify({ ...basePayload, threadId: tid2, token: `gate-tracked-${tid2}` }),
      );

      let releaseExitReap: () => void = () => {};
      const exitReapGate = new Promise<void>((res) => {
        releaseExitReap = res;
      });
      let notifyPausedInReap: () => void = () => {};
      const pausedInReap = new Promise<void>((res) => {
        notifyPausedInReap = res;
      });
      let pausedOnce = false;
      schedule.beforeUnlink = async (targetPath) => {
        if (!pausedOnce && (targetPath === trackedReaderFile || targetPath === trackedWatchFile)) {
          pausedOnce = true;
          notifyPausedInReap();
          await exitReapGate;
        }
      };

      await trackedWorker.terminate();
      trackedWorker = undefined;
      await pausedInReap;

      const successorLock = await acquireFileLock(coldLockPath, {
        waitForMs: 2_000,
        owner: { contender: 'successor' },
      });
      try {
        releaseExitReap();
        schedule.beforeUnlink = undefined;
        await vi.waitFor(async () => {
          await expect(stat(trackedReaderFile)).rejects.toMatchObject({ code: 'ENOENT' });
          await expect(stat(trackedWatchFile)).rejects.toMatchObject({ code: 'ENOENT' });
        }, { timeout: 2_000 });

        const livePayload = JSON.parse(await readFile(coldLockPath, 'utf8')) as {
          owner?: Record<string, unknown>;
        };
        expect(livePayload.owner).toEqual({ contender: 'successor' });
        await expect(acquireFileLock(coldLockPath, { waitForMs: 50 })).rejects.toMatchObject({
          code: 'storage.locked',
        });
      } finally {
        releaseExitReap();
        schedule.beforeUnlink = undefined;
        await successorLock.release();
      }
      await expect(stat(coldLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await untrackedWorker?.terminate();
      await trackedWorker?.terminate();
    }
  }, 20_000);

  it('unblocks same-process waiters on already-released worker leases and retries failed .reader unlinks via unref timer while idle (Round-3 R2-6b)', async () => {
    directory = await mkdtemp(join(tmpdir(), 'fss-r3-idle-retry-'));
    const wirePath = join(directory, 'wire.jsonl');
    await writeFile(wirePath, '{"ok":1}\n');
    const readersDir = sharedReadDirectory(wirePath);

    let blockReaderUnlink = true;
    schedule.beforeUnlink = async (targetPath) => {
      if (blockReaderUnlink && targetPath.endsWith('.reader')) {
        throw Object.assign(new Error('EBUSY: sharing violation'), { code: 'EBUSY' });
      }
    };

    const lease = await acquireSharedReadLease(wirePath);
    const readerFiles = (await readdir(readersDir)).filter((name) => name.endsWith('.reader'));
    expect(readerFiles).toHaveLength(1);
    const leaseFile = join(readersDir, readerFiles[0]!);

    await lease.release();
    expect((await stat(leaseFile)).isFile()).toBe(true);

    let idleWorker: Worker | undefined;
    try {
      idleWorker = new Worker(
        `
        const { threadId, parentPort, BroadcastChannel } = require('node:worker_threads');
        const active = new Set();
        process.on('workerMessage', (msg) => {
          if (msg && msg.state && typeof msg.kikiReaderProbeToken === 'string') {
            Atomics.store(msg.state, 0, active.has(msg.kikiReaderProbeToken) ? 1 : 2);
            Atomics.notify(msg.state, 0);
          }
        });
        const bc = new BroadcastChannel('kiki.fileLock.readers.v1');
        bc.unref();
        parentPort.postMessage({ threadId });
        setInterval(() => {}, 10000);
        `,
        { eval: true },
      );
      const { threadId: workerTid } = await new Promise<{ threadId: number }>((res, rej) => {
        idleWorker!.once('message', res);
        idleWorker!.once('error', rej);
      });

      const basePayload = JSON.parse(await readFile(leaseFile, 'utf8')) as Record<string, unknown>;
      const workerReleasedFile = join(readersDir, 'worker-idle-released.reader');
      await writeFile(
        workerReleasedFile,
        JSON.stringify({
          ...basePayload,
          threadId: workerTid,
          token: `already-released-${workerTid}`,
        }),
      );

      await waitSharedReadIdle(wirePath, AbortSignal.timeout(500));

      blockReaderUnlink = false;
      await vi.waitFor(async () => {
        await expect(stat(leaseFile)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(workerReleasedFile)).rejects.toMatchObject({ code: 'ENOENT' });
      }, { timeout: 2_000 });
    } finally {
      schedule.beforeUnlink = undefined;
      await idleWorker?.terminate();
    }
  }, 20_000);

  it('allows a foreign process to take over an untracked terminated worker .cold.lock while the host process stays alive (Round-5 #2)', async () => {
    directory = await mkdtemp(join(tmpdir(), 'fss-r5-foreign-beacon-'));
    const wirePath = join(directory, 'wire.jsonl');
    await writeFile(wirePath, '{"ok":1}\n');
    const coldLockPath = `${wirePath}.cold.lock`;
    const packageRoot = resolve(import.meta.dirname, '../../../..');
    const fileLockUrl = pathToFileURL(
      resolve(packageRoot, 'src/persistence/backends/node-fs/fileLock.ts'),
    ).href;
    const tsxApiUrl = import.meta.resolve('tsx/esm/api');
    const tsconfigPath = resolve(packageRoot, 'tsconfig.json');
    const workerScriptPath = join(directory, 'foreign-worker.mjs');
    const hostScriptPath = join(directory, 'foreign-host.mjs');

    await writeFile(
      workerScriptPath,
      [
        "import { parentPort, workerData } from 'node:worker_threads';",
        `import { register as registerTypeScript } from ${JSON.stringify(tsxApiUrl)};`,
        `registerTypeScript({ tsconfig: ${JSON.stringify(tsconfigPath)} });`,
        `const { acquireFileLock } = await import(${JSON.stringify(fileLockUrl)});`,
        "const lock = await acquireFileLock(workerData.lockPath, { waitForMs: 2000, owner: { from: 'foreign-worker' } });",
        'void lock;',
        'parentPort.postMessage({ acquired: true });',
        'while (Atomics.load(workerData.spinFlag, 0) === 1) {}',
        'setInterval(() => {}, 10000);',
      ].join('\n'),
    );

    await writeFile(
      hostScriptPath,
      [
        "import { Worker } from 'node:worker_threads';",
        'const lockPath = process.argv[2];',
        'const spinFlag = new Int32Array(new SharedArrayBuffer(4));',
        'Atomics.store(spinFlag, 0, 1);',
        `const worker = new Worker(${JSON.stringify(workerScriptPath)}, {`,
        '  workerData: { lockPath, spinFlag },',
        '});',
        "worker.once('message', () => { process.stdout.write('LOCKED_SPINNING\\n'); });",
        "worker.once('error', (err) => { process.stderr.write(String(err) + '\\n'); process.exit(1); });",
        "let buf = '';",
        "process.stdin.on('data', async (chunk) => {",
        "  buf += chunk.toString('utf8');",
        "  if (buf.includes('TERMINATE_WORKER')) {",
        "    buf = '';",
        '    await worker.terminate();',
        "    process.stdout.write('WORKER_TERMINATED\\n');",
        '  }',
        '});',
        'setInterval(() => {}, 10000);',
      ].join('\n'),
    );

    const child = spawn(
      process.execPath,
      [hostScriptPath, coldLockPath],
      {
        cwd: packageRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

    let stdoutBuf = '';
    let stderrBuf = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });
    const waitChildLine = (expected: string): Promise<void> =>
      new Promise<void>((res, rej) => {
        const check = (): boolean => {
          if (stdoutBuf.includes(expected)) {
            res();
            return true;
          }
          return false;
        };
        if (check()) return;
        const onData = (chunk: Buffer): void => {
          stdoutBuf += chunk.toString('utf8');
          if (check()) child.stdout!.off('data', onData);
        };
        child.stdout!.on('data', onData);
        child.once('exit', (code) => {
          rej(new Error(`foreign host exited early (${String(code)}): ${stderrBuf}`));
        });
      });

    try {
      await waitChildLine('LOCKED_SPINNING');
      const onDiskBefore = JSON.parse(await readFile(coldLockPath, 'utf8')) as {
        pid: number;
        threadId?: number;
        workerBeacon?: string;
      };
      expect(onDiskBefore.pid).toBe(child.pid);
      expect(onDiskBefore.threadId).toBeGreaterThan(0);
      expect(typeof onDiskBefore.workerBeacon).toBe('string');

      await expect(acquireFileLock(coldLockPath, { waitForMs: 120 })).rejects.toMatchObject({
        code: 'storage.locked',
      });

      child.stdin!.write('TERMINATE_WORKER\n');
      await waitChildLine('WORKER_TERMINATED');
      expect(child.exitCode).toBeNull();

      const taken = await acquireFileLock(coldLockPath, {
        waitForMs: 3_000,
        owner: { from: 'parent-takeover' },
      });
      try {
        const afterTakeover = JSON.parse(await readFile(coldLockPath, 'utf8')) as {
          pid: number;
          owner?: Record<string, unknown>;
        };
        expect(afterTakeover.pid).toBe(process.pid);
        expect(afterTakeover.owner).toEqual({ from: 'parent-takeover' });
      } finally {
        await taken.release();
      }
    } finally {
      child.kill('SIGKILL');
      await new Promise<void>((done) => {
        if (child.exitCode !== null) done();
        else child.once('exit', () => done());
      });
      closeSparseFileWorker();
    }
  }, 25_000);

  it('fails closed in a worker thread when local worker beacon bind fails without writing .lock, .watch, or .reader sidecars (Round-6 #2)', async () => {
    directory = await mkdtemp(join(tmpdir(), 'fss-r6-beacon-fail-closed-'));
    const wirePath = join(directory, 'wire.jsonl');
    await writeFile(wirePath, '{"ok":1}\n');
    const coldLockPath = `${wirePath}.cold.lock`;
    const packageRoot = resolve(import.meta.dirname, '../../../..');
    const fileLockUrl = pathToFileURL(
      resolve(packageRoot, 'src/persistence/backends/node-fs/fileLock.ts'),
    ).href;
    const tsxApiUrl = import.meta.resolve('tsx/esm/api');
    const tsconfigPath = resolve(packageRoot, 'tsconfig.json');
    const workerScriptPath = join(directory, 'beacon-emfile-worker.mjs');

    await writeFile(
      workerScriptPath,
      [
        "import net from 'node:net';",
        "import { parentPort, workerData } from 'node:worker_threads';",
        `import { register as registerTypeScript } from ${JSON.stringify(tsxApiUrl)};`,
        `registerTypeScript({ tsconfig: ${JSON.stringify(tsconfigPath)} });`,
        'net.Server.prototype.listen = function () {',
        "  queueMicrotask(() => this.emit('error', Object.assign(new Error('EMFILE: beacon bind exhausted'), { code: 'EMFILE' })));",
        '  return this;',
        '};',
        `const { acquireFileLock, acquireSharedReadLease } = await import(${JSON.stringify(fileLockUrl)});`,
        'let lockErr = null;',
        'let readerErr = null;',
        'try { await acquireFileLock(workerData.coldLockPath, { waitForMs: 100 }); } catch (err) { lockErr = String(err); }',
        'try { await acquireSharedReadLease(workerData.wirePath); } catch (err) { readerErr = String(err); }',
        'parentPort.postMessage({ lockErr, readerErr });',
      ].join('\n'),
    );

    const worker = new Worker(workerScriptPath, {
      workerData: { wirePath, coldLockPath },
    });
    try {
      const outcome = await new Promise<{ lockErr: string | null; readerErr: string | null }>((res, rej) => {
        worker.once('message', res);
        worker.once('error', rej);
      });
      expect(outcome.lockErr).toBeTruthy();
      expect(outcome.readerErr).toContain('EMFILE');

      const entries = await readdir(directory);
      expect(entries.filter((name) => name.includes('.cold.lock') || name.includes('.readers'))).toEqual([]);
    } finally {
      await worker.terminate();
    }
  }, 15_000);
});

