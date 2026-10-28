import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { ZipFile } from 'yazl';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  downloadZip,
  extractZip,
  MAX_ZIP_DOWNLOAD_BYTES,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_UNCOMPRESSED_BYTES,
} from '#/app/plugin/archive';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) };
});

async function smallArchive(): Promise<Buffer> {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({ name: 'cancel-archive' })), 'kimi.plugin.json');
  zip.addBuffer(Buffer.alloc(256 * 1024, 11), 'later.bin');
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('plugin archive extraction', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-archive-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('waits for an aborted extraction stream to close and writes no subsequent entry', async () => {
    const bytes = await smallArchive();
    const controller = new AbortController();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    let opened = 0;
    let closed = 0;
    const write = vi.mocked(fs.createWriteStream).mockImplementation((file, options) => {
      const stream = actual.createWriteStream(file, options);
      opened++;
      stream.once('open', () => { controller.abort(); });
      stream.once('close', () => { closed++; });
      return stream;
    });
    try {
      await expect(extractZip(bytes, join(dir, 'out'), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
      expect(opened).toBe(1);
      expect(closed).toBe(1);
      await expect(stat(join(dir, 'out', 'later.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
      await rm(join(dir, 'out'), { recursive: true });
    } finally {
      write.mockRestore();
    }
  });

  it('rejects a pre-cancelled extraction before creating scratch and rejects malformed input promptly', async () => {
    await expect(extractZip(await smallArchive(), join(dir, 'cancelled'), AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
    await expect(stat(join(dir, 'cancelled'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(extractZip(Buffer.from('invalid'), join(dir, 'malformed'))).rejects.toThrow('Failed to open zip');
  });

  it('cancels a pending download body reader when the caller aborts after headers', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const bodyStarted = new Promise<void>((resolve) => { started = resolve; });
    let cancelled = 0;
    let pulling = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        if (!pulling) {
          pulling = true;
          started();
        }
      },
      cancel() {
        cancelled += 1;
      },
    });
    const fetchMock = vi.fn(async () => new Response(stream));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const pending = downloadZip('https://example.test/download.zip', controller.signal).catch((error: unknown) => error);
      await bodyStarted;
      controller.abort();
      expect(await pending).toMatchObject({ name: 'AbortError' });
      expect(cancelled).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects a declared oversized download and cancels its body without reading it', async () => {
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled += 1;
      },
    });
    const fetchMock = vi.fn(async () => new Response(stream, {
      headers: { 'content-length': String(MAX_ZIP_DOWNLOAD_BYTES + 1) },
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(downloadZip('https://example.test/oversized.zip')).rejects.toMatchObject({ code: 'plugin.load_failed' });
      expect(cancelled).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
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
  }, 30_000);

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
