// @vitest-environment jsdom

/**
 * PreviewWorkspace component tests — tab strip semantics, markdown rendered/
 * source toggle, dirty tracking with close confirmation, manual save through
 * the injected write channel, and the external-change conflict banner. The
 * CodeMirror wrapper is stubbed with a textarea (highlighting is irrelevant
 * here and CM6 measure passes are slow under jsdom); the write channel and
 * the connection's client are mocked module-level.
 */

import { act, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes, useLocation, useNavigationType } from 'react-router-dom';
import { clearNavHistory, getCurrentVisit, recordNavigation } from '../lib/navHistory';
import { getReadingSnapshot, previewSnapshotKey, type PreviewReadingSnapshot } from '../lib/navViewState';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { HTML_PREVIEW_SANDBOX } from '@kiki/protocol';
import { clearStoredDrafts, readDraft, resetDraftMemoryForTests } from '@kiki/session-core/composer';
import {
  createViewState,
  type AgentForest,
  type SessionController,
} from '@kiki/session-core/session';
import { I18nProvider } from '../i18n';
import { MediaPartList, MediaPreviewProvider, PreviewToggleButton, useMediaPreview } from './mediaPreview';
import { ToolCard } from './ToolCard';
import { Markdown } from './Markdown';
import { PreviewWorkspace, isHtmlPreviewPath, relativeToCwd } from './PreviewWorkspace';
import { ConversationShell, useRegisterSeat } from './ConversationShell';
import { useRailMode } from './rail-variants/shell';

const FILES: Record<string, string> = {
  '/work/src/server.ts': "import { boot } from './boot';\nboot(5801);\n",
  '/work/docs/design.md': '# Design\n\nSome **notes**.\n',
};

const writeMock = vi.fn(async (path: string, text: string) => {
  FILES[path] = text;
});
const connectionMock = vi.hoisted(() => ({
  activeClient: null as unknown, defaultClient: null as unknown, scopeId: 'local',
}));
const hostMock = vi.hoisted(() => ({ desktop: false, revealPath: vi.fn(), openPath: vi.fn(), pickDirectory: vi.fn() }));
const htmlPreviewMock = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }));

vi.mock('../state/connection', async (importOriginal) => {
  const original = await importOriginal<typeof import('../state/connection')>();
  // STABLE identity: TextTabView's controller effect keys on `client` — a
  // per-call fresh object would recreate the controller every render (and
  // leak listeners until the worker OOMs).
  const fakeClient = {
    readHostFile: (path: string) =>
      path in FILES ? Promise.resolve(FILES[path]) : Promise.reject(new Error('not found')),
    previewHostFile: (path: string) =>
      path === '/work/docs/long.md' ? Promise.resolve({ text: '# Beginning\n', truncated: true })
        : path in FILES ? Promise.resolve({ text: FILES[path], truncated: false }) : Promise.reject(new Error('not found')),
    readHostFileBytes: (path: string) => {
      const file = {
        '/work/shots/screen.png': { bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png' },
        '/work/clips/intro.mp4': { bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), mime: 'video/mp4' },
        '/work/bundles/release.zip': { bytes: new Uint8Array([80, 75, 3, 4]), mime: 'application/zip' },
      }[path];
      return file === undefined ? Promise.reject(new Error('not found')) : Promise.resolve(file);
    },
    baseUrl: 'http://127.0.0.1:5177',
    openHtmlPreview: htmlPreviewMock.open,
    closeHtmlPreview: htmlPreviewMock.close,
  };
  connectionMock.activeClient = fakeClient;
  connectionMock.defaultClient = fakeClient;
  return {
    ...original,
    useOptionalConnection: () => ({ client: connectionMock.activeClient, scopeId: connectionMock.scopeId }),
  };
});

vi.mock('../host', () => {
  const host = {
    kind: 'browser',
    writeFileText: (path: string, text: string) => writeMock(path, text),
  };
  const desktopHost = { ...host, kind: 'tauri', revealPath: hostMock.revealPath, openPath: hostMock.openPath, pickDirectory: hostMock.pickDirectory };
  return { useHost: () => hostMock.desktop ? desktopHost : host };
});

vi.mock('./CodeEditor', () => ({
  CodeEditor: ({
    value,
    readOnly,
    navigation,
    onChange,
  }: {
    value: string;
    readOnly: boolean;
    navigation?: { line?: number; column?: number };
    onChange: (text: string) => void;
  }) => (
    <textarea
      data-testid="editor"
      className="cm-scroller"
      data-line={navigation?.line}
      data-column={navigation?.column}
      value={value}
      readOnly={readOnly}
      onChange={(event) => { onChange(event.target.value); }}
    />
  ),
}));

// The embedded workspace is probed, not rendered: the retain/release lease and
// the tab chrome live in PreviewWorkspace itself, and AgentWorkspace has its
// own test file for its internals.
const agentWorkspaceHarness = vi.hoisted(() => ({
  calls: [] as Array<{
    agentId: string;
    inheritMediaPreview: unknown;
    showPreviewToggle: unknown;
    railIsOverlay: unknown;
    railOpen: unknown;
    showRailToggle: unknown;
    onToggleRail: unknown;
    transcriptVisible: unknown;
    slotsProvided: boolean;
  }>,
}));

vi.mock('./agent-workspace/AgentWorkspace', () => ({
  AgentWorkspace: (props: {
    target: { sessionId: string; agentId: string };
    inheritMediaPreview?: unknown;
    showPreviewToggle?: unknown;
    railIsOverlay?: unknown;
    railOpen?: unknown;
    showRailToggle?: unknown;
    onToggleRail?: unknown;
    transcriptVisible?: unknown;
    slots?: unknown;
  }) => {
    agentWorkspaceHarness.calls.push({
      agentId: props.target.agentId,
      inheritMediaPreview: props.inheritMediaPreview,
      showPreviewToggle: props.showPreviewToggle,
      railIsOverlay: props.railIsOverlay,
      railOpen: props.railOpen,
      showRailToggle: props.showRailToggle,
      onToggleRail: props.onToggleRail,
      transcriptVisible: props.transcriptVisible,
      slotsProvided: props.slots !== undefined,
    });
    return <div data-agent-workspace={props.target.agentId} />;
  },
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
function OpenButton({ path, reference }: { path: string; reference?: { path: string; line?: number; column?: number } }) {
  const preview = useMediaPreview();
  return (
    <button type="button" data-open-file={path} onClick={() => preview?.openFile(reference ?? path)}>
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

function CockpitPreviewHarness() {
  const [mode, choose] = useRailMode();
  const [railOpen, setRailOpen] = useState(true);
  const seat = useMemo(() => ({ phase: 'active' as const, composer: <textarea data-test-composer />, cockpit: railOpen && mode === 'cockpit' }), [railOpen, mode]);
  useRegisterSeat(seat);
  return <MediaPreviewProvider cwd="/work">
    <div data-test-timeline />
    <button data-cockpit-on onClick={() => { choose('cockpit'); }}>cockpit</button>
    <button data-cockpit-off onClick={() => { choose('default'); }}>standard</button>
    <button data-close-rail onClick={() => { setRailOpen(false); }}>close rail</button>
    <button data-open-rail onClick={() => { setRailOpen(true); }}>open rail</button>
    <PreviewToggleButton />
    <OpenButton path="/work/src/server.ts" reference={{ path: '/work/src/server.ts', line: 2, column: 3 }} />
    <OpenButton path="/work/docs/design.md" />
  </MediaPreviewProvider>;
}

async function mountCockpitPreview() {
  localStorage.setItem('kiki.railMode', 'default');
  localStorage.setItem('kiki.previewPanelWidth', '460');
  const probe = makeRoot();
  await renderSettled(probe.root, <MemoryRouter><Routes>
    <Route element={<ConversationShell />}><Route index element={<CockpitPreviewHarness />} /></Route>
  </Routes></MemoryRouter>);
  return probe;
}
async function pressPreviewControl(selector: string) {
  await act(async () => { document.querySelector<HTMLButtonElement>(selector)!.click(); });
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
    connectionMock.activeClient = connectionMock.defaultClient;
    connectionMock.scopeId = 'local';
    hostMock.desktop = false;
    hostMock.revealPath.mockClear();
    hostMock.openPath.mockClear();
    writeMock.mockClear();
  });
  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => { root.unmount(); });
    }
    for (const container of containers.splice(0)) container.remove();
    document.body.innerHTML = '';
    localStorage.removeItem('kiki.railMode');
    localStorage.removeItem('kiki.previewPanelWidth');
  });

  it('N2 consumer restores delayed editor readiness beyond the old frame window, without chasing scroll reports', async () => {
    const probe = makeRoot();
    let resolve!: (value: { text: string; truncated: boolean }) => void;
    const delayed = new Promise<{ text: string; truncated: boolean }>((done) => { resolve = done; });
    connectionMock.activeClient = { previewHostFile: () => delayed };
    let frames = 0;
    let frameId = 0;
    const queued = new Map<number, FrameRequestCallback>();
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { queued.set(++frameId, callback); return frameId; });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { queued.delete(id); });
    const advanceFrame = async () => { await act(async () => {
      const batch = [...queued]; queued.clear();
      for (const [, callback] of batch) { frames += 1; callback(frames * 16); }
    }); };
    const report = vi.fn();
    const props = { tabs: ['/work/src/server.ts'], active: '/work/src/server.ts', dirtyPaths: new Set<string>(), width: 400,
      onActivate: vi.fn(), onClose: vi.fn(), onCloseOthers: vi.fn(), onCloseAll: vi.fn(), onMove: vi.fn(), onCollapse: vi.fn(),
      onWidthChange: vi.fn(), onOpenImage: vi.fn(), reportDirty: vi.fn(), onScrollPosition: report };
    try {
      await renderSettled(probe.root, <PreviewWorkspace {...props} scrollPositions={{ '/work/src/server.ts': { top: 187, left: 23 } }} />);
      for (let frame = 0; frame < 35; frame += 1) await advanceFrame();
      expect(probe.container.querySelector('.cm-scroller')).toBeNull();
      await act(async () => { resolve({ text: 'loaded after the old attach window', truncated: false }); });
      await advanceFrame();
      const scroller = probe.container.querySelector<HTMLElement>('.cm-scroller')!;
      expect(scroller.scrollTop).toBe(187);
      expect(scroller.scrollLeft).toBe(23);
      await act(async () => { scroller.scrollTop = 241; scroller.dispatchEvent(new Event('scroll')); });
      expect(report).toHaveBeenLastCalledWith('/work/src/server.ts', { top: 241, left: 23 });
      await renderSettled(probe.root, <PreviewWorkspace {...props} scrollPositions={{ '/work/src/server.ts': { top: 187, left: 23 } }} />);
      expect(scroller.scrollTop).toBe(241);
      expect(frames).toBeLessThan(30);
    } finally { raf.mockRestore(); cancel.mockRestore(); }
  });

  it('N2 consumer same-provider Back restores editor and markdown positions without remounting the buffer', async () => {
    clearNavHistory();
    const probe = makeRoot();
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => window.setTimeout(() => { callback(0); }, 1));
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { window.clearTimeout(id); });
    function Page() {
      const location = useLocation();
      const action = useNavigationType();
      useLayoutEffect(() => { recordNavigation({ location, scope: { homeId: 'main', scopeId: 'local' }, action }); }, [location, action]);
      return <I18nProvider><MediaPreviewProvider sessionId="example">
        <OpenButton path="/work/src/server.ts" /><OpenButton path="/work/docs/design.md" />
      </MediaPreviewProvider></I18nProvider>;
    }
    const router = createMemoryRouter([{ path: '*', element: <Page /> }], { initialEntries: ['/s/example'] });
    const settle = async () => { await act(async () => { await new Promise((done) => setTimeout(done, 40)); }); };
    try {
      await act(async () => { probe.root.render(<RouterProvider router={router} />); });
      await openFile(probe.container, '/work/docs/design.md');
      await settle();
      const markdown = workspace().querySelector<HTMLElement>('[data-preview-scroll]')!;
      await act(async () => { markdown.scrollTop = 91; markdown.dispatchEvent(new Event('scroll')); });
      await openFile(probe.container, '/work/src/server.ts');
      await settle();
      const editor = workspace().querySelector<HTMLElement>('.cm-scroller')!;
      await act(async () => { editor.scrollTop = 187; editor.scrollLeft = 23; editor.dispatchEvent(new Event('scroll')); });
      await act(async () => { await router.navigate('/s/example'); });
      await settle();
      await act(async () => { editor.scrollTop = 481; editor.dispatchEvent(new Event('scroll')); });
      await openFile(probe.container, '/work/docs/design.md');
      await settle();
      await act(async () => { markdown.scrollTop = 321; markdown.dispatchEvent(new Event('scroll')); });
      const forwardVisit = getCurrentVisit()!.visitId;
      await act(async () => { await router.navigate(-1); });
      await settle();
      expect(getReadingSnapshot<PreviewReadingSnapshot>(forwardVisit, previewSnapshotKey('example'))?.positions['/work/docs/design.md']?.top).toBe(321);
      expect(workspace().querySelector('.cm-scroller')).toBe(editor);
      expect(editor.scrollTop).toBe(187);
      expect(editor.scrollLeft).toBe(23);
      await openFile(probe.container, '/work/docs/design.md');
      await settle();
      expect(markdown.scrollTop).toBe(91);
      await act(async () => { await router.navigate(1); });
      await settle();
      expect(getCurrentVisit()!.visitId).toBe(forwardVisit);
      expect(getReadingSnapshot<PreviewReadingSnapshot>(forwardVisit, previewSnapshotKey('example'))?.positions['/work/docs/design.md']?.top).toBe(321);
      expect(markdown.scrollTop).toBe(321);
    } finally { raf.mockRestore(); cancel.mockRestore(); clearNavHistory(); }
  });

  it.each(['image', 'skill'] as const)('N2 consumer restores and reports %s reading scroll without adding zoom state', async (kind) => {
    const probe = makeRoot();
    connectionMock.activeClient = { ...connectionMock.defaultClient as object, readBuiltinSkill: async () => '# Example skill\n\nReading text.' };
    const objectUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:reading-image');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => window.setTimeout(() => { callback(0); }, 1));
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { window.clearTimeout(id); });
    const report = vi.fn();
    const key = kind === 'image' ? '/work/shots/screen.png' : 'skill:builtin:example';
    const tab = kind === 'image' ? key : { kind: 'skill' as const, name: 'example' };
    try {
      await renderSettled(probe.root, <PreviewWorkspace tabs={[tab]} active={key} dirtyPaths={new Set()} width={400}
        onActivate={vi.fn()} onClose={vi.fn()} onCloseOthers={vi.fn()} onCloseAll={vi.fn()} onMove={vi.fn()}
        onCollapse={vi.fn()} onWidthChange={vi.fn()} onOpenImage={vi.fn()} reportDirty={vi.fn()}
        scrollPositions={{ [key]: { top: 73, left: 12 } }} onScrollPosition={report} />);
      if (kind === 'image') {
        const image = probe.container.querySelector<HTMLImageElement>('[data-image-viewport] img')!;
        Object.defineProperty(image, 'naturalWidth', { value: 1440 });
        Object.defineProperty(image, 'naturalHeight', { value: 2000 });
        await act(async () => { image.dispatchEvent(new Event('load')); });
      }
      await act(async () => { await new Promise((done) => setTimeout(done, 30)); });
      const scroller = probe.container.querySelector<HTMLElement>(kind === 'image' ? '[data-image-viewport]' : '[data-preview-scroll]')!;
      expect(scroller.scrollTop).toBe(73);
      expect(scroller.scrollLeft).toBe(12);
      await act(async () => { scroller.scrollTop = 129; scroller.dispatchEvent(new Event('scroll')); });
      expect(report).toHaveBeenLastCalledWith(key, { top: 129, left: 12 });
      if (kind === 'image') expect(scroller.dataset['imageViewport']).toBe('fit');
    } finally {
      await act(async () => { probe.root.unmount(); });
      objectUrl.mockRestore(); revoke.mockRestore(); raf.mockRestore(); cancel.mockRestore();
    }
  });

  it('parks the same preview editors for cockpit and restores selection, draft, citation and width', async () => {
    const probe = await mountCockpitPreview();
    await openFile(probe.container, '/work/docs/design.md');
    await openFile(probe.container, '/work/src/server.ts');
    const panel = workspace();
    const editor = panel.querySelector<HTMLTextAreaElement>('[data-preview-tabpanel="/work/src/server.ts"] [data-testid="editor"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, 'draft kept through cockpit');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    editor.scrollTop = 72;
    const composer = document.querySelector('[data-test-composer]');
    const timeline = document.querySelector('[data-test-timeline]');
    const width = panel.style.width;
    for (let repeat = 0; repeat < 3; repeat += 1) {
      await pressPreviewControl('[data-cockpit-on]');
      expect(workspace()).toBe(panel);
      expect(panel.hidden).toBe(true);
      expect(panel.style.display).toBe('none');
      expect(document.querySelector('[data-test-composer]')).toBe(composer);
      expect(document.querySelector('[data-test-timeline]')).toBe(timeline);
      await pressPreviewControl(repeat === 1 ? '[data-close-rail]' : '[data-cockpit-off]');
      expect(panel.hidden).toBe(false);
      expect(panel.style.width).toBe(width);
      expect(panel.querySelector('[data-preview-tabpanel="/work/src/server.ts"] [data-testid="editor"]')).toBe(editor);
      expect(editor.value).toBe('draft kept through cockpit');
      expect(editor.scrollTop).toBe(72);
      expect(editor.dataset['line']).toBe('2');
      expect(editor.dataset['column']).toBe('3');
      expect(panel.querySelector('[data-preview-tab="/work/src/server.ts"]')?.getAttribute('aria-selected')).toBe('true');
      expect(localStorage.getItem('kiki.previewPanelWidth')).toBe('460');
      await pressPreviewControl('[data-cockpit-off]');
      await pressPreviewControl('[data-open-rail]');
    }
  });

  it('restores an absent or collapsed preview as absent or collapsed', async () => {
    const probe = await mountCockpitPreview();
    await pressPreviewControl('[data-cockpit-on]');
    await pressPreviewControl('[data-cockpit-off]');
    expect(document.querySelector('[data-preview-workspace]')).toBeNull();
    await openFile(probe.container, '/work/src/server.ts');
    await pressPreviewControl('[data-preview-toggle]');
    const panel = workspace();
    expect(panel.hidden).toBe(true);
    await pressPreviewControl('[data-cockpit-on]');
    await pressPreviewControl('[data-cockpit-off]');
    expect(workspace()).toBe(panel);
    expect(panel.hidden).toBe(true);
    await pressPreviewControl('[data-cockpit-on]');
    await pressPreviewControl('[data-preview-toggle]');
    expect(localStorage.getItem('kiki.railMode')).toBe('default');
    expect(panel.hidden).toBe(false);
  });

  it.each(['tool', 'media', 'markdown'] as const)('keeps coexisting literal-percent and space files distinct through %s', async (entry) => {
    const rawPath = 'C:/work/a%20b.ts';
    const spacedPath = 'C:/work/a b.ts';
    FILES[rawPath] = 'literal percent file';
    FILES[spacedPath] = 'space file';
    const probe = makeRoot();
    const content = entry === 'tool' ? (
      <ToolCard block={{
        kind: 'tool', id: 'tool-1', toolCallId: 'call-1', name: 'Read',
        argsText: '', args: {}, display: { kind: 'file_io', path: rawPath, operation: 'read' },
        description: undefined, status: 'done', output: undefined, isError: false,
        durationMs: undefined, progressText: undefined,
      }} />
    ) : entry === 'media' ? <MediaPartList media={[{ kind: 'file', path: rawPath }]} />
      : <Markdown text={`[source](${rawPath})`} />;
    await renderSettled(probe.root, <MediaPreviewProvider cwd="C:/work">{content}</MediaPreviewProvider>);
    const selector = entry === 'tool' ? '[role="link"]' : entry === 'media' ? 'button' : 'a';
    await act(async () => { probe.container.querySelector(selector)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    const expected = entry === 'markdown' ? spacedPath : rawPath;
    expect(tabs()).toEqual([expected]);
    const editor = workspace().querySelector<HTMLTextAreaElement>('[data-testid="editor"]')!;
    expect(editor.value).toBe(FILES[expected]);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, 'edited correct file');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { workspace().querySelector('[data-save-button]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(writeMock).toHaveBeenCalledWith(expected, 'edited correct file');
    expect(FILES[entry === 'markdown' ? rawPath : spacedPath]).toBe(entry === 'markdown' ? 'literal percent file' : 'space file');
  });

  it('loads content by the undecorated path, reuses its tab and updates citation navigation', async () => {
    const probe = makeRoot();
    await renderSettled(probe.root,
      <MediaPreviewProvider cwd="/work">
        <OpenButton path="src/server.ts:2:3" reference={{ path: '/work/src/server.ts', line: 2, column: 3 }} />
        <OpenButton path="/work/src/server.ts:1" reference={{ path: '/work/src/server.ts', line: 1 }} />
        <OpenButton path="docs/design.md:3" reference={{ path: '/work/docs/design.md', line: 3 }} />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, 'src/server.ts:2:3');
    expect(tabs()).toEqual(['/work/src/server.ts']);
    let editor = workspace().querySelector<HTMLTextAreaElement>('[data-testid="editor"]')!;
    expect(editor.value).toBe(FILES['/work/src/server.ts']);
    expect(editor.dataset['line']).toBe('2');
    expect(editor.dataset['column']).toBe('3');
    await openFile(probe.container, '/work/src/server.ts:1');
    expect(tabs()).toEqual(['/work/src/server.ts']);
    expect(editor.dataset['line']).toBe('1');
    await openFile(probe.container, 'docs/design.md:3');
    editor = workspace().querySelector<HTMLTextAreaElement>('[data-preview-tabpanel="/work/docs/design.md"] [data-testid="editor"]')!;
    expect(editor.value).toBe(FILES['/work/docs/design.md']);
    expect(editor.dataset['line']).toBe('3');
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

  it('discloses a truncated Markdown preview and loads the full file on demand without enabling editing', async () => {
    FILES['/work/docs/long.md'] = '# Beginning\n\n# Hidden ending\n';
    const probe = makeRoot();
    await renderSettled(probe.root,
      <MediaPreviewProvider cwd="/work">
        <OpenButton path="/work/docs/long.md" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/docs/long.md');
    const panel = workspace().querySelector('[data-preview-tabpanel="/work/docs/long.md"]')!;
    expect(panel.querySelector('h1')?.textContent).toBe('Beginning');
    expect(panel.textContent).toContain('preview shows only the beginning');
    expect(panel.textContent).not.toContain('Hidden ending');
    await act(async () => {
      panel.querySelector('[data-load-full-markdown]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(panel.querySelector('h1')?.textContent).toBe('Beginning');
    expect([...panel.querySelectorAll('h1')].map((heading) => heading.textContent)).toEqual(['Beginning', 'Hidden ending']);
    expect(panel.querySelector('[data-load-full-markdown]')).toBeNull();
    expect(panel.querySelector('[data-save-button]')).toBeNull();
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('loads the full Markdown source on demand without making it editable', async () => {
    FILES['/work/docs/long.md'] = '# Beginning\n\n# Hidden ending\n';
    const probe = makeRoot();
    await renderSettled(probe.root,
      <MediaPreviewProvider cwd="/work">
        <OpenButton path="/work/docs/long.md" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/docs/long.md');
    const panel = workspace().querySelector('[data-preview-tabpanel="/work/docs/long.md"]')!;
    await act(async () => {
      panel.querySelector('[data-md-mode="source"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const editor = () => panel.querySelector('[data-testid="editor"]') as HTMLTextAreaElement;
    expect(editor().value).not.toContain('Hidden ending');
    expect(panel.querySelector('[data-load-full-markdown]')).not.toBeNull();
    await act(async () => {
      panel.querySelector('[data-load-full-markdown]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(editor().value).toContain('# Hidden ending');
    expect(editor().readOnly).toBe(true);
    expect(panel.querySelector('[data-load-full-markdown]')).toBeNull();
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('does not reuse full Markdown from a different connection with the same file generation', async () => {
    FILES['/work/docs/long.md'] = '# First host\n\n# Private ending\n';
    const probe = makeRoot();
    const view = () => <MediaPreviewProvider cwd="/work"><OpenButton path="/work/docs/long.md" /></MediaPreviewProvider>;
    await renderSettled(probe.root, view());
    await openFile(probe.container, '/work/docs/long.md');
    await act(async () => {
      workspace().querySelector('[data-load-full-markdown]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(workspace().textContent).toContain('Private ending');

    connectionMock.activeClient = {
      readHostFile: async () => '# Second host\n',
      previewHostFile: async () => ({ text: '# Second host\n', truncated: true }),
      readHostFileBytes: async () => { throw new Error('not found'); },
    };
    await renderSettled(probe.root, view());
    expect(workspace().textContent).not.toContain('Private ending');
    expect(workspace().querySelector('h1')?.textContent).toBe('Second host');
    expect(workspace().querySelector('[data-load-full-markdown]')).not.toBeNull();
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

  it('keeps the mounted editor and its unsaved draft across a panel collapse', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work">
        <PreviewToggleButton />
        <OpenButton path="/work/src/server.ts" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/src/server.ts');
    const editor = workspace().querySelector<HTMLTextAreaElement>('[data-testid="editor"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(editor, 'collapsed draft');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(workspace().querySelector('[aria-label="Unsaved changes"]')).not.toBeNull();

    // Collapsing hides the panel in place: the editor (and the controller
    // behind it) must stay mounted, not be torn down with its draft.
    await act(async () => {
      workspace()
        .querySelector('[aria-label="Collapse preview panel"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const collapsed = workspace();
    expect(collapsed.hasAttribute('hidden')).toBe(true);
    expect(collapsed.style.display).toBe('none');
    expect(collapsed.querySelector('[data-testid="editor"]')).toBe(editor);

    // Re-opening the panel shows the same buffer with the draft intact.
    await act(async () => {
      probe.container
        .querySelector('[data-preview-toggle]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const reopened = workspace();
    expect(reopened.hasAttribute('hidden')).toBe(false);
    expect(reopened.style.display).not.toBe('none');
    const restored = reopened.querySelector<HTMLTextAreaElement>('[data-testid="editor"]')!;
    expect(restored).toBe(editor);
    expect(restored.value).toBe('collapsed draft');
    expect(reopened.querySelector('[aria-label="Unsaved changes"]')).not.toBeNull();
  });

  it('an autosave armed before collapsing still fires while the panel is hidden', async () => {
    vi.useFakeTimers();
    try {
      const probe = makeRoot();
      await renderSettled(
        probe.root,
        <MediaPreviewProvider cwd="/work">
          <PreviewToggleButton />
          <OpenButton path="/work/src/server.ts" />
        </MediaPreviewProvider>,
      );
      await openFile(probe.container, '/work/src/server.ts');
      const editor = workspace().querySelector<HTMLTextAreaElement>('[data-testid="editor"]')!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        setter.call(editor, 'autosaved while hidden');
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        workspace()
          .querySelector('[aria-label="Collapse preview panel"]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(writeMock).not.toHaveBeenCalled();
      // The 5s debounce survives the collapse instead of being cancelled by a
      // controller dispose.
      await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
      expect(writeMock).toHaveBeenCalledWith('/work/src/server.ts', 'autosaved while hidden');
    } finally {
      vi.useRealTimers();
    }
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

  it.each([['local', true], ['ssh:remote-1', false]] as const)(
    'only offers local file openers in the local scope (%s)', async (scopeId, expected) => {
      hostMock.desktop = true;
      connectionMock.scopeId = scopeId;
      const probe = makeRoot();
      await renderSettled(probe.root,
        <MediaPreviewProvider cwd="/work"><OpenButton path="/work/src/server.ts" /></MediaPreviewProvider>,
      );
      await openFile(probe.container, '/work/src/server.ts');
      await act(async () => {
        workspace().querySelector('[data-preview-tab="/work/src/server.ts"]')!
          .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      });
      const menu = document.querySelector('[data-preview-tab-menu]')!;
      expect(menu.querySelector('[data-menu-item="copy-absolute"]')).not.toBeNull();
      expect(menu.querySelector('[data-menu-item="show-in-folder"]') !== null).toBe(expected);
      expect(menu.querySelector('[data-menu-item="open-default-app"]') !== null).toBe(expected);
    },
  );

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

  it('supports opening and closing subagent panel tabs, auto-hiding when all tabs closed', async () => {
    const probe = makeRoot();
    function OpenPanelButton({ agentId, title }: { agentId: string; title?: string }) {
      const preview = useMediaPreview();
      return (
        <button
          type="button"
          data-open-panel={agentId}
          onClick={() => preview?.openAgentPanel(agentId, title)}
        >
          open panel
        </button>
      );
    }
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work" sessionId="s1">
        <OpenPanelButton agentId="sub-123" title="Subagent Worker" />
      </MediaPreviewProvider>,
    );
    // Initially no tabs, workspace is not rendered
    expect(document.querySelector('[data-preview-workspace]')).toBeNull();

    // Open subagent panel tab
    await act(async () => {
      probe.container
        .querySelector('[data-open-panel="sub-123"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(workspace()).not.toBeNull();
    expect(tabs()).toEqual(['panel:sub-123']);
    expect(workspace().textContent).toContain('Subagent Worker');

    // Close the panel tab
    const closeBtn = workspace().querySelector('[data-preview-tab="panel:sub-123"] button')!;
    await act(async () => {
      closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Auto-hidden when empty
    expect(document.querySelector('[data-preview-workspace]')).toBeNull();
  });

  it('toggles fullscreen in preview workspace', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work" sessionId="s1">
        <OpenButton path="/work/src/server.ts" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/src/server.ts');
    const ws = workspace();
    expect(ws.classList.contains('fixed')).toBe(false);
    expect(ws.hasAttribute('data-preview-fullscreen')).toBe(false);

    const toggleBtn = ws.querySelector('[data-preview-fullscreen-toggle]')!;
    // Toggle into fullscreen; the shell uses this state to lift its one shared rail.
    await act(async () => {
      toggleBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(workspace().classList.contains('fixed')).toBe(true);
    expect(workspace().classList.contains('inset-0')).toBe(true);
    expect(workspace().hasAttribute('data-preview-fullscreen')).toBe(true);

    const ownedEscape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    ownedEscape.preventDefault();
    await act(async () => { window.dispatchEvent(ownedEscape); });
    expect(workspace().hasAttribute('data-preview-fullscreen')).toBe(true);

    // The fullscreen closer consumes its Escape so later main-abort listeners
    // cannot mistake focus on body for permission to stop the active turn.
    const fullscreenEscape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    await act(async () => { window.dispatchEvent(fullscreenEscape); });
    expect(fullscreenEscape.defaultPrevented).toBe(true);
    expect(workspace().classList.contains('fixed')).toBe(false);
    expect(workspace().hasAttribute('data-preview-fullscreen')).toBe(false);
  });

  it('docked in the shell, fullscreen fills the conversation row instead of the window', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MemoryRouter initialEntries={['/s/s1']}>
        <Routes>
          <Route element={<ConversationShell />}>
            <Route
              path="/s/:id"
              element={(
                <MediaPreviewProvider cwd="/work" sessionId="s1">
                  <OpenButton path="/work/src/server.ts" />
                </MediaPreviewProvider>
              )}
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    await openFile(probe.container, '/work/src/server.ts');
    expect(workspace().closest('.conversation-row')).not.toBeNull();
    await act(async () => {
      workspace().querySelector('[data-preview-fullscreen-toggle]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const ws = workspace();
    expect(ws.hasAttribute('data-preview-fullscreen')).toBe(true);
    // The row-scoped class, never the window-covering fixed/inset-0 overlay.
    expect(ws.classList.contains('preview-workspace--fullscreen')).toBe(true);
    expect(ws.classList.contains('fixed')).toBe(false);
    expect(ws.classList.contains('w-screen')).toBe(false);
    expect(ws.closest('.conversation-row')).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });
    expect(workspace().hasAttribute('data-preview-fullscreen')).toBe(false);
    expect(workspace().classList.contains('preview-workspace--fullscreen')).toBe(false);
  });
});

describe('PreviewWorkspace image tabs', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => { root.unmount(); });
    }
    for (const container of containers.splice(0)) container.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  async function openImageTab() {
    let objectUrls = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:original-${++objectUrls}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work" sessionId="s1">
        <OpenButton path="/work/shots/screen.png" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/shots/screen.png');
    await act(async () => { await Promise.resolve(); });
    const image = workspace().querySelector<HTMLImageElement>('[data-image-viewport] img')!;
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1440 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 900 });
    await act(async () => { image.dispatchEvent(new Event('load')); });
    return { image, objectUrls: () => objectUrls };
  }

  it('renders the original bytes, never a downscaled thumbnail', async () => {
    const { image, objectUrls } = await openImageTab();
    // One object URL: the original blob. A thumbnail would add a second one.
    expect(objectUrls()).toBe(1);
    expect(image.getAttribute('src')).toBe('blob:original-1');
    expect(workspace().querySelector('[data-image-meta]')?.textContent).toContain('1440 × 900');
    expect(workspace().querySelector<HTMLElement>('[data-image-viewport]')?.dataset['imageViewport']).toBe('fit');
    expect(image.className).toContain('max-w-full');
  });

  it('toggles fit and 100% by click or the zoom buttons, sizing 100% in device pixels', async () => {
    const dpr = vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2);
    const { image } = await openImageTab();
    const viewport = () => workspace().querySelector<HTMLElement>('[data-image-viewport]')!;
    await act(async () => { viewport().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(viewport().dataset['imageViewport']).toBe('actual');
    expect(image.style.width).toBe('720px');
    expect(image.className).not.toContain('max-w-full');
    expect(workspace().querySelector('[data-image-zoom="actual"]')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      workspace().querySelector('[data-image-zoom="fit"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(viewport().dataset['imageViewport']).toBe('fit');
    expect(image.style.width).toBe('');
    dpr.mockRestore();
  });
});

describe('PreviewWorkspace media tabs', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    connectionMock.activeClient = connectionMock.defaultClient;
    connectionMock.scopeId = 'local';
    hostMock.desktop = false;
    hostMock.revealPath.mockClear();
    hostMock.openPath.mockClear();
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => { root.unmount(); });
    }
    for (const container of containers.splice(0)) container.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('plays a video container in the HTML5 player; the opener pair stays hidden without a desktop host', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work">
        <OpenButton path="/work/clips/intro.mp4" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/clips/intro.mp4');
    await act(async () => { await Promise.resolve(); });
    const panel = workspace().querySelector('[data-preview-tabpanel="/work/clips/intro.mp4"]')!;
    const video = panel.querySelector<HTMLVideoElement>('video[data-preview-video]')!;
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.getAttribute('src')).toBe('blob:mock');
    // The download anchor renders; the desktop opener pair does not (browser host).
    expect(panel.querySelector('[data-download-file]')).not.toBeNull();
    expect(panel.querySelector('[data-open-default-app]')).toBeNull();
    expect(panel.querySelector('[data-reveal-file]')).toBeNull();
  });

  it.each([['local', true], ['ssh:remote-1', false]] as const)(
    'gates the video tab opener pair by scope, beside the download anchor (%s)',
    async (scopeId, expected) => {
      hostMock.desktop = true;
      connectionMock.scopeId = scopeId;
      const probe = makeRoot();
      await renderSettled(
        probe.root,
        <MediaPreviewProvider cwd="/work">
          <OpenButton path="/work/clips/intro.mp4" />
        </MediaPreviewProvider>,
      );
      await openFile(probe.container, '/work/clips/intro.mp4');
      await act(async () => { await Promise.resolve(); });
      const panel = workspace().querySelector('[data-preview-tabpanel="/work/clips/intro.mp4"]')!;
      expect(panel.querySelector('[data-download-file]')).not.toBeNull();
      expect(panel.querySelector('[data-open-default-app]') !== null).toBe(expected);
      expect(panel.querySelector('[data-reveal-file]') !== null).toBe(expected);
      if (expected) {
        await act(async () => {
          panel.querySelector('[data-open-default-app]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(hostMock.openPath).toHaveBeenCalledWith('/work/clips/intro.mp4');
        await act(async () => {
          panel.querySelector('[data-reveal-file]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(hostMock.revealPath).toHaveBeenCalledWith('/work/clips/intro.mp4');
      }
    },
  );

  it('places the opener pair beside the binary download, plus a caption reveal icon', async () => {
    hostMock.desktop = true;
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work">
        <OpenButton path="/work/bundles/release.zip" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/bundles/release.zip');
    const panel = workspace().querySelector('[data-preview-tabpanel="/work/bundles/release.zip"]')!;
    expect(panel.textContent).toContain('No preview available for this file type.');
    expect(panel.querySelector('[data-download-file]')?.textContent).toBe('Download');
    // Two reveal affordances: the caption-strip icon (tooltip/aria label) and
    // the text button beside the download.
    const reveals = [...panel.querySelectorAll<HTMLElement>('[data-reveal-file]')];
    expect(reveals).toHaveLength(2);
    expect(reveals[0]!.getAttribute('aria-label')).toBe('Show in folder');
    expect(reveals[1]!.textContent).toBe('Show in folder');
    const openButton = panel.querySelector<HTMLElement>('[data-open-default-app]')!;
    expect(openButton.textContent).toBe('Open');
    expect(openButton.getAttribute('title')).toBe('Open with default app');
    await act(async () => {
      openButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(hostMock.openPath).toHaveBeenCalledWith('/work/bundles/release.zip');
    await act(async () => {
      reveals[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(hostMock.revealPath).toHaveBeenCalledWith('/work/bundles/release.zip');
  });

  it('adds the opener pair beside the text tab download and wires the clicks', async () => {
    hostMock.desktop = true;
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work">
        <OpenButton path="/work/src/server.ts" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/src/server.ts');
    const panel = workspace().querySelector('[data-preview-tabpanel="/work/src/server.ts"]')!;
    expect(panel.querySelector('[data-download-file]')).not.toBeNull();
    const openButton = panel.querySelector<HTMLElement>('[data-open-default-app]')!;
    expect(openButton.textContent).toBe('Open');
    const revealButton = panel.querySelector<HTMLElement>('[data-reveal-file]')!;
    expect(revealButton.getAttribute('aria-label')).toBe('Show in folder');
    await act(async () => {
      openButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(hostMock.openPath).toHaveBeenCalledWith('/work/src/server.ts');
    await act(async () => {
      revealButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(hostMock.revealPath).toHaveBeenCalledWith('/work/src/server.ts');
  });

  it('keeps image tabs free of the opener pair (no download anchor there)', async () => {
    hostMock.desktop = true;
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work" sessionId="s1">
        <OpenButton path="/work/shots/screen.png" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/shots/screen.png');
    await act(async () => { await Promise.resolve(); });
    const image = workspace().querySelector<HTMLImageElement>('[data-image-viewport] img')!;
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1440 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 900 });
    await act(async () => { image.dispatchEvent(new Event('load')); });
    const panel = workspace().querySelector('[data-preview-tabpanel="/work/shots/screen.png"]')!;
    expect(panel.querySelector('[data-download-file]')).toBeNull();
    expect(panel.querySelector('[data-open-default-app]')).toBeNull();
    expect(panel.querySelector('[data-reveal-file]')).toBeNull();
  });
});

describe('PreviewWorkspace agent tabs', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    agentWorkspaceHarness.calls.length = 0;
  });
  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => { root.unmount(); });
    }
    for (const container of containers.splice(0)) container.remove();
    document.body.innerHTML = '';
  });

  function makeController() {
    return {
      retainAgentView: vi.fn(),
      updateAgentView: vi.fn(),
      releaseAgentView: vi.fn(),
    };
  }

  function OpenPanelButton({ agentId, title }: { agentId: string; title?: string }) {
    const preview = useMediaPreview();
    return (
      <button
        type="button"
        data-open-panel={agentId}
        onClick={() => preview?.openAgentPanel(agentId, title)}
      >
        open panel
      </button>
    );
  }

  async function renderAgentPreview(
    controller: ReturnType<typeof makeController>,
    openRoute: (agentId: string) => void,
    sharedRail?: { open: boolean; toggle: () => void; available?: boolean },
  ) {
    const probe = makeRoot();
    const forest: AgentForest = { roots: [], byId: {} };
    await renderSettled(
      probe.root,
      <MediaPreviewProvider
        cwd="/work"
        sessionId="s1"
        sessionViewState={{ ...createViewState('s1'), loaded: true }}
        agentForest={forest}
        controller={controller as unknown as SessionController}
        workspaceNavigation={{ openAgent: vi.fn(), openAgentRoute: openRoute, openSession: vi.fn(), sharedRail }}
      >
        <OpenPanelButton agentId="sub-123" title="Subagent Worker" />
        <OpenButton path="/work/src/server.ts" />
      </MediaPreviewProvider>,
    );
    return probe;
  }

  async function openPanel(container: HTMLElement, agentId: string): Promise<void> {
    await act(async () => {
      container
        .querySelector(`[data-open-panel="${agentId}"]`)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('renders the full agent workspace in a panel tab and retains a delta view', async () => {
    const controller = makeController();
    const probe = await renderAgentPreview(controller, vi.fn());
    await openPanel(probe.container, 'sub-123');

    const panel = workspace().querySelector('[data-preview-tabpanel="panel:sub-123"]');
    expect(panel?.querySelector('[data-agent-workspace="sub-123"]')).not.toBeNull();
    expect(controller.retainAgentView).toHaveBeenCalledTimes(1);
    expect(controller.retainAgentView).toHaveBeenCalledWith('panel:sub-123', 'sub-123', 'delta');
    const call = agentWorkspaceHarness.calls.at(-1);
    expect(call?.agentId).toBe('sub-123');
    expect(call?.inheritMediaPreview).toBe(true);
    expect(call?.showPreviewToggle).toBe(false);
    // No tab-local rail: the app keeps one shared rail, retargeted at this
    // tab's agent by SessionView's focus bridge.
    expect(call?.railIsOverlay).toBe(false);
    expect(call?.showRailToggle).toBe(false);
    expect(call?.slotsProvided).toBe(true);
  });

  it('reopens the one shared rail from the preview header instead of creating a local rail', async () => {
    const toggle = vi.fn();
    const controller = makeController();
    const probe = await renderAgentPreview(controller, vi.fn(), { open: false, toggle });
    await openPanel(probe.container, 'sub-123');
    const call = agentWorkspaceHarness.calls.at(-1);
    expect(call?.showRailToggle).toBe(true);
    expect(call?.railOpen).toBe(false);
    expect(call?.onToggleRail).toBe(toggle);
    expect(call?.railIsOverlay).toBe(false);
  });

  it('offers no rail entry in the panel tab where the shell has no rail (below lg)', async () => {
    // Below lg the shell hides the shared rail outright, and it says so
    // through sharedRail.available: the tab header must not offer an entry
    // that could not open anything.
    const controller = makeController();
    const probe = await renderAgentPreview(controller, vi.fn(), { open: false, toggle: vi.fn(), available: false });
    await openPanel(probe.container, 'sub-123');
    const call = agentWorkspaceHarness.calls.at(-1);
    expect(call?.showRailToggle).toBe(false);
  });

  it('closes the shared rail before exiting fullscreen on Escape', async () => {
    const toggle = vi.fn();
    const controller = makeController();
    const probe = await renderAgentPreview(controller, vi.fn(), { open: true, toggle });
    await openPanel(probe.container, 'sub-123');
    await act(async () => {
      workspace().querySelector<HTMLButtonElement>('[data-preview-fullscreen-toggle]')?.click();
    });
    expect(workspace().hasAttribute('data-preview-fullscreen')).toBe(true);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(workspace().hasAttribute('data-preview-fullscreen')).toBe(true);
  });

  it('drops the view when the tab or panel hides, restores it on show, releases on close', async () => {
    const controller = makeController();
    const probe = await renderAgentPreview(controller, vi.fn());
    await openPanel(probe.container, 'sub-123');
    expect(controller.retainAgentView).toHaveBeenCalledTimes(1);
    expect(agentWorkspaceHarness.calls.at(-1)?.transcriptVisible).toBe(true);

    // Switching to another tab hides the workspace: the demand drops to the
    // summary baseline in one update, without a release/re-retain swing.
    await openFile(probe.container, '/work/src/server.ts');
    expect(controller.updateAgentView).toHaveBeenLastCalledWith('panel:sub-123', 'off');
    expect(agentWorkspaceHarness.calls.at(-1)?.transcriptVisible).toBe(false);
    expect(controller.retainAgentView).toHaveBeenCalledTimes(1);
    expect(controller.releaseAgentView).not.toHaveBeenCalled();

    // Re-activating the tab restores the delta demand in one update.
    await act(async () => {
      workspace()
        .querySelector('[data-preview-tab-key="panel:sub-123"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(controller.updateAgentView).toHaveBeenLastCalledWith('panel:sub-123', 'delta');
    expect(agentWorkspaceHarness.calls.at(-1)?.transcriptVisible).toBe(true);
    expect(controller.retainAgentView).toHaveBeenCalledTimes(1);

    // Collapsing the whole panel hides the active tab as well.
    await act(async () => {
      workspace()
        .querySelector('[aria-label="Collapse preview panel"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(controller.updateAgentView).toHaveBeenLastCalledWith('panel:sub-123', 'off');
    expect(agentWorkspaceHarness.calls.at(-1)?.transcriptVisible).toBe(false);
    expect(controller.releaseAgentView).not.toHaveBeenCalled();

    // Closing the tab releases the lease.
    await act(async () => {
      workspace()
        .querySelector('[data-preview-tab="panel:sub-123"] button')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(controller.releaseAgentView).toHaveBeenCalledWith('panel:sub-123');
  });

  it('activates an agent tab from keyboard without routing away or losing its transcript lease', async () => {
    const controller = makeController();
    const openRoute = vi.fn();
    const probe = await renderAgentPreview(controller, openRoute);
    await openPanel(probe.container, 'sub-123');
    await openFile(probe.container, '/work/src/server.ts');
    expect(controller.updateAgentView).toHaveBeenLastCalledWith('panel:sub-123', 'off');
    const tab = workspace().querySelector<HTMLElement>('[data-preview-tab="panel:sub-123"]')!;
    expect(tab.tabIndex).toBe(0);
    await act(async () => { tab.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })); });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(controller.updateAgentView).toHaveBeenLastCalledWith('panel:sub-123', 'delta');
    expect(openRoute).not.toHaveBeenCalled();
  });

  it('opens the agent on its fullscreen route from the tab context menu', async () => {
    const controller = makeController();
    const openRoute = vi.fn();
    const probe = await renderAgentPreview(controller, openRoute);
    await openPanel(probe.container, 'sub-123');

    const tab = workspace().querySelector('[data-preview-tab="panel:sub-123"]')!;
    await act(async () => {
      tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    const item = document.querySelector('[data-menu-item="open-agent-route"]');
    expect(item?.textContent).toBe('Open Subagent Worker');
    await act(async () => {
      item!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(openRoute).toHaveBeenCalledWith('sub-123');
    expect(document.querySelector('[data-preview-tab-menu]')).toBeNull();
  });

  it('keeps the plain caption when the workspace is not wired', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work" sessionId="s1">
        <OpenPanelButton agentId="sub-123" title="Subagent Worker" />
      </MediaPreviewProvider>,
    );
    await openPanel(probe.container, 'sub-123');

    const panel = workspace().querySelector('[data-preview-tabpanel="panel:sub-123"]');
    expect(panel?.textContent).toContain('Agent: Subagent Worker');
    expect(panel?.querySelector('[data-agent-workspace]')).toBeNull();
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

describe('PreviewWorkspace HTML document preview', () => {
  const previewUrl = 'http://a1b2c3d4.kiki-document.localhost:54321/html-preview/cap123/page.html';

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    hostMock.desktop = false;
    hostMock.pickDirectory.mockReset();
    htmlPreviewMock.open.mockReset();
    htmlPreviewMock.close.mockReset();
    htmlPreviewMock.open.mockImplementation(async () => ({
      preview_id: 'cap123',
      url: previewUrl,
      expires_at: Date.now() + 30 * 60 * 1000,
      sandbox: HTML_PREVIEW_SANDBOX,
    }));
    htmlPreviewMock.close.mockImplementation(async () => {});
    FILES['/work/page.html'] = '<!doctype html><html><head><style>body { color: red }</style></head><body><script>window.ran = true</script><p>safe</p></body></html>';
  });
  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => { root.unmount(); });
    }
    for (const container of containers.splice(0)) container.remove();
    document.body.innerHTML = '';
  });

  const settle = async (): Promise<void> => {
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  };

  async function mountHtmlTab(path = '/work/page.html', cwd = '/work'): Promise<{ root: Root; container: HTMLDivElement }> {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd={cwd}>
        <OpenButton path={path} />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, path);
    await settle();
    return probe;
  }

  async function clickMode(mode: 'rendered' | 'source'): Promise<void> {
    await act(async () => {
      workspace().querySelector<HTMLButtonElement>(`[data-preview-mode="${mode}"]`)!.click();
    });
  }

  it('recognizes HTML paths for the documented preview', () => {
    expect(isHtmlPreviewPath('/work/page.html')).toBe(true);
    expect(isHtmlPreviewPath('C:\\work\\page.htm')).toBe(true);
    expect(isHtmlPreviewPath('/work/page.md')).toBe(false);
  });

  it('opens the server-issued isolated document origin in a sandboxed frame, never srcdoc', async () => {
    const probe = await mountHtmlTab();
    expect(htmlPreviewMock.open).toHaveBeenCalledTimes(1);
    expect(htmlPreviewMock.open).toHaveBeenCalledWith({ path: '/work/page.html', root: '/work' });

    const frame = probe.container.querySelector<HTMLIFrameElement>('[data-preview-html]');
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute('src')).toBe(previewUrl);
    expect(frame!.getAttribute('srcdoc')).toBeNull();
    expect(frame!.getAttribute('sandbox')).toBe(HTML_PREVIEW_SANDBOX);
    expect(frame!.getAttribute('allow')).toBe('fullscreen');
    expect(frame!.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame!.src.includes('bearer')).toBe(false);

    // The rendered/source toggle keeps the same resident frame and never closes the capability.
    await clickMode('source');
    expect(htmlPreviewMock.close).not.toHaveBeenCalled();
    expect(probe.container.querySelector('[data-testid="editor"]')).not.toBeNull();
    await clickMode('rendered');
    expect(probe.container.querySelector('[data-preview-html]')).toBe(frame);
    expect(htmlPreviewMock.open).toHaveBeenCalledTimes(1);
  });

  it('closes the capability when the tab unmounts', async () => {
    const probe = await mountHtmlTab();
    expect(htmlPreviewMock.open).toHaveBeenCalledTimes(1);
    await act(async () => { probe.root.unmount(); });
    expect(htmlPreviewMock.close).toHaveBeenCalledWith('cap123');
  });

  it('cleans up a late open result the tab no longer owns', async () => {
    let resolveOpen!: (value: { preview_id: string; url: string; expires_at: number; sandbox: string }) => void;
    htmlPreviewMock.open.mockImplementationOnce(() => new Promise((resolve) => { resolveOpen = resolve; }));
    const probe = await mountHtmlTab();
    expect(htmlPreviewMock.open).toHaveBeenCalledTimes(1);
    await act(async () => { probe.root.unmount(); });
    await act(async () => {
      resolveOpen({
        preview_id: 'late-id',
        url: 'http://late.kiki-document.localhost:1234/html-preview/late-id/page.html',
        expires_at: Date.now() + 10_000,
        sandbox: HTML_PREVIEW_SANDBOX,
      });
      await Promise.resolve();
    });
    expect(htmlPreviewMock.close).toHaveBeenCalledWith('late-id');
  });

  it('asks for a resource root outside the workspace and accepts a picked root', async () => {
    hostMock.desktop = true;
    hostMock.pickDirectory.mockResolvedValueOnce('/outside');
    const probe = await mountHtmlTab('/outside/page.html');
    expect(htmlPreviewMock.open).not.toHaveBeenCalled();
    expect(probe.container.querySelector('[data-html-preview-root-required]')).not.toBeNull();

    await act(async () => {
      probe.container.querySelector<HTMLButtonElement>('[data-html-pick-root]')!.click();
    });
    await settle();
    expect(htmlPreviewMock.open).toHaveBeenCalledWith({ path: '/outside/page.html', root: '/outside' });
    expect(probe.container.querySelector('[data-preview-html]')).not.toBeNull();
  });

  it('reports the remote target-owner refusal as unavailable authorization', async () => {
    htmlPreviewMock.open.mockRejectedValueOnce(new Error('html_preview_target_owner_grant_required'));
    const probe = await mountHtmlTab();
    expect(probe.container.querySelector('[data-html-preview-error="remote_grant_required"]')).not.toBeNull();
    expect(probe.container.querySelector('[data-preview-html]')).toBeNull();
  });

  it('reports the local-connection refusal and keeps the source available', async () => {
    htmlPreviewMock.open.mockRejectedValueOnce(new Error('html_preview_document_origin_requires_local_connection'));
    const probe = await mountHtmlTab();
    const error = probe.container.querySelector<HTMLElement>('[data-html-preview-error="local_connection_required"]');
    expect(error).not.toBeNull();
    await act(async () => { error!.querySelector<HTMLButtonElement>('[data-html-view-source]')!.click(); });
    expect(probe.container.querySelector('[data-testid="editor"]')).not.toBeNull();
  });

  it('recovers from an expired capability by reopening it', async () => {
    htmlPreviewMock.open.mockRejectedValueOnce(new Error('html_preview_expired'));
    const probe = await mountHtmlTab();
    const error = probe.container.querySelector<HTMLElement>('[data-html-preview-error="expired"]');
    expect(error).not.toBeNull();
    expect(htmlPreviewMock.open).toHaveBeenCalledTimes(1);

    await act(async () => {
      error!.querySelector<HTMLButtonElement>('[data-html-reload]')!.click();
    });
    await settle();
    expect(htmlPreviewMock.open).toHaveBeenCalledTimes(2);
    expect(probe.container.querySelector('[data-preview-html]')).not.toBeNull();
  });
});
