// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyTextToClipboard } from './clipboard';

function mockExecCommand(result: boolean) {
  const execCommand = vi.fn(() => result);
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: execCommand,
  });
  return execCommand;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('copyTextToClipboard', () => {
  it('uses the async clipboard API when it succeeds', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const execCommand = mockExecCommand(true);

    await copyTextToClipboard('copied');

    expect(writeText).toHaveBeenCalledWith('copied');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('falls back to execCommand after clipboard denial', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) },
    });
    const execCommand = mockExecCommand(true);

    await copyTextToClipboard('fallback');

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('rejects when execCommand reports failure', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) },
    });
    mockExecCommand(false);

    await expect(copyTextToClipboard('failed')).rejects.toThrow(
      'Clipboard fallback rejected the copy command.',
    );
    expect(document.querySelector('textarea')).toBeNull();
  });
});

const PNG_HEADER = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const JPEG_HEADER = [0xFF, 0xD8, 0xFF, 0xE0];

describe('copyImageToClipboard', () => {
  it('writes valid png blob to clipboard when available', async () => {
    const write = vi.fn(() => Promise.resolve());
    vi.stubGlobal('ClipboardItem', class ClipboardItem {
      constructor(readonly items: Record<string, Blob>) {}
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write },
    });

    const validPng = new Blob([new Uint8Array(PNG_HEADER)], { type: 'image/png' });
    const { copyImageToClipboard } = await import('./clipboard');
    await copyImageToClipboard(validPng);

    expect(write).toHaveBeenCalledOnce();
    const calls = write.mock.calls as unknown[][];
    const itemsArg = calls[0]?.[0] as { items: Record<string, Blob> }[] | undefined;
    const item = itemsArg?.[0];
    expect(item?.items['image/png']?.type).toBe('image/png');
  });

  it('rejects non-PNG bytes even if mislabeled with image/png MIME', async () => {
    const write = vi.fn(() => Promise.resolve());
    vi.stubGlobal('ClipboardItem', class ClipboardItem {
      constructor(readonly items: Record<string, Blob>) {}
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write },
    });

    // A JPEG stream falsely given image/png MIME must be rejected at the clipboard boundary
    const fakePng = new Blob([new Uint8Array(JPEG_HEADER)], { type: 'image/png' });
    const { copyImageToClipboard } = await import('./clipboard');
    await expect(copyImageToClipboard(fakePng)).rejects.toThrow('Clipboard image write requires a valid PNG image');
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects non-PNG MIME types (e.g. image/jpeg)', async () => {
    const write = vi.fn(() => Promise.resolve());
    vi.stubGlobal('ClipboardItem', class ClipboardItem {
      constructor(readonly items: Record<string, Blob>) {}
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write },
    });

    const jpegBlob = new Blob([new Uint8Array(JPEG_HEADER)], { type: 'image/jpeg' });
    const { copyImageToClipboard } = await import('./clipboard');
    await expect(copyImageToClipboard(jpegBlob)).rejects.toThrow('Clipboard image write requires a valid PNG image');
    expect(write).not.toHaveBeenCalled();
  });

  it('throws error when clipboard or ClipboardItem is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    const { copyImageToClipboard } = await import('./clipboard');
    const validPng = new Blob([new Uint8Array(PNG_HEADER)], { type: 'image/png' });
    await expect(copyImageToClipboard(validPng)).rejects.toThrow('Clipboard image write is unavailable');
  });
});
