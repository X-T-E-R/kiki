// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamSave } from '../../../vscode/src/stream-save';
import { I18nProvider } from '../i18n';
import { KikiClient } from '../lib/client';
import { MediaPartList, MediaPreviewProvider } from './mediaPreview';
import { MediaLightbox } from './MediaLightbox';

const fixture = vi.hoisted(() => ({ client: null as unknown, openSaveSink: vi.fn(), saveBlob: undefined as ((blob: Blob, name: string) => Promise<boolean>) | undefined }));
vi.mock('../state/connection', () => ({ useOptionalConnection: () => ({ client: fixture.client, scopeId: 'fixture' }) }));
vi.mock('../host', () => ({ useHost: () => ({ kind: 'vscode', openSaveSink: fixture.openSaveSink, saveBlob: fixture.saveBlob }) }));
vi.mock('./PreviewWorkspace', () => ({ PreviewWorkspace: () => null, PreviewCloseConfirm: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

let server: Server;
let directory: string;
let root: Root;
let container: HTMLDivElement;
let originalRequests: number;
let previewRequests: number;
let boundaryPreviews: boolean;
const block = new Uint8Array(64 * 1024).fill(0x5a);
const item = { kind: 'image', fileId: 'image', mime: 'image/png', name: 'original.png' } as const;
let originalBytes = 300 * 1024 * 1024;
let closed = deferred<void>();

beforeEach(async () => {
  originalRequests = 0;
  previewRequests = 0;
  boundaryPreviews = false;
  closed = deferred<void>();
  directory = await mkdtemp(join(tmpdir(), 'kiki-gui-media-test-'));
  server = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer fixture-token') { response.writeHead(401).end(); return; }
    if (/^\/api\/sessions\/session\/media\/image(?:-\d+)?\/preview(?:\?|$)/.test(request.url ?? '')) {
      previewRequests += 1;
      const bytes = boundaryPreviews ? block.byteLength : 1024;
      const oversized = boundaryPreviews && request.url?.includes('/image-4/preview');
      // Chunked responses force the production reader to count actual bytes.
      response.writeHead(200, { 'content-type': 'image/jpeg' });
      response.write(block.subarray(0, bytes));
      response.end(oversized ? new Uint8Array([0x5a]) : undefined);
      return;
    }
    if (request.url !== '/api/sessions/session/media/image') { response.writeHead(404).end(); return; }
    originalRequests += 1;
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(originalBytes) });
    response.once('close', () => { closed.resolve(); });
    void (async () => {
      for (let bytes = 0; bytes < originalBytes && !response.destroyed; bytes += block.byteLength) {
        if (!response.write(block.subarray(0, Math.min(block.byteLength, originalBytes - bytes)))) {
          await new Promise<void>((resolve) => {
            const finish = () => { response.off('drain', finish); response.off('close', finish); resolve(); };
            response.once('drain', finish);
            response.once('close', finish);
          });
        }
      }
      if (!response.destroyed) response.end();
    })();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  fixture.client = new KikiClient({ baseUrl: `http://127.0.0.1:${port}`, token: 'fixture-token' });
  fixture.openSaveSink.mockReset();
  fixture.saveBlob = undefined;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', undefined);
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function openAttachment() {
  await act(async () => {
    root.render(<MemoryRouter><I18nProvider><MediaPreviewProvider sessionId="session"><MediaPartList media={[item]} /></MediaPreviewProvider></I18nProvider></MemoryRouter>);
  });
  for (let tries = 0; !container.querySelector('img') && tries < 40; tries += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  expect(container.querySelector('img')).not.toBeNull();
  await act(async () => { container.querySelector<HTMLButtonElement>('button')!.click(); });
  await act(async () => {
    document.querySelector('[data-attachment-preview]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
  });
  return document.querySelector<HTMLButtonElement>('[data-attachment-image-menu] [data-menu-item="save-image"]')!;
}

describe('media original GUI stream', () => {
  it('loads only source previews until Download, then saves the exact 300 MiB through the production native sink', async () => {
    originalBytes = 300 * 1024 * 1024;
    const target = join(directory, 'original.png');
    const saved = deferred<void>();
    let sinkBytes = 0;
    fixture.openSaveSink.mockImplementation(async () => {
      const stream = await StreamSave.open(target);
      return {
        streaming: true,
        async write(chunk: Uint8Array) { expect(chunk.byteLength).toBeLessThanOrEqual(64 * 1024); sinkBytes = await stream.write(chunk, sinkBytes); },
        async close() { const result = await stream.close(); saved.resolve(); return result; },
        abort: () => stream.abort(),
      };
    });
    const download = await openAttachment();
    expect(originalRequests).toBe(0);
    expect(previewRequests).toBeLessThanOrEqual(2);
    await act(async () => { download.click(); await saved.promise; });
    expect(originalRequests).toBe(1);
    expect(sinkBytes).toBe(originalBytes);
    expect((await stat(target)).size).toBe(originalBytes);
    const expected = createHash('sha256');
    for (let bytes = 0; bytes < originalBytes; bytes += block.byteLength) expected.update(block);
    const actual = createHash('sha256');
    for await (const chunk of createReadStream(target)) actual.update(chunk);
    expect(actual.digest('hex')).toBe(expected.digest('hex'));
    expect(document.body.textContent).toContain('Saved');
  }, 30_000);

  it('Cancel terminates the HTTP source and aborts only its temporary sink, preserving the chosen existing file', async () => {
    originalBytes = 16 * 1024 * 1024;
    const target = join(directory, 'existing.png');
    await writeFile(target, 'existing user file');
    const first = deferred<void>();
    const resume = deferred<void>();
    const aborted = deferred<void>();
    let writes = 0;
    fixture.openSaveSink.mockImplementation(async () => {
      const stream = await StreamSave.open(target);
      return {
        streaming: true,
        async write(chunk: Uint8Array) { writes += 1; await stream.write(chunk, 0); first.resolve(); await resume.promise; },
        close: () => stream.close(),
        async abort() { await stream.abort(); aborted.resolve(); },
      };
    });
    const download = await openAttachment();
    await act(async () => { download.click(); await first.promise; });
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Cancel');
    expect(cancel).toBeDefined();
    await act(async () => { cancel!.click(); resume.resolve(); await aborted.promise; });
    await closed.promise;
    expect(writes).toBe(1);
    expect(await readFile(target, 'utf8')).toBe('existing user file');
    expect(document.body.textContent).not.toContain('Saved');
  }, 15_000);
});


describe('media preview budget and ownership', () => {
  it('bounds each source preview, keeps a declined preview original reachable, and never auto-fetches originals', async () => {
    boundaryPreviews = true;
    const client = fixture.client as KikiClient;
    const previews = vi.spyOn(client, 'readSessionMediaPreviewBytes');
    const originals = vi.spyOn(client, 'readSessionMediaBytes').mockResolvedValue({ bytes: new Uint8Array([1, 2]), mime: 'image/png' });
    await act(async () => {
      root.render(<MemoryRouter><I18nProvider><MediaPreviewProvider sessionId="session"><MediaPartList media={Array.from({ length: 5 }, (_, index) => ({ ...item, fileId: `image-${index}` }))} /></MediaPreviewProvider></I18nProvider></MemoryRouter>);
    });
    const results = await act(async () => Promise.allSettled(previews.mock.results.map((result) => result.value)));
    expect(previews).toHaveBeenCalledTimes(5);
    expect(previewRequests).toBe(5);
    for (const result of results.slice(0, 4)) {
      expect(result.status).toBe('fulfilled');
      if (result.status === 'fulfilled') expect(result.value.bytes.byteLength).toBe(64 * 1024);
    }
    expect(results[4]).toMatchObject({ status: 'rejected', reason: new Error('Media preview exceeds its byte budget') });
    expect(container.querySelectorAll('img')).toHaveLength(4);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(4);
    expect(originals).not.toHaveBeenCalled();
    expect(originalRequests).toBe(0);
    const unavailable = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.title === 'image-4');
    expect(unavailable).toBeDefined();
    await act(async () => { unavailable!.click(); });
    expect(originals).not.toHaveBeenCalled();
    const full = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Load full file')!;
    expect(full).toBeDefined();
    await act(async () => { full.click(); });
    expect(originals).toHaveBeenCalledExactlyOnceWith('session', 'image-4', expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 0 }));
  });

  it('uses source host path preview and does not read the original path for a thumbnail', async () => {
    const client = fixture.client as KikiClient;
    const preview = vi.spyOn(client, 'readHostMediaPreviewBytes').mockResolvedValue({ bytes: new Uint8Array(1024), mime: 'image/jpeg' });
    const original = vi.spyOn(client, 'readHostFileBytes').mockResolvedValue({ bytes: new Uint8Array(4), mime: 'video/mp4' });
    await act(async () => {
      root.render(<MemoryRouter><I18nProvider><MediaPreviewProvider sessionId="session"><MediaPartList media={[{ kind: 'video', path: '/isolated/clip.mp4' }]} /></MediaPreviewProvider></I18nProvider></MemoryRouter>);
    });
    expect(preview).toHaveBeenCalledWith('/isolated/clip.mp4', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(original).not.toHaveBeenCalled();
    expect(container.querySelector('img')).not.toBeNull();
    expect(container.querySelector('video')).toBeNull();
  });

  it('locks open attachments to their initiating client/session and never sends the old media ID to a switched space', async () => {
    const oldClient = fixture.client as KikiClient;
    vi.spyOn(oldClient, 'readSessionMediaPreviewBytes').mockResolvedValue({ bytes: new Uint8Array(10), mime: 'image/jpeg' });
    const render = () => <MemoryRouter><I18nProvider><MediaPreviewProvider sessionId="session"><MediaPartList media={[item]} /></MediaPreviewProvider></I18nProvider></MemoryRouter>;
    await act(async () => { root.render(render()); });
    await act(async () => { container.querySelector<HTMLButtonElement>('button')!.click(); });
    expect(document.querySelector('[data-attachment-preview]')).not.toBeNull();
    const next = new KikiClient({ baseUrl: 'http://unused.invalid', token: 'fixture-token' });
    const preview = vi.spyOn(next, 'readSessionMediaPreviewBytes').mockResolvedValue({ bytes: new Uint8Array(10), mime: 'image/jpeg' });
    const original = vi.spyOn(next, 'readSessionMediaBytes');
    fixture.client = next;
    await act(async () => { root.render(<MemoryRouter><I18nProvider><MediaPreviewProvider sessionId="other"><MediaPartList media={[]} /></MediaPreviewProvider></I18nProvider></MemoryRouter>); });
    expect(document.querySelector('[data-attachment-preview]')).toBeNull();
    expect(preview).not.toHaveBeenCalled();
    expect(original).not.toHaveBeenCalled();
  });

  it('keeps external URL originals explicit instead of auto-loading them or forwarding a bearer header', async () => {
    await act(async () => {
      root.render(<MemoryRouter><I18nProvider><MediaPreviewProvider sessionId="session"><MediaPartList media={[{ kind: 'image', url: 'https://fixture.invalid/original.png', name: 'external.png' }]} /></MediaPreviewProvider></I18nProvider></MemoryRouter>);
    });
    expect(container.querySelector('img')).toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('button')!.click(); });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://fixture.invalid/original.png');
    expect(container.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(originalRequests).toBe(0);
  });

  it('renders image attachment preview with readable floating header card and accessible controls', async () => {
    const client = fixture.client as KikiClient;
    vi.spyOn(client, 'readSessionMediaPreviewBytes').mockResolvedValue({ bytes: new Uint8Array(1024), mime: 'image/png' });
    vi.spyOn(client, 'readSessionMediaBytes').mockResolvedValue({ bytes: new Uint8Array(1024), mime: 'image/png' });
    await act(async () => {
      root.render(<MemoryRouter><I18nProvider><MediaPreviewProvider sessionId="session"><MediaPartList media={[{ ...item, kind: 'image', mime: 'image/png', name: 'step-after.png' }]} /></MediaPreviewProvider></I18nProvider></MemoryRouter>);
    });
    const trigger = container.querySelector<HTMLButtonElement>('button');
    expect(trigger).not.toBeNull();
    await act(async () => { trigger!.click(); });

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const header = dialog!.querySelector('header');
    expect(header).not.toBeNull();
    expect(header!.className).toContain('bg-panel/90');
    expect(header!.className).toContain('border-hairline');
    expect(header!.className).toContain('backdrop-blur-md');
    expect(header!.textContent).toContain('step-after.png');
    expect(header!.textContent).toContain('image/png');

    const downloadBtn = [...header!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Download');
    expect(downloadBtn).toBeUndefined();
    const surface = dialog!.querySelector<HTMLElement>('[data-attachment-preview]')!;
    await act(async () => { surface.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    expect(document.querySelector('[data-attachment-image-menu] [data-menu-item="save-image"]')).not.toBeNull();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('[data-attachment-image-menu]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    await act(async () => { surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); });
    const save = document.querySelector<HTMLButtonElement>('[data-attachment-image-menu] [data-menu-item="save-image"]')!;
    expect(document.activeElement).toBe(save);
    fixture.openSaveSink.mockResolvedValue(null);
    await act(async () => { save.click(); });
    expect(fixture.openSaveSink).toHaveBeenCalledWith('step-after.png');
    const closeBtn = [...header!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === 'Close');
    expect(closeBtn).toBeDefined();
    expect(closeBtn!.className).toContain('focus-visible:outline-selected-ink');
  });
});

it('saves a lightbox image from the keyboard context menu without a persistent Download button', async () => {
  const close = vi.fn();
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe('example.png');
    expect(this.getAttribute('href')).toBe('blob:original');
  });
  try {
    await act(async () => { root.render(<I18nProvider><MediaLightbox src="blob:original" name="example.png" onClose={close} /></I18nProvider>); });
    expect([...document.querySelectorAll('button')].some((button) => button.textContent === 'Download')).toBe(false);
    const image = document.querySelector('img')!;
    await act(async () => { image.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true })); });
    const save = document.querySelector<HTMLButtonElement>('[data-lightbox-image-menu] [data-menu-item="save-image"]')!;
    expect(document.activeElement).toBe(save);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(close).not.toHaveBeenCalled();
    await act(async () => { image.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-lightbox-image-menu] [data-menu-item="save-image"]')!.click(); });
    expect(click).toHaveBeenCalledOnce();
  } finally { click.mockRestore(); }
});

it.each([true, false])('uses native image saving without a browser download when the save dialog returns %s', async (saved) => {
  const blob = new Blob(['original-image'], { type: 'image/png' });
  const saveBlob = vi.fn(async (_blob: Blob, _name: string) => saved);
  fixture.saveBlob = saveBlob;
  const fetchImage = vi.fn(async () => ({ ok: true, blob: async () => blob }));
  vi.stubGlobal('fetch', fetchImage);
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  try {
    await act(async () => { root.render(<I18nProvider><MediaLightbox src="blob:original" name="example.png" onClose={() => {}} /></I18nProvider>); });
    const image = document.querySelector('img')!;
    await act(async () => { image.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true })); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-lightbox-image-menu] [data-menu-item="save-image"]')!.click(); });
    expect(fetchImage).toHaveBeenCalledWith('blob:original');
    expect(saveBlob).toHaveBeenCalledWith(blob, 'example.png');
    expect(click).not.toHaveBeenCalled();
  } finally { click.mockRestore(); }
});
