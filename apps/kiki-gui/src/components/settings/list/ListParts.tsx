/**
 * The settings list pattern, visible half. One long list reads the same on
 * every page:
 *
 *   ListToolbar   search (with the live "12 of 84" count), filter chips,
 *                 sort and density — one row, sticky at the top of the
 *                 settings pane so it stays in reach while scrolling.
 *   ListBulkBar   replaces nothing; it slides in under the toolbar while
 *                 rows are selected and names the verbs that apply to all.
 *   ListGroup     a foldable group header with its count; the rows follow.
 *   ListBody      the row container (the one bordered surface), windowed
 *                 once the list is long enough for it to matter.
 *   ListEmpty     nothing yet (what it means + how to get some) vs. nothing
 *                 matches (what narrowed it + one way back).
 *
 * Chosen tabs are paper chips lifted off a light ink ground — the same
 * vocabulary as the selected nav row — never an accent fill.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { useI18n } from '../../../i18n';
import { DisclosureChevron, Icon } from '../../icons';
import type { ListDensity, ListFilterSpec, ListSortSpec, ListView } from './listState';

const CHIP = 'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[5px] px-2.5 text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-9';
const CHIP_ON = 'bg-panel font-medium text-ink shadow-[var(--kiki-sheet-shadow)]';
const CHIP_OFF = 'text-ink-soft hover:text-ink';
const ICON_BUTTON = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-9 pointer-coarse:w-9';

/** Row heights per density, shared by the page rows and the windowing estimate. */
export const LIST_ROW_HEIGHT: Record<ListDensity, number> = { comfortable: 56, compact: 36 };

/** Above this many rows a list windows its body; below it every row stays mounted. */
export const VIRTUALIZE_AFTER = 60;

export function ListToolbar<T>({
  view, total, searchLabel, searchPlaceholder, filters = [], sorts = [], showDensity = true, actions,
}: {
  view: ListView<T>;
  /** Items before any narrowing, for the "n of total" count. */
  total: number;
  searchLabel: string;
  searchPlaceholder: string;
  filters?: readonly ListFilterSpec<T>[];
  sorts?: readonly ListSortSpec<T>[];
  showDensity?: boolean;
  /** The page's own verbs (Add …) at the right end. */
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const shown = view.visible.length;
  return (
    <div data-list-toolbar
      className="sticky -top-6 z-[3] -mx-2 flex flex-col gap-2 bg-paper/95 px-2 pt-2 pb-2 backdrop-blur-[6px] lg:-top-8">
      <div className="flex min-w-0 items-center gap-2">
        <label className="relative flex h-8 min-w-0 flex-1 items-center">
          <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 text-ink-faint" />
          <input
            ref={inputRef}
            type="search"
            data-list-search
            aria-label={searchLabel}
            placeholder={searchPlaceholder}
            value={view.query}
            onChange={(event) => { view.setQuery(event.target.value); }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && view.query !== '') {
                event.stopPropagation();
                view.setQuery('');
              }
            }}
            className="h-8 w-full min-w-0 rounded-md bg-ink/[0.04] pr-20 pl-8 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint hover:bg-ink/[0.06] focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)] [&::-webkit-search-cancel-button]:hidden"
          />
          <span data-list-count aria-live="polite"
            className="pointer-events-none absolute right-2.5 text-[12px] text-ink-faint tabular-nums">
            {view.narrowed ? t('st.list.countOf', { shown, total }) : t('st.list.count', { total })}
          </span>
        </label>
        {showDensity ? <DensityToggle density={view.density} onChange={view.setDensity} /> : null}
        {actions}
      </div>
      {filters.length > 0 || sorts.length > 1 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          {filters.length > 0 ? (
            <div role="group" aria-label={t('st.list.filterAria')} data-list-filters
              className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-md bg-ink/[0.04] p-0.5">
              {[{ id: 'all', label: t('st.list.all'), tone: undefined }, ...filters].map((chip) => {
                const on = view.filter === chip.id;
                const count = view.counts[chip.id] ?? 0;
                return (
                  <button key={chip.id} type="button" aria-pressed={on} data-list-filter={chip.id}
                    onClick={() => { view.setFilter(chip.id); }}
                    className={`${CHIP} ${on ? CHIP_ON : CHIP_OFF}`}>
                    {chip.label}
                    <span className={`tabular-nums ${chip.tone === 'attention' && count > 0 ? 'font-medium text-attention' : 'text-ink-faint'}`}>{count}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
          {sorts.length > 1 ? (
            <SortSwitch sorts={sorts} value={view.sort} onChange={view.setSort} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** "Sort: Recent · Name" as quiet text buttons; the chosen one is ink, the rest faint. */
function SortSwitch<T>({ sorts, value, onChange }: { sorts: readonly ListSortSpec<T>[]; value: string; onChange: (id: string) => void }) {
  const { t } = useI18n();
  return (
    <div role="group" aria-label={t('st.list.sortAria')} data-list-sort className="ml-auto flex items-center gap-0.5 text-[12px]">
      <span className="pr-1 text-ink-faint">{t('st.list.sortBy')}</span>
      {sorts.map((spec) => (
        <button key={spec.id} type="button" aria-pressed={spec.id === value} data-list-sort-option={spec.id}
          onClick={() => { onChange(spec.id); }}
          className={`h-7 rounded-md px-1.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${
            spec.id === value ? 'font-medium text-ink' : 'text-ink-faint hover:text-ink'
          }`}>
          {spec.label}
        </button>
      ))}
    </div>
  );
}

function DensityToggle({ density, onChange }: { density: ListDensity; onChange: (density: ListDensity) => void }) {
  const { t } = useI18n();
  const compact = density === 'compact';
  return (
    <button type="button" data-list-density={density} aria-pressed={compact}
      aria-label={t('st.list.compact')} title={compact ? t('st.list.comfortableTitle') : t('st.list.compactTitle')}
      onClick={() => { onChange(compact ? 'comfortable' : 'compact'); }}
      className={`${ICON_BUTTON} ${compact ? 'bg-panel text-ink shadow-[var(--kiki-sheet-shadow)] hover:bg-panel' : ''}`}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
        {compact
          ? <path d="M3 4h10M3 7h10M3 10h10M3 13h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          : <path d="M3 4.5h10M3 8h10M3 11.5h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />}
      </svg>
    </button>
  );
}
/**
 * A foldable group: header (chevron, label, count, optional trailing slot)
 * then its rows. Folded groups keep their header so a long list reads as a
 * table of contents; a search unfolds them (see `useListView.isFolded`).
 */
export function ListGroup({ groupKey, label, count, total, folded, onToggle, trailing, children }: {
  groupKey: string;
  label: ReactNode;
  count: number;
  total: number;
  folded: boolean;
  onToggle: () => void;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const labelText = typeof label === 'string' ? label : groupKey;
  return (
    <section data-list-group={groupKey} data-list-group-folded={folded ? '' : undefined} aria-label={labelText}>
      <div className="flex h-8 items-center gap-2 pr-1">
        <button type="button" aria-expanded={!folded} data-list-group-toggle={groupKey}
          aria-label={folded ? t('sidebar.expandGroup', { label: labelText }) : t('sidebar.collapseGroup', { label: labelText })}
          onClick={onToggle}
          className="-ml-1 flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left text-[12px] font-medium text-section-ink transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink">
          <DisclosureChevron open={!folded} className="text-ink-faint" />
          <span className="min-w-0 truncate">{label}</span>
          <span className="shrink-0 font-normal text-ink-faint tabular-nums">
            {count === total ? count : t('st.list.countOf', { shown: count, total })}
          </span>
        </button>
        {trailing}
      </div>
      {folded ? null : <div className="pb-3">{children}</div>}
    </section>
  );
}

/**
 * The bordered row surface. Short lists render every row; past
 * `VIRTUALIZE_AFTER` only the rows near the viewport mount, measured against
 * the settings pane's own scroller. Rows are fixed height per density so the
 * estimate is exact and scrolling never jumps.
 */
export function ListBody<T>({ items, keyOf, density, renderRow, label, virtualizeAfter = VIRTUALIZE_AFTER }: {
  items: readonly T[];
  keyOf: (item: T) => string;
  density: ListDensity;
  renderRow: (item: T) => ReactNode;
  label: string;
  virtualizeAfter?: number;
}) {
  const windowed = items.length > virtualizeAfter;
  return (
    <div role="list" aria-label={label} data-list-body data-list-density={density} data-list-windowed={windowed ? '' : undefined}
      className="overflow-hidden rounded-lg border border-hairline bg-panel">
      {windowed
        ? <WindowedRows items={items} keyOf={keyOf} density={density} renderRow={renderRow} />
        : items.map((item) => (
          <div role="listitem" key={keyOf(item)} className="border-b border-hairline last:border-b-0">{renderRow(item)}</div>
        ))}
    </div>
  );
}

function WindowedRows<T>({ items, keyOf, density, renderRow }: {
  items: readonly T[];
  keyOf: (item: T) => string;
  density: ListDensity;
  renderRow: (item: T) => ReactNode;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const anchor = anchorRef.current;
    const pane = anchor?.closest<HTMLElement>('[data-settings-scroll]') ?? null;
    setScroller(pane);
    if (anchor === null || pane === null) return;
    // Where the list starts inside the scroller; re-read when anything above it grows.
    const measure = () => {
      setOffset(anchor.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane.firstElementChild ?? pane);
    return () => { observer.disconnect(); };
  }, []);
  const rowHeight = LIST_ROW_HEIGHT[density];
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller,
    estimateSize: () => rowHeight,
    getItemKey: (index) => keyOf(items[index]!),
    overscan: 10,
    scrollMargin: offset,
    initialRect: { width: 720, height: 900 },
    useFlushSync: false,
  });
  return (
    <div ref={anchorRef} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      {virtualizer.getVirtualItems().map((row) => (
        <div role="listitem" key={row.key} data-index={row.index}
          className="absolute inset-x-0 border-b border-hairline"
          style={{ top: row.start - offset, height: rowHeight }}>
          {renderRow(items[row.index]!)}
        </div>
      ))}
    </div>
  );
}

/**
 * Appears while rows are selected: the count, the verbs that apply to all of
 * them, and a way out. Sticky under the toolbar; the destructive verb goes
 * through the page's own confirmation.
 */
export function ListBulkBar({ count, onClear, children }: { count: number; onClear: () => void; children: ReactNode }) {
  const { t } = useI18n();
  if (count === 0) return null;
  return (
    <div data-list-bulk role="region" aria-label={t('st.list.bulkAria')}
      className="anim-enter mb-2 flex min-h-10 flex-wrap items-center gap-2 rounded-lg bg-panel px-3 py-1.5 shadow-[var(--kiki-sheet-shadow)]">
      <span className="mr-auto text-[13px] font-medium text-ink tabular-nums">{t('st.list.selected', { count })}</span>
      {children}
      <button type="button" onClick={onClear} className={ICON_BUTTON} aria-label={t('st.list.clearSelection')} title={t('st.list.clearSelection')}>
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

/** Nothing to list, or nothing left after narrowing; the two never share copy. */
export function ListEmpty({ kind, title, body, action, onClear }: {
  kind: 'none' | 'no-match';
  title: string;
  body?: string;
  action?: ReactNode;
  onClear?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div data-list-empty={kind} className="rounded-lg border border-dashed border-hairline-strong px-4 py-6 text-center">
      <p className="text-[13px] font-medium text-ink">{title}</p>
      {body !== undefined ? <p className="mx-auto mt-1 max-w-[52ch] text-[12px] leading-4 text-ink-faint">{body}</p> : null}
      {kind === 'no-match' && onClear !== undefined ? (
        <button type="button" onClick={onClear}
          className="mt-3 h-8 rounded-md px-3 text-[12.5px] font-medium text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink">
          {t('st.list.clearFilters')}
        </button>
      ) : null}
      {action !== undefined ? <div className="mt-3 flex justify-center">{action}</div> : null}
    </div>
  );
}

/**
 * Row selection box: a real checkbox so Space, labels and screen readers just
 * work. `quiet` hides it until the row is hovered or focused, so an idle list
 * is not a column of empty boxes; once anything is selected every box shows.
 * The row needs the `group/row` class.
 */
export function RowCheck({ checked, onChange, label, quiet = false }: { checked: boolean; onChange: () => void; label: string; quiet?: boolean }) {
  return (
    <label className={`flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-ink/[0.04] pointer-coarse:h-11 pointer-coarse:w-11 ${
      quiet && !checked ? 'opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100' : ''
    }`}>
      <input type="checkbox" checked={checked} onChange={onChange} aria-label={label}
        className="h-3.5 w-3.5 cursor-pointer accent-[var(--color-ink)]" />
    </label>
  );
}