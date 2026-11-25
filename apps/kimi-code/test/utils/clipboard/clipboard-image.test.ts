import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { ClipboardMediaError, readClipboardMedia } from '#/utils/clipboard/clipboard-image';
import type { ClipboardModule } from '#/utils/clipboard/clipboard-native';

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes[16] = (width >>> 24) & 0xff;
  bytes[17] = (width >>> 16) & 0xff;
  bytes[18] = (width >>> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = (height >>> 24) & 0xff;
  bytes[21] = (height >>> 16) & 0xff;
  bytes[22] = (height >>> 8) & 0xff;
  bytes[23] = height & 0xff;
  return bytes;
}

function fakeClipboard(overrides: Partial<ClipboardModule>): ClipboardModule {
  return {
    hasImage: vi.fn(() => false),
    getImageBinary: vi.fn(async () => []),
    ...overrides,
  };
}

function noMacOsPaths(): { stdout: Buffer; ok: boolean } {
  return { stdout: Buffer.alloc(0), ok: false };
}

describe('readClipboardMedia', () => {
  it('reads a copied image file from its real path instead of the Finder preview icon', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-code-clip-'));
    try {
      const imagePath = join(dir, 'photo.png');
      const imageBytes = png(12, 34);
      writeFileSync(imagePath, imageBytes);
      const getImageBinary = vi.fn(async () => Array.from(png(1, 1)));
      const clip = fakeClipboard({
        availableFormats: vi.fn(() => ['public.file-url', 'public.png']),
        hasImage: vi.fn(() => true),
        getImageBinary,
      });
      const runCommand = vi.fn(() => ({ stdout: Buffer.from(`${imagePath}\n`), ok: true }));

      const media = await readClipboardMedia({ platform: 'darwin', clipboard: clip, runCommand });

      expect(media).toEqual({
        kind: 'image',
        bytes: imageBytes,
        mimeType: 'image/png',
      });
      expect(getImageBinary).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('prefers a video file URL over an available image preview', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-code-clip-'));
    try {
      const videoPath = join(dir, 'sample.mov');
      writeFileSync(videoPath, new Uint8Array([0, 1, 2]));
      const getImageBinary = vi.fn(async () => [0x89, 0x50, 0x4e, 0x47]);
      const clip = fakeClipboard({
        availableFormats: vi.fn(() => ['public.file-url', 'public.png']),
        hasText: vi.fn(() => true),
        getText: vi.fn(async () => pathToFileURL(videoPath).toString()),
        hasImage: vi.fn(() => true),
        getImageBinary,
      });

      const media = await readClipboardMedia({
        platform: 'darwin',
        clipboard: clip,
        runCommand: noMacOsPaths,
      });

      expect(media?.kind).toBe('video');
      expect(media).toMatchObject({
        mimeType: 'video/quicktime',
        filename: 'sample.mov',
        sourcePath: videoPath,
      });
      expect(getImageBinary).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('falls back to native image bytes when no video file is present', async () => {
    const clip = fakeClipboard({
      availableFormats: vi.fn(() => ['public.png']),
      hasText: vi.fn(() => false),
      hasImage: vi.fn(() => true),
      getImageBinary: vi.fn(async () => [0x89, 0x50, 0x4e, 0x47]),
    });

    const media = await readClipboardMedia({
      platform: 'darwin',
      clipboard: clip,
      runCommand: noMacOsPaths,
    });

    expect(media).toEqual({
      kind: 'image',
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mimeType: 'image/png',
    });
  });

  it('does not consume file-like clipboard image previews when no real file path is readable', async () => {
    const getImageBinary = vi.fn(async () => Array.from(png(1, 1)));
    const clip = fakeClipboard({
      availableFormats: vi.fn(() => ['public.file-url', 'public.png']),
      hasImage: vi.fn(() => true),
      getImageBinary,
    });

    const media = await readClipboardMedia({
      platform: 'darwin',
      clipboard: clip,
      runCommand: noMacOsPaths,
    });

    expect(media).toBeNull();
    expect(getImageBinary).not.toHaveBeenCalled();
  });

  it('rejects pasted videos larger than 100 MB', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-code-clip-'));
    try {
      const videoPath = resolve(dir, 'too-big.mp4');
      writeFileSync(videoPath, new Uint8Array([0]));
      truncateSync(videoPath, 101 * 1024 * 1024);
      const clip = fakeClipboard({
        availableFormats: vi.fn(() => ['public.file-url']),
        hasText: vi.fn(() => true),
        getText: vi.fn(async () => pathToFileURL(videoPath).toString()),
      });

      await expect(
        readClipboardMedia({
          platform: 'darwin',
          clipboard: clip,
          runCommand: noMacOsPaths,
        }),
      ).rejects.toThrow(ClipboardMediaError);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('rejects oversized or non-image copied file paths via magic-header sniff without loading them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-code-clip-nonimg-'));
    try {
      const hugeNonImage = resolve(dir, 'disk.iso');
      writeFileSync(hugeNonImage, Buffer.from('NOT_AN_IMAGE_HEADER'));
      truncateSync(hugeNonImage, 150 * 1024 * 1024);

      const smallNonImage = resolve(dir, 'notes.bin');
      writeFileSync(smallNonImage, Buffer.from('plain binary payload'));

      const clip = fakeClipboard({
        availableFormats: vi.fn(() => ['public.file-url']),
        hasText: vi.fn(() => true),
        getText: vi.fn(async () => `${pathToFileURL(hugeNonImage).toString()}\n${pathToFileURL(smallNonImage).toString()}`),
      });

      const media = await readClipboardMedia({
        platform: 'darwin',
        clipboard: clip,
        runCommand: noMacOsPaths,
      });
      expect(media).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('uses the async runCommand runner for Linux Wayland clipboard probes', async () => {
    const imageBytes = Buffer.from(png(8, 8));
    const runCommand = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'wl-paste' && args.includes('--list-types')) {
        return { stdout: Buffer.from('image/png\n'), ok: true };
      }
      if (cmd === 'wl-paste' && args.includes('image/png')) {
        return { stdout: imageBytes, ok: true };
      }
      return { stdout: Buffer.alloc(0), ok: false };
    });

    const media = await readClipboardMedia({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      clipboard: null,
      runCommand,
    });

    expect(media).toEqual({
      kind: 'image',
      bytes: imageBytes,
      mimeType: 'image/png',
    });
    expect(runCommand).toHaveBeenCalledWith('wl-paste', ['--list-types'], expect.any(Object));
  });
});
