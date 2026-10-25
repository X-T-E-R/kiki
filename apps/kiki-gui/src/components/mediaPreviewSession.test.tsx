// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import type { ToolBlock } from '@kiki/session-core/session';
import { ApiError } from '@kiki/session-core/transport';
import { MediaPartList, MediaPreviewProvider } from './mediaPreview';
import { previewThumbnail } from './imageThumbnail';
import { imagePreviewDownloadName, imagePreviewLabel, safeImagePreviewName } from './imagePreviewName';
import { ToolCard } from './ToolCard';
import { TranscriptDetailProvider } from './transcriptDetail';
import type { MediaRef } from '@kiki/session-core/composer/media';
import type { KikiClient } from '../lib/client';
import type { MediaPreviewApi } from './mediaPreviewContext';
import { useSessionMediaPlayback } from './useSessionMediaPlayback';
const mocks = vi.hoisted(() => ({
  readSessionMediaBytes: vi.fn(),
  readHostFileBytes: vi.fn(),
  readSessionMediaPreviewBytes: vi.fn(),
  readHostMediaPreviewBytes: vi.fn(),
  downloadSessionMedia: vi.fn(),
  downloadHostFile: vi.fn(),
  openMediaPlayback: vi.fn(),
  closeMediaPlayback: vi.fn(),
  remote: false,
  activeClient: undefined as unknown,
}));

vi.mock('../state/connection', async (importOriginal) => {
  const original = await importOriginal<typeof import('../state/connection')>();
  const defaultClient = {
    readingOptions: () => ({ timeoutMs: 0 }),
    readSessionMediaBytes: mocks.readSessionMediaBytes,
    readHostFileBytes: mocks.readHostFileBytes,
    readSessionMediaPreviewBytes: mocks.readSessionMediaPreviewBytes,
    readHostMediaPreviewBytes: mocks.readHostMediaPreviewBytes,
    downloadSessionMedia: mocks.downloadSessionMedia,
    downloadHostFile: mocks.downloadHostFile,
    baseUrl: 'http://localhost:8080',
    klient: { rest: { sessions: { openMediaPlayback: mocks.openMediaPlayback, closeMediaPlayback: mocks.closeMediaPlayback } } },
  };
  return {
    ...original,
    useOptionalConnection: () => ({
      client: (mocks.activeClient ?? defaultClient) as typeof defaultClient,
      connectionSource: mocks.remote ? 'remote' : 'local',
    }),
  };
});

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
let originalCreateObjectUrl: typeof URL.createObjectURL | undefined;
let originalRevokeObjectUrl: typeof URL.revokeObjectURL | undefined;

function makeRoot(): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  return { root, container };
}

async function renderSettled(root: Root, node: ReactNode): Promise<void> {
  await act(async () => {
    flushSync(() => {
      root.render(<I18nProvider>{node}</I18nProvider>);
    });
    await Promise.resolve();
  });
}

/** The dialog names its own actions in English, so the text is the anchor. */
function findDialogButton(dialog: Element | null, label: string): HTMLButtonElement | undefined {
  return [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find((button) => button.textContent === label);
}

function makeToolBlock(overrides: Partial<ToolBlock> & { id: string; name: string }): ToolBlock {
  return {
    kind: 'tool',
    id: overrides.id,
    toolCallId: overrides.toolCallId ?? `call_${overrides.id}`,
    name: overrides.name,
    argsText: overrides.argsText ?? '{}',
    args: overrides.args ?? {},
    status: overrides.status ?? 'done',
    output: overrides.output ?? '',
    display: overrides.display ?? undefined,
    description: overrides.description ?? undefined,
    isError: overrides.isError ?? false,
    durationMs: overrides.durationMs ?? 1000,
    progressText: overrides.progressText ?? undefined,
  };
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  originalCreateObjectUrl = URL.createObjectURL;
  originalRevokeObjectUrl = URL.revokeObjectURL;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:kiki-session-media'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(async () => {
  mocks.readSessionMediaBytes.mockReset();
  mocks.readHostFileBytes.mockReset();
  mocks.readSessionMediaPreviewBytes.mockReset();
  mocks.readHostMediaPreviewBytes.mockReset();
  mocks.downloadSessionMedia.mockReset();
  mocks.downloadHostFile.mockReset();
  mocks.activeClient = undefined;
  // By default the preview read is the original read: these cases are about
  // the file id, the MIME and the dialog, not about bounding.
  mocks.readSessionMediaPreviewBytes.mockImplementation((...args: unknown[]) => mocks.readSessionMediaBytes(...(args as [string, string])));
  mocks.readHostMediaPreviewBytes.mockImplementation((...args: unknown[]) => mocks.readHostFileBytes(...(args as [string])));
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await act(async () => {
      flushSync(() => { root.unmount(); });
    });
  }
  for (const container of containers.splice(0)) container.remove();
  document.body.querySelectorAll('[role="dialog"]').forEach((dialog) => { dialog.remove(); });
});

afterAll(() => {
  if (originalCreateObjectUrl === undefined) {
    Reflect.deleteProperty(URL, 'createObjectURL');
  } else {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: originalCreateObjectUrl,
    });
  }
  if (originalRevokeObjectUrl === undefined) {
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  } else {
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: originalRevokeObjectUrl,
    });
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('image preview naming', () => {
  it('accepts only real names or legal path basenames and keeps opaque references out of labels', () => {
    expect(safeImagePreviewName({ name: 'shot.png' })).toBe('shot.png');
    expect(safeImagePreviewName({ metadataName: 'metadata.webp' })).toBe('metadata.webp');
    expect(safeImagePreviewName({ path: 'C:\\work\\shot.png' })).toBe('shot.png');
    expect(safeImagePreviewName({
      name: 'data:image/png;base64,AAAA',
      metadataName: 'blob:opaque-image',
      path: '/workspace/shot.png',
    })).toBe('shot.png');
    expect(safeImagePreviewName({ name: 'https://example.test/shot.png', path: '/workspace/fallback.png' })).toBe('fallback.png');
    expect(safeImagePreviewName({ name: 'shot%2Epng', path: '/workspace/fallback.png' })).toBe('fallback.png');
    expect(safeImagePreviewName({ name: `iVBORw0KGgo${'A'.repeat(12)}`, path: '/workspace/fallback.png' })).toBe('fallback.png');
    expect(safeImagePreviewName({ name: '截图 2026.png' })).toBe('截图 2026.png');
    expect(safeImagePreviewName({ name: 'iVBORw0KGgo.png' })).toBe('iVBORw0KGgo.png');
    expect(safeImagePreviewName({ path: 'C:\\工作区\\照片 1.png' })).toBe('照片 1.png');
    expect(imagePreviewLabel({ name: 'data:image/png;base64,AAAA' }, 'Image')).toBe('Image');
    expect(imagePreviewDownloadName({ name: 'blob:image' })).toBe('image');
  });
});

describe('session media preview', () => {
  it('automatically reads one visible deferred image detail per session target without turning file summaries into reads', async () => {
    const load = vi.fn(async () => true);
    const { root } = makeRoot();
    const node = (sessionId: string) => <MediaPreviewProvider sessionId={sessionId}>
      <TranscriptDetailProvider load={load} loads={{}} sessionId={sessionId} agentId="main">
        <MediaPartList media={[
          { kind: 'image', name: 'saved.png', detail: { agentId: 'main', attachmentId: 'image-detail' } },
          { kind: 'file', name: 'archive.bin', detail: { agentId: 'main', attachmentId: 'file-detail' } },
        ]} />
      </TranscriptDetailProvider>
    </MediaPreviewProvider>;
    await renderSettled(root, node('session_image_one'));
    expect(load).toHaveBeenCalledExactlyOnceWith('main', 'attachment', 'image-detail');
    await renderSettled(root, node('session_image_one'));
    expect(load).toHaveBeenCalledTimes(1);
    await renderSettled(root, node('session_image_two'));
    expect(load.mock.calls).toEqual([['main', 'attachment', 'image-detail'], ['main', 'attachment', 'image-detail']]);
  });

  it('decodes a bounded offscreen thumbnail rather than displaying the full bitmap', async () => {
    const close = vi.fn();
    const drawImage = vi.fn();
    const bitmap = { width: 4000, height: 2000, close };
    const createBitmap = vi.fn(async () => bitmap);
    const offscreen = vi.fn(function (this: object, width: number, height: number) {
      return { width, height, getContext: () => ({ drawImage }), convertToBlob: async () => new Blob() };
    });
    vi.stubGlobal('createImageBitmap', createBitmap);
    vi.stubGlobal('OffscreenCanvas', offscreen);
    try {
      await expect(previewThumbnail(new Uint8Array([1, 2, 3]), 'image/png')).resolves.toBe('blob:kiki-session-media');
      expect(createBitmap).toHaveBeenCalledTimes(1);
      expect(offscreen).toHaveBeenCalledWith(768, 384);
      expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 768, 384);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('loads a fileId image through the authenticated session route and opens it', async () => {
    mocks.readSessionMediaBytes.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'image/png',
    });
    const { root, container } = makeRoot();
    await renderSettled(
      root,
      <MediaPreviewProvider sessionId="session_test">
        <MediaPartList media={[{ kind: 'image', fileId: 'img-1', name: 'shot.png' }]} />
      </MediaPreviewProvider>,
    );

    expect(mocks.readSessionMediaPreviewBytes).toHaveBeenCalledWith('session_test', 'img-1', expect.anything());
    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('blob:kiki-session-media');

    await act(async () => {
      image?.closest('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(
      'blob:kiki-session-media',
    );
    expect(mocks.readSessionMediaBytes).toHaveBeenCalledWith('session_test', 'img-1', expect.objectContaining({ timeoutMs: 0 }));
    expect(findDialogButton(document.body.querySelector('[role="dialog"]'), 'Load full file')).toBeUndefined();
  });

  it('loads a persisted user-image blobref with its original MIME', async () => {
    const hash = 'a'.repeat(64);
    mocks.readSessionMediaBytes.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3, 4]), mime: 'application/octet-stream' });
    mocks.readSessionMediaPreviewBytes.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' });
    const { root, container } = makeRoot();
    await renderSettled(root, <MediaPreviewProvider sessionId="session_test">
      <MediaPartList media={[{ kind: 'image', blobHash: hash, fileId: `blobref:main:${hash}`, mime: 'image/png' }]} />
    </MediaPreviewProvider>);
    expect(mocks.readSessionMediaPreviewBytes).toHaveBeenCalledWith('session_test', `blobref:main:${hash}`, expect.anything());
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:kiki-session-media');
    expect(vi.mocked(URL.createObjectURL).mock.calls.at(-1)?.[0]).toMatchObject({ type: 'image/png', size: 3 });
    await act(async () => {
      container.querySelector('img')?.closest('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe('blob:kiki-session-media');
  });

  it('opens and downloads a fileId attachment instead of rendering a dead chip', async () => {
    mocks.readSessionMediaBytes.mockResolvedValue({
      bytes: new Uint8Array([4, 5]),
      mime: 'text/plain',
      name: 'notes.txt',
    });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    // The save streams through the host sink; this case only needs the file
    // the reader asked for to arrive, which the native path covers at size.
    mocks.downloadSessionMedia.mockImplementation(async (_sessionId, _fileId, sink) => {
      await sink(new Uint8Array([4, 5]), { bytes: 2, totalBytes: 2 });
    });
    const { root, container } = makeRoot();
    await renderSettled(
      root,
      <MediaPreviewProvider sessionId="session_test">
        <MediaPartList
          media={[{ kind: 'file', fileId: 'file-1', name: 'notes.txt', mime: 'text/plain' }]}
        />
      </MediaPreviewProvider>,
    );

    const chip = container.querySelector('button');
    expect(chip).not.toBeNull();
    await act(async () => {
      chip?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.querySelector('[data-attachment-preview]')).not.toBeNull();
    expect(findDialogButton(dialog, 'Load full file')).toBeUndefined();
    expect(mocks.readSessionMediaBytes).toHaveBeenCalledWith('session_test', 'file-1', expect.anything());
    expect(mocks.readSessionMediaPreviewBytes).not.toHaveBeenCalled();
    expect(dialog?.querySelector('[data-attachment-preview] pre')?.textContent).toBe('\u0004\u0005');

    const download = findDialogButton(dialog, 'Download');
    expect(download).not.toBeUndefined();
    await act(async () => {
      download?.click();
    });
    expect(mocks.downloadSessionMedia).toHaveBeenCalledWith('session_test', 'file-1', expect.anything(), expect.anything());
    expect(clickSpy).toHaveBeenCalledOnce();
  });
});

function readMediaBlock(path: string, url: string, kind: 'image' | 'video' = 'image', inputPath = path): ToolBlock {
  return {
    kind: 'tool', id: 'read-media', toolCallId: 'read-media', name: 'ReadMediaFile',
    argsText: '', args: { path: inputPath }, display: undefined, description: undefined,
    status: 'done', isError: undefined, durationMs: undefined, progressText: undefined,
    output: [
      { type: 'text', text: `<${kind} path="${path}">` },
      { type: `${kind}_url`, [kind === 'image' ? 'imageUrl' : 'videoUrl']: { url } },
      { type: 'text', text: `</${kind}>` },
    ],
  };
}

/** Opens the real tool card; media needs no second loading action. */
async function renderReadMedia(block: ToolBlock): Promise<HTMLDivElement> {
  const { root, container } = makeRoot();
  await renderSettled(root, <MediaPreviewProvider sessionId="session_test"><ToolCard block={block} agentId="main" /></MediaPreviewProvider>);
  await act(async () => {
    container.querySelector('[data-tool] [data-activity-toggle]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(container.textContent).not.toContain('Load full file');
  expect(container.querySelector('a[download]')).toBeNull();
  return container;
}

describe('ReadMediaFile tool result preview', () => {
  it('reads the saved image bytes, not the current absolute Windows path', async () => {
    const path = 'C:\\work\\shots\\home.png';
    // The preview carries the image's own MIME; the generic download MIME the
    // original route would hand back is exactly what must not be shown.
    mocks.readSessionMediaBytes.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3, 4]), mime: 'application/octet-stream' });
    mocks.readSessionMediaPreviewBytes.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' });
    const container = await renderReadMedia(readMediaBlock(path, `blobref:image/png;${'a'.repeat(64)}`));

    expect(mocks.readSessionMediaPreviewBytes).toHaveBeenCalledWith('session_test', `blobref:main:${'a'.repeat(64)}`, expect.anything());
    expect(mocks.readHostMediaPreviewBytes).not.toHaveBeenCalled();
    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('blob:kiki-session-media');
    expect(vi.mocked(URL.createObjectURL).mock.calls.at(-1)?.[0]).toMatchObject({ type: 'image/png', size: 3 });
    await act(async () => {
      image?.closest('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe('blob:kiki-session-media');
  });

  it('keeps the original absolute result path for relative input and preserves inline media', async () => {
    const hashish = 'd'.repeat(64);
    mocks.readSessionMediaPreviewBytes.mockResolvedValue({ bytes: new Uint8Array([1]), mime: 'image/png' });
    const cold = await renderReadMedia(readMediaBlock('/workspace/shot.png', `blobref:image/png;${'b'.repeat(64)}`, 'image', './shot.png'));
    expect(mocks.readSessionMediaPreviewBytes).toHaveBeenCalledWith('session_test', `blobref:main:${'b'.repeat(64)}`, expect.anything());
    expect(cold.querySelector('img')?.getAttribute('src')).toBe('blob:kiki-session-media');

    // An inline data URL needs no session read at all: the row shows the image
    // as it is and reads nothing.
    const live = await renderReadMedia({ ...readMediaBlock('/workspace/live.png', 'blobref:image/png;${hashish}'), output: [
      { type: 'text', text: '<image path="/workspace/live.png">' },
      { type: 'image', source: { kind: 'base64', media_type: 'image/png', data: 'AAA' } },
      { type: 'text', text: '</image>' },
    ] });
    expect(live.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAA');
    expect(mocks.readSessionMediaPreviewBytes).toHaveBeenCalledTimes(1);
    expect(mocks.readHostMediaPreviewBytes).not.toHaveBeenCalled();
  });

  it('replays two different crops of the same image without showing the original file', async () => {
    const left = 'a'.repeat(64);
    const right = 'b'.repeat(64);
    const path = '/workspace/original.png';
    const crops = new Map([
      [`blobref:agent-1:${left}`, new Uint8Array([1, 2, 3])],
      [`blobref:agent-1:${right}`, new Uint8Array([4, 5, 6, 7])],
    ]);
    mocks.readSessionMediaPreviewBytes.mockImplementation(async (_sessionId: string, fileId: string) => ({
      bytes: crops.get(fileId), mime: 'image/png',
    }));
    vi.mocked(URL.createObjectURL).mockImplementationOnce(() => 'blob:crop-left').mockImplementationOnce(() => 'blob:crop-right');
    const leftBlock = { ...readMediaBlock(path, `blobref:image/png;${left}`),
      id: 'crop-left', toolCallId: 'crop-left', args: { path, region: { x: 0, y: 0, width: 2, height: 2 } } };
    const rightBlock = { ...readMediaBlock(path, `blobref:image/png;${right}`),
      id: 'crop-right', toolCallId: 'crop-right', args: { path, region: { x: 2, y: 0, width: 2, height: 2 } } };
    const { root, container } = makeRoot();
    await renderSettled(root, <MediaPreviewProvider sessionId="session_test">
      <ToolCard block={leftBlock} agentId="agent-1" />
      <ToolCard block={rightBlock} agentId="agent-1" />
    </MediaPreviewProvider>);
    await act(async () => {
      for (const button of container.querySelectorAll('[data-tool] [data-activity-toggle]')) {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
      await Promise.resolve();
    });

    expect(mocks.readSessionMediaPreviewBytes.mock.calls.map(([sessionId, fileId]) => [sessionId, fileId])).toEqual([
      ['session_test', `blobref:agent-1:${left}`],
      ['session_test', `blobref:agent-1:${right}`],
    ]);
    expect([...container.querySelectorAll('img')].map((image) => image.getAttribute('src'))).toEqual([
      'blob:crop-left', 'blob:crop-right',
    ]);
    expect(vi.mocked(URL.createObjectURL).mock.calls.slice(-2).map(([blob]) => (blob as Blob).size)).toEqual([3, 4]);
    expect(mocks.readHostMediaPreviewBytes).not.toHaveBeenCalled();
  });

  it('plays saved video bytes with the blob reference MIME rather than the generic download MIME', async () => {
    const hash = 'd'.repeat(64);
    mocks.readSessionMediaPreviewBytes.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mime: 'video/mp4' });
    const container = await renderReadMedia(readMediaBlock('/workspace/crop.mp4', `blobref:video/mp4;${hash}`, 'video'));

    expect(mocks.readSessionMediaPreviewBytes).toHaveBeenCalledWith('session_test', `blobref:main:${hash}`, expect.anything());
    // The tool row shows the video as its thumbnail; the player is the dialog's.
    const thumb = container.querySelector('img, video');
    expect(thumb?.getAttribute('src')).toBe('blob:kiki-session-media');
    expect(vi.mocked(URL.createObjectURL).mock.calls.at(-1)?.[0]).toMatchObject({ type: 'video/mp4' });
    expect(mocks.readHostMediaPreviewBytes).not.toHaveBeenCalled();
  });

  it('previews provider-only video URLs from the host path and preserves inline videos', async () => {
    mocks.readHostMediaPreviewBytes.mockResolvedValue({ bytes: new Uint8Array([0, 1, 2]), mime: 'video/mp4' });
    const cold = await renderReadMedia(readMediaBlock('/workspace/clip.mp4', 'ms://uploaded-id', 'video'));
    expect(mocks.readHostMediaPreviewBytes).toHaveBeenCalledWith('/workspace/clip.mp4', expect.anything());
    // A host path video is read through the host route, not the session one.
    expect(cold.querySelector('img, video')?.getAttribute('src')).toBe('blob:kiki-session-media');

    // An inline video is shown as it is: no host read, no object URL.
    const live = await renderReadMedia({ ...readMediaBlock('/workspace/live.mp4', 'ms://uploaded-id', 'video'), output: [
      { type: 'text', text: '<video path="/workspace/live.mp4">' },
      { type: 'video', source: { kind: 'base64', media_type: 'video/mp4', data: 'AAA' } },
      { type: 'text', text: '</video>' },
    ] });
    expect(live.querySelector('video')?.getAttribute('src')).toBe('data:video/mp4;base64,AAA');
    expect(mocks.readHostMediaPreviewBytes).toHaveBeenCalledTimes(1);
  });

  it('reports missing saved media rather than displaying the current host file', async () => {
    mocks.readSessionMediaBytes.mockRejectedValue(new Error('blob not found'));
    mocks.readSessionMediaPreviewBytes.mockRejectedValue(new Error('blob not found'));
    const container = await renderReadMedia(readMediaBlock('/workspace/deleted.png', `blobref:image/png;${'c'.repeat(64)}`));

    expect(mocks.readSessionMediaPreviewBytes).toHaveBeenCalledWith('session_test', `blobref:main:${'c'.repeat(64)}`, expect.anything());
    expect(mocks.readHostMediaPreviewBytes).not.toHaveBeenCalled();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('deleted.png');
  });
});


describe('sent image loading and recovery', () => {
  it('shows three inline images automatically without redundant per-image download links', async () => {
    const { root, container } = makeRoot();
    const media = [1023, 65537, 200000].map((size) => ({ kind: 'image' as const, name: `picture-${size}.png`, url: `data:image/png;base64,${'A'.repeat(size)}` }));
    await renderSettled(root, <MediaPreviewProvider sessionId="session"><MediaPartList media={media} /></MediaPreviewProvider>);
    expect(container.querySelectorAll('img')).toHaveLength(3);
    expect(container.textContent).not.toContain('Load full file');
    expect(container.querySelector('a[download]')).toBeNull();
    expect(mocks.readSessionMediaPreviewBytes).not.toHaveBeenCalled();
    await act(async () => { container.querySelector('img')?.closest('button')?.click(); });
    expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(media[0]!.url);
  });

  it('keeps opaque source URLs out of image labels and download names', async () => {
    const rawUrl = 'data:image/png;base64,AAAA';
    const { root, container } = makeRoot();
    await renderSettled(root, <MediaPreviewProvider sessionId="session"><MediaPartList media={[{ kind: 'image', url: rawUrl }]} /></MediaPreviewProvider>);
    const image = container.querySelector<HTMLImageElement>('img');
    const trigger = image?.closest<HTMLButtonElement>('button');
    expect(image?.alt).toBe('Image');
    expect(trigger?.title).toBe('Image');
    expect([...container.querySelectorAll<HTMLElement>('[title]')].every((element) => !element.title.includes(rawUrl))).toBe(true);

    const downloadClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('image');
      expect(this.getAttribute('download')).toBe('image');
    });
    await act(async () => { trigger?.click(); });
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-label')).toBe('Image');
    expect(dialog?.querySelector<HTMLImageElement>('img')?.alt).toBe('Image');
    expect(findDialogButton(dialog, 'Download')).toBeUndefined();
    await act(async () => { dialog?.querySelector('img')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 8, clientY: 8 })); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-lightbox-image-menu] [data-menu-item="save-image"]')?.click(); });
    expect(downloadClick).toHaveBeenCalledOnce();
  });

  it('reports a decoded URL failure and retries instead of leaving a blank frame', async () => {
    const { root, container } = makeRoot();
    await renderSettled(root, <MediaPreviewProvider sessionId="session"><MediaPartList media={[{ kind: 'image', name: 'broken.png', url: 'data:image/png;base64,AAAA' }]} /></MediaPreviewProvider>);
    await act(async () => { container.querySelector('img')?.dispatchEvent(new Event('error')); });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-media-broken="decode"]')?.textContent).toContain('broken.png could not be shown');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-media-broken]')?.click(); });
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('opens a failed thumbnail directly as an original and retries a missing saved source', async () => {
    mocks.readSessionMediaPreviewBytes.mockRejectedValue(new Error('preview unavailable'));
    mocks.readSessionMediaBytes.mockRejectedValueOnce(new Error('missing original')).mockResolvedValueOnce({ bytes: new Uint8Array([1, 2]), mime: 'image/png' });
    const { root, container } = makeRoot();
    await renderSettled(root, <MediaPreviewProvider sessionId="session"><MediaPartList media={[{ kind: 'image', fileId: 'saved', mime: 'image/png', name: 'saved.png' }]} /></MediaPreviewProvider>);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-media-broken]')?.click(); });
    expect(mocks.readSessionMediaBytes).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-lightbox-viewport] [role="alert"]')).not.toBeNull();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-lightbox-viewport] button')?.click(); });
    expect(mocks.readSessionMediaBytes).toHaveBeenCalledTimes(2);
    const lightboxDialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((dialog) => dialog.querySelector('[data-lightbox-viewport]') !== null);
    expect(lightboxDialog?.querySelector('[data-lightbox-viewport] img')).not.toBeNull();
    expect(lightboxDialog?.getAttribute('aria-label')).toBe('saved.png');
  });
});

describe('preview optimization fallback', () => {
  it('automatically reads the saved original when source thumbnail decoding is unavailable, preserving its MIME', async () => {
    mocks.readSessionMediaPreviewBytes.mockRejectedValue(new ApiError({ code: 40001, msg: 'This image has no small preview', data: null }));
    mocks.readSessionMediaBytes.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mime: 'application/octet-stream' });
    const { root, container } = makeRoot();
    await renderSettled(root, <MediaPreviewProvider sessionId="session"><MediaPartList media={[{ kind: 'image', fileId: 'saved-gif', mime: 'image/gif' }]} /></MediaPreviewProvider>);
    expect(mocks.readSessionMediaBytes).toHaveBeenCalledWith('session', 'saved-gif', expect.objectContaining({ timeoutMs: 0 }));
    expect(container.querySelector('img')).not.toBeNull();
    expect(vi.mocked(URL.createObjectURL).mock.calls.at(-1)?.[0]).toMatchObject({ type: 'image/gif' });
  });

  it('does not fall back to another original source when the saved image is missing or forbidden', async () => {
    mocks.readSessionMediaPreviewBytes.mockRejectedValue(new ApiError({ code: 40409, msg: 'file not found', data: null }));
    const { root, container } = makeRoot();
    await renderSettled(root, <MediaPreviewProvider sessionId="session"><MediaPartList media={[{ kind: 'image', fileId: 'missing' }]} /></MediaPreviewProvider>);
    expect(mocks.readSessionMediaBytes).not.toHaveBeenCalled();
    expect(mocks.readHostFileBytes).not.toHaveBeenCalled();
    expect(container.querySelector('[data-media-broken="read"]')).not.toBeNull();
  });
});

describe('sequential bounded previews', () => {
  it('requests the sixth small preview after predecessors unmount and revoke their URLs', async () => {
    mocks.readSessionMediaPreviewBytes.mockResolvedValue({ bytes: new Uint8Array(16 * 1024), mime: 'image/jpeg' });
    const { root, container } = makeRoot();
    const revoked = vi.mocked(URL.revokeObjectURL).mock.calls.length;
    for (let index = 0; index < 6; index += 1) {
      await renderSettled(root, <MediaPreviewProvider sessionId="session"><MediaPartList media={[{ kind: 'image', fileId: `file${index}`, name: `image${index}.jpg`, mime: 'image/jpeg' }]} /></MediaPreviewProvider>);
      expect(container.querySelector('img')).not.toBeNull();
      await renderSettled(root, <MediaPreviewProvider sessionId="session"><MediaPartList media={[]} /></MediaPreviewProvider>);
    }
    expect(mocks.readSessionMediaPreviewBytes).toHaveBeenCalledTimes(6);
    expect(vi.mocked(URL.revokeObjectURL).mock.calls.length - revoked).toBe(6);
  });
});


describe('session Range playback', () => {
  const video: MediaRef = { kind: 'video', fileId: 'blobref:main:saved-video', mime: 'video/mp4', name: 'clip.mp4' };
  const descriptor = (id = 'grant-1', mime = 'video/mp4', expiresAt = Date.now() + 60_000) => ({
    preview_id: id, url: `/media-preview/${id}`, mime, size: 300 * 1024 * 1024, expires_at: expiresAt,
  });
  function playbackClient() {
    const open = vi.fn().mockResolvedValue(descriptor());
    const close = vi.fn().mockResolvedValue(undefined);
    const client = { baseUrl: 'http://localhost:8080', klient: { rest: { sessions: { openMediaPlayback: open, closeMediaPlayback: close } } } } as unknown as KikiClient;
    return { client, open, close };
  }
  function Player({ client, sessionId = 'session-a', item = video, attempt = 0 }: {
    client?: KikiClient; sessionId?: string; item?: MediaRef; attempt?: number;
  }) {
    const load = useSessionMediaPlayback(item, sessionId, client, false, attempt);
    return load.status === 'ready'
      ? <video src={load.url} onError={load.fail} /> : <span data-playback-status={load.status}>{load.status}</span>;
  }
  async function attachment(item: MediaRef) {
    const { root } = makeRoot();
    const api = { current: null as MediaPreviewApi | null };
    await renderSettled(root, <MediaPreviewProvider sessionId="session-a" apiRef={api}>{null}</MediaPreviewProvider>);
    await act(async () => { api.current!.openAttachment(item); });
    return { root, api };
  }
  beforeEach(() => {
    mocks.remote = false;
    mocks.openMediaPlayback.mockReset().mockResolvedValue(descriptor());
    mocks.closeMediaPlayback.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => { mocks.remote = false; vi.useRealTimers(); });

  it.each([
    { item: video, tag: 'video', mime: 'video/mp4' },
    { item: { kind: 'file', fileId: 'saved-audio', mime: 'audio/wav', name: 'recording.wav' } as MediaRef, tag: 'audio', mime: 'audio/wav' },
  ])('uses a descriptor for $tag without reading the original bytes', async ({ item, tag, mime }) => {
    mocks.openMediaPlayback.mockResolvedValue(descriptor('stream', mime));
    await attachment(item);
    expect(document.querySelector(`[role="dialog"] ${tag}`)?.getAttribute('src')).toBe('http://localhost:8080/media-preview/stream');
    expect(mocks.openMediaPlayback).toHaveBeenCalledWith('session-a', item.fileId, expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 15_000 }));
    expect(mocks.readSessionMediaBytes).not.toHaveBeenCalled();
    expect(mocks.readSessionMediaPreviewBytes).not.toHaveBeenCalled();
    expect(mocks.readHostFileBytes).not.toHaveBeenCalled();
  });

  it('revokes a late mint through its original client after switching client and session', async () => {
    const old = playbackClient();
    const next = playbackClient();
    let finish!: (grant: ReturnType<typeof descriptor>) => void;
    old.open.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { root, container } = makeRoot();
    await renderSettled(root, <Player client={old.client} />);
    await renderSettled(root, <Player client={next.client} sessionId="session-b" />);
    await act(async () => { finish(descriptor('late')); });
    expect(old.close).toHaveBeenCalledExactlyOnceWith('late', { timeoutMs: 10_000 });
    expect(next.close).not.toHaveBeenCalled();
    expect(next.open).toHaveBeenCalledWith('session-b', video.fileId, expect.anything());
    expect(container.querySelector('video')?.src).toBe('http://localhost:8080/media-preview/grant-1');
  });

  it('releases on file change and unmount exactly once', async () => {
    const owner = playbackClient();
    owner.open.mockResolvedValueOnce(descriptor('first')).mockResolvedValueOnce(descriptor('second'));
    const { root } = makeRoot();
    await renderSettled(root, <Player client={owner.client} />);
    await renderSettled(root, <Player client={owner.client} item={{ ...video, fileId: 'other-video' }} />);
    expect(owner.close.mock.calls.map(([id]) => id)).toEqual(['first']);
    await renderSettled(root, null);
    expect(owner.close.mock.calls.map(([id]) => id)).toEqual(['first', 'second']);
  });

  it('revokes a mint that resolves after unmount and consumes a rejected revoke', async () => {
    const owner = playbackClient();
    let finish!: (grant: ReturnType<typeof descriptor>) => void;
    owner.open.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    owner.close.mockRejectedValue(new Error('connection closed'));
    const { root } = makeRoot();
    await renderSettled(root, <Player client={owner.client} />);
    await renderSettled(root, null);
    await act(async () => { finish(descriptor('departed')); });
    expect(owner.close).toHaveBeenCalledExactlyOnceWith('departed', { timeoutMs: 10_000 });
  });

  it('waits for a late connection without losing the session file id', async () => {
    const owner = playbackClient();
    const { root, container } = makeRoot();
    await renderSettled(root, <Player />);
    expect(container.textContent).toBe('loading');
    await renderSettled(root, <Player client={owner.client} />);
    expect(owner.open).toHaveBeenCalledWith('session-a', video.fileId, expect.anything());
    expect(container.querySelector('video')).not.toBeNull();
  });

  it('revokes on playback error and retries with a fresh grant without a blob fallback', async () => {
    mocks.openMediaPlayback.mockResolvedValueOnce(descriptor('broken')).mockResolvedValueOnce(descriptor('retry'));
    await attachment(video);
    await act(async () => { document.querySelector('video')!.dispatchEvent(new Event('error')); });
    expect(mocks.closeMediaPlayback).toHaveBeenCalledExactlyOnceWith('broken', { timeoutMs: 10_000 });
    expect(document.querySelector('[role="dialog"] video')).toBeNull();
    await act(async () => { document.querySelector<HTMLButtonElement>('[role="dialog"] [data-media-broken]')!.click(); });
    expect(document.querySelector('video')?.src).toBe('http://localhost:8080/media-preview/retry');
    expect(mocks.readSessionMediaBytes).not.toHaveBeenCalled();
  });

  it('expires and retries within a bounded lease and never reuses its URL', async () => {
    vi.useFakeTimers();
    const owner = playbackClient();
    owner.open.mockResolvedValueOnce(descriptor('expires', 'video/mp4', Date.now() + 1000)).mockResolvedValueOnce(descriptor('renewed'));
    const { root, container } = makeRoot();
    await renderSettled(root, <Player client={owner.client} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(container.textContent).toBe('failed');
    expect(owner.close).toHaveBeenCalledExactlyOnceWith('expires', { timeoutMs: 10_000 });
    await renderSettled(root, <Player client={owner.client} attempt={1} />);
    expect(container.querySelector('video')?.src).toBe('http://localhost:8080/media-preview/renewed');
  });

  it.each(['unsupported', 'remote', 'loopback denied'] as const)('preserves the canonical byte fallback for %s', async (mode) => {
    if (mode === 'remote') mocks.remote = true;
    else mocks.openMediaPlayback.mockRejectedValue(mode === 'unsupported'
      ? { code: 404 } : { code: 40301, message: 'media_preview_requires_local_connection' });
    mocks.readSessionMediaBytes.mockResolvedValue({ bytes: new Uint8Array([1, 2]), mime: 'video/mp4' });
    await attachment(video);
    expect(document.querySelector('video')?.getAttribute('src')).toBe('blob:kiki-session-media');
    expect(mocks.readSessionMediaBytes).toHaveBeenCalledWith('session-a', video.fileId, expect.anything());
    expect(mocks.readHostFileBytes).not.toHaveBeenCalled();
    if (mode === 'remote') expect(mocks.openMediaPlayback).not.toHaveBeenCalled();
  });

  it.each([new Error('network unavailable'), { code: 40409 }])('keeps mint failures visible instead of disguising them as unsupported', async (error) => {
    mocks.openMediaPlayback.mockRejectedValueOnce(error).mockResolvedValueOnce(descriptor('retry'));
    await attachment(video);
    expect(document.querySelector('[role="dialog"] [data-media-broken]')).not.toBeNull();
    expect(mocks.readSessionMediaBytes).not.toHaveBeenCalled();
    await act(async () => { document.querySelector<HTMLButtonElement>('[role="dialog"] [data-media-broken]')!.click(); });
    expect(document.querySelector('video')?.src).toBe('http://localhost:8080/media-preview/retry');
  });

  it.each([
    { ...video, fileId: undefined, path: '/workspace/clip.mp4' },
    { kind: 'file', fileId: 'text-file', name: 'notes.txt', mime: 'text/plain' } as MediaRef,
  ])('leaves hostpath and non-playback attachments on their existing read route', async (item) => {
    mocks.readSessionMediaBytes.mockResolvedValue({ bytes: new Uint8Array([65]), mime: 'text/plain' });
    mocks.readHostFileBytes.mockResolvedValue({ bytes: new Uint8Array([1, 2]), mime: 'video/mp4' });
    await attachment(item);
    expect(mocks.openMediaPlayback).not.toHaveBeenCalled();
    if (item.path !== undefined) expect(mocks.readHostFileBytes).toHaveBeenCalledWith(item.path, expect.anything());
    else expect(mocks.readSessionMediaBytes).toHaveBeenCalledWith('session-a', item.fileId, expect.anything());
  });
});

describe('ToolCard real Voice plugin result and canonical audio playback', () => {
  beforeEach(() => {
    mocks.remote = false;
    mocks.openMediaPlayback.mockReset();
    mocks.closeMediaPlayback.mockReset().mockResolvedValue(undefined);
  });

  it('parses real Voice plugin JSON string with separate job and delivery, rendering delivery details', async () => {
    const rawVoiceOutput = JSON.stringify({
      type: 'media_generation',
      job: {
        job_id: 'voice-job-123',
        request_id: 'req-speak-1',
        state: 'succeeded',
        phase: 'complete',
        provider: 'kiki-media/script-voice-proof',
        model: 'default',
        artifacts: [{
          id: 'art-1',
          kind: 'audio',
          role: 'original',
          complete: true,
          file_id: 'file-audio-voice-1',
          name: 'speech.mp3',
          mime: 'audio/mpeg',
          bytes: 1024,
        }],
      },
      delivery: {
        delivery: 'delivered',
        request_id: 'delivery-1',
        detail: 'Sent successfully to channel',
        channels: [{
          channel_id: 'im:qq',
          status: 'delivered',
        }],
      },
    });

    const block = makeToolBlock({
      id: 'tool-voice-1',
      name: 'plugin__kiki_voice__speak',
      argsText: '{"text":"hello"}',
      args: { text: 'hello' },
      output: rawVoiceOutput,
    });

    const { root, container } = makeRoot();
    await renderSettled(
      root,
      <MediaPreviewProvider sessionId="session_voice_test">
        <ToolCard block={block} agentId="main" />
      </MediaPreviewProvider>,
    );

    // Expand ToolCard
    await act(async () => {
      container.querySelector('[data-tool] [data-activity-toggle]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Verify MediaJobView rendered from JSON string
    const jobElem = container.querySelector('[data-media-job="voice-job-123"]');
    expect(jobElem).not.toBeNull();
    expect(jobElem?.getAttribute('data-media-job-state')).toBe('succeeded');

    // Verify delivery section is rendered separately
    const deliveryElem = container.querySelector('[data-media-job-delivery]');
    expect(deliveryElem).not.toBeNull();
    expect(deliveryElem?.textContent).toContain('Delivery');
    expect(deliveryElem?.textContent).toContain('Delivered');
    expect(deliveryElem?.textContent).toContain('Sent successfully to channel');
    expect(container.querySelector('[data-media-delivery-channel="im:qq"]')).not.toBeNull();
  });

  it('renders mixed delivered/unsupported and unknown channels accurately without false success', async () => {
    const rawVoiceOutput = JSON.stringify({
      type: 'media_generation',
      job: {
        job_id: 'voice-job-mixed',
        request_id: 'req-speak-2',
        state: 'succeeded',
        provider: 'kiki-media/tts',
        artifacts: [{
          id: 'art-audio-mixed',
          kind: 'audio',
          role: 'original',
          complete: true,
          file_id: 'file-audio-mixed',
          name: 'mixed.mp3',
          mime: 'audio/mpeg',
          bytes: 2048,
        }],
      },
      delivery: {
        delivery: 'partial',
        request_id: 'del-mixed-1',
        channels: [
          { channel_id: 'internal', status: 'delivered' },
          { channel_id: 'im:unsupported', status: 'unsupported', unsupported: ['voice'] },
          { channel_id: 'im:unknown', status: 'unknown' },
        ],
      },
    });

    const block = makeToolBlock({
      id: 'tool-voice-mixed',
      name: 'plugin__kiki_voice__speak',
      output: rawVoiceOutput,
    });

    const { root, container } = makeRoot();
    await renderSettled(
      root,
      <MediaPreviewProvider sessionId="session_voice_test">
        <ToolCard block={block} agentId="main" />
      </MediaPreviewProvider>,
    );

    await act(async () => {
      container.querySelector('[data-tool] [data-activity-toggle]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const deliveryElem = container.querySelector('[data-media-job-delivery]');
    expect(deliveryElem).not.toBeNull();
    expect(deliveryElem?.textContent).toContain('Partially delivered');
    expect(container.querySelector('[data-media-delivery-channel="im:unsupported"][data-media-delivery-channel-status="unsupported"]')).not.toBeNull();
    expect(container.querySelector('[data-media-delivery-channel="im:unknown"][data-media-delivery-channel-status="unknown"]')).not.toBeNull();
  });

  it('plays audio from canonical file_id via openMediaPlayback on user action', async () => {
    mocks.openMediaPlayback.mockResolvedValue({
      preview_id: 'grant-voice-play',
      url: '/media-preview/grant-voice-play',
      mime: 'audio/mpeg',
      size: 1234,
      expires_at: Date.now() + 60_000,
    });

    const voiceOutput = {
      type: 'media_generation',
      job: {
        job_id: 'voice-job-play',
        request_id: 'req-audio-play',
        state: 'succeeded',
        provider: 'kiki-media/tts',
        artifacts: [{
          id: 'art-play-1',
          kind: 'audio',
          role: 'original',
          complete: true,
          file_id: 'file-canonical-audio-play',
          name: 'voice-clip.mp3',
          mime: 'audio/mpeg',
          bytes: 1234,
        }],
      },
    };

    const block = makeToolBlock({
      id: 'tool-voice-play',
      name: 'plugin__kiki_voice__speak',
      output: JSON.stringify(voiceOutput),
    });

    const { root, container } = makeRoot();
    await renderSettled(
      root,
      <MediaPreviewProvider sessionId="session_audio_session_1">
        <ToolCard block={block} agentId="main" />
      </MediaPreviewProvider>,
    );

    await act(async () => {
      container.querySelector('[data-tool] [data-activity-toggle]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const playBtn = container.querySelector<HTMLButtonElement>('[data-media-audio="art-play-1"]');
    expect(playBtn).not.toBeNull();

    // Trigger audio playback
    await act(async () => {
      playBtn?.click();
    });

    expect(mocks.openMediaPlayback).toHaveBeenCalledWith(
      'session_audio_session_1',
      'file-canonical-audio-play',
      expect.anything(),
    );

    // Audio element loaded and mounted via canonical stream URL
    const audioElement = container.querySelector<HTMLAudioElement>('audio[data-media-audio="art-play-1"]');
    expect(audioElement).not.toBeNull();
    expect(audioElement?.src).toBe('http://localhost:8080/media-preview/grant-voice-play');
  });

  it('falls back to readSessionMediaBytes when playback route is unsupported', async () => {
    mocks.openMediaPlayback.mockRejectedValue({ code: 404 });
    mocks.readSessionMediaBytes.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'audio/mpeg',
    });

    const voiceOutput = {
      type: 'media_generation',
      job: {
        job_id: 'voice-job-fb',
        request_id: 'req-fb',
        state: 'succeeded',
        provider: 'kiki-media/tts',
        artifacts: [{
          id: 'art-fb-1',
          kind: 'audio',
          role: 'original',
          complete: true,
          file_id: 'file-canonical-audio-fb',
          name: 'fallback.mp3',
          mime: 'audio/mpeg',
          bytes: 456,
        }],
      },
    };

    const block = makeToolBlock({
      id: 'tool-voice-fb',
      name: 'plugin__kiki_voice__speak',
      output: JSON.stringify(voiceOutput),
    });

    const { root, container } = makeRoot();
    await renderSettled(
      root,
      <MediaPreviewProvider sessionId="session_fb">
        <ToolCard block={block} agentId="main" />
      </MediaPreviewProvider>,
    );

    await act(async () => {
      container.querySelector('[data-tool] [data-activity-toggle]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const playBtn = container.querySelector<HTMLButtonElement>('[data-media-audio="art-fb-1"]');
    await act(async () => {
      playBtn?.click();
    });

    expect(mocks.readSessionMediaBytes).toHaveBeenCalledWith(
      'session_fb',
      'file-canonical-audio-fb',
      expect.anything(),
    );
    const audioElement = container.querySelector<HTMLAudioElement>('audio[data-media-audio="art-fb-1"]');
    expect(audioElement).not.toBeNull();
    expect(audioElement?.src).toBe('blob:kiki-session-media');
  });

  it('safely degrades malformed JSON output to ReadableToolText without crashing', async () => {
    const malformed = '{ "type": "media_generation", "job": { incomplete: true';
    const block = makeToolBlock({
      id: 'tool-malformed',
      name: 'plugin__kiki_voice__speak',
      output: malformed,
    });

    const { root, container } = makeRoot();
    await renderSettled(
      root,
      <MediaPreviewProvider sessionId="session_test">
        <ToolCard block={block} agentId="main" />
      </MediaPreviewProvider>,
    );

    await act(async () => {
      container.querySelector('[data-tool] [data-activity-toggle]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('[data-media-job]')).toBeNull();
    expect(container.textContent).toContain('{ "type": "media_generation"');
  });

  it('V1: retries remote/fallback byte load after initial failure on user retry action', async () => {
    // Force remote connection so it hits fallback byte load
    mocks.remote = true;
    let callCount = 0;
    mocks.readSessionMediaBytes.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('remote network read failed');
      }
      return {
        bytes: new Uint8Array([1, 2, 3]),
        mime: 'audio/mpeg',
      };
    });

    const voiceOutput = {
      type: 'media_generation',
      job: {
        job_id: 'voice-job-remote-retry',
        request_id: 'req-remote-retry',
        state: 'succeeded',
        provider: 'kiki-media/tts',
        artifacts: [{
          id: 'art-remote-retry-1',
          kind: 'audio',
          role: 'original',
          complete: true,
          file_id: 'file-remote-retry-1',
          name: 'remote-clip.mp3',
          mime: 'audio/mpeg',
          bytes: 1234,
        }],
      },
    };

    const block = makeToolBlock({
      id: 'tool-remote-retry',
      name: 'plugin__kiki_voice__speak',
      output: JSON.stringify(voiceOutput),
    });

    const { root, container } = makeRoot();
    await renderSettled(
      root,
      <MediaPreviewProvider sessionId="session_remote_retry">
        <ToolCard block={block} agentId="main" />
      </MediaPreviewProvider>,
    );

    await act(async () => {
      container.querySelector('[data-tool] [data-activity-toggle]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // 1st play: armed -> triggers readSessionMediaBytes -> fails
    const playBtn = container.querySelector<HTMLButtonElement>('[data-media-audio="art-remote-retry-1"]');
    await act(async () => {
      playBtn?.click();
    });

    expect(callCount).toBe(1);
    const failedNotice = container.querySelector('[data-media-audio-state="failed"]');
    expect(failedNotice).not.toBeNull();
    const retryBtn = container.querySelector<HTMLButtonElement>('[data-media-audio-retry="art-remote-retry-1"]');
    expect(retryBtn).not.toBeNull();

    // 2nd play: retry button clicked -> attempt increments -> readSessionMediaBytes triggers again -> succeeds
    await act(async () => {
      retryBtn?.click();
    });

    expect(callCount).toBe(2);
    const audioElement = container.querySelector<HTMLAudioElement>('audio[data-media-audio="art-remote-retry-1"]');
    expect(audioElement).not.toBeNull();
    expect(audioElement?.src).toBe('blob:kiki-session-media');
  });

  it('V2: handles audio element decode/stream failure via onError and closes playback lease', async () => {
    mocks.remote = false;
    mocks.openMediaPlayback.mockResolvedValue({
      preview_id: 'grant-decode-fail',
      url: '/media-preview/grant-decode-fail',
      mime: 'audio/mpeg',
      size: 1000,
      expires_at: Date.now() + 60_000,
    });

    const voiceOutput = {
      type: 'media_generation',
      job: {
        job_id: 'voice-job-decode-fail',
        request_id: 'req-decode-fail',
        state: 'succeeded',
        provider: 'kiki-media/tts',
        artifacts: [{
          id: 'art-decode-fail-1',
          kind: 'audio',
          role: 'original',
          complete: true,
          file_id: 'file-decode-fail-1',
          name: 'decode-fail.mp3',
          mime: 'audio/mpeg',
          bytes: 1000,
        }],
      },
    };

    const block = makeToolBlock({
      id: 'tool-decode-fail',
      name: 'plugin__kiki_voice__speak',
      output: JSON.stringify(voiceOutput),
    });

    const { root, container } = makeRoot();
    await renderSettled(
      root,
      <MediaPreviewProvider sessionId="session_decode_fail">
        <ToolCard block={block} agentId="main" />
      </MediaPreviewProvider>,
    );

    await act(async () => {
      container.querySelector('[data-tool] [data-activity-toggle]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Play -> loads audio
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-media-audio="art-decode-fail-1"]')?.click();
    });

    const audioElement = container.querySelector<HTMLAudioElement>('audio[data-media-audio="art-decode-fail-1"]');
    expect(audioElement).not.toBeNull();

    // Trigger audio decode/stream error
    await act(async () => {
      audioElement?.dispatchEvent(new Event('error'));
    });

    // Should have called closeMediaPlayback to release lease
    expect(mocks.closeMediaPlayback).toHaveBeenCalledWith('grant-decode-fail', expect.anything());

    // Should switch to failed state with retry
    const failedNotice = container.querySelector('[data-media-audio-state="failed"]');
    expect(failedNotice).not.toBeNull();
    expect(container.querySelector('[data-media-audio-retry="art-decode-fail-1"]')).not.toBeNull();
  });

  it('V3: revokes old objectUrl and resets byte load state when source session or file changes', async () => {
    mocks.remote = true;
    const revokedUrls: string[] = [];
    if (originalRevokeObjectUrl) {
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
        revokedUrls.push(url);
      });
    }

    mocks.readSessionMediaBytes.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'audio/mpeg',
    });

    const voiceOutput1 = {
      type: 'media_generation',
      job: {
        job_id: 'voice-job-src-1',
        request_id: 'req-src-1',
        state: 'succeeded',
        provider: 'kiki-media/tts',
        artifacts: [{
          id: 'art-src-1',
          kind: 'audio',
          role: 'original',
          complete: true,
          file_id: 'file-src-1',
          name: 'clip1.mp3',
          mime: 'audio/mpeg',
          bytes: 100,
        }],
      },
    };

    const block1 = makeToolBlock({
      id: 'tool-src-1',
      name: 'plugin__kiki_voice__speak',
      output: JSON.stringify(voiceOutput1),
    });

    const { root, container } = makeRoot();
    await renderSettled(
      root,
      <MediaPreviewProvider sessionId="session_1">
        <ToolCard block={block1} agentId="main" />
      </MediaPreviewProvider>,
    );

    await act(async () => {
      container.querySelector('[data-tool] [data-activity-toggle]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-media-audio="art-src-1"]')?.click();
    });

    expect(container.querySelector('audio[data-media-audio="art-src-1"]')).not.toBeNull();

    // Now change session to session_2 with a different block
    const voiceOutput2 = {
      type: 'media_generation',
      job: {
        job_id: 'voice-job-src-2',
        request_id: 'req-src-2',
        state: 'succeeded',
        provider: 'kiki-media/tts',
        artifacts: [{
          id: 'art-src-2',
          kind: 'audio',
          role: 'original',
          complete: true,
          file_id: 'file-src-2',
          name: 'clip2.mp3',
          mime: 'audio/mpeg',
          bytes: 200,
        }],
      },
    };

    const block2 = makeToolBlock({
      id: 'tool-src-2',
      name: 'plugin__kiki_voice__speak',
      output: JSON.stringify(voiceOutput2),
    });

    await renderSettled(
      root,
      <MediaPreviewProvider sessionId="session_2">
        <ToolCard block={block2} agentId="main" />
      </MediaPreviewProvider>,
    );

    // Old URL should have been revoked
    expect(revokedUrls).toContain('blob:kiki-session-media');
    // New item in session_2 should start idle and not carry over session_1 audio
    const newPlayBtn = container.querySelector<HTMLButtonElement>('[data-media-audio="art-src-2"]');
    expect(newPlayBtn).not.toBeNull();
    expect(newPlayBtn?.getAttribute('data-media-audio-state')).toBe('idle');
  });

  it('V3 residual: same artifact and same session/file but switching client resets armed to idle without new read until clicked', async () => {
    mocks.remote = true;
    let readCount = 0;
    mocks.readSessionMediaBytes.mockImplementation(async () => {
      readCount++;
      return {
        bytes: new Uint8Array([1, 2, 3]),
        mime: 'audio/mpeg',
      };
    });

    const voiceOutput = {
      type: 'media_generation',
      job: {
        job_id: 'voice-job-client-switch',
        request_id: 'req-cs-1',
        state: 'succeeded',
        provider: 'kiki-media/tts',
        artifacts: [{
          id: 'art-client-switch',
          kind: 'audio',
          role: 'original',
          complete: true,
          file_id: 'file-cs-1',
          name: 'audio.mp3',
          mime: 'audio/mpeg',
          bytes: 100,
        }],
      },
    };

    const block = makeToolBlock({
      id: 'tool-cs',
      name: 'plugin__kiki_voice__speak',
      output: JSON.stringify(voiceOutput),
    });

    const clientA = {
      readingOptions: () => ({ timeoutMs: 0 }),
      readSessionMediaBytes: mocks.readSessionMediaBytes,
      readHostFileBytes: mocks.readHostFileBytes,
      readSessionMediaPreviewBytes: mocks.readSessionMediaPreviewBytes,
      readHostMediaPreviewBytes: mocks.readHostMediaPreviewBytes,
      downloadSessionMedia: mocks.downloadSessionMedia,
      downloadHostFile: mocks.downloadHostFile,
      baseUrl: 'http://localhost:8080',
      klient: { rest: { sessions: { openMediaPlayback: mocks.openMediaPlayback, closeMediaPlayback: mocks.closeMediaPlayback } } },
    };

    mocks.activeClient = clientA;

    const { root, container } = makeRoot();
    await renderSettled(
      root,
      <MediaPreviewProvider sessionId="session_cs">
        <ToolCard block={block} agentId="main" />
      </MediaPreviewProvider>,
    );

    await act(async () => {
      container.querySelector('[data-tool] [data-activity-toggle]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // 1. Click play on clientA -> armed on clientA, reads bytes
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-media-audio="art-client-switch"]')?.click();
    });

    expect(readCount).toBe(1);
    expect(container.querySelector('audio[data-media-audio="art-client-switch"]')).not.toBeNull();

    // 2. Switch connection client to clientB (same session, same file_id, same artifact)
    const clientB = { ...clientA };
    mocks.activeClient = clientB;

    await renderSettled(
      root,
      <MediaPreviewProvider sessionId="session_cs">
        <ToolCard block={block} agentId="main" />
      </MediaPreviewProvider>,
    );

    // 3. Armed status must NOT leak to clientB; audio should reset to idle without triggering another read
    expect(readCount).toBe(1);
    const playBtn = container.querySelector<HTMLButtonElement>('[data-media-audio="art-client-switch"]');
    expect(playBtn).not.toBeNull();
    expect(playBtn?.getAttribute('data-media-audio-state')).toBe('idle');

    // 4. Click play again on clientB -> now armed on clientB, triggers 2nd read
    await act(async () => {
      playBtn?.click();
    });
    expect(readCount).toBe(2);
  });

  it('V4: extracts valid media_generation payload even when preceded by unrelated JSON parts', async () => {
    const unrelatedJsonPart = {
      type: 'text',
      text: JSON.stringify({ event: 'status_update', timestamp: 12345678, status: 'ok' }),
    };

    const voiceOutput = {
      type: 'media_generation',
      job: {
        job_id: 'voice-job-parts-multi',
        request_id: 'req-parts-multi',
        state: 'succeeded',
        provider: 'kiki-media/tts',
        artifacts: [{
          id: 'art-parts-1',
          kind: 'audio',
          role: 'original',
          complete: true,
          file_id: 'file-parts-1',
          name: 'multi-part-clip.mp3',
          mime: 'audio/mpeg',
          bytes: 333,
        }],
      },
      delivery: {
        delivery: 'delivered',
        request_id: 'del-parts-1',
        message_id: 'msg-parts-1',
      },
    };

    const mediaGenerationPart = {
      type: 'text',
      text: JSON.stringify(voiceOutput),
    };

    const block = makeToolBlock({
      id: 'tool-parts-multi',
      name: 'plugin__kiki_voice__speak',
      output: [unrelatedJsonPart, mediaGenerationPart],
    });

    const { root, container } = makeRoot();
    await renderSettled(
      root,
      <MediaPreviewProvider sessionId="session_parts">
        <ToolCard block={block} agentId="main" />
      </MediaPreviewProvider>,
    );

    await act(async () => {
      container.querySelector('[data-tool] [data-activity-toggle]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const jobElem = container.querySelector('[data-media-job="voice-job-parts-multi"]');
    expect(jobElem).not.toBeNull();
    expect(container.querySelector('[data-media-audio="art-parts-1"]')).not.toBeNull();
    expect(container.querySelector('[data-media-job-delivery]')).not.toBeNull();
  });

  it('V5: renders batch delivery with multiple messages and mixed delivered/failed status accurately', async () => {
    const rawVoiceBatchOutput = JSON.stringify({
      type: 'media_generation',
      job: {
        job_id: 'voice-job-batch-multi',
        request_id: 'req-batch-multi',
        state: 'succeeded',
        provider: 'kiki-media/tts',
        artifacts: [{
          id: 'art-batch-1',
          kind: 'audio',
          role: 'original',
          complete: true,
          file_id: 'file-batch-1',
          name: 'batch.mp3',
          mime: 'audio/mpeg',
          bytes: 512,
        }],
      },
      delivery: {
        request_id: 'req-batch-delivery',
        messages: [
          {
            index: 0,
            message_id: 'msg-batch-0',
            delivery: 'delivered',
            channels: [
              { channel_id: 'im:qq', status: 'delivered' },
            ],
          },
          {
            index: 1,
            message_id: 'msg-batch-1',
            delivery: 'undeliverable',
            detail: 'Target user blocked the bot or channel unavailable',
            channels: [
              { channel_id: 'im:tg', status: 'failed' },
            ],
          },
        ],
      },
    });

    const block = makeToolBlock({
      id: 'tool-voice-batch-multi',
      name: 'plugin__kiki_voice__speak',
      output: rawVoiceBatchOutput,
    });

    const { root, container } = makeRoot();
    await renderSettled(
      root,
      <MediaPreviewProvider sessionId="session_batch_multi">
        <ToolCard block={block} agentId="main" />
      </MediaPreviewProvider>,
    );

    await act(async () => {
      container.querySelector('[data-tool] [data-activity-toggle]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const deliveryElem = container.querySelector('[data-media-job-delivery]');
    expect(deliveryElem).not.toBeNull();
    expect(deliveryElem?.textContent).toContain('Delivery');

    // Both messages must be rendered individually with their exact receipt status
    const msg0 = container.querySelector('[data-media-delivery-item="0"]');
    expect(msg0).not.toBeNull();
    expect(msg0?.querySelector('[data-media-delivery-item-status="delivered"]')).not.toBeNull();
    expect(msg0?.textContent).toContain('Delivered');
    expect(msg0?.querySelector('[data-media-delivery-channel="im:qq"][data-media-delivery-channel-status="delivered"]')).not.toBeNull();

    const msg1 = container.querySelector('[data-media-delivery-item="1"]');
    expect(msg1).not.toBeNull();
    expect(msg1?.querySelector('[data-media-delivery-item-status="undeliverable"]')).not.toBeNull();
    expect(msg1?.textContent).toContain('Undeliverable');
    expect(msg1?.textContent).toContain('Target user blocked');
    expect(msg1?.querySelector('[data-media-delivery-channel="im:tg"][data-media-delivery-channel-status="failed"]')).not.toBeNull();
  });

  it('V5 batch edge case 1: handles batch with delivered item and item with missing delivery (unknown)', async () => {
    const rawOutput = JSON.stringify({
      type: 'media_generation',
      job: {
        job_id: 'voice-job-batch-missing-del',
        request_id: 'req-b-1',
        state: 'succeeded',
        provider: 'kiki-media/tts',
        artifacts: [{
          id: 'art-b-1',
          kind: 'audio',
          role: 'original',
          complete: true,
          file_id: 'file-b-1',
          name: 'b1.mp3',
          mime: 'audio/mpeg',
          bytes: 100,
        }],
      },
      delivery: {
        messages: [
          {
            index: 0,
            delivery: 'delivered',
            channels: [{ channel_id: 'im:ch1', status: 'delivered' }],
          },
          {
            index: 1,
            // delivery field omitted
            channels: [{ channel_id: 'im:ch2', status: 'unknown' }],
          },
        ],
      },
    });

    const block = makeToolBlock({
      id: 'tool-b-missing',
      name: 'plugin__kiki_voice__speak',
      output: rawOutput,
    });

    const { root, container } = makeRoot();
    await renderSettled(
      root,
      <MediaPreviewProvider sessionId="session_b_missing">
        <ToolCard block={block} agentId="main" />
      </MediaPreviewProvider>,
    );

    await act(async () => {
      container.querySelector('[data-tool] [data-activity-toggle]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const msg0 = container.querySelector('[data-media-delivery-item="0"]');
    expect(msg0?.querySelector('[data-media-delivery-item-status="delivered"]')).not.toBeNull();
    expect(msg0?.textContent).toContain('Delivered');

    const msg1 = container.querySelector('[data-media-delivery-item="1"]');
    expect(msg1?.querySelector('[data-media-delivery-item-status="unknown"]')).not.toBeNull();
    expect(msg1?.textContent).toContain('Outcome unknown');
  });

  it('V5 batch edge case 2: handles batch where all messages are pending without guessing false success', async () => {
    const rawOutput = JSON.stringify({
      type: 'media_generation',
      job: {
        job_id: 'voice-job-batch-pending',
        request_id: 'req-b-pending',
        state: 'succeeded',
        provider: 'kiki-media/tts',
        artifacts: [{
          id: 'art-b-p',
          kind: 'audio',
          role: 'original',
          complete: true,
          file_id: 'file-b-p',
          name: 'bp.mp3',
          mime: 'audio/mpeg',
          bytes: 100,
        }],
      },
      delivery: {
        messages: [
          {
            index: 0,
            delivery: 'pending',
            channels: [{ channel_id: 'im:pending1', status: 'pending' }],
          },
          {
            index: 1,
            delivery: 'pending',
            channels: [{ channel_id: 'im:pending2', status: 'pending' }],
          },
        ],
      },
    });

    const block = makeToolBlock({
      id: 'tool-b-pending',
      name: 'plugin__kiki_voice__speak',
      output: rawOutput,
    });

    const { root, container } = makeRoot();
    await renderSettled(
      root,
      <MediaPreviewProvider sessionId="session_b_pending">
        <ToolCard block={block} agentId="main" />
      </MediaPreviewProvider>,
    );

    await act(async () => {
      container.querySelector('[data-tool] [data-activity-toggle]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const msg0 = container.querySelector('[data-media-delivery-item="0"]');
    expect(msg0?.querySelector('[data-media-delivery-item-status="pending"]')).not.toBeNull();
    expect(msg0?.textContent).toContain('Sending');

    const msg1 = container.querySelector('[data-media-delivery-item="1"]');
    expect(msg1?.querySelector('[data-media-delivery-item-status="pending"]')).not.toBeNull();
    expect(msg1?.textContent).toContain('Sending');
  });
});
