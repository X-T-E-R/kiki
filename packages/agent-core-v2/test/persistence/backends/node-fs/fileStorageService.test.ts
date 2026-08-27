import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';

const isWin = process.platform === 'win32';
const encoder = new TextEncoder();

describe('FileStorageService — file permissions', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fss-perm-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  // Windows 不建模 POSIX mode（chmod 是 no-op）；权限行为由 POSIX 平台的这条断言守
  it.skipIf(isWin)('creates scope directories with dirMode (0700)', async () => {
    const svc = new FileStorageService(dir, 0o700, 0o600);
    await svc.write('cron/ws', 'abc.json', encoder.encode('{}'));

    const dirStat = await stat(join(dir, 'cron/ws'));
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  // Windows 不建模 POSIX mode（chmod 是 no-op）；权限行为由 POSIX 平台的这条断言守
  it.skipIf(isWin)('writes documents with fileMode (0600)', async () => {
    const svc = new FileStorageService(dir, 0o700, 0o600);
    await svc.write('cron/ws', 'abc.json', encoder.encode('{"x":1}'));

    const fileStat = await stat(join(dir, 'cron/ws', 'abc.json'));
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  // Windows 不建模 POSIX mode（chmod 是 no-op）；权限行为由 POSIX 平台的这条断言守
  it.skipIf(isWin)('defaults to the process umask when modes are omitted', async () => {
    const svc = new FileStorageService(dir);
    await svc.write('scope', 'k.json', encoder.encode('{}'));
    const fileStat = await stat(join(dir, 'scope', 'k.json'));
    expect(fileStat.mode & 0o400).toBe(0o400);
  });
});

describe('FileStorageService — error translation', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fss-err-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('keeps ENOENT semantics: read returns undefined, list returns []', async () => {
    const svc = new FileStorageService(dir);
    expect(await svc.read('scope', 'missing.json')).toBeUndefined();
    expect(await svc.list('missing-scope')).toEqual([]);
    await expect(svc.delete('scope', 'missing.json')).resolves.toBeUndefined();
  });

  it.skipIf(isWin)('translates non-ENOENT failures into StorageError(io_failed)', async () => {
    const svc = new FileStorageService(dir);
    await mkdir(join(dir, 'scope', 'adir'), { recursive: true });
    await expect(svc.read('scope', 'adir')).rejects.toSatisfy((error: unknown) => {
      expect(error).toMatchObject({ code: 'storage.io_failed' });
      const io = error as { details?: Record<string, unknown>; cause?: unknown };
      expect(io.details).toMatchObject({
        path: join(dir, 'scope', 'adir'),
        op: 'read',
        errno: 'EISDIR',
      });
      expect(io.cause).toBeInstanceOf(Error);
      return true;
    });
  });

  it.skipIf(isWin)('translates write failures into StorageError(io_failed)', async () => {
    const svc = new FileStorageService(dir);
    await writeFile(join(dir, 'blocked'), 'x');
    await expect(svc.write('blocked', 'k.json', encoder.encode('{}'))).rejects.toMatchObject({
      code: 'storage.io_failed',
      details: { op: 'write', errno: expect.any(String) },
    });
  });
});

describe('FileStorageService — exclusive locks', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fss-lock-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('rejects a second holder with storage.locked and releases ownership', async () => {
    const first = new FileStorageService(dir);
    const second = new FileStorageService(dir);
    const held = await first.acquireLock('session-locks', 'session.lock', {
      owner: { sessionId: 'session-1', workspaceId: 'workspace-1' },
    });

    await expect(
      second.acquireLock('session-locks', 'session.lock', {
        owner: { sessionId: 'session-1', workspaceId: 'workspace-1' },
      }),
    ).rejects.toMatchObject({
      code: 'storage.locked',
      details: {
        owner: { sessionId: 'session-1', workspaceId: 'workspace-1' },
        pid: process.pid,
      },
    });

    await held.release();
    const replacement = await second.acquireLock('session-locks', 'session.lock');
    await replacement.release();
  });

  it('reclaims an expired lease even when the recorded pid is alive', async () => {
    const lockDir = join(dir, 'session-locks');
    const lockPath = join(lockDir, 'session.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        processStartedAt: Math.floor(Date.now() - process.uptime() * 1_000),
        token: 'expired-owner',
        acquiredAt: Date.now() - 10_000,
        leaseMs: 1_000,
        owner: { sessionId: 'session-stale' },
      }),
    );
    const expiredAt = new Date(Date.now() - 5_000);
    await utimes(lockPath, expiredAt, expiredAt);

    const svc = new FileStorageService(dir);
    const lock = await svc.acquireLock('session-locks', 'session.lock', {
      leaseMs: 1_000,
      renewIntervalMs: 250,
      owner: { sessionId: 'session-stale' },
    });
    await lock.release();
  });

  it('allows exactly one contender to win a stale-lock takeover', async () => {
    const lockDir = join(dir, 'session-locks');
    const lockPath = join(lockDir, 'session.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        processStartedAt: 0,
        token: 'dead-owner',
        acquiredAt: Date.now() - 10_000,
        leaseMs: 1_000,
      }),
    );

    const contenders = [new FileStorageService(dir), new FileStorageService(dir)];
    const results = await Promise.allSettled(
      contenders.map((svc, index) =>
        svc.acquireLock('session-locks', 'session.lock', {
          leaseMs: 1_000,
          renewIntervalMs: 250,
          owner: { sessionId: `session-${index}` },
        }),
      ),
    );
    const winners = results.filter((result) => result.status === 'fulfilled');
    const losers = results.filter((result) => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ reason: { code: 'storage.locked' } });
    if (winners[0]?.status === 'fulfilled') await winners[0].value.release();
  });
});

describe('FileStorageService — writeStream', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fss-stream-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('writes a chunked source and replaces the whole value', async () => {
    const svc = new FileStorageService(dir);
    await svc.write('scope', 'k.bin', encoder.encode('old'));
    await svc.writeStream('scope', 'k.bin', (async function* () {
      yield encoder.encode('aa');
      yield encoder.encode('bbb');
    })());

    const chunks: Uint8Array[] = [];
    for await (const chunk of svc.readStream('scope', 'k.bin')) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('aabbb');
  });

  it('leaves no target file behind when the source fails mid-stream', async () => {
    const svc = new FileStorageService(dir);
    await expect(
      svc.writeStream('scope', 'k.bin', (async function* () {
        yield encoder.encode('partial');
        throw new Error('boom');
      })()),
    ).rejects.toThrow();

    expect(await svc.read('scope', 'k.bin')).toBeUndefined();
    expect(await svc.list('scope')).toEqual([]);
  });
});
