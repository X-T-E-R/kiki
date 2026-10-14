/**
 * DiscoveryTourTag — spotlight overlay and anchored popover for active discovery stations.
 *
 * Implements:
 * - Real-time spotlight overlay tracking anchor element rect with rounded breathing ring.
 * - Anchored callout popover positioned dynamically near the anchor, falling back to top-right.
 * - Direct action execution without fake example modals.
 * - Collapsible state, resume banner, and compact keyboard controls (Alt+Shift+G / Escape).
 */

import { useCallback, useEffect, useState } from 'react';

import { discoveryStation } from '@kiki/session-core/discovery';
import { useI18n } from '../../i18n';
import { useMediaQuery } from '../../lib/layoutHooks';
import { Icon } from '../icons';
import { resolveAnchorElement, useDiscovery } from './DiscoveryContext';
import { useGuardedNavigate } from '../dirtyGuard';
import { PRIMARY_BUTTON } from '../ui';

export function DiscoveryTourTag() {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const {
    state,
    view,
    nextStation,
    previousStation,
    skipStation,
    leaveDiscovery,
    resumeDiscovery,
    collapseDiscovery,
    performAction,
  } = useDiscovery();

  const narrow = useMediaQuery('(max-width: 640px)');
  const [narrowExpanded, setNarrowExpanded] = useState(false);
  const collapsed = narrow ? !narrowExpanded : view.collapsed;
  const setCollapsed = useCallback((next: boolean) => {
    if (narrow) setNarrowExpanded(!next);
    else collapseDiscovery(next);
  }, [narrow, collapseDiscovery]);

  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  // Monitor anchor element position for live spotlight highlighting and popover docking
  useEffect(() => {
    if (state.lifecycle !== 'active' || !view.visible || !view.station?.anchor) {
      setAnchorRect(null);
      return;
    }

    const updateRect = () => {
      const anchor = view.station?.anchor;
      const el = anchor ? resolveAnchorElement(anchor) : null;
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          setAnchorRect(rect);
          return;
        }
      }
      setAnchorRect(null);
    };

    updateRect();
    window.addEventListener('resize', updateRect);
    window.addEventListener('scroll', updateRect, true);
    return () => {
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
    };
  }, [state.lifecycle, view.visible, view.station?.id, view.station?.anchor]);

  const runAction = (actionId: Parameters<typeof performAction>[0]) => {
    if (narrow) setNarrowExpanded(false);
    void performAction(actionId);
  };

  // Keyboard navigation when not focused on an input
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (state.lifecycle !== 'active' || !view.visible) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]') !== null)
    ) {
      return;
    }

    if (event.key === 'Escape') {
      if (!collapsed) {
        event.preventDefault();
        setCollapsed(true);
      }
    } else if (event.altKey && event.shiftKey && (event.key === 'G' || event.key === 'g')) {
      event.preventDefault();
      setCollapsed(!collapsed);
    }
  }, [state.lifecycle, view.visible, collapsed, setCollapsed]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => { window.removeEventListener('keydown', handleKeyDown); };
  }, [handleKeyDown]);

  // If left but resumable, show a quiet resume paper tag
  if (state.lifecycle === 'left' && view.resume) {
    return (
      <div
        data-discovery-resume-tag
        className="fixed top-3 right-4 z-40 flex max-w-[calc(100vw_-_1.5rem)] items-center gap-2 rounded-lg border border-hairline bg-paper/95 px-3 py-1.5 shadow-[var(--kiki-sheet-shadow)] backdrop-blur-sm transition-all"
      >
        <span className="min-w-0 truncate text-[12px] font-medium text-ink-soft">
          {t('discovery.title')} · {view.route ? t(view.route.titleKey) : ''}
        </span>
        <button
          type="button"
          onClick={() => { void resumeDiscovery(); }}
          className="shrink-0 rounded-md bg-accent-soft px-2 py-0.5 text-[12px] font-medium text-accent-ink hover:bg-accent-soft/80"
        >
          {t('discovery.continue')}
        </button>
      </div>
    );
  }

  // Only render active tour tag when on the target station page
  if (state.lifecycle !== 'active' || !view.visible || view.station === undefined || view.route === undefined) {
    return null;
  }

  const isLastStation = view.position === view.total;
  const nextStationId = view.route.stations[view.position]; // position is 1-indexed
  const nextStationName = nextStationId !== undefined ? t(discoveryStation(nextStationId).titleKey) : '';

  // Collapsed mode: mini bookmark pinned to the header/corner
  if (collapsed) {
    return (
      <div
        data-discovery-tour-tag="collapsed"
        className="fixed top-2.5 right-4 z-40 flex max-w-[calc(100vw_-_1.5rem)] items-center gap-2 rounded-lg border border-hairline bg-paper/95 px-2.5 py-1 text-ink shadow-[var(--kiki-sheet-shadow)] backdrop-blur-sm transition-transform"
      >
        <Icon name="compass" size={14} className="shrink-0 text-accent" />
        <span className="min-w-0 truncate text-[12px] font-medium text-ink">
          {t(view.route.titleKey)}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-ink-faint">
          {view.position}/{view.total}
        </span>
        <button
          type="button"
          data-discovery-expand
          onClick={() => { setCollapsed(false); }}
          aria-label={t('discovery.expand')}
          className="flex h-5 w-5 items-center justify-center rounded text-ink-soft hover:bg-ink/[0.05] hover:text-ink"
        >
          <Icon name="expand" size={12} />
        </button>
      </div>
    );
  }

  // Compute anchored popover positioning
  const hasValidRect = anchorRect !== null && anchorRect.width > 0 && anchorRect.height > 0;
  let popoverStyle: React.CSSProperties | undefined = undefined;

  if (hasValidRect && typeof window !== 'undefined') {
    const popoverWidth = Math.min(380, Math.max(280, window.innerWidth - 32));
    const popoverEstimatedHeight = 220;
    const spaceBelow = window.innerHeight - (anchorRect.bottom + 12);

    let top: number;
    if (spaceBelow >= popoverEstimatedHeight || anchorRect.top < popoverEstimatedHeight) {
      top = anchorRect.bottom + 12;
    } else {
      top = Math.max(16, anchorRect.top - popoverEstimatedHeight - 12);
    }

    const left = Math.max(16, Math.min(anchorRect.left, window.innerWidth - popoverWidth - 16));

    popoverStyle = {
      position: 'fixed',
      top: `${Math.round(top)}px`,
      left: `${Math.round(left)}px`,
      width: `${Math.round(popoverWidth)}px`,
      zIndex: 50,
    };
  }

  return (
    <>
      {/* Spotlight Overlay: Highlighting the active interface element */}
      {hasValidRect ? (
        <div
          data-discovery-spotlight={view.station.anchor}
          className="pointer-events-none fixed inset-0 z-40 overflow-hidden"
          aria-hidden="true"
        >
          <div
            style={{
              position: 'absolute',
              top: Math.max(0, anchorRect.top - 6),
              left: Math.max(0, anchorRect.left - 6),
              width: anchorRect.width + 12,
              height: anchorRect.height + 12,
            }}
            className="rounded-[var(--radius-card)] ring-2 ring-accent shadow-[0_0_0_9999px_rgba(0,0,0,0.28)] transition-all duration-200 animate-pulse"
          />
        </div>
      ) : null}

      {/* Anchored Callout Popover */}
      <aside
        data-discovery-tour-tag="expanded"
        aria-label={t('discovery.title')}
        style={popoverStyle}
        className={`${
          popoverStyle ? '' : 'fixed top-14 right-4 z-50 w-full max-w-[min(380px,calc(100vw_-_1.5rem))]'
        } rounded-xl border border-hairline bg-paper p-4 text-ink shadow-[0_12px_36px_rgb(var(--kiki-shadow-ink)/0.18)] transition-all duration-200`}
      >
        {/* Top Header: Step badge, route name, collapse and leave */}
        <div className="flex items-center justify-between gap-2 border-b border-hairline pb-2.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              data-discovery-step-badge
              className="inline-flex items-center rounded-full bg-accent/15 px-2 py-0.5 font-mono text-[11px] font-medium text-accent"
            >
              {view.position} / {view.total}
            </span>
            <span className="truncate text-[12px] font-semibold tracking-tight text-ink">
              {t(view.route.titleKey)}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              data-discovery-collapse
              onClick={() => { setCollapsed(true); }}
              title={t('discovery.collapse')}
              aria-label={t('discovery.collapse')}
              className="flex h-6 w-6 items-center justify-center rounded text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink"
            >
              <Icon name="collapse" size={12} />
            </button>
            <button
              type="button"
              data-discovery-leave
              onClick={leaveDiscovery}
              title={t('discovery.tour.exitEsc')}
              aria-label={t('discovery.tour.exitEsc')}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink"
            >
              <span>{t('discovery.tour.exitEsc')}</span>
            </button>
          </div>
        </div>

        {/* Station Main Content */}
        <div className="mt-2.5">
          <h4 className="font-display text-[14px] font-semibold text-ink">
            {t(view.station.titleKey)}
          </h4>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
            {t(view.station.bodyKey)}
          </p>
        </div>

        {/* Real Interface Actions */}
        {view.actions.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5" data-discovery-actions>
            {view.actions.map((action) => (
              <button
                key={action.id}
                type="button"
                data-discovery-action={action.id}
                onClick={() => { runAction(action.id); }}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline-strong bg-paper px-2.5 text-[12px] font-medium text-ink transition-colors hover:border-selected-ink/50 hover:bg-ink/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40"
              >
                <span>{t(action.labelKey)}</span>
                {view.progress?.tried ? (
                  <span className="rounded bg-ink/[0.06] px-1 py-px text-[10px] font-normal text-ink-soft">
                    {t('discovery.tried')}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}

        {/* Footer Navigation Bar */}
        <div className="mt-3.5 flex flex-wrap items-center justify-between gap-1.5 border-t border-hairline pt-2.5">
          {/* Progress dots indicator */}
          <div
            className="flex items-center gap-1"
            data-discovery-progress-dots
            aria-label={`Progress: ${view.position} of ${view.total}`}
          >
            {Array.from({ length: view.total }, (_, i) => {
              const stepNum = i + 1;
              const active = stepNum === view.position;
              const passed = stepNum < view.position;
              return (
                <span
                  key={i}
                  className={`h-1.5 rounded-full transition-all ${
                    active ? 'w-3.5 bg-accent' : passed ? 'w-1.5 bg-accent/50' : 'w-1.5 bg-hairline-strong'
                  }`}
                  title={`Stop ${stepNum}`}
                />
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            {view.canPrevious ? (
              <button
                type="button"
                data-discovery-nav="previous"
                onClick={() => { void previousStation(); }}
                className="text-[12px] text-ink-soft hover:text-ink"
              >
                {t('discovery.previous')}
              </button>
            ) : (
              <button
                type="button"
                data-discovery-nav="routes"
                onClick={() => { navigate('/discover'); }}
                className="text-[12px] text-ink-soft hover:text-ink"
              >
                {t('discovery.routes')}
              </button>
            )}
            <span className="text-ink-faint">·</span>
            <button
              type="button"
              data-discovery-nav="skip"
              onClick={() => { void skipStation(); }}
              className="text-[12px] text-ink-soft hover:text-ink"
            >
              {t('discovery.skip')}
            </button>
            <button
              type="button"
              data-discovery-nav="next"
              onClick={() => { void nextStation(); }}
              className={`${PRIMARY_BUTTON} h-7 py-0 text-[12px]`}
            >
              {isLastStation
                ? t('discovery.finish')
                : t('discovery.tour.nextShort')}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
