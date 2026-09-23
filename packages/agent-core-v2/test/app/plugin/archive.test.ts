import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  extractZip,
  MAX_ZIP_DOWNLOAD_BYTES,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_UNCOMPRESSED_BYTES,
} from '#/app/plugin/archive';

describe('plugin archive extraction', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-archive-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('extracts a zip and detects a nested plugin root', async () => {
    const source = join(dir, 'source');
    const nested = join(source, 'plugin');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'kimi.plugin.json'), JSON.stringify({ name: 'zip-demo' }), 'utf8');
    const zipPath = join(dir, 'plugin.zip');
    execFileSync('zip', ['-qr', zipPath, '.'], { cwd: source });

    const outDir = join(dir, 'out');
    const detectedRoot = await extractZip(await readFile(zipPath), outDir);

    expect(detectedRoot).toBe(join(outDir, 'plugin'));
    await expect(readFile(join(detectedRoot, 'kimi.plugin.json'), 'utf8')).resolves.toContain('zip-demo');
  });

  it('extracts a zip that stays under every ceiling', async () => {
    const source = join(dir, 'source');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'kimi.plugin.json'), JSON.stringify({ name: 'zip-demo' }), 'utf8');
    const zipPath = join(dir, 'plugin.zip');
    execFileSync('zip', ['-qr', zipPath, '.'], { cwd: source });

    const outDir = join(dir, 'out');
    await expect(extractZip(await readFile(zipPath), outDir)).resolves.toBe(outDir);
  });

  it('rejects a zip buffer above the download limit before extracting', async () => {
    const oversized = Buffer.alloc(MAX_ZIP_DOWNLOAD_BYTES + 1);
    await expect(extractZip(oversized, join(dir, 'out'))).rejects.toMatchObject({
      code: 'plugin.load_failed',
    });
    await expect(stat(join(dir, 'out'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a zip whose uncompressed size exceeds the limit', async () => {
    const source = join(dir, 'source');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'kimi.plugin.json'), JSON.stringify({ name: 'zip-bomb' }), 'utf8');
    await writeFile(
      join(source, 'zeros.bin'),
      Buffer.alloc(MAX_ZIP_UNCOMPRESSED_BYTES / 2, 0),
    );
    await writeFile(
      join(source, 'zeros2.bin'),
      Buffer.alloc(MAX_ZIP_UNCOMPRESSED_BYTES / 2 + 1, 0),
    );
    const zipPath = join(dir, 'plugin.zip');
    execFileSync('zip', ['-qr', zipPath, '.'], { cwd: source });
    const buffer = await readFile(zipPath);
    expect(buffer.byteLength).toBeLessThan(MAX_ZIP_DOWNLOAD_BYTES);

    await expect(extractZip(buffer, join(dir, 'out'))).rejects.toMatchObject({
      code: 'plugin.load_failed',
    });
  });

  it('rejects a zip with more entries than the entry limit', async () => {
    const source = join(dir, 'source');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'kimi.plugin.json'), JSON.stringify({ name: 'zip-many' }), 'utf8');
    for (let i = 0; i < MAX_ZIP_ENTRIES; i += 1) {
      await writeFile(join(source, `f${i}.txt`), 'x', 'utf8');
    }
    const zipPath = join(dir, 'plugin.zip');
    execFileSync('zip', ['-qr', zipPath, '.'], { cwd: source });

    await expect(extractZip(await readFile(zipPath), join(dir, 'out'))).rejects.toMatchObject({
      code: 'plugin.load_failed',
    });
  }, 240_000);
});
