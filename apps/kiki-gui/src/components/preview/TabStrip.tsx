/**
 * PreviewWorkspace top bar — desktop tab strip (`resource`, `web`, `panel`,
 * and `skill`) with active-tab scroll-into-view and overflow cue, plus the
 * phone title + tab-list `ActionSheet` (`#36`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { appendToDraft } from '@kiki/session-core/composer';
import { basenameOf, resolveHostPath } from '@kiki/session-core/composer/media';
import type { AgentForest } from '@kiki/session-core/session';
import { useI18n } from '#/i18n';
import {
  resourceMutability,
  type PreviewReadState,
  type PreviewResource,
} from '#/state/previewResource';
import { previewTabKey, type PreviewTab as PreviewTabModel } from '#/state/previewWorkspace';
import { Icon, resolvePluginSlotIconName, type IconName } from '../icons';
import { ActionSheet } from '../overlays/ActionSheet';
import { mentionTokenFor, webUrlDisplayLabel } from './shared';

function tabDisplayInfo(
  tab: PreviewTabModel,
  agentForest: AgentForest | undefined,
  fallbackAttachmentLabel: string,
): { readonly label: string; readonly icon: IconName; readonly isCopy: boolean } {
  if (tab.kind === 'resource') {
    const { resource } = tab;
    const { source } = resource;
    const label =
      resource.name ??
      (source.kind === 'host-file'
        ? basenameOf(source.path)
        : source.kind === 'session-copy'
          ? basenameOf(source.fileId)
          : fallbackAttachmentLabel);
    const icon: IconName =
      resource.type === 'html'
        ? 'web'
        : resource.type === 'markdown' || resource.type === 'pdf' || resource.type === 'office'
          ? 'read'
          : 'file';
    return {
      label,
      icon,
      isCopy: resourceMutability(resource) === 'copy',
    };
  }
  if (tab.kind === 'web') {
    return { label: webUrlDisplayLabel(tab.url, tab.title), icon: 'compass', isCopy: false };
  }
  if (tab.kind === 'skill') {
    return { label: `${tab.name} / SKILL.md`, icon: 'skill', isCopy: false };
  }
  if (tab.kind === 'plugin') {
    const label =
      tab.title !== undefined && tab.title.trim() !== ''
        ? tab.title.trim()
        : `${tab.pluginId} · ${tab.panelId}`;
    return {
      label,
      icon: resolvePluginSlotIconName({
        pluginId: tab.pluginId,
        panelId: tab.panelId,
        fallback: 'plugin',
      }),
      isCopy: false,
    };
  }
  const node = agentForest?.byId[tab.agentId];
  return {
    label: tab.title ?? node?.label ?? tab.agentId,
    icon: 'agent',
    isCopy: false,
  };
}

export interface PreviewTabStripProps {
  readonly tabs: readonly PreviewTabModel[];
  readonly active: string | null;
  readonly dirtyPaths: ReadonlySet<string>;
  readonly tabReadStates: Readonly<Record<string, PreviewReadState>>;
  readonly agentForest?: AgentForest;
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly phoneMode: boolean;
  readonly isFullscreen: boolean;
  readonly onToggleFullscreen: () => void;
  readonly onCollapse: () => void;
  readonly onOpenCockpit?: () => void;
  readonly onActivate: (key: string) => void;
  readonly onClose: (key: string) => void;
  readonly onMove: (key: string, targetIndex: number) => void;
  readonly onOpenContextMenu: (tab: PreviewTabModel, x: number, y: number) => void;
}

export function PreviewTabStrip({
  tabs,
  active,
  dirtyPaths,
  tabReadStates,
  agentForest,
  cwd,
  sessionId,
  phoneMode,
  isFullscreen,
  onToggleFullscreen,
  onCollapse,
  onOpenCockpit,
  onActivate,
  onClose,
  onMove,
  onOpenContextMenu,
}: PreviewTabStripProps) {
  const { t } = useI18n();
  const dragKeyRef = useRef<string | null>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [overflowState, setOverflowState] = useState<{ left: boolean; right: boolean }>({
    left: false,
    right: false,
  });

  const updateOverflow = useCallback(() => {
    const scroller = tabListRef.current;
    if (scroller === null) return;
    const left = scroller.scrollLeft > 1;
    const right = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1;
    setOverflowState((prev) =>
      prev.left === left && prev.right === right ? prev : { left, right },
    );
  }, []);

  useEffect(() => {
    if (phoneMode || active === null) return;
    const scroller = tabListRef.current;
    if (scroller === null) return;
    const activeChip = [...scroller.querySelectorAll<HTMLElement>('[data-preview-tab-key]')].find(
      (node) => node.dataset['previewTabKey'] === active,
    );
    activeChip?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    updateOverflow();
  }, [active, phoneMode, tabs.length, updateOverflow]);

  useEffect(() => {
    if (phoneMode) return undefined;
    updateOverflow();
    const scroller = tabListRef.current;
    if (scroller === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      updateOverflow();
    });
    observer.observe(scroller);
    return () => {
      observer.disconnect();
    };
  }, [phoneMode, tabs.length, updateOverflow]);

  if (phoneMode) {
    const activeTab = tabs.find((tab) => previewTabKey(tab, cwd) === active) ?? tabs[0];
    const activeInfo =
      activeTab === undefined
        ? { label: t('preview.title'), icon: 'file' as const, isCopy: false }
        : tabDisplayInfo(activeTab, agentForest, t('media.attachment'));
    return (
      <div
        className="flex min-h-11 shrink-0 items-center gap-1 border-b border-hairline pl-2 pr-1"
        data-preview-phone-title-row
      >
        <button
          type="button"
          data-preview-tab-picker
          aria-expanded={sheetOpen}
          aria-haspopup="menu"
          aria-label={t('preview.tabPickerAria', { name: activeInfo.label, count: tabs.length })}
          onClick={() => { setSheetOpen(true); }}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-[13px] font-medium text-ink transition-colors hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
        >
          <span className="min-w-0 truncate" data-preview-phone-active-name>
            {activeInfo.label}
          </span>
          {activeInfo.isCopy ? (
            <span
              data-preview-copy-badge
              className="shrink-0 rounded-[3px] bg-ink/[0.06] px-1 py-0.5 text-[10px] leading-none font-normal text-ink-faint"
            >
              {t('preview.sentCopyBadge')}
            </span>
          ) : null}
          <span aria-hidden className="shrink-0 text-[12px] text-ink-faint">
            ▾ · {tabs.length}
          </span>
        </button>
        {isFullscreen ? (
          <button
            type="button"
            onClick={onToggleFullscreen}
            title={t('preview.exitFullscreen')}
            aria-label={t('preview.exitFullscreen')}
            data-preview-fullscreen-toggle
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-[12px] text-ink-faint transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
          >
            <Icon name="collapse" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onCollapse}
          title={t('preview.collapse')}
          aria-label={t('preview.collapse')}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-[12px] text-ink-faint transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
        >
          »
        </button>
        {sheetOpen ? (
          <ActionSheet
            ariaLabel={t('preview.openTabsTitle')}
            overlayId="preview-tab-picker"
            dataAttribute="data-preview-tab-sheet"
            onClose={() => { setSheetOpen(false); }}
          >
            {tabs.map((tab) => {
              const key = previewTabKey(tab, cwd);
              const isTabActive = key === active;
              const info = tabDisplayInfo(tab, agentForest, t('media.attachment'));
              const hostPath =
                tab.kind === 'resource' && tab.resource.source.kind === 'host-file'
                  ? tab.resource.source.path
                  : undefined;
              const dirty = hostPath !== undefined && dirtyPaths.has(hostPath);
              return (
                <div
                  key={key}
                  data-preview-tab-sheet-row={key}
                  className="flex items-center gap-1 rounded-[10px]"
                >
                  <button
                    type="button"
                    role="menuitem"
                    aria-current={isTabActive ? 'true' : undefined}
                    data-preview-tab-sheet-select={key}
                    onClick={() => {
                      onActivate(key);
                      setSheetOpen(false);
                    }}
                    className={`flex min-h-12 min-w-0 flex-1 items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-left text-[15px] transition-colors hover:bg-paper focus-visible:bg-paper ${
                      isTabActive ? 'font-medium text-ink' : 'text-ink-soft'
                    }`}
                  >
                    <Icon name={info.icon} size={16} className="shrink-0 text-ink-faint" />
                    {dirty ? (
                      <span
                        aria-label={t('preview.unsaved')}
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                      />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">{info.label}</span>
                    {info.isCopy ? (
                      <span className="shrink-0 rounded-[3px] bg-ink/[0.06] px-1.5 py-0.5 text-[11px] leading-none font-normal text-ink-faint">
                        {t('preview.sentCopyBadge')}
                      </span>
                    ) : null}
                    {isTabActive ? (
                      <Icon name="check" size={16} className="shrink-0 text-accent" />
                    ) : null}
                  </button>
                  <button
                    type="button"
                    aria-label={`${t('common.close')} ${info.label}`}
                    data-preview-tab-sheet-close={key}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (tabs.length <= 1) setSheetOpen(false);
                      onClose(key);
                    }}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] text-ink-faint transition-colors hover:bg-paper hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
              );
            })}
          </ActionSheet>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-hairline pl-2 pr-1 lg:h-9">
      <div className="relative flex min-w-0 flex-1 items-center">
        <div
          ref={tabListRef}
          role="tablist"
          onScroll={updateOverflow}
          data-overflow-left={overflowState.left ? 'true' : undefined}
          data-overflow-right={overflowState.right ? 'true' : undefined}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pr-2"
        >
          {tabs.map((tab, index) => {
            const key = previewTabKey(tab, cwd);
            const isTabActive = key === active;
            const tabReadState = tabReadStates[key];
            const readFailed = tabReadState?.status === 'failed';
            return tab.kind === 'resource' ? (
              <PreviewResourceTabChip
                key={key}
                tabKey={key}
                resource={tab.resource}
                cwd={cwd}
                sessionId={sessionId}
                dirtyPaths={dirtyPaths}
                readFailed={readFailed}
                active={isTabActive}
                onActivate={() => { onActivate(key); }}
                onClose={() => { onClose(key); }}
                onContextMenu={(x, y) => { onOpenContextMenu(tab, x, y); }}
                onDragStart={() => { dragKeyRef.current = key; }}
                onDrop={() => {
                  const dragged = dragKeyRef.current;
                  dragKeyRef.current = null;
                  if (dragged !== null && dragged !== key) onMove(dragged, index);
                }}
              />
            ) : tab.kind === 'web' ? (
              <PreviewWebTab
                key={key}
                tabKey={key}
                url={tab.url}
                title={tab.title}
                active={isTabActive}
                onActivate={() => { onActivate(key); }}
                onClose={() => { onClose(key); }}
                onContextMenu={(x, y) => { onOpenContextMenu(tab, x, y); }}
                onDragStart={() => { dragKeyRef.current = key; }}
                onDrop={() => {
                  const dragged = dragKeyRef.current;
                  dragKeyRef.current = null;
                  if (dragged !== null && dragged !== key) onMove(dragged, index);
                }}
              />
            ) : tab.kind === 'skill' ? (
              <PreviewSkillTab
                key={key}
                tabKey={key}
                name={tab.name}
                active={isTabActive}
                onActivate={() => { onActivate(key); }}
                onClose={() => { onClose(key); }}
                onContextMenu={(x, y) => { onOpenContextMenu(tab, x, y); }}
                onDragStart={() => { dragKeyRef.current = key; }}
                onDrop={() => {
                  const dragged = dragKeyRef.current;
                  dragKeyRef.current = null;
                  if (dragged !== null && dragged !== key) onMove(dragged, index);
                }}
              />
            ) : tab.kind === 'plugin' ? (
              <PreviewPluginTab
                key={key}
                tabKey={key}
                tab={tab}
                active={isTabActive}
                onActivate={() => { onActivate(key); }}
                onClose={() => { onClose(key); }}
                onContextMenu={(x, y) => { onOpenContextMenu(tab, x, y); }}
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
                onContextMenu={(x, y) => { onOpenContextMenu(tab, x, y); }}
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
        {overflowState.right ? (
          <div
            aria-hidden
            data-preview-tabs-overflow-cue
            className="pointer-events-none absolute inset-y-0 right-0 w-5 bg-gradient-to-l from-panel to-transparent"
          />
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 border-l border-hairline/70 pl-1">
        {onOpenCockpit !== undefined ? (
          <button
            type="button"
            data-preview-open-cockpit
            onClick={onOpenCockpit}
            className="hidden h-7 shrink-0 items-center rounded-md px-2 text-[12px] text-ink-faint hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink lg:flex min-[85rem]:hidden"
          >
            {t('rail.mode.cockpit')}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onToggleFullscreen}
          title={isFullscreen ? t('preview.exitFullscreen') : t('preview.fullscreen')}
          aria-label={isFullscreen ? t('preview.exitFullscreen') : t('preview.fullscreen')}
          data-preview-fullscreen-toggle
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-[12px] text-ink-faint transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink lg:h-7 lg:w-7"
        >
          <Icon name={isFullscreen ? 'collapse' : 'expand'} />
        </button>
        <button
          type="button"
          onClick={onCollapse}
          title={t('preview.collapse')}
          aria-label={t('preview.collapse')}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-[12px] text-ink-faint transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink lg:h-7 lg:w-7"
        >
          »
        </button>
      </div>
    </div>
  );
}

function PreviewResourceTabChip({
  tabKey,
  resource,
  cwd,
  sessionId,
  dirtyPaths,
  readFailed,
  active,
  onActivate,
  onClose,
  onContextMenu,
  onDragStart,
  onDrop,
}: {
  readonly tabKey: string;
  readonly resource: PreviewResource;
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly dirtyPaths: ReadonlySet<string>;
  readonly readFailed: boolean;
  readonly active: boolean;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onContextMenu: (x: number, y: number) => void;
  readonly onDragStart: () => void;
  readonly onDrop: () => void;
}) {
  const { t } = useI18n();
  const { source } = resource;
  const isCopy = resourceMutability(resource) === 'copy';
  const hostPath = source.kind === 'host-file' ? source.path : undefined;
  const trustedPath =
    resource.origin !== undefined && resource.origin.trusted
      ? resolveHostPath(resource.origin.path, cwd)
      : hostPath;
  const name =
    resource.name ??
    (hostPath !== undefined
      ? basenameOf(hostPath)
      : source.kind === 'session-copy'
        ? basenameOf(source.fileId)
        : t('media.attachment'));
  const dataTabId =
    source.kind === 'host-file'
      ? source.path
      : source.kind === 'session-copy'
        ? source.fileId
        : source.url || name;
  const dirty = hostPath !== undefined && dirtyPaths.has(hostPath);
  const canMention = sessionId !== undefined && trustedPath !== undefined && !readFailed;

  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      title={trustedPath ?? name}
      draggable
      data-preview-tab={dataTabId}
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
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
      className={`group flex h-7 ${isCopy ? 'max-w-52' : 'max-w-40'} min-w-0 shrink-0 cursor-pointer items-center gap-1 rounded-t-md border border-b-0 px-2 text-[11.5px] select-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${
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
      {isCopy ? (
        <span
          data-preview-copy-badge
          className="shrink-0 rounded-[3px] bg-ink/[0.06] px-1 py-0.5 text-[10px] leading-none font-normal text-ink-faint"
        >
          {t('preview.sentCopyBadge')}
        </span>
      ) : null}
      {canMention && trustedPath !== undefined ? (
        <button
          type="button"
          data-mention-file={trustedPath}
          aria-label={t('preview.addToChat')}
          title={t('preview.addToChat')}
          onClick={(event) => {
            event.stopPropagation();
            appendToDraft(sessionId, mentionTokenFor(trustedPath, cwd));
          }}
          className={`shrink-0 rounded-sm px-0.5 font-mono text-[11px] leading-none transition-colors hover:text-ink ${
            active ? 'text-ink-faint' : 'text-ink-faint/0 group-hover:text-ink-faint pointer-coarse:text-ink-faint'
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
          active ? 'text-ink-faint' : 'text-ink-faint/0 group-hover:text-ink-faint pointer-coarse:text-ink-faint'
        }`}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

function PreviewSkillTab({
  tabKey,
  name,
  active,
  onActivate,
  onClose,
  onContextMenu,
  onDragStart,
  onDrop,
}: {
  readonly tabKey: string;
  readonly name: string;
  readonly active: boolean;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onContextMenu: (x: number, y: number) => void;
  readonly onDragStart: () => void;
  readonly onDrop: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      title={`${t('cap.source.builtin')} · ${name} / SKILL.md`}
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
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
      className={`group flex h-7 max-w-48 min-w-0 shrink-0 cursor-pointer items-center gap-1 rounded-t-md border border-b-0 px-2 text-[11.5px] select-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${
        active ? 'border-hairline bg-paper font-medium text-ink' : 'border-transparent text-ink-faint hover:text-ink-soft'
      }`}
    >
      <span className="min-w-0 truncate">SKILL.md</span>
      <span className="min-w-0 truncate text-[11px] text-ink-faint">{name}</span>
      <button
        type="button"
        aria-label={`${t('common.close')} ${name} SKILL.md`}
        onClick={(event) => { event.stopPropagation(); onClose(); }}
        className={`shrink-0 rounded-sm px-0.5 text-[11px] leading-none transition-colors hover:text-danger ${
          active ? 'text-ink-faint' : 'text-ink-faint/0 group-hover:text-ink-faint pointer-coarse:text-ink-faint'
        }`}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

function PreviewWebTab({
  tabKey,
  url,
  title,
  active,
  onActivate,
  onClose,
  onContextMenu,
  onDragStart,
  onDrop,
}: {
  readonly tabKey: string;
  readonly url: string;
  readonly title?: string;
  readonly active: boolean;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onContextMenu: (x: number, y: number) => void;
  readonly onDragStart: () => void;
  readonly onDrop: () => void;
}) {
  const { t } = useI18n();
  const label = webUrlDisplayLabel(url, title);
  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      title={url}
      draggable
      data-preview-tab={url}
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
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
      className={`group flex h-7 max-w-44 min-w-0 shrink-0 cursor-pointer items-center gap-1 rounded-t-md border border-b-0 px-2 text-[11.5px] select-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${
        active ? 'border-hairline bg-paper font-medium text-ink' : 'border-transparent text-ink-faint hover:text-ink-soft'
      }`}
    >
      <Icon name="compass" size={12} className="shrink-0 text-ink-faint" />
      <span className="min-w-0 truncate">{label}</span>
      <button
        type="button"
        aria-label={`${t('common.close')} ${label}`}
        onClick={(event) => { event.stopPropagation(); onClose(); }}
        className={`shrink-0 rounded-sm px-0.5 text-[11px] leading-none transition-colors hover:text-danger ${
          active ? 'text-ink-faint' : 'text-ink-faint/0 group-hover:text-ink-faint pointer-coarse:text-ink-faint'
        }`}
      >
        <Icon name="close" size={12} />
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
      tabIndex={0}
      aria-selected={active}
      title={t('preview.agentTabTitle', { name, id: tab.agentId })}
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
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
      className={`group flex h-11 max-w-44 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2 text-[11.5px] select-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink lg:h-7 ${
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
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-[11px] leading-none transition-colors hover:text-danger lg:h-auto lg:w-auto lg:px-0.5 ${
          active ? 'text-ink-faint' : 'text-ink-faint/0 group-hover:text-ink-faint pointer-coarse:text-ink-faint'
        }`}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

function PreviewPluginTab({
  tabKey,
  tab,
  active,
  onActivate,
  onClose,
  onContextMenu,
  onDragStart,
  onDrop,
}: {
  readonly tabKey: string;
  readonly tab: Extract<PreviewTabModel, { kind: 'plugin' }>;
  readonly active: boolean;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onContextMenu: (x: number, y: number) => void;
  readonly onDragStart: () => void;
  readonly onDrop: () => void;
}) {
  const { t } = useI18n();
  const label = tab.title !== undefined && tab.title.trim() !== '' ? tab.title.trim() : `${tab.pluginId} · ${tab.panelId}`;
  const iconName = resolvePluginSlotIconName({
    pluginId: tab.pluginId,
    panelId: tab.panelId,
    fallback: 'plugin',
  });

  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      title={`${label} (${tab.pluginId}:${tab.panelId})`}
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
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
      className={`group flex h-11 max-w-44 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2 text-[11.5px] select-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink lg:h-7 ${
        active
          ? 'border-hairline bg-paper font-medium text-ink'
          : 'border-transparent text-ink-faint hover:text-ink-soft'
      }`}
    >
      <Icon name={iconName} size={12} className="shrink-0 text-ink-faint" />
      <span className="min-w-0 truncate">{label}</span>
      <button
        type="button"
        aria-label={`${t('common.close')} ${label}`}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-[11px] leading-none transition-colors hover:text-danger lg:h-auto lg:w-auto lg:px-0.5 ${
          active ? 'text-ink-faint' : 'text-ink-faint/0 group-hover:text-ink-faint pointer-coarse:text-ink-faint'
        }`}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
