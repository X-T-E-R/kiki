/**
 * PreviewWorkspace — the resident multi-tab preview panel. One tab per host
 * file path or agent panel; tabs close via the × or the context menu (close /
 * close others / close all), reorder by drag, and mark unsaved buffers with a
 * dot. Content routes by extension: images escalate to the lightbox, markdown
 * toggles rendered/source, code/text open in a CodeMirror view, and unknown
 * binaries get the download fallback. Text files are editable where a write
 * channel exists (desktop); everything degrades to read-only otherwise. Every
 * tab's view stays mounted while hidden so editor buffers survive tab
 * switches. Collapsing the panel hides it in place for the same reason: the
 * mounted editor controller keeps its draft and its pending autosave, so
 * re-opening the panel never costs unsaved edits. Only closing the last tab
 * unmounts.
 *
 * Agent (panel) tabs render the same full AgentWorkspace as the agent route
 * page — identity header, timeline, actions and detail rail — chromed by
 * tab-local portal slots instead of the app-level shell slots. While wired,
 * each visible agent tab retains its own transcript view on the shared
 * controller; the lease drops to the summary baseline when the tab or the
 * whole panel hides, and is released when the tab closes. The tab context
 * menu's agent entry opens the same agent on its fullscreen route.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { appendToDraft, mentionToken } from '@kiki/session-core/composer';
import { basenameOf, formatBytes, previewKindOf, type FileReference } from '@kiki/session-core/composer/media';
import type { AgentForest, SessionController, SessionViewState } from '@kiki/session-core/session';
import { useHost, type HostAdapter } from '../host';
import { useI18n } from '../i18n';
import { copyTextToClipboard } from '../lib/clipboard';
import type { KikiClient } from '../lib/client';
import { runToastAction } from '../lib/toasts';
import { useOptionalConnection } from '../state/connection';
import {
  HostFileEditorController,
  type HostFileEditorSnapshot,
} from '../state/hostFileEditor';
import {
  normalizeTabInput,
  previewTabKey,
  type PreviewTab as PreviewTabModel,
} from '../state/previewWorkspace';
import { AgentWorkspace, type AgentWorkspaceNavigation } from './agent-workspace';
import { CodeEditor } from './CodeEditor';
import { ConfirmDialog } from './ConfirmDialog';
import type { ConversationShellSlots } from './ConversationShell';
import { Markdown } from './Markdown';

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
  readonly onWidthChange: (width: number, final: boolean) => void;
  readonly onOpenImage: (src: string, name?: string) => void;
  readonly reportDirty: (path: string, dirty: boolean) => void;
  /**
   * Collapsed (not closed): the panel keeps every tab view — and the editor
   * buffer behind it — mounted and hides itself instead. Unmounting here would
   * dispose the host-file editor controller, dropping the draft and canceling
   * its pending autosave. Defaults to false.
   */
  readonly hidden?: boolean;
  readonly overlay?: boolean;
  /** Session workspace cwd — anchors "Copy relative path" and the @-mention. */
  readonly cwd?: string;
  /** Owning session — the @-mention target composer. Absent without a session. */
  readonly sessionId?: string;
}

const MIN_WIDTH = 320;
const MAX_WIDTH = 760;

export function clampPreviewWidth(width: number, viewport: number): number {
  return Math.max(MIN_WIDTH, Math.min(width, Math.min(MAX_WIDTH, Math.floor(viewport * 0.6))));
}

/**
 * Path relative to the session cwd (posix-style, case-insensitive prefix
 * match for Windows drives); falls back to the untouched absolute path when
 * the file lives outside the workspace.
 */
export function relativeToCwd(path: string, cwd: string | undefined): string {
  if (cwd === undefined) return path;
  const normPath = path.replaceAll('\\', '/');
  const normCwd = cwd.replaceAll('\\', '/').replace(/\/+$/, '');
  const prefix = `${normCwd}/`;
  if (normPath.toLowerCase().startsWith(prefix.toLowerCase())) {
    return normPath.slice(prefix.length);
  }
  return path;
}

/**
 * Composer `@`-token for a previewed file — delegates whitespace quoting to
 * the shared mention formatter so spaced paths arrive as `@"…"`, exactly the
 * shape the TUI's mention autocomplete produces.
 */
function mentionTokenFor(path: string, cwd: string | undefined): string {
  return mentionToken({
    kind: 'file',
    path: relativeToCwd(path, cwd),
    name: basenameOf(path),
    isDir: false,
  });
}

export function PreviewWorkspace({
  tabs,
  active,
  navigation,
  dirtyPaths,
  width,
  sessionViewState,
  agentForest,
  onOpenSubagent,
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
  hidden = false,
  overlay = false,
  cwd,
  sessionId,
}: PreviewWorkspaceProps) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<{ tab: PreviewTabModel; x: number; y: number } | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const dragKeyRef = useRef<string | null>(null);

  const normalizedTabs = useMemo(
    () => tabs.map(normalizeTabInput),
    [tabs],
  );

  // Esc exits fullscreen
  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [isFullscreen]);

  const startResize = (event: React.PointerEvent) => {
    if (isFullscreen) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const onMovePointer = (move: Event) => {
      const x = (move as PointerEvent).clientX;
      onWidthChange(clampPreviewWidth(window.innerWidth - x, window.innerWidth), false);
    };
    const onUp = (up: Event) => {
      const x = (up as PointerEvent).clientX;
      onWidthChange(clampPreviewWidth(window.innerWidth - x, window.innerWidth), true);
      handle.removeEventListener('pointermove', onMovePointer);
      handle.removeEventListener('pointerup', onUp);
    };
    handle.addEventListener('pointermove', onMovePointer);
    handle.addEventListener('pointerup', onUp);
  };

  if (normalizedTabs.length === 0) {
    return null;
  }

  const containerClasses = isFullscreen
    ? 'fixed inset-0 z-40 flex h-screen w-screen flex-col bg-panel'
    : `preview-workspace ${overlay ? 'preview-workspace--overlay' : ''}`;

  // Inline `display:none` rather than the `hidden` class: the class rules on
  // `.preview-workspace` set a display of their own, so only an inline style
  // reliably wins regardless of stylesheet order.
  const hiddenStyle = hidden ? { display: 'none' as const } : undefined;
  const containerStyle = isFullscreen ? hiddenStyle : { width, ...hiddenStyle };

  return (
    <aside
      data-preview-workspace
      hidden={hidden}
      aria-label={t('preview.title')}
      className={containerClasses}
      style={containerStyle}
    >
      {!isFullscreen ? (
        <div
          className="preview-workspace__resizer"
          aria-hidden
          onPointerDown={startResize}
        />
      ) : null}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-hairline pl-2 pr-1">
        <div role="tablist" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {normalizedTabs.map((tab, index) => {
            const key = previewTabKey(tab);
            const isTabActive = key === active;
            return tab.kind === 'file' ? (
              <PreviewFileTab
                key={key}
                tabKey={key}
                path={tab.path}
                active={isTabActive}
                dirty={dirtyPaths.has(tab.path)}
                mentionable={sessionId !== undefined}
                onMention={
                  sessionId === undefined
                    ? undefined
                    : () => { appendToDraft(sessionId, mentionTokenFor(tab.path, cwd)); }
                }
                onActivate={() => { onActivate(key); }}
                onClose={() => { onClose(key); }}
                onContextMenu={(x, y) => { setMenu({ tab, x, y }); }}
                onDragStart={() => { dragKeyRef.current = key; }}
                onDrop={() => {
                  const dragged = dragKeyRef.current;
                  dragKeyRef.current = null;
                  if (dragged !== null && dragged !== key) onMove(dragged, index);
                }}
              />
            ) : (
              <PreviewPanelTab
                key={key}
                tabKey={key}
                tab={tab}
                forest={agentForest}
                active={isTabActive}
                onActivate={() => { onActivate(key); }}
                onClose={() => { onClose(key); }}
                onContextMenu={(x, y) => { setMenu({ tab, x, y }); }}
                onDragStart={() => { dragKeyRef.current = key; }}
                onDrop={() => {
                  const dragged = dragKeyRef.current;
                  dragKeyRef.current = null;
                  if (dragged !== null && dragged !== key) onMove(dragged, index);
                }}
              />
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => { setIsFullscreen(!isFullscreen); }}
          title={isFullscreen ? t('preview.exitFullscreen') : t('preview.fullscreen')}
          aria-label={isFullscreen ? t('preview.exitFullscreen') : t('preview.fullscreen')}
          data-preview-fullscreen-toggle
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-ink-faint transition-colors hover:text-ink"
        >
          {isFullscreen ? '⤢' : '⛶'}
        </button>
        <button
          type="button"
          onClick={onCollapse}
          title={t('preview.collapse')}
          aria-label={t('preview.collapse')}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-ink-faint transition-colors hover:text-ink"
        >
          »
        </button>
      </div>
      {normalizedTabs.map((tab) => {
        const key = previewTabKey(tab);
        const isTabActive = key === active;
        if (tab.kind === 'panel') {
          const workspaceWired =
            controller != null &&
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
                  Agent: {tab.title ?? tab.agentId}
                </div>
              )}
            </div>
          );
        }
        return (
          <PreviewTabView
            key={key}
            path={tab.path}
            visible={isTabActive}
            navigation={navigation?.path === tab.path && isTabActive ? navigation : undefined}
            onOpenImage={onOpenImage}
            reportDirty={reportDirty}
          />
        );
      })}
      {menu !== null ? (
        <TabContextMenu
          menu={menu}
          cwd={cwd}
          workspaceNavigation={workspaceNavigation}
          onCloseMenu={() => { setMenu(null); }}
          onCloseTab={() => { onClose(previewTabKey(menu.tab)); }}
          onCloseOthers={() => { onCloseOthers(previewTabKey(menu.tab)); }}
          onCloseAll={onCloseAll}
        />
      ) : null}
    </aside>
  );
}

/**
 * AgentTabWorkspace — one panel tab's embedded AgentWorkspace. The tab shell
 * owns the container concerns: local chrome slots (header/dock/rail portal
 * targets inside the tabpanel), a per-tab rail that opens as a tab-local
 * drawer, and the transcript view lease. The lease follows actual visibility:
 * 'delta' while the tab is active in a shown panel, 'off' once the tab or the
 * whole panel is hidden (the wildcard 'turn' summary baseline keeps flowing
 * for background tabs), released when the tab unmounts.
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
  const { t } = useI18n();
  const [railOpen, setRailOpen] = useState(false);
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const [dockSlot, setDockSlot] = useState<HTMLElement | null>(null);
  const [railSlot, setRailSlot] = useState<HTMLElement | null>(null);
  const slots = useMemo<ConversationShellSlots>(
    () => ({
      header: headerSlot,
      dock: dockSlot,
      rail: railSlot,
      heroFooter: null,
      footer: null,
      preview: null,
    }),
    [headerSlot, dockSlot, railSlot],
  );

  // Transcript view lease: one per tab, keyed by the stable tab key. Retain
  // once per (controller, view, agent); visibility flips go through
  // updateAgentView so the grade changes in one pass instead of swinging
  // through an intermediate release/re-retain drop.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => {
    controller.retainAgentView(viewId, agentId, visibleRef.current ? 'delta' : 'off');
    return () => { controller.releaseAgentView(viewId); };
  }, [controller, viewId, agentId]);
  useEffect(() => {
    controller.updateAgentView(viewId, visible ? 'delta' : 'off');
  }, [controller, viewId, visible]);

  const closeRail = useCallback(() => { setRailOpen(false); }, []);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-agent-tab-workspace={agentId}>
      <div ref={setHeaderSlot} className="shrink-0" />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <AgentWorkspace
          target={{ sessionId, agentId }}
          controller={controller}
          sessionState={sessionState}
          forest={forest}
          navigation={navigation}
          railOpen={railOpen}
          railIsOverlay
          onToggleRail={() => { setRailOpen((value) => !value); }}
          onCloseRail={closeRail}
          onCancelTask={onCancelTask ?? (() => {})}
          onStopAgentTask={onStopAgentTask ?? (() => Promise.resolve())}
          slots={slots}
          inheritMediaPreview
          showPreviewToggle={false}
          showBreadcrumb={false}
        />
        {railOpen ? (
          <div
            role="button"
            tabIndex={-1}
            aria-label={t('sv.closePanel')}
            className="absolute inset-0 z-10 hidden bg-shell/40 lg:block"
            onClick={closeRail}
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeRail();
            }}
          />
        ) : null}
        {/* The rail drawer overlays the timeline only: the header (with its
            toggle) and the dock stay clickable above it. */}
        <div ref={setRailSlot} className="absolute inset-y-0 right-0 z-20" />
      </div>
      <div ref={setDockSlot} className="shrink-0" />
    </div>
  );
}

function PreviewFileTab({
  tabKey,
  path,
  active,
  dirty,
  mentionable,
  onMention,
  onActivate,
  onClose,
  onContextMenu,
  onDragStart,
  onDrop,
}: {
  readonly tabKey: string;
  readonly path: string;
  readonly active: boolean;
  readonly dirty: boolean;
  /** A mention button only renders when the workspace has an owning session. */
  readonly mentionable: boolean;
  readonly onMention: (() => void) | undefined;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onContextMenu: (x: number, y: number) => void;
  readonly onDragStart: () => void;
  readonly onDrop: () => void;
}) {
  const { t } = useI18n();
  const name = basenameOf(path);
  return (
    <div
      role="tab"
      aria-selected={active}
      title={path}
      draggable
      data-preview-tab={path}
      data-preview-tab-key={tabKey}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', tabKey);
        onDragStart();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      onClick={onActivate}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
      className={`group flex h-7 max-w-40 min-w-0 shrink-0 cursor-pointer items-center gap-1 rounded-t-md border border-b-0 px-2 text-[11.5px] select-none ${
        active
          ? 'border-hairline bg-paper font-medium text-ink'
          : 'border-transparent text-ink-faint hover:text-ink-soft'
      }`}
    >
      {dirty ? (
        <span
          aria-label={t('preview.unsaved')}
          title={t('preview.unsaved')}
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
        />
      ) : null}
      <span className="min-w-0 truncate">{name}</span>
      {mentionable && onMention !== undefined ? (
        <button
          type="button"
          data-mention-file={path}
          aria-label={t('preview.addToChat')}
          title={t('preview.addToChat')}
          onClick={(event) => {
            event.stopPropagation();
            onMention();
          }}
          className={`shrink-0 rounded-sm px-0.5 font-mono text-[11px] leading-none transition-colors hover:text-accent ${
            active ? 'text-ink-faint' : 'text-ink-faint/0 group-hover:text-ink-faint'
          }`}
        >
          @
        </button>
      ) : null}
      <button
        type="button"
        aria-label={`${t('common.close')} ${name}`}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className={`shrink-0 rounded-sm px-0.5 text-[11px] leading-none transition-colors hover:text-danger ${
          active ? 'text-ink-faint' : 'text-ink-faint/0 group-hover:text-ink-faint'
        }`}
      >
        ×
      </button>
    </div>
  );
}

function PreviewPanelTab({
  tabKey,
  tab,
  forest,
  active,
  onActivate,
  onClose,
  onContextMenu,
  onDragStart,
  onDrop,
}: {
  readonly tabKey: string;
  readonly tab: Extract<PreviewTabModel, { kind: 'panel' }>;
  readonly forest?: AgentForest;
  readonly active: boolean;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onContextMenu: (x: number, y: number) => void;
  readonly onDragStart: () => void;
  readonly onDrop: () => void;
}) {
  const { t } = useI18n();
  const node = forest?.byId[tab.agentId];
  const name = tab.title ?? node?.label ?? tab.agentId;
  const isBusy = node?.busy ?? false;

  return (
    <div
      role="tab"
      aria-selected={active}
      title={`Agent: ${name} (${tab.agentId})`}
      draggable
      data-preview-tab={tabKey}
      data-preview-tab-key={tabKey}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', tabKey);
        onDragStart();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      onClick={onActivate}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
      className={`group flex h-7 max-w-44 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2 text-[11.5px] select-none ${
        active
          ? 'border-hairline bg-paper font-medium text-ink'
          : 'border-transparent text-ink-faint hover:text-ink-soft'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          isBusy ? 'status-dot-busy bg-accent' : node?.status === 'failed' ? 'bg-danger' : 'bg-ink-faint/60'
        }`}
      />
      <span className="min-w-0 truncate">{name}</span>
      <button
        type="button"
        aria-label={`${t('common.close')} ${name}`}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className={`shrink-0 rounded-sm px-0.5 text-[11px] leading-none transition-colors hover:text-danger ${
          active ? 'text-ink-faint' : 'text-ink-faint/0 group-hover:text-ink-faint'
        }`}
      >
        ×
      </button>
    </div>
  );
}

function TabContextMenu({
  menu,
  cwd,
  workspaceNavigation,
  onCloseMenu,
  onCloseTab,
  onCloseOthers,
  onCloseAll,
}: {
  readonly menu: { tab: PreviewTabModel; x: number; y: number };
  readonly cwd: string | undefined;
  readonly workspaceNavigation: AgentWorkspaceNavigation | undefined;
  readonly onCloseMenu: () => void;
  readonly onCloseTab: () => void;
  readonly onCloseOthers: () => void;
  readonly onCloseAll: () => void;
}) {
  const host = useHost();
  const { t } = useI18n();
  const closeRef = useRef(onCloseMenu);
  closeRef.current = onCloseMenu;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (
        !(event.target instanceof HTMLElement) ||
        event.target.closest('[data-preview-tab-menu]') === null
      ) {
        closeRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);

  const itemClass =
    'w-full rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-paper';
  const pick = (run: () => void) => {
    onCloseMenu();
    run();
  };
  const pickAction = (label: string, action: () => Promise<void>) => {
    onCloseMenu();
    runToastAction(label, action);
  };

  const tab = menu.tab;

  return (
    <div
      data-preview-tab-menu
      role="menu"
      className="anim-enter fixed z-50 w-52 rounded-lg border border-hairline bg-panel p-1 shadow-[0_8px_24px_-10px_rgba(28,25,23,0.3)]"
      style={{ left: menu.x, top: menu.y }}
    >
      <button type="button" role="menuitem" className={itemClass} onClick={() => { pick(onCloseTab); }}>
        {t('preview.closeTab')}
      </button>
      <button type="button" role="menuitem" className={itemClass} onClick={() => { pick(onCloseOthers); }}>
        {t('preview.closeOthers')}
      </button>
      <button type="button" role="menuitem" className={itemClass} onClick={() => { pick(onCloseAll); }}>
        {t('preview.closeAll')}
      </button>
      {tab.kind === 'file' ? (
        <>
          <div className="mx-1 my-1 border-t border-hairline" />
          <button
            type="button"
            role="menuitem"
            data-menu-item="copy-relative"
            className={itemClass}
            onClick={() => {
              const rel = relativeToCwd(tab.path, cwd);
              pickAction(t('file.copyRelativePath'), () => copyTextToClipboard(rel));
            }}
          >
            {t('file.copyRelativePath')}
          </button>
          <button
            type="button"
            role="menuitem"
            data-menu-item="copy-absolute"
            className={itemClass}
            onClick={() => { pickAction(t('file.copyAbsolutePath'), () => copyTextToClipboard(tab.path)); }}
          >
            {t('file.copyAbsolutePath')}
          </button>
          {host.revealPath !== undefined && host.openPath !== undefined ? (
            <>
              <button
                type="button"
                role="menuitem"
                data-menu-item="show-in-folder"
                className={itemClass}
                onClick={() => { pickAction(t('file.showInFolder'), () => host.revealPath!(tab.path)); }}
              >
                {t('file.showInFolder')}
              </button>
              <button
                type="button"
                role="menuitem"
                data-menu-item="open-default-app"
                className={itemClass}
                onClick={() => { pickAction(t('file.openDefaultApp'), () => host.openPath!(tab.path)); }}
              >
                {t('file.openDefaultApp')}
              </button>
            </>
          ) : null}
        </>
      ) : (
        <>
          <div className="mx-1 my-1 border-t border-hairline" />
          {workspaceNavigation !== undefined ? (
            <button
              type="button"
              role="menuitem"
              data-menu-item="open-agent-route"
              className={itemClass}
              onClick={() => { pick(() => { workspaceNavigation.openAgentRoute(tab.agentId); }); }}
            >
              {t('subagent.openAgent', { name: tab.title ?? tab.agentId })}
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            data-menu-item="copy-agent-id"
            className={itemClass}
            onClick={() => {
              pickAction(t('preview.copyAgentId'), () => copyTextToClipboard(tab.agentId));
            }}
          >
            {t('preview.copyAgentId')}
          </button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab content
// ---------------------------------------------------------------------------

async function downloadHostFile(
  host: HostAdapter,
  client: KikiClient,
  path: string,
  name: string,
): Promise<void> {
  const { bytes, mime } = await client.readHostFileBytes(path);
  const blob = new Blob([bytes as BlobPart], { type: mime });
  if (host.saveBlob !== undefined) {
    try {
      await host.saveBlob(blob, name);
      return;
    } catch {
      // Fall through to the browser download.
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function PreviewTabView({
  path,
  visible,
  navigation,
  onOpenImage,
  reportDirty,
}: {
  readonly path: string;
  readonly visible: boolean;
  readonly navigation?: FileReference;
  readonly onOpenImage: (src: string, name?: string) => void;
  readonly reportDirty: (path: string, dirty: boolean) => void;
}) {
  const kind = previewKindOf(path);
  return (
    <div
      role="tabpanel"
      hidden={!visible}
      className={`min-h-0 flex-1 flex-col ${visible ? 'flex' : 'hidden'}`}
      data-preview-tabpanel={path}
    >
      {kind === 'image' ? (
        <ImageTabView path={path} onOpenImage={onOpenImage} />
      ) : kind === 'binary' ? (
        <BinaryTabView path={path} />
      ) : (
        <TextTabView path={path} markdown={kind === 'markdown'} navigation={navigation} reportDirty={reportDirty} />
      )}
    </div>
  );
}

function TabPathCaption({ path }: { readonly path: string }) {
  return (
    <p className="truncate border-b border-hairline px-3 py-1.5 font-mono text-[10.5px] text-ink-faint" title={path}>
      {path}
    </p>
  );
}

function ImageTabView({
  path,
  onOpenImage,
}: {
  readonly path: string;
  readonly onOpenImage: (src: string, name?: string) => void;
}) {
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const name = basenameOf(path);
  const [state, setState] = useState<
    | { readonly status: 'loading' }
    | { readonly status: 'error' }
    | { readonly status: 'ready'; readonly url: string; readonly size: number }
  >({ status: 'loading' });

  useEffect(() => {
    const client = connection?.client;
    if (client === undefined) {
      setState({ status: 'error' });
      return;
    }
    let cancelled = false;
    let objectUrl: string | undefined;
    setState({ status: 'loading' });
    client.readHostFileBytes(path).then(
      ({ bytes, mime }) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
        setState({ status: 'ready', url: objectUrl, size: bytes.byteLength });
      },
      () => {
        if (!cancelled) setState({ status: 'error' });
      },
    );
    return () => {
      cancelled = true;
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [connection, path]);

  return (
    <>
      <TabPathCaption path={path} />
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {state.status === 'loading' ? (
          <p className="flex items-center gap-2 text-[12px] text-ink-faint">
            <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
            {t('preview.loading')}
          </p>
        ) : state.status === 'error' ? (
          <p className="text-[12.5px] text-danger">{t('preview.failed')}</p>
        ) : (
          <button
            type="button"
            onClick={() => { onOpenImage(state.url, name); }}
            className="block"
            title={t('media.viewImage')}
          >
            <img
              src={state.url}
              alt={name}
              className="max-h-[70vh] rounded-lg border border-hairline object-contain"
            />
            <span className="mt-1 block font-mono text-[10.5px] text-ink-faint">
              {formatBytes(state.size)}
            </span>
          </button>
        )}
      </div>
    </>
  );
}

function BinaryTabView({ path }: { readonly path: string }) {
  const host = useHost();
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const name = basenameOf(path);
  return (
    <>
      <TabPathCaption path={path} />
      <div className="flex flex-1 flex-col items-start gap-3 p-4">
        <p className="text-[12.5px] text-ink-soft">{t('preview.unsupported')}</p>
        <button
          type="button"
          onClick={() => {
            const client = connection?.client;
            if (client !== undefined) void downloadHostFile(host, client, path, name);
          }}
          className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-accent-deep"
        >
          {t('media.download')}
        </button>
      </div>
    </>
  );
}

/**
 * Text/code/markdown tab: one HostFileEditorController per tab (created when
 * the connection's client is available), CodeMirror for source, the Markdown
 * renderer for the rendered markdown mode.
 */
const IDLE_SNAPSHOT: HostFileEditorSnapshot = {
  status: 'loading',
  error: undefined,
  savedText: '',
  draft: '',
  dirty: false,
  saving: false,
  conflict: false,
  oversized: false,
  generation: 0,
  lastSavedAt: undefined,
};

function TextTabView({
  path,
  markdown,
  navigation,
  reportDirty,
}: {
  readonly path: string;
  readonly markdown: boolean;
  readonly navigation?: FileReference;
  readonly reportDirty: (path: string, dirty: boolean) => void;
}) {
  const host = useHost();
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const client = connection?.client;
  const [controller, setController] = useState<HostFileEditorController | null>(null);
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered');
  useEffect(() => {
    if (navigation?.line !== undefined) setMode('source');
  }, [navigation]);

  useEffect(() => {
    if (client === undefined) {
      setController(null);
      return;
    }
    const next = new HostFileEditorController({
      path,
      readFile: (target) => client.readHostFile(target),
      writeFile: host.writeFileText,
    });
    setController(next);
    void next.load();
    return () => {
      next.dispose();
      setController(null);
    };
  }, [client, host, path]);

  const subscribe = useMemo(
    () => controller?.subscribe ?? (() => () => {}),
    [controller],
  );
  // Stable fallback snapshot: useSyncExternalStore loops forever on a fresh
  // object per call while the controller is still being created.
  const getState = useMemo(
    () => controller?.getState ?? (() => IDLE_SNAPSHOT),
    [controller],
  );
  const snap = useSyncExternalStore(subscribe, getState);

  const dirty = snap.dirty;
  useEffect(() => {
    reportDirty(path, dirty);
    return () => { reportDirty(path, false); };
  }, [reportDirty, path, dirty]);

  const name = basenameOf(path);
  const editable = controller?.editable ?? false;
  const showEditor = !markdown || mode === 'source';
  const clientForDownload = client;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-faint" title={path}>
          {path}
        </span>
        {markdown ? (
          <span className="flex shrink-0 overflow-hidden rounded-full border border-hairline text-[10.5px]">
            {(['rendered', 'source'] as const).map((option) => (
              <button
                key={option}
                type="button"
                data-md-mode={option}
                onClick={() => { setMode(option); }}
                className={`px-2 py-0.5 transition-colors ${
                  mode === option
                    ? 'bg-accent-soft font-medium text-accent'
                    : 'text-ink-faint hover:text-ink-soft'
                }`}
              >
                {option === 'rendered' ? t('preview.rendered') : t('preview.source')}
              </button>
            ))}
          </span>
        ) : null}
        {snap.status === 'ready' ? (
          <span className="shrink-0 text-[10.5px] text-ink-faint" data-save-status>
            {snap.saving
              ? t('preview.saving')
              : snap.dirty
                ? `● ${t('preview.unsaved')}`
                : snap.lastSavedAt !== undefined
                  ? `✓ ${t('preview.saved')}`
                  : ''}
          </span>
        ) : null}
        {editable ? (
          <button
            type="button"
            data-save-button
            disabled={!snap.dirty || snap.saving}
            onClick={() => { void controller?.saveNow(); }}
            className="shrink-0 rounded-full border border-hairline px-2 py-0.5 text-[10.5px] font-medium text-ink-soft transition-colors hover:border-accent hover:text-accent disabled:cursor-default disabled:opacity-40 disabled:hover:border-hairline disabled:hover:text-ink-soft"
          >
            {t('preview.save')}
          </button>
        ) : null}
        <button
          type="button"
          title={t('media.download')}
          onClick={() => {
            if (clientForDownload !== undefined) {
              void downloadHostFile(host, clientForDownload, path, name);
            }
          }}
          className="shrink-0 rounded-full border border-hairline px-2 py-0.5 text-[10.5px] text-ink-soft transition-colors hover:border-accent hover:text-accent"
        >
          ↓
        </button>
      </div>
      {snap.conflict ? (
        <div
          data-conflict-banner
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-rule/40 bg-amber-card px-3 py-1.5 text-[11px] text-amber-ink"
        >
          <span className="min-w-0 flex-1">{t('preview.conflictBody')}</span>
          <button
            type="button"
            data-conflict-overwrite
            onClick={() => { void controller?.resolveConflict('overwrite'); }}
            className="rounded-full border border-amber-rule/60 px-2 py-0.5 font-medium transition-colors hover:bg-amber-rule/20"
          >
            {t('preview.overwrite')}
          </button>
          <button
            type="button"
            data-conflict-reload
            onClick={() => { void controller?.resolveConflict('reload'); }}
            className="rounded-full border border-amber-rule/60 px-2 py-0.5 font-medium transition-colors hover:bg-amber-rule/20"
          >
            {t('preview.reload')}
          </button>
          <button
            type="button"
            onClick={() => { void controller?.resolveConflict('cancel'); }}
            className="rounded-full px-2 py-0.5 text-amber-ink/70 transition-colors hover:text-amber-ink"
          >
            {t('preview.keepEditing')}
          </button>
        </div>
      ) : null}
      {snap.error !== undefined && snap.status !== 'error' ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-danger/30 bg-danger/5 px-3 py-1.5 text-[11px] text-danger">
          <span className="min-w-0 flex-1 truncate">{snap.error}</span>
          <button
            type="button"
            onClick={() => { controller?.dismissError(); }}
            aria-label={t('common.close')}
            className="shrink-0"
          >
            ×
          </button>
        </div>
      ) : null}
      {!editable && snap.status === 'ready' ? (
        <p className="shrink-0 border-b border-hairline bg-paper/60 px-3 py-1 text-[10.5px] text-ink-faint">
          {snap.oversized ? t('preview.oversized') : t('preview.editUnsupported')}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        {snap.status === 'loading' ? (
          <p className="flex items-center gap-2 p-3 text-[12px] text-ink-faint">
            <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
            {t('preview.loading')}
          </p>
        ) : snap.status === 'error' ? (
          <p className="p-3 text-[12.5px] text-danger">{t('preview.failed')}</p>
        ) : showEditor ? (
          <CodeEditor
            key={path}
            path={path}
            value={snap.draft}
            generation={snap.generation}
            navigation={navigation}
            readOnly={!editable}
            onChange={(text) => { controller?.setDraft(text); }}
            onSaveShortcut={() => { void controller?.saveNow(); }}
            ariaLabel={t('preview.openFile', { name })}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <Markdown text={snap.draft} />
          </div>
        )}
      </div>
    </>
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
