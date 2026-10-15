// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { I18nKey } from '@kiki/session-core/i18n';
import { HostProvider, browserHost } from '../host';
import { I18nProvider } from '../i18n';
import { MediaLightbox } from './MediaLightbox';
import { copyImageBitmap, hostActionPath, imageMenuEntries, isRemoteConnection, localImagePath } from './imageActions';
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
