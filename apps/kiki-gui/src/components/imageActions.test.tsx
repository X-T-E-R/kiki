// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { I18nKey } from '@kiki/session-core/i18n';
import { HostProvider, browserHost } from '../host';
import { I18nProvider } from '../i18n';
import { MediaLightbox, mediaSourceLabel } from './MediaLightbox';
import { copyImageBitmap, hostActionPath, imageMenuEntries, isRemoteConnection, localImagePath, resolveImageMime, saveMediaToDisk, sniffImageMime, type MediaDownloadClient } from './imageActions';
import type { MiniMenuEntry as MenuEntry } from './MiniContextMenu';

function keys(entries: readonly MenuEntry[]): string[] {
  return entries.map((entry) => ('separator' in entry ? '|' : entry.key));
}

const label = (key: I18nKey) => key;

describe('image action targets', () => {
  it('identifies remote connections accurately across SSH, direct peer, and remote space', () => {
    expect(isRemoteConnection(undefined)).toBe(false);
    expect(isRemoteConnection({ scopeId: 'local', spaceKey: 'main' })).toBe(false);
    expect(isRemoteConnection({ scopeId: 'ssh:prod', spaceKey: 'ssh:prod' })).toBe(true);
    expect(isRemoteConnection({ scopeId: 'direct:peer', spaceKey: 'peer:node' })).toBe(true);
    expect(isRemoteConnection({ scopeId: 'remote:c1', connectionSource: 'remote' })).toBe(true);
    expect(isRemoteConnection({ spaceKey: 'remote:uuid' })).toBe(true);
  });

  it('offers host actions independently according to host capabilities', () => {
    const revealPath = vi.fn(async () => {});
    const openPath = vi.fn(async () => {});
    const revealOnly = imageMenuEntries({
      t: label, src: 'blob:shot', path: 'C:/shot.png', remote: false, revealPath,
      canCopyImage: true, canSave: true, annotated: false, onCopyImage: async () => {}, onSave() {},
    });
    expect(keys(revealOnly)).toEqual(['copy-image', 'copy-path', '|', 'show-in-folder', '|', 'save-image']);

    const openOnly = imageMenuEntries({
      t: label, src: 'blob:shot', path: 'C:/shot.png', remote: false, openPath,
      canCopyImage: true, canSave: true, annotated: false, onCopyImage: async () => {}, onSave() {},
    });
    expect(keys(openOnly)).toEqual(['copy-image', 'copy-path', '|', 'open-default-app', '|', 'save-image']);
  });

  it('keeps url links, real paths, and drive-letter normalization apart', () => {
    expect(localImagePath('https://example.test/a.png')).toBeUndefined();
    expect(localImagePath('blob:https://example.test/uuid')).toBeUndefined();
    expect(localImagePath('kimi-file://file-1')).toBeUndefined();
    expect(localImagePath('blobref:main:abc')).toBeUndefined();
    expect(localImagePath('C:/fixture/image-actions/shot.png')).toBe('C:/fixture/image-actions/shot.png');
    expect(hostActionPath('/C:/fixture/image-actions/shot.png')).toBe('C:/fixture/image-actions/shot.png');
    expect(hostActionPath('/srv/images/shot.png')).toBe('/srv/images/shot.png');
  });

  it('offers bitmap, link, and save for a url, and does not invent a path', () => {
    const entries = imageMenuEntries({
      t: label, src: 'https://example.test/shot.png', link: 'https://example.test/shot.png', remote: false,
      canCopyImage: true, canSave: true, annotated: false, onCopyImage: async () => {}, onSave() {},
    });
    expect(keys(entries)).toEqual(['copy-image', 'copy-link', '|', 'save-image']);
  });

  it('offers the local file actions only when the host can reveal that path', () => {
    const revealPath = vi.fn(async () => {});
    const openPath = vi.fn(async () => {});
    const local = imageMenuEntries({
      t: label, src: 'blob:shot', path: '/C:/fixture/image-actions/shot.png', remote: false, revealPath, openPath,
      canCopyImage: true, canSave: true, annotated: true, onCopyImage: async () => {}, onSave() {}, onSaveAnnotated() {},
    });
    expect(keys(local)).toEqual(['copy-image', 'copy-path', '|', 'show-in-folder', 'open-default-app', '|', 'save-image', 'save-annotated-image']);
    const remote = imageMenuEntries({
      t: label, src: 'blob:shot', path: '/srv/images/shot.png', remote: true, revealPath, openPath,
      canCopyImage: true, canSave: true, annotated: false, onCopyImage: async () => {}, onSave() {},
    });
    expect(keys(remote)).toEqual(['copy-image', 'copy-path', '|', 'save-image']);
    const canonical = imageMenuEntries({
      t: label, src: 'blob:canonical', remote: false, revealPath, openPath,
      canCopyImage: true, canSave: true, annotated: false, onCopyImage: async () => {}, onSave() {},
    });
    expect(keys(canonical)).toEqual(['copy-image', '|', 'save-image']);
  });
});

describe('saveMediaToDisk', () => {
  const sinkWrites: number[][] = [];
  beforeEach(() => { sinkWrites.length = 0; });
  function fakeSink() {
    return {
      streaming: true,
      async write(chunk: Uint8Array) { sinkWrites.push([...chunk]); },
      async close() { return true; },
      async abort() {},
    };
  }
  function clientWith(chunks: readonly number[][]): MediaDownloadClient {
    return {
      readingOptions: () => ({ timeoutMs: 0 }),
      async downloadSessionMedia(_s, _f, sink) { for (const c of chunks) await sink(new Uint8Array(c), { bytes: 0 }); },
      async downloadHostFile(_p, sink) { for (const c of chunks) await sink(new Uint8Array(c), { bytes: 0 }); },
    };
  }

  it('streams a session-media id into the host save sink', async () => {
    const openSaveSink = vi.fn(async () => fakeSink());
    await saveMediaToDisk({ fileId: 'file-1' }, 'shot.png', { openSaveSink }, clientWith([[1, 2], [3]]), 'session-1');
    expect(openSaveSink).toHaveBeenCalledWith('shot.png');
    expect(sinkWrites).toEqual([[1, 2], [3]]);
  });

  it('streams a host path into the host save sink', async () => {
    const host = { openSaveSink: vi.fn(async () => fakeSink()) };
    await saveMediaToDisk({ path: 'C:/shot.png' }, 'shot.png', host, clientWith([[9]]), 'session-1');
    expect(host.openSaveSink).toHaveBeenCalledWith('shot.png');
    expect(sinkWrites).toEqual([[9]]);
  });

  it('saves a ready url through the desktop saveBlob when present', async () => {
    const saveBlob = vi.fn(async () => true);
    const bytes = bytesOfPng();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob([bytes as BlobPart], { type: 'image/png' }) })));
    const saved = await saveMediaToDisk({ url: 'data:image/png;base64,x' }, 'shot.png', { saveBlob }, undefined, 'session-1');
    expect(saved).toBe(true);
    expect(saveBlob).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('returns false when the user cancels the save picker', async () => {
    const openSaveSink = vi.fn(async () => null);
    const saved = await saveMediaToDisk({ fileId: 'file-1' }, 'shot.png', { openSaveSink }, clientWith([[1]]), 'session-1');
    expect(saved).toBe(false);
    expect(sinkWrites).toEqual([]);
  });

  it('throws when the reference has no readable source', async () => {
    await expect(saveMediaToDisk({}, 'shot.png', {}, undefined, 'session-1')).rejects.toThrow('no readable source');
  });
});

describe('copyImageBitmap', () => {
  const write = vi.fn();
  const writeText = vi.fn();

  beforeEach(() => {
    write.mockReset();
    writeText.mockReset();
    write.mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', class ClipboardItem { constructor(readonly items: Record<string, Blob>) {} });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write, writeText } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('writes the png bytes as a clipboard image and not as a url', async () => {
    const bytes = bytesOfPng();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob([bytes as BlobPart], { type: 'image/png' }) })));
    await copyImageBitmap('blob:shot');
    expect(write).toHaveBeenCalledOnce();
    const item = write.mock.calls[0]?.[0]?.[0] as { items: Record<string, Blob> };
    expect(item.items['image/png']?.type).toBe('image/png');
    expect(item.items['image/png']?.size).toBe(bytes.byteLength);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('rasterizes a non-png bitmap and writes real converted png to clipboard', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob([bytesOfJpeg() as BlobPart], { type: 'image/jpeg' }) })));
    vi.stubGlobal('Image', class { crossOrigin: string | null = null; src = ''; naturalWidth = 4; naturalHeight = 2; decode() { return Promise.resolve(); } });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} } as unknown as CanvasRenderingContext2D);
    const convertedPng = bytesOfPng();
    HTMLCanvasElement.prototype.toBlob = (callback) => { callback(new Blob([convertedPng as BlobPart], { type: 'image/png' })); };
    await copyImageBitmap('https://example.test/shot.jpg');
    const item = write.mock.calls[0]?.[0]?.[0] as { items: Record<string, Blob> };
    expect(item.items['image/png']?.type).toBe('image/png');
    expect(item.items['image/png']?.size).toBe(convertedPng.byteLength);
    expect(writeText).not.toHaveBeenCalled();

    write.mockRejectedValueOnce(new Error('denied'));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob([bytesOfPng() as BlobPart], { type: 'image/png' }) })));
    await expect(copyImageBitmap('https://example.test/shot.png')).rejects.toThrow('denied');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('rasterizes when blob has image/png MIME but invalid PNG magic signature', async () => {
    // Blob falsely claims image/png, but contains JPEG bytes -> must be rasterized to real PNG
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob([bytesOfJpeg() as BlobPart], { type: 'image/png' }) })));
    vi.stubGlobal('Image', class { crossOrigin: string | null = null; src = ''; naturalWidth = 4; naturalHeight = 2; decode() { return Promise.resolve(); } });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} } as unknown as CanvasRenderingContext2D);
    const convertedPng = bytesOfPng();
    HTMLCanvasElement.prototype.toBlob = (callback) => { callback(new Blob([convertedPng as BlobPart], { type: 'image/png' })); };
    await copyImageBitmap('blob:corrupt-mime');
    const item = write.mock.calls[0]?.[0]?.[0] as { items: Record<string, Blob> };
    expect(item.items['image/png']?.type).toBe('image/png');
    expect(item.items['image/png']?.size).toBe(convertedPng.byteLength);
  });
});

function bytesOfPng(): Uint8Array {
  const buffer = new ArrayBuffer(11);
  const view = new Uint8Array(buffer);
  view.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3]);
  return view;
}

function bytesOfJpeg(): Uint8Array {
  const buffer = new ArrayBuffer(8);
  const view = new Uint8Array(buffer);
  view.set([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46]);
  return view;
}

function bytesOfWebp(): Uint8Array {
  const buffer = new ArrayBuffer(16);
  const view = new Uint8Array(buffer);
  view.set([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0]);
  view.set([0x57, 0x45, 0x42, 0x50], 8);
  return view;
}

describe('image type resolution', () => {
  it('names the type the bytes are, not the label the store gave them', () => {
    expect(sniffImageMime(bytesOfPng())).toBe('image/png');
    expect(sniffImageMime(bytesOfJpeg())).toBe('image/jpeg');
    expect(sniffImageMime(bytesOfWebp())).toBe('image/webp');
    expect(sniffImageMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml');
    expect(sniffImageMime(new TextEncoder().encode('not an image at all'))).toBeUndefined();

    expect(resolveImageMime(bytesOfPng(), 'application/octet-stream')).toBe('image/png');
    expect(resolveImageMime(bytesOfJpeg(), 'image/png')).toBe('image/jpeg');
    expect(resolveImageMime(new TextEncoder().encode('plain'), 'image/avif')).toBe('image/avif');
    expect(resolveImageMime(new TextEncoder().encode('plain'), 'image/*')).toBeUndefined();
    expect(resolveImageMime(new TextEncoder().encode('plain'), 'text/plain')).toBeUndefined();
  });
});

describe('copyImageBitmap through a generic media type', () => {
  const write = vi.fn();
  const writeText = vi.fn();

  beforeEach(() => {
    write.mockReset();
    writeText.mockReset();
    write.mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', class ClipboardItem { constructor(readonly items: Record<string, Blob>) {} });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write, writeText } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('retypes a stored png the media route labelled application/octet-stream and copies its own bytes', async () => {
    const bytes = bytesOfPng();
    const stored = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => stored })));
    const raster = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
    await copyImageBitmap('blob:stored');
    expect(write).toHaveBeenCalledOnce();
    const item = write.mock.calls[0]?.[0]?.[0] as { items: Record<string, Blob> };
    expect(item.items['image/png']?.type).toBe('image/png');
    expect(item.items['image/png']?.size).toBe(bytes.byteLength);
    expect(raster).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('still writes a bitmap when the stored bytes only look like an image by signature', async () => {
    const bytes = bytesOfJpeg();
    const stored = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => stored })));
    vi.stubGlobal('Image', class { crossOrigin: string | null = null; src = ''; naturalWidth = 4; naturalHeight = 2; decode() { return Promise.resolve(); } });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} } as unknown as CanvasRenderingContext2D);
    const converted = bytesOfPng();
    HTMLCanvasElement.prototype.toBlob = (callback) => { callback(new Blob([converted as BlobPart], { type: 'image/png' })); };
    await copyImageBitmap('blob:stored-jpeg');
    const item = write.mock.calls[0]?.[0]?.[0] as { items: Record<string, Blob> };
    expect(item.items['image/png']?.type).toBe('image/png');
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('media source labels', () => {
  it('strips query credentials from an address and keeps real paths intact', () => {
    expect(mediaSourceLabel('https://example.test/a/shot.png?token=secret&x=1#frag')).toBe('https://example.test/a/shot.png?…');
    expect(mediaSourceLabel('https://user:pass@example.test/shot.png')).toBe('https://…@example.test/shot.png');
    expect(mediaSourceLabel('C:/fixture/image-actions/shot.png')).toBe('C:/fixture/image-actions/shot.png');
    expect(mediaSourceLabel('kimi-file://browser-1')).toBeUndefined();
    expect(mediaSourceLabel('   ')).toBeUndefined();
  });
});

describe('lightbox image menu', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    document.body.querySelectorAll('[data-lightbox-image-menu]').forEach((node) => { node.remove(); });
    vi.restoreAllMocks();
  });

  it('copies and reveals a local path from the image menu and hides those actions for ssh', async () => {
    const revealPath = vi.fn(async () => {});
    const openPath = vi.fn(async () => {});
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const host = { ...browserHost, revealPath, openPath };
    const openMenu = (remote: boolean, sourcePath?: string, src = 'blob:shot') => {
      act(() => {
        root.render(<I18nProvider><HostProvider host={host}><MediaLightbox src={src} name="shot.png" sourcePath={sourcePath} remote={remote} onClose={() => {}} /></HostProvider></I18nProvider>);
      });
      act(() => { document.querySelector('[data-lightbox-viewport]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 8, clientY: 8 })); });
    };
    openMenu(false, '/C:/fixture/image-actions/shot.png');
    expect([...document.querySelectorAll('[role="dialog"] button')].some((button) => button.textContent === 'Download')).toBe(false);
    expect(document.querySelector('[data-menu-item="copy-image"]')?.textContent).toBe('Copy image');
    expect(document.querySelector('[data-menu-item="copy-path"]')?.textContent).toBe('Copy path');
    expect(document.querySelector('[data-menu-item="show-in-folder"]')?.textContent).toBe('Show in folder');
    expect(document.querySelector('[data-menu-item="open-default-app"]')?.textContent).toBe('Open with default app');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-menu-item="copy-path"]')!.click(); });
    expect(writeText).toHaveBeenCalledWith('/C:/fixture/image-actions/shot.png');
    act(() => { document.querySelector('[data-lightbox-viewport]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-menu-item="show-in-folder"]')!.click(); });
    expect(revealPath).toHaveBeenCalledWith('C:/fixture/image-actions/shot.png');
    act(() => { document.querySelector('[data-lightbox-viewport]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-menu-item="open-default-app"]')!.click(); });
    expect(openPath).toHaveBeenCalledWith('C:/fixture/image-actions/shot.png');

    openMenu(true, '/srv/images/shot.png');
    expect(document.querySelector('[data-menu-item="copy-path"]')).not.toBeNull();
    expect(document.querySelector('[data-menu-item="show-in-folder"]')).toBeNull();
    expect(document.querySelector('[data-menu-item="open-default-app"]')).toBeNull();

    openMenu(false, undefined, 'https://example.test/shot.png');
    expect(document.querySelector('[data-menu-item="copy-path"]')).toBeNull();
    expect(document.querySelector('[data-menu-item="show-in-folder"]')).toBeNull();
    expect(document.querySelector('[data-menu-item="copy-link"]')?.textContent).toBe('Copy link');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-menu-item="copy-link"]')!.click(); });
    expect(writeText).toHaveBeenCalledWith('https://example.test/shot.png');
  });
});
