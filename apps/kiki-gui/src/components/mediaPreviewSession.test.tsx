// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import type { ToolBlock } from '@kiki/session-core/session';
import { MediaPartList, MediaPreviewProvider } from './mediaPreview';
import { previewThumbnail } from './imageThumbnail';
import { ToolCard } from './ToolCard';

const mocks = vi.hoisted(() => ({
  readSessionMediaBytes: vi.fn(),
  readHostFileBytes: vi.fn(),
}));

vi.mock('../state/connection', async (importOriginal) => {
  const original = await importOriginal<typeof import('../state/connection')>();
  const client = {
    readSessionMediaBytes: mocks.readSessionMediaBytes,
    readHostFileBytes: mocks.readHostFileBytes,
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

    expect(mocks.readSessionMediaBytes).toHaveBeenCalledWith('session_test', 'img-1');
    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('blob:kiki-session-media');

    await act(async () => {
      image?.closest('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(
      'blob:kiki-session-media',
    );
  });

  it('opens and downloads a fileId attachment instead of rendering a dead chip', async () => {
    mocks.readSessionMediaBytes.mockResolvedValue({
      bytes: new Uint8Array([4, 5]),
      mime: 'text/plain',
      name: 'notes.txt',
    });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
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
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.readSessionMediaBytes).toHaveBeenCalledWith('session_test', 'file-1');
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.querySelector('[data-attachment-preview]')).not.toBeNull();
    const download = dialog?.querySelector('button:not([aria-label])');
    expect(download).not.toBeNull();
    await act(async () => {
      download?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
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

async function renderReadMedia(block: ToolBlock): Promise<HTMLDivElement> {
  const { root, container } = makeRoot();
  await renderSettled(root, <MediaPreviewProvider sessionId="session_test"><ToolCard block={block} agentId="main" /></MediaPreviewProvider>);
  await act(async () => {
    container.querySelector('[data-tool] > button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  return container;
}

describe('ReadMediaFile tool result preview', () => {
  it('reads the saved image bytes, not the current absolute Windows path', async () => {
    const path = 'C:\\work\\shots\\home.png';
    mocks.readSessionMediaBytes.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mime: 'application/octet-stream' });
    const container = await renderReadMedia(readMediaBlock(path, `blobref:image/png;${'a'.repeat(64)}`));

    expect(mocks.readSessionMediaBytes).toHaveBeenCalledWith('session_test', `blobref:main:${'a'.repeat(64)}`);
    expect(mocks.readHostFileBytes).not.toHaveBeenCalled();
    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('blob:kiki-session-media');
    expect(vi.mocked(URL.createObjectURL).mock.calls.at(-1)?.[0]).toMatchObject({ type: 'image/png', size: 3 });
    await act(async () => {
      image?.closest('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe('blob:kiki-session-media');
  });

  it('keeps the original absolute result path for relative input and preserves inline media', async () => {
    mocks.readSessionMediaBytes.mockResolvedValue({ bytes: new Uint8Array([1]), mime: 'application/octet-stream' });
    const cold = await renderReadMedia(readMediaBlock('/workspace/shot.png', `blobref:image/png;${'b'.repeat(64)}`, 'image', './shot.png'));
    expect(mocks.readSessionMediaBytes).toHaveBeenCalledWith('session_test', `blobref:main:${'b'.repeat(64)}`);
    expect(cold.querySelector('img')?.getAttribute('src')).toBe('blob:kiki-session-media');

    const live = await renderReadMedia(readMediaBlock('/workspace/live.png', 'data:image/png;base64,AAA'));
    expect(live.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAA');
    expect(mocks.readSessionMediaBytes).toHaveBeenCalledTimes(1);
    expect(mocks.readHostFileBytes).not.toHaveBeenCalled();
  });

  it('replays two different crops of the same image without showing the original file', async () => {
    const left = 'a'.repeat(64);
    const right = 'b'.repeat(64);
    const path = '/workspace/original.png';
    const crops = new Map([
      [`blobref:agent-1:${left}`, new Uint8Array([1, 2, 3])],
      [`blobref:agent-1:${right}`, new Uint8Array([4, 5, 6, 7])],
    ]);
    mocks.readSessionMediaBytes.mockImplementation(async (_sessionId: string, fileId: string) => ({
      bytes: crops.get(fileId), mime: 'application/octet-stream',
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
      for (const button of container.querySelectorAll('[data-tool] > button')) {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
      await Promise.resolve();
    });

    expect(mocks.readSessionMediaBytes.mock.calls).toEqual([
      ['session_test', `blobref:agent-1:${left}`],
      ['session_test', `blobref:agent-1:${right}`],
    ]);
    expect([...container.querySelectorAll('img')].map((image) => image.getAttribute('src'))).toEqual([
      'blob:crop-left', 'blob:crop-right',
    ]);
    expect(vi.mocked(URL.createObjectURL).mock.calls.slice(-2).map(([blob]) => (blob as Blob).size)).toEqual([3, 4]);
    expect(mocks.readHostFileBytes).not.toHaveBeenCalled();
  });

  it('plays saved video bytes with the blob reference MIME rather than the generic download MIME', async () => {
    const hash = 'd'.repeat(64);
    mocks.readSessionMediaBytes.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mime: 'application/octet-stream' });
    const container = await renderReadMedia(readMediaBlock('/workspace/crop.mp4', `blobref:video/mp4;${hash}`, 'video'));

    expect(mocks.readSessionMediaBytes).toHaveBeenCalledWith('session_test', `blobref:main:${hash}`);
    expect(container.querySelector('video')?.getAttribute('src')).toBe('blob:kiki-session-media');
    expect(vi.mocked(URL.createObjectURL).mock.calls.at(-1)?.[0]).toMatchObject({ type: 'video/mp4' });
    expect(mocks.readHostFileBytes).not.toHaveBeenCalled();
  });

  it('previews provider-only video URLs from the host path and preserves inline videos', async () => {
    mocks.readHostFileBytes.mockResolvedValue({ bytes: new Uint8Array([0, 1, 2]), mime: 'video/mp4' });
    const cold = await renderReadMedia(readMediaBlock('/workspace/clip.mp4', 'ms://uploaded-id', 'video'));
    expect(mocks.readHostFileBytes).toHaveBeenCalledWith('/workspace/clip.mp4');
    expect(cold.querySelector('video')?.getAttribute('src')).toBe('blob:kiki-session-media');

    const live = await renderReadMedia(readMediaBlock('/workspace/live.mp4', 'data:video/mp4;base64,AAA', 'video'));
    expect(live.querySelector('video')?.getAttribute('src')).toBe('data:video/mp4;base64,AAA');
    expect(mocks.readHostFileBytes).toHaveBeenCalledTimes(1);
  });

  it('shows a file chip rather than a false original-file preview when saved media is missing', async () => {
    mocks.readSessionMediaBytes.mockRejectedValue(new Error('blob not found'));
    const container = await renderReadMedia(readMediaBlock('/workspace/deleted.png', `blobref:image/png;${'c'.repeat(64)}`));

    expect(mocks.readSessionMediaBytes).toHaveBeenCalledWith('session_test', `blobref:main:${'c'.repeat(64)}`);
    expect(mocks.readHostFileBytes).not.toHaveBeenCalled();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('deleted.png');
  });
});
