/**
 * MediaPreviewProvider — owns the transcript's media overlays (image lightbox)
 * and the resident preview workspace (multi-tab resource panel) plus the session
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

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { HostSaveSink } from '../host/host';
import { createPortal } from 'react-dom';

import { useI18n } from '../i18n';
import { basenameOf, resolveHostPath, type FileReference, type MediaRef } from '@kiki/session-core/composer/media';
import { useOptionalConnection } from '../state/connection';
import type { PreviewResource } from '../state/previewResource';
import {
  closeAllPreviewTabs,
  closeOtherPreviewTabs,
  closePreviewTab,
  EMPTY_PREVIEW_TABS,
  hostFileResource,
  mediaRefResource,
  movePreviewTab,
  openPreviewTab,
  previewTabKey,
  type PreviewTab,
  type PreviewTabsState,
} from '../state/previewWorkspace';
import type { AgentForest, SessionController, SessionViewState } from '@kiki/session-core/session';
import type { AgentWorkspaceNavigation } from './agent-workspace';
import { ConfirmDialog } from './ConfirmDialog';
import { useOptionalConversationShell } from './ConversationShell';
import { useRailMode } from './rail-variants/shell';
import { locateInTimeline } from '../lib/timelineLocate';
import { useLayerHistory } from '../lib/layerHistory';
import { useMediaQuery } from '../lib/layoutHooks';
import { getReadingSnapshot, previewSnapshotKey, type PreviewReadingSnapshot } from '../lib/navViewState';
import { useNavSnapshotAdapter, useNavVisitId } from '../lib/useNavSnapshot';
import { useDirtyReporter } from './dirtyGuard';
import { httpImageLink, isOnKikiComputer, mediaOutcomeKey, resolveImageMime } from './imageActions';
import { imagePreviewLabel, safeImagePreviewName } from './imagePreviewName';
import { attachmentName, useSessionMedia } from './mediaParts';
import { remoteImageUrl } from './RemoteImageGate';
import { blockGalleryImages, canonicalGalleryItem, galleryImageId, orderedGalleryImages, type GalleryImage } from './mediaGallery';
import {
  LazyMediaLightbox,
  LazyPreviewWorkspace,
  LightboxLoadFailure,
  LightboxLoadingShell,
  PreviewLoadBoundary,
  PreviewPanelLoadFailure,
  PreviewPanelLoadingShell,
} from './preview/PreviewLoadBoundary';
import {
  MediaPreviewContext,
  useMediaPreview,
  type MediaPreviewApi,
} from './mediaPreviewContext';

export { useMediaPreview } from './mediaPreviewContext';

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

function applyCloseAction(state: PreviewTabsState, action: CloseAction, cwd?: string): PreviewTabsState {
  switch (action.kind) {
    case 'tab':
      return closePreviewTab(state, action.key, cwd);
    case 'others':
      return closeOtherPreviewTabs(state, action.key, cwd);
    case 'all':
      return closeAllPreviewTabs();
  }
}

/** Paths an action would close; used to decide whether to confirm first (panel tabs are not files). */
export function affectedByClose(state: PreviewTabsState, action: CloseAction, cwd?: string): readonly string[] {
  const getFilePath = (tab: PreviewTab): string | undefined =>
    tab.kind === 'resource' && tab.resource.source.kind === 'host-file' ? tab.resource.source.path : undefined;
  switch (action.kind) {
    case 'tab': {
      const match = state.tabs.find((tab) => previewTabKey(tab, cwd) === action.key);
      const path = match ? getFilePath(match) : undefined;
      return path !== undefined ? [path] : [];
    }
    case 'others':
      return state.tabs
        .filter((tab) => previewTabKey(tab, cwd) !== action.key)
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
  controller?: SessionController | null;
  workspaceSessionState?: SessionViewState;
  workspaceNavigation?: AgentWorkspaceNavigation;
  onCancelTask?: (taskId: string, ownerAgentId?: string) => void;
  onStopAgentTask?: (ownerAgentId: string, taskId: string) => Promise<void>;
  snapshotAgentId?: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const clientIdentity = connection?.client;
  const localKikiComputer = isOnKikiComputer(connection);
  const [image, setImage] = useState<{ src: string; name?: string; sourcePath?: string; client: unknown; sessionId?: string; agentId: string } | null>(null);
  const [gallery, setGallery] = useState<{ images: readonly GalleryImage[]; selected: number; client: unknown; sessionId?: string; scopeAgentId: string; seededId?: string; seededSrc?: string } | null>(null);
  const registeredImages = useRef<{ client: unknown; sessionId?: string; agentId: string; images: Map<string, GalleryImage> }>({ client: clientIdentity, sessionId, agentId: snapshotAgentId, images: new Map() });
  if (registeredImages.current.client !== clientIdentity || registeredImages.current.sessionId !== sessionId || registeredImages.current.agentId !== snapshotAgentId) {
    registeredImages.current = { client: clientIdentity, sessionId, agentId: snapshotAgentId, images: new Map() };
  }
  const registerGalleryImage = useCallback((entry: GalleryImage) => {
    registeredImages.current.images.set(entry.occurrenceId ?? entry.id, entry);
  }, []);
  const imagesFor = useCallback((item: MediaRef, agentId = snapshotAgentId) => {
    const id = galleryImageId(item, agentId);
    if (id === undefined) return [];
    const blocks = sessionViewState?.sessionId === sessionId ? sessionViewState?.blocks : undefined;
    const activeBlocks = blocks === undefined ? undefined : new Set(blocks.map((block) => block.id));
    const registered = [...registeredImages.current.images.values()].filter((entry) =>
      activeBlocks === undefined || entry.blockId === undefined || entry.agentId !== snapshotAgentId || activeBlocks.has(entry.blockId));
    const approved = new Set(registered.map((entry) => entry.item.url).filter((url) => url !== undefined));
    const source = blocks === undefined ? [] : blockGalleryImages(blocks, snapshotAgentId).filter(({ item: entry }) =>
      remoteImageUrl(entry.url, clientIdentity?.baseUrl) === undefined || entry.url === item.url || (entry.url !== undefined && approved.has(entry.url)));
    const entries = [...source, ...registered];
    if (!entries.some((entry) => entry.id === id)) entries.push({ id, agentId, order: [Number.MAX_SAFE_INTEGER], item: canonicalGalleryItem(item, agentId) });
    return orderedGalleryImages(entries, agentId);
  }, [clientIdentity, sessionId, snapshotAgentId, sessionViewState]);
  const openGalleryImage = useCallback((item: MediaRef, agentId = snapshotAgentId, initialSrc?: string, occurrenceId?: string) => {
    const id = galleryImageId(item, agentId);
    if (id === undefined) return;
    const images = imagesFor(item, agentId);
    const selected = occurrenceId === undefined ? -1 : images.findIndex((entry) => entry.occurrenceId === occurrenceId);
    const index = selected < 0 ? images.findIndex((entry) => entry.id === id) : selected;
    if (index < 0) return;
    setImage(null);
    setGallery({ images, selected: index, client: clientIdentity, sessionId, scopeAgentId: snapshotAgentId, seededId: initialSrc === undefined ? undefined : id, seededSrc: initialSrc });
  }, [clientIdentity, imagesFor, sessionId, snapshotAgentId]);
  useEffect(() => { setImage(null); setGallery(null); }, [clientIdentity, sessionId, snapshotAgentId]);
  const previewKey = sessionId === undefined ? 'preview:unsessioned' : previewSnapshotKey(sessionId, snapshotAgentId);
  const visitId = useNavVisitId();
  const initialSnapshot = useMemo(
    () => (visitId === null ? undefined : getReadingSnapshot<PreviewReadingSnapshot>(visitId, previewKey)),
    [visitId, previewKey],
  );
  const [tabsState, setTabsState] = useState<PreviewTabsState>(() => initialSnapshot?.tabsState ?? EMPTY_PREVIEW_TABS);
  const [panelOpen, setPanelOpen] = useState(() => Boolean(initialSnapshot?.panelOpen && initialSnapshot.tabsState.tabs.length > 0));
  const [width, setWidth] = useState(readStoredWidth);
  const [dirtyPaths, setDirtyPaths] = useState<ReadonlySet<string>>(new Set());
  const [positions, setPositions] = useState<Readonly<Record<string, { top: number; left?: number }>>>(() => initialSnapshot?.positions ?? {});
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

  useNavSnapshotAdapter<PreviewReadingSnapshot>(previewKey, {
    ready: sessionId !== undefined,
    capture: () => ({ tabsState, panelOpen, positions }),
    restore: (snapshot) => {
      setNavigation(undefined);
      setTabsState((current) => {
        const kept = current.tabs.filter(
          (tab) =>
            tab.kind === 'resource' &&
            tab.resource.source.kind === 'host-file' &&
            dirtyPaths.has(tab.resource.source.path) &&
            !snapshot.tabsState.tabs.some((candidate) => previewTabKey(candidate, cwd) === previewTabKey(tab, cwd)),
        );
        if (kept.length === 0) return snapshot.tabsState;
        const active = snapshot.tabsState.active ?? previewTabKey(kept[0]!, cwd);
        return { tabs: [...snapshot.tabsState.tabs, ...kept], active };
      });
      setPanelOpen(snapshot.panelOpen && snapshot.tabsState.tabs.length > 0);
      setPositions(snapshot.positions);
    },
  });
  const [, chooseMode] = useRailMode();
  const cockpit = shell?.cockpit === true;
  const overlayStage = useMediaQuery('(max-width: 1023px)');
  const collapsePanel = useCallback(() => { setPanelOpen(false); }, []);
  useLayerHistory('preview-workspace', panelOpen && !cockpit && tabsState.tabs.length > 0 && overlayStage, collapsePanel);
  const revealPreview = useCallback(() => {
    if (cockpit) chooseMode('default');
    setPanelOpen(true);
  }, [cockpit, chooseMode]);

  const [navigation, setNavigation] = useState<FileReference | undefined>();
  const openResource = useCallback(
    (resource: PreviewResource, nextNavigation?: FileReference, size?: number) => {
      const key = previewTabKey({ kind: 'resource', resource }, cwd);
      const existing = tabsState.tabs.find(
        (tab) => tab.kind === 'resource' && previewTabKey(tab, cwd) === key,
      );
      const existingHostPath =
        existing?.kind === 'resource' && existing.resource.source.kind === 'host-file'
          ? existing.resource.source.path
          : undefined;
      setTabsState((state) => openPreviewTab(state, { kind: 'resource', resource, size }, cwd));
      if (nextNavigation !== undefined) {
        setNavigation(
          existingHostPath !== undefined ? { ...nextNavigation, path: existingHostPath } : nextNavigation,
        );
      } else {
        setNavigation(undefined);
      }
      revealPreview();
    },
    [cwd, revealPreview, tabsState.tabs],
  );

  const openFile = useCallback(
    (input: string | FileReference) => {
      const raw = typeof input === 'string' ? { path: input } : input;
      const resource = hostFileResource(raw.path, cwd);
      const resolvedPath = resource.source.kind === 'host-file' ? resource.source.path : resolveHostPath(raw.path, cwd);
      openResource(resource, { ...raw, path: resolvedPath });
    },
    [cwd, openResource],
  );

  const openAgentPanel = useCallback((agentId: string, title?: string) => {
    setTabsState((state) => openPreviewTab(state, { kind: 'panel', agentId, title }, cwd));
    revealPreview();
    if (sessionId !== undefined) {
      void locateInTimeline({ kind: 'latest', respectReader: true }, { sessionId, agentId, notify: false });
    }
  }, [cwd, sessionId, revealPreview]);

  const openBuiltinSkill = useCallback((name: string) => {
    setTabsState((state) => openPreviewTab(state, { kind: 'skill', name }, cwd));
    revealPreview();
  }, [cwd, revealPreview]);

  const openAttachmentInWorkspace = useCallback(
    (item: MediaRef) => {
      const fallbackName = item.kind === 'image' ? t('media.image') : t('media.attachment');
      const resource = mediaRefResource(item, {
        sessionId,
        origin: item.origin,
        cwd,
        name: attachmentName(item, undefined, fallbackName),
      });
      openResource(resource, undefined, item.size);
    },
    [cwd, openResource, sessionId, t],
  );

  const openWeb = useCallback((url: string, title?: string) => {
    setNavigation(undefined);
    setTabsState((state) => openPreviewTab(state, { kind: 'web', url, title }, cwd));
    revealPreview();
  }, [cwd, revealPreview]);

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
      const affected = affectedByClose(tabsState, action, cwd);
      const dirty = affected.filter((path) => dirtyPaths.has(path));
      if (dirty.length > 0) {
        setConfirmClose({ dirty, action });
        return;
      }
      setTabsState((state) => {
        const next = applyCloseAction(state, action, cwd);
        if (next.tabs.length === 0) setPanelOpen(false);
        return next;
      });
    },
    [cwd, tabsState, dirtyPaths],
  );

  const confirmCloseRun = useCallback(() => {
    setConfirmClose((pending) => {
      if (pending !== null) {
        setTabsState((state) => {
          const next = applyCloseAction(state, pending.action, cwd);
          if (next.tabs.length === 0) setPanelOpen(false);
          return next;
        });
      }
      return null;
    });
  }, [cwd]);

  const handleMove = useCallback((key: string, targetIndex: number) => {
    setTabsState((state) => movePreviewTab(state, key, targetIndex, cwd));
  }, [cwd]);

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

  const activeAgentPanelId =
    panelOpen && tabsState.active !== null
      ? (tabsState.tabs.find(
          (tab) => previewTabKey(tab, cwd) === tabsState.active && tab.kind === 'panel',
        ) as { agentId: string } | undefined)?.agentId
      : undefined;
  const api = useMemo<MediaPreviewApi>(
    () => ({
      cwd,
      sessionId,
      openImage: (src, name) => { setGallery(null); setImage({ src, name, client: clientIdentity, sessionId, agentId: snapshotAgentId }); },
      openGalleryImage,
      registerGalleryImage,
      openResource,
      openFile,
      openAttachment: (item, galleryAgentId = snapshotAgentId) => {
        const isImage = item.kind === 'image' || item.mime?.startsWith('image/') === true;
        const id = galleryImageId(item, galleryAgentId);
        if (isImage && id !== undefined) {
          openGalleryImage(item, galleryAgentId);
          return;
        }
        if (isImage && item.url !== undefined) {
          setGallery(null);
          setImage({ src: item.url, name: item.name, client: clientIdentity, sessionId, agentId: snapshotAgentId });
          return;
        }
        openAttachmentInWorkspace(item);
      },
      openAttachmentInWorkspace,
      openWeb,
      openAgentPanel,
      openBuiltinSkill,
      previewTabCount: tabsState.tabs.length,
      previewPanelOpen: panelOpen && !cockpit,
      previewPanelWidth: panelOpen ? width : undefined,
      togglePreviewPanel: togglePanel,
      activeAgentPanelId,
    }),
    [
      cwd,
      sessionId,
      clientIdentity,
      snapshotAgentId,
      openGalleryImage,
      registerGalleryImage,
      openResource,
      openFile,
      openAttachmentInWorkspace,
      openWeb,
      openAgentPanel,
      openBuiltinSkill,
      tabsState.tabs.length,
      panelOpen,
      cockpit,
      width,
      togglePanel,
      activeAgentPanelId,
    ],
  );

  useEffect(() => {
    if (!apiRef) return;
    if (typeof apiRef === 'function') {
      apiRef(api);
    } else {
      (apiRef as React.MutableRefObject<MediaPreviewApi | null>).current = api;
    }
  }, [api, apiRef]);

  const panelHidden = !panelOpen || cockpit;
  const panelOverlay = shell?.slots.preview === null || shell?.slots.preview === undefined;
  const panel = tabsState.tabs.length > 0 ? (
    <PreviewLoadBoundary
      resetKey={previewKey}
      renderFailure={(error) => (
        <PreviewPanelLoadFailure
          error={error}
          width={width}
          hidden={panelHidden}
          overlay={panelOverlay}
          onCollapse={() => { setPanelOpen(false); }}
        />
      )}
    >
      <Suspense fallback={<PreviewPanelLoadingShell width={width} hidden={panelHidden} overlay={panelOverlay} />}>
        <LazyPreviewWorkspace
          tabs={tabsState.tabs}
          active={tabsState.active}
          navigation={navigation}
          dirtyPaths={dirtyPaths}
          width={width}
          hidden={panelHidden}
          sessionViewState={workspaceSessionState ?? sessionViewState}
          agentForest={agentForest}
          onOpenSubagent={onOpenSubagent}
          controller={controller}
          workspaceNavigation={workspaceNavigation}
          onCancelTask={onCancelTask}
          onStopAgentTask={onStopAgentTask}
          onActivate={(key) => { setNavigation(undefined); setTabsState((state) => ({ ...state, active: key })); }}
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
          onOpenImage={(src, name, sourcePath) => { setImage({ src, name, sourcePath, client: clientIdentity, sessionId, agentId: snapshotAgentId }); }}
          reportDirty={reportDirty}
          scrollPositions={positions}
          onScrollPosition={reportPosition}
          overlay={panelOverlay}
          cwd={cwd}
          sessionId={sessionId}
        />
      </Suspense>
    </PreviewLoadBoundary>
  ) : null;

  return (
    <MediaPreviewContext.Provider value={api}>
      {children}
      {panel !== null && shell?.slots.preview !== null && shell?.slots.preview !== undefined
        ? createPortal(panel, shell.slots.preview)
        : panel}
      {confirmClose !== null ? (
        <ConfirmDialog
          open
          overlayId="preview-close-dirty"
          title={t('preview.discardTitle')}
          body={
            confirmClose.dirty.length === 1
              ? t('preview.discardBody', { name: basenameOf(confirmClose.dirty[0] ?? '') })
              : t('preview.discardBodyMany', { count: confirmClose.dirty.length })
          }
          confirmLabel={t('preview.discard')}
          tone="danger"
          onConfirm={confirmCloseRun}
          onCancel={() => { setConfirmClose(null); }}
        />
      ) : null}
      {gallery !== null && gallery.client === clientIdentity && gallery.sessionId === sessionId && gallery.scopeAgentId === snapshotAgentId && gallery.images[gallery.selected] !== undefined ? (
        <GalleryLightbox
          image={gallery.images[gallery.selected]!}
          sessionId={sessionId}
          localKikiComputer={localKikiComputer}
          seededSrc={gallery.seededId === gallery.images[gallery.selected]!.id ? gallery.seededSrc : undefined}
          index={gallery.selected}
          count={gallery.images.length}
          onSelect={(selected) => { setGallery((current) => current === null ? null : { ...current, selected }); }}
          onClose={() => { setGallery(null); }}
        />
      ) : null}
      {image !== null && image.client === clientIdentity && image.sessionId === sessionId && image.agentId === snapshotAgentId ? (
        <PreviewLoadBoundary
          resetKey={image.src}
          renderFailure={(error) => (
            <LightboxLoadFailure
              error={error}
              label={imagePreviewLabel({ name: image.name }, t('media.image'))}
              onClose={() => { setImage(null); }}
            />
          )}
        >
          <Suspense
            fallback={
              <LightboxLoadingShell
                label={imagePreviewLabel({ name: image.name }, t('media.image'))}
                onClose={() => { setImage(null); }}
              />
            }
          >
            <LazyMediaLightbox
              src={image.src}
              name={image.name}
              sourcePath={image.sourcePath}
              linkUrl={httpImageLink(image.src)}
              outcomeKey={mediaOutcomeKey({ url: image.src })}
              localKikiComputer={localKikiComputer}
              onClose={() => { setImage(null); }}
            />
          </Suspense>
        </PreviewLoadBoundary>
      ) : null}
    </MediaPreviewContext.Provider>
  );
}

export { PreviewToggleButton } from './PreviewToggleButton';

// ---------------------------------------------------------------------------

/**
 * A media store answers saved tool results under a generic type, and a decoder
 * that trusts the label refuses them. The bytes are already in hand, so the URL
 * handed to the viewer is minted with the type they really are — the same bytes,
 * one correct label.
 */
function useTypedImageUrl(bytes: Uint8Array | undefined, declared: string | undefined): string | undefined {
  const [typed, setTyped] = useState<{ readonly url: string }>();
  useEffect(() => {
    if (bytes === undefined) return;
    const mime = resolveImageMime(bytes, declared);
    if (mime === undefined || mime === declared) return;
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    setTyped({ url });
    return () => {
      URL.revokeObjectURL(url);
      setTyped((current) => current?.url === url ? undefined : current);
    };
  }, [bytes, declared]);
  return typed?.url;
}

function GalleryLightbox({ image, sessionId, localKikiComputer = false, seededSrc, index, count, onSelect, onClose }: { image: GalleryImage; sessionId?: string; localKikiComputer?: boolean; seededSrc?: string; index: number; count: number; onSelect: (index: number) => void; onClose: () => void }) {
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const client = connection?.client;
  const preview = useMediaPreview();
  const hostPath = image.item.path === undefined ? undefined : resolveHostPath(image.item.path, preview?.cwd);
  const [retry, setRetry] = useState({ id: image.id, attempt: 0 });
  const canonical = seededSrc === undefined && (image.item.fileId !== undefined || hostPath !== undefined);
  const load = useSessionMedia(image.item, sessionId, canonical, false, retry.id === image.id ? retry.attempt : 0);
  const bytes = load.status === 'ready' ? load.bytes : undefined;
  const mime = bytes === undefined ? image.item.mime : resolveImageMime(bytes, load.status === 'ready' ? load.mime : image.item.mime) ?? image.item.mime;
  const typedSrc = useTypedImageUrl(bytes, mime);
  const src = seededSrc ?? typedSrc ?? (canonical ? load.status === 'ready' ? load.url : undefined : image.item.url);
  const size = load.status === 'ready' ? load.bytes.byteLength : image.item.size;

  const onSaveOriginal = useMemo(() => {
    if (client === undefined || (hostPath === undefined && (sessionId === undefined || image.item.fileId === undefined))) return undefined;
    return async (sink: HostSaveSink, signal: AbortSignal, onProgress: (bytes: number, total?: number) => void) => {
      const consume: import('@kiki/klient').HttpRestMediaSink = async (chunk, progress) => {
        await sink.write(chunk);
        onProgress(progress.bytes, progress.totalBytes);
      };
      const options = { ...client.readingOptions(), signal };
      if (hostPath !== undefined) await client.downloadHostFile(hostPath, consume, options);
      else await client.downloadSessionMedia(sessionId!, image.item.fileId!, consume, options);
    };
  }, [client, sessionId, hostPath, image.item.fileId]);

  const resolvedName = safeImagePreviewName({
    name: image.item.name,
    metadataName: load.status === 'ready' ? load.name : undefined,
    path: image.item.path,
  });
  const fallbackLabel = imagePreviewLabel({ name: resolvedName }, t('media.image'));

  return (
    <PreviewLoadBoundary
      resetKey={image.id}
      renderFailure={(error) => <LightboxLoadFailure error={error} label={fallbackLabel} onClose={onClose} />}
    >
      <Suspense fallback={<LightboxLoadingShell label={fallbackLabel} onClose={onClose} />}>
        <LazyMediaLightbox
          src={src}
          identity={image.id}
          name={resolvedName}
          sourcePath={hostPath}
          linkUrl={httpImageLink(image.item.url)}
          outcomeKey={mediaOutcomeKey({ ...image.item, sessionId })}
          localKikiComputer={localKikiComputer}
          mime={mime}
          size={size}
          loading={canonical && load.status === 'loading'}
          failed={canonical && load.status === 'failed'}
          onRetry={() => { setRetry((current) => ({ id: image.id, attempt: current.id === image.id ? current.attempt + 1 : 1 })); }}
          onSaveOriginal={onSaveOriginal}
          index={index}
          count={count}
          onSelect={onSelect}
          onClose={onClose}
        />
      </Suspense>
    </PreviewLoadBoundary>
  );
}

export { FilePathLink, MediaPart, MediaPartList, type MediaThumbSize } from './mediaParts';
