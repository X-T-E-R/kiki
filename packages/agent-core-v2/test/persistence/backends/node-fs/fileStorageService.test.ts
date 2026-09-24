import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanupExpiredSessionLocks } from '#/persistence/backends/node-fs/fileLock';
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

  it.skipIf(isWin)('creates scope directories with dirMode (0700) (POSIX only — Windows does not model POSIX modes, chmod is a no-op)', async () => {
    const svc = new FileStorageService(dir, 0o700, 0o600);
    await svc.write('cron/ws', 'abc.json', encoder.encode('{}'));

    const dirStat = await stat(join(dir, 'cron/ws'));
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it.skipIf(isWin)('writes documents with fileMode (0600) (POSIX only — Windows does not model POSIX modes, chmod is a no-op)', async () => {
    const svc = new FileStorageService(dir, 0o700, 0o600);
    await svc.write('cron/ws', 'abc.json', encoder.encode('{"x":1}'));

    const fileStat = await stat(join(dir, 'cron/ws', 'abc.json'));
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it.skipIf(isWin)('defaults to the process umask when modes are omitted (POSIX only — Windows does not model POSIX modes, chmod is a no-op)', async () => {
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

  it('does not reclaim an expired lease while its process is still alive', async () => {
    const lockDir = join(dir, 'session-locks');
    const lockPath = join(lockDir, 'session.lock');
    await mkdir(lockDir, { recursive: true });
    const payload = {
      version: 1,
      pid: process.pid,
      processStartedAt: Math.floor(Date.now() - process.uptime() * 1_000),
      token: 'live-owner',
      acquiredAt: Date.now() - 10_000,
      leaseMs: 1_000,
      owner: { sessionId: 'session-live' },
    };
    await writeFile(lockPath, JSON.stringify(payload));
    const expiredAt = new Date(Date.now() - 5_000);
    await utimes(lockPath, expiredAt, expiredAt);

    const svc = new FileStorageService(dir);
    await expect(svc.acquireLock('session-locks', 'session.lock')).rejects.toMatchObject({
      code: 'storage.locked',
      details: { owner: payload.owner, pid: process.pid },
    });
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(payload);
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
    const expiredAt = new Date(Date.now() - 5_000);
    await utimes(lockPath, expiredAt, expiredAt);

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

  it('atomically replaces a dead expired owner with a fresh token and timestamp', async () => {
    const lockDir = join(dir, 'session-locks');
    const lockPath = join(lockDir, 'session.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(lockPath, JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      processStartedAt: 0,
      token: 'old-token',
      acquiredAt: Date.now() - 10_000,
      leaseMs: 1_000,
    }));
    const expiredAt = new Date(Date.now() - 5_000);
    await utimes(lockPath, expiredAt, expiredAt);

    const before = Date.now();
    const lock = await new FileStorageService(dir).acquireLock('session-locks', 'session.lock');
    const current = JSON.parse(await readFile(lockPath, 'utf8')) as {
      pid: number; token: string; acquiredAt: number; processStartedAt: number;
    };
    expect(current).toMatchObject({ pid: process.pid, token: expect.not.stringMatching('old-token') });
    expect(current.acquiredAt).toBeGreaterThanOrEqual(before);
    expect(current.processStartedAt).toBeGreaterThan(0);
    await lock.release();
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fences a superseded holder when its pid has the wrong process start time', async () => {
    const lockPath = join(dir, 'session-locks', 'session.lock');
    const svc = new FileStorageService(dir);
    const old = await svc.acquireLock('session-locks', 'session.lock');
    const payload = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
    await writeFile(lockPath, JSON.stringify({ ...payload, processStartedAt: 0 }));
    const expiredAt = new Date(Date.now() - 180_000);
    await utimes(lockPath, expiredAt, expiredAt);

    const replacement = await svc.acquireLock('session-locks', 'session.lock');
    const current = JSON.parse(await readFile(lockPath, 'utf8')) as { token: string };
    expect(current.token).not.toBe(payload['token']);
    await old.release();
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({ token: current.token });
    await replacement.release();
  });

  it.skipIf(!isWin)('distinguishes a live foreign Windows process from a reused pid', async () => {
    const child = spawn(process.execPath, [
      '-e',
      'process.stdout.write(String(Math.floor(Date.now() - process.uptime() * 1000))); setInterval(() => {}, 1000)',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await once(child, 'spawn');
      const [startTime] = await once(child.stdout, 'data');
      const lockPath = join(dir, 'session-locks', 'session.lock');
      await mkdir(join(dir, 'session-locks'), { recursive: true });
      const payload = {
        version: 1,
        pid: child.pid,
        processStartedAt: Number(startTime.toString()),
        token: 'foreign-owner',
        acquiredAt: Date.now() - 10_000,
        leaseMs: 1_000,
      };
      await writeFile(lockPath, JSON.stringify(payload));
      const expiredAt = new Date(Date.now() - 5_000);
      await utimes(lockPath, expiredAt, expiredAt);
      const svc = new FileStorageService(dir);
      await expect(svc.acquireLock('session-locks', 'session.lock')).rejects.toMatchObject({
        code: 'storage.locked',
      });
      expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(payload);
      await writeFile(lockPath, JSON.stringify({ ...payload, processStartedAt: 0 }));
      await utimes(lockPath, expiredAt, expiredAt);
      const lock = await svc.acquireLock('session-locks', 'session.lock');
      expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({ pid: process.pid });
      await lock.release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, 'exit');
      }
    }
  });

  it('cleans up only expired dead locks and leaves live, fresh, and malformed locks alone', async () => {
    const lockDir = join(dir, 'session-locks');
    await mkdir(lockDir, { recursive: true });
    const payload = {
      version: 1,
      pid: 2_147_483_647,
      processStartedAt: 0,
      token: 'dead-token',
      acquiredAt: Date.now() - 180_000,
      leaseMs: 1_000,
    };
    const dead = join(lockDir, 'expired-dead.lock');
    const live = join(lockDir, 'expired-live.lock');
    const fresh = join(lockDir, 'fresh-dead.lock');
    const malformed = join(lockDir, 'malformed.lock');
    await writeFile(dead, JSON.stringify(payload));
    await writeFile(live, JSON.stringify({
      ...payload,
      pid: process.pid,
      processStartedAt: Math.floor(Date.now() - process.uptime() * 1_000),
    }));
    await writeFile(fresh, JSON.stringify(payload));
    await writeFile(malformed, '{incomplete');
    const expiredAt = new Date(Date.now() - 5_000);
    await Promise.all([utimes(dead, expiredAt, expiredAt), utimes(live, expiredAt, expiredAt)]);

    expect(await cleanupExpiredSessionLocks(dir)).toBe(1);
    await expect(readFile(dead)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(live)).resolves.toBeDefined();
    await expect(readFile(fresh)).resolves.toBeDefined();
    await expect(readFile(malformed)).resolves.toBeDefined();
    await expect(new FileStorageService(dir).acquireLock('session-locks', 'fresh-dead.lock'))
      .rejects.toMatchObject({ code: 'storage.locked' });
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

describe('FileStorageService — mtime', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fss-mtime-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns undefined for a missing file and the stat mtime for an existing one', async () => {
    const svc = new FileStorageService(dir);
    expect(await svc.mtime('scope', 'missing.json')).toBeUndefined();

    await svc.write('scope', 'k.json', encoder.encode('{}'));
    const expected = (await stat(join(dir, 'scope', 'k.json'))).mtimeMs;
    expect(await svc.mtime('scope', 'k.json')).toBe(expected);
  });

  it('reflects rewrites and deletions', async () => {
    const svc = new FileStorageService(dir);
    await svc.write('scope', 'k.json', encoder.encode('{}'));
    const before = await svc.mtime('scope', 'k.json');

    const bumped = new Date(Date.now() + 10_000);
    await utimes(join(dir, 'scope', 'k.json'), bumped, bumped);
    expect(await svc.mtime('scope', 'k.json')).toBeGreaterThan(before ?? 0);

    await svc.delete('scope', 'k.json');
    expect(await svc.mtime('scope', 'k.json')).toBeUndefined();
  });
});

describe('FileStorageService — orphaned temp recovery', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fss-recover-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('promotes a surviving temp file when the target is missing (dead writer pid)', async () => {
    await mkdir(join(dir, 'scope'), { recursive: true });
    const DEAD_PID_BEYOND_TYPICAL_PID_LIMIT = 4_000_000;
    const deadPid = DEAD_PID_BEYOND_TYPICAL_PID_LIMIT;
    await writeFile(
      join(dir, 'scope', `config.toml.tmp.${deadPid}.deadbeef`),
      encoder.encode('recovered = true'),
    );
    const svc = new FileStorageService(dir);
    const bytes = await svc.read('scope', 'config.toml');
    expect(bytes === undefined ? '' : new TextDecoder().decode(bytes)).toContain('recovered = true');
    await expect(
      stat(join(dir, 'scope', `config.toml.tmp.${deadPid}.deadbeef`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await svc.read('scope', 'config.toml')).toBeDefined();
  });

  it('does not promote temps from a live pid, and returns undefined with no candidates', async () => {
    await mkdir(join(dir, 'scope'), { recursive: true });
    await writeFile(
      join(dir, 'scope', `config.toml.tmp.${process.pid}.ffffff`),
      encoder.encode('live-writer'),
    );
    const svc = new FileStorageService(dir);
    expect(await svc.read('scope', 'config.toml')).toBeUndefined();
    await expect(
      readFile(join(dir, 'scope', `config.toml.tmp.${process.pid}.ffffff`)),
    ).resolves.toBeDefined();
  });
});

describe('FileStorageService — rewrite keeps file mode', () => {
  it.skipIf(isWin)('re-applies fileMode after overwriting a document with a drifted mode (POSIX only)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fss-mode-'));
    try {
      const svc = new FileStorageService(dir, 0o700, 0o600);
      await svc.write('scope', 'k.json', encoder.encode('{"x":1}'));
      const { chmod } = await import('node:fs/promises');
      await chmod(join(dir, 'scope', 'k.json'), 0o644);
      await svc.write('scope', 'k.json', encoder.encode('{"x":2}'));
      const fileStat = await stat(join(dir, 'scope', 'k.json'));
      expect(fileStat.mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});
