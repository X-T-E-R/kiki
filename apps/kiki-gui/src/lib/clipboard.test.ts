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
  type PromisedItem = { items: Record<string, Promise<Blob>> };
  function imageClipboard() {
    vi.stubGlobal('ClipboardItem', class { constructor(readonly items: Record<string, Promise<Blob>>) {} });
    const write = vi.fn(async (items: PromisedItem[]) => { await Promise.all(items.map((item) => item.items['image/png'])); });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } });
    return write;
  }

  afterEach(() => { vi.unstubAllGlobals(); });

  it('starts write synchronously and validates the promised PNG before delivery', async () => {
    const write = imageClipboard();
    const { copyImageToClipboard } = await import('./clipboard');
    let resolve!: (blob: Blob) => void;
    const source = new Promise<Blob>((done) => { resolve = done; });
    const copying = copyImageToClipboard(source);
    expect(write).toHaveBeenCalledOnce();
    const item = write.mock.calls[0]![0][0]!;
    expect(item.items['image/png']).toBeInstanceOf(Promise);
    const validPng = new Blob([new Uint8Array(PNG_HEADER)], { type: 'image/png' });
    resolve(validPng);
    await copying;
    expect(await item.items['image/png']).toBe(validPng);
  });

  it.each([
    [JPEG_HEADER, 'image/png'],
    [JPEG_HEADER, 'image/jpeg'],
  ])('rejects invalid PNG data at the clipboard boundary (%s, %s)', async (bytes, type) => {
    imageClipboard();
    const { copyImageToClipboard } = await import('./clipboard');
    await expect(copyImageToClipboard(new Blob([new Uint8Array(bytes)], { type }))).rejects.toThrow('requires a valid PNG image');
  });

  it('preserves the source error when the browser rejects promised image data', async () => {
    const write = imageClipboard();
    write.mockImplementation(async (items) => {
      try { await items[0]!.items['image/png']; }
      catch { throw new DOMException('Failed to read clipboard data', 'DataError'); }
    });
    const { copyImageToClipboard } = await import('./clipboard');
    await expect(copyImageToClipboard(Promise.reject(new TypeError('Failed to fetch')))).rejects.toThrow('Failed to fetch');
  });

  it('reports clipboard denial even if image preparation is still pending', async () => {
    const write = imageClipboard();
    write.mockRejectedValue(new DOMException('Document is not focused.', 'NotAllowedError'));
    const { copyImageToClipboard } = await import('./clipboard');
    let reject!: (error: Error) => void;
    const source = new Promise<Blob>((_resolve, fail) => { reject = fail; });
    await expect(copyImageToClipboard(source)).rejects.toThrow('Document is not focused.');
    reject(new Error('decode failed later'));
    await Promise.resolve();
  });

  it('reports when clipboard images are unavailable and observes a rejected source', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const { copyImageToClipboard } = await import('./clipboard');
    await expect(copyImageToClipboard(Promise.reject(new Error('source failed')))).rejects.toThrow('Clipboard image write is unavailable');
  });
});
