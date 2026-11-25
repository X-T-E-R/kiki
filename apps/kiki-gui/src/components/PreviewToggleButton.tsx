import { useEffect, useMemo, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import {
  resolvePluginLocalizedText,
  selectComposerToolbarSlots,
  type PluginComposerToolbarSlotContribution,
} from '@kiki/session-core';

import { useI18n } from '../i18n';
import { floatingSurfaceZIndex, registerOverlay } from '../lib/uiBusy';
import { Icon, resolvePluginSlotIconName, Spinner } from './icons';
import { useMediaPreview } from './mediaPreviewContext';
import { useExecutePluginSlotAction, usePluginGuiSlots } from './plugins/PluginComposerSlots';
import { FOCUS_RING } from './rail-variants/shell';
import { POPOVER_SURFACE_CLASS } from './SearchableSelect';

const INLINE_MAX = 4;
const INLINE_OVERFLOW_KEEP = 3;
const COMPACT_FOLD_HEADER_WIDTH = 460;

export function WorkspacePanelsControl({
  className,
  sessionId,
  workspaceId,
}: {
  className?: string;
  sessionId?: string;
  workspaceId?: string;
}) {
  const { t, locale } = useI18n();
  const preview = useMediaPreview();
  const [menuOpen, setMenuOpen] = useState(false);
  const [headerWidth, setHeaderWidth] = useState<number | null>(null);
  const [panelQuery, setPanelQuery] = useState('');
  const anchorRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!menuOpen) {
      setPanelQuery('');
      return;
    }
    return registerOverlay('workspace-panels');
  }, [menuOpen]);
  const { slots } = usePluginGuiSlots({ sessionId, workspaceId });
  const { execute, busyKey } = useExecutePluginSlotAction();

  const panelSlots = useMemo(
    () =>
      selectComposerToolbarSlots(slots).filter(
        (slot) => slot.action.kind === 'open_plugin_panel',
      ),
    [slots],
  );
  const activePluginIds = useMemo(() => {
    const ids = new Set<string>();
    for (const slot of slots) {
      if (slot.slot === 'status-capsule') ids.add(slot.pluginId);
    }
    return ids;
  }, [slots]);

  const tabCount = preview?.previewTabCount ?? 0;
  const hasVisibleControls = tabCount > 0 || panelSlots.length > 0;

  useEffect(() => {
    if (!hasVisibleControls) return;
    const node = anchorRef.current;
    if (node === null || typeof ResizeObserver === 'undefined') return;
    const target = node.closest('header') ?? node.parentElement;
    if (target === null) return;
    const sync = () => {
      const next = target.getBoundingClientRect().width || target.clientWidth;
      if (next > 0) setHeaderWidth((prev) => (prev === next ? prev : next));
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(target);
    return () => { observer.disconnect(); };
  }, [hasVisibleControls]);

  if (!hasVisibleControls) return null;

  const panelsLabel = t('preview.panels.title');
  const compactFold = headerWidth !== null && headerWidth < COMPACT_FOLD_HEADER_WIDTH;
  const hasOverflow = compactFold ? panelSlots.length > 0 : panelSlots.length > INLINE_MAX;
  const inlineSlots = compactFold ? [] : (hasOverflow ? panelSlots.slice(0, INLINE_OVERFLOW_KEEP) : panelSlots);
  const overflowSlots = compactFold ? panelSlots : (hasOverflow ? panelSlots.slice(INLINE_OVERFLOW_KEEP) : []);
  const overflowHasActive = overflowSlots.some((slot) => {
    if (activePluginIds.has(slot.pluginId)) return true;
    const panelIdHint = slot.action.kind === 'open_plugin_panel' ? slot.action.panelId : undefined;
    return (
      panelIdHint !== undefined &&
      preview?.previewPanelOpen === true &&
      preview.activePluginPanelKey === `${slot.pluginId}:${panelIdHint}`
    );
  });
  const labelExpandAt = inlineSlots.length >= 4 ? '880' : inlineSlots.length === 3 ? '800' : '680';
  const btnExpandClass =
    labelExpandAt === '880'
      ? '@[880px]/center:w-auto @[880px]/center:px-2'
      : labelExpandAt === '800'
        ? '@[800px]/center:w-auto @[800px]/center:px-2'
        : '@[680px]/center:w-auto @[680px]/center:px-2';
  const textExpandClass =
    labelExpandAt === '880'
      ? '@[880px]/center:inline'
      : labelExpandAt === '800'
        ? '@[800px]/center:inline'
        : '@[680px]/center:inline';
  const dotExpandClass =
    labelExpandAt === '880'
      ? '@[880px]/center:static @[880px]/center:ring-0'
      : labelExpandAt === '800'
        ? '@[800px]/center:static @[800px]/center:ring-0'
        : '@[680px]/center:static @[680px]/center:ring-0';
  const panelSearchNeedles = panelQuery.trim().toLowerCase().split(/\s+/).filter((part) => part !== '');
  const filteringPanels = panelSearchNeedles.length > 0;
  const popoverSlots = filteringPanels
    ? panelSlots.filter((slot) => {
        const label = resolvePluginLocalizedText(slot.label, locale);
        const tooltip = slot.tooltip === undefined ? '' : resolvePluginLocalizedText(slot.tooltip, locale);
        const panelIdHint = slot.action.kind === 'open_plugin_panel' ? slot.action.panelId : '';
        const haystack = [
          label,
          slot.label.default,
          slot.label.zh ?? '',
          tooltip,
          slot.pluginId,
          slot.id,
          panelIdHint,
        ].join('\n').toLowerCase();
        return panelSearchNeedles.every((needle) => haystack.includes(needle));
      })
    : overflowSlots;

  const activatePanelSlot = (slot: PluginComposerToolbarSlotContribution, key: string, label: string, isPanelActive: boolean) => {
    setMenuOpen(false);
    if (isPanelActive && preview !== null) {
      preview.togglePreviewPanel();
      return;
    }
    void execute(
      {
        pluginId: slot.pluginId,
        label,
        action: slot.action,
        sessionId,
        workspaceId,
      },
      key,
    );
  };

  const renderSlotMeta = (slot: PluginComposerToolbarSlotContribution) => {
    const key = `${slot.pluginId}:${slot.id}`;
    const label = resolvePluginLocalizedText(slot.label, locale);
    const tooltip = slot.tooltip === undefined ? label : resolvePluginLocalizedText(slot.tooltip, locale);
    const isBusy = busyKey === key;
    const explicitIcon = (slot as { readonly icon?: string }).icon;
    const panelIdHint = slot.action.kind === 'open_plugin_panel' ? slot.action.panelId : undefined;
    const iconName = resolvePluginSlotIconName({
      icon: explicitIcon,
      pluginId: slot.pluginId,
      panelId: panelIdHint,
      fallback: 'plugin',
    });
    const panelKey = panelIdHint === undefined ? undefined : `${slot.pluginId}:${panelIdHint}`;
    const isPanelActive =
      panelKey !== undefined &&
      preview?.previewPanelOpen === true &&
      preview.activePluginPanelKey === panelKey;
    const hasActiveCapsule = activePluginIds.has(slot.pluginId);
    return { key, label, tooltip, isBusy, iconName, isPanelActive, hasActiveCapsule };
  };

  const overflowMenu = overflowSlots.length > 0 ? (
    <Popover.Root
      open={menuOpen}
      onOpenChange={(nextOpen, details) => {
        if (!nextOpen && details.reason === 'escape-key' && panelQuery !== '') {
          details.cancel();
          setPanelQuery('');
          searchInputRef.current?.focus();
          return;
        }
        setMenuOpen(nextOpen);
      }}
    >
      <Popover.Trigger
        type="button"
        data-workspace-panels-trigger=""
        title={panelsLabel}
        aria-label={panelsLabel}
        className="relative flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-ink-faint transition-colors duration-[var(--kiki-motion-quick)] hover:bg-canvas hover:text-ink aria-expanded:bg-canvas aria-expanded:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink lg:h-8 lg:w-8"
      >
        <Icon name={compactFold ? 'plugin' : 'more'} size={16} className="h-[15px] w-[15px]" />
        {overflowHasActive ? (
          <span
            data-workspace-panels-active=""
            aria-hidden
            className="pointer-events-none absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-ink-soft ring-1 ring-paper"
          />
        ) : null}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          positionMethod="fixed"
          style={{ zIndex: floatingSurfaceZIndex(anchorRef.current) }}
          className="outline-none"
        >
          <Popover.Popup
            data-workspace-panels-popover=""
            aria-label={panelsLabel}
            className={`anim-enter flex w-60 max-h-[min(22rem,var(--available-height,60vh))] flex-col p-1 outline-none ${POPOVER_SURFACE_CLASS}`}
          >
            <p className="px-2.5 py-1 text-[11px] font-normal text-ink-faint">{panelsLabel}</p>
            <label className="relative mx-1.5 mb-1 block">
              <span className="sr-only">{t('preview.panels.search')}</span>
              <Icon name="search" size={12} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-ink-faint" />
              <input
                ref={searchInputRef}
                type="search"
                data-workspace-panels-search=""
                value={panelQuery}
                onChange={(event) => { setPanelQuery(event.target.value); }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && panelQuery !== '') {
                    event.preventDefault();
                    event.stopPropagation();
                    setPanelQuery('');
                    return;
                  }
                  if (event.key === 'Enter' && filteringPanels && popoverSlots.length > 0) {
                    event.preventDefault();
                    const first = popoverSlots[0]!;
                    const meta = renderSlotMeta(first);
                    if (!meta.isBusy) activatePanelSlot(first, meta.key, meta.label, meta.isPanelActive);
                  }
                }}
                placeholder={t('preview.panels.search')}
                className="h-7 w-full rounded-md border border-hairline bg-transparent pr-6 pl-6 text-[12px] text-ink placeholder:text-ink-faint transition-colors hover:border-hairline-strong focus:border-hairline-strong focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-selected-ink [&::-webkit-search-cancel-button]:hidden"
              />
              {panelQuery !== '' ? (
                <button
                  type="button"
                  data-workspace-panels-search-clear=""
                  aria-label={t('inspector.cap.clearSearch')}
                  onClick={() => { setPanelQuery(''); searchInputRef.current?.focus(); }}
                  className={`absolute top-1/2 right-1 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-ink-faint transition-colors hover:text-ink ${FOCUS_RING}`}
                >
                  <Icon name="close" size={12} />
                </button>
              ) : null}
            </label>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {popoverSlots.length === 0 ? (
                <p data-workspace-panels-empty="" className="px-2.5 py-2 text-[12px] text-ink-faint">
                  {t('preview.panels.empty')}
                </p>
              ) : popoverSlots.map((slot) => {
                const { key, label, tooltip, isBusy, iconName, isPanelActive, hasActiveCapsule } = renderSlotMeta(slot);
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={isBusy}
                    title={tooltip}
                    aria-pressed={isPanelActive}
                    data-workspace-panel-item={key}
                    data-plugin-composer-slot={key}
                    onClick={() => { activatePanelSlot(slot, key, label, isPanelActive); }}
                    className={`flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-[13px] transition-colors hover:bg-paper focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-10 ${
                      isPanelActive ? 'bg-canvas text-ink' : 'text-ink'
                    }`}
                  >
                    {isBusy ? (
                      <Spinner label={label} />
                    ) : (
                      <Icon name={iconName} size={14} className="shrink-0 text-ink-soft" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    {hasActiveCapsule ? (
                      <span
                        data-workspace-panel-active={slot.pluginId}
                        aria-hidden
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink-soft"
                      />
                    ) : null}
                    {slot.badgeText !== undefined && slot.badgeText !== '' ? (
                      <span className="shrink-0 font-mono text-[11px] text-ink-faint tabular-nums">
                        {slot.badgeText}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  ) : null;

  return (
    <div
      ref={anchorRef}
      className={`inline-flex shrink-0 items-center gap-0.5 ${className ?? ''}`}
      data-workspace-panels-group=""
    >
      {inlineSlots.map((slot) => {
        const { key, label, tooltip, isBusy, iconName, isPanelActive, hasActiveCapsule } = renderSlotMeta(slot);
        return (
          <button
            key={key}
            type="button"
            disabled={isBusy}
            title={tooltip}
            aria-label={label}
            aria-pressed={isPanelActive}
            data-workspace-panel-item={key}
            data-plugin-composer-slot={key}
            onClick={() => { activatePanelSlot(slot, key, label, isPanelActive); }}
            className={`relative flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg text-[12.5px] transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-50 lg:h-8 lg:w-8 ${btnExpandClass} ${
              isPanelActive
                ? 'bg-canvas text-ink'
                : 'text-ink-faint hover:bg-canvas hover:text-ink'
            }`}
          >
            {isBusy ? (
              <Spinner label={label} />
            ) : (
              <Icon name={iconName} size={16} className="h-[15px] w-[15px] shrink-0" />
            )}
            <span className={`hidden max-w-[4.5rem] truncate text-[12.5px] leading-none ${textExpandClass}`}>{label}</span>
            {hasActiveCapsule ? (
              <span
                data-workspace-panel-active={slot.pluginId}
                aria-hidden
                className={`pointer-events-none absolute top-1 right-1 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-soft ring-1 ${isPanelActive ? 'ring-canvas' : 'ring-paper'} ${dotExpandClass}`}
              />
            ) : null}
          </button>
        );
      })}
      {overflowMenu}
      {tabCount > 0 && panelSlots.length > 0 ? (
        <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-hairline" />
      ) : null}
      {tabCount > 0 ? (
        <button
          type="button"
          onClick={preview!.togglePreviewPanel}
          title={t('preview.toggleAria')}
          aria-label={t('preview.toggleAria')}
          aria-expanded={preview!.previewPanelOpen}
          data-preview-toggle
          className={`flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-0 text-[12.5px] transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink lg:h-8 lg:w-8 @[620px]/center:w-auto @[620px]/center:px-2.5 ${
            preview!.previewPanelOpen
              ? 'bg-canvas text-ink'
              : 'text-ink-faint hover:bg-canvas hover:text-ink'
          }`}
        >
          <svg aria-hidden viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" className="h-[14px] w-[14px] shrink-0">
            <path d="M4.5 2.5h4.8l2.7 2.7v7.3a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" />
            <path d="M9 2.5v3h3" />
          </svg>
          <span className="hidden @[620px]/center:inline">{t('preview.toggle')}</span>
        </button>
      ) : null}
    </div>
  );
}

/** Header toggle for the preview workspace & plugin panels. */
export const PreviewToggleButton = WorkspacePanelsControl;
