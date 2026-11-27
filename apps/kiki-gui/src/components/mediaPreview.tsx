/**
 * MediaPreviewProvider — owns the transcript's media overlays (image lightbox)
 * and the resident preview workspace (multi-tab resource panel) plus the session
 * cwd, exposed through MediaPreviewContext. Also hosts the small
 * presentational building blocks that consume it: MediaPartList
 * (thumbnails/chips for message media refs) and FilePathLink (clickable host
 * paths).
 */

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { UNSAFE_LocationContext } from 'react-router-dom';
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
import { formatBytes, resolveHostPath, type FileReference, type MediaRef } from '@kiki/session-core/composer/media';
import { pushToast } from '../lib/toasts';
import type { AnnotationRecord } from './MediaLightbox';
import { useOptionalConnection } from '../state/connection';
import type { PreviewResource } from '../state/previewResource';
import {
  closeAllPreviewTabs,
  closeOtherPreviewTabs,
  closePreviewTab,
  DEFAULT_PREVIEW_WIDTH,
  EMPTY_PREVIEW_TABS,
  hostFileResource,
  mediaRefResource,
  movePreviewTab,
  openPreviewTab,
  previewTabKey,
  promoteResidentPluginEntry,
  removeResidentPluginEntries,
  type PluginTab,
  type PreviewTab,
  type PreviewTabsState,
  type ResidentPluginEntry,
} from '../state/previewWorkspace';
import type { AgentForest, SessionController, SessionViewState } from '@kiki/session-core/session';
import type { AgentWorkspaceNavigation } from './agent-workspace';
import { lazyComponent } from '../lib/lazyComponent';
import { useOptionalConversationShell } from './ConversationShell';
import { locateInTimeline } from '../lib/timelineLocate';
import { registerSessionPluginPanelOpener } from '../lib/pluginPanelPreview';
import { useLayerHistory } from '../lib/layerHistory';
import { useMediaQuery, usePhoneMode } from '../lib/layoutHooks';
import { getReadingSnapshot, previewSnapshotKey, type PreviewReadingSnapshot } from '../lib/navViewState';
import { useNavSnapshotAdapter, useNavVisitId } from '../lib/useNavSnapshot';
import { useDirtyReporter } from './dirtyGuard';
import { isOnKikiComputer } from './imageActions';
import { ActiveDraftKeyProvider, attachmentName } from './mediaParts';
import { remoteImageUrl } from './RemoteImageGate';
import { blockGalleryImages, canonicalGalleryItem, galleryImageId, orderedGalleryImages, type GalleryImage } from './mediaGallery';
import type { PreviewCloseAction, ShellPreviewHostPayload } from './MediaPreviewOverlays';
import {
  MediaPreviewContext,
  type MediaPreviewApi,
} from './mediaPreviewContext';

export { useMediaPreview } from './mediaPreviewContext';

const LazyMediaPreviewOverlays = lazyComponent(() =>
  import('./MediaPreviewOverlays').then((m) => m.MediaPreviewOverlays),
);

if (import.meta.env.MODE === 'test') {
  await LazyMediaPreviewOverlays.preload();
}

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

type CloseAction = PreviewCloseAction;

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

function affectedPluginKeysByClose(
  state: PreviewTabsState,
  action: CloseAction,
  cwd?: string,
): ReadonlySet<string> {
  const keys = new Set<string>();
  switch (action.kind) {
    case 'tab': {
      const targetKey = previewTabKey(action.key, cwd);
      const match = state.tabs.find((tab) => previewTabKey(tab, cwd) === targetKey);
      if (match?.kind === 'plugin') keys.add(previewTabKey(match, cwd));
      break;
    }
    case 'others': {
      const targetKey = previewTabKey(action.key, cwd);
      for (const tab of state.tabs) {
        const key = previewTabKey(tab, cwd);
        if (key !== targetKey && tab.kind === 'plugin') keys.add(key);
      }
      break;
    }
    case 'all': {
      for (const tab of state.tabs) {
        if (tab.kind === 'plugin') keys.add(previewTabKey(tab, cwd));
      }
      break;
    }
  }
  return keys;
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

  const tabsStateRef = useRef(tabsState);
  tabsStateRef.current = tabsState;
  const promoteResidentPluginRef = useRef<(tab: PluginTab) => void>(() => {});

  useNavSnapshotAdapter<PreviewReadingSnapshot>(previewKey, {
    ready: sessionId !== undefined,
    capture: () => ({ tabsState, panelOpen, positions }),
    restore: (snapshot) => {
      setNavigation(undefined);
      if (snapshot.panelOpen) {
        const restoredActive = snapshot.tabsState.tabs.find(
          (tab): tab is PluginTab =>
            tab.kind === 'plugin' && previewTabKey(tab, cwd) === snapshot.tabsState.active,
        );
        if (restoredActive !== undefined) promoteResidentPluginRef.current(restoredActive);
      }
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
  const prevPreviewKeyRef = useRef(previewKey);
  useEffect(() => {
    if (prevPreviewKeyRef.current === previewKey) return;
    prevPreviewKeyRef.current = previewKey;
    const nextSnapshot = initialSnapshot;
    const nextTabsState = nextSnapshot?.tabsState ?? EMPTY_PREVIEW_TABS;
    if (nextSnapshot?.panelOpen) {
      const restoredActive = nextTabsState.tabs.find(
        (tab): tab is PluginTab =>
          tab.kind === 'plugin' && previewTabKey(tab, cwd) === nextTabsState.active,
      );
      if (restoredActive !== undefined) promoteResidentPluginRef.current(restoredActive);
    }
    setNavigation(undefined);
    setTabsState((current) => {
      const kept = current.tabs.filter(
        (tab) =>
          tab.kind === 'resource' &&
          tab.resource.source.kind === 'host-file' &&
          dirtyPaths.has(tab.resource.source.path) &&
          !nextTabsState.tabs.some((candidate) => previewTabKey(candidate, cwd) === previewTabKey(tab, cwd)),
      );
      if (kept.length === 0) return nextTabsState;
      const active = nextTabsState.active ?? previewTabKey(kept[0]!, cwd);
      return { tabs: [...nextTabsState.tabs, ...kept], active };
    });
    setPanelOpen(Boolean(nextSnapshot?.panelOpen && nextTabsState.tabs.length > 0));
    setPreviewMaximized(false);
    setPositions(nextSnapshot?.positions ?? {});
  }, [previewKey, initialSnapshot, dirtyPaths, cwd]);
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
  const ownsShellPreviewHost =
    registerSessionOpener && shell?.registerPreviewHost !== undefined;
  const ownsShellPreview =
    registerSessionOpener && shell?.registerPreview !== undefined;
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

  const localResidentSeqRef = useRef(0);
  const [localResidentState, setLocalResidentState] = useState<{
    readonly client: unknown;
    readonly entries: readonly ResidentPluginEntry[];
  }>(() => ({ client: clientIdentity, entries: [] }));
  useEffect(() => {
    setLocalResidentState((current) =>
      current.client === clientIdentity ? current : { client: clientIdentity, entries: [] },
    );
  }, [clientIdentity]);
  const localResidentPluginTabs = useMemo<readonly PluginTab[]>(
    () => (localResidentState.client === clientIdentity ? localResidentState.entries.map((entry) => entry.tab) : []),
    [localResidentState, clientIdentity],
  );
  const shellPromoteResident = shell?.promoteResidentPluginTab;
  const shellRemoveResident = shell?.removeResidentPluginTabs;
  const promoteResidentPlugin = useCallback(
    (tab: PluginTab) => {
      if (ownsShellPreviewHost && shellPromoteResident !== undefined) {
        shellPromoteResident(clientIdentity, tab);
        return;
      }
      const seq = ++localResidentSeqRef.current;
      setLocalResidentState((current) => {
        const base = current.client === clientIdentity ? current.entries : [];
        const nextEntries = promoteResidentPluginEntry(base, tab, seq);
        if (current.client === clientIdentity && nextEntries === current.entries) return current;
        return { client: clientIdentity, entries: nextEntries };
      });
    },
    [ownsShellPreviewHost, shellPromoteResident, clientIdentity],
  );
  promoteResidentPluginRef.current = promoteResidentPlugin;
  const removeResidentPlugins = useCallback(
    (keys: ReadonlySet<string>) => {
      if (keys.size === 0) return;
      if (ownsShellPreviewHost && shellRemoveResident !== undefined) {
        shellRemoveResident(keys);
        return;
      }
      setLocalResidentState((current) => {
        const nextEntries = removeResidentPluginEntries(current.entries, keys);
        return nextEntries === current.entries ? current : { client: current.client, entries: nextEntries };
      });
    },
    [ownsShellPreviewHost, shellRemoveResident],
  );

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
    const tab: PluginTab = { kind: 'plugin', pluginId, panelId, title };
    promoteResidentPlugin(tab);
    setTabsState((state) => openPreviewTab(state, tab, cwd));
    revealPreview();
  }, [cwd, promoteResidentPlugin, revealPreview]);

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
      const currentTabs = tabsStateRef.current;
      const affected = affectedByClose(currentTabs, action, cwd);
      const dirty = affected.filter((path) => dirtyPaths.has(path));
      if (dirty.length > 0) {
        setConfirmClose({ dirty, action });
        return;
      }
      const closedPlugins = affectedPluginKeysByClose(currentTabs, action, cwd);
      if (closedPlugins.size > 0) removeResidentPlugins(closedPlugins);
      setTabsState((state) => {
        const next = applyCloseAction(state, action, cwd);
        if (next.tabs.length === 0) {
          setPanelOpen(false);
          setPreviewMaximized(false);
        }
        return next;
      });
    },
    [cwd, dirtyPaths, removeResidentPlugins],
  );

  const confirmCloseRun = useCallback(() => {
    if (confirmClose === null) return;
    const action = confirmClose.action;
    setConfirmClose(null);
    const closedPlugins = affectedPluginKeysByClose(tabsStateRef.current, action, cwd);
    if (closedPlugins.size > 0) removeResidentPlugins(closedPlugins);
    setTabsState((state) => {
      const next = applyCloseAction(state, action, cwd);
      if (next.tabs.length === 0) {
        setPanelOpen(false);
        setPreviewMaximized(false);
      }
      return next;
    });
  }, [confirmClose, cwd, removeResidentPlugins]);

  const handleActivate = useCallback((key: string) => {
    setNavigation(undefined);
    const target = tabsState.tabs.find((tab) => previewTabKey(tab, cwd) === key);
    if (target?.kind === 'plugin') promoteResidentPlugin(target);
    setTabsState((state) => ({ ...state, active: key }));
  }, [cwd, promoteResidentPlugin, tabsState.tabs]);

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

  const phoneMode = usePhoneMode();
  const panelHidden = !panelOpen;
  const panelOverlay =
    phoneMode || (!ownsShellPreviewHost && (shell?.slots.preview === null || shell?.slots.preview === undefined));
  const hasResidentPlugins = ownsShellPreviewHost
    ? (shell?.residentPluginCount ?? 0) > 0
    : localResidentPluginTabs.length > 0;
  const shouldMountWorkspace = tabsState.tabs.length > 0 || hasResidentPlugins;
  const handleOpenImage = useCallback(
    (src: string, name?: string, sourcePath?: string) => {
      setImage({ src, name, sourcePath, client: clientIdentity, sessionId, agentId: snapshotAgentId });
    },
    [clientIdentity, sessionId, snapshotAgentId],
  );
  const shellHostPayload = useMemo<ShellPreviewHostPayload | null>(() => {
    if (!ownsShellPreviewHost || !shouldMountWorkspace) return null;
    return {
      surface: {
        previewKey,
        tabsState,
        navigation,
        dirtyPaths,
        width,
        panelHidden,
        panelOverlay,
        phoneMode,
        effectiveMaximized,
        togglePreviewMaximized,
        exitPreviewMaximized,
        sessionViewState: workspaceSessionState ?? sessionViewState,
        agentForest,
        onOpenSubagent,
        controller,
        workspaceNavigation,
        onCancelTask,
        onStopAgentTask,
        onActivate: handleActivate,
        onRequestClose: requestClose,
        onMove: handleMove,
        collapsePanel,
        onWidthChange: handleWidthChange,
        onOpenImage: handleOpenImage,
        reportDirty,
        positions,
        reportPosition,
        cwd,
        sessionId,
      },
      api,
      activeDraftKey,
    };
  }, [
    ownsShellPreviewHost,
    shouldMountWorkspace,
    previewKey,
    tabsState,
    navigation,
    dirtyPaths,
    width,
    panelHidden,
    panelOverlay,
    phoneMode,
    effectiveMaximized,
    togglePreviewMaximized,
    exitPreviewMaximized,
    workspaceSessionState,
    sessionViewState,
    agentForest,
    onOpenSubagent,
    controller,
    workspaceNavigation,
    onCancelTask,
    onStopAgentTask,
    handleActivate,
    requestClose,
    handleMove,
    collapsePanel,
    handleWidthChange,
    handleOpenImage,
    reportDirty,
    positions,
    reportPosition,
    cwd,
    sessionId,
    api,
    activeDraftKey,
  ]);
  const registerShellPreviewHost = shell?.registerPreviewHost;
  const unregisterShellPreviewHost = shell?.unregisterPreviewHost;
  useLayoutEffect(() => {
    if (!ownsShellPreviewHost || registerShellPreviewHost === undefined) return;
    registerShellPreviewHost(shellPreviewOwner, shellHostPayload);
  }, [ownsShellPreviewHost, registerShellPreviewHost, shellPreviewOwner, shellHostPayload]);
  useLayoutEffect(() => {
    if (!ownsShellPreviewHost || unregisterShellPreviewHost === undefined) return;
    return () => {
      unregisterShellPreviewHost(shellPreviewOwner);
    };
  }, [ownsShellPreviewHost, unregisterShellPreviewHost, shellPreviewOwner]);

  const activeGallery =
    gallery !== null &&
    gallery.client === clientIdentity &&
    gallery.sessionId === sessionId &&
    gallery.scopeAgentId === snapshotAgentId &&
    gallery.images[gallery.selected] !== undefined
      ? gallery
      : null;
  const activeImage =
    image !== null &&
    image.client === clientIdentity &&
    image.sessionId === sessionId &&
    image.agentId === snapshotAgentId
      ? image
      : null;
  const hasActiveOverlays =
    (!ownsShellPreviewHost && shouldMountWorkspace) ||
    confirmClose !== null ||
    activeGallery !== null ||
    activeImage !== null;

  return (
    <ActiveDraftKeyProvider sessionId={sessionId} draftKey={activeDraftKey}>
      <MediaPreviewContext.Provider value={api}>
        {children}
        {hasActiveOverlays ? (
          <LazyMediaPreviewOverlays
            previewKey={previewKey}
            tabsState={tabsState}
            residentPluginTabs={localResidentPluginTabs}
            renderWorkspacePanel={!ownsShellPreviewHost}
            navigation={navigation}
            dirtyPaths={dirtyPaths}
            width={width}
            panelHidden={panelHidden}
            panelOverlay={panelOverlay}
            phoneMode={phoneMode}
            effectiveMaximized={effectiveMaximized}
            togglePreviewMaximized={togglePreviewMaximized}
            exitPreviewMaximized={exitPreviewMaximized}
            sessionViewState={workspaceSessionState ?? sessionViewState}
            agentForest={agentForest}
            onOpenSubagent={onOpenSubagent}
            controller={controller}
            workspaceNavigation={workspaceNavigation}
            onCancelTask={onCancelTask}
            onStopAgentTask={onStopAgentTask}
            onActivate={handleActivate}
            onRequestClose={requestClose}
            onMove={handleMove}
            collapsePanel={collapsePanel}
            onWidthChange={handleWidthChange}
            onOpenImage={handleOpenImage}
            reportDirty={reportDirty}
            positions={positions}
            reportPosition={reportPosition}
            cwd={cwd}
            sessionId={sessionId}
            renderDesktopPortal={(panel) =>
              shell?.slots.preview !== null && shell?.slots.preview !== undefined
                ? createPortal(panel, shell.slots.preview)
                : panel
            }
            confirmClose={confirmClose}
            confirmCloseRun={confirmCloseRun}
            onCancelConfirmClose={() => { setConfirmClose(null); }}
            activeGallery={activeGallery}
            onSelectGallery={(selected) => { setGallery((current) => current === null ? null : { ...current, selected }); }}
            onCloseGallery={() => { setGallery(null); }}
            activeImage={activeImage}
            onCloseImage={() => { setImage(null); }}
            localKikiComputer={localKikiComputer}
            lightboxAnnotations={lightboxAnnotations}
            setLightboxAnnotations={setLightboxAnnotations}
            attachAnnotatedImageFor={attachAnnotatedImageFor}
          />
        ) : null}
      </MediaPreviewContext.Provider>
    </ActiveDraftKeyProvider>
  );
}

export { PreviewToggleButton, WorkspacePanelsControl } from './PreviewToggleButton';

export { FilePathLink, MediaPart, MediaPartList, type MediaThumbSize } from './mediaParts';
