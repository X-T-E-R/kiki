// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import type { ToolBlock } from '@kiki/session-core/session';
import { MediaPartList, MediaPreviewProvider } from './mediaPreview';
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
  await renderSettled(root, <MediaPreviewProvider sessionId="session_test"><ToolCard block={block} /></MediaPreviewProvider>);
  await act(async () => {
    container.querySelector('[data-tool] > button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  return container;
}

describe('ReadMediaFile tool result preview', () => {
  it('reads an absolute Windows image path when the cold transcript holds a blob reference', async () => {
    const path = 'C:\\work\\shots\\home.png';
    mocks.readHostFileBytes.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' });
    const container = await renderReadMedia(readMediaBlock(path, `blobref:image/png;${'a'.repeat(64)}`));

    expect(mocks.readHostFileBytes).toHaveBeenCalledWith(path);
    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('blob:kiki-session-media');
    await act(async () => {
      image?.closest('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe('blob:kiki-session-media');
  });

  it('uses the normalized absolute result path for relative input and keeps inline media inline', async () => {
    mocks.readHostFileBytes.mockResolvedValue({ bytes: new Uint8Array([1]), mime: 'image/png' });
    const cold = await renderReadMedia(readMediaBlock('/workspace/shot.png', `blobref:image/png;${'b'.repeat(64)}`, 'image', './shot.png'));
    expect(mocks.readHostFileBytes).toHaveBeenCalledWith('/workspace/shot.png');
    expect(cold.querySelector('img')?.getAttribute('src')).toBe('blob:kiki-session-media');

    const live = await renderReadMedia(readMediaBlock('/workspace/live.png', 'data:image/png;base64,AAA'));
    expect(live.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAA');
    expect(mocks.readHostFileBytes).toHaveBeenCalledTimes(1);
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

  it('shows a file chip instead of a broken image when the original file is unavailable', async () => {
    mocks.readHostFileBytes.mockRejectedValue(new Error('file not found'));
    const container = await renderReadMedia(readMediaBlock('/workspace/deleted.png', `blobref:image/png;${'c'.repeat(64)}`));

    expect(mocks.readHostFileBytes).toHaveBeenCalledWith('/workspace/deleted.png');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('deleted.png');
  });
});
