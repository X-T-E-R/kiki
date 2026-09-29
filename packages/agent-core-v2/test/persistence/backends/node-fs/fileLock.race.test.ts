import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
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

import { cleanupExpiredSessionLocks } from '#/persistence/backends/node-fs/fileLock';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';

describe('FileStorageService — stale takeover scheduling', () => {
  let directory: string | undefined;

  afterEach(async () => {
    schedule.beforeRename = undefined;
    schedule.afterRename = undefined;
    schedule.afterReaddir = undefined;
    schedule.beforeUnlink = undefined;
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

  it('does not let a paused stale-lock reaper unlink a new owner', async () => {
    directory = await mkdtemp(join(tmpdir(), 'fss-reap-race-'));
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
      expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({ token: 'dead-owner' });
      resume();
      expect(await reaping).toBe(1);
      const replacement = await new FileStorageService(directory).acquireLock('session-locks', 'session.lock');
      await replacement.release();
    } finally {
      resume();
      await reaping.catch(() => undefined);
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
});

