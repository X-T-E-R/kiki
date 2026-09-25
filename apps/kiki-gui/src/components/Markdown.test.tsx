// @vitest-environment jsdom

/**
 * Markdown link context menus (G-1): file links raise preview/copy-path/
 * copy-absolute (plus the desktop opener pair off-browser), external links
 * raise open/copy. The shiki loader is mocked out; the connection is absent,
 * so the tests drive the menus without opening real previews.
 */

import { act, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { Markdown } from './Markdown';
import { FilePathLink, MediaPreviewProvider } from './mediaPreview';
import { MediaPreviewContext, type MediaPreviewApi } from './mediaPreviewContext';

const hostMocks = vi.hoisted(() => ({ revealPath: vi.fn(), openPath: vi.fn(), openUrl: vi.fn(), desktop: false }));
vi.mock('../host', () => ({
  useHost: () => hostMocks.desktop
    ? { kind: 'tauri', revealPath: hostMocks.revealPath, openPath: hostMocks.openPath, openUrl: hostMocks.openUrl }
    : { kind: 'browser' },
}));

vi.mock('./markdown/streamdown-plugins', async (importOriginal) => {
  const original = await importOriginal<typeof import('./markdown/streamdown-plugins')>();
  return { ...original, useStreamdownPlugins: () => ({}) };
});

vi.mock('../state/connection', async (importOriginal) => {
  const original = await importOriginal<typeof import('../state/connection')>();
  return { ...original, useOptionalConnection: () => null };
});

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
const writeText = vi.fn(async () => {});

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
  });
}

async function rightClick(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  });
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

beforeEach(() => {
  hostMocks.desktop = false;
  hostMocks.openPath.mockReset();
  hostMocks.openUrl.mockReset();
  hostMocks.revealPath.mockReset();
  writeText.mockClear();
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => { root.unmount(); });
  }
  for (const container of containers.splice(0)) container.remove();
  document.body.innerHTML = '';
});

describe('Markdown link menus', () => {
  it.each([
    ['taskService.ts:1063:7', 'C:/work/taskService.ts', 1063, 7],
    ['/C:/work/中%20a.ts:12', 'C:/work/中 a.ts', 12, undefined],
    ['file:///C:/work/taskService.ts#L3', 'C:/work/taskService.ts', 3, undefined],
    ['/C:/work/dir', 'C:/work/dir', undefined, undefined],
  ])('keeps citation position out of native actions for %s', async (href, path, line, column) => {
    hostMocks.desktop = true;
    const openFile = vi.fn();
    const api: MediaPreviewApi = {
      cwd: 'C:/work', sessionId: undefined, openFile,
      openImage: vi.fn(), openAttachment: vi.fn(), previewTabCount: 0,
      previewPanelOpen: false, togglePreviewPanel: vi.fn(), openAgentPanel: vi.fn(),
      openBuiltinSkill: vi.fn(), activeAgentPanelId: undefined,
    };
    const probe = makeRoot();
    await renderSettled(probe.root,
      <MediaPreviewContext.Provider value={api}>
        <Markdown text={`[source](${href})`} />
      </MediaPreviewContext.Provider>,
    );
    const link = probe.container.querySelector('a')!;
    expect(link).not.toBeNull();
    await act(async () => { link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    expect(openFile).toHaveBeenLastCalledWith(expect.objectContaining({ path }));
    expect(openFile.mock.lastCall?.[0].line).toBe(line);
    expect(openFile.mock.lastCall?.[0].column).toBe(column);
    for (const [key, action] of [['show-in-folder', hostMocks.revealPath], ['open-default-app', hostMocks.openPath]] as const) {
      await rightClick(link);
      await act(async () => {
        document.querySelector(`[data-menu-item="${key}"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(action).toHaveBeenLastCalledWith(path);
    }
  });

  it.each([
    ['/C:/work/a%20b.ts', 'C:/work/a%20b.ts'],
    ['C:/work/a b.ts', 'C:/work/a b.ts'],
    ['/work/a.ts:12', '/work/a.ts:12'],
  ])('preserves raw FilePathLink target %s in preview and native actions', async (input, path) => {
    hostMocks.desktop = true;
    const probe = makeRoot();
    await renderSettled(probe.root,
      <MediaPreviewProvider cwd="C:/work"><FilePathLink path={input} /></MediaPreviewProvider>,
    );
    const link = probe.container.querySelector('[role="link"]')!;
    for (const [key, action] of [['show-in-folder', hostMocks.revealPath], ['open-default-app', hostMocks.openPath]] as const) {
      await rightClick(link);
      await act(async () => { document.querySelector(`[data-menu-item="${key}"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(action).toHaveBeenLastCalledWith(path);
    }
    await act(async () => { link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(document.querySelector('[data-preview-tab]')?.getAttribute('data-preview-tab')).toBe(path);
  });
  it('file links raise the file menu and copy both path forms', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work/app">
        <Markdown text={'See [the config](./config/app.toml) for details.'} />
      </MediaPreviewProvider>,
    );
    const link = probe.container.querySelector('a')!;
    await rightClick(link);
    const menu = document.body.querySelector('[data-file-link-menu]')!;
    expect(menu).not.toBeNull();
    expect(menu.querySelector('[data-menu-item="open-preview"]')?.textContent).toBe('Open preview');
    expect(menu.querySelector('[data-menu-item="copy-path"]')).not.toBeNull();
    expect(menu.querySelector('[data-menu-item="copy-absolute"]')).not.toBeNull();
    // Browser runtime: the desktop opener pair stays out.
    expect(menu.querySelector('[data-menu-item="show-in-folder"]')).toBeNull();
    expect(menu.querySelector('[data-menu-item="open-default-app"]')).toBeNull();

    await act(async () => {
      menu
        .querySelector<HTMLButtonElement>('[data-menu-item="copy-path"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(writeText).toHaveBeenCalledWith('./config/app.toml');
    expect(document.body.querySelector('[data-file-link-menu]')).toBeNull();

    await rightClick(link);
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-menu-item="copy-absolute"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(writeText).toHaveBeenCalledWith('/work/app/config/app.toml');
  });

  it('external links raise open/copy and copy writes the URL', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work/app">
        <Markdown text={'[Docs](https://example.test/docs)'} />
      </MediaPreviewProvider>,
    );
    const link = probe.container.querySelector('a')!;
    await rightClick(link);
    const menu = document.body.querySelector('[data-link-menu]')!;
    expect(menu.querySelector('[data-menu-item="open-link"]')?.textContent).toBe('Open link');
    await act(async () => {
      menu
        .querySelector<HTMLButtonElement>('[data-menu-item="copy-link"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(writeText).toHaveBeenCalledWith('https://example.test/docs');
  });

  it('uses the native host opener for external clicks and context-menu opens', async () => {
    hostMocks.desktop = true;
    hostMocks.openUrl.mockResolvedValue(undefined);
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work/app">
        <Markdown text={'[Docs](https://example.test/docs)'} />
      </MediaPreviewProvider>,
    );
    const link = probe.container.querySelector<HTMLAnchorElement>('a')!;
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { link.dispatchEvent(clickEvent); });
    expect(clickEvent.defaultPrevented).toBe(true);
    expect(hostMocks.openUrl).toHaveBeenCalledExactlyOnceWith('https://example.test/docs');

    await rightClick(link);
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-menu-item="open-link"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(hostMocks.openUrl).toHaveBeenCalledTimes(2);
  });

  it('Escape closes the menu', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work/app">
        <Markdown text={'[Docs](https://example.test/docs)'} />
      </MediaPreviewProvider>,
    );
    await rightClick(probe.container.querySelector('a')!);
    expect(document.body.querySelector('[data-link-menu]')).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(document.body.querySelector('[data-link-menu]')).toBeNull();
  });
});

describe('Markdown annotation marks', () => {
  const annotation = {
    id: 'ta-marked',
    quote: 'marked words',
    comment: 'Keep this visible',
  };

  it('marks an annotation in the plain-prose fast path', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <Markdown text="Before marked words after" annotationTargets={[annotation]} />,
    );

    const mark = probe.container.querySelector<HTMLElement>('[data-annotation-ref="ta-marked"]');
    expect(mark?.textContent).toBe('marked words');
    expect(mark?.getAttribute('role')).toBe('button');
    expect(mark?.tabIndex).toBe(0);
  });

  it('keeps one keyboard target when markdown formatting splits a marked passage', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <Markdown text="Before **marked** words after" annotationTargets={[annotation]} />,
    );

    const marks = [...probe.container.querySelectorAll<HTMLElement>('[data-annotation-ref="ta-marked"]')];
    expect(marks.map((mark) => mark.textContent).join('')).toBe('marked words');
    expect(probe.container.querySelector('mark[data-annotation-ref="ta-marked"]')?.contains(
      probe.container.querySelector('span[data-annotation-ref="ta-marked"]'),
    )).toBe(false);
    expect(marks.filter((mark) => mark.tabIndex === 0)).toHaveLength(1);
    expect(probe.container.querySelector('[data-streamdown="strong"]')?.textContent).toBe('marked');
  });
});
