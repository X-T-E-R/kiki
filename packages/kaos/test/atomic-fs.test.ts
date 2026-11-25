import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  atomicCreate,
  atomicWrite,
  atomicWriteStream,
  atomicWriteSync,
  writeFileAtomicDurable,
} from '#/atomic-fs';

const dirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kaos-atomic-fs-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('@kiki/kaos/atomic-fs', () => {
  it('writes and replaces files atomically with no leftover temp files', async () => {
    const dir = await makeTempDir();
    const target = join(dir, 'doc.txt');

    await atomicWrite(target, 'first', undefined, 0o600);
    expect(await readFile(target, 'utf8')).toBe('first');

    await atomicWrite(target, 'second', undefined, 0o600, undefined, true);
    expect(await readFile(target, 'utf8')).toBe('second');

    atomicWriteSync(target, 'third', 0o600);
    expect(await readFile(target, 'utf8')).toBe('third');

    await writeFileAtomicDurable(target, 'fourth');
    expect(await readFile(target, 'utf8')).toBe('fourth');

    if (process.platform !== 'win32') {
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    }
    expect(await readdir(dir)).toEqual(['doc.txt']);
  });

  it('aborts before touching the target and cleans up temp files on failure', async () => {
    const dir = await makeTempDir();
    const target = join(dir, 'doc.txt');
    await atomicWrite(target, 'original');

    const controller = new AbortController();
    controller.abort();
    await expect(atomicWrite(target, 'never', undefined, undefined, controller.signal)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('original');

    await expect(
      atomicWrite(target, 'boom', async () => {
        throw new Error('sync failed');
      }),
    ).rejects.toThrow('sync failed');
    expect(await readFile(target, 'utf8')).toBe('original');
    expect(await readdir(dir)).toEqual(['doc.txt']);
  });

  it('creates exclusively once and writes streams atomically', async () => {
    const dir = await makeTempDir();
    const created = join(dir, 'exclusive.txt');
    await atomicCreate(created, 'hello');
    expect(await readFile(created, 'utf8')).toBe('hello');
    await expect(atomicCreate(created, 'again')).rejects.toMatchObject({ code: 'EEXIST' });

    const streamed = join(dir, 'stream.bin');
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode('alpha-');
      yield new Uint8Array(0);
      yield new TextEncoder().encode('beta');
    }
    await atomicWriteStream(streamed, chunks());
    expect(await readFile(streamed, 'utf8')).toBe('alpha-beta');
  });
});
