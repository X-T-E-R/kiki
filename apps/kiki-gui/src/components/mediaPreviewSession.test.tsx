// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import type { ToolBlock } from '@kiki/session-core/session';
import { ApiError } from '@kiki/session-core/transport';
import { MediaPartList, MediaPreviewProvider } from './mediaPreview';
import { previewThumbnail } from './imageThumbnail';
import { ToolCard } from './ToolCard';
import { TranscriptDetailProvider } from './transcriptDetail';
const mocks = vi.hoisted(() => ({
  readSessionMediaBytes: vi.fn(),
  readHostFileBytes: vi.fn(),
  readSessionMediaPreviewBytes: vi.fn(),
  readHostMediaPreviewBytes: vi.fn(),
  downloadSessionMedia: vi.fn(),
  downloadHostFile: vi.fn(),
}));

vi.mock('../state/connection', async (importOriginal) => {
  const original = await importOriginal<typeof import('../state/connection')>();
  const client = {
    readingOptions: () => ({ timeoutMs: 0 }),
    readSessionMediaBytes: mocks.readSessionMediaBytes,
    readHostFileBytes: mocks.readHostFileBytes,
    readSessionMediaPreviewBytes: mocks.readSessionMediaPreviewBytes,
    readHostMediaPreviewBytes: mocks.readHostMediaPreviewBytes,
    downloadSessionMedia: mocks.downloadSessionMedia,
    downloadHostFile: mocks.downloadHostFile,
  };
  return {
    ...original,
    useOptionalConnection: () => ({ client }),
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
    expect(document.querySelector('[data-attachment-preview] [data-media-broken="read"]')).not.toBeNull();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-attachment-preview] [data-media-broken]')?.click(); });
    expect(mocks.readSessionMediaBytes).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-attachment-preview] img')).not.toBeNull();
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
