// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { ApiError } from '@kiki/session-core/transport';
import { resetMediaOutcomes } from './imageActions';
import { MediaPartList, MediaPreviewProvider } from './mediaPreview';
import { configureMediaFetchConfig, useSessionMedia } from './mediaParts';
import { LazyMediaLightbox } from './preview/PreviewLoadBoundary';
import { MediaGalleryOrder } from './mediaPreviewContext';
import { configureMediaTransportLimits, KikiClient } from '../lib/client';
import { LiveControllerRegistry, VIEW_CACHE_MAX_PARKED } from '../state/connection';
import type { SessionController } from '@kiki/session-core/session';
import type { MediaRef } from '@kiki/session-core/composer/media';

const fixture = vi.hoisted(() => {
  const preview = vi.fn();
  const original = vi.fn();
  const hostPreview = vi.fn();
  const hostOriginal = vi.fn();
  return {
    preview,
    original,
    hostPreview,
    hostOriginal,
    connectionOverrides: {} as Record<string, unknown>,
    client: {
      readingOptions: () => ({ timeoutMs: 0 }),
      readSessionMediaPreviewBytes: preview,
      readSessionMediaBytes: original,
      readHostMediaPreviewBytes: hostPreview,
      readHostFileBytes: hostOriginal,
    },
  };
});

vi.mock('../state/connection', async (importOriginal) => {
  const originalModule = await importOriginal<typeof import('../state/connection')>();
  return {
    ...originalModule,
    useOptionalConnection: () => ({ client: fixture.client, scopeId: 'local', ...fixture.connectionOverrides }),
  };
});

let root: Root;
let container: HTMLDivElement;
let blobs = 0;
let brokenPreviews = 0;

beforeEach(async () => {
  resetMediaOutcomes();
  await LazyMediaLightbox.preload();
  blobs = 0;
  brokenPreviews = 0;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('IntersectionObserver', undefined);
  URL.createObjectURL = vi.fn(() => `blob:thumb-${blobs += 1}`);
  URL.revokeObjectURL = vi.fn();
  fixture.preview.mockImplementation(async (_session: string, fileId: string) => {
    if (fileId === 'broken') {
      brokenPreviews += 1;
      if (brokenPreviews === 1) throw new Error('preview down');
    }
    return { bytes: Uint8Array.from([1, 2, 3]), mime: 'image/png', name: `${fileId}.png` };
  });
  fixture.original.mockImplementation(async (_session: string, fileId: string) => ({ bytes: Uint8Array.from([4, 5, 6]), mime: 'image/png', name: `${fileId}.png` }));
  fixture.hostPreview.mockRejectedValue(new Error('host preview'));
  fixture.hostOriginal.mockRejectedValue(new Error('host original'));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  document.body.querySelectorAll('[role="dialog"]').forEach((node) => { node.remove(); });
  fixture.connectionOverrides = {};
  configureMediaFetchConfig(null);
  configureMediaTransportLimits(null);
  resetMediaOutcomes();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function previewIds(): string[] {
  return fixture.preview.mock.calls.map((call) => String(call[1]));
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('thumbnail recovery', () => {
  it.each([
    new Error('preview exceeds its byte budget'),
    new ApiError({ code: 413, msg: 'Payload too large', data: null }),
    new ApiError({ code: -3, msg: 'preview_budget_exceeded', data: null }),
    new ApiError({ code: 40001, msg: 'preview unsupported', data: null }),
  ])('loads original image bytes when the preview is unavailable: %s', async (error) => {
    fixture.preview.mockRejectedValue(error);
    fixture.hostPreview.mockRejectedValue(error);
    fixture.hostOriginal.mockResolvedValue({ bytes: Uint8Array.from([1, 2, 3]), mime: 'image/png' });
    await act(async () => {
      root.render(<I18nProvider><MediaPreviewProvider sessionId="session">
        <MediaPartList media={[
          { kind: 'image', fileId: 'large', path: 'E:/images/large.png', name: 'large.png' },
          { kind: 'image', path: 'E:/images/host.png', name: 'host.png' },
        ]} />
      </MediaPreviewProvider></I18nProvider>);
    });
    await flush();
    expect(container.querySelectorAll('img')).toHaveLength(2);
    expect(container.querySelector('[data-media-broken]')).toBeNull();
    expect(fixture.original).toHaveBeenCalledWith('session', 'large', expect.anything());
    expect(fixture.hostOriginal).toHaveBeenCalledExactlyOnceWith('E:/images/host.png', expect.anything());
  });

  it('retries only the file thumbnail after that image becomes ready in the viewer', async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <MediaPreviewProvider sessionId="session">
            <MediaGalleryOrder agentId="other" order={0} blockId="foreign">
              <MediaPartList media={[{ kind: 'image', fileId: 'foreign', name: 'foreign.png', mime: 'image/png' }]} />
            </MediaGalleryOrder>
            <MediaGalleryOrder agentId="main" order={0} blockId="main">
              <MediaPartList media={[
                { kind: 'image', fileId: 'broken', name: 'broken.png', mime: 'image/png' },
                { kind: 'image', fileId: 'kept', name: 'kept.png', mime: 'image/png' },
              ]} />
            </MediaGalleryOrder>
          </MediaPreviewProvider>
        </I18nProvider>,
      );
    });
    await flush();
    const kept = container.querySelector('img[alt="kept.png"]');
    expect(kept).not.toBeNull();
    expect(container.querySelector('[data-media-broken="read"]')?.getAttribute('title')).toBe('broken.png');
    expect(previewIds().filter((id) => id === 'broken')).toEqual(['broken']);
    expect(previewIds().filter((id) => id === 'kept')).toEqual(['kept']);
    expect(previewIds().filter((id) => id === 'foreign')).toEqual(['foreign']);

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-media-broken="read"]')!.click(); });
    await flush();
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((node) => node.querySelector('[data-lightbox-viewport]') !== null);
    expect(dialog?.textContent).toContain('1 / 2');
    expect(dialog?.textContent).not.toContain('foreign.png');
    const dialogImage = dialog?.querySelector('img');
    expect(dialogImage).not.toBeNull();
    await act(async () => { dialogImage!.dispatchEvent(new Event('load')); });
    await flush();

    expect(previewIds().filter((id) => id === 'broken')).toEqual(['broken', 'broken']);
    expect(previewIds().filter((id) => id === 'kept')).toEqual(['kept']);
    expect(previewIds().filter((id) => id === 'foreign')).toEqual(['foreign']);
    expect(fixture.original.mock.calls.map((call) => call[1])).toEqual(['broken']);
    expect(fixture.hostPreview).not.toHaveBeenCalled();
    expect(fixture.hostOriginal).not.toHaveBeenCalled();
    expect(container.querySelector('[data-media-broken]')).toBeNull();
    expect(container.querySelector('img[alt="broken.png"]')).not.toBeNull();
    expect(container.querySelector('img[alt="kept.png"]')).toBe(kept);
  });

  it('retries transient 503 SESSION_BUSY preview failures automatically with backoff', async () => {
    vi.useFakeTimers();
    let calls = 0;
    fixture.preview.mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw new ApiError({ code: 40901, msg: 'SESSION_BUSY', data: null });
      return { bytes: Uint8Array.from([1, 2, 3]), mime: 'image/png', name: 'busy.png' };
    });
    try {
      await act(async () => {
        root.render(
          <I18nProvider>
            <MediaPreviewProvider sessionId="session">
              <MediaPartList media={[{ kind: 'image', fileId: 'busy', name: 'busy.png', mime: 'image/png' }]} />
            </MediaPreviewProvider>
          </I18nProvider>,
        );
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(calls).toBe(2);
      expect(container.querySelector('[data-media-broken]')).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(750); });
      expect(calls).toBe(3);
      expect(container.querySelector('img[alt="busy.png"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders a playable video placeholder instead of a broken icon when video poster returns 415', async () => {
    fixture.preview.mockRejectedValue(new ApiError({ code: 40001, msg: 'HTTP 415 unsupported video poster', data: null }));
    await act(async () => {
      root.render(
        <I18nProvider>
          <MediaPreviewProvider sessionId="session">
            <MediaPartList media={[{ kind: 'video', fileId: 'clip', name: 'clip.mp4', mime: 'video/mp4' }]} />
          </MediaPreviewProvider>
        </I18nProvider>,
      );
    });
    await flush();
    expect(container.querySelector('[data-media-broken]')).toBeNull();
    const placeholder = container.querySelector<HTMLButtonElement>('[data-media-video-placeholder]');
    expect(placeholder).not.toBeNull();
    expect(placeholder?.textContent).toContain('clip.mp4');
  });

  it('bounds concurrent preview fetches via LIFO scheduler and cancels unmounted queued items with 0 network calls', async () => {
    let active = 0;
    let peakActive = 0;
    const startedIds: string[] = [];
    const resolvers = new Map<string, () => void>();
    fixture.preview.mockImplementation((_session: string, fileId: string, opts?: { signal?: AbortSignal }) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      startedIds.push(fileId);
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          active -= 1;
          reject(new DOMException('aborted', 'AbortError'));
        };
        opts?.signal?.addEventListener('abort', onAbort, { once: true });
        resolvers.set(fileId, () => {
          opts?.signal?.removeEventListener('abort', onAbort);
          active -= 1;
          resolve({ bytes: Uint8Array.from([1, 2, 3]), mime: 'image/png', name: `${fileId}.png` });
        });
      });
    });

    const items: MediaRef[] = Array.from({ length: 12 }, (_, idx) => ({
      kind: 'image',
      fileId: `img-${idx}`,
      name: `img-${idx}.png`,
      mime: 'image/png',
    }));

    await act(async () => {
      root.render(
        <I18nProvider>
          <MediaPreviewProvider sessionId="session-lifo">
            <MediaPartList media={items} />
          </MediaPreviewProvider>
        </I18nProvider>,
      );
    });

    expect(peakActive).toBe(4);
    expect(startedIds).toEqual(['img-0', 'img-1', 'img-2', 'img-3']);

    // Unmount queued middle items (img-4..img-9) while initial 4 are still in flight:
    // those queued items must dequeue immediately with 0 network requests!
    await act(async () => {
      root.render(
        <I18nProvider>
          <MediaPreviewProvider sessionId="session-lifo">
            <MediaPartList media={[items[0]!, items[1]!, items[2]!, items[3]!, items[10]!, items[11]!]} />
          </MediaPreviewProvider>
        </I18nProvider>,
      );
    });

    // Resolve img-0 -> LIFO must start newest remaining queued item (img-11) before img-10!
    await act(async () => {
      resolvers.get('img-0')?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(startedIds[4]).toBe('img-11');

    // Resolve img-1 -> starts img-10
    await act(async () => {
      resolvers.get('img-1')?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(startedIds[5]).toBe('img-10');

    // Drain remaining
    await act(async () => {
      for (const id of ['img-2', 'img-3', 'img-11', 'img-10']) resolvers.get(id)?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(peakActive).toBeLessThanOrEqual(4);
    expect(startedIds).toHaveLength(6);
    for (let i = 4; i <= 9; i += 1) {
      expect(startedIds).not.toContain(`img-${i}`);
    }
  });

  it('never auto-downloads raw original images on remote connections or oversized (>4 MiB) items during scroll', async () => {
    fixture.preview.mockRejectedValue(new ApiError({ code: 413, msg: 'preview_budget_exceeded', data: null }));

    // Case 1: oversized (> 4 MiB) local image must not auto-download raw original inline
    await act(async () => {
      root.render(
        <I18nProvider>
          <MediaPreviewProvider sessionId="session-huge">
            <MediaPartList media={[{ kind: 'image', fileId: 'huge-25mb', name: 'huge.png', mime: 'image/png', size: 25 * 1024 * 1024 }]} />
          </MediaPreviewProvider>
        </I18nProvider>,
      );
    });
    await flush();
    expect(fixture.original).not.toHaveBeenCalled();
    expect(container.querySelector('[data-media-broken="read"]')).not.toBeNull();

    // Case 2: remote connection must never auto-download raw original inline
    fixture.connectionOverrides = { connectionSource: 'remote', scopeId: 'remote:space-1', spaceKey: 'remote:space-1' };
    await act(async () => {
      root.render(
        <I18nProvider>
          <MediaPreviewProvider sessionId="session-remote">
            <MediaPartList media={[{ kind: 'image', fileId: 'remote-img', name: 'remote.png', mime: 'image/png' }]} />
          </MediaPreviewProvider>
        </I18nProvider>,
      );
    });
    await flush();
    expect(fixture.original).not.toHaveBeenCalled();
    expect(container.querySelector('[data-media-broken="read"]')).not.toBeNull();
  });

  it('revokes both thumbnailUrl (immediately on ready) and objectUrl with 0 leaked ObjectURLs across 200 cycles', async () => {
    const activeUrls = new Set<string>();
    let seq = 0;
    URL.createObjectURL = vi.fn(() => {
      const url = `blob:soak-${++seq}`;
      activeUrls.add(url);
      return url;
    });
    URL.revokeObjectURL = vi.fn((url: string) => {
      expect(activeUrls.has(url)).toBe(true);
      activeUrls.delete(url);
    });

    let resolveOriginal!: (value: { bytes: Uint8Array; mime: string; name: string }) => void;
    fixture.original.mockImplementation(() => new Promise((resolve) => { resolveOriginal = resolve; }));

    function Harness({ item, previewOnly }: { item: MediaRef; previewOnly: boolean }) {
      const load = useSessionMedia(item, 'soak-session', true, previewOnly, 0);
      return <span data-status={load.status} data-url={load.status === 'ready' ? load.url : ''} data-thumb={'thumbnailUrl' in load ? load.thumbnailUrl ?? '' : ''} />;
    }

    for (let i = 0; i < 200; i += 1) {
      const item: MediaRef = { kind: 'image', fileId: `soak-${i}`, name: `soak-${i}.png`, mime: 'image/png' };
      // Step 1: mount preview thumbnail so provider cache holds the preview bytes
      await act(async () => {
        root.render(
          <I18nProvider>
            <MediaPreviewProvider sessionId="soak-session">
              <Harness item={item} previewOnly={true} />
            </MediaPreviewProvider>
          </I18nProvider>,
        );
      });
      await flush();

      // Step 2: switch to full-res (Lightbox) -> creates thumbnailUrl while loading full original
      await act(async () => {
        root.render(
          <I18nProvider>
            <MediaPreviewProvider sessionId="soak-session">
              <Harness item={item} previewOnly={false} />
            </MediaPreviewProvider>
          </I18nProvider>,
        );
      });
      const thumbUrl = container.querySelector('span')?.getAttribute('data-thumb');
      expect(thumbUrl).toMatch(/^blob:soak-/);
      expect(activeUrls.size).toBe(1);

      // Step 3: resolve full original -> thumbnailUrl MUST be revoked immediately upon transition to ready!
      await act(async () => {
        resolveOriginal({ bytes: Uint8Array.from([9, 8, 7, 6]), mime: 'image/png', name: `soak-${i}.png` });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(activeUrls.has(thumbUrl!)).toBe(false);
      expect(activeUrls.size).toBe(1);

      // Step 4: unmount -> remaining objectUrl is revoked
      await act(async () => {
        root.render(null);
      });
      expect(activeUrls.size).toBe(0);
    }
    expect(activeUrls.size).toBe(0);
  });

  it('bounds KikiClient remote media fetches (<=3) and uploadFile concurrency (<=2) and clears caches on dispose', async () => {
    let activeMedia = 0;
    let peakMedia = 0;
    let activeUploads = 0;
    let peakUploads = 0;
    const mediaResolvers: Array<() => void> = [];
    const uploadResolvers: Array<() => void> = [];
    vi.stubGlobal('fetch', vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/files') || url.includes('/klient/call') || init?.method === 'POST') {
        activeUploads += 1;
        peakUploads = Math.max(peakUploads, activeUploads);
        return new Promise<Response>((resolve) => {
          uploadResolvers.push(() => {
            activeUploads -= 1;
            resolve(new Response(JSON.stringify({
              code: 0,
              msg: 'success',
              data: { id: 'f_1', name: 'big.bin', media_type: 'application/octet-stream', size: 4, created_at: '2026-01-01T00:00:00Z' },
            }), { status: 200, headers: { 'content-type': 'application/json' } }));
          });
        });
      }
      activeMedia += 1;
      peakMedia = Math.max(peakMedia, activeMedia);
      return new Promise<Response>((resolve) => {
        mediaResolvers.push(() => {
          activeMedia -= 1;
          resolve(new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'image/jpeg', etag: '"e1"' },
          }));
        });
      });
    }));

    const remoteClient = new KikiClient({ baseUrl: 'https://remote.example.test', token: 'tok' });
    expect(remoteClient.isRemoteTransport).toBe(true);
    try {
      const previewPromises = Array.from({ length: 8 }, (_, idx) =>
        remoteClient.readSessionMediaPreviewBytes('s1', `f-${idx}`),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(peakMedia).toBe(3);

      const files = Array.from({ length: 5 }, (_, idx) => {
        const file = new File([new Uint8Array([1, 2, 3, 4])], `big-${idx}.bin`);
        Object.defineProperty(file, 'arrayBuffer', {
          value: async () => new Uint8Array([1, 2, 3, 4]).buffer,
        });
        return file;
      });
      const uploadPromises = files.map((file) => remoteClient.uploadFile(file, 's1'));
      await new Promise((r) => setTimeout(r, 15));
      expect(peakUploads).toBeLessThanOrEqual(2);

      while (mediaResolvers.length > 0 || uploadResolvers.length > 0) {
        mediaResolvers.shift()?.();
        uploadResolvers.shift()?.();
        await new Promise((r) => setTimeout(r, 5));
      }
      await Promise.all([...previewPromises, ...uploadPromises]);
      expect(peakMedia).toBe(3);
      expect(peakUploads).toBe(2);
      expect(remoteClient.peekSessionMediaPreviewBytes('s1', 'f-0')).toBeDefined();
    } finally {
      await remoteClient.dispose();
    }
    expect(remoteClient.peekSessionMediaPreviewBytes('s1', 'f-0')).toBeUndefined();
  });

  it('bounds LiveControllerRegistry across 500 session switches and disposes oversized settled views', () => {
    const registry = new LiveControllerRegistry();
    const scope = {};
    let openCount = 0;
    let closeCount = 0;
    const makeController = (sessionId: string, initialBusy: boolean, bytesRef: { value: number }) => {
      let busy = initialBusy;
      let suspended = false;
      const listeners = new Set<() => void>();
      const controller = {
        sessionId,
        get suspended() { return suspended; },
        open: () => { openCount += 1; return Promise.resolve(); },
        resume: () => Promise.resolve(),
        close: () => { closeCount += 1; listeners.clear(); },
        suspend: () => { suspended = true; },
        setFocusedAgent: () => {},
        residentBytes: () => bytesRef.value,
        getState: () => ({
          loaded: true,
          loadError: undefined,
          resyncFailed: false,
          resyncError: undefined,
          busy,
          pendingInteraction: 'none',
          tasks: [],
        }),
        subscribe: (fn: () => void) => {
          listeners.add(fn);
          return () => { listeners.delete(fn); };
        },
        settle: () => {
          busy = false;
          for (const fn of listeners) fn();
        },
      };
      return controller as unknown as SessionController & { settle: () => void };
    };

    // 500 idle session switches must never exceed VIEW_CACHE_MAX_PARKED
    for (let i = 0; i < 500; i += 1) {
      const lease = registry.acquire(`sess-${i}`, scope, () => makeController(`sess-${i}`, false, { value: 1024 * 1024 }));
      lease.release();
      expect(registry.parkedCount).toBeLessThanOrEqual(VIEW_CACHE_MAX_PARKED);
    }

    // A busy session that grows past maxEntryBytes while live-parked must be disposed immediately on settle
    const grownBytes = { value: 512 * 1024 };
    let busyCtrl!: SessionController & { settle: () => void };
    const busyLease = registry.acquire('sess-busy-huge', scope, () => {
      busyCtrl = makeController('sess-busy-huge', true, grownBytes);
      return busyCtrl;
    });
    busyLease.release();
    expect(registry.hasRetained('sess-busy-huge', scope)).toBe(true);
    grownBytes.value = 48 * 1024 * 1024;
    busyCtrl.settle();
    expect(registry.hasRetained('sess-busy-huge', scope)).toBe(false);

    registry.evictScope(scope);
    expect(registry.parkedCount).toBe(0);
    expect(closeCount).toBe(openCount);
  });
});
