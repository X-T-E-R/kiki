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
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { Markdown } from './Markdown';
import { FilePathLink, MediaPreviewProvider } from './mediaPreview';
import { MediaPreviewContext, type MediaPreviewApi } from './mediaPreviewContext';

const hostMocks = vi.hoisted(() => ({ revealPath: vi.fn(), openPath: vi.fn(), openUrl: vi.fn(), desktop: false }));
const connectionScope = vi.hoisted(() => ({ scopeId: null as string | null }));
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
  return { ...original, useOptionalConnection: () => connectionScope.scopeId === null ? null : { scopeId: connectionScope.scopeId } };
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
  connectionScope.scopeId = null;
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

  it('keeps FilePathLink preview and copy but hides local openers in SSH scope', async () => {
    hostMocks.desktop = true;
    connectionScope.scopeId = 'ssh:remote-1';
    const probe = makeRoot();
    await renderSettled(probe.root,
      <MediaPreviewProvider cwd="/remote"><FilePathLink path="/remote/output.txt" /></MediaPreviewProvider>,
    );
    await rightClick(probe.container.querySelector('[role="link"]')!);
    const menu = document.querySelector('[data-file-link-menu]')!;
    expect(menu.querySelector('[data-menu-item="open-preview"]')).not.toBeNull();
    expect(menu.querySelector('[data-menu-item="copy-path"]')).not.toBeNull();
    expect(menu.querySelector('[data-menu-item="show-in-folder"]')).toBeNull();
    expect(menu.querySelector('[data-menu-item="open-default-app"]')).toBeNull();
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

  it('hides local desktop file openers for a remote SSH scope', async () => {
    hostMocks.desktop = true;
    connectionScope.scopeId = 'ssh:remote-1';
    const probe = makeRoot();
    await renderSettled(probe.root,
      <MediaPreviewProvider cwd="/remote"><Markdown text="[source](./config.toml)" /></MediaPreviewProvider>,
    );
    await rightClick(probe.container.querySelector('a')!);
    const menu = document.body.querySelector('[data-file-link-menu]')!;
    expect(menu.querySelector('[data-menu-item="open-preview"]')).not.toBeNull();
    expect(menu.querySelector('[data-menu-item="copy-absolute"]')).not.toBeNull();
    expect(menu.querySelector('[data-menu-item="show-in-folder"]')).toBeNull();
    expect(menu.querySelector('[data-menu-item="open-default-app"]')).toBeNull();
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

describe('Markdown internal links', () => {
  it.each([
    ['/rooms/release-contract', 'room'],
    ['/s/session_example', 'thread'],
    ['/board', 'board'],
    ['/memory', 'memory'],
    ['/usage', 'usage'],
  ])('marks a link to a real page %s and keeps the author text', async (to, name) => {
    const probe = makeRoot();
    await renderSettled(probe.root, <MemoryRouter><Markdown text={`[see the contract](${to})`} /></MemoryRouter>);
    const link = probe.container.querySelector(`[data-internal-link="${name}"]`)!;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe(to);
    // The writer's own words are the label; only the mark is added.
    expect(link.textContent).toBe('see the contract');
    expect(link.querySelector('svg')).not.toBeNull();
    await act(async () => { probe.root.unmount(); });
  });

  it('leaves an unknown in-app path as a plain router link with no mark', async () => {
    const probe = makeRoot();
    await renderSettled(probe.root, <MemoryRouter><Markdown text={'[custom](/custom/thing)'} /></MemoryRouter>);
    const link = probe.container.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/custom/thing');
    expect(probe.container.querySelector('[data-internal-link]')).toBeNull();
    await act(async () => { probe.root.unmount(); });
  });

  it('keeps an external link external, with its own menu', async () => {
    const probe = makeRoot();
    await renderSettled(probe.root, <MemoryRouter><Markdown text={'[example](https://example.com/rooms/x)'} /></MemoryRouter>);
    const link = probe.container.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://example.com/rooms/x');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(probe.container.querySelector('[data-internal-link]')).toBeNull();
    await act(async () => { probe.root.unmount(); });
  });
});

describe('Markdown autolinks beside CJK punctuation', () => {
  const real = '新版预览已启动：**http://127.0.0.1:63474**，浏览器也已打开。';

  it('keeps the URL a real link and gives the swallowed sentence back', async () => {
    const probe = makeRoot();
    await renderSettled(probe.root, <MemoryRouter><Markdown text={real} /></MemoryRouter>);
    const link = probe.container.querySelector('a')!;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe('http://127.0.0.1:63474/');
    expect(link.textContent).toBe('http://127.0.0.1:63474');
    // The tail the autolink swallowed is readable prose again, and the block
    // marker is gone.
    expect(probe.container.textContent).toContain('浏览器也已打开。');
    expect(probe.container.textContent).not.toContain('[blocked]');
    // The emphasis the writer put around the URL is emphasis again, not raw
    // `**` beside it.
    expect(probe.container.textContent).not.toContain('**');
    expect(probe.container.querySelector('[data-streamdown="strong"] a')).not.toBeNull();
    await act(async () => { probe.root.unmount(); });
  });

  it('renders the same way while the text is still streaming', async () => {
    const probe = makeRoot();
    await renderSettled(probe.root, <MemoryRouter><Markdown text={real} mode="streaming" /></MemoryRouter>);
    expect(probe.container.querySelector('a')?.getAttribute('href')).toBe('http://127.0.0.1:63474/');
    expect(probe.container.textContent).not.toContain('[blocked]');
    await act(async () => { probe.root.unmount(); });
  });

  it.each([
    ['a **http://127.0.0.1:63474** b', 'http://127.0.0.1:63474/'],
    ['see http://127.0.0.1:63474 now', 'http://127.0.0.1:63474/'],
    ['see https://example.com/x now', 'https://example.com/x'],
  ])('leaves an ordinary link alone: %s', async (text, href) => {
    const probe = makeRoot();
    await renderSettled(probe.root, <MemoryRouter><Markdown text={text} /></MemoryRouter>);
    expect(probe.container.querySelector('a')?.getAttribute('href')).toBe(href);
    await act(async () => { probe.root.unmount(); });
  });

  it('leaves an author-written link alone even when its URL is malformed', async () => {
    const probe = makeRoot();
    // `[说明](https://example.com:bad)` is the writer's own link with a bad URL.
    // Re-cutting it would invent a different address AND replace their label.
    await renderSettled(probe.root, <MemoryRouter><Markdown text={'[说明](https://example.com:bad)'} /></MemoryRouter>);
    expect(probe.container.textContent).toContain('说明');
    expect(probe.container.textContent).not.toContain('https://example.com/');
    await act(async () => { probe.root.unmount(); });
  });

  it.each([
    ['inline with a matching label', '[https://example.com:bad](https://example.com:bad)'],
    ['a reference link', '[https://example.com:bad]'],
    ['an autolink in angle brackets', '<https://example.com:bad>'],
  ])('never trims an explicit link: %s', async (_label, text) => {
    const probe = makeRoot();
    // Each of these carries an author's own malformed URL and a label equal to
    // it, which is not evidence that GFM built a bare autolink. Trimming it
    // would silently invent a different address.
    await renderSettled(probe.root, <MemoryRouter><Markdown text={text} /></MemoryRouter>);
    const shown = probe.container.textContent ?? '';
    expect(shown).toContain('https://example.com:bad');
    expect(probe.container.querySelector('a[href="https://example.com/"]')).toBeNull();
    await act(async () => { probe.root.unmount(); });
  });

  it('keeps the label of a valid link whose path is Chinese', async () => {
    const probe = makeRoot();
    await renderSettled(probe.root, <MemoryRouter><Markdown text={'[说明](https://example.com/中文路径)'} /></MemoryRouter>);
    const link = probe.container.querySelector('a')!;
    expect(link.textContent).toBe('说明');
    expect(link.getAttribute('href')).toBe('https://example.com/%E4%B8%AD%E6%96%87%E8%B7%AF%E5%BE%84');
    await act(async () => { probe.root.unmount(); });
  });

  it('still refuses a dangerous scheme', async () => {
    const probe = makeRoot();
    await renderSettled(probe.root, <MemoryRouter><Markdown text={'[click](javascript:alert(1))'} /></MemoryRouter>);
    // The sanitizer is untouched: nothing becomes a live javascript: link.
    const link = probe.container.querySelector('a');
    expect(link?.getAttribute('href') ?? '').not.toContain('javascript:');
    await act(async () => { probe.root.unmount(); });
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


describe('file citation entrances', () => {
  function api(openFile = vi.fn()): MediaPreviewApi {
    return { cwd: 'C:/work', sessionId: undefined, openFile, openImage: vi.fn(), openAttachment: vi.fn(), previewTabCount: 0, previewPanelOpen: false, togglePreviewPanel: vi.fn(), openAgentPanel: vi.fn(), openBuiltinSkill: vi.fn(), activeAgentPanelId: undefined };
  }
  it.each([
    ['See C:\\Example\\analyses\\pending-decisions.md:309', 'C:\\Example\\analyses\\pending-decisions.md', 309, undefined],
    ['See C:/Example/analyses/pending-decisions.md:309', 'C:/Example/analyses/pending-decisions.md', 309, undefined],
    ['See C:\\Example\\.tmp\\_notes.md:309', 'C:\\Example\\.tmp\\_notes.md', 309, undefined],
    ['See `src/example.ts:12:7`', 'C:/work/src/example.ts', 12, 7],
    ['See src/example.ts:12:7', 'C:/work/src/example.ts', 12, 7],
    ['See `C:/Example/a b.md:3`', 'C:/Example/a b.md', 3, undefined],
    ['See `src/a%3A%23.ts:12`', 'C:/work/src/a%3A%23.ts', 12, undefined],
    ['See src/a%20b.ts:12', 'C:/work/src/a%20b.ts', 12, undefined],
  ])('renders and opens %s as a path and position', async (text, path, line, column) => {
    const preview = api();
    const probe = makeRoot();
    await renderSettled(probe.root, <MediaPreviewContext.Provider value={preview}><Markdown text={text} /></MediaPreviewContext.Provider>);
    const link = probe.container.querySelector('a')!;
    expect(link).not.toBeNull();
    await act(async () => { link.click(); });
    expect(preview.openFile).toHaveBeenLastCalledWith(expect.objectContaining({ path, line, column }));
  });
  it('does not linkify commands, fenced code, app routes or external URLs', async () => {
    const preview = api();
    const probe = makeRoot();
    await renderSettled(probe.root, <MemoryRouter><MediaPreviewContext.Provider value={preview}><Markdown text={'`cat src/example.ts`\n\n`./script.sh argument`\n\n```sh\ncat src/example.ts:12\n```\n\n[settings](/settings/models) [external](https://example.test/file.md#L12)'} /></MediaPreviewContext.Provider></MemoryRouter>);
    const links = probe.container.querySelectorAll('a');
    expect(links).toHaveLength(2);
    expect([...links].some((link) => link.href.includes('__kiki-'))).toBe(false);
  });
  it('opens document-local and cross-file heading references relative to the document', async () => {
    const preview = api();
    const probe = makeRoot();
    await renderSettled(probe.root, <MediaPreviewContext.Provider value={preview}><Markdown mode="static" documentDirectory="C:/other/docs" documentPath="C:/other/docs/current%23.md" text={'[here](#%E4%B8%AD%E6%96%87) [other](./a%20b.md#hello-world) [range](a.md#L3-L7)'} /></MediaPreviewContext.Provider>);
    const links = probe.container.querySelectorAll('a');
    expect(links).toHaveLength(3);
    await act(async () => { links[0]!.click(); });
    expect(preview.openFile).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'C:/other/docs/current%23.md', heading: '中文' }));
    await act(async () => { links[1]!.click(); });
    expect(preview.openFile).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'C:/other/docs/a b.md', heading: 'hello-world' }));
    await act(async () => { links[2]!.click(); });
    expect(preview.openFile).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'C:/other/docs/a.md', line: 3, endLine: 7 }));
  });
  it('indexes actual rendered headings with stable duplicate slugs and locates each new request', async () => {
    const probe = makeRoot();
    const result = vi.fn();
    const scroll = vi.fn();
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { callback(0); return 0; });
    try {
      const render = async (heading: string) => renderSettled(probe.root, <Markdown mode="static" text={'# Hello **World**!\n\n## 中文\n\n## 中文\n\n## 中文-1'} documentPath="C:/work/example.md" headingNavigation={{ path: 'C:/work/example.md', heading }} onHeadingResult={result} />);
      await render('中文-1');
      expect([...probe.container.querySelectorAll<HTMLElement>('[data-markdown-heading]')].map((element) => element.dataset['markdownHeading'])).toEqual(['hello-world', '中文', '中文-1', '中文-1-1']);
      expect(result).toHaveBeenLastCalledWith(true);
      expect(scroll.mock.instances.at(-1)).toBe(probe.container.querySelectorAll('h2')[1]);
      await render('hello-world');
      expect(scroll.mock.instances.at(-1)).toBe(probe.container.querySelector('h1'));
      await render('missing');
      expect(result).toHaveBeenLastCalledWith(false);
    } finally { raf.mockRestore(); HTMLElement.prototype.scrollIntoView = originalScroll; }
  });
});
