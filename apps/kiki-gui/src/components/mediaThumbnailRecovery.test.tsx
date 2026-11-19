// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { ApiError } from '@kiki/session-core/transport';
import { resetMediaOutcomes } from './imageActions';
import { MediaPartList, MediaPreviewProvider } from './mediaPreview';
import { LazyMediaLightbox } from './preview/PreviewLoadBoundary';
import { MediaGalleryOrder } from './mediaPreviewContext';

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
    client: {
      readingOptions: () => ({ timeoutMs: 0 }),
      readSessionMediaPreviewBytes: preview,
      readSessionMediaBytes: original,
      readHostMediaPreviewBytes: hostPreview,
      readHostFileBytes: hostOriginal,
    },
  };
});

vi.mock('../state/connection', () => ({
  useOptionalConnection: () => ({ client: fixture.client, scopeId: 'local' }),
}));

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
});
