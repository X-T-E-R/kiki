/**
 * MediaPreviewProvider — owns the transcript's media overlays (image lightbox)
 * and the resident preview workspace (multi-tab file panel) plus the session
 * cwd, exposed through MediaPreviewContext. Also hosts the small
 * presentational building blocks that consume it: MediaPartList
 * (thumbnails/chips for message media refs) and FilePathLink (clickable host
 * paths).
 *
 * The workspace portals into ConversationShell's `preview` slot so it docks
 * between the conversation column and the right rail; without a shell (unit
 * tests, static pages) it renders as a fixed right overlay. Dirty buffers
 * report upward so tab dots, close confirmations, the app-level dirty guard,
 * and the beforeunload guard all read one set. Collapsing the panel hides it
 * rather than unmounting it, so open buffers keep their drafts (and stay in
 * that dirty set); closing the last tab is what unmounts the workspace.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { browserSaveSink, bufferedSaveSink } from '../host/saveSink';
import type { HostSaveSink } from '../host/host';
import { createPortal } from 'react-dom';

import { useHost } from '../host';
import { useI18n } from '../i18n';
import { copyTextToClipboard } from '../lib/clipboard';
import { basenameOf, formatBytes, type FileReference, type MediaRef } from '@kiki/session-core/composer/media';
import { useOptionalConnection } from '../state/connection';
import {
  closeAllPreviewTabs,
  closeOtherPreviewTabs,
  closePreviewTab,
  EMPTY_PREVIEW_TABS,
  movePreviewTab,
  openPreviewTab,
  previewTabKey,
  type PreviewTab,
  type PreviewTabsState,
} from '../state/previewWorkspace';
import type { AgentForest, SessionController, SessionViewState } from '@kiki/session-core/session';
import type { AgentWorkspaceNavigation } from './agent-workspace';
import { useOptionalConversationShell } from './ConversationShell';
import { useRailMode } from './rail-variants/shell';
import { locateInTimeline } from '../lib/timelineLocate';
import { previewSnapshotKey, type PreviewReadingSnapshot } from '../lib/navViewState';
import { useNavSnapshotAdapter } from '../lib/useNavSnapshot';
import { useDirtyReporter } from './dirtyGuard';
import { Dialog } from './Dialog';
import { Icon } from './icons';
import { MediaLightbox } from './MediaLightbox';
import { MiniContextMenu, type MiniMenuEntry } from './MiniContextMenu';
import { PreviewCloseConfirm, PreviewWorkspace } from './PreviewWorkspace';
import { useTranscriptDetail } from './transcriptDetail';
import {
  MediaPreviewContext,
  useMediaPreview,
  type MediaPreviewApi,
} from './mediaPreviewContext';

export { useMediaPreview } from './mediaPreviewContext';

// Filesystem paths are not URI/citation text: preserve percent escapes and colons.
function normalizeRawPath(path: string): string {
  return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
}

const WIDTH_STORAGE_KEY = 'kiki.previewPanelWidth';
const DEFAULT_WIDTH = 420;

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_STORAGE_KEY);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) && value >= 320 ? value : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

type CloseAction =
  | { readonly kind: 'tab'; readonly key: string }
  | { readonly kind: 'others'; readonly key: string }
  | { readonly kind: 'all' };

function applyCloseAction(state: PreviewTabsState, action: CloseAction): PreviewTabsState {
  switch (action.kind) {
    case 'tab':
      return closePreviewTab(state, action.key);
    case 'others':
      return closeOtherPreviewTabs(state, action.key);
    case 'all':
      return closeAllPreviewTabs();
  }
}

/** Paths an action would close; used to decide whether to confirm first (panel tabs are not files). */
export function affectedByClose(state: PreviewTabsState, action: CloseAction): readonly string[] {
  const getFilePath = (tab: PreviewTab): string | undefined => (tab.kind === 'file' ? tab.path : undefined);
  switch (action.kind) {
    case 'tab': {
      const match = state.tabs.find((tab) => previewTabKey(tab) === action.key);
      const path = match ? getFilePath(match) : undefined;
      return path !== undefined ? [path] : [];
    }
    case 'others':
      return state.tabs
        .filter((tab) => previewTabKey(tab) !== action.key)
        .map(getFilePath)
        .filter((p): p is string => p !== undefined);
    case 'all':
      return state.tabs.map(getFilePath).filter((p): p is string => p !== undefined);
  }
}

export function MediaPreviewProvider({
  cwd,
  sessionId,
  sessionViewState,
  agentForest,
  onOpenSubagent,
  apiRef,
  controller,
  workspaceSessionState,
  workspaceNavigation,
  onCancelTask,
  onStopAgentTask,
  snapshotAgentId = 'main',
  children,
}: {
  cwd?: string;
  sessionId?: string;
  sessionViewState?: SessionViewState;
  agentForest?: AgentForest;
  onOpenSubagent?: (agentId: string) => void;
  apiRef?: React.Ref<MediaPreviewApi>;
  /**
   * Agent-tab workspace wiring: the shared session runtime plus the
   * session-level (main) view state, navigation intents and task commands the
   * embedded AgentWorkspace needs. Absent without a session — panel tabs then
   * fall back to a plain caption. `workspaceSessionState` defaults to
   * `sessionViewState` (they differ only where the provider itself is scoped
   * to one agent, e.g. the agent route page).
   */
  controller?: SessionController | null;
  workspaceSessionState?: SessionViewState;
  workspaceNavigation?: AgentWorkspaceNavigation;
  onCancelTask?: (taskId: string, ownerAgentId?: string) => void;
  onStopAgentTask?: (ownerAgentId: string, taskId: string) => Promise<void>;
  /**
   * Which visit this panel belongs to. The tab set, its active tab and each
   * tab's reading position are remembered per visit, so lifting a preview to a
   * page and returning reopens the panel the reader left.
   */
  snapshotAgentId?: string;
  children: ReactNode;
}) {
  const clientIdentity = useOptionalConnection()?.client;
  const [image, setImage] = useState<{ src: string; name?: string; client: unknown; sessionId?: string; agentId: string } | null>(null);
  const [attachment, setAttachment] = useState<{ item: MediaRef; client: unknown; sessionId?: string; agentId: string } | null>(null);
  useEffect(() => { setImage(null); setAttachment(null); }, [clientIdentity, sessionId, snapshotAgentId]);
  const [tabsState, setTabsState] = useState<PreviewTabsState>(EMPTY_PREVIEW_TABS);
  const [panelOpen, setPanelOpen] = useState(false);
  const [width, setWidth] = useState(readStoredWidth);
  const [dirtyPaths, setDirtyPaths] = useState<ReadonlySet<string>>(new Set());
  const [positions, setPositions] = useState<Readonly<Record<string, { top: number; left?: number }>>>({});
  const [confirmClose, setConfirmClose] = useState<{
    dirty: readonly string[];
    action: CloseAction;
  } | null>(null);
  const shell = useOptionalConversationShell();
  const reportPosition = useCallback((key: string, position: { top: number; left?: number }) => {
    setPositions((previous) => {
      const current = previous[key];
      if (current !== undefined && current.top === position.top && current.left === position.left) return previous;
      return { ...previous, [key]: position };
    });
  }, []);
  // Per-visit preview state (see lib/navViewState.ts): the tab set, its active
  // tab and each tab's reading position belong to the visit, not to the panel
  // instance. Returning to a visit reopens that visit's panel even when the
  // provider stayed mounted across a same-URL visit change. Restoring never
  // closes a buffer that is dirty right now.
  const previewKey = sessionId === undefined ? 'preview:unsessioned' : previewSnapshotKey(sessionId, snapshotAgentId);
  useNavSnapshotAdapter<PreviewReadingSnapshot>(previewKey, {
    ready: sessionId !== undefined,
    capture: () => ({ tabsState, panelOpen, positions }),
    restore: (snapshot) => {
      setTabsState((current) => {
        const kept = current.tabs.filter((tab) => tab.kind === 'file' && dirtyPaths.has(tab.path) &&
          !snapshot.tabsState.tabs.some((candidate) => previewTabKey(candidate) === previewTabKey(tab)));
        if (kept.length === 0) return snapshot.tabsState;
        const active = snapshot.tabsState.active ?? previewTabKey(kept[0]!);
        return { tabs: [...snapshot.tabsState.tabs, ...kept], active };
      });
      setPanelOpen(snapshot.panelOpen && snapshot.tabsState.tabs.length > 0);
      setPositions(snapshot.positions);
    },
  });
  const [, chooseMode] = useRailMode();
  const cockpit = shell?.cockpit === true;
  const revealPreview = useCallback(() => {
    if (cockpit) chooseMode('default');
    setPanelOpen(true);
  }, [cockpit, chooseMode]);

  const [navigation, setNavigation] = useState<FileReference | undefined>();
  const openFile = useCallback((input: string | FileReference) => {
    const raw = typeof input === 'string' ? { path: input } : input;
    const reference = { ...raw, path: normalizeRawPath(raw.path) };
    setTabsState((state) => openPreviewTab(state, reference.path));
    setNavigation(reference);
    revealPreview();
  }, [revealPreview]);

  const openAgentPanel = useCallback((agentId: string, title?: string) => {
    setTabsState((state) => openPreviewTab(state, { kind: 'panel', agentId, title }));
    revealPreview();
    // Opening (or re-opening) an agent lands on its latest message; a reader
    // who scrolled that tab up keeps their place.
    if (sessionId !== undefined) {
      void locateInTimeline({ kind: 'latest', respectReader: true }, { sessionId, agentId, notify: false });
    }
  }, [sessionId, revealPreview]);

  const openBuiltinSkill = useCallback((name: string) => {
    setTabsState((state) => openPreviewTab(state, { kind: 'skill', name }));
    revealPreview();
  }, [revealPreview]);

  const togglePanel = useCallback(() => {
    if (cockpit) revealPreview();
    else setPanelOpen((value) => !value);
  }, [cockpit, revealPreview]);

  const reportDirty = useCallback((path: string, dirty: boolean) => {
    setDirtyPaths((previous) => {
      const has = previous.has(path);
      if (has === dirty) return previous;
      const next = new Set(previous);
      if (dirty) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const requestClose = useCallback(
    (action: CloseAction) => {
      const affected = affectedByClose(tabsState, action);
      const dirty = affected.filter((path) => dirtyPaths.has(path));
      if (dirty.length > 0) {
        setConfirmClose({ dirty, action });
        return;
      }
      setTabsState((state) => {
        const next = applyCloseAction(state, action);
        if (next.tabs.length === 0) setPanelOpen(false);
        return next;
      });
    },
    [tabsState, dirtyPaths],
  );

  const confirmCloseRun = useCallback(() => {
    setConfirmClose((pending) => {
      if (pending !== null) {
        setTabsState((state) => {
          const next = applyCloseAction(state, pending.action);
          if (next.tabs.length === 0) setPanelOpen(false);
          return next;
        });
      }
      return null;
    });
  }, []);

  const handleMove = useCallback((key: string, targetIndex: number) => {
    setTabsState((state) => movePreviewTab(state, key, targetIndex));
  }, []);

  const handleWidthChange = useCallback((next: number, final: boolean) => {
    setWidth(next);
    if (final) {
      try {
        localStorage.setItem(WIDTH_STORAGE_KEY, String(next));
      } catch {
        // storage unavailable — session-only width
      }
    }
  }, []);

  // Navigation + unload guards while any buffer is dirty.
  useDirtyReporter('preview-workspace', dirtyPaths.size > 0);
  useEffect(() => {
    if (dirtyPaths.size === 0) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => { window.removeEventListener('beforeunload', onBeforeUnload); };
  }, [dirtyPaths.size]);

  // Focus seam: the agent panel tab the user is looking at right now. The
  // shared right rail retargets at this agent while it is active (and the
  // panel shown); a file tab, a collapsed panel, or no tabs hand the rail
  // back to the main session.
  const activeAgentPanelId =
    panelOpen && tabsState.active !== null
      ? (tabsState.tabs.find(
          (tab) => previewTabKey(tab) === tabsState.active && tab.kind === 'panel',
        ) as { agentId: string } | undefined)?.agentId
      : undefined;
  const api = useMemo<MediaPreviewApi>(
    () => ({
      cwd,
      sessionId,
      openImage: (src, name) => { setImage({ src, name, client: clientIdentity, sessionId, agentId: snapshotAgentId }); },
      openFile,
      openAttachment: (item) => { setAttachment({ item, client: clientIdentity, sessionId, agentId: snapshotAgentId }); },
      openAgentPanel,
      openBuiltinSkill,
      previewTabCount: tabsState.tabs.length,
      previewPanelOpen: panelOpen && !cockpit,
      previewPanelWidth: panelOpen ? width : undefined,
      togglePreviewPanel: togglePanel,
      activeAgentPanelId,
    }),
    [cwd, sessionId, clientIdentity, snapshotAgentId, openFile, openAgentPanel, openBuiltinSkill, tabsState.tabs, tabsState.active, panelOpen, cockpit, width, togglePanel, activeAgentPanelId],
  );

  useEffect(() => {
    if (!apiRef) return;
    if (typeof apiRef === 'function') {
      apiRef(api);
    } else {
      (apiRef as React.MutableRefObject<MediaPreviewApi | null>).current = api;
    }
  }, [api, apiRef]);

  // Collapsing is a hide, not a close: the workspace stays mounted (hidden) so
  // every tab's editor buffer, unsaved draft and pending autosave survive.
  // Only closing the last tab unmounts it (after the discard confirmation).
  const panel = tabsState.tabs.length > 0 ? (
    <PreviewWorkspace
      tabs={tabsState.tabs}
      active={tabsState.active}
      navigation={navigation}
      dirtyPaths={dirtyPaths}
      width={width}
      hidden={!panelOpen || cockpit}
      sessionViewState={workspaceSessionState ?? sessionViewState}
      agentForest={agentForest}
      onOpenSubagent={onOpenSubagent}
      controller={controller}
      workspaceNavigation={workspaceNavigation}
      onCancelTask={onCancelTask}
      onStopAgentTask={onStopAgentTask}
      onActivate={(key) => { setTabsState((state) => ({ ...state, active: key })); }}
      onClose={(key) => { requestClose({ kind: 'tab', key }); }}
      onCloseOthers={(key) => { requestClose({ kind: 'others', key }); }}
      onCloseAll={() => { requestClose({ kind: 'all' }); }}
      onMove={handleMove}
      onCollapse={() => { setPanelOpen(false); }}
      onOpenCockpit={shell?.slots.preview !== null && shell?.slots.preview !== undefined && workspaceNavigation?.sharedRail !== undefined ? () => {
        const sharedRail = workspaceNavigation.sharedRail;
        if (sharedRail !== undefined && !sharedRail.open) sharedRail.toggle();
        chooseMode('cockpit');
      } : undefined}
      onWidthChange={handleWidthChange}
      onOpenImage={(src, name) => { setImage({ src, name, client: clientIdentity, sessionId, agentId: snapshotAgentId }); }}
      reportDirty={reportDirty}
      scrollPositions={positions}
      onScrollPosition={reportPosition}
      overlay={shell?.slots.preview === null || shell?.slots.preview === undefined}
      cwd={cwd}
      sessionId={sessionId}
    />
  ) : null;

  return (
    <MediaPreviewContext.Provider value={api}>
      {children}
      {panel !== null && shell?.slots.preview !== null && shell?.slots.preview !== undefined
        ? createPortal(panel, shell.slots.preview)
        : panel}
      {confirmClose !== null ? (
        <PreviewCloseConfirm
          paths={confirmClose.dirty}
          onConfirm={confirmCloseRun}
          onCancel={() => { setConfirmClose(null); }}
        />
      ) : null}
      {attachment !== null && attachment.client === clientIdentity && attachment.sessionId === sessionId && attachment.agentId === snapshotAgentId ? (
        <AttachmentPreviewDialog
          item={attachment.item}
          sessionId={attachment.sessionId}
          onClose={() => { setAttachment(null); }}
        />
      ) : null}
      {image !== null && image.client === clientIdentity && image.sessionId === sessionId && image.agentId === snapshotAgentId ? (
        <MediaLightbox
          src={image.src}
          name={image.name}
          onClose={() => { setImage(null); }}
        />
      ) : null}
    </MediaPreviewContext.Provider>
  );
}

/** Header toggle for the preview workspace; hides itself with no open tabs. */
export function PreviewToggleButton({ className }: { className?: string }) {
  const { t } = useI18n();
  const preview = useMediaPreview();
  if (preview === null || preview.previewTabCount === 0) return null;
  return (
    <button
      type="button"
      onClick={preview.togglePreviewPanel}
      title={t('preview.toggleAria')}
      aria-label={t('preview.toggleAria')}
      aria-expanded={preview.previewPanelOpen}
      data-preview-toggle
      className={`flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[12.5px] transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink lg:h-8 ${
        preview.previewPanelOpen
          ? 'bg-canvas text-ink'
          : 'text-ink-faint hover:bg-canvas hover:text-ink'
      } ${className ?? ''}`}
    >
      <svg aria-hidden viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" className="h-[14px] w-[14px] shrink-0">
        <path d="M4.5 2.5h4.8l2.7 2.7v7.3a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" />
        <path d="M9 2.5v3h3" />
      </svg>
      {t('preview.toggle')}
    </button>
  );
}

// ---------------------------------------------------------------------------

type SessionMediaLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | {
      readonly status: 'ready';
      readonly bytes: Uint8Array;
      readonly mime: string;
      readonly name?: string;
      readonly url: string;
      readonly thumbnailUrl?: string;
    };

function useSessionMedia(
  item: MediaRef,
  sessionId: string | undefined,
  enabled = true,
  previewOnly = true,
): SessionMediaLoad {
  const client = useOptionalConnection()?.client;
  const source = useMemo(() => ({ client, sessionId, fileId: item.fileId, path: item.path }), [client, sessionId, item.fileId, item.path, item.mime, item.kind, previewOnly]);
  const [loaded, setLoaded] = useState<{ source: typeof source; load: SessionMediaLoad }>({ source, load: { status: 'loading' } });
  const setLoad = useCallback((load: SessionMediaLoad) => { setLoaded({ source, load }); }, [source]);
  const load: SessionMediaLoad = loaded.source === source ? loaded.load : { status: 'loading' };

  useEffect(() => {
    if (!enabled) { setLoad({ status: 'loading' }); return; }
    if (client === undefined || (item.path === undefined && (sessionId === undefined || item.fileId === undefined)) || (previewOnly && item.kind !== 'image' && item.kind !== 'video')) {
      setLoad({ status: 'failed' });
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setLoad({ status: 'loading' });
    const options = { signal: controller.signal, mediaType: item.mime, timeoutMs: previewOnly ? undefined : 0 };
    const read: Promise<{ bytes: Uint8Array; mime: string; name?: string }> = item.path !== undefined
      ? previewOnly ? client.readHostMediaPreviewBytes(item.path, options) : client.readHostFileBytes(item.path, options)
      : previewOnly ? client.readSessionMediaPreviewBytes(sessionId!, item.fileId!, options) : client.readSessionMediaBytes(sessionId!, item.fileId!, options);
    read.then(({ bytes, mime, name }) => {
      if (controller.signal.aborted) return;
      const mediaType = !previewOnly && item.blobHash !== undefined ? item.mime ?? mime : mime;
      objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mediaType }));
      setLoad({ status: 'ready', bytes, mime: mediaType, name, url: objectUrl });
    }, () => {
      if (!controller.signal.aborted) setLoad({ status: 'failed' });
    });
    return () => {
      controller.abort();
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [client, enabled, previewOnly, item.blobHash, item.fileId, item.mime, item.kind, sessionId, setLoad]);

  return load;
}

function useVisibleOnce(): [(node: HTMLElement | null) => void, boolean] {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (visible || node === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(node);
    return () => { observer.disconnect(); };
  }, [node, visible]);

  return [setNode, visible];
}

function attachmentName(item: MediaRef, loadedName?: string): string {
  return item.name ?? loadedName ?? item.fileId ?? item.path ?? 'attachment';
}

function isTextPreview(mime: string, name: string): boolean {
  if (mime.startsWith('text/')) return true;
  if (mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json')) return true;
  return /\.(?:md|markdown|txt|log|json|jsonl|ya?ml|toml|ini|csv|tsv|xml|html?|css|jsx?|tsx?|py|rs|go|java|c|cc|cpp|h|hpp|sh|zsh|fish|ps1)$/i.test(name);
}

function AttachmentPreviewDialog({
  item,
  sessionId,
  onClose,
}: {
  item: MediaRef;
  sessionId: string | undefined;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const host = useHost();
  const client = useOptionalConnection()?.client;
  const [original, setOriginal] = useState(false);
  const [textLimit, setTextLimit] = useState(1024 * 1024);
  const [transfer, setTransfer] = useState<{ status: 'idle' | 'downloading' | 'saving' | 'saved' | 'failed'; bytes?: number; total?: number; message?: string }>({ status: 'idle' });
  const downloadController = useRef<AbortController | null>(null);
  const load = useSessionMedia(item, sessionId, true, !original);
  const name = attachmentName(item, load.status === 'ready' ? load.name : undefined);
  const title = t('preview.openFile', { name });
  useEffect(() => () => { downloadController.current?.abort(); }, [client, sessionId, item.fileId, item.path]);
  const download = async () => {
    if (client === undefined || (item.path === undefined && (sessionId === undefined || item.fileId === undefined))) return;
    downloadController.current?.abort();
    const controller = new AbortController();
    downloadController.current = controller;
    let sink: HostSaveSink | null = null;
    setTransfer({ status: 'downloading', bytes: 0, total: item.size });
    try {
      sink = host.openSaveSink !== undefined ? await host.openSaveSink(name)
        : host.saveBlob !== undefined ? bufferedSaveSink((blob) => host.saveBlob!(blob, name)) : await browserSaveSink(name);
      if (sink === null) { if (!controller.signal.aborted) setTransfer({ status: 'idle' }); return; }
      controller.signal.throwIfAborted();
      const target = sink;
      const consume: import('@kiki/klient').HttpRestMediaSink = async (chunk, progress) => {
        await target.write(chunk);
        if (!controller.signal.aborted) setTransfer({ status: 'downloading', bytes: progress.bytes, total: progress.totalBytes });
      };
      const options = { signal: controller.signal, timeoutMs: 0 };
      if (item.path !== undefined) await client.downloadHostFile(item.path, consume, options);
      else await client.downloadSessionMedia(sessionId!, item.fileId!, consume, options);
      controller.signal.throwIfAborted();
      setTransfer({ status: 'saving' });
      const saved = await sink.close();
      if (!controller.signal.aborted) setTransfer({ status: saved ? 'saved' : 'idle' });
    } catch (error) {
      await sink?.abort().catch(() => {});
      if (!controller.signal.aborted) setTransfer({ status: 'failed', message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (downloadController.current === controller) downloadController.current = null;
    }
  };
  let body: ReactNode;

  if (load.status === 'loading') {
    body = <div className="flex min-h-48 items-center justify-center text-sm text-ink-faint">{t('preview.loading')}</div>;
  } else if (load.status === 'failed') {
    body = <div className="flex min-h-48 items-center justify-center text-sm text-danger">{t('preview.failed')}</div>;
  } else if (load.mime.startsWith('image/')) {
    body = <img src={load.url} alt={name} className="max-h-[72vh] max-w-full object-contain" />;
  } else if (load.mime.startsWith('video/')) {
    body = <video src={load.url} controls className="max-h-[72vh] max-w-full" />;
  } else if (load.mime.startsWith('audio/')) {
    body = <audio src={load.url} controls className="w-full" />;
  } else if (load.mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf')) {
    body = <iframe src={load.url} title={name} className="h-[72vh] w-full rounded-lg border border-hairline bg-white" />;
  } else if (isTextPreview(load.mime, name)) {
    const shown = load.bytes.subarray(0, textLimit);
    const text = new TextDecoder().decode(shown, { stream: shown.byteLength < load.bytes.byteLength });
    body = (
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-hairline bg-paper p-3">
        <pre className="font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink">{text}</pre>
        {load.bytes.byteLength > shown.byteLength ? (
          <button type="button" onClick={() => { setTextLimit((value) => value + 1024 * 1024); }} className="mt-3 text-[11px] text-accent">{t('transcript.showMore')}</button>
        ) : null}
      </div>
    );
  } else {
    body = (
      <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-ink-faint">
        <span>{t('preview.unsupported')}</span>

      </div>
    );
  }

  return (
    <Dialog
      onClose={() => { if (transfer.status !== 'saving') onClose(); }}
      ariaLabel={title}
      overlayId="session-attachment-preview"
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-shell/55 p-4"
      panelClassName="anim-enter flex max-h-[92vh] w-full max-w-[min(94vw,1100px)] flex-col overflow-hidden rounded-2xl border border-hairline bg-panel p-4 shadow-[0_20px_60px_-20px_rgb(var(--kiki-shadow-ink)/0.45)]"
    >
      <header className="mb-3 flex shrink-0 items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-ink">{name}</h2>
          {load.status === 'ready' ? (
            <p className="truncate font-mono text-[11px] text-ink-faint">{load.mime} · {formatBytes(load.bytes.byteLength)}</p>
          ) : null}
        </div>
        {!original ? (
          <button type="button" onClick={() => { setOriginal(true); }} className="rounded-lg border border-hairline px-3 py-1 text-[11px] text-ink-soft hover:border-accent hover:text-ink">
            {t('preview.loadFullFile')}
          </button>
        ) : null}
        <button
          type="button"
          disabled={transfer.status === 'downloading' || transfer.status === 'saving'}
          onClick={() => { void download(); }}
          className="rounded-lg border border-hairline px-3 py-1 text-[11px] text-ink-soft transition-colors hover:border-accent hover:text-ink disabled:opacity-50"
        >
          {t('media.download')}
        </button>
        <button
          type="button"
          data-autofocus
          disabled={transfer.status === 'saving'}
          onClick={onClose}
          aria-label={t('common.close')}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink"
        >
          <Icon name="close" />
        </button>
      </header>
      {transfer.status !== 'idle' ? (
        <div role={transfer.status === 'failed' ? 'alert' : 'status'} className="mb-3 flex shrink-0 items-center gap-3 text-[11px] text-ink-soft">
          {transfer.status === 'downloading' ? <>
            <span className="font-mono">{formatBytes(transfer.bytes ?? 0)}{transfer.total === undefined ? '' : ` / ${formatBytes(transfer.total)}`}</span>
            <button type="button" onClick={() => { downloadController.current?.abort(); setTransfer({ status: 'idle' }); }} className="text-accent">{t('common.cancel')}</button>
          </> : transfer.status === 'saving' ? t('preview.saving') : transfer.status === 'saved' ? t('preview.saved') : <span className="text-danger">{transfer.message}</span>}
        </div>
      ) : null}
      <div data-attachment-preview className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
        {body}
      </div>
    </Dialog>
  );
}

function SessionMediaThumb({ item, size = 'default' }: { item: MediaRef; size?: MediaThumbSize }) {
  const { t } = useI18n();
  const preview = useMediaPreview();
  const [hostRef, visible] = useVisibleOnce();
  const load = useSessionMedia(item, preview?.sessionId, visible);
  const name = attachmentName(item, load.status === 'ready' ? load.name : undefined);

  let body: ReactNode;
  if (load.status === 'failed') {
    body = size === 'default'
      ? <FileChip item={item} />
      : <button type="button" onClick={() => { preview?.openAttachment(item); }} title={name}><BrokenThumb size={size} name={name} /></button>;
  } else if (load.status === 'loading') {
    body = (
      <span className={`flex ${THUMB_SIZE[size].slot} items-center justify-center ${THUMB_SIZE[size].frame} border border-hairline bg-paper text-[11px] text-ink-faint`}>
        {size === 'strip' ? null : t('preview.loading')}
      </span>
    );
  } else {
    body = (
      <button
        type="button"
        title={name}
        onClick={() => { preview?.openAttachment(item); }}
        className={`block overflow-hidden ${THUMB_SIZE[size].frame} border border-hairline transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink`}
      >
        <img src={load.thumbnailUrl ?? load.url} alt={name} className={`${THUMB_SIZE[size].img} object-cover`} />
      </button>
    );
  }

  return <span ref={hostRef} className="inline-flex">{body}</span>;
}

/** An image that could not be read, in the slot it would have taken: neutral, never an error. */
function BrokenThumb({ size, name }: { size: MediaThumbSize; name: string }) {
  const { t } = useI18n();
  return (
    <span
      data-media-broken
      role="img"
      aria-label={t('media.unavailable', { name })}
      title={name}
      className={`flex ${THUMB_SIZE[size].slot} items-center justify-center ${THUMB_SIZE[size].frame} border border-dashed border-hairline-strong bg-panel text-ink-faint`}
    >
      <Icon name="file" size={size === 'strip' ? 12 : 16} />
    </span>
  );
}

function FileChip({ item }: { item: MediaRef }) {
  const { t } = useI18n();
  const preview = useMediaPreview();
  const label =
    item.name ?? (item.path !== undefined ? basenameOf(item.path) : t('media.attachment'));
  const detail = item.size !== undefined ? formatBytes(item.size) : item.mime;
  const openable = (item.path !== undefined || item.fileId !== undefined) && preview !== null;
  const className = `inline-flex max-w-full items-center gap-2 rounded-lg border px-3 py-1.5 text-left ${
    openable
      ? 'border-hairline bg-paper transition-colors hover:border-accent'
      : 'border-hairline bg-paper/60'
  }`;
  const body = (
    <>
      <Icon name="file" className="h-3.5 w-3.5 text-ink-faint" />
      <span className="min-w-0 truncate font-mono text-[12px] text-ink">{label}</span>
      {detail !== undefined && detail !== '' ? (
        <span className="shrink-0 font-mono text-[11px] text-ink-faint">{detail}</span>
      ) : null}
    </>
  );
  if (!openable) {
    return (
      <span className={className} title={item.path ?? item.fileId}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={className}
      title={item.path ?? item.fileId}
      onClick={() => {
        if ((item.kind === 'image' || item.kind === 'video') && item.path !== undefined) preview.openAttachment(item);
        else if (item.path !== undefined) preview.openFile(item.path);
        else if (item.fileId !== undefined) preview.openAttachment(item);
      }}
    >
      {body}
    </button>
  );
}

/** Host media uses the same bounded source-preview and explicit-original UI. */
function HostMediaThumb({ item, size = 'default' }: { item: MediaRef & { kind: 'image' | 'video'; path: string }; size?: MediaThumbSize }) {
  return <SessionMediaThumb item={item} size={size} />;
}

/**
 * Thumbnail sizes. `strip` is the timeline's row of what an agent looked at
 * (one line tall); `preview` is the latest look, large enough to read at a
 * glance; `default` is a message attachment.
 */
export type MediaThumbSize = 'default' | 'strip' | 'preview';

const THUMB_SIZE: Record<MediaThumbSize, { img: string; slot: string; frame: string }> = {
  default: { img: 'h-28 w-auto', slot: 'h-28 w-40', frame: 'rounded-lg' },
  strip: { img: 'h-9 w-auto max-w-[96px]', slot: 'h-9 w-12', frame: 'rounded-[5px]' },
  preview: { img: 'h-[120px] w-auto max-w-[240px]', slot: 'h-[120px] w-40', frame: 'rounded-lg' },
};

const LOADABLE_MEDIA_URL = /^(?:data:|blob:|https?:\/\/)/i;

function UrlMediaPart({ item, size }: { item: MediaRef & { url: string }; size: MediaThumbSize }) {
  const { t } = useI18n();
  const preview = useMediaPreview();
  const client = useOptionalConnection()?.client;
  const source = useMemo(() => ({ client, sessionId: preview?.sessionId, url: item.url }), [client, preview?.sessionId, item.url]);
  const [opened, setOpened] = useState<typeof source | null>(null);
  const name = attachmentName(item);
  if (!LOADABLE_MEDIA_URL.test(item.url)) return <FileChip item={item} />;
  if (opened !== source) return (
    <button type="button" onClick={() => { setOpened(source); }} title={name} className={`flex ${THUMB_SIZE[size].slot} flex-col items-center justify-center gap-2 ${THUMB_SIZE[size].frame} border border-hairline bg-paper p-2 text-[11px] text-accent`}>
      <Icon name="file" /><span>{t('preview.loadFullFile')}</span>
    </button>
  );
  return <span className="flex flex-col gap-1">
    {item.kind === 'video' ? <video src={item.url} controls className="max-h-52 rounded-lg border border-hairline" /> :
      <button type="button" onClick={() => { preview?.openImage(item.url, name); }} title={name}><img src={item.url} alt={name} className={`${THUMB_SIZE[size].img} ${THUMB_SIZE[size].frame} border border-hairline object-cover`} /></button>}
    <a href={item.url} download={name} target="_blank" rel="noopener noreferrer" className="text-[11px] text-accent">{t('media.download')}</a>
  </span>;
}

/**
 * A referenced attachment outside the collection window, or with its source
 * omitted. It costs nothing until the reader opens it; the loaded entity then
 * re-projects as an ordinary thumbnail in the same place.
 */
function DeferredMediaPart({ item, size }: { item: MediaRef & { detail: NonNullable<MediaRef['detail']> }; size: MediaThumbSize }) {
  const { t } = useI18n();
  const detail = useTranscriptDetail({ agentId: item.detail.agentId, kind: 'attachment', id: item.detail.attachmentId });
  const name = item.name ?? t('media.attachment');
  if (detail.request === undefined) return <FileChip item={item} />;
  const status = detail.status?.status;
  const label = status === 'loading'
    ? t('media.detail.loading', { name })
    : status === 'error'
      ? t('media.detail.failed', { name })
      : t('media.detail.open', { name });
  const meta = item.size !== undefined ? formatBytes(item.size) : item.mime;
  if (size === 'strip') {
    return (
      <button
        type="button"
        data-media-deferred={status ?? 'idle'}
        onClick={detail.request}
        disabled={status === 'loading'}
        aria-label={label}
        title={label}
        className={`flex ${THUMB_SIZE[size].slot} items-center justify-center ${THUMB_SIZE[size].frame} border border-dashed ${status === 'error' ? 'border-danger/60 text-danger' : 'border-hairline-strong text-ink-faint'} bg-panel transition-colors hover:border-accent hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink`}
      >
        <Icon name="file" size={12} />
      </button>
    );
  }
  return (
    <button
      type="button"
      data-media-deferred={status ?? 'idle'}
      onClick={detail.request}
      disabled={status === 'loading'}
      aria-busy={status === 'loading'}
      aria-label={label}
      title={label}
      className={`flex ${THUMB_SIZE[size].slot} flex-col items-start justify-between gap-1 ${THUMB_SIZE[size].frame} border border-dashed ${status === 'error' ? 'border-danger/60' : 'border-hairline-strong'} bg-panel p-2 text-left transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink disabled:cursor-default motion-reduce:transition-none`}
    >
      <span className="flex w-full min-w-0 items-center gap-1.5 text-ink-faint">
        <Icon name="file" size={14} />
        {meta !== undefined && meta !== '' ? <span className="truncate font-mono text-[11px]">{meta}</span> : null}
      </span>
      <span className="w-full min-w-0">
        <span className="block truncate font-mono text-[12px] text-ink" title={name}>{name}</span>
        <span className={`mt-0.5 flex items-center gap-1.5 text-[12px] font-medium ${status === 'error' ? 'text-danger' : 'text-accent-ink'}`}>
          {status === 'loading' ? <span aria-hidden className="status-dot-busy h-1.5 w-1.5 rounded-full bg-ink-soft" /> : null}
          {status === 'loading' ? t('preview.loading') : status === 'error' ? t('transcript.detail.retry') : t('media.detail.action')}
        </span>
      </span>
    </button>
  );
}

export function MediaPart({ item, agentId, size = 'default' }: { item: MediaRef; agentId?: string; size?: MediaThumbSize }) {
  if (item.detail !== undefined) return <DeferredMediaPart item={{ ...item, detail: item.detail }} size={size} />;
  if (item.blobHash !== undefined) {
    const savedItem = {
      ...item,
      path: undefined,
      name: item.name ?? (item.path === undefined ? undefined : basenameOf(item.path)),
      fileId: item.fileId ?? (agentId === undefined ? undefined : `blobref:${agentId}:${item.blobHash}`),
    };
    return savedItem.fileId === undefined ? <FileChip item={savedItem} /> : <SessionMediaThumb item={savedItem} size={size} />;
  }
  if (item.kind === 'image') {
    if (item.fileId !== undefined) return <SessionMediaThumb item={item} size={size} />;
    if (item.url !== undefined) return <UrlMediaPart item={{ ...item, url: item.url }} size={size} />;
    if (item.path !== undefined) return <HostMediaThumb item={{ ...item, kind: 'image', path: item.path }} size={size} />;
    if (item.fileId !== undefined) return <SessionMediaThumb item={item} size={size} />;
    return <FileChip item={item} />;
  }
  if (item.kind === 'video') {
    if (item.fileId !== undefined) return <SessionMediaThumb item={item} size={size} />;
    if (item.url !== undefined) return <UrlMediaPart item={{ ...item, url: item.url }} size={size} />;
    if (item.path !== undefined) return <HostMediaThumb item={{ ...item, kind: 'video', path: item.path }} />;
    if (item.fileId !== undefined) return <SessionMediaThumb item={item} />;
    return <FileChip item={item} />;
  }
  return <FileChip item={item} />;
}

/** Thumbnails + chips for the media refs carried by a transcript block. */
export function MediaPartList({
  media,
  align = 'start',
  agentId,
}: {
  media: readonly MediaRef[];
  align?: 'start' | 'end';
  agentId?: string;
}) {
  if (media.length === 0) return null;
  return (
    <div className={`mt-1.5 flex flex-wrap gap-2 ${align === 'end' ? 'justify-end' : ''}`}>
      {media.map((item, index) => (
        <MediaPart key={index} item={item} agentId={agentId} />
      ))}
    </div>
  );
}

/**
 * Clickable host file path. Without a preview provider (tests, static pages)
 * it degrades to plain text. Right-click raises the file menu (G-1): preview,
 * copy path, and the desktop opener pair.
 */
export function FilePathLink({ path, className }: { path: string; className?: string }) {
  const host = useHost();
  const { t } = useI18n();
  const preview = useMediaPreview();
  const remoteScope = useOptionalConnection()?.scopeId.startsWith('ssh:') ?? false;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (preview === null) return <span className={className}>{path}</span>;
  const filePath = normalizeRawPath(path);
  const entries: MiniMenuEntry[] = [
    { key: 'open-preview', label: t('file.openPreview'), run: () => { preview.openFile(path); } },
    { key: 'copy-path', label: t('file.copyPath'), run: () => copyTextToClipboard(path) },
    ...(!remoteScope && host.revealPath !== undefined && host.openPath !== undefined
      ? [
          { separator: true } as const,
          {
            key: 'show-in-folder',
            label: t('file.showInFolder'),
            run: () => host.revealPath?.(filePath),
          } as const,
          {
            key: 'open-default-app',
            label: t('file.openDefaultApp'),
            run: () => host.openPath?.(filePath),
          } as const,
        ]
      : []),
  ];
  return (
    <>
      <span
        role="link"
        tabIndex={0}
        title={path}
        onClick={(event) => {
          event.stopPropagation();
          preview.openFile(path);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.stopPropagation();
            preview.openFile(path);
          }
        }}
        // Quiet at rest: the link affordance (underline, ink) appears only
        // under the pointer or keyboard focus, so a screen of paths is not a
        // screen of dotted lines.
        className={`cursor-pointer rounded-[2px] underline-offset-2 decoration-ink-faint hover:text-ink hover:underline focus-visible:text-ink focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink ${className ?? ''}`}
      >
        {path}
      </span>
      {menu !== null ? (
        <MiniContextMenu
          x={menu.x}
          y={menu.y}
          entries={entries}
          onClose={() => { setMenu(null); }}
          ariaLabel={t('file.menuAria')}
          overlayId="file-path-link"
          dataAttribute="data-file-link-menu"
        />
      ) : null}
    </>
  );
}
