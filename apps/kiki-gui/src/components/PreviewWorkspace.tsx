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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { basenameOf, resolveHostPath, type FileReference } from '@kiki/session-core/composer/media';
import type { AgentForest, SessionController, SessionViewState } from '@kiki/session-core/session';
import { useHost } from '#/host';
import { useI18n } from '#/i18n';
import { usePaneResize, usePhoneMode } from '#/lib/layoutHooks';
import { anyOverlayOpen } from '#/lib/uiBusy';
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
  type PluginTab,
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
  DEFAULT_PREVIEW_WIDTH,
  downloadHostFile,
  fileWriteEpochFor,
  isLocalKikiComputer,
  MAX_PREVIEW_WIDTH,
  measurePreviewMaxAvailableWidth,
  relativeToCwd,
  useFileOpeners,
  usePreviewReadingScroll,
} from './preview/shared';
import { PreviewPluginView } from './preview/PluginTabView';
import {
  PreviewHeaderSlotProvider,
  previewWidthTier,
  type PreviewHeaderSlotContextValue,
} from './preview/PreviewHeaderSlot';
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

const EMPTY_RESIDENT_PLUGIN_TABS: readonly PluginTab[] = [];

export interface PreviewWorkspaceProps {
  readonly tabs: readonly (string | PreviewTabModel)[];
  readonly residentPluginTabs?: readonly PluginTab[];
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
  readonly isFullscreen?: boolean;
  readonly onToggleFullscreen?: () => void;
  readonly onExitFullscreen?: () => void;
  /** Session workspace cwd — anchors "Copy relative path" and the @-mention. */
  readonly cwd?: string;
  /** Owning session — the @-mention target composer. Absent without a session. */
  readonly sessionId?: string;
}

export function PreviewWorkspace({
  tabs,
  residentPluginTabs = EMPTY_RESIDENT_PLUGIN_TABS,
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
  onWidthChange,
  onOpenImage,
  reportDirty,
  scrollPositions,
  onScrollPosition,
  hidden = false,
  overlay = false,
  isFullscreen: controlledFullscreen,
  onToggleFullscreen,
  onExitFullscreen,
  cwd,
  sessionId,
}: PreviewWorkspaceProps) {
  const { t } = useI18n();
  const workspaceRef = useRef<HTMLElement | null>(null);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const actionsSlotRef = useCallback((node: HTMLElement | null) => {
    setActionsSlot(node);
  }, []);
  const [measuredPaneWidth, setMeasuredPaneWidth] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ tab: PreviewTabModel; x: number; y: number } | null>(null);
  const [uncontrolledFullscreen, setUncontrolledFullscreen] = useState(false);
  const isFullscreen = controlledFullscreen ?? uncontrolledFullscreen;
  const toggleFullscreen = useCallback(() => {
    if (onToggleFullscreen !== undefined) {
      onToggleFullscreen();
      return;
    }
    setUncontrolledFullscreen((current) => !current);
  }, [onToggleFullscreen]);
  const exitFullscreen = useCallback(() => {
    if (onExitFullscreen !== undefined) {
      onExitFullscreen();
      return;
    }
    if (onToggleFullscreen !== undefined) {
      if (controlledFullscreen) onToggleFullscreen();
      return;
    }
    setUncontrolledFullscreen(false);
  }, [controlledFullscreen, onExitFullscreen, onToggleFullscreen]);
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
  const effectiveHidden = hidden || normalizedTabs.length === 0;
  const effectiveFullscreen = isFullscreen && !effectiveHidden;
  const resolvedActive = useMemo(() => {
    if (active === null || active === '') return null;
    if (normalizedTabs.some((tab) => previewTabKey(tab, cwd) === active)) return active;
    const canonical = previewTabKey(active, cwd);
    return normalizedTabs.some((tab) => previewTabKey(tab, cwd) === canonical) ? canonical : active;
  }, [active, cwd, normalizedTabs]);

  useEffect(() => {
    const el = workspaceRef.current;
    if (el === null || effectiveHidden) return undefined;
    const measure = () => {
      const zoom = cssZoomFactor();
      const raw = el.getBoundingClientRect().width || el.clientWidth;
      if (raw > 0) {
        const cssWidth = Math.round(raw / zoom);
        setMeasuredPaneWidth((previous) => (previous === cssWidth ? previous : cssWidth));
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => { observer.disconnect(); };
  }, [effectiveHidden, effectiveFullscreen, width, normalizedTabs.length]);

  const effectivePaneWidth =
    measuredPaneWidth !== null && measuredPaneWidth > 0
      ? measuredPaneWidth
      : effectiveFullscreen
        ? unzoomedViewport().width
        : width;
  const widthTier = previewWidthTier(effectivePaneWidth, phoneMode);
  const activeTabModel = useMemo(
    () => normalizedTabs.find((tab) => previewTabKey(tab, cwd) === resolvedActive) ?? normalizedTabs[0],
    [normalizedTabs, cwd, resolvedActive],
  );
  const isOrdinaryActiveTab =
    activeTabModel !== undefined &&
    activeTabModel.kind !== 'panel' &&
    !(
      activeTabModel.kind === 'resource' &&
      activeTabModel.resource.source.kind === 'host-file' &&
      (activeTabModel.resource.type === 'video' || activeTabModel.resource.type === 'audio')
    );
  const unifiedHead = isOrdinaryActiveTab && (widthTier === 'compact' || normalizedTabs.length === 1);
  const headerSlotValue = useMemo<PreviewHeaderSlotContextValue>(
    () => ({
      unifiedHead,
      paneWidth: effectivePaneWidth,
      widthTier,
      actionsSlot: unifiedHead ? actionsSlot : null,
    }),
    [unifiedHead, effectivePaneWidth, widthTier, actionsSlot],
  );

  const openTabKeys = useMemo(
    () => new Set(normalizedTabs.map((tab) => previewTabKey(tab, cwd))),
    [normalizedTabs, cwd],
  );
  const mountedPluginTabs = useMemo(() => {
    const openPlugins = new Map<string, PluginTab>();
    for (const tab of normalizedTabs) {
      if (tab.kind === 'plugin') openPlugins.set(previewTabKey(tab, cwd), tab);
    }
    const list: Array<{ readonly tab: PluginTab; readonly key: string; readonly isResident: boolean }> = [];
    const added = new Set<string>();
    for (const resident of residentPluginTabs) {
      const key = previewTabKey(resident, cwd);
      if (added.has(key)) continue;
      added.add(key);
      list.push({ tab: openPlugins.get(key) ?? resident, key, isResident: true });
    }
    for (const [key, tab] of openPlugins) {
      if (added.has(key)) continue;
      added.add(key);
      list.push({ tab, key, isResident: false });
    }
    return list;
  }, [normalizedTabs, residentPluginTabs, cwd]);
  const [seenTabs, setSeenTabs] = useState<ReadonlySet<string>>(() => new Set());
  const nextSeen = new Set([...seenTabs].filter((key) => openTabKeys.has(key)));
  if (!effectiveHidden && resolvedActive !== null && resolvedActive !== '' && openTabKeys.has(resolvedActive)) {
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
    if (!effectiveFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || anyOverlayOpen()) return;
      const sharedRail = workspaceNavigation?.sharedRail;
      if (sharedRail?.open) {
        event.preventDefault();
        if (sharedRail.close !== undefined) {
          sharedRail.close();
        } else {
          sharedRail.toggle();
        }
        return;
      }
      event.preventDefault();
      exitFullscreen();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [exitFullscreen, effectiveFullscreen, workspaceNavigation?.sharedRail]);

  const resolvePreviewBounds = useCallback((handle: HTMLElement) => {
    const workspaceEl = workspaceRef.current ?? handle.closest<HTMLElement>('[data-preview-workspace]');
    const zoom = cssZoomFactor();
    const viewportWidth = unzoomedViewport().width;
    const maxAvailable = measurePreviewMaxAvailableWidth(workspaceEl ?? null, viewportWidth, zoom);
    const max = clampPreviewWidth(MAX_PREVIEW_WIDTH, viewportWidth, maxAvailable);
    const liveRect = workspaceEl?.getBoundingClientRect();
    const measuredStart = liveRect !== undefined && liveRect.width > 0 ? liveRect.width / zoom : width;
    return { startValue: clampPreviewWidth(measuredStart, viewportWidth, maxAvailable), min: 320, max };
  }, [width]);

  const { startResize, onKeyDown: onResizerKeyDown, reset: resetPreviewWidth } = usePaneResize({
    value: width,
    min: 320,
    max: MAX_PREVIEW_WIDTH,
    direction: -1,
    resolveBounds: resolvePreviewBounds,
    onChange: (nextWidth, final) => {
      const zoom = cssZoomFactor();
      const viewportWidth = unzoomedViewport().width;
      const maxAvailable = measurePreviewMaxAvailableWidth(workspaceRef.current, viewportWidth, zoom);
      onWidthChange(clampPreviewWidth(nextWidth, viewportWidth, maxAvailable), final);
    },
    onReset: () => {
      const zoom = cssZoomFactor();
      const viewportWidth = unzoomedViewport().width;
      const maxAvailable = measurePreviewMaxAvailableWidth(workspaceRef.current, viewportWidth, zoom);
      onWidthChange(clampPreviewWidth(DEFAULT_PREVIEW_WIDTH, viewportWidth, maxAvailable), true);
    },
  });

  if (normalizedTabs.length === 0 && mountedPluginTabs.length === 0) {
    return null;
  }

  const containerClasses = effectiveFullscreen && overlay
    ? 'fixed inset-0 z-40 flex h-full w-full flex-col bg-panel'
    : `preview-workspace ${overlay ? 'preview-workspace--overlay' : ''} ${effectiveFullscreen ? 'preview-workspace--fullscreen' : ''}`;

  const hiddenStyle = effectiveHidden ? { display: 'none' as const } : undefined;
  const containerStyle = effectiveFullscreen ? hiddenStyle : {
    width: narrow ? '100%' : width,
    maxWidth: narrow ? 'none' : undefined,
    ...hiddenStyle,
  };

  const sharedRail = workspaceNavigation?.sharedRail;
  const showStripRailToggle =
    sharedRail !== undefined &&
    sharedRail.available !== false &&
    !phoneMode &&
    effectiveFullscreen &&
    !narrow;

  return (
    <aside
      ref={workspaceRef}
      data-preview-workspace
      data-preview-width-tier={widthTier}
      data-preview-fullscreen={effectiveFullscreen ? '' : undefined}
      hidden={effectiveHidden}
      aria-label={t('preview.title')}
      className={containerClasses}
      style={containerStyle}
    >
      {!effectiveFullscreen && !phoneMode && normalizedTabs.length > 0 ? (
        <div
          className="preview-workspace__resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('preview.resetWidth')}
          tabIndex={0}
          title={t('preview.resetWidth')}
          onPointerDown={(event) => { if (!effectiveFullscreen) startResize(event); }}
          onKeyDown={onResizerKeyDown}
          onDoubleClick={resetPreviewWidth}
        />
      ) : null}
      {normalizedTabs.length > 0 ? (
        <PreviewTabStrip
          tabs={normalizedTabs}
          active={resolvedActive}
          dirtyPaths={dirtyPaths}
          tabReadStates={tabReadStates}
          agentForest={agentForest}
          cwd={cwd}
          sessionId={sessionId}
          phoneMode={phoneMode}
          widthTier={widthTier}
          unifiedHead={unifiedHead}
          actionsSlotRef={actionsSlotRef}
          isFullscreen={effectiveFullscreen}
          onToggleFullscreen={toggleFullscreen}
          railOpen={sharedRail?.open}
          onToggleRail={showStripRailToggle ? sharedRail.toggle : undefined}
          onCollapse={onCollapse}
          onActivate={onActivate}
          onClose={onClose}
          onMove={onMove}
          onOpenContextMenu={(tab, x, y) => { setMenu({ tab, x, y }); }}
        />
      ) : null}
      <PreviewHeaderSlotProvider value={headerSlotValue}>
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
                  visible={isTabActive && !effectiveHidden}
                  suppressRailToggle={showStripRailToggle}
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
              visible={isTabActive && !effectiveHidden}
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
              visible={isTabActive && !effectiveHidden}
              externalReloadNonce={reloadNonces[key]}
            />
          );
        }
        if (tab.kind === 'plugin') {
          return null;
        }
        if (!seenTabs.has(key)) return null;
        return (
          <PreviewResourceTabView
            key={key}
            tabKey={key}
            resource={tab.resource}
            size={tab.size}
            workspaceRoot={cwd}
            visible={isTabActive && !effectiveHidden}
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
      {mountedPluginTabs.map(({ tab, key, isResident }) => {
        if (!isResident && !seenTabs.has(key)) return null;
        const isTabOpen = openTabKeys.has(key);
        const isTabActive = isTabOpen && key === resolvedActive;
        return (
          <PreviewPluginView
            key={key}
            tabKey={key}
            pluginId={tab.pluginId}
            panelId={tab.panelId}
            title={tab.title}
            sessionId={sessionId}
            visible={isTabActive && !effectiveHidden}
            isFullscreen={effectiveFullscreen}
            onToggleFullscreen={toggleFullscreen}
            onCollapse={onCollapse}
            onCloseTab={() => { onClose(key); }}
            externalReloadNonce={reloadNonces[key]}
          />
        );
      })}
      </PreviewHeaderSlotProvider>
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
  suppressRailToggle = false,
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
  readonly suppressRailToggle?: boolean;
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
  useLayoutEffect(() => {
    controller.retainAgentView(viewId, agentId, visibleRef.current ? 'delta' : 'off');
    return () => { controller.releaseAgentView(viewId); };
  }, [controller, viewId, agentId]);
  useLayoutEffect(() => {
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
          showRailToggle={!suppressRailToggle && navigation.sharedRail !== undefined && navigation.sharedRail.available !== false}
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
          visible={visible}
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
