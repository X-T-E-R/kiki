/**
 * Media sources — the list a reader actually uses.
 *
 * One object per row, whatever is behind it. A row is a *provider* the tools
 * can call, and the four facts it carries (which package it came from, whether
 * that package is healthy, whether this provider is configured, and which
 * modalities it is the default for) are four fields on that one row — not four
 * parallel lists the reader has to reconcile.
 *
 * What this list is built to survive:
 *
 *  - A hundred sources. They are rows, not cards: one line each, no frame, no
 *    per-row expand, no per-row form. Detail is a sub-view, opened only for
 *    the one source being configured. A hundred expanded forms is a hundred
 *    dirty drafts and a page that cannot be scanned.
 *  - Search and filter over the whole set, with the count behind each filter
 *    shown before the reader commits to it. Both are computed from one array
 *    in memory — no request per row, no refetch as the reader types.
 *  - A filter that is a *real* state, not a decoration. "Needs setup" is the
 *    set a reader actually wants when they come back to finish configuring
 *    something, and it must be exactly the rows that will fail without a key.
 *
 * What it deliberately does not do: probe. Opening this page costs one call.
 * A row that says "Needs setup" is the host's own answer about a declared
 * field, not this page's guess from having tried to generate.
 */

import { useMemo, useState } from 'react';

import { useI18n } from '../../i18n';
import {
  filterBands,
  mediaSourceStatus,
  statusKey,
  visibleMediaSources,
  type MediaSourceEntry,
  type MediaSourceFilter,
  type MediaSourceStatus,
} from '../../lib/mediaSources';
import { EmptyNote, QUIET_BUTTON, SearchField, StatusDot, Tag } from '../capabilities/primitives';
import { MediaKindGlyph } from './MediaKindGlyph';

/** The band's own wording; a modality filter and a state filter read differently. */
const MODALITY_FILTERS: ReadonlySet<MediaSourceFilter> = new Set(['image', 'video', 'tts']);

const STATUS_DOT: Record<MediaSourceStatus, 'ok' | 'busy' | 'error' | 'off' | 'waiting'> = {
  broken: 'error',
  'needs-config': 'waiting',
  blocked: 'waiting',
  default: 'ok',
  ready: 'ok',
  // Not a fault and not an assurance. A hollow dot, so it never reads as either.
  unchecked: 'off',
};

export function MediaSourceList({
  sources,
  blockedProviders,
  loading,
  selected,
  onOpen,
}: {
  readonly sources: readonly MediaSourceEntry[];
  /** Providers with a job that cannot proceed until the package is back. */
  readonly blockedProviders?: ReadonlySet<string>;
  readonly loading?: boolean;
  readonly selected?: string;
  readonly onOpen: (provider: string) => void;
}) {
  const { t, tp } = useI18n();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<MediaSourceFilter>('all');
  const blocked = blockedProviders ?? new Set<string>();
  const bands = useMemo(() => filterBands(sources, blocked), [sources, blocked]);
  const visible = useMemo(() => visibleMediaSources(sources, query, filter, blocked), [sources, query, filter, blocked]);
  const filtering = query.trim() !== '' || filter !== 'all';

  return (
    <div className="min-w-0 space-y-3" data-media-sources={sources.length}>
      {/* Search and filters share one line and one rhythm: at 390px the search
          takes the row and the bands wrap under it; from 720px they sit
          beside each other. A hundred rows need a filter rail that does not
          cost a second screen. */}
      <div className="flex min-w-0 flex-col gap-2 min-[720px]:flex-row min-[720px]:items-center">
        <div className="min-w-0 flex-1">
          <SearchField value={query} onChange={setQuery} placeholder={t('cap.media.search')} ariaLabel={t('cap.media.searchAria')} />
        </div>
        <FilterRail bands={bands} value={filter} onChange={setFilter} />
      </div>

      {loading ? (
        <p className="text-[13px] text-ink-faint" role="status" data-media-sources-loading>{t('cap.media.loading')}</p>
      ) : visible.length === 0 ? (
        <EmptyNote
          title={filtering ? t('cap.media.noMatch', { query: query.trim() }) : t('cap.media.none')}
          body={filtering ? undefined : t('cap.media.noneBody')}
          action={filtering ? (
            <button type="button" className={QUIET_BUTTON} onClick={() => { setQuery(''); setFilter('all'); }} data-media-sources-clear>
              {t('cap.media.clearFilters')}
            </button>
          ) : undefined}
        />
      ) : (
        <>
          <p className="text-[12px] text-ink-faint tabular-nums" data-media-sources-count>
            {tp('cap.media.shown', visible.length)}
            {filtering && visible.length !== sources.length ? t('cap.media.ofTotal', { total: sources.length }) : null}
          </p>
          {/* A list, not a grid: at a hundred rows a single column with a
              stable left edge is the only shape a reader can scan. Each row is
              44px at rest, which is also a thumb-sized target on touch. */}
          <ul className="min-w-0" data-media-source-list>
            {visible.map((entry) => (
              <MediaSourceRow
                key={entry.provider}
                entry={entry}
                blocked={blocked.has(entry.provider)}
                selected={selected === entry.provider}
                onOpen={onOpen}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function FilterRail({
  bands,
  value,
  onChange,
}: {
  readonly bands: readonly { readonly id: MediaSourceFilter; readonly count: number }[];
  readonly value: MediaSourceFilter;
  readonly onChange: (next: MediaSourceFilter) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      role="tablist"
      aria-label={t('cap.media.filters')}
      data-media-source-filters={value}
      className="-mx-1 flex min-w-0 items-center gap-1 overflow-x-auto px-1 py-0.5 [scrollbar-width:none]"
    >
      {bands.map((band) => {
        const active = band.id === value;
        const label = MODALITY_FILTERS.has(band.id)
          ? t(`cap.media.filter.${band.id}` as Parameters<typeof t>[0])
          : t(`cap.media.filter.${band.id}` as Parameters<typeof t>[0]);
        return (
          <button
            key={band.id}
            type="button"
            role="tab"
            aria-selected={active}
            data-media-filter={band.id}
            onClick={() => { onChange(band.id); }}
            className={`inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12px] whitespace-nowrap transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink pointer-coarse:min-h-10 ${
              active
                ? 'bg-ink/[0.08] font-medium text-ink'
                : 'text-ink-soft hover:bg-ink/[0.04] hover:text-ink'
            }`}
          >
            {/* Only a modality filter carries a drawn mark; a state filter is
                about the row, not the medium, and a glyph there would lie. */}
            {band.id === 'image' || band.id === 'video' ? <MediaKindGlyph kind={band.id} className="h-3.5 w-3.5" /> : null}
            {label}
            <span className="font-mono text-[11px] tabular-nums text-ink-faint">{band.count}</span>
          </button>
        );
      })}
    </div>
  );
}

function MediaSourceRow({
  entry,
  blocked,
  selected,
  onOpen,
}: {
  readonly entry: MediaSourceEntry;
  readonly blocked: boolean;
  readonly selected: boolean;
  readonly onOpen: (provider: string) => void;
}) {
  const { t } = useI18n();
  const status = mediaSourceStatus(entry, blocked);
  const kinds = entry.definition.kinds;
  return (
    <li data-media-source={entry.provider} data-media-source-status={status}>
      <button
        type="button"
        onClick={() => { onOpen(entry.provider); }}
        aria-current={selected ? 'true' : undefined}
        className={`group flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${
          selected ? 'bg-ink/[0.05]' : ''
        }`}
      >
        {/* Which modality it makes, drawn — the fastest thing to scan in a
            list of a hundred, and it costs no text. */}
        <span className="flex shrink-0 items-center gap-1">
          {kinds.map((kind) => (
            <MediaKindGlyph key={kind} kind={kind} className="h-4 w-4 text-ink-faint" />
          ))}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={`truncate text-[13px] ${status === 'broken' ? 'text-ink-faint line-through decoration-ink-faint/60' : 'font-medium text-ink'}`}>
              {entry.displayName}
            </span>
            {status === 'default' ? <Tag tone="accent">{t(statusKey(status))}</Tag> : null}
            {status === 'needs-config' || status === 'blocked' ? <Tag tone="warn">{t(statusKey(status))}</Tag> : null}
            {status === 'broken' ? <Tag tone="danger">{t(statusKey(status))}</Tag> : null}
          </span>
          <span className="mt-0.5 block truncate text-[12px] leading-4 text-ink-faint">
            {rowMeta(entry, status, t)}
          </span>
        </span>
        <StatusDot state={STATUS_DOT[status]} label={t(statusKey(status))} />
      </button>
    </li>
  );
}

/**
 * The one fact line. It answers "what would I have to do to use this" before
 * the reader clicks: an unconfigured package says which setting is missing, a
 * healthy one says what it makes and which package it came from. It never
 * shows a key, a URL with a token in it, or a settings dump.
 */
function rowMeta(entry: MediaSourceEntry, status: MediaSourceStatus, t: ReturnType<typeof useI18n>['t']): string {
  if (status === 'broken') {
    return entry.problem ?? t('cap.media.row.unavailable', { plugin: entry.pluginId });
  }
  if (status === 'needs-config') {
    const missing = entry.settings?.missing ?? [];
    return missing.length > 0
      ? t('cap.media.row.missing', { keys: missing.join(', ') })
      : t('cap.media.row.needsKey');
  }
  if (status === 'blocked') return t('cap.media.row.blocked');
  if (status === 'unchecked') return t('cap.media.row.unchecked', { plugin: entry.pluginId });
  return [
    t(`cap.media.kind.${entry.definition.kinds[0]}` as Parameters<typeof t>[0]),
    entry.pluginId,
  ].filter((part) => part !== undefined).join(' · ');
}
