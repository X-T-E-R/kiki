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
import { LazyMediaLightbox, LazyPreviewWorkspace } from './preview/PreviewLoadBoundary';
import { anyOverlayOpen } from '../lib/uiBusy';
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
  connectionSource: 'desktop' as 'desktop' | 'remote' | 'ssh' | null,
  config: null as { readonly url?: string } | null,
}));
const hostMock = vi.hoisted(() => ({ desktop: false, revealPath: vi.fn(), openPath: vi.fn() }));
const htmlPreviewMock = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }));
const sessionMediaMock = vi.hoisted(() => ({
  bytesById: {} as Record<string, { bytes: Uint8Array; mime: string; name?: string }>,
  documentPreview: vi.fn(),
}));

vi.mock('../state/connection', async (importOriginal) => {
  const original = await importOriginal<typeof import('../state/connection')>();
  // STABLE identity: TextTabView's controller effect keys on `client` — a
  // per-call fresh object would recreate the controller every render (and
  // leak listeners until the worker OOMs).
  const fakeClient = {
    readingOptions: () => ({ timeoutMs: 0 }),
    readHostFile: (path: string) =>
      path in FILES ? Promise.resolve(FILES[path]) : Promise.reject(new Error('not found')),
    previewHostFile: (path: string) =>
      path === '/work/docs/long.md' ? Promise.resolve({ text: '# Beginning\n', truncated: true })
        : path in FILES ? Promise.resolve({ text: FILES[path], truncated: false }) : Promise.reject(new Error('not found')),
    readHostFileBytes: (path: string) => {
      if (path in FILES) return Promise.resolve({ bytes: new TextEncoder().encode(FILES[path]), mime: 'text/plain' });
      const file = {
        '/work/shots/screen.png': { bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png' },
        '/work/docs/sub/diagram.png': { bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png' },
        '/work/clips/intro.mp4': { bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), mime: 'video/mp4' },
        '/work/audio/sample.mp3': { bytes: new Uint8Array([73, 68, 51, 3]), mime: 'audio/mpeg' },
        '/work/bundles/release.zip': { bytes: new Uint8Array([80, 75, 3, 4]), mime: 'application/zip' },
      }[path];
      return file === undefined ? Promise.reject(new Error('not found')) : Promise.resolve(file);
    },
    readHostMediaPreviewBytes: (path: string) => fakeClient.readHostFileBytes(path),
    readSessionMediaBytes: (_sessionId: string, fileId: string) => {
      const entry = sessionMediaMock.bytesById[fileId];
      return entry === undefined ? Promise.reject(new Error('not found')) : Promise.resolve(entry);
    },
    readSessionMediaPreviewBytes: (_sessionId: string, fileId: string) => {
      const entry = sessionMediaMock.bytesById[fileId];
      return entry === undefined ? Promise.reject(new Error('not found')) : Promise.resolve(entry);
    },
    documentPreview: (sessionId: string, request: unknown, signal?: AbortSignal) =>
      sessionMediaMock.documentPreview(sessionId, request, signal),
    readDocumentPreviewAsset: () => Promise.resolve({ bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png' }),
    baseUrl: 'http://127.0.0.1:5177',
    openHtmlPreview: htmlPreviewMock.open,
    closeHtmlPreview: htmlPreviewMock.close,
  };
  connectionMock.activeClient = fakeClient;
  connectionMock.defaultClient = fakeClient;
  return {
    ...original,
    useOptionalConnection: () => ({
      client: connectionMock.activeClient,
      scopeId: connectionMock.scopeId,
      connectionSource: connectionMock.connectionSource,
      config: connectionMock.config,
    }),
  };
});

vi.mock('../host', () => {
  const host = {
    kind: 'browser',
    writeFileText: (path: string, text: string) => writeMock(path, text),
  };
  const desktopHost = { ...host, kind: 'tauri', revealPath: hostMock.revealPath, openPath: hostMock.openPath };
  return {
    useHost: () => hostMock.desktop ? desktopHost : host,
    openExternalUrl: vi.fn(),
  };
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
    const button = [...container.querySelectorAll<HTMLButtonElement>('[data-open-file]')]
      .find((candidate) => candidate.dataset['openFile'] === path);
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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
  beforeAll(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await Promise.all([LazyPreviewWorkspace.preload(), LazyMediaLightbox.preload()]);
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    FILES['/work/src/server.ts'] = "import { boot } from './boot';\nboot(5801);\n";
    FILES['/work/docs/design.md'] = '# Design\n\nSome **notes**.\n';
    connectionMock.activeClient = connectionMock.defaultClient;
    connectionMock.scopeId = 'local';
    connectionMock.connectionSource = 'desktop';
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
      expect(report).toHaveBeenLastCalledWith('file:/work/src/server.ts', { top: 241, left: 23 });
      await renderSettled(probe.root, <PreviewWorkspace {...props} scrollPositions={{ 'file:/work/src/server.ts': { top: 187, left: 23 } }} />);
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
      expect(getReadingSnapshot<PreviewReadingSnapshot>(forwardVisit, previewSnapshotKey('example'))?.positions['file:/work/docs/design.md']?.top).toBe(321);
      expect(workspace().querySelector('.cm-scroller')).toBe(editor);
      expect(editor.scrollTop).toBe(187);
      expect(editor.scrollLeft).toBe(23);
      await openFile(probe.container, '/work/docs/design.md');
      await settle();
      expect(markdown.scrollTop).toBe(91);
      await act(async () => { await router.navigate(1); });
      await settle();
      expect(getCurrentVisit()!.visitId).toBe(forwardVisit);
      expect(getReadingSnapshot<PreviewReadingSnapshot>(forwardVisit, previewSnapshotKey('example'))?.positions['file:/work/docs/design.md']?.top).toBe(321);
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
    const key = kind === 'image' ? 'file:/work/shots/screen.png' : 'skill:builtin:example';
    const tab = kind === 'image' ? '/work/shots/screen.png' : { kind: 'skill' as const, name: 'example' };
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
    expect(editor.readOnly).toBe(true);
    await act(async () => { workspace().querySelector('[data-edit-button]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(editor.readOnly).toBe(false);
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

  it('reuses an existing Windows file tab across slash spelling and citation targets', async () => {
    const path = 'C:\\Example\\notes.md';
    FILES[path] = '# Example\n\nSource text.\n';
    const probe = makeRoot();
    await renderSettled(probe.root, <MediaPreviewProvider cwd="C:/Example">
      <Markdown text={'See `C:\\Example\\notes.md:3` and `c:/example/notes.md:1`'} />
    </MediaPreviewProvider>);
    const links = probe.container.querySelectorAll('a');
    await act(async () => { links[0]!.click(); });
    const editor = workspace().querySelector<HTMLElement>('[data-testid="editor"]')!;
    await act(async () => { links[1]!.click(); });
    expect(tabs()).toEqual([path]);
    expect(workspace().querySelector('[data-testid="editor"]')).toBe(editor);
    expect(editor.dataset['line']).toBe('1');
    delete FILES[path];
  });

  it('switches line citations to source and headings to rendered without discarding the source editor', async () => {
    const probe = makeRoot();
    const scroll = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      await renderSettled(probe.root, <MediaPreviewProvider cwd="/work">
        <Markdown text={'[line](docs/design.md:3) [heading](docs/design.md#design) [missing](docs/design.md#absent) [outside](docs/design.md:999) [invalid](docs/design.md:0)'} />
      </MediaPreviewProvider>);
      const links = probe.container.querySelectorAll('a');
      await act(async () => { links[0]!.click(); });
      const editor = workspace().querySelector<HTMLTextAreaElement>('[data-testid="editor"]')!;
      const draft = `${editor.value}\nUnsaved citation draft.\n`;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, draft);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => { links[1]!.click(); });
      expect(editor.closest('[hidden]')).not.toBeNull();
      expect(workspace().querySelector('h1')?.textContent).toBe('Design');
      expect(workspace().querySelector('h1')!.closest('[hidden]')).toBeNull();
      expect(workspace().textContent).toContain('Unsaved citation draft.');
      await act(async () => { links[2]!.click(); });
      expect(workspace().textContent).toContain('File opened, but the cited location was not found.');
      await act(async () => { links[3]!.click(); });
      expect(workspace().querySelector('[data-testid="editor"]')).toBe(editor);
      expect(editor.value).toBe(draft);
      expect(editor.closest('[hidden]')).toBeNull();
      expect(workspace().textContent).toContain('Showing the nearest available position.');
      await act(async () => { links[4]!.click(); });
      expect(tabs()).toEqual(['/work/docs/design.md']);
      expect(workspace().textContent).toContain('File opened, but the cited location was not found.');
    } finally { HTMLElement.prototype.scrollIntoView = original; }
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

  it('automatically completes a truncated Markdown preview without enabling editing', async () => {
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
    expect(panel.textContent).toContain('Hidden ending');
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
    expect(workspace().textContent).toContain('Private ending');

    connectionMock.activeClient = {
      readingOptions: () => ({ timeoutMs: 0 }),
      readHostFile: async () => '# Second host\n',
      previewHostFile: async () => ({ text: '# Second host\n', truncated: true }),
      readHostFileBytes: async () => { throw new Error('not found'); },
    };
    await renderSettled(probe.root, view());
    expect(workspace().textContent).not.toContain('Private ending');
    expect(workspace().querySelector('h1')?.textContent).toBe('Second host');
    expect(workspace().querySelector('[data-load-full-markdown]')).toBeNull();
  });

  it.each(['hide', 'close', 'connection'] as const)('aborts the selected Markdown full read on %s and ignores its late result', async (change) => {
    const path = '/work/docs/long.md';
    let resolveFull!: (text: string) => void;
    const pending = new Promise<string>((resolve) => { resolveFull = resolve; });
    const readFull = vi.fn((_path: string, _options?: { signal?: AbortSignal }) => pending);
    connectionMock.activeClient = {
      previewHostFile: async () => ({ text: '# Beginning\n', truncated: true }),
      readHostFile: readFull,
    };
    const probe = makeRoot();
    const props = { tabs: [path, '/work/huge.log'], active: path, dirtyPaths: new Set<string>(), width: 400,
      onActivate: vi.fn(), onClose: vi.fn(), onCloseOthers: vi.fn(), onCloseAll: vi.fn(), onMove: vi.fn(),
      onCollapse: vi.fn(), onWidthChange: vi.fn(), onOpenImage: vi.fn(), reportDirty: vi.fn() };
    await renderSettled(probe.root, <PreviewWorkspace {...props} hidden />);
    expect(readFull).not.toHaveBeenCalled();
    await renderSettled(probe.root, <PreviewWorkspace {...props} />);
    expect(readFull).toHaveBeenCalledTimes(1);
    expect(readFull.mock.calls[0]?.[0]).toBe(path);
    const signal = readFull.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    if (change === 'connection') {
      connectionMock.activeClient = {
        previewHostFile: async () => ({ text: '# Second host\n', truncated: true }),
        readHostFile: async () => '# Second host\n\n# Fresh ending\n',
      };
      await renderSettled(probe.root, <PreviewWorkspace {...props} />);
    } else {
      await renderSettled(probe.root, <PreviewWorkspace {...props} hidden={change === 'hide'} tabs={change === 'close' ? [] : props.tabs} />);
    }
    expect(signal?.aborted).toBe(true);
    await act(async () => { resolveFull('# Stale private ending\n'); });
    expect(probe.container.textContent).not.toContain('Stale private ending');
    if (change === 'connection') expect(probe.container.textContent).toContain('Fresh ending');
    if (change === 'hide') {
      readFull.mockResolvedValueOnce('# Beginning\n\n# Fresh ending\n');
      await renderSettled(probe.root, <PreviewWorkspace {...props} />);
      expect(probe.container.textContent).toContain('Fresh ending');
      expect(probe.container.textContent).not.toContain('Stale private ending');
    }
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('retains rendered Markdown across source switches and applies edits only when shown again', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work">
        <OpenButton path="/work/docs/design.md" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/docs/design.md');
    const heading = workspace().querySelector('h1')!;
    const switchMode = async (mode: 'source' | 'rendered') => {
      await act(async () => { workspace().querySelector<HTMLButtonElement>(`[data-md-mode="${mode}"]`)!.click(); });
    };
    await switchMode('source');
    const editor = workspace().querySelector('[data-testid="editor"]') as HTMLTextAreaElement;
    expect(editor.value).toContain('# Design');
    expect(heading.closest('[hidden]')).not.toBeNull();
    await switchMode('rendered');
    expect(workspace().querySelector('h1')).toBe(heading);
    expect(heading.closest('[hidden]')).toBeNull();
    await switchMode('source');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, '# Edited design\n\nComplete final paragraph.');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(workspace().querySelector('h1')).toBe(heading);
    expect(heading.textContent).toBe('Design');
    await switchMode('rendered');
    expect(workspace().querySelector('h1')?.textContent).toBe('Edited design');
    expect(workspace().textContent).toContain('Complete final paragraph.');
    expect(workspace().querySelector('[data-testid="editor"]')).toBe(editor);
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
    expect(editor.readOnly).toBe(true);
    expect(workspace().querySelector('[data-save-button]')).toBeNull();
    await act(async () => {
      workspace()
        .querySelector('[data-edit-button]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
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
        workspace()
          .querySelector('[data-edit-button]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
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
      workspace()
        .querySelector('[data-edit-button]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
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
    connectionMock.activeClient = connectionMock.defaultClient;
    connectionMock.scopeId = 'local';
    connectionMock.connectionSource = 'desktop';
    connectionMock.config = null;
    hostMock.desktop = false;
    hostMock.revealPath.mockClear();
    hostMock.openPath.mockClear();
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

  it.each([
    ['local', 'desktop' as const, true],
    ['ssh:remote-1', 'ssh' as const, false],
    ['remote:space-1', 'remote' as const, false],
  ])(
    'only offers local file openers on the computer running Kiki (%s)', async (scopeId, source, expected) => {
      hostMock.desktop = true;
      connectionMock.scopeId = scopeId;
      connectionMock.connectionSource = source;
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
      if (expected) {
        await act(async () => {
          menu.querySelector<HTMLButtonElement>('[data-menu-item="copy-absolute"]')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(writeText).toHaveBeenLastCalledWith('/work/src/server.ts');
        await act(async () => {
          workspace().querySelector('[data-preview-tab="/work/src/server.ts"]')!
            .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
        });
        await act(async () => {
          document.querySelector<HTMLButtonElement>('[data-menu-item="show-in-folder"]')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(hostMock.revealPath).toHaveBeenLastCalledWith('/work/src/server.ts');
        await act(async () => {
          workspace().querySelector('[data-preview-tab="/work/src/server.ts"]')!
            .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
        });
        await act(async () => {
          document.querySelector<HTMLButtonElement>('[data-menu-item="open-default-app"]')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(hostMock.openPath).toHaveBeenLastCalledWith('/work/src/server.ts');
      }
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
    connectionMock.connectionSource = 'desktop';
    connectionMock.config = null;
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

  it('plays common audio files with native controls from the original bytes', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work">
        <OpenButton path="/work/audio/sample.mp3" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/audio/sample.mp3');
    await act(async () => { await Promise.resolve(); });
    const panel = workspace().querySelector('[data-preview-tabpanel="/work/audio/sample.mp3"]')!;
    const audio = panel.querySelector<HTMLAudioElement>('audio[data-preview-audio]')!;
    expect(audio.hasAttribute('controls')).toBe(true);
    expect(audio.getAttribute('src')).toBe('blob:mock');
    expect(panel.querySelector('[data-audio-meta]')?.textContent).toBe('4 B');
    expect(panel.querySelector('[data-download-file]')).not.toBeNull();
    expect(panel.querySelector('[data-open-default-app]')).toBeNull();
    expect(panel.querySelector('[data-reveal-file]')).toBeNull();
  });

  it('keeps a real audio read failure visible and retries the original read', async () => {
    const readHostFileBytes = vi.fn()
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue({ bytes: new Uint8Array([1, 2]), mime: 'audio/wav' });
    connectionMock.activeClient = { readHostFileBytes };
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work">
        <OpenButton path="/work/audio/retry.wav" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/audio/retry.wav');
    await act(async () => { await Promise.resolve(); });
    const panel = workspace().querySelector('[data-preview-tabpanel="/work/audio/retry.wav"]')!;
    expect(panel.querySelector('audio[data-preview-audio]')).toBeNull();
    expect(panel.querySelector('[data-preview-reload]')).not.toBeNull();
    await act(async () => {
      panel.querySelector<HTMLButtonElement>('[data-preview-reload]')!.click();
      await Promise.resolve();
    });
    expect(readHostFileBytes).toHaveBeenCalledTimes(2);
    expect(panel.querySelector('audio[data-preview-audio]')).not.toBeNull();
  });

  it('drops old audio bytes before a client or scope change resolves', async () => {
    let resolveSecond!: (value: { bytes: Uint8Array; mime: string }) => void;
    const firstClient = { readHostFileBytes: vi.fn(async () => ({ bytes: new Uint8Array([1]), mime: 'audio/mpeg' })) };
    const secondClient = {
      readHostFileBytes: vi.fn(() => new Promise<{ bytes: Uint8Array; mime: string }>((resolve) => { resolveSecond = resolve; })),
    };
    connectionMock.activeClient = firstClient;
    const probe = makeRoot();
    const view = () => (
      <MediaPreviewProvider cwd="/work">
        <OpenButton path="/work/audio/scope-change.mp3" />
      </MediaPreviewProvider>
    );
    await renderSettled(probe.root, view());
    await openFile(probe.container, '/work/audio/scope-change.mp3');
    await act(async () => { await Promise.resolve(); });
    const panel = workspace().querySelector('[data-preview-tabpanel="/work/audio/scope-change.mp3"]')!;
    expect(panel.querySelector('audio[data-preview-audio]')).not.toBeNull();

    connectionMock.scopeId = 'ssh:remote-2';
    connectionMock.activeClient = secondClient;
    await renderSettled(probe.root, view());
    expect(panel.querySelector('audio[data-preview-audio]')).toBeNull();
    expect(panel.querySelector('[data-preview-audio-retry]')).toBeNull();
    await act(async () => {
      resolveSecond({ bytes: new Uint8Array([2]), mime: 'audio/mpeg' });
      await Promise.resolve();
    });
    expect(panel.querySelector('audio[data-preview-audio]')).not.toBeNull();
  });

  it.each([
    ['local', 'desktop' as const, true],
    ['ssh:remote-1', 'ssh' as const, false],
    ['remote:space-1', 'remote' as const, false],
  ])(
    'gates the video tab opener pair by scope, beside the download anchor (%s)',
    async (scopeId, source, expected) => {
      hostMock.desktop = true;
      connectionMock.scopeId = scopeId;
      connectionMock.connectionSource = source;
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

  it('leaves unselected office and video tabs idle, then plays a video url and cancels it', async () => {
    const documentPreview = vi.fn(async (_session?: string, _request?: unknown, _signal?: AbortSignal) => ({
      kind: 'missing_dependency',
      dependency: 'officecli',
      source: { kind: 'workspace', name: 'deck.pptx', media_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: 4 },
      message: 'The kiki-office plugin is not installed.',
      recovery: { kind: 'install-prerequisite', plugin_id: 'kiki-office', prerequisite_id: 'officecli', consent_required: true, plugin_state: 'not-installed' },
      read_only: true,
    }));
    let resolveOpen: ((value: { preview_id: string; url: string; mime: string; size: number; expires_at: number }) => void) | undefined;
    const openHostMediaPreview = vi.fn(() => new Promise<{ preview_id: string; url: string; mime: string; size: number; expires_at: number }>((resolve) => { resolveOpen = resolve; }));
    const closeHostMediaPreview = vi.fn(async () => undefined);
    const readHostFileBytes = vi.fn(async (_path?: string, _options?: { signal?: AbortSignal }) => ({ bytes: new Uint8Array([0, 0, 0, 24]), mime: 'video/mp4' }));
    connectionMock.activeClient = {
      ...(connectionMock.defaultClient as object),
      documentPreview,
      openHostMediaPreview,
      closeHostMediaPreview,
      readHostFileBytes,
    };
    const props = {
      tabs: ['/work/docs/design.md', '/work/clips/intro.mp4', '/work/deck.pptx'],
      active: '/work/docs/design.md',
      dirtyPaths: new Set<string>(),
      width: 400,
      sessionId: 'session',
      onActivate: vi.fn(),
      onClose: vi.fn(),
      onCloseOthers: vi.fn(),
      onCloseAll: vi.fn(),
      onMove: vi.fn(),
      onCollapse: vi.fn(),
      onWidthChange: vi.fn(),
      onOpenImage: vi.fn(),
      reportDirty: vi.fn(),
    };
    const probe = makeRoot();
    await renderSettled(probe.root, <PreviewWorkspace {...props} />);
    expect(documentPreview).not.toHaveBeenCalled();
    expect(openHostMediaPreview).not.toHaveBeenCalled();
    await renderSettled(probe.root, <PreviewWorkspace {...props} active="/work/clips/intro.mp4" />);
    expect(openHostMediaPreview).toHaveBeenCalledTimes(1);
    expect(documentPreview).not.toHaveBeenCalled();
    await act(async () => {
      resolveOpen?.({ preview_id: 'cap', url: 'http://127.0.0.1:9/media-preview/cap', mime: 'video/mp4', size: 8, expires_at: Date.now() + 60_000 });
    });
    const video = () => workspace().querySelector<HTMLVideoElement>('video[data-preview-video]');
    expect(video()?.getAttribute('src')).toBe('http://127.0.0.1:9/media-preview/cap');
    await act(async () => { video()?.dispatchEvent(new Event('error')); });
    expect(readHostFileBytes).toHaveBeenCalledTimes(1);
    expect(video()?.getAttribute('src')).toBe('blob:mock');
    expect(closeHostMediaPreview).toHaveBeenCalledWith('cap');
    await renderSettled(probe.root, <PreviewWorkspace {...props} active="/work/deck.pptx" />);
    expect(documentPreview).toHaveBeenCalledTimes(1);
    let rejectPreview: ((error: Error) => void) | undefined;
    documentPreview.mockImplementation((_session?: string, _request?: unknown, previewSignal?: AbortSignal) => new Promise((_resolve, reject) => {
      rejectPreview = reject;
      previewSignal?.addEventListener('abort', () => { reject(new Error('cancelled')); });
    }));
    await renderSettled(probe.root, <PreviewWorkspace {...props} active="/work/docs/design.md" />);
    expect(documentPreview.mock.calls.at(-1)?.[2]?.aborted).toBe(true);
    await act(async () => { probe.root.unmount(); });
    expect(readHostFileBytes.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    rejectPreview?.(new Error('cancelled'));
  });

  it('does not render a closed office tab when the same path is reopened unselected', async () => {
    const documentPreview = vi.fn(async () => ({
      kind: 'missing_dependency',
      dependency: 'officecli',
      source: { kind: 'workspace', name: 'deck.pptx', media_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: 4 },
      message: 'The kiki-office plugin is not installed.',
      recovery: { kind: 'install-prerequisite', plugin_id: 'kiki-office', prerequisite_id: 'officecli', consent_required: true, plugin_state: 'not-installed' },
      read_only: true,
    }));
    connectionMock.activeClient = { ...(connectionMock.defaultClient as object), documentPreview };
    const base = {
      dirtyPaths: new Set<string>(),
      width: 400,
      sessionId: 'session',
      onActivate: vi.fn(),
      onClose: vi.fn(),
      onCloseOthers: vi.fn(),
      onCloseAll: vi.fn(),
      onMove: vi.fn(),
      onCollapse: vi.fn(),
      onWidthChange: vi.fn(),
      onOpenImage: vi.fn(),
      reportDirty: vi.fn(),
    };
    const probe = makeRoot();
    await renderSettled(probe.root, <PreviewWorkspace {...base} tabs={['/work/docs/design.md', '/work/deck.pptx']} active="/work/docs/design.md" />);
    expect(documentPreview).not.toHaveBeenCalled();
    await renderSettled(probe.root, <PreviewWorkspace {...base} tabs={['/work/docs/design.md']} active="/work/docs/design.md" />);
    await renderSettled(probe.root, <PreviewWorkspace {...base} tabs={['/work/docs/design.md', '/work/deck.pptx']} active="/work/docs/design.md" />);
    expect(documentPreview).not.toHaveBeenCalled();
    await renderSettled(probe.root, <PreviewWorkspace {...base} tabs={['/work/docs/design.md', '/work/deck.pptx']} active="/work/deck.pptx" />);
    expect(documentPreview).toHaveBeenCalledTimes(1);
  });

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
    expect(panel.textContent).toContain('This kind of file cannot be previewed yet.');
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
        <OpenButton path="src/server.ts" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, 'src/server.ts');
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
    await act(async () => { image.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })); });
    expect(document.querySelector('[data-menu-item="copy-image"]')).not.toBeNull();
    expect(document.querySelector('[data-menu-item="copy-path"]')).not.toBeNull();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await act(async () => { panel.querySelector<HTMLButtonElement>('button[aria-label="View image"]')!.click(); });
    const viewer = document.querySelector('[role="dialog"]')!;
    await act(async () => { viewer.querySelector('img')!.dispatchEvent(new Event('load')); });
    await act(async () => { viewer.querySelector('img')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })); });
    expect(document.querySelector('[data-menu-item="copy-path"]')).not.toBeNull();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-menu-item="show-in-folder"]')!.click(); });
    expect(hostMock.revealPath).toHaveBeenCalledWith('/work/shots/screen.png');
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
    connectionMock.activeClient = connectionMock.defaultClient;
    connectionMock.connectionSource = 'desktop';
    hostMock.desktop = false;
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
    expect(htmlPreviewMock.open).toHaveBeenCalledWith({ path: '/work/page.html', workspace_root: '/work' });

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

  it('opens a Windows HTML path outside the workspace with Chinese and spaces without choosing a directory', async () => {
    hostMock.desktop = true;
    const path = 'C:\\Users\\测试 用户\\HTML 预览\\page.html';
    const cwd = 'C:\\workspace\\session';
    const probe = await mountHtmlTab(path, cwd);
    expect(htmlPreviewMock.open).toHaveBeenCalledWith({ path, workspace_root: cwd });
    expect(probe.container.querySelector('[data-preview-html]')).not.toBeNull();
  });

  it('reports a local path-outside-root refusal without offering a root input', async () => {
    htmlPreviewMock.open.mockRejectedValueOnce(new Error('preview_path_outside_root'));
    const probe = await mountHtmlTab();
    const error = probe.container.querySelector<HTMLElement>('[data-html-preview-error="path_outside_root"]');
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain('document resource root');
    expect(error?.querySelector('[data-html-root-input]')).toBeNull();
  });

  it('allows a remote broker path-outside-root retry with a target-machine root', async () => {
    connectionMock.connectionSource = 'remote';
    const path = '/remote/reports/page.html';
    const workspaceRoot = '/remote/workspace';
    htmlPreviewMock.open.mockRejectedValueOnce(new Error('preview_path_outside_root'));
    const probe = await mountHtmlTab(path, workspaceRoot);
    const error = probe.container.querySelector<HTMLElement>('[data-html-preview-error="path_outside_root"]');
    expect(error).not.toBeNull();
    const input = error!.querySelector<HTMLInputElement>('[data-html-root-input]')!;
    expect(input.value).toBe(workspaceRoot);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, '/remote/reports');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { error!.querySelector<HTMLButtonElement>('[data-html-root-retry]')!.click(); });
    await settle();
    expect(htmlPreviewMock.open).toHaveBeenLastCalledWith({ path, root: '/remote/reports' });
    expect(probe.container.querySelector('[data-preview-html]')).not.toBeNull();
  });

  it('does not reuse an explicit root when the remote client changes for the same path and cwd', async () => {
    connectionMock.connectionSource = 'remote';
    const path = '/remote/reports/page.html';
    const cwd = '/remote/workspace';
    htmlPreviewMock.open
      .mockRejectedValueOnce(new Error('preview_path_outside_root'))
      .mockRejectedValueOnce(new Error('preview_path_outside_root'));
    const probe = await mountHtmlTab(path, cwd);
    const error = probe.container.querySelector<HTMLElement>('[data-html-preview-error="path_outside_root"]')!;
    const input = error.querySelector<HTMLInputElement>('[data-html-root-input]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, '/remote/old-root');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { error.querySelector<HTMLButtonElement>('[data-html-root-retry]')!.click(); });
    await settle();
    expect(htmlPreviewMock.open).toHaveBeenLastCalledWith({ path, root: '/remote/old-root' });

    const secondOpen = vi.fn(async () => ({
      preview_id: 'second-client-preview',
      url: previewUrl,
      expires_at: Date.now() + 30 * 60 * 1000,
      sandbox: HTML_PREVIEW_SANDBOX,
    }));
    const secondClose = vi.fn(async () => {});
    connectionMock.activeClient = {
      ...(connectionMock.defaultClient as object),
      openHtmlPreview: secondOpen,
      closeHtmlPreview: secondClose,
    };
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd={cwd}>
        <OpenButton path={path} />
      </MediaPreviewProvider>,
    );
    await settle();
    expect(secondOpen).toHaveBeenCalledWith({ path, workspace_root: cwd });
  });

  it('does not offer a root input for a direct SSH path-outside-root refusal', async () => {
    connectionMock.connectionSource = 'ssh';
    htmlPreviewMock.open.mockRejectedValueOnce(new Error('preview_path_outside_root'));
    const probe = await mountHtmlTab('/ssh/page.html', '/ssh/workspace');
    const error = probe.container.querySelector<HTMLElement>('[data-html-preview-error="path_outside_root"]');
    expect(error).not.toBeNull();
    expect(error?.querySelector('[data-html-root-input]')).toBeNull();
  });

  it('reports the remote target-owner refusal as unavailable authorization without a root input', async () => {
    connectionMock.connectionSource = 'remote';
    htmlPreviewMock.open.mockRejectedValueOnce(new Error('html_preview_target_owner_grant_required'));
    const probe = await mountHtmlTab();
    const error = probe.container.querySelector<HTMLElement>('[data-html-preview-error="remote_grant_required"]');
    expect(error).not.toBeNull();
    expect(error?.querySelector('[data-html-root-input]')).toBeNull();
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


describe('PreviewWorkspace tab keyboard & menu focus', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    connectionMock.activeClient = {
      ...(connectionMock.defaultClient as object),
      readBuiltinSkill: async () => '# Example skill\n\nReading text.',
    };
  });
  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => { root.unmount(); });
    }
    for (const container of containers.splice(0)) container.remove();
    document.body.innerHTML = '';
  });

  function renderWorkspace(options: {
    tabs: readonly (string | { kind: 'skill'; name: string })[];
    active: string;
    onActivate?: (key: string) => void;
  }) {
    const probe = makeRoot();
    const onActivate = options.onActivate ?? vi.fn();
    return renderSettled(
      probe.root,
      <PreviewWorkspace
        tabs={options.tabs}
        active={options.active}
        dirtyPaths={new Set()}
        width={400}
        onActivate={onActivate}
        onClose={vi.fn()}
        onCloseOthers={vi.fn()}
        onCloseAll={vi.fn()}
        onMove={vi.fn()}
        onCollapse={vi.fn()}
        onWidthChange={vi.fn()}
        onOpenImage={vi.fn()}
        reportDirty={vi.fn()}
        scrollPositions={{}}
        onScrollPosition={vi.fn()}
      />,
    ).then(() => ({ probe, onActivate }));
  }

  it('file tabs take keyboard focus and Enter / Space activate them', async () => {
    const onActivate = vi.fn();
    await renderWorkspace({
      tabs: ['/work/src/server.ts', '/work/docs/design.md'],
      active: '/work/docs/design.md',
      onActivate,
    });
    const tab = workspace().querySelector<HTMLElement>('[data-preview-tab="/work/src/server.ts"]')!;
    expect(tab.getAttribute('tabindex')).toBe('0');
    await act(async () => { tab.focus(); });
    expect(document.activeElement).toBe(tab);
    await act(async () => { tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(onActivate).toHaveBeenCalledWith('file:/work/src/server.ts');
    await act(async () => { tab.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); });
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it('skill tabs activate from the keyboard the same way', async () => {
    const onActivate = vi.fn();
    await renderWorkspace({
      tabs: [{ kind: 'skill', name: 'example' }, '/work/docs/design.md'],
      active: '/work/docs/design.md',
      onActivate,
    });
    const tab = workspace().querySelector<HTMLElement>('[data-preview-tab="skill:builtin:example"]')!;
    expect(tab.getAttribute('tabindex')).toBe('0');
    await act(async () => { tab.focus(); });
    await act(async () => { tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(onActivate).toHaveBeenCalledWith('skill:builtin:example');
  });

  it('Enter on the inner close button is not read as a tab activation', async () => {
    const onActivate = vi.fn();
    await renderWorkspace({
      tabs: ['/work/src/server.ts', '/work/docs/design.md'],
      active: '/work/docs/design.md',
      onActivate,
    });
    const closeButton = workspace().querySelector<HTMLElement>('[data-preview-tab="/work/src/server.ts"] button[aria-label]')!;
    await act(async () => { closeButton.focus(); });
    await act(async () => { closeButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('tab menu opens with focus inside, cycles, and Escape hands focus back to the tab', async () => {
    await renderWorkspace({
      tabs: ['/work/src/server.ts', '/work/docs/design.md'],
      active: '/work/src/server.ts',
    });
    const tab = workspace().querySelector<HTMLElement>('[data-preview-tab="/work/docs/design.md"]')!;
    await act(async () => { tab.focus(); });
    await act(async () => { tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); });
    const menu = document.querySelector<HTMLElement>('[data-preview-tab-menu]')!;
    expect(menu).not.toBeNull();
    expect(anyOverlayOpen()).toBe(true);
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    expect(items.length).toBeGreaterThan(1);
    expect(document.activeElement).toBe(items[0]);
    await act(async () => { items[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(document.activeElement).toBe(items[1]);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(document.querySelector('[data-preview-tab-menu]')).toBeNull();
    expect(anyOverlayOpen()).toBe(false);
    expect(document.activeElement).toBe(tab);
  });

  it('renders ResourceTab for HTML (sandboxed origin) and unsupported binaries, and WebTab for external URLs without falling back to host paths on missing blobs (#33)', async () => {
    htmlPreviewMock.open.mockReset();
    htmlPreviewMock.open.mockResolvedValue({
      preview_id: 'prev-html-1',
      url: 'http://prev-html-1.kiki-document.localhost:59999/html-preview/prev-html-1/index.html',
      sandbox: HTML_PREVIEW_SANDBOX,
      expires_at: Date.now() + 60_000,
    });
    const probe = makeRoot();
    const htmlTab = {
      kind: 'resource' as const,
      size: 1024,
      resource: {
        source: {
          kind: 'session-copy' as const,
          sessionId: 'sess-1',
          fileId: 'blobref:main:html1',
          sourceId: 'a'.repeat(64),
        },
        origin: { path: '/work/slides/index.html', trusted: true },
        type: 'html' as const,
        name: 'index.html',
        mime: 'text/html',
      },
    };
    const zipTab = {
      kind: 'resource' as const,
      size: 2048,
      resource: {
        source: {
          kind: 'session-copy' as const,
          sessionId: 'sess-1',
          fileId: 'blobref:main:zip1',
        },
        type: 'unsupported' as const,
        name: 'bundle.zip',
        mime: 'application/zip',
      },
    };
    const webTab = {
      kind: 'web' as const,
      url: 'https://docs.example.com/guide',
      title: 'Guide',
    };
    await renderSettled(
      probe.root,
      <PreviewWorkspace
        tabs={[htmlTab, zipTab, webTab]}
        active={`attachment:sess-1:${encodeURIComponent('blobref:main:html1')}:${'a'.repeat(64)}`}
        dirtyPaths={new Set()}
        width={420}
        cwd="/work"
        sessionId="sess-1"
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onCloseOthers={vi.fn()}
        onCloseAll={vi.fn()}
        onMove={vi.fn()}
        onCollapse={vi.fn()}
        onWidthChange={vi.fn()}
        onOpenImage={vi.fn()}
        reportDirty={vi.fn()}
      />,
    );
    expect(htmlPreviewMock.open).toHaveBeenCalledWith({
      session_id: 'sess-1',
      file_id: 'blobref:main:html1',
      source_id: 'a'.repeat(64),
      name: 'index.html',
    });
    expect(htmlPreviewMock.open).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: '/work/slides/index.html' }),
    );
    const htmlFrame = workspace().querySelector<HTMLIFrameElement>('iframe[data-preview-html]');
    expect(htmlFrame).not.toBeNull();
    expect(htmlFrame?.getAttribute('src')).toBe('http://prev-html-1.kiki-document.localhost:59999/html-preview/prev-html-1/index.html');
    expect(htmlFrame?.getAttribute('sandbox')).toBe(HTML_PREVIEW_SANDBOX);

    await renderSettled(
      probe.root,
      <PreviewWorkspace
        tabs={[htmlTab, zipTab, webTab]}
        active={`attachment:sess-1:${encodeURIComponent('blobref:main:zip1')}`}
        dirtyPaths={new Set()}
        width={420}
        cwd="/work"
        sessionId="sess-1"
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onCloseOthers={vi.fn()}
        onCloseAll={vi.fn()}
        onMove={vi.fn()}
        onCollapse={vi.fn()}
        onWidthChange={vi.fn()}
        onOpenImage={vi.fn()}
        reportDirty={vi.fn()}
      />,
    );
    expect(workspace().querySelector('[data-preview-unsupported]')).not.toBeNull();

    await renderSettled(
      probe.root,
      <PreviewWorkspace
        tabs={[htmlTab, zipTab, webTab]}
        active="web:https://docs.example.com/guide"
        dirtyPaths={new Set()}
        width={420}
        cwd="/work"
        sessionId="sess-1"
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onCloseOthers={vi.fn()}
        onCloseAll={vi.fn()}
        onMove={vi.fn()}
        onCollapse={vi.fn()}
        onWidthChange={vi.fn()}
        onOpenImage={vi.fn()}
        reportDirty={vi.fn()}
      />,
    );
    const webFrame = workspace().querySelector<HTMLIFrameElement>('iframe[data-preview-web]');
    expect(webFrame).not.toBeNull();
    expect(webFrame?.getAttribute('src')).toBe('https://docs.example.com/guide');
    expect(webFrame?.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-popups');
    expect(webFrame?.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(workspace().querySelector('[data-web-open-external]')).not.toBeNull();
  });
});

describe('PreviewWorkspace attachment actions & copy marking (#29)', () => {
  const writeText = vi.fn(async () => {});

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    FILES['/work/docs/sub/notes.md'] = '# Notes\n\nLive version.\n';
    connectionMock.activeClient = connectionMock.defaultClient;
    connectionMock.scopeId = 'local';
    connectionMock.connectionSource = 'desktop';
    connectionMock.config = null;
    hostMock.desktop = false;
    hostMock.revealPath.mockClear();
    hostMock.openPath.mockClear();
    sessionMediaMock.bytesById = {};
    sessionMediaMock.documentPreview.mockReset();
    writeText.mockClear();
    resetDraftMemoryForTests();
    clearStoredDrafts();
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:attachment-mock');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => { root.unmount(); });
    }
    for (const container of containers.splice(0)) container.remove();
    document.body.innerHTML = '';
    localStorage.removeItem('kiki.locale');
    vi.restoreAllMocks();
  });

  async function settle() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function AttachmentHarness({
    item,
  }: {
    item: {
      readonly kind: 'file' | 'image';
      readonly fileId?: string;
      readonly sourceId?: string;
      readonly path?: string;
      readonly name?: string;
      readonly mime?: string;
      readonly origin?: { readonly path: string; readonly trusted: true };
    };
  }) {
    const preview = useMediaPreview()!;
    return (
      <div>
        <button
          type="button"
          data-open-attachment
          onClick={() => { preview.openAttachmentInWorkspace?.(item); }}
        >
          open attachment
        </button>
        <button
          type="button"
          data-open-live
          onClick={() => { preview.openFile('/work/docs/sub/notes.md'); }}
        >
          open live
        </button>
      </div>
    );
  }

  it('offers copy path, show on this computer, open original file and @ on local desktop with trusted origin; only copy path in remote space; none without source_id', async () => {
    sessionMediaMock.bytesById['blobref:main:notes1'] = {
      bytes: new TextEncoder().encode('# Sent copy\n'),
      mime: 'text/markdown',
      name: 'notes.md',
    };
    const trustedOrigin = { path: '/work/docs/sub/notes.md', trusted: true as const };
    const sentWithOrigin = {
      kind: 'file' as const,
      fileId: 'blobref:main:notes1',
      sourceId: 'b'.repeat(64),
      name: 'notes.md',
      mime: 'text/markdown',
      origin: trustedOrigin,
    };

    // 1. Local desktop with source_id + trusted origin
    hostMock.desktop = true;
    connectionMock.connectionSource = 'desktop';
    connectionMock.scopeId = 'local';
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work" sessionId="sess-29">
        <AttachmentHarness item={sentWithOrigin} />
      </MediaPreviewProvider>,
    );
    await act(async () => {
      probe.container.querySelector<HTMLButtonElement>('[data-open-attachment]')!.click();
    });
    await settle();

    const tab = workspace().querySelector<HTMLElement>('[data-preview-tab="blobref:main:notes1"]')!;
    expect(tab.querySelector('[data-preview-copy-badge]')?.textContent).toBe('Sent copy');
    const mentionBtn = tab.querySelector<HTMLButtonElement>('[data-mention-file="/work/docs/sub/notes.md"]');
    expect(mentionBtn).not.toBeNull();
    await act(async () => { mentionBtn!.click(); });
    expect(readDraft('sess-29')).toContain('@docs/sub/notes.md');

    await act(async () => {
      tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    const tabMenu = document.querySelector<HTMLElement>('[data-preview-tab-menu]')!;
    expect(tabMenu.querySelector('[data-menu-item="copy-absolute"]')).not.toBeNull();
    expect(tabMenu.querySelector('[data-menu-item="show-in-folder"]')?.textContent).toBe('Show on this computer');
    expect(tabMenu.querySelector('[data-menu-item="open-default-app"]')?.textContent).toBe('Open original file');
    await act(async () => {
      tabMenu.querySelector<HTMLButtonElement>('[data-menu-item="open-default-app"]')!.click();
    });
    expect(hostMock.openPath).toHaveBeenCalledWith('/work/docs/sub/notes.md');

    const moreBtn = workspace().querySelector<HTMLButtonElement>('[data-attachment-more]')!;
    expect(moreBtn).not.toBeNull();
    await act(async () => { moreBtn.click(); });
    const moreMenu = document.querySelector<HTMLElement>('[data-attachment-more-menu]')!;
    expect(moreMenu.querySelector('[data-menu-item="copy-absolute"]')).not.toBeNull();
    expect(moreMenu.querySelector('[data-menu-item="show-in-folder"]')?.textContent).toBe('Show on this computer');
    expect(moreMenu.querySelector('[data-menu-item="open-default-app"]')?.textContent).toBe('Open original file');
    await act(async () => {
      moreMenu.querySelector<HTMLButtonElement>('[data-menu-item="show-in-folder"]')!.click();
    });
    expect(hostMock.revealPath).toHaveBeenCalledWith('/work/docs/sub/notes.md');

    // 2. Remote space with trusted origin: copy path stays, desktop openers disappear
    connectionMock.connectionSource = 'remote';
    connectionMock.scopeId = 'remote:space-29';
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work" sessionId="sess-29">
        <AttachmentHarness item={sentWithOrigin} />
      </MediaPreviewProvider>,
    );
    await act(async () => {
      workspace().querySelector<HTMLElement>('[data-preview-tab="blobref:main:notes1"]')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    const remoteMenu = document.querySelector<HTMLElement>('[data-preview-tab-menu]')!;
    expect(remoteMenu.querySelector('[data-menu-item="copy-absolute"]')).not.toBeNull();
    expect(remoteMenu.querySelector('[data-menu-item="show-in-folder"]')).toBeNull();
    expect(remoteMenu.querySelector('[data-menu-item="open-default-app"]')).toBeNull();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });

    // 3. Without source_id / trusted origin: none of copy path, show, open, or @
    connectionMock.connectionSource = 'desktop';
    connectionMock.scopeId = 'local';
    const probeNoOrigin = makeRoot();
    const sentWithoutOrigin = {
      kind: 'file' as const,
      fileId: 'blobref:main:notes1',
      name: 'notes.md',
      mime: 'text/markdown',
    };
    await renderSettled(
      probeNoOrigin.root,
      <MediaPreviewProvider cwd="/work" sessionId="sess-29">
        <AttachmentHarness item={sentWithoutOrigin} />
      </MediaPreviewProvider>,
    );
    await act(async () => {
      probeNoOrigin.container.querySelector<HTMLButtonElement>('[data-open-attachment]')!.click();
    });
    await settle();
    const untrustedTab = probeNoOrigin.container.querySelector<HTMLElement>('[data-preview-tab="blobref:main:notes1"]')!;
    expect(untrustedTab.querySelector('[data-mention-file]')).toBeNull();
    await act(async () => {
      untrustedTab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    const untrustedMenu = document.querySelector<HTMLElement>('[data-preview-tab-menu]')!;
    expect(untrustedMenu.querySelector('[data-menu-item="copy-absolute"]')).toBeNull();
    expect(untrustedMenu.querySelector('[data-menu-item="show-in-folder"]')).toBeNull();
    expect(untrustedMenu.querySelector('[data-menu-item="open-default-app"]')).toBeNull();
  });

  it('keeps live file and sent copy as two tabs, labels the copy in zh, and Open current file activates the live tab', async () => {
    sessionMediaMock.bytesById['blobref:main:notes2'] = {
      bytes: new TextEncoder().encode('# Sent snapshot\n'),
      mime: 'text/markdown',
      name: 'notes.md',
    };
    const trustedOrigin = { path: '/work/docs/sub/notes.md', trusted: true as const };
    const sentItem = {
      kind: 'file' as const,
      fileId: 'blobref:main:notes2',
      sourceId: 'c'.repeat(64),
      name: 'notes.md',
      mime: 'text/markdown',
      origin: trustedOrigin,
    };
    localStorage.setItem('kiki.locale', 'zh');
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work" sessionId="sess-zh">
        <AttachmentHarness item={sentItem} />
      </MediaPreviewProvider>,
    );
    await act(async () => {
      probe.container.querySelector<HTMLButtonElement>('[data-open-live]')!.click();
      probe.container.querySelector<HTMLButtonElement>('[data-open-attachment]')!.click();
    });
    await settle();

    const allTabs = probe.container.querySelectorAll('[role="tab"]');
    expect(allTabs).toHaveLength(2);
    const copyTab = probe.container.querySelector<HTMLElement>('[data-preview-tab="blobref:main:notes2"]')!;
    expect(copyTab.querySelector('[data-preview-copy-badge]')?.textContent).toBe('副本');
    expect(probe.container.querySelector('[data-preview-copy-notice]')?.textContent).toBe('发送时的副本');

    const openCurrentBtn = probe.container.querySelector<HTMLButtonElement>('[data-open-current-file]')!;
    expect(openCurrentBtn.textContent).toBe('打开现在的文件');
    await act(async () => { openCurrentBtn.click(); });
    const liveTab = probe.container.querySelector<HTMLElement>('[data-preview-tab="/work/docs/sub/notes.md"]')!;
    expect(liveTab.getAttribute('aria-selected')).toBe('true');
  });

  it('resolves relative Markdown images against the trusted origin directory and renders header download on document attachments', async () => {
    sessionMediaMock.bytesById['blobref:main:mdimg'] = {
      bytes: new TextEncoder().encode('# Doc\n\n![Diagram](./diagram.png)\n'),
      mime: 'text/markdown',
      name: 'notes.md',
    };
    const trustedOrigin = { path: '/work/docs/sub/notes.md', trusted: true as const };
    const mdItem = {
      kind: 'file' as const,
      fileId: 'blobref:main:mdimg',
      sourceId: 'd'.repeat(64),
      name: 'notes.md',
      mime: 'text/markdown',
      origin: trustedOrigin,
    };
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work" sessionId="sess-md">
        <AttachmentHarness item={mdItem} />
      </MediaPreviewProvider>,
    );
    await act(async () => {
      probe.container.querySelector<HTMLButtonElement>('[data-open-attachment]')!.click();
    });
    await settle();
    const img = probe.container.querySelector<HTMLImageElement>('img[alt="Diagram"]');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('blob:attachment-mock');

    // Document attachment (CSV / Office / PDF) shows download button in ready header
    sessionMediaMock.documentPreview.mockResolvedValue({
      kind: 'text',
      fidelity: 'source',
      format: 'csv',
      source: { kind: 'session-media', name: 'report.csv', media_type: 'text/csv', size: 12 },
      content: 'col1,col2\n1,2\n',
      offset: 0,
      truncated: false,
      read_only: true,
    });
    const csvProbe = makeRoot();
    await renderSettled(
      csvProbe.root,
      <MediaPreviewProvider cwd="/work" sessionId="sess-doc">
        <AttachmentHarness
          item={{
            kind: 'file',
            fileId: 'blobref:main:csv1',
            sourceId: 'e'.repeat(64),
            name: 'report.csv',
            mime: 'text/csv',
          }}
        />
      </MediaPreviewProvider>,
    );
    await act(async () => {
      csvProbe.container.querySelector<HTMLButtonElement>('[data-open-attachment]')!.click();
    });
    await settle();
    expect(csvProbe.container.querySelector('[data-download-file]')).not.toBeNull();
  });

  it('omits download and @ when reading an attachment or file fails', async () => {
    const trustedOrigin = { path: '/work/docs/sub/notes.md', trusted: true as const };
    const missingAttachment = {
      kind: 'file' as const,
      fileId: 'blobref:main:missing',
      sourceId: 'f'.repeat(64),
      name: 'notes.md',
      mime: 'text/markdown',
      origin: trustedOrigin,
    };
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work" sessionId="sess-fail">
        <AttachmentHarness item={missingAttachment} />
      </MediaPreviewProvider>,
    );
    await act(async () => {
      probe.container.querySelector<HTMLButtonElement>('[data-open-attachment]')!.click();
    });
    await settle();

    expect(probe.container.querySelector('[data-preview-attachment-error]')).not.toBeNull();
    expect(probe.container.querySelector('[data-download-file]')).toBeNull();
    expect(probe.container.querySelector('[data-mention-file]')).toBeNull();
  });

  it('gates desktop editing behind Edit and shows read-only reasons for non-UTF-8, truncated, or unknown extension-less files while hiding Edit on SSH (#31)', async () => {
    const baseClient = connectionMock.defaultClient as {
      previewHostFile: (path: string) => Promise<{ text: string; truncated: boolean; lossless?: boolean }>;
      [key: string]: unknown;
    };
    connectionMock.activeClient = {
      ...baseClient,
      previewHostFile: (path: string) => {
        if (path === '/work/legacy-gbk.txt') {
          return Promise.resolve({ text: '\ufffd\ufffd', truncated: false, lossless: false });
        }
        if (path === '/work/elf-bin') {
          return Promise.resolve({ text: '\x7fELF\ufffd', truncated: false, lossless: false });
        }
        if (path === '/work/Makefile') {
          return Promise.resolve({ text: 'all:\n\techo ok\n', truncated: false, lossless: true });
        }
        return baseClient.previewHostFile(path);
      },
    };
    hostMock.desktop = true;

    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work" sessionId="sess-edit">
        <OpenButton path="/work/legacy-gbk.txt" />
        <OpenButton path="/work/elf-bin" />
        <OpenButton path="/work/Makefile" />
      </MediaPreviewProvider>,
    );
    await openFile(probe.container, '/work/legacy-gbk.txt');
    await settle();
    const gbkPanel = probe.container.querySelector<HTMLElement>('[data-preview-tabpanel="/work/legacy-gbk.txt"]')!;
    expect(gbkPanel.querySelector('[data-edit-button]')).toBeNull();
    expect(gbkPanel.querySelector('[data-save-button]')).toBeNull();
    expect(gbkPanel.querySelector('[data-readonly-reason]')?.textContent).toBe('Read-only: not UTF-8 text');
    expect(gbkPanel.textContent).not.toContain('Open in the desktop app to edit.');

    await openFile(probe.container, '/work/elf-bin');
    await settle();
    const elfPanel = probe.container.querySelector<HTMLElement>('[data-preview-tabpanel="/work/elf-bin"]')!;
    expect(elfPanel.querySelector('[data-edit-button]')).toBeNull();
    expect(elfPanel.querySelector('[data-readonly-reason]')?.textContent).toBe('Read-only: not UTF-8 text');

    await openFile(probe.container, '/work/Makefile');
    await settle();
    const makePanel = probe.container.querySelector<HTMLElement>('[data-preview-tabpanel="/work/Makefile"]')!;
    expect(makePanel.querySelector('[data-edit-button]')?.textContent).toBe('Edit');
    expect(makePanel.querySelector<HTMLTextAreaElement>('[data-testid="editor"]')!.readOnly).toBe(true);
    await act(async () => {
      makePanel.querySelector<HTMLButtonElement>('[data-edit-button]')!.click();
    });
    expect(makePanel.querySelector<HTMLTextAreaElement>('[data-testid="editor"]')!.readOnly).toBe(false);
    expect(makePanel.querySelector('[data-save-button]')).not.toBeNull();

    // SSH space never shows Edit or desktop read-only reason
    connectionMock.scopeId = 'ssh:dev-box';
    localStorage.setItem('kiki.locale', 'zh');
    const sshProbe = makeRoot();
    await renderSettled(
      sshProbe.root,
      <MediaPreviewProvider cwd="/work" sessionId="sess-ssh">
        <OpenButton path="/work/src/server.ts" />
      </MediaPreviewProvider>,
    );
    await openFile(sshProbe.container, '/work/src/server.ts');
    await settle();
    expect(sshProbe.container.querySelector('[data-edit-button]')).toBeNull();
    expect(sshProbe.container.querySelector('[data-save-button]')).toBeNull();
    expect(sshProbe.container.querySelector('[data-readonly-reason]')).toBeNull();
  });

  it('distinguishes 404, 403, 409, and remote-unreadable sentences while hiding download and @ on failed reads (#32)', async () => {
    const codedError = (code: number, error: string, status: number) =>
      Object.assign(new Error(error), { code, error, status });
    const baseClient = connectionMock.defaultClient as Record<string, unknown>;
    connectionMock.activeClient = {
      ...baseClient,
      previewHostFile: (path: string) => {
        if (path === '/work/missing.ts') return Promise.reject(codedError(40409, 'FS_PATH_NOT_FOUND', 404));
        if (path === '/work/secret.ts') return Promise.reject(codedError(40411, 'FS_PERMISSION_DENIED', 403));
        if (path === '/work/subdir.ts') return Promise.reject(codedError(40906, 'FS_IS_DIRECTORY', 409));
        if (path === '/work/remote-only.ts') return Promise.reject(codedError(40101, 'local_owner_required', 403));
        return Promise.resolve({ text: 'ok', truncated: false, lossless: true });
      },
    };
    hostMock.desktop = true;
    localStorage.setItem('kiki.locale', 'zh');

    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work" sessionId="sess-32-err">
        <OpenButton path="/work/missing.ts" />
        <OpenButton path="/work/secret.ts" />
        <OpenButton path="/work/subdir.ts" />
        <OpenButton path="/work/remote-only.ts" />
      </MediaPreviewProvider>,
    );

    const cases = [
      { path: '/work/missing.ts', sentence: '这个文件不存在了。', state: 'missing' },
      { path: '/work/secret.ts', sentence: '没有权限读取这个文件。', state: 'permission-denied' },
      { path: '/work/subdir.ts', sentence: '这是一个文件夹。', state: 'folder' },
      { path: '/work/remote-only.ts', sentence: '这个文件在运行 Kiki 的电脑上，这台设备读不到它。', state: 'remote-unreadable' },
    ] as const;

    for (const entry of cases) {
      await openFile(probe.container, entry.path);
      await settle();
      const panel = probe.container.querySelector<HTMLElement>(`[data-preview-tabpanel="${entry.path}"]`)!;
      expect(panel.querySelector(`[data-preview-read-state="${entry.state}"]`)?.textContent).toContain(entry.sentence);
      expect(panel.querySelector('[data-download-file]')).toBeNull();
      const tab = probe.container.querySelector<HTMLElement>(`[data-preview-tab="${entry.path}"]`)!;
      expect(tab.querySelector('[data-mention-file]')).toBeNull();
    }

    const missingPanel = probe.container.querySelector<HTMLElement>('[data-preview-tabpanel="/work/missing.ts"]')!;
    expect(missingPanel.textContent).toContain('/work/missing.ts');
    expect(missingPanel.querySelector('[data-preview-reload]')).not.toBeNull();
    expect(missingPanel.querySelector('[data-preview-close-missing]')).not.toBeNull();

    const folderPanel = probe.container.querySelector<HTMLElement>('[data-preview-tabpanel="/work/subdir.ts"]')!;
    expect(folderPanel.querySelector('[data-preview-read-state="folder"] [data-reveal-file]')?.textContent).toContain('在这台电脑上显示');

    const remotePanel = probe.container.querySelector<HTMLElement>('[data-preview-tabpanel="/work/remote-only.ts"]')!;
    expect(remotePanel.querySelector('[data-copy-path]')?.textContent).toContain('复制路径');
  });

  it('shows 磁盘上的文件已更改。 with Reload when ETag changes on re-activation, and shows nothing on 304 (#32)', async () => {
    let etag = '"etag-v1"';
    let diskText = 'const v = 1;\n';
    const baseClient = connectionMock.defaultClient as {
      previewHostFile: (path: string) => Promise<{ text: string; truncated: boolean; lossless?: boolean; etag?: string; notModified?: boolean }>;
      [key: string]: unknown;
    };
    connectionMock.activeClient = {
      ...baseClient,
      previewHostFile: (path: string, _maxBytes?: number, options?: { ifNoneMatch?: string }) => {
        if (path === '/work/live.ts') {
          if (options?.ifNoneMatch !== undefined && options.ifNoneMatch === etag) {
            return Promise.resolve({ text: '', truncated: false, lossless: true, etag, notModified: true });
          }
          return Promise.resolve({ text: diskText, truncated: false, lossless: true, etag });
        }
        return baseClient.previewHostFile(path);
      },
    };
    localStorage.setItem('kiki.locale', 'zh');

    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work" sessionId="sess-32-etag">
        <OpenButton path="/work/live.ts" />
        <OpenButton path="/work/docs/design.md" />
      </MediaPreviewProvider>,
    );

    await openFile(probe.container, '/work/live.ts');
    await settle();
    const livePanel = probe.container.querySelector<HTMLElement>('[data-preview-tabpanel="/work/live.ts"]')!;
    expect(livePanel.querySelector('[data-changed-on-disk]')).toBeNull();
    expect(livePanel.textContent).not.toContain('在桌面应用中打开即可编辑。');

    // Switch away and back while ETag is unchanged -> 304, no changed-on-disk banner
    await openFile(probe.container, '/work/docs/design.md');
    await settle();
    await openFile(probe.container, '/work/live.ts');
    await settle();
    expect(livePanel.querySelector('[data-changed-on-disk]')).toBeNull();

    // Update ETag on disk, switch away and back -> shows 磁盘上的文件已更改。 without swapping editor text yet
    etag = '"etag-v2"';
    diskText = 'const v = 2;\n';
    await openFile(probe.container, '/work/docs/design.md');
    await settle();
    await openFile(probe.container, '/work/live.ts');
    await settle();
    const changedBanner = livePanel.querySelector<HTMLElement>('[data-changed-on-disk]')!;
    expect(changedBanner).not.toBeNull();
    expect(changedBanner.textContent).toContain('磁盘上的文件已更改。');
    expect(livePanel.querySelector<HTMLTextAreaElement>('[data-testid="editor"]')!.value).toBe('const v = 1;\n');

    // Clicking Reload swaps in the updated file and clears the banner
    await act(async () => {
      changedBanner.querySelector<HTMLButtonElement>('[data-changed-reload]')!.click();
    });
    await settle();
    expect(livePanel.querySelector('[data-changed-on-disk]')).toBeNull();
    expect(livePanel.querySelector<HTMLTextAreaElement>('[data-testid="editor"]')!.value).toBe('const v = 2;\n');
  });

  it('routes truncated video decode errors to damaged rather than unsupported, opens .ipynb as text, and times out unembeddable web tabs (#32)', async () => {
    FILES['/work/notebooks/demo.ipynb'] = '{"cells":[],"metadata":{},"nbformat":4}\n';
    sessionMediaMock.bytesById['blobref:main:nb1'] = {
      bytes: new TextEncoder().encode('{"cells":[{"cell_type":"code"}],"nbformat":4}\n'),
      mime: 'application/x-ipynb+json',
      name: 'analysis.ipynb',
    };
    localStorage.setItem('kiki.locale', 'zh');

    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work" sessionId="sess-32-media">
        <OpenButton path="/work/clips/intro.mp4" />
        <OpenButton path="/work/notebooks/demo.ipynb" />
        <AttachmentHarness
          item={{
            kind: 'file',
            fileId: 'blobref:main:nb1',
            sourceId: '9'.repeat(64),
            name: 'analysis.ipynb',
            mime: 'application/x-ipynb+json',
          }}
        />
      </MediaPreviewProvider>,
    );

    // Truncated video -> damaged sentence, not unsupported
    await openFile(probe.container, '/work/clips/intro.mp4');
    await settle();
    const videoPanel = probe.container.querySelector<HTMLElement>('[data-preview-tabpanel="/work/clips/intro.mp4"]')!;
    const video = videoPanel.querySelector<HTMLVideoElement>('video[data-preview-video]')!;
    await act(async () => {
      video.dispatchEvent(new Event('error'));
    });
    await settle();
    expect(videoPanel.querySelector('[data-preview-read-state="corrupted"]')?.textContent).toContain('这个文件损坏了，或者不是它声明的类型。');
    expect(videoPanel.textContent).not.toContain('这种文件还不能预览。');

    // .ipynb in file tab -> text editor
    await openFile(probe.container, '/work/notebooks/demo.ipynb');
    await settle();
    const nbFilePanel = probe.container.querySelector<HTMLElement>('[data-preview-tabpanel="/work/notebooks/demo.ipynb"]')!;
    expect(nbFilePanel.querySelector<HTMLTextAreaElement>('[data-testid="editor"]')?.value).toContain('"nbformat":4');

    // .ipynb in attachment tab -> text editor
    await act(async () => {
      probe.container.querySelector<HTMLButtonElement>('[data-open-attachment]')!.click();
    });
    await settle();
    expect(probe.container.querySelector<HTMLTextAreaElement>('[data-attachment-preview] [data-testid="editor"]')?.value).toContain('"cell_type":"code"');

    // Web tab failure fallback when no load arrives within timeout
    vi.useFakeTimers();
    const webProbe = makeRoot();
    await act(async () => {
      webProbe.root.render(
        <MemoryRouter>
          <I18nProvider>
            <PreviewWorkspace
              tabs={[{ kind: 'web', url: 'https://blocked.example.com', title: 'Blocked' }]}
              active="web:https://blocked.example.com"
              dirtyPaths={new Set()}
              width={420}
              onActivate={() => {}}
              onClose={() => {}}
              onCloseOthers={() => {}}
              onCloseAll={() => {}}
              onMove={() => {}}
              onCollapse={() => {}}
              onWidthChange={() => {}}
              onOpenImage={() => {}}
              reportDirty={() => {}}
            />
          </I18nProvider>
        </MemoryRouter>,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(webProbe.container.querySelector('[data-web-loading] [data-preview-reading]')?.textContent).toContain('正在读取…');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    const webFailed = webProbe.container.querySelector<HTMLElement>('[data-web-embed-failed]')!;
    expect(webFailed).not.toBeNull();
    expect(webFailed.textContent).toContain('没能打开这个网页，可以在浏览器里打开');
    expect(webFailed.querySelector('[data-web-open-failed]')).not.toBeNull();
    vi.useRealTimers();
    delete FILES['/work/notebooks/demo.ipynb'];
    delete sessionMediaMock.bytesById['blobref:main:nb1'];
  });

  it('opens session-media chips, generated-media items, and non-image attachments in unified resource tabs with shared Markdown, PDF, and HTML renderers and no modal attachment dialog (#33)', async () => {
    FILES['/work/slides/deck.html'] = '<!doctype html><html><body>Slide</body></html>\n';
    sessionMediaMock.bytesById['blobref:main:md33'] = {
      bytes: new TextEncoder().encode('# Unified Heading\n\nParagraph text.\n'),
      mime: 'text/markdown',
      name: 'design.md',
    };
    sessionMediaMock.documentPreview.mockImplementation(async (_sid: string, req: { source: { kind: string } }) => ({
      kind: 'ready',
      fidelity: 'page',
      format: 'pdf',
      renderer: 'raster',
      source: req.source.kind === 'workspace'
        ? { kind: 'workspace', path: '/work/docs/spec.pdf', size: 128 }
        : { kind: 'session-media', name: 'spec.pdf', media_type: 'application/pdf', size: 128 },
      navigation: { kind: 'page', page: 1, page_count: 2 },
      assets: [{ asset_id: 'p1', url: 'https://example.test/page1.png', width: 600, height: 800 }],
    }));
    htmlPreviewMock.open.mockResolvedValue({
      preview_id: 'prev-33',
      url: 'http://prev-33.kiki-document.localhost:59999/html-preview/prev-33/deck.html',
      sandbox: HTML_PREVIEW_SANDBOX,
      expires_at: Date.now() + 60_000,
    });

    function UnifiedHarness() {
      const preview = useMediaPreview()!;
      return (
        <div>
          <MediaPartList
            media={[
              { kind: 'file', fileId: 'blobref:main:md33', name: 'design.md', mime: 'text/markdown' },
            ]}
          />
          <button
            type="button"
            data-open-pdf-copy
            onClick={() => {
              preview.openAttachment({
                kind: 'file',
                fileId: 'blobref:main:pdf33',
                name: 'spec.pdf',
                mime: 'application/pdf',
              });
            }}
          >
            pdf copy
          </button>
          <button
            type="button"
            data-open-pdf-live
            onClick={() => { preview.openFile('/work/docs/spec.pdf'); }}
          >
            pdf live
          </button>
          <button
            type="button"
            data-open-html-copy
            onClick={() => {
              preview.openAttachment({
                kind: 'file',
                fileId: 'blobref:main:html33',
                name: 'deck.html',
                mime: 'text/html',
              });
            }}
          >
            html copy
          </button>
          <button
            type="button"
            data-open-html-live
            onClick={() => { preview.openFile('/work/slides/deck.html'); }}
          >
            html live
          </button>
        </div>
      );
    }

    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work" sessionId="sess-33">
        <UnifiedHarness />
        <OpenButton path="/work/docs/design.md" />
      </MediaPreviewProvider>,
    );

    // 1. Clicking a session-media file chip opens a resource tab (Rendered Markdown) and never a modal dialog
    await act(async () => {
      probe.container.querySelector<HTMLButtonElement>('button')!.click();
    });
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(probe.container.querySelector('[data-attachment-preview] h1')?.textContent).toBe('Unified Heading');

    // Path-opened Markdown also renders Heading via Markdown
    await openFile(probe.container, '/work/docs/design.md');
    await settle();
    expect(probe.container.querySelector('[data-preview-tabpanel="/work/docs/design.md"] h1')?.textContent).toBe('Design');

    // 2. Both PDF attachment copy and live PDF path render via DocumentTabView [data-preview-document]
    await act(async () => {
      probe.container.querySelector<HTMLButtonElement>('[data-open-pdf-copy]')!.click();
    });
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(probe.container.querySelector('[data-attachment-preview] [data-preview-document]')).not.toBeNull();

    await act(async () => {
      probe.container.querySelector<HTMLButtonElement>('[data-open-pdf-live]')!.click();
    });
    await settle();
    expect(probe.container.querySelector('[data-preview-tabpanel="/work/docs/spec.pdf"] [data-preview-document]')).not.toBeNull();

    // 3. Both HTML attachment copy and live HTML path render via SandboxedHtmlPreview iframe[data-preview-html]
    await act(async () => {
      probe.container.querySelector<HTMLButtonElement>('[data-open-html-copy]')!.click();
    });
    await settle();
    expect(probe.container.querySelector('[data-attachment-preview] iframe[data-preview-html]')).not.toBeNull();

    await act(async () => {
      probe.container.querySelector<HTMLButtonElement>('[data-open-html-live]')!.click();
    });
    await settle();
    expect(probe.container.querySelector('[data-preview-tabpanel="/work/slides/deck.html"] iframe[data-preview-html]')).not.toBeNull();

    delete FILES['/work/slides/deck.html'];
    delete sessionMediaMock.bytesById['blobref:main:md33'];
  });

  it('previews workspace text, Markdown and images via session fsRead on paired/remote connections, blocks outside-workspace paths with Copy path, and keeps local desktop on fs:content (#37)', async () => {
    localStorage.setItem('kiki.locale', 'zh');
    const previewHostFileSpy = vi.fn(async (path: string) => ({
      text: FILES[path] ?? '',
      truncated: false,
      lossless: true,
      etag: 'W/"local-1"',
    }));
    const readHostFileBytesSpy = vi.fn(async () => ({
      bytes: new Uint8Array([137, 80, 78, 71]),
      mime: 'image/png',
      etag: 'W/"local-img-1"',
    }));
    const fsReadSpy = vi.fn(async (sessionId: string, body: { path: string; encoding?: string; length?: number }) => {
      expect(sessionId).toBe('sess-37');
      if (body.path === 'src/server.ts') {
        return {
          path: 'src/server.ts',
          content: "import { boot } from './boot';\nboot(3700);\n",
          encoding: 'utf-8' as const,
          size: 43,
          truncated: false,
          etag: 'W/"remote-ts-1"',
          mime: 'text/typescript',
          is_binary: false,
        };
      }
      if (body.path === 'docs/design.md') {
        return {
          path: 'docs/design.md',
          content: '# Paired Design\n\nWorkspace note.\n',
          encoding: 'utf-8' as const,
          size: 33,
          truncated: false,
          etag: 'W/"remote-md-1"',
          mime: 'text/markdown',
          is_binary: false,
        };
      }
      if (body.path === 'shots/screen.png') {
        return {
          path: 'shots/screen.png',
          content: btoa(String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10)),
          encoding: 'base64' as const,
          size: 8,
          truncated: false,
          etag: 'W/"remote-img-1"',
          mime: 'image/png',
          is_binary: true,
        };
      }
      throw Object.assign(new Error('fs.path_escapes_session'), { code: 41304, msg: 'fs.path_escapes_session' });
    });

    const pairedClient = {
      ...(connectionMock.defaultClient as Record<string, unknown>),
      previewHostFile: vi.fn(async () => {
        throw Object.assign(new Error('local_owner_required'), { code: 40101, msg: 'local_owner_required' });
      }),
      readHostFileBytes: vi.fn(async () => {
        throw Object.assign(new Error('local_owner_required'), { code: 40101, msg: 'local_owner_required' });
      }),
      fsRead: fsReadSpy,
    };

    connectionMock.activeClient = pairedClient;
    connectionMock.connectionSource = 'remote';
    connectionMock.scopeId = 'conn-paired';

    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work" sessionId="sess-37">
        <OpenButton path="/work/src/server.ts" />
        <OpenButton path="/work/docs/design.md" />
        <OpenButton path="/work/shots/screen.png" />
        <OpenButton path="/outside/secret.txt" />
      </MediaPreviewProvider>,
    );

    await openFile(probe.container, '/work/src/server.ts');
    await settle();
    const tsPanel = probe.container.querySelector<HTMLElement>('[data-preview-tabpanel="/work/src/server.ts"]')!;
    expect(tsPanel.querySelector<HTMLTextAreaElement>('[data-testid="editor"]')?.value).toContain('boot(3700)');
    expect(pairedClient.previewHostFile).not.toHaveBeenCalled();
    expect(fsReadSpy).toHaveBeenCalledWith('sess-37', expect.objectContaining({ path: 'src/server.ts' }), expect.anything());

    await openFile(probe.container, '/work/docs/design.md');
    await settle();
    const mdPanel = probe.container.querySelector<HTMLElement>('[data-preview-tabpanel="/work/docs/design.md"]')!;
    expect(mdPanel.querySelector('h1')?.textContent).toBe('Paired Design');

    await openFile(probe.container, '/work/shots/screen.png');
    await settle();
    const imgPanel = probe.container.querySelector<HTMLElement>('[data-preview-tabpanel="/work/shots/screen.png"]')!;
    expect(imgPanel.querySelector('img')).not.toBeNull();
    expect(pairedClient.readHostFileBytes).not.toHaveBeenCalled();

    await openFile(probe.container, '/outside/secret.txt');
    await settle();
    const outsidePanel = probe.container.querySelector<HTMLElement>('[data-preview-tabpanel="/outside/secret.txt"]')!;
    const remoteState = outsidePanel.querySelector<HTMLElement>('[data-preview-read-state="remote-unreadable"]')!;
    expect(remoteState).not.toBeNull();
    expect(remoteState.textContent).toContain('这个文件在运行 Kiki 的电脑上，这台设备读不到它。');
    expect(remoteState.querySelector('[data-copy-path]')?.textContent).toBe('复制路径');

    // Local desktop connection keeps reading directly through fs:content (no fsRead call)
    fsReadSpy.mockClear();
    connectionMock.activeClient = {
      ...(connectionMock.defaultClient as Record<string, unknown>),
      previewHostFile: previewHostFileSpy,
      readHostFileBytes: readHostFileBytesSpy,
      fsRead: fsReadSpy,
    };
    connectionMock.connectionSource = 'desktop';
    connectionMock.scopeId = 'local';

    const localProbe = makeRoot();
    await renderSettled(
      localProbe.root,
      <MediaPreviewProvider cwd="/work" sessionId="sess-37">
        <OpenButton path="/work/src/server.ts" />
      </MediaPreviewProvider>,
    );
    await openFile(localProbe.container, '/work/src/server.ts');
    await settle();
    expect(previewHostFileSpy).toHaveBeenCalledWith('/work/src/server.ts');
    expect(fsReadSpy).not.toHaveBeenCalled();
  });

  it('replaces the tab strip with a title + tab sheet in phone touch mode, exposes @ and actions via header more sheet, and scrolls active desktop tabs into view (#36)', async () => {
    localStorage.setItem('kiki.locale', 'zh');
    FILES['/work/a.ts'] = 'export const a = 1;';
    FILES['/work/b.ts'] = 'export const b = 2;';
    FILES['/work/c.ts'] = 'export const c = 3;';
    FILES['/work/d.ts'] = 'export const d = 4;';
    FILES['/work/notes.md'] = '# Phone Markdown\n\nBody text.';

    const scrollIntoViewSpy = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoViewSpy;
    const originalMatchMedia = window.matchMedia;

    try {
      // 1. Desktop strip scrolls active tab into view on open & re-open
      const desktopProbe = makeRoot();
      await renderSettled(
        desktopProbe.root,
        <MediaPreviewProvider cwd="/work" sessionId="sess-36">
          <OpenButton path="/work/a.ts" />
          <OpenButton path="/work/b.ts" />
          <OpenButton path="/work/notes.md" />
        </MediaPreviewProvider>,
      );
      await openFile(desktopProbe.container, '/work/a.ts');
      await openFile(desktopProbe.container, '/work/b.ts');
      await openFile(desktopProbe.container, '/work/notes.md');
      await settle();
      expect(scrollIntoViewSpy).toHaveBeenCalled();
      scrollIntoViewSpy.mockClear();
      await openFile(desktopProbe.container, '/work/a.ts');
      await settle();
      expect(scrollIntoViewSpy).toHaveBeenCalled();

      // 2. Phone touch mode: title row + tab sheet + header more sheet
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: (query: string) => ({
          matches:
            query.includes('(pointer: coarse)') ||
            query.includes('(max-width: 639px)'),
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }),
      });
      window.innerWidth = 390;

      const phoneProbe = makeRoot();
      await renderSettled(
        phoneProbe.root,
        <MediaPreviewProvider cwd="/work" sessionId="sess-36">
          <OpenButton path="/work/a.ts" />
          <OpenButton path="/work/b.ts" />
          <OpenButton path="/work/c.ts" />
          <OpenButton path="/work/d.ts" />
          <OpenButton path="/work/notes.md" />
        </MediaPreviewProvider>,
      );

      for (const p of ['/work/a.ts', '/work/b.ts', '/work/c.ts', '/work/d.ts', '/work/notes.md']) {
        await openFile(phoneProbe.container, p);
      }
      await settle();

      expect(phoneProbe.container.querySelector('[role="tablist"]')).toBeNull();
      expect(phoneProbe.container.querySelector('[data-mention-file]')).toBeNull();
      expect(phoneProbe.container.querySelector('[data-readonly-reason]')).toBeNull();

      const picker = phoneProbe.container.querySelector<HTMLButtonElement>('[data-preview-tab-picker]')!;
      expect(picker).not.toBeNull();
      expect(picker.textContent).toContain('notes.md');
      expect(picker.textContent).toContain('▾ · 5');

      // Header keeps name + single primary download action + ⋯
      const mdPanel = phoneProbe.container.querySelector<HTMLElement>('[data-preview-tabpanel="/work/notes.md"]')!;
      expect(mdPanel.querySelector('[data-download-file]')).not.toBeNull();
      const moreBtn = mdPanel.querySelector<HTMLButtonElement>('[data-header-more]')!;
      expect(moreBtn).not.toBeNull();

      await act(async () => {
        moreBtn.click();
      });
      const moreSheet = document.body.querySelector('[data-preview-header-more-menu]')!;
      expect(moreSheet).not.toBeNull();
      expect(moreSheet.querySelector('[data-menu-item="rendered-source"]')).not.toBeNull();
      expect(moreSheet.querySelector('[data-menu-item="find-in-file"]')).not.toBeNull();
      expect(moreSheet.querySelector('[data-menu-item="add-to-chat"]')).not.toBeNull();
      expect(moreSheet.querySelector('[data-menu-item="copy-content"]')).not.toBeNull();
      expect(moreSheet.querySelector('[data-menu-item="copy-path"]')).not.toBeNull();
      expect(moreSheet.querySelector('[data-menu-item="reload"]')).not.toBeNull();

      // Switch to source via header ⋯ sheet
      await act(async () => {
        moreSheet.querySelector<HTMLButtonElement>('[data-menu-item="rendered-source"]')!.click();
      });
      await settle();
      expect(mdPanel.querySelector('[data-testid="editor"]')).not.toBeNull();

      // Open tab sheet, switch tab, and close a tab
      await act(async () => {
        picker.click();
      });
      const tabSheet = document.body.querySelector('[data-preview-tab-sheet]')!;
      expect(tabSheet).not.toBeNull();
      expect(tabSheet.querySelectorAll('[data-preview-tab-sheet-row]')).toHaveLength(5);

      await act(async () => {
        tabSheet.querySelector<HTMLButtonElement>('[data-preview-tab-sheet-close="file:/work/d.ts"]')!.click();
      });
      await settle();
      expect(document.body.querySelectorAll('[data-preview-tab-sheet-row]')).toHaveLength(4);

      await act(async () => {
        document.body
          .querySelector<HTMLButtonElement>('[data-preview-tab-sheet-select="file:/work/b.ts"]')!
          .click();
      });
      await settle();
      expect(document.body.querySelector('[data-preview-tab-sheet]')).toBeNull();
      expect(picker.textContent).toContain('b.ts');
      expect(picker.textContent).toContain('▾ · 4');
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      });
      window.innerWidth = 1024;
      delete FILES['/work/a.ts'];
      delete FILES['/work/b.ts'];
      delete FILES['/work/c.ts'];
      delete FILES['/work/d.ts'];
      delete FILES['/work/notes.md'];
    }
  });
});
