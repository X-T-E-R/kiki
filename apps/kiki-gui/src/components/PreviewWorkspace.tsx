/**
 * PreviewWorkspace — the resident multi-tab preview panel. Tab kinds are
 * `resource` (live host files and sent session copies), `web` (external URLs),
 * `panel` (agent workspaces), and `skill` (built-in skills). Tabs close via ×
 * or the context menu (close / close others / close all), reorder by drag, and
 * mark unsaved buffers with a dot. Resource tabs pick their renderer from
 * `resource.type` (`classifyResource`) so live files and session copies share
 * the exact same rendering capabilities (Markdown, sandboxed HTML, PDF/Office,
 * image, audio/video, text/code, and unsupported fallbacks).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { basenameOf, resolveHostPath, type FileReference } from '@kiki/session-core/composer/media';
import type { AgentForest, SessionController, SessionViewState } from '@kiki/session-core/session';
import { useHost } from '#/host';
import { useI18n } from '#/i18n';
import { usePhoneMode } from '#/lib/layoutHooks';
import { cssZoomFactor, unzoomedViewport } from '#/lib/uiZoom';
import { useOptionalConnection } from '#/state/connection';
import {
  normalizeHostFilePath,
  type PreviewReadState,
  type PreviewResource,
} from '#/state/previewResource';
import {
  normalizeTabInput,
  previewTabKey,
  type PreviewTab as PreviewTabModel,
} from '#/state/previewWorkspace';
import { AgentWorkspace, type AgentWorkspaceNavigation } from './agent-workspace/AgentWorkspace';
import { ConfirmDialog } from './ConfirmDialog';
import type { ConversationShellSlots } from './ConversationShell';
import { useMediaPreview } from './mediaPreviewContext';
import { PreviewAttachmentView } from './preview/AttachmentTabView';
import { BinaryTabView } from './preview/BinaryTabView';
import { DocumentTabView } from './preview/DocumentTabView';
import { ImageTabView } from './preview/ImageTabView';
import { AudioTabView, VideoTabView } from './preview/MediaTabView';
import { TabContextMenu } from './preview/ResourceHeader';
import {
  clampPreviewWidth,
  computeFileWriteCounts,
  downloadHostFile,
  fileWriteEpochFor,
  isLocalKikiComputer,
  MAX_PREVIEW_WIDTH,
  relativeToCwd,
  useFileOpeners,
  usePreviewReadingScroll,
} from './preview/shared';
import { PreviewSkillView } from './preview/SkillTabView';
import { PreviewTabStrip } from './preview/TabStrip';
import { isHtmlPreviewPath, TextTabView } from './preview/TextTabView';
import { PreviewWebView } from './preview/WebTabView';

export { clampPreviewWidth, isHtmlPreviewPath, relativeToCwd };

function comparableHostPath(rawPath: string, cwd: string | undefined): string {
  const normalized = normalizeHostFilePath(rawPath, cwd);
  return /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

export interface PreviewWorkspaceProps {
  readonly tabs: readonly (string | PreviewTabModel)[];
  readonly active: string | null;
  readonly navigation?: FileReference;
  readonly dirtyPaths: ReadonlySet<string>;
  readonly width: number;
  readonly sessionViewState?: SessionViewState;
  readonly agentForest?: AgentForest;
  readonly onOpenSubagent?: (agentId: string) => void;
  /**
   * Agent-tab workspace wiring (shared runtime, navigation intents, task
   * commands). All three must be present — together with sessionViewState,
   * agentForest and sessionId — for a panel tab to render the full
   * AgentWorkspace; otherwise the tab keeps its plain caption fallback.
   */
  readonly controller?: SessionController | null;
  readonly workspaceNavigation?: AgentWorkspaceNavigation;
  readonly onCancelTask?: (taskId: string, ownerAgentId?: string) => void;
  readonly onStopAgentTask?: (ownerAgentId: string, taskId: string) => Promise<void>;
  readonly onActivate: (key: string) => void;
  readonly onClose: (key: string) => void;
  readonly onCloseOthers: (key: string) => void;
  readonly onCloseAll: () => void;
  readonly onMove: (key: string, targetIndex: number) => void;
  readonly onCollapse: () => void;
  readonly onOpenCockpit?: () => void;
  readonly onWidthChange: (width: number, final: boolean) => void;
  readonly onOpenImage: (src: string, name?: string, sourcePath?: string) => void;
  readonly reportDirty: (path: string, dirty: boolean) => void;
  /**
   * Per-tab reading positions for this visit (tab key → scroller offset).
   * Restored when the panel comes back — a lifted preview reopens at the place
   * the reader left — and reported back while the reader scrolls.
   */
  readonly scrollPositions?: Readonly<Record<string, { readonly top: number; readonly left?: number }>>;
  readonly onScrollPosition?: (key: string, position: { top: number; left?: number }) => void;
  /**
   * Collapsed (not closed): a resource tab that has already been shown stays
   * mounted and hides itself. Unmounting here would dispose the host-file
   * editor controller, dropping the draft and canceling its pending autosave.
   * Defaults to false.
   */
  readonly hidden?: boolean;
  readonly overlay?: boolean;
  /** Session workspace cwd — anchors "Copy relative path" and the @-mention. */
  readonly cwd?: string;
  /** Owning session — the @-mention target composer. Absent without a session. */
  readonly sessionId?: string;
}

export function PreviewWorkspace({
  tabs,
  active,
  navigation,
  dirtyPaths,
  width,
  sessionViewState,
  agentForest,
  onOpenSubagent: _onOpenSubagent,
  controller,
  workspaceNavigation,
  onCancelTask,
  onStopAgentTask,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseAll,
  onMove,
  onCollapse,
  onOpenCockpit,
  onWidthChange,
  onOpenImage,
  reportDirty,
  scrollPositions,
  onScrollPosition,
  hidden = false,
  overlay = false,
  cwd,
  sessionId,
}: PreviewWorkspaceProps) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<{ tab: PreviewTabModel; x: number; y: number } | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const phoneMode = usePhoneMode();
  const [narrow, setNarrow] = useState(() =>
    typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1023px)').matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 1023px)');
    const update = () => { setNarrow(media.matches); };
    update();
    media.addEventListener('change', update);
    return () => { media.removeEventListener('change', update); };
  }, []);

  const normalizedTabs = useMemo(
    () => tabs.map((tab) => normalizeTabInput(tab, cwd)),
    [tabs, cwd],
  );
  const resolvedActive = useMemo(() => {
    if (active === null || active === '') return null;
    if (normalizedTabs.some((tab) => previewTabKey(tab, cwd) === active)) return active;
    const canonical = previewTabKey(active, cwd);
    return normalizedTabs.some((tab) => previewTabKey(tab, cwd) === canonical) ? canonical : active;
  }, [active, cwd, normalizedTabs]);

  const openTabKeys = useMemo(
    () => new Set(normalizedTabs.map((tab) => previewTabKey(tab, cwd))),
    [normalizedTabs, cwd],
  );
  const [seenTabs, setSeenTabs] = useState<ReadonlySet<string>>(() => new Set());
  const nextSeen = new Set([...seenTabs].filter((key) => openTabKeys.has(key)));
  if (!hidden && resolvedActive !== null && resolvedActive !== '' && openTabKeys.has(resolvedActive)) {
    nextSeen.add(resolvedActive);
  }
  if (nextSeen.size !== seenTabs.size || [...nextSeen].some((key) => !seenTabs.has(key))) setSeenTabs(nextSeen);

  const [tabReadStates, setTabReadStates] = useState<Readonly<Record<string, PreviewReadState>>>({});
  const [reloadNonces, setReloadNonces] = useState<Readonly<Record<string, number>>>({});
  const bumpTabReload = useCallback((key: string) => {
    setReloadNonces((previous) => ({ ...previous, [key]: (previous[key] ?? 0) + 1 }));
  }, []);
  const fileWriteCounts = useMemo(
    () => computeFileWriteCounts(sessionViewState?.blocks, cwd),
    [sessionViewState?.blocks, cwd],
  );
  const reportTabReadState = useCallback((key: string, state: PreviewReadState) => {
    setTabReadStates((previous) => {
      const current = previous[key];
      if (
        current !== undefined &&
        current.status === state.status &&
        current.readableFromDevice === state.readableFromDevice &&
        current.originalReadable === state.originalReadable &&
        current.losslessUtf8 === state.losslessUtf8 &&
        current.truncated === state.truncated &&
        current.failureReason === state.failureReason
      ) {
        return previous;
      }
      return { ...previous, [key]: state };
    });
  }, []);
  const preview = useMediaPreview();
  const openLiveFile = useCallback(
    (targetPath: string) => {
      if (preview !== null) {
        preview.openFile(targetPath);
        return;
      }
      const targetComparable = comparableHostPath(targetPath, cwd);
      const existing = normalizedTabs.find(
        (candidate) =>
          candidate.kind === 'resource' &&
          candidate.resource.source.kind === 'host-file' &&
          comparableHostPath(candidate.resource.source.path, cwd) === targetComparable,
      );
      if (existing !== undefined) onActivate(previewTabKey(existing, cwd));
    },
    [cwd, normalizedTabs, onActivate, preview],
  );

  // The shared rail owns the first Escape even if this listener runs before
  // SessionView's rail closer. The next unclaimed Escape exits fullscreen.
  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (workspaceNavigation?.sharedRail?.open) {
        event.preventDefault();
        workspaceNavigation.sharedRail.toggle();
        return;
      }
      event.preventDefault();
      setIsFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [isFullscreen, workspaceNavigation?.sharedRail]);

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isFullscreen) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    handle.dataset['dragging'] = 'true';
    document.body.dataset['paneResizing'] = 'true';
    const onMovePointer = (move: Event) => {
      const x = (move as PointerEvent).clientX / cssZoomFactor();
      const viewportWidth = unzoomedViewport().width;
      onWidthChange(clampPreviewWidth(viewportWidth - x, viewportWidth), false);
    };
    const onUp = (up: Event) => {
      const x = (up as PointerEvent).clientX / cssZoomFactor();
      const viewportWidth = unzoomedViewport().width;
      onWidthChange(clampPreviewWidth(viewportWidth - x, viewportWidth), true);
      handle.dataset['dragging'] = 'false';
      delete document.body.dataset['paneResizing'];
      handle.removeEventListener('pointermove', onMovePointer);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
    handle.addEventListener('pointermove', onMovePointer);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  if (normalizedTabs.length === 0) {
    return null;
  }

  const containerClasses = isFullscreen && overlay
    ? 'fixed inset-0 z-40 flex h-full w-full flex-col bg-panel'
    : `preview-workspace ${overlay ? 'preview-workspace--overlay' : ''} ${isFullscreen ? 'preview-workspace--fullscreen' : ''}`;

  const hiddenStyle = hidden ? { display: 'none' as const } : undefined;
  const containerStyle = isFullscreen ? hiddenStyle : {
    width: narrow ? '100%' : width,
    maxWidth: narrow ? 'none' : undefined,
    ...hiddenStyle,
  };

  return (
    <aside
      data-preview-workspace
      data-preview-fullscreen={isFullscreen ? '' : undefined}
      hidden={hidden}
      aria-label={t('preview.title')}
      className={containerClasses}
      style={containerStyle}
    >
      {!isFullscreen && !phoneMode ? (
        <div
          className="preview-workspace__resizer"
          aria-hidden
          title={t('preview.resetWidth')}
          onPointerDown={startResize}
          onDoubleClick={() => {
            onWidthChange(
              clampPreviewWidth(Math.min(MAX_PREVIEW_WIDTH, Math.floor(window.innerWidth * 0.6)), window.innerWidth),
              true,
            );
          }}
        />
      ) : null}
      <PreviewTabStrip
        tabs={normalizedTabs}
        active={resolvedActive}
        dirtyPaths={dirtyPaths}
        tabReadStates={tabReadStates}
        agentForest={agentForest}
        cwd={cwd}
        sessionId={sessionId}
        phoneMode={phoneMode}
        isFullscreen={isFullscreen}
        onToggleFullscreen={() => { setIsFullscreen(!isFullscreen); }}
        onCollapse={onCollapse}
        onOpenCockpit={onOpenCockpit}
        onActivate={onActivate}
        onClose={onClose}
        onMove={onMove}
        onOpenContextMenu={(tab, x, y) => { setMenu({ tab, x, y }); }}
      />
      {normalizedTabs.map((tab) => {
        const key = previewTabKey(tab, cwd);
        const isTabActive = key === resolvedActive;
        const legacyScrollKey =
          tab.kind === 'resource' && tab.resource.source.kind === 'host-file'
            ? tab.resource.source.path
            : undefined;
        const tabPosition =
          scrollPositions?.[key] ??
          (legacyScrollKey === undefined ? undefined : scrollPositions?.[legacyScrollKey]);
        if (tab.kind === 'panel') {
          const workspaceWired =
            controller !== null && controller !== undefined &&
            sessionViewState !== undefined &&
            agentForest !== undefined &&
            workspaceNavigation !== undefined &&
            sessionId !== undefined;
          return (
            <div
              key={key}
              role="tabpanel"
              hidden={!isTabActive}
              className={`relative min-h-0 flex-1 overflow-hidden ${isTabActive ? 'flex flex-col' : 'hidden'}`}
              data-preview-tabpanel={key}
            >
              {workspaceWired ? (
                <AgentTabWorkspace
                  viewId={key}
                  agentId={tab.agentId}
                  sessionId={sessionId}
                  controller={controller}
                  sessionState={sessionViewState}
                  forest={agentForest}
                  navigation={workspaceNavigation}
                  visible={isTabActive && !hidden}
                  onCancelTask={onCancelTask}
                  onStopAgentTask={onStopAgentTask}
                />
              ) : (
                <div className="overflow-auto p-4 text-center text-[12px] text-ink-faint">
                  {t('preview.agentFallback', { name: tab.title ?? tab.agentId })}
                </div>
              )}
            </div>
          );
        }
        if (tab.kind === 'skill') {
          return (
            <PreviewSkillView
              key={key}
              tabKey={key}
              name={tab.name}
              visible={isTabActive && !hidden}
              position={tabPosition}
              onScrollPosition={onScrollPosition === undefined ? undefined : (position) => { onScrollPosition(key, position); }}
            />
          );
        }
        if (tab.kind === 'web') {
          if (!seenTabs.has(key)) return null;
          return (
            <PreviewWebView
              key={key}
              tabKey={key}
              url={tab.url}
              title={tab.title}
              visible={isTabActive && !hidden}
              externalReloadNonce={reloadNonces[key]}
            />
          );
        }
        if (!seenTabs.has(key)) return null;
        return (
          <PreviewResourceTabView
            key={key}
            tabKey={key}
            resource={tab.resource}
            size={tab.size}
            workspaceRoot={cwd}
            visible={isTabActive && !hidden}
            navigation={
              tab.resource.source.kind === 'host-file' &&
              navigation !== undefined &&
              isTabActive &&
              comparableHostPath(navigation.path, cwd) === comparableHostPath(tab.resource.source.path, cwd)
                ? navigation
                : undefined
            }
            fileWriteEpoch={
              tab.resource.source.kind === 'host-file'
                ? fileWriteEpochFor(fileWriteCounts, tab.resource.source.path, cwd)
                : 0
            }
            externalReloadNonce={reloadNonces[key]}
            onCloseTab={() => { onClose(key); }}
            onOpenImage={onOpenImage}
            onOpenCurrentFile={openLiveFile}
            reportDirty={reportDirty}
            onReadStateChange={(state) => { reportTabReadState(key, state); }}
            position={tabPosition}
            onScrollPosition={onScrollPosition === undefined ? undefined : (position) => { onScrollPosition(key, position); }}
            sessionId={sessionId}
          />
        );
      })}
      {menu !== null ? (
        <TabContextMenu
          menu={menu}
          cwd={cwd}
          sessionId={sessionId}
          readState={tabReadStates[previewTabKey(menu.tab, cwd)]}
          workspaceNavigation={workspaceNavigation}
          onOpenCurrentFile={openLiveFile}
          onReloadTab={bumpTabReload}
          onCloseMenu={() => { setMenu(null); }}
          onCloseTab={() => { onClose(previewTabKey(menu.tab, cwd)); }}
          onCloseOthers={() => { onCloseOthers(previewTabKey(menu.tab, cwd)); }}
          onCloseAll={onCloseAll}
        />
      ) : null}
    </aside>
  );
}

/**
 * AgentTabWorkspace — one panel tab's embedded AgentWorkspace.
 */
function AgentTabWorkspace({
  viewId,
  agentId,
  sessionId,
  controller,
  sessionState,
  forest,
  navigation,
  visible,
  onCancelTask,
  onStopAgentTask,
}: {
  readonly viewId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly controller: SessionController;
  readonly sessionState: SessionViewState;
  readonly forest: AgentForest;
  readonly navigation: AgentWorkspaceNavigation;
  readonly visible: boolean;
  readonly onCancelTask: ((taskId: string, ownerAgentId?: string) => void) | undefined;
  readonly onStopAgentTask: ((ownerAgentId: string, taskId: string) => Promise<void>) | undefined;
}) {
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const [dockSlot, setDockSlot] = useState<HTMLElement | null>(null);
  const slots = useMemo<ConversationShellSlots>(
    () => ({
      header: headerSlot,
      dock: dockSlot,
      rail: null,
      heroFooter: null,
      footer: null,
      preview: null,
    }),
    [headerSlot, dockSlot],
  );

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => {
    controller.retainAgentView(viewId, agentId, visibleRef.current ? 'delta' : 'off');
    return () => { controller.releaseAgentView(viewId); };
  }, [controller, viewId, agentId]);
  useEffect(() => {
    controller.updateAgentView(viewId, visible ? 'delta' : 'off');
  }, [controller, viewId, visible]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-paper" data-agent-tab-workspace={agentId}>
      <div ref={setHeaderSlot} className="shrink-0" />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <AgentWorkspace
          target={{ sessionId, agentId }}
          controller={controller}
          sessionState={sessionState}
          forest={forest}
          navigation={navigation}
          railOpen={navigation.sharedRail?.open ?? false}
          railIsOverlay={false}
          onToggleRail={navigation.sharedRail?.toggle ?? (() => {})}
          onCloseRail={() => {}}
          onCancelTask={onCancelTask ?? (() => {})}
          onStopAgentTask={onStopAgentTask ?? (() => Promise.resolve())}
          slots={slots}
          inheritMediaPreview
          transcriptVisible={visible}
          showPreviewToggle={false}
          showRailToggle={navigation.sharedRail !== undefined && navigation.sharedRail.available !== false}
          showBreadcrumb={false}
        />
      </div>
      <div ref={setDockSlot} className="shrink-0" />
    </div>
  );
}

function PreviewResourceTabView({
  tabKey,
  resource,
  size,
  workspaceRoot,
  visible,
  navigation,
  fileWriteEpoch = 0,
  externalReloadNonce,
  onCloseTab,
  onOpenImage,
  onOpenCurrentFile,
  reportDirty,
  onReadStateChange,
  position,
  onScrollPosition,
  sessionId,
}: {
  readonly tabKey: string;
  readonly resource: PreviewResource;
  readonly size?: number;
  readonly workspaceRoot?: string;
  readonly visible: boolean;
  readonly navigation?: FileReference;
  readonly fileWriteEpoch?: number;
  readonly externalReloadNonce?: number;
  readonly onCloseTab?: () => void;
  readonly onOpenImage: (src: string, name?: string, sourcePath?: string) => void;
  readonly onOpenCurrentFile?: (path: string) => void;
  readonly reportDirty: (path: string, dirty: boolean) => void;
  readonly onReadStateChange?: (state: PreviewReadState) => void;
  readonly position?: { readonly top: number; readonly left?: number };
  readonly onScrollPosition?: (position: { top: number; left?: number }) => void;
  readonly sessionId?: string;
}) {
  if (resource.source.kind !== 'host-file') {
    return (
      <PreviewAttachmentView
        tabKey={tabKey}
        resource={resource}
        size={size}
        sessionId={sessionId}
        workspaceRoot={workspaceRoot}
        visible={visible}
        externalReloadNonce={externalReloadNonce}
        onOpenImage={onOpenImage}
        onOpenCurrentFile={onOpenCurrentFile}
        onReadStateChange={onReadStateChange}
        position={position}
        onScrollPosition={onScrollPosition}
      />
    );
  }
  return (
    <HostFileResourceTabView
      path={resource.source.path}
      resourceType={resource.type}
      workspaceRoot={workspaceRoot}
      visible={visible}
      navigation={navigation}
      fileWriteEpoch={fileWriteEpoch}
      externalReloadNonce={externalReloadNonce}
      onCloseTab={onCloseTab}
      onOpenImage={onOpenImage}
      reportDirty={reportDirty}
      onReadStateChange={onReadStateChange}
      position={position}
      onScrollPosition={onScrollPosition}
      sessionId={sessionId}
    />
  );
}

function HostFileResourceTabView({
  path,
  resourceType,
  workspaceRoot,
  visible,
  navigation,
  fileWriteEpoch = 0,
  externalReloadNonce,
  onCloseTab,
  onOpenImage,
  reportDirty,
  onReadStateChange,
  position,
  onScrollPosition,
  sessionId,
}: {
  readonly path: string;
  readonly resourceType: PreviewResource['type'];
  readonly workspaceRoot?: string;
  readonly visible: boolean;
  readonly navigation?: FileReference;
  readonly fileWriteEpoch?: number;
  readonly externalReloadNonce?: number;
  readonly onCloseTab?: () => void;
  readonly onOpenImage: (src: string, name?: string, sourcePath?: string) => void;
  readonly reportDirty: (path: string, dirty: boolean) => void;
  readonly onReadStateChange?: (state: PreviewReadState) => void;
  readonly position?: { readonly top: number; readonly left?: number };
  readonly onScrollPosition?: (position: { top: number; left?: number }) => void;
  readonly sessionId?: string;
}) {
  const filePath = resolveHostPath(path, workspaceRoot);
  const host = useHost();
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const localKikiComputer = isLocalKikiComputer(connection);
  const openers = useFileOpeners();
  const { panelRef, onReadingReady } = usePreviewReadingScroll(visible, position, onScrollPosition, navigation);
  const hasKnownExtension = basenameOf(filePath).includes('.');

  return (
    <div
      ref={panelRef}
      role="tabpanel"
      hidden={!visible}
      className={`min-h-0 flex-1 flex-col ${visible ? 'flex' : 'hidden'}`}
      data-preview-tabpanel={path}
    >
      {resourceType === 'image' ? (
        <ImageTabView
          path={filePath}
          sessionId={sessionId}
          workspaceRoot={workspaceRoot}
          visible={visible}
          fileWriteEpoch={fileWriteEpoch}
          externalReloadNonce={externalReloadNonce}
          onOpenImage={onOpenImage}
          onCloseTab={onCloseTab}
          onReadStateChange={onReadStateChange}
        />
      ) : resourceType === 'video' ? (
        <VideoTabView
          path={filePath}
          sessionId={sessionId}
          workspaceRoot={workspaceRoot}
          externalReloadNonce={externalReloadNonce}
          onCloseTab={onCloseTab}
          onReadStateChange={onReadStateChange}
        />
      ) : resourceType === 'audio' ? (
        <AudioTabView
          path={filePath}
          scopeId={connection?.scopeId}
          sessionId={sessionId}
          workspaceRoot={workspaceRoot}
          externalReloadNonce={externalReloadNonce}
          onCloseTab={onCloseTab}
          onReadStateChange={onReadStateChange}
        />
      ) : resourceType === 'pdf' || resourceType === 'office' ? (
        <DocumentTabView
          source={{ kind: 'workspace', path: filePath }}
          sessionId={sessionId}
          workspaceRoot={workspaceRoot}
          client={connection?.client}
          active={visible}
          externalReloadNonce={externalReloadNonce}
          onReadStateChange={
            onReadStateChange === undefined
              ? undefined
              : (status) => {
                  onReadStateChange({
                    status,
                    readableFromDevice: status !== 'failed',
                    originalReadable: status !== 'failed',
                  });
                }
          }
          onOpenLocally={openers?.open === undefined ? undefined : () => { openers.open!(filePath); }}
          onDownload={() => {
            const target = connection?.client;
            if (target !== undefined) {
              void downloadHostFile(host, target, filePath, basenameOf(filePath), t, {
                sessionId,
                workspaceRoot,
                localKikiComputer,
              });
            }
          }}
        />
      ) : resourceType === 'unsupported' && hasKnownExtension ? (
        <BinaryTabView
          path={filePath}
          sessionId={sessionId}
          workspaceRoot={workspaceRoot}
        />
      ) : (
        <TextTabView
          path={filePath}
          workspaceRoot={workspaceRoot}
          sessionId={sessionId}
          visible={visible}
          markdown={resourceType === 'markdown'}
          navigation={navigation}
          fileWriteEpoch={fileWriteEpoch}
          externalReloadNonce={externalReloadNonce}
          onCloseTab={onCloseTab}
          reportDirty={reportDirty}
          onReadStateChange={onReadStateChange}
          onReadingReady={onReadingReady}
        />
      )}
    </div>
  );
}

/**
 * Close-with-unsaved-changes confirmation, rendered by the provider next to
 * the workspace. `names` labels the single-file body; several files fall back
 * to the count body.
 */
export function PreviewCloseConfirm({
  paths,
  onConfirm,
  onCancel,
}: {
  readonly paths: readonly string[];
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <ConfirmDialog
      open
      overlayId="preview-close-dirty"
      title={t('preview.discardTitle')}
      body={
        paths.length === 1
          ? t('preview.discardBody', { name: basenameOf(paths[0] ?? '') })
          : t('preview.discardBodyMany', { count: paths.length })
      }
      confirmLabel={t('preview.discard')}
      tone="danger"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
