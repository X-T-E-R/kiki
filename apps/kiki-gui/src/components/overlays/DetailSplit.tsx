/**
 * DetailSplit — the in-page detail tier of the surface ladder (README.md):
 * editing an existing object picked from a list. No scrim, no modal. The
 * detail replaces the full list in the page; on md+ the list stays usable as
 * a slim rail beside it, below md the detail is a single pane with Back.
 *
 *   const detail = useDetailParam('agent');
 *   <DetailSplit
 *     selected={detail.selected === null ? null : row?.key ?? null}
 *     label={t('st.profiles.team')}
 *     list={<TeamView … onOpen={(row) => detail.open(row.param)} />}
 *     rail={<DetailRail …>{rows.map((row) => <DetailRailItem key=… itemKey=… />)}</DetailRail>}
 *     detail={<Editor … header={<DetailBack label=… onClick={detail.close} />} />}
 *   />
 *
 * Contract a worker must keep:
 * - Every element that opens a detail carries `data-detail-trigger={key}`;
 *   closing returns focus there. The detail's title carries
 *   `data-detail-heading` (tabIndex -1); opening moves focus to it.
 * - The full list stays mounted (hidden) while a detail is open, so its
 *   search text, folds and scroll survive the round trip.
 * - The split marks itself `data-detail-split="open"`; the settings page
 *   widens its column for it (SettingsPage: `has-[[data-detail-split=open]]`).
 * - Dirty guarding is not done here. The editor reports through
 *   `useDirtyReporter`; `useDetailParam` routes every switch and close
 *   through the guarded navigator, which owns the one prompt.
 */

import { useEffect, useRef, type ReactNode } from 'react';

import { Icon } from '../icons';

export function DetailSplit({ selected, list, rail, detail, label, data }: {
  /** Key of the open item, or null for the full list. */
  selected: string | null;
  /** The full list (table, cards). Hidden, still mounted, while a detail is open. */
  list: ReactNode;
  /** The slim md+ list beside an open detail. Omit to give the detail the full width. */
  rail?: ReactNode;
  /** The open item's editor; rendered only while `selected` is set. */
  detail: ReactNode;
  /** Accessible name of the list region (the rail's landmark). */
  label: string;
  data?: Record<`data-${string}`, string>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const previous = useRef<string | null>(selected);
  useEffect(() => {
    const before = previous.current;
    previous.current = selected;
    if (before === selected) return;
    const root = rootRef.current;
    if (root === null) return;
    // After the swap paints, so the target exists and is visible.
    const frame = requestAnimationFrame(() => {
      if (selected !== null) {
        root.querySelector<HTMLElement>('[data-detail-pane] [data-detail-heading]')?.focus({ preventScroll: true });
        // Bring the whole surface in from its card's title, so the rail and
        // the detail header start together with nothing clipped above them.
        const scroller = root.closest<HTMLElement>('[data-settings-scroll]');
        if (scroller === null) {
          const target = root.closest<HTMLElement>('[id^="st-card-"]') ?? root;
          target.scrollIntoView?.({ block: 'start' });
        } else {
          // Always land the pane's header in view, below any sticky toolbar in
          // the card above it: an opened split can sit far below the fold or
          // start above it, and the card's own edge answers neither.
          const delta = root.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
          scroller.scrollTop += delta - 56;
        }
        return;
      }
      if (before === null) return;
      const trigger = [...root.querySelectorAll<HTMLElement>('[data-detail-list] [data-detail-trigger]')]
        .find((node) => node.dataset['detailTrigger'] === before);
      trigger?.focus({ preventScroll: true });
      trigger?.scrollIntoView?.({ block: 'nearest' });
    });
    return () => { cancelAnimationFrame(frame); };
  }, [selected]);

  const open = selected !== null;
  return <div ref={rootRef} data-detail-split={open ? 'open' : 'closed'} {...data}
    className={`min-w-0 ${open && rail !== undefined ? 'md:grid md:grid-cols-[13.5rem_minmax(0,1fr)] md:gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]' : ''}`}>
    <div data-detail-list hidden={open} className="min-w-0">{list}</div>
    {open && rail !== undefined ? (
      <nav aria-label={label} data-detail-rail
        className="hidden min-w-0 md:block md:sticky md:top-0 md:max-h-[calc(100dvh-10rem)] md:self-start md:overflow-y-auto md:overscroll-contain md:border-r md:border-hairline md:pr-3">
        {rail}
      </nav>
    ) : null}
    {open ? <section data-detail-pane className="@container detail-pane-enter min-w-0">{detail}</section> : null}
  </div>;
}

/** The Back control at the head of a detail: returns to the full list. */
export function DetailBack({ label, onClick, data }: {
  /** The list's name ("智能体", "模型"); visible on md+, screen-reader only below. */
  label: string;
  onClick: () => void;
  data?: Record<`data-${string}`, string>;
}) {
  return <button type="button" onClick={onClick} {...data} data-detail-back
    className="-ml-1.5 inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md px-1.5 text-[13px] text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:min-h-11">
    <Icon name="arrowLeft" size={14} /><span>{label}</span>
  </button>;
}

/** A quiet group label inside the rail (主智能体 / 助手). */
export function DetailRailGroup({ label, count, children }: { label: string; count?: number; children: ReactNode }) {
  return <div className="mb-3 last:mb-0" data-detail-rail-group={label}>
    <p className="flex items-baseline gap-1.5 px-2 pb-1 pt-1 text-[11.5px] font-medium text-ink-faint">
      <span className="min-w-0 truncate">{label}</span>
      {count !== undefined ? <span className="tabular-nums">{count}</span> : null}
    </p>
    <ul className="space-y-px">{children}</ul>
  </div>;
}

/** One row of the rail: the name, an optional trailing mark, current state. */
export function DetailRailItem({ itemKey, label, hint, current, muted = false, trailing, onSelect }: {
  itemKey: string;
  label: ReactNode;
  /** A second quiet line (an id, a provider). Keep it short. */
  hint?: ReactNode;
  current: boolean;
  muted?: boolean;
  trailing?: ReactNode;
  onSelect: () => void;
}) {
  return <li>
    <button type="button" data-detail-rail-item={itemKey} aria-current={current ? 'page' : undefined} onClick={onSelect}
      className={`flex min-h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-selected-ink/40 pointer-coarse:min-h-11 ${
        current ? 'bg-ink/[0.06] font-medium text-ink' : muted ? 'text-ink-faint hover:bg-ink/[0.03]' : 'text-ink-soft hover:bg-ink/[0.03] hover:text-ink'}`}>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {hint !== undefined ? <span className="block truncate font-mono text-[11px] font-normal text-ink-faint">{hint}</span> : null}
      </span>
      {trailing}
    </button>
  </li>;
}
