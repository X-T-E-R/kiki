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
import { formatBytes, type FileReference, type MediaRef } from '@kiki/session-core/composer/media';
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
import { PreviewCloseConfirm, PreviewWorkspace } from './PreviewWorkspace';
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

export { PreviewToggleButton } from './PreviewToggleButton';

// ---------------------------------------------------------------------------

import { attachmentName, useSessionMedia } from './mediaParts';

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
  const imageSurface = item.kind === 'image' || item.mime?.startsWith('image/') === true;
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
      panelClassName={imageSurface
        ? 'anim-enter flex max-h-[92vh] w-full max-w-[min(94vw,1100px)] flex-col overflow-hidden outline-none'
        : 'anim-enter flex max-h-[92vh] w-full max-w-[min(94vw,1100px)] flex-col overflow-hidden rounded-2xl border border-hairline bg-panel p-4 shadow-[0_20px_60px_-20px_rgb(var(--kiki-shadow-ink)/0.45)]'}
    >
      <header
        className={imageSurface
          ? 'mb-3 flex shrink-0 items-center gap-3 rounded-xl border border-hairline bg-panel/90 px-3.5 py-2 shadow-sm backdrop-blur-md'
          : 'mb-3 flex shrink-0 items-center gap-3'}
      >
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
          className="shrink-0 rounded-lg border border-hairline bg-paper/80 px-3 py-1 text-[11.5px] font-medium text-ink-soft transition-colors hover:border-accent hover:bg-paper hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink disabled:opacity-50"
        >
          {t('media.download')}
        </button>
        <button
          type="button"
          data-autofocus
          disabled={transfer.status === 'saving'}
          onClick={onClose}
          aria-label={t('common.close')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-soft transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink disabled:opacity-50"
        >
          <Icon name="close" />
        </button>
      </header>
      {transfer.status !== 'idle' ? (
        <div role={transfer.status === 'failed' ? 'alert' : 'status'} className={`mb-3 flex shrink-0 items-center gap-3 text-[11px] text-ink-soft${imageSurface ? ' rounded-lg border border-hairline bg-panel/90 px-3 py-2 shadow-sm backdrop-blur-md' : ''}`}>
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

export { FilePathLink, MediaPart, MediaPartList, type MediaThumbSize } from './mediaParts';
