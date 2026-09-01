// @vitest-environment jsdom

/**
 * PreviewWorkspace component tests — tab strip semantics, markdown rendered/
 * source toggle, dirty tracking with close confirmation, manual save through
 * the injected write channel, and the external-change conflict banner. The
 * CodeMirror wrapper is stubbed with a textarea (highlighting is irrelevant
 * here and CM6 measure passes are slow under jsdom); the write channel and
 * the connection's client are mocked module-level.
 */

import { act, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { clearStoredDrafts, readDraft, resetDraftMemoryForTests } from '../lib/drafts';
import { MediaPreviewProvider, useMediaPreview } from './mediaPreview';
import { relativeToCwd } from './PreviewWorkspace';

const FILES: Record<string, string> = {
  '/work/src/server.ts': "import { boot } from './boot';\nboot(5801);\n",
  '/work/docs/design.md': '# Design\n\nSome **notes**.\n',
};

const writeMock = vi.fn(async (path: string, text: string) => {
  FILES[path] = text;
});

vi.mock('../state/connection', async (importOriginal) => {
  const original = await importOriginal<typeof import('../state/connection')>();
  // STABLE identity: TextTabView's controller effect keys on `client` — a
  // per-call fresh object would recreate the controller every render (and
  // leak listeners until the worker OOMs).
  const fakeClient = {
    readHostFile: (path: string) =>
      path in FILES ? Promise.resolve(FILES[path]) : Promise.reject(new Error('not found')),
    readHostFileBytes: () => Promise.reject(new Error('not found')),
  };
  return {
    ...original,
    useOptionalConnection: () => ({ client: fakeClient }),
  };
});

vi.mock('../lib/hostFileWrite', () => ({
  hostFileWriteSupported: () => true,
  writeHostFileText: (path: string, text: string) => writeMock(path, text),
}));

vi.mock('../lib/desktop', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/desktop')>();
  return { ...original, isDesktopRuntime: () => false };
});

vi.mock('./CodeEditor', () => ({
  CodeEditor: ({
    value,
    readOnly,
    onChange,
  }: {
    value: string;
    readOnly: boolean;
    onChange: (text: string) => void;
  }) => (
    <textarea
      data-testid="editor"
      value={value}
      readOnly={readOnly}
      onChange={(event) => { onChange(event.target.value); }}
    />
  ),
}));

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

function makeRoot(): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  return { root, container };
}

/** Probe button opening a file through the preview context, like FilePathLink. */
function OpenButton({ path }: { path: string }) {
  const preview = useMediaPreview();
  return (
    <button type="button" data-open-file={path} onClick={() => preview?.openFile(path)}>
      open
    </button>
  );
}

async function renderSettled(root: Root, node: ReactNode): Promise<void> {
  await act(async () => {
    flushSync(() => {
      root.render(<I18nProvider>{node}</I18nProvider>);
    });
  });
}

async function openFile(container: HTMLElement, path: string): Promise<void> {
  await act(async () => {
    container
      .querySelector(`[data-open-file="${path}"]`)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function workspace(): HTMLElement {
  const element = document.querySelector('[data-preview-workspace]');
  expect(element).not.toBeNull();
  return element as HTMLElement;
}

function tabs(): string[] {
  return [...document.querySelectorAll('[data-preview-tab]')].map(
    (tab) => (tab as HTMLElement).dataset['previewTab'] ?? '',
  );
}

describe('PreviewWorkspace', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    FILES['/work/src/server.ts'] = "import { boot } from './boot';\nboot(5801);\n";
    FILES['/work/docs/design.md'] = '# Design\n\nSome **notes**.\n';
    writeMock.mockClear();
  });
  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => { root.unmount(); });
    }
    for (const container of containers.splice(0)) container.remove();
    document.body.innerHTML = '';
  });

  it('opens files as tabs and activates the newest one', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work">
        <OpenButton path="/work/src/server.ts" />
        <OpenButton path="/work/docs/design.md" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/src/server.ts');
    expect(tabs()).toEqual(['/work/src/server.ts']);
    await openFile(probe.container, '/work/docs/design.md');
    expect(tabs()).toEqual(['/work/src/server.ts', '/work/docs/design.md']);
    const active = workspace().querySelector('[role="tab"][aria-selected="true"]');
    expect(active?.textContent).toContain('design.md');
    // Markdown defaults to the rendered view.
    const panel = workspace().querySelector('[data-preview-tabpanel="/work/docs/design.md"]');
    expect(panel?.querySelector('h1')?.textContent).toBe('Design');
  });

  it('markdown source toggle shows the editor', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work">
        <OpenButton path="/work/docs/design.md" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/docs/design.md');
    await act(async () => {
      workspace()
        .querySelector('[data-md-mode="source"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const editor = workspace().querySelector('[data-testid="editor"]') as HTMLTextAreaElement;
    expect(editor.value).toContain('# Design');
  });

  it('edits mark the tab dirty; the save button writes and clears the dot', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work">
        <OpenButton path="/work/src/server.ts" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/src/server.ts');
    const editor = workspace().querySelector('[data-testid="editor"]') as HTMLTextAreaElement;
    expect(editor.readOnly).toBe(false);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(editor, 'edited content');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(workspace().querySelector('[data-preview-tab]')?.textContent).toContain('server.ts');
    expect(workspace().querySelector('[aria-label="Unsaved changes"]')).not.toBeNull();
    await act(async () => {
      workspace()
        .querySelector('[data-save-button]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(writeMock).toHaveBeenCalledWith('/work/src/server.ts', 'edited content');
    expect(workspace().querySelector('[aria-label="Unsaved changes"]')).toBeNull();
  });

  it('closing a dirty tab asks before discarding', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work">
        <OpenButton path="/work/src/server.ts" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/src/server.ts');
    const editor = workspace().querySelector('[data-testid="editor"]') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(editor, 'unsaved');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const closeButton = workspace().querySelector('[data-preview-tab] button')!;
    await act(async () => {
      closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Confirm dialog names the file; the tab survives cancel.
    expect(document.body.textContent).toContain('Discard unsaved changes?');
    expect(document.body.textContent).toContain('server.ts');
    const dialog = document.body.querySelector('[role="alertdialog"]')!;
    const cancel = [...dialog.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cancel',
    )!;
    await act(async () => {
      cancel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(tabs()).toEqual(['/work/src/server.ts']);
    // Confirming discards the buffer and closes the tab.
    await act(async () => {
      closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const confirm = [...document.body.querySelectorAll('[role="alertdialog"] button')].find(
      (button) => button.textContent === 'Discard',
    )!;
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(tabs()).toEqual([]);
  });

  it('context menu closes other tabs', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work">
        <OpenButton path="/work/src/server.ts" />
        <OpenButton path="/work/docs/design.md" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/src/server.ts');
    await openFile(probe.container, '/work/docs/design.md');
    const serverTab = workspace().querySelector('[data-preview-tab="/work/src/server.ts"]')!;
    await act(async () => {
      serverTab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    const menu = document.querySelector('[data-preview-tab-menu]')!;
    const closeOthers = [...menu.querySelectorAll('button')].find(
      (button) => button.textContent === 'Close other tabs',
    )!;
    await act(async () => {
      closeOthers.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(tabs()).toEqual(['/work/src/server.ts']);
  });

  it('an on-disk change during save parks on the conflict banner; overwrite writes', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work">
        <OpenButton path="/work/src/server.ts" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/src/server.ts');
    const editor = workspace().querySelector('[data-testid="editor"]') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(editor, 'my edit');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // External process touches the file between load and save.
    FILES['/work/src/server.ts'] = 'external change';
    await act(async () => {
      workspace()
        .querySelector('[data-save-button]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(writeMock).not.toHaveBeenCalled();
    expect(workspace().querySelector('[data-conflict-banner]')).not.toBeNull();
    await act(async () => {
      workspace()
        .querySelector('[data-conflict-overwrite]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(writeMock).toHaveBeenCalledWith('/work/src/server.ts', 'my edit');
    expect(workspace().querySelector('[data-conflict-banner]')).toBeNull();
  });
});

describe('PreviewWorkspace file ops & 加入对话', () => {
  const writeText = vi.fn(async () => {});

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    writeText.mockClear();
    resetDraftMemoryForTests();
    // Drafts persist to localStorage; without clearing it the next readDraft
    // would rehydrate an earlier test's leftovers.
    clearStoredDrafts();
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

  it('copies the workspace-relative path from the tab menu', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work">
        <OpenButton path="/work/src/server.ts" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/src/server.ts');
    const tab = workspace().querySelector('[data-preview-tab="/work/src/server.ts"]')!;
    await act(async () => {
      tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    const menu = document.querySelector('[data-preview-tab-menu]')!;
    expect(menu.querySelector('[data-menu-item="copy-relative"]')?.textContent).toBe(
      'Copy relative path',
    );
    expect(menu.querySelector('[data-menu-item="copy-absolute"]')).not.toBeNull();
    // Browser runtime: no desktop opener entries.
    expect(menu.querySelector('[data-menu-item="show-in-folder"]')).toBeNull();
    expect(menu.querySelector('[data-menu-item="open-default-app"]')).toBeNull();
    await act(async () => {
      menu
        .querySelector<HTMLButtonElement>('[data-menu-item="copy-relative"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(writeText).toHaveBeenCalledWith('src/server.ts');
  });

  it('the @ button appends @<relative path> to the session draft', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work" sessionId="s1">
        <OpenButton path="/work/docs/design.md" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/docs/design.md');
    const mention = workspace().querySelector('[data-mention-file="/work/docs/design.md"]')!;
    expect(mention.textContent).toBe('@');
    await act(async () => {
      mention.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(readDraft('s1')).toBe('@docs/design.md');
    // Mentioning again appends with a separator, and the tab stays open.
    await act(async () => {
      mention.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(readDraft('s1')).toBe('@docs/design.md @docs/design.md');
    expect(tabs()).toEqual(['/work/docs/design.md']);
  });

  it('the @ button quotes paths containing whitespace (posix cwd)', async () => {
    FILES['/work/docs/design spec.md'] = '# Draft\n';
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work" sessionId="s1">
        <OpenButton path="/work/docs/design spec.md" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/docs/design spec.md');
    const mention = workspace().querySelector('[data-mention-file="/work/docs/design spec.md"]')!;
    await act(async () => {
      mention.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(readDraft('s1')).toBe('@"docs/design spec.md"');
  });

  it('the @ button quotes spaced paths under a Windows cwd', async () => {
    FILES['C:\\work\\my dir\\a b.txt'] = 'hi\n';
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="C:\work" sessionId="s1">
        <OpenButton path={'C:\\work\\my dir\\a b.txt'} />
      </MediaPreviewProvider>,
    );
    // The CSS attribute selector cannot express backslashes; click the sole
    // open button / mention button directly instead of a path-keyed lookup.
    await act(async () => {
      probe.container
        .querySelector('button')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const mention = workspace().querySelector('[data-mention-file]')!;
    await act(async () => {
      mention.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(readDraft('s1')).toBe('@"my dir/a b.txt"');
  });

  it('hides the @ button when the workspace has no owning session', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work">
        <OpenButton path="/work/src/server.ts" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/src/server.ts');
    expect(workspace().querySelector('[data-mention-file]')).toBeNull();
  });
});

describe('relativeToCwd', () => {
  it('strips the cwd prefix case-insensitively across path separators', () => {
    expect(relativeToCwd('/work/src/server.ts', '/work')).toBe('src/server.ts');
    expect(relativeToCwd('C:\\repo\\x\\y.md', 'C:/repo')).toBe('x/y.md');
    expect(relativeToCwd('/work', '/work')).toBe('/work');
  });

  it('falls back to the absolute path outside the workspace or without a cwd', () => {
    expect(relativeToCwd('/elsewhere/a.ts', '/work')).toBe('/elsewhere/a.ts');
    expect(relativeToCwd('/work/a.ts', undefined)).toBe('/work/a.ts');
  });
});
