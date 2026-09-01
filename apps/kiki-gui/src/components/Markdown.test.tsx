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
import { MediaPreviewProvider } from './mediaPreview';

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
    expect(menu.querySelector('[data-menu-item="open-in-editor"]')).toBeNull();

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
