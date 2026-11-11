// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAndroidBridge, subscribeAndroidHostEvents } from './androidBridge';
import { appShellConnectUrl, isEmbeddedAndroidHost } from './appShell';
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
    const write = vi.fn(async (items: PromisedItem[]) => {
      await Promise.all(items.map((item) => Promise.resolve(item.items['image/png'])));
    });
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

  it('falls back to a resolved Blob when the engine rejects promised ClipboardItem data', async () => {
    const write = imageClipboard();
    vi.stubGlobal('ClipboardItem', class {
      constructor(readonly items: Record<string, Blob | Promise<Blob>>) {
        if (items['image/png'] instanceof Promise) throw new TypeError('Expected Blob');
      }
    });
    const { copyImageToClipboard } = await import('./clipboard');
    const png = new Blob([new Uint8Array(PNG_HEADER)], { type: 'image/png' });
    await copyImageToClipboard(Promise.resolve(png));
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]![0][0]!.items['image/png']).toBe(png);
  });

  it('does not retry a denied write with a resolved Blob', async () => {
    const write = imageClipboard();
    write.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    const { copyImageToClipboard } = await import('./clipboard');
    await expect(copyImageToClipboard(new Blob([new Uint8Array(PNG_HEADER)], { type: 'image/png' }))).rejects.toThrow('denied');
    expect(write).toHaveBeenCalledOnce();
  });

  it('reports when clipboard images are unavailable and observes a rejected source', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const { copyImageToClipboard } = await import('./clipboard');
    await expect(copyImageToClipboard(Promise.reject(new Error('source failed')))).rejects.toThrow('Clipboard image write is unavailable');
  });
});

describe('embedded Android host detection and androidBridge', () => {
  afterEach(() => {
    delete (window as unknown as { KikiAndroid?: unknown }).KikiAndroid;
  });

  it('detects KikiEmbedded Android user agents and routes appShellConnectUrl', () => {
    const embeddedUa = 'Mozilla/5.0 (Linux; Android 15) KikiApp/android KikiEmbedded/1';
    const remoteShellUa = 'Mozilla/5.0 (Linux; Android 15) KikiApp/android';
    const browserUa = 'Mozilla/5.0 (Linux; Android 15) Chrome/131.0';

    expect(isEmbeddedAndroidHost(embeddedUa)).toBe(true);
    expect(isEmbeddedAndroidHost(remoteShellUa)).toBe(false);
    expect(isEmbeddedAndroidHost(browserUa)).toBe(false);

    expect(appShellConnectUrl(embeddedUa)).toBe('kiki-shell://connect');
    expect(appShellConnectUrl(remoteShellUa)).toBe('https://localhost/index.html#change');
    expect(appShellConnectUrl(browserUa)).toBeNull();
  });

  it('calls window.KikiAndroid over WebMessage RPC, aligns openNativeSettings, and falls back to clipboard bridge', async () => {
    const listeners = new Set<(event: MessageEvent<unknown>) => void>();
    const sent: Array<{ id: string; method: string; params: Record<string, unknown> }> = [];
    (window as unknown as { KikiAndroid?: unknown }).KikiAndroid = {
      addEventListener: (_type: 'message', fn: (event: MessageEvent<unknown>) => void) => {
        listeners.add(fn);
      },
      postMessage: (raw: string) => {
        const frame = JSON.parse(raw) as { id: string; method: string; params: Record<string, unknown> };
        sent.push(frame);
        queueMicrotask(() => {
          const result = frame.method === 'capabilities'
            ? { permissions: { accessibility: true, overlay: false, notifications: true, battery: true } }
            : frame.method === 'readClipboard'
              ? 'hello-from-android'
              : true;
          const reply = new MessageEvent('message', {
            data: JSON.stringify({ id: frame.id, ok: true, result }),
          });
          for (const listener of listeners) listener(reply);
        });
      },
    };

    const bridge = createAndroidBridge(window);
    const caps = await bridge.capabilities();
    expect(caps?.permissions.accessibility).toBe(true);
    expect(caps?.permissions.overlay).toBe(false);

    expect(await bridge.readClipboard()).toBe('hello-from-android');
    await bridge.openPermission('overlay');
    await bridge.openPhoneSettings();
    await bridge.setAppearance({ dark: false });
    expect(sent.map((item) => item.method)).toEqual([
      'capabilities',
      'readClipboard',
      'openPermission',
      'openNativeSettings',
      'setAppearance',
    ]);
    expect(sent[2]!.params).toEqual({ kind: 'overlay' });
    expect(sent[4]!.params).toEqual({ dark: false });

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) },
    });
    await copyTextToClipboard('via-android-bridge');
    expect(sent.at(-1)).toMatchObject({ method: 'writeClipboard', params: { text: 'via-android-bridge' } });
  });

  it('unwraps AndroidBridgeHandler { type, data } host event envelopes', () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeAndroidHostEvents((detail) => { received.push(detail); }, window);
    window.dispatchEvent(new CustomEvent('kiki:android', {
      detail: {
        type: 'permissions',
        data: {
          permissions: { accessibility: true, overlay: true, notifications: true, battery: false },
          abi: 'arm64-v8a',
          sdk: 35,
        },
      },
    }));
    window.dispatchEvent(new CustomEvent('kiki:android', {
      detail: {
        type: 'navigate',
        data: { route: '/settings/connection' },
      },
    }));
    window.dispatchEvent(new CustomEvent('kiki:android', {
      detail: {
        type: 'share-intake',
        data: { id: 'intake-42' },
      },
    }));
    unsubscribe();
    expect(received).toEqual([
      {
        type: 'permissions',
        permissions: {
          accessibility: true,
          overlay: true,
          notifications: true,
          battery: false,
          oemAutostart: undefined,
        },
      },
      { type: 'navigate', route: '/settings/connection' },
      { type: 'share-intake', id: 'intake-42' },
    ]);
  });
});
