import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LegacyMinidbLock } from '#/persistence/backends/sqliteMailbox/legacyMinidbReader';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kiki-legacy-lock-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('LegacyMinidbLock', () => {
  it('allows only one contender to acquire under parallel calls and preserves owner token on release', async () => {
    const lockPath = join(dir, 'db.lock');
    const locks = Array.from({ length: 8 }, () => new LegacyMinidbLock(lockPath));
    const results = await Promise.all(locks.map((lock) => lock.acquire()));
    const winners = locks.filter((_lock, index) => results[index] === true);
    expect(winners).toHaveLength(1);

    const onDisk = JSON.parse(await readFile(lockPath, 'utf8')) as { token: string };
    expect(onDisk.token).toBe(winners[0]!.heldToken);

    await winners[0]!.release();
    const next = new LegacyMinidbLock(lockPath);
    expect(await next.acquire()).toBe(true);
    await next.release();
  });

  it('treats a freshly created empty lock file as held during the creation grace window', async () => {
    const lockPath = join(dir, 'db.lock');
    await writeFile(lockPath, '', 'utf8');
    const contender = new LegacyMinidbLock(lockPath);
    expect(await contender.acquire()).toBe(false);

    const staleTime = new Date(Date.now() - 10_000);
    await utimes(lockPath, staleTime, staleTime);
    expect(await contender.acquire()).toBe(true);
    await contender.release();
  });

  it('reclaims a stale lock atomically under contention without deleting the winner lock', async () => {
    const lockPath = join(dir, 'db.lock');
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, processStartedAt: 1, ts: 1, token: 'stale:pid-reused' }), 'utf8');
    const contenders = Array.from({ length: 6 }, () => new LegacyMinidbLock(lockPath));
    const results = await Promise.all(contenders.map((lock) => lock.acquire()));
    const winners = contenders.filter((_lock, index) => results[index] === true);
    expect(winners).toHaveLength(1);

    const onDisk = JSON.parse(await readFile(lockPath, 'utf8')) as { token: string };
    expect(onDisk.token).toBe(winners[0]!.heldToken);
    await winners[0]!.release();
  });
});
