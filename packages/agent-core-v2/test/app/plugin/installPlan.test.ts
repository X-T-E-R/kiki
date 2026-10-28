import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fingerprintDirectory } from '#/app/plugin/installPlan';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

describe('plugin content fingerprint', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'plugin-fingerprint-')); });
  afterEach(async () => {
    vi.mocked(fs.createReadStream).mockRestore();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('preserves the complete ordered byte contract including dependency files and large files', async () => {
    await mkdir(path.join(root, 'node_modules', 'example'), { recursive: true });
    await mkdir(path.join(root, 'empty'));
    await writeFile(path.join(root, 'node_modules', 'example', 'index.js'), 'export const value = 1;');
    await writeFile(path.join(root, 'asset.bin'), Buffer.alloc(1024 * 1024 + 7, 19));
    await writeFile(path.join(root, '文本.txt'), 'complete contents');
    const digest = createHash('sha256');
    async function originalWalk(directory: string): Promise<void> {
      for (const entry of (await readdir(directory, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await originalWalk(file);
        else {
          digest.update(path.relative(root, file).replaceAll('\\', '/'));
          digest.update('\0');
          digest.update(await readFile(file));
        }
      }
    }
    await originalWalk(root);
    const expected = digest.digest('hex');
    expect(await fingerprintDirectory(root)).toBe(expected);
    await writeFile(path.join(root, 'node_modules', 'example', 'index.js'), 'export const value = 2;');
    expect(await fingerprintDirectory(root)).not.toBe(expected);
  });

  it('rejects before IO when already cancelled', async () => {
    vi.mocked(fs.createReadStream).mockClear();
    await expect(fingerprintDirectory(root, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.createReadStream).not.toHaveBeenCalled();
  });

  it('closes all prefetched streams before cancellation settles and starts no later batch', async () => {
    for (let index = 0; index < 20; index++) await writeFile(path.join(root, `${index}.bin`), Buffer.alloc(256 * 1024, index));
    const controller = new AbortController();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    let opened = 0;
    let closed = 0;
    vi.mocked(fs.createReadStream).mockImplementation((file, options) => {
      const stream = actual.createReadStream(file, options);
      opened++;
      stream.once('close', () => { closed++; });
      if (opened === 1) stream.once('data', () => { controller.abort(); });
      return stream;
    });
    await expect(fingerprintDirectory(root, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(opened).toBe(8);
    expect(closed).toBe(opened);
    await yieldTurn();
    expect(opened).toBe(8);
  });

  it('rejects symbolic links instead of excluding their bytes', async () => {
    const nested = path.join(root, 'nested');
    await mkdir(nested);
    await symlink(nested, path.join(root, 'alias'), 'junction');
    await expect(fingerprintDirectory(root)).rejects.toThrow('symbolic link');
  });
});
