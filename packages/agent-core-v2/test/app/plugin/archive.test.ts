import * as fs from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipFile } from 'yazl';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  downloadZip,
  extractZip,
  MAX_ZIP_DOWNLOAD_BYTES,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_SINGLE_ENTRY_BYTES,
  MAX_ZIP_UNCOMPRESSED_BYTES,
} from '#/app/plugin/archive';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) };
});

async function buildArchive(entries: readonly { path: string; data: Buffer | string }[]): Promise<Buffer> {
  const zip = new ZipFile();
  for (const entry of entries) {
    const buf = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    zip.addBuffer(buf, entry.path);
  }
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function smallArchive(): Promise<Buffer> {
  return buildArchive([
    { path: 'kimi.plugin.json', data: JSON.stringify({ name: 'cancel-archive' }) },
    { path: 'later.bin', data: Buffer.alloc(64 * 1024, 11) },
  ]);
}

describe('plugin archive extraction', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-archive-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('pins production default archive ceilings', () => {
    expect(MAX_ZIP_DOWNLOAD_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_ZIP_UNCOMPRESSED_BYTES).toBe(200 * 1024 * 1024);
    expect(MAX_ZIP_SINGLE_ENTRY_BYTES).toBe(200 * 1024 * 1024);
    expect(MAX_ZIP_ENTRIES).toBe(20_000);
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
    } finally {
      write.mockRestore();
    }
  });

  it('rejects pre-cancelled, malformed, and path-traversal archives promptly', async () => {
    await expect(extractZip(await smallArchive(), join(dir, 'cancelled'), AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
    await expect(stat(join(dir, 'cancelled'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(extractZip(Buffer.from('invalid'), join(dir, 'malformed'))).rejects.toThrow('Failed to open zip');
    const baseTraversal = await buildArchive([{ path: 'aa/escape.txt', data: 'nope' }]);
    const traversal = Buffer.from(baseTraversal.toString('latin1').replaceAll('aa/escape.txt', '../escape.txt'), 'latin1');
    await expect(extractZip(traversal, join(dir, 'escape'))).rejects.toThrow(/invalid relative path|Path traversal/);
  });

  it('cancels a pending download body reader on abort and enforces declared or streamed download limits', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const bodyStarted = new Promise<void>((resolve) => { started = resolve; });
    let cancelled = 0;
    let pulling = false;
    const hangingStream = new ReadableStream<Uint8Array>({
      pull() {
        if (!pulling) {
          pulling = true;
          started();
        }
      },
      cancel() { cancelled += 1; },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(hangingStream)));
    try {
      const pending = downloadZip('https://example.test/download.zip', controller.signal).catch((error: unknown) => error);
      await bodyStarted;
      controller.abort();
      expect(await pending).toMatchObject({ name: 'AbortError' });
      expect(cancelled).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }

    let declaredCancelled = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      cancel() { declaredCancelled += 1; },
    }), { headers: { 'content-length': '513' } })));
    try {
      await expect(downloadZip('https://example.test/oversized.zip', undefined, { maxDownloadBytes: 512 }))
        .rejects.toMatchObject({ code: 'plugin.load_failed' });
      expect(declaredCancelled).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }

    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.alloc(513, 1))));
    try {
      await expect(downloadZip('https://example.test/streamed.zip', undefined, { maxDownloadBytes: 512 }))
        .rejects.toMatchObject({ code: 'plugin.load_failed' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('extracts root or nested plugin manifests and enforces download, entry, single-entry, and uncompressed ceilings', async () => {
    const nested = await buildArchive([{ path: 'plugin/kimi.plugin.json', data: JSON.stringify({ name: 'zip-demo' }) }]);
    const nestedRoot = await extractZip(nested, join(dir, 'nested'));
    expect(nestedRoot).toBe(join(dir, 'nested', 'plugin'));
    await expect(readFile(join(nestedRoot, 'kimi.plugin.json'), 'utf8')).resolves.toContain('zip-demo');

    const manifest = JSON.stringify({ name: 'zip-bound' });
    const bounded = await buildArchive([
      { path: 'kimi.plugin.json', data: manifest },
      { path: 'a.bin', data: Buffer.alloc(100, 1) },
      { path: 'b.bin', data: Buffer.alloc(101, 2) },
    ]);
    const totalUncompressed = Buffer.byteLength(manifest) + 201;

    await expect(extractZip(bounded, join(dir, 'ok'), undefined, {
      maxDownloadBytes: bounded.byteLength,
      maxEntries: 3,
      maxSingleEntryBytes: 101,
      maxUncompressedBytes: totalUncompressed,
    })).resolves.toBe(join(dir, 'ok'));

    await expect(extractZip(bounded, join(dir, 'over-dl'), undefined, {
      maxDownloadBytes: bounded.byteLength - 1,
    })).rejects.toMatchObject({ code: 'plugin.load_failed' });
    await expect(stat(join(dir, 'over-dl'))).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(extractZip(bounded, join(dir, 'over-entries'), undefined, {
      maxEntries: 2,
    })).rejects.toMatchObject({ code: 'plugin.load_failed' });

    await expect(extractZip(bounded, join(dir, 'over-single'), undefined, {
      maxSingleEntryBytes: 100,
    })).rejects.toMatchObject({ code: 'plugin.load_failed' });

    await expect(extractZip(bounded, join(dir, 'over-uncompressed'), undefined, {
      maxUncompressedBytes: totalUncompressed - 1,
    })).rejects.toMatchObject({ code: 'plugin.load_failed' });
  });
});
