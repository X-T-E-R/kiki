// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { MediaPartList, MediaPreviewProvider } from './mediaPreview';

const mocks = vi.hoisted(() => ({
  readSessionMediaBytes: vi.fn(),
}));

vi.mock('../state/connection', async (importOriginal) => {
  const original = await importOriginal<typeof import('../state/connection')>();
  const client = { readSessionMediaBytes: mocks.readSessionMediaBytes };
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

  it('downloads a fileId attachment instead of rendering a dead chip', async () => {
    mocks.readSessionMediaBytes.mockResolvedValue({
      bytes: new Uint8Array([4, 5]),
      mime: 'text/plain',
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
    });

    expect(mocks.readSessionMediaBytes).toHaveBeenCalledWith('session_test', 'file-1');
    expect(clickSpy).toHaveBeenCalledOnce();
  });
});
