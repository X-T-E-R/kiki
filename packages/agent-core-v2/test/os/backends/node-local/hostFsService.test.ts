import { mkdir, mkdtemp, rm, stat as nodeStat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HostFileSystem } from '#/os/backends/node-local/hostFsService';

import { symlinkDir, windowsSymlinksUnavailable } from '../../../_base/utils/symlink';

let dir: string;
let fs: HostFileSystem;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kimi-hostfs-'));
  fs = new HostFileSystem();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

describe('HostFileSystem stat / lstat', () => {
  it('retains native ownership and permission metadata for protected file readers', async () => {
    const path = join(dir, 'private.txt');
    await writeFile(path, 'fixture-value', { mode: 0o600 });
    const expected = await nodeStat(path);
    expect(await fs.stat(path)).toMatchObject({ mode: expected.mode, uid: expected.uid });
    expect(await fs.lstat(path)).toMatchObject({ mode: expected.mode, uid: expected.uid });
  });

  it.skipIf(windowsSymlinksUnavailable)('stat follows a symlink to a regular file while lstat stats the link', async () => {
    const target = join(dir, 'target.txt');
    await writeFile(target, 'hello', 'utf-8');
    const link = join(dir, 'link.txt');
    await symlink(target, link);

    const st = await fs.stat(link);
    expect(st.isFile).toBe(true);
    expect(st.isSymbolicLink).not.toBe(true);

    const lst = await fs.lstat(link);
    expect(lst.isSymbolicLink).toBe(true);
    expect(lst.isFile).toBe(false);
  });

  it('stat follows a symlink to a directory', async () => {
    const target = join(dir, 'subdir');
    await mkdir(target);
    const link = join(dir, 'dirlink');
    await symlinkDir(target, link);

    expect((await fs.stat(link)).isDirectory).toBe(true);
    expect((await fs.lstat(link)).isDirectory).toBe(false);
  });

  it('stat rejects a dangling symlink while lstat still stats the link', async () => {
    const link = join(dir, 'dangling');
    await symlinkDir(join(dir, 'missing'), link);

    await expect(fs.stat(link)).rejects.toThrow();
    expect((await fs.lstat(link)).isSymbolicLink).toBe(true);
  });
});

describe('HostFileSystem readLineRange', () => {
  async function collect(path: string, startLine: number, maxLines: number): Promise<string[]> {
    const lines: string[] = [];
    for await (const line of fs.readLineRange(path, { startLine, maxLines })) lines.push(line);
    return lines;
  }

  it('reads a bounded window and preserves a BOM on non-first lines', async () => {
    const path = join(dir, 'range.txt');
    await writeFile(path, 'a\n\uFEFFb\nc\nd\n', 'utf-8');

    await expect(collect(path, 2, 2)).resolves.toEqual(['\uFEFFb\n', 'c\n']);
  });

  it('invalidates sparse line checkpoints after a rewrite', async () => {
    const path = join(dir, 'rewrite.txt');
    await writeFile(
      path,
      Array.from({ length: 700 }, (_, index) => `old-${String(index + 1)}`).join('\n'),
      'utf-8',
    );
    await expect(collect(path, 513, 2)).resolves.toEqual(['old-513\n', 'old-514\n']);

    await writeFile(
      path,
      Array.from({ length: 700 }, (_, index) => `new-value-${String(index + 1)}`).join('\n'),
      'utf-8',
    );
    await expect(collect(path, 513, 2)).resolves.toEqual([
      'new-value-513\n',
      'new-value-514\n',
    ]);
  });
});
