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

import { Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { UNSAFE_LocationContext } from 'react-router-dom';
import type { HostSaveSink } from '../host/host';
import { createPortal } from 'react-dom';

import { useI18n } from '../i18n';
import {
  agentDraftKey,
  appendAttachmentToDraft,
  fileToImageAttachment,
  MAX_ATTACHMENTS,
  MAX_TOTAL_IMAGE_BYTES,
  resolveActiveDraftKey,
  revokeAttachmentPreviewUrl,
} from '@kiki/session-core/composer';
import { basenameOf, formatBytes, resolveHostPath, type FileReference, type MediaRef } from '@kiki/session-core/composer/media';
import { pushToast } from '../lib/toasts';
import type { AnnotationRecord, MediaLightboxThumbnail } from './MediaLightbox';
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
import { locateInTimeline } from '../lib/timelineLocate';
import { registerSessionPluginPanelOpener } from '../lib/pluginPanelPreview';
import { useLayerHistory } from '../lib/layerHistory';
import { useMediaQuery } from '../lib/layoutHooks';
import { getReadingSnapshot, previewSnapshotKey, type PreviewReadingSnapshot } from '../lib/navViewState';
import { useNavSnapshotAdapter, useNavVisitId } from '../lib/useNavSnapshot';
import { useDirtyReporter } from './dirtyGuard';
import { httpImageLink, isOnKikiComputer, mediaOutcomeKey, resolveImageMime } from './imageActions';
import { imagePreviewLabel, safeImagePreviewName } from './imagePreviewName';
import { ActiveDraftKeyProvider, attachmentName, useSessionMedia } from './mediaParts';
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
import { DEFAULT_PREVIEW_WIDTH } from './preview/shared';

export { useMediaPreview } from './mediaPreviewContext';

const WIDTH_STORAGE_KEY = 'kiki.previewPanelWidth';

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_STORAGE_KEY);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) && value >= 320 ? value : DEFAULT_PREVIEW_WIDTH;
  } catch {
    return DEFAULT_PREVIEW_WIDTH;
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
  registerSessionOpener = true,
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
  /** False on auxiliary surfaces (`/capabilities` media resolver) that pass a `sessionId` without owning a conversation preview workspace. */
  registerSessionOpener?: boolean;
  children: ReactNode;
}) {
  const { t, locale } = useI18n();
  const connection = useOptionalConnection();
  const clientIdentity = connection?.client;
  const localKikiComputer = isOnKikiComputer(connection);
  const locationContext = useContext(UNSAFE_LocationContext);
  const activeDraftKey = resolveActiveDraftKey(
    connection?.scopeId,
    sessionId,
    snapshotAgentId !== 'main'
      ? snapshotAgentId
      : (locationContext?.location.pathname ?? (typeof window !== 'undefined' ? window.location.pathname : undefined)),
  );
  const [lightboxAnnotations, setLightboxAnnotations] = useState<Record<string, AnnotationRecord>>({});
  const [image, setImage] = useState<{ src: string; name?: string; sourcePath?: string; client: unknown; sessionId?: string; agentId: string; targetAgentId?: string } | null>(null);
  const [gallery, setGallery] = useState<{ images: readonly GalleryImage[]; selected: number; client: unknown; sessionId?: string; scopeAgentId: string; targetAgentId?: string; seededId?: string; seededSrc?: string } | null>(null);
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
  const openGalleryImage = useCallback((item: MediaRef, agentId?: string, initialSrc?: string, occurrenceId?: string) => {
    const effectiveAgentId = agentId ?? snapshotAgentId;
    const id = galleryImageId(item, effectiveAgentId);
    if (id === undefined) return;
    const images = imagesFor(item, effectiveAgentId);
    const selected = occurrenceId === undefined ? -1 : images.findIndex((entry) => entry.occurrenceId === occurrenceId);
    const index = selected < 0 ? images.findIndex((entry) => entry.id === id) : selected;
    if (index < 0) return;
    setImage(null);
    setGallery({ images, selected: index, client: clientIdentity, sessionId, scopeAgentId: snapshotAgentId, targetAgentId: agentId, seededId: initialSrc === undefined ? undefined : id, seededSrc: initialSrc });
  }, [clientIdentity, imagesFor, sessionId, snapshotAgentId]);
  useEffect(() => { setImage(null); setGallery(null); setLightboxAnnotations({}); }, [clientIdentity, sessionId, snapshotAgentId]);

  const attachAnnotatedImageFor = useCallback(
    (targetAgentId?: string) => {
      const targetDraftKey =
        sessionId !== undefined && sessionId !== '' && targetAgentId !== undefined && targetAgentId !== ''
          ? agentDraftKey(connection?.scopeId, sessionId, targetAgentId)
          : activeDraftKey;
      if (targetDraftKey === undefined) return undefined;
      return async (blob: Blob, filename: string): Promise<boolean> => {
        const file = new File([blob], filename, { type: blob.type || 'image/png' });
        const attachment = await fileToImageAttachment(file);
        const result = appendAttachmentToDraft(targetDraftKey, attachment);
        if (!result.added) {
          revokeAttachmentPreviewUrl(attachment);
          pushToast({
            tone: 'error',
            text:
              result.reason === 'total_too_large'
                ? t('attach.totalTooLarge', { max: formatBytes(MAX_TOTAL_IMAGE_BYTES) })
                : t('attach.tooMany', { max: MAX_ATTACHMENTS }),
          });
          return false;
        }
        pushToast({
          tone: 'success',
          text: locale === 'zh' ? '已将标注图片加入对话' : 'Annotated image added to chat',
        });
        return true;
      };
    },
    [activeDraftKey, connection?.scopeId, locale, sessionId, t],
  );
  const previewKey = sessionId === undefined ? 'preview:unsessioned' : previewSnapshotKey(sessionId, snapshotAgentId);
  const visitId = useNavVisitId();
  const initialSnapshot = useMemo(
    () => (visitId === null ? undefined : getReadingSnapshot<PreviewReadingSnapshot>(visitId, previewKey)),
    [visitId, previewKey],
  );
  const [tabsState, setTabsState] = useState<PreviewTabsState>(() => initialSnapshot?.tabsState ?? EMPTY_PREVIEW_TABS);
  const [panelOpen, setPanelOpen] = useState(() => Boolean(initialSnapshot?.panelOpen && initialSnapshot.tabsState.tabs.length > 0));
  const [previewMaximized, setPreviewMaximized] = useState(false);
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
      setPreviewMaximized(false);
      setPositions(snapshot.positions);
    },
  });
  const overlayStage = useMediaQuery('(max-width: 1023px)');
  const collapsePanel = useCallback(() => {
    setPanelOpen(false);
    setPreviewMaximized(false);
  }, []);
  useLayerHistory('preview-workspace', panelOpen && tabsState.tabs.length > 0 && overlayStage, collapsePanel);
  const revealPreview = useCallback(() => {
    setPanelOpen(true);
  }, []);
  const togglePreviewMaximized = useCallback(() => {
    setPreviewMaximized((current) => !current);
  }, []);
  const exitPreviewMaximized = useCallback(() => {
    setPreviewMaximized(false);
  }, []);

  useEffect(() => {
    setPreviewMaximized(false);
  }, [sessionId, snapshotAgentId]);

  useEffect(() => {
    if (!panelOpen || tabsState.tabs.length === 0 || overlayStage) {
      setPreviewMaximized(false);
    }
  }, [panelOpen, tabsState.tabs.length, overlayStage]);

  const previewVisible = panelOpen && tabsState.tabs.length > 0;
  const effectiveMaximized = previewVisible && previewMaximized && !overlayStage;
  const shellPreviewOwner = useMemo(() => ({}), []);
  const ownsShellPreview =
    registerSessionOpener && shell?.slots.preview !== null && shell?.slots.preview !== undefined;
  const registerShellPreview = shell?.registerPreview;
  const unregisterShellPreview = shell?.unregisterPreview;
  useLayoutEffect(() => {
    if (!ownsShellPreview || registerShellPreview === undefined) return;
    registerShellPreview(shellPreviewOwner, { open: previewVisible, maximized: effectiveMaximized });
  }, [ownsShellPreview, registerShellPreview, shellPreviewOwner, previewVisible, effectiveMaximized]);
  useLayoutEffect(() => {
    if (!ownsShellPreview || unregisterShellPreview === undefined) return;
    return () => {
      unregisterShellPreview(shellPreviewOwner);
    };
  }, [ownsShellPreview, unregisterShellPreview, shellPreviewOwner]);

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

  const openPluginPanel = useCallback((pluginId: string, panelId: string, title?: string) => {
    setNavigation(undefined);
    setTabsState((state) => openPreviewTab(state, { kind: 'plugin', pluginId, panelId, title }, cwd));
    revealPreview();
  }, [cwd, revealPreview]);

  const togglePanel = useCallback(() => {
    setPanelOpen((value) => {
      if (value) setPreviewMaximized(false);
      return !value;
    });
  }, []);

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
        if (next.tabs.length === 0) {
          setPanelOpen(false);
          setPreviewMaximized(false);
        }
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
          if (next.tabs.length === 0) {
            setPanelOpen(false);
            setPreviewMaximized(false);
          }
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
  const activePluginTab =
    panelOpen && tabsState.active !== null
      ? tabsState.tabs.find(
          (tab): tab is Extract<PreviewTab, { kind: 'plugin' }> =>
            previewTabKey(tab, cwd) === tabsState.active && tab.kind === 'plugin',
        )
      : undefined;
  const activePluginPanelKey =
    activePluginTab !== undefined
      ? `${activePluginTab.pluginId}:${activePluginTab.panelId}`
      : undefined;

  const openPluginPanelRef = useRef(openPluginPanel);
  openPluginPanelRef.current = openPluginPanel;
  const activePluginPanelKeyRef = useRef(activePluginPanelKey);
  activePluginPanelKeyRef.current = activePluginPanelKey;
  const openerHandleRef = useRef<ReturnType<typeof registerSessionPluginPanelOpener> | null>(null);

  useEffect(() => {
    if (!registerSessionOpener || sessionId === undefined) return;
    const handle = registerSessionPluginPanelOpener({
      sessionId,
      agentId: snapshotAgentId,
      open: ({ pluginId, panelId, title }) => {
        openPluginPanelRef.current(pluginId, panelId, title);
      },
      activePluginPanelKey: activePluginPanelKeyRef.current,
    });
    openerHandleRef.current = handle;
    return () => {
      openerHandleRef.current = null;
      handle.unregister();
    };
  }, [registerSessionOpener, sessionId, snapshotAgentId]);

  useEffect(() => {
    openerHandleRef.current?.update({
      open: ({ pluginId, panelId, title }) => {
        openPluginPanelRef.current(pluginId, panelId, title);
      },
      activePluginPanelKey,
    });
  }, [openPluginPanel, activePluginPanelKey]);

  const api = useMemo<MediaPreviewApi>(
    () => ({
      cwd,
      sessionId,
      openImage: (src, name, targetAgentId) => {
        setGallery(null);
        setImage({ src, name, client: clientIdentity, sessionId, agentId: snapshotAgentId, targetAgentId });
      },
      openGalleryImage,
      registerGalleryImage,
      openResource,
      openFile,
      openAttachment: (item, galleryAgentId) => {
        const effectiveAgentId = galleryAgentId ?? snapshotAgentId;
        const isImage = item.kind === 'image' || item.mime?.startsWith('image/') === true;
        const id = galleryImageId(item, effectiveAgentId);
        if (isImage && id !== undefined) {
          openGalleryImage(item, galleryAgentId);
          return;
        }
        if (isImage && item.url !== undefined) {
          setGallery(null);
          setImage({ src: item.url, name: item.name, client: clientIdentity, sessionId, agentId: snapshotAgentId, targetAgentId: galleryAgentId });
          return;
        }
        openAttachmentInWorkspace(item);
      },
      openAttachmentInWorkspace,
      openWeb,
      openPluginPanel,
      openAgentPanel,
      openBuiltinSkill,
      previewTabCount: tabsState.tabs.length,
      previewPanelOpen: panelOpen,
      previewPanelWidth: panelOpen ? width : undefined,
      previewMaximized: effectiveMaximized,
      togglePreviewMaximized,
      setPreviewMaximized,
      togglePreviewPanel: togglePanel,
      activeAgentPanelId,
      activePluginPanelKey,
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
      openPluginPanel,
      openAgentPanel,
      openBuiltinSkill,
      tabsState.tabs.length,
      panelOpen,
      width,
      effectiveMaximized,
      togglePreviewMaximized,
      togglePanel,
      activeAgentPanelId,
      activePluginPanelKey,
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

  const panelHidden = !panelOpen;
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
          onCollapse={collapsePanel}
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
          isFullscreen={effectiveMaximized}
          onToggleFullscreen={togglePreviewMaximized}
          onExitFullscreen={exitPreviewMaximized}
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
          onCollapse={collapsePanel}
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
    <ActiveDraftKeyProvider sessionId={sessionId} draftKey={activeDraftKey}>
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
            images={gallery.images}
            image={gallery.images[gallery.selected]!}
            sessionId={sessionId}
            localKikiComputer={localKikiComputer}
            seededSrc={gallery.seededId === gallery.images[gallery.selected]!.id ? gallery.seededSrc : undefined}
            index={gallery.selected}
            count={gallery.images.length}
            savedAnnotations={lightboxAnnotations}
            onAnnotationsChange={setLightboxAnnotations}
            onAttachAnnotatedImage={attachAnnotatedImageFor(gallery.targetAgentId)}
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
                savedAnnotations={lightboxAnnotations}
                onAnnotationsChange={setLightboxAnnotations}
                onAttachAnnotatedImage={attachAnnotatedImageFor(image.targetAgentId)}
                onClose={() => { setImage(null); }}
              />
            </Suspense>
          </PreviewLoadBoundary>
        ) : null}
      </MediaPreviewContext.Provider>
    </ActiveDraftKeyProvider>
  );
}

export { PreviewToggleButton, WorkspacePanelsControl } from './PreviewToggleButton';

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

function GalleryLightbox({ images, image, sessionId, localKikiComputer = false, seededSrc, index, count, savedAnnotations, onAnnotationsChange, onAttachAnnotatedImage, onSelect, onClose }: { images: readonly GalleryImage[]; image: GalleryImage; sessionId?: string; localKikiComputer?: boolean; seededSrc?: string; index: number; count: number; savedAnnotations?: Readonly<Record<string, AnnotationRecord>>; onAnnotationsChange?: (updater: (previous: Record<string, AnnotationRecord>) => Record<string, AnnotationRecord>) => void; onAttachAnnotatedImage?: (blob: Blob, filename: string) => Promise<boolean> | boolean; onSelect: (index: number) => void; onClose: () => void }) {
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const client = connection?.client;
  const preview = useMediaPreview();
  const hostPath = image.item.path === undefined ? undefined : resolveHostPath(image.item.path, preview?.cwd);
  const [retry, setRetry] = useState({ id: image.id, attempt: 0 });
  const hasCanonicalSource =
    (sessionId !== undefined && image.item.fileId !== undefined && typeof (client as { readSessionMediaBytes?: unknown } | undefined)?.readSessionMediaBytes === 'function') ||
    (hostPath !== undefined && typeof (client as { readHostFileBytes?: unknown } | undefined)?.readHostFileBytes === 'function');
  const retryAttempt = retry.id === image.id ? retry.attempt : 0;
  const load = useSessionMedia(image.item, sessionId, hasCanonicalSource, false, retryAttempt);
  const bytes = load.status === 'ready' ? load.bytes : undefined;
  const mime = bytes === undefined ? image.item.mime : resolveImageMime(bytes, load.status === 'ready' ? load.mime : image.item.mime) ?? image.item.mime;
  const typedSrc = useTypedImageUrl(bytes, load.status === 'ready' ? load.mime : undefined);
  const externalSeedSrc = hasCanonicalSource && seededSrc?.startsWith('blob:') === true ? undefined : seededSrc;
  const previewFallbackSrc = load.status === 'failed'
    ? undefined
    : (externalSeedSrc ?? (load.status !== 'ready' ? load.thumbnailUrl : undefined));
  const fullSrc = hasCanonicalSource
    ? (load.status === 'ready' ? (typedSrc ?? load.url) : undefined)
    : (externalSeedSrc ?? image.item.url);
  const src = fullSrc ?? previewFallbackSrc;
  const size = load.status === 'ready' ? load.bytes.byteLength : image.item.size;
  const isLoading = src === undefined && hasCanonicalSource && load.status === 'loading';
  const isFailed = src === undefined && hasCanonicalSource && load.status === 'failed';

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

  const thumbnails = useMemo<readonly MediaLightboxThumbnail[] | undefined>(
    () => (images.length > 1
      ? images.map((entry, entryIndex) => ({
          id: entry.occurrenceId ?? `${entry.id}:${entryIndex}`,
          src: entry.item.url,
          label: safeImagePreviewName({ name: entry.item.name, path: entry.item.path }),
        }))
      : undefined),
    [images],
  );

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
          loading={isLoading}
          failed={isFailed}
          onRetry={() => { setRetry((current) => ({ id: image.id, attempt: current.id === image.id ? current.attempt + 1 : 1 })); }}
          onSaveOriginal={onSaveOriginal}
          savedAnnotations={savedAnnotations}
          onAnnotationsChange={onAnnotationsChange}
          onAttachAnnotatedImage={onAttachAnnotatedImage}
          index={index}
          count={count}
          thumbnails={thumbnails}
          onSelect={onSelect}
          onClose={onClose}
        />
      </Suspense>
    </PreviewLoadBoundary>
  );
}

export { FilePathLink, MediaPart, MediaPartList, type MediaThumbSize } from './mediaParts';
