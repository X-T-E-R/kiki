/**
 * DiscoveryTourTag — header paper tag / mini-guide for the active discovery station.
 *
 * Implements paper-ink visual aesthetics:
 * - Clear station label, route title, and progress [station / total].
 * - Real try action (anchor focus, draft prefill, or local example).
 * - Leave, resume, change route, skip, finish controls.
 * - Collapsible state that tucks away without obscuring the composer or inputs.
 * - Keyboard listeners for rapid navigation without taking over form inputs.
 */

import { useCallback, useEffect, useState } from 'react';

import { discoveryStation } from '@kiki/session-core/discovery';
import { useI18n } from '../../i18n';
import { useMediaQuery } from '../../lib/layoutHooks';
import { Icon } from '../icons';
import { useDiscovery } from './DiscoveryContext';
import { useGuardedNavigate } from '../dirtyGuard';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { DiscoveryExampleModal } from './DiscoveryExampleModal';

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
    showingExample,
    setShowingExample,
  } = useDiscovery();

  /**
   * A 380px guide has nowhere to stand in a narrow window, so at that width the
   * tag yields to the bookmark and waits to be asked — the expand control still
   * opens it, and a wider window goes back to the stored preference. This is
   * the "give way at narrow widths" half of the guide's own contract; Escape and
   * the collapse control both fold it again on the way.
   */
  const narrow = useMediaQuery('(max-width: 640px)');
  const [narrowExpanded, setNarrowExpanded] = useState(false);
  const collapsed = narrow ? !narrowExpanded : view.collapsed;
  const setCollapsed = useCallback((next: boolean) => {
    if (narrow) setNarrowExpanded(!next);
    else collapseDiscovery(next);
  }, [narrow, collapseDiscovery]);

  /**
   * On a narrow window the expanded guide stands over the top of the page —
   * exactly where the control a stop points at tends to live. An action that
   * points at a control on this page folds the guide back to its bookmark
   * first, so the thing it just opened is what is left in view.
   */
  const runAction = (action: (typeof view.actions)[number]) => {
    if (narrow && action.kind === 'anchor') setNarrowExpanded(false);
    void performAction(action.id);
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
    return (
      <>
        {showingExample !== null ? (
          <DiscoveryExampleModal exampleId={showingExample} onClose={() => { setShowingExample(null); }} />
        ) : null}
      </>
    );
  }

  const isLastStation = view.position === view.total;
  const nextStationId = view.route.stations[view.position]; // position is 1-indexed
  const nextStationName = nextStationId !== undefined ? t(discoveryStation(nextStationId).titleKey) : '';

  // Collapsed mode: mini bookmark pinned to the header/corner
  if (collapsed) {
    return (
      <>
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
        {showingExample !== null ? (
          <DiscoveryExampleModal exampleId={showingExample} onClose={() => { setShowingExample(null); }} />
        ) : null}
      </>
    );
  }

  // Expanded paper guide tag
  return (
    <>
      <aside
        data-discovery-tour-tag="expanded"
        aria-label={t('discovery.title')}
        className="fixed top-3 right-4 z-40 w-full max-w-[min(380px,calc(100vw_-_1.5rem))] rounded-xl border border-hairline bg-paper p-4 text-ink shadow-[0_8px_30px_rgb(var(--kiki-shadow-ink)/0.12)] transition-all duration-200"
      >
        {/* Header: route name, station progress, and dismiss/collapse controls */}
        <div className="flex items-center justify-between gap-2 border-b border-hairline pb-2.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-accent">
              <Icon name="compass" size={14} />
            </span>
            <span className="truncate text-[12px] font-semibold tracking-tight text-ink">
              {t(view.route.titleKey)}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-ink-faint">
              ({view.position}/{view.total})
            </span>
          </div>

          <div className="flex items-center gap-1">
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
              title={t('discovery.leave')}
              aria-label={t('discovery.leave')}
              className="flex h-6 w-6 items-center justify-center rounded text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        </div>

        {/* Station Content */}
        <div className="mt-2.5">
          <h4 className="font-display text-[14px] font-semibold text-ink">
            {t(view.station.titleKey)}
          </h4>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
            {t(view.station.bodyKey)}
          </p>
        </div>

        {/* One real try action leads the stop; anything else stays a quiet
            second, so the stop reads as one thing to do rather than a menu.
            It is outlined in ink, not accent: Next is the guide's one primary,
            and the page under it may already carry its own. */}
        {view.actions.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5" data-discovery-actions>
            {view.actions.slice(0, 1).map((action) => (
              <button
                key={action.id}
                type="button"
                data-discovery-action={action.id}
                onClick={() => { runAction(action); }}
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
            {view.actions.slice(1).map((action) => (
              <button
                key={action.id}
                type="button"
                data-discovery-action={action.id}
                onClick={() => { runAction(action); }}
                className="text-[12px] text-ink-soft underline decoration-hairline-strong underline-offset-2 transition-colors hover:text-ink"
              >
                {t(action.labelKey)}
              </button>
            ))}
          </div>
        ) : null}

        {/* Controls footer */}
        <div className="mt-3.5 flex flex-wrap items-center justify-between gap-1.5 border-t border-hairline pt-2.5">
          <div className="flex items-center gap-1">
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
          </div>

          <button
            type="button"
            data-discovery-nav="next"
            onClick={() => { void nextStation(); }}
            className={`${PRIMARY_BUTTON} h-7 py-0 text-[12px]`}
          >
            {isLastStation
              ? t('discovery.finish')
              : t('discovery.next', { name: nextStationName })}
          </button>
        </div>
      </aside>

      {showingExample !== null ? (
        <DiscoveryExampleModal exampleId={showingExample} onClose={() => { setShowingExample(null); }} />
      ) : null}
    </>
  );
}
