/**
 * UsagePage (/usage) — the Activity & cross-session usage surface. A bare
 * `/usage` visit opens Live (`realtime`), with Usage (`history`) and Quotas
 * (`quota`) as sibling tabs, while model prices and export sit behind the
 * header's `⋯`.
 */

import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { ErrorCode } from '@kiki/protocol';
import { formatBytes } from '@kiki/session-core/composer/media';
import { formatCostUsd, formatGrouped } from '@kiki/session-core/util';
import { useI18n } from '../i18n';
import { ApiError } from '../lib/client';
import { compactIdentifier } from '../lib/compactIdentifier';
import { getCurrentVisit, getUiSnapshot, saveScrollPosition, saveUiSnapshot } from '../lib/navHistory';
import { useThreadTitleResolver } from '../lib/threadTitles';
import {
  aggregateSourceRows,
  browserTimezoneOffsetMinutes,
  bucketLabel,
  cacheHitRateOf,
  parseUsageDetailView,
  totalTokensOf,
  usageBucketCompareWindow,
  usageCompareWindow,
  usageDetailViewToSearch,
  usagePointChange,
  usageRangeWindow,
  usageRatioChange,
  usageSourceFilterValue,
  usageSourceKey,
  usageTokenTotalIsUnknown,
  writeStoredUsageFilters,
  USAGE_SOURCE_KEY_UNKNOWN,
  type UsageDetailView,
  type UsageGroupBy,
  type UsageMetric,
  type UsageResponseWire,
  type UsageSourceRow,
  type UsageTrendBucketWire,
  type UsageWindow,
} from '../lib/usageV2';
import { useConnection } from '../state/connection';
import { Icon } from './icons';
import { PAGE_WIDTH, PageHeader, PageMoreMenu } from './PageChrome';
import { RequestGovernanceView } from './RequestGovernanceView';
import { ThreadTitle } from './ThreadTitle';
import { SECONDARY_BUTTON } from './ui';
import { UsageNavigation, usagePanelFromSearch, type UsagePanel } from './UsageNavigation';
import { UsageExportPanel } from './usage/export/UsageExportPanel';
import { PricingPanel } from './usage/PricingPanel';
import { ProviderQuotaPanel } from './usage/ProviderQuotaPanel';
import { DimensionBreakdown } from './usage/UsageBreakdown';
import { UsageFilterBar } from './usage/UsageFilterBar';
import { UsageReliabilityDetails } from './usage/UsageReliabilityDetails';
import { UsageRescanActiveBadge, UsageRescanControl } from './usage/UsageRescanControl';
import { UsageSessionPanel, type UsageSessionTraceRequest } from './usage/UsageSessionPanel';
import { UsageSources, type UsageSourcePrior } from './usage/UsageSources';
import { TrendChart } from './usage/UsageTrend';
import {
  buildUsageMultiApiQuery,
  isSourceRowFilterActive,
  parseUsageMultiFilters,
  searchHasUsageMultiParams,
  toggleSourceRowFilter,
  toSingleUsageFilters,
  USAGE_MULTI_FILTER_DEFAULTS,
  usageMultiFiltersHaveScope,
  usageMultiFiltersToSearch,
  type UsageMultiFilters,
} from './usage/usageFilterModel';
import { avgCostPerTurn, computeCacheSavingsUsd, summarizeActivityCounts } from './usage/usageMetrics';
import {
  bucketCost,
  CompareCell,
  formatCachePercent,
  formatPercent,
  KnownSubtotalMarker,
} from './usage/usageShared';

const SESSION_PAGE_SIZE = 25;
const SESSION_LOCATOR_MAX_AUTO_PAGES = 4;
export const USAGE_SESSIONS_VIRTUALIZE_THRESHOLD = 50;

type DetailTab = 'sources' | 'sessions' | 'breakdown';

const DETAIL_TAB_TO_VIEW: Record<DetailTab, UsageDetailView> = {
  sources: 'sources',
  sessions: 'sessions',
  breakdown: 'breakdown',
};

const VIEW_TO_DETAIL_TAB: Record<UsageDetailView, DetailTab> = {
  sources: 'sources',
  sessions: 'sessions',
  breakdown: 'breakdown',
  five_hour: 'sources',
};

const SOURCE_TABS_ORDER: readonly UsageGroupBy[] = ['model', 'provider', 'workspace', 'profile'];

const NOTICE_AMBER = 'rounded-lg border border-amber-rule/40 bg-amber-card px-3 py-2 text-[12.5px] leading-relaxed text-amber-ink';
const NOTICE_SOFT = 'rounded-lg border border-hairline bg-panel px-3 py-2 text-[12.5px] leading-relaxed text-ink-soft';

function localDateKey(nowMs: number): string {
  const date = new Date(nowMs);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-');
}

function importProgressOf(response: UsageResponseWire | undefined): UsageResponseWire['reliability']['import_progress'] {
  return response?.reliability.import_progress;
}

function isAdvanceableImport(reliability: UsageResponseWire['reliability']): boolean {
  return (
    !reliability.complete &&
    (reliability.import_progress !== undefined ||
      reliability.incomplete_reason === 'deadline' ||
      reliability.incomplete_reason === 'record_budget')
  );
}

// ---------------------------------------------------------------------------
// Minimalist 4-Figure Editorial KPI Band
// ---------------------------------------------------------------------------

function Kpi({ id, label, value, valueAction, hint, title, dataValue }: {
  readonly id: string;
  readonly label: string;
  readonly value: ReactNode;
  readonly valueAction?: ReactNode;
  readonly hint?: ReactNode;
  readonly title?: string;
  readonly dataValue?: string;
}) {
  const valueProps = dataValue === undefined ? {} : { [dataValue]: true };
  return (
    <section
      data-usage-kpi={id}
      title={title}
      className="flex min-w-0 flex-col py-1 lg:px-5 first:lg:pl-0 last:lg:pr-0"
    >
      <p className="text-[11.5px] font-medium tracking-[-0.005em] text-ink-faint">{label}</p>
      <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
        <div
          {...valueProps}
          className="flex min-w-0 items-baseline gap-2 truncate font-display text-[28px] leading-none tracking-tight text-ink tabular-nums"
        >
          {value}
        </div>
        {valueAction}
      </div>
      {hint !== undefined ? <div className="mt-2 min-h-4 text-[12px] leading-snug text-ink-faint">{hint}</div> : null}
    </section>
  );
}

function UsageKpiBand({
  summary,
  trend,
  incomplete,
  comparing,
  prior,
  unpricedCount,
  onOpenPricing,
  cacheSavingsUsd,
}: {
  readonly summary: UsageResponseWire['summary'];
  readonly trend: readonly UsageTrendBucketWire[];
  readonly incomplete: boolean;
  readonly comparing: boolean;
  readonly prior: UsageResponseWire['summary'] | undefined;
  readonly unpricedCount: number;
  readonly onOpenPricing: () => void;
  readonly cacheSavingsUsd: number | undefined;
}) {
  const { t, tp, time } = useI18n();

  const costUnknown = summary.cost_unknown || incomplete;
  const tokensUnknown = usageTokenTotalIsUnknown(summary) || (incomplete && totalTokensOf(summary) === 0);
  const cacheHit = cacheHitRateOf(summary);
  const input = summary.tokens.input_other + summary.tokens.input_cache_read + summary.tokens.input_cache_creation;

  const tokenCompositionTitle = !tokensUnknown && input > 0
    ? [
        `${t('usage.tokens.cacheRead')}: ${time.formatTokens(summary.tokens.input_cache_read)}`,
        `${t('usage.tokens.cacheWrite')}: ${time.formatTokens(summary.tokens.input_cache_creation)}`,
        `${t('usage.composition.fresh')}: ${time.formatTokens(summary.tokens.input_other)}`,
      ].join(' · ')
    : undefined;

  const costOutcome = comparing && prior !== undefined
    ? (summary.cost_unknown && summary.cost_usd_estimated === 0) || (prior.cost_unknown && prior.cost_usd_estimated === 0)
      ? usageRatioChange(Number.NaN, Number.NaN)
      : usageRatioChange(summary.cost_usd_estimated, prior.cost_usd_estimated)
    : undefined;
  const cacheOutcome = comparing && prior !== undefined
    ? usagePointChange(cacheHit, cacheHitRateOf(prior))
    : undefined;

  const activity = useMemo(() => summarizeActivityCounts(trend), [trend]);
  const perTurnCost = avgCostPerTurn(summary, activity);

  const activityHeadline = activity.hasTurns && activity.hasRequests
    ? t('usage.kpi.turnsRequests', { turns: formatGrouped(activity.turns), requests: formatGrouped(activity.requests) })
    : activity.hasTurns
      ? t('usage.kpi.turnsOnly', { turns: formatGrouped(activity.turns) })
      : tp('usage.sessionChip', summary.session_count);

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-y border-hairline py-4 lg:grid-cols-4 lg:gap-x-0 lg:divide-x lg:divide-hairline">
      <Kpi
        id="cost"
        label={t('usage.kpi.estimatedCost')}
        dataValue="data-usage-summary-cost"
        value={costUnknown && tokensUnknown && summary.cost_usd_estimated === 0 ? '—' : formatCostUsd(summary.cost_usd_estimated)}
        valueAction={unpricedCount > 0 ? (
          <button
            type="button"
            data-usage-unpriced-trigger
            onClick={onOpenPricing}
            title={`${tp('usage.kpi.unpricedCount', unpricedCount)} · ${t('usage.reliability.setPrices')}`}
            aria-label={`${tp('usage.kpi.unpricedCount', unpricedCount)} · ${t('usage.reliability.setPrices')}`}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-amber-ink/85 transition-colors hover:bg-amber-card hover:text-amber-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
          >
            <Icon name="partial" size={14} />
          </button>
        ) : undefined}
        hint={costOutcome !== undefined ? <CompareCell outcome={costOutcome} /> : undefined}
      />

      <Kpi
        id="tokens"
        label={t('usage.card.tokens')}
        dataValue="data-usage-summary-tokens"
        title={tokenCompositionTitle}
        value={tokensUnknown ? '—' : time.formatTokens(totalTokensOf(summary))}
        hint={(
          <span data-usage-summary-input-output className="tabular-nums">
            {tokensUnknown
              ? '—'
              : t('usage.kpi.inputOutput', {
                  input: time.formatTokens(input),
                  output: time.formatTokens(summary.tokens.output),
                })}
          </span>
        )}
      />

      <Kpi
        id="cache"
        label={t('usage.kpi.cacheHit')}
        dataValue="data-usage-summary-cache"
        title={t('usage.cacheHitHint')}
        value={tokensUnknown ? '—' : formatCachePercent(cacheHit)}
        hint={(cacheOutcome !== undefined || cacheSavingsUsd !== undefined) ? (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {cacheOutcome !== undefined ? <CompareCell outcome={cacheOutcome} points /> : null}
            {cacheSavingsUsd !== undefined ? (
              <span data-usage-cache-savings className="font-medium text-success tabular-nums">
                {t('usage.kpi.cacheSaved', { cost: formatCostUsd(cacheSavingsUsd) })}
              </span>
            ) : null}
          </div>
        ) : undefined}
      />

      <Kpi
        id="activity"
        label={t('usage.kpi.activity')}
        dataValue="data-usage-summary-activity"
        value={<span className="truncate text-[23px] leading-none tracking-tight">{activityHeadline}</span>}
        hint={perTurnCost !== undefined ? (
          <span className="tabular-nums">{t('usage.kpi.avgPerTurn', { cost: formatCostUsd(perTurnCost) })}</span>
        ) : undefined}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sessions table
// ---------------------------------------------------------------------------

function SessionsTab({
  data,
  search,
  fetchNextPage,
  hasNextPage,
  isFetchingNextPage,
  isFetchNextPageError,
  sessionLocator,
  locatorSearching,
  workspaceName,
  summaryCost,
  scrollElementRef,
}: {
  data: { pages: readonly UsageResponseWire[] };
  search: string;
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  sessionLocator: string | undefined;
  locatorSearching: boolean;
  workspaceName: (id: string) => string | undefined;
  summaryCost: number;
  scrollElementRef: RefObject<HTMLElement | null>;
}) {
  const { t, time } = useI18n();
  const navigate = useNavigate();
  const deferredSearch = useDeferredValue(search);
  const items = useMemo(() => data.pages.flatMap((page) => page.sessions.items), [data.pages]);
  const rankById = useMemo(() => {
    const map = new Map<string, number>();
    for (let index = 0; index < items.length; index += 1) {
      const id = items[index]!.id;
      if (!map.has(id)) map.set(id, index + 1);
    }
    return map;
  }, [items]);
  const total = data.pages[0]?.sessions.total ?? items.length;
  const located = sessionLocator !== undefined && rankById.has(sessionLocator);
  const needle = deferredSearch.trim().toLocaleLowerCase();
  const visible = useMemo(() => {
    const base = sessionLocator !== undefined && located
      ? items.filter((item) => item.id === sessionLocator)
      : items;
    if (needle === '') return base;
    return base.filter((item) => {
      const ws = workspaceName(item.workspace_id) ?? item.workspace_id;
      const hay = [
        item.title ?? '',
        item.primary_model ?? '',
        ws,
        ...(item.profile_names ?? []),
      ].join(' ').toLocaleLowerCase();
      return hay.includes(needle);
    });
  }, [items, located, needle, sessionLocator, workspaceName]);

  const listRef = useRef<HTMLOListElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const windowed = visible.length > USAGE_SESSIONS_VIRTUALIZE_THRESHOLD;

  useLayoutEffect(() => {
    if (!windowed) return;
    const list = listRef.current;
    const scroller = scrollElementRef.current;
    if (list === null || scroller === null) return;
    const measure = () => {
      const listRect = list.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      if (listRect.height === 0 && scrollerRect.height === 0) return;
      const next = Math.max(0, Math.round(listRect.top - scrollerRect.top + scroller.scrollTop));
      setScrollMargin((previous) => (previous === next ? previous : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    const observeAncestorsAndPreceding = () => {
      observer.disconnect();
      observer.observe(scroller);
      let node: Element | null = list;
      while (node !== null && node !== scroller) {
        const parent: Element | null = node.parentElement;
        if (parent === null) break;
        if (parent !== scroller) observer.observe(parent);
        let child: Element | null = parent.firstElementChild;
        while (child !== null && child !== node) {
          observer.observe(child);
          child = child.nextElementSibling;
        }
        node = parent;
      }
    };
    observeAncestorsAndPreceding();
    return () => { observer.disconnect(); };
  }, [windowed, scrollElementRef, visible.length]);

  const virtualizer = useVirtualizer({
    count: windowed ? visible.length : 0,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => 48,
    getItemKey: (index) => visible[index]?.id ?? index,
    overscan: 8,
    scrollMargin,
    initialRect: { width: 960, height: 640 },
    measureElement: (element, _entry, instance) => {
      const height = Math.round(element.getBoundingClientRect().height);
      return height > 0 ? height : instance.options.estimateSize(Number(element.getAttribute('data-index') ?? 0));
    },
    observeElementRect: (instance, cb) => {
      const el = instance.scrollElement;
      if (el === null) return;
      const emit = () => {
        const rect = el.getBoundingClientRect();
        const height = Math.round(rect.height || el.clientHeight);
        const width = Math.round(rect.width || el.clientWidth);
        if (height > 0) cb({ width, height });
      };
      emit();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(emit);
      observer.observe(el);
      return () => { observer.disconnect(); };
    },
    useFlushSync: false,
  });

  const grid = 'grid grid-cols-[1.75rem_minmax(0,1fr)_5.5rem] items-center gap-x-3 sm:grid-cols-[1.75rem_minmax(0,1fr)_8rem_4.5rem_4rem_5rem_5.5rem]';

  const renderSessionRow = (
    item: UsageResponseWire['sessions']['items'][number],
    virtualStyle?: { readonly top: number; readonly index: number; readonly isLast: boolean },
  ) => {
    const rank = rankById.get(item.id) ?? 1;
    const itemTokens = totalTokensOf(item.usage);
    const unknownTotal = usageTokenTotalIsUnknown(item.usage);
    const unpricedZero = item.usage.cost_unknown && item.usage.cost_usd_estimated === 0 && (itemTokens > 0 || unknownTotal);
    const share = summaryCost > 0 ? item.usage.cost_usd_estimated / summaryCost : 0;
    const profiles = item.profile_names ?? [];
    const updatedLabel = time.relativeTime(new Date(item.updated_at).toISOString());
    const wsDisplay = workspaceName(item.workspace_id) ?? compactIdentifier(item.workspace_id);
    const fillPct = share > 0 ? Math.max(1.5, Math.min(100, share * 100)) : 0;
    return (
      <li
        key={item.id}
        data-index={virtualStyle?.index}
        ref={virtualStyle !== undefined ? virtualizer.measureElement : undefined}
        style={virtualStyle !== undefined ? { top: virtualStyle.top } : undefined}
        className={
          virtualStyle !== undefined
            ? `absolute inset-x-0 overflow-hidden ${virtualStyle.isLast ? '' : 'border-b border-hairline'}`
            : 'relative overflow-hidden'
        }
      >
        {fillPct > 0 ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-[3px] left-0 rounded-r-sm bg-accent/[0.05]"
            style={{ width: `${fillPct}%` }}
          />
        ) : null}
        <button
          type="button"
          data-usage-session={item.id}
          onClick={() => void navigate(`/s/${item.id}`)}
          className={`${grid} relative w-full rounded-md px-2 py-2.5 text-left transition-colors hover:bg-ink/[0.03] focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11`}
        >
          <span className={`text-right text-[12px] tabular-nums ${rank <= 3 ? 'font-semibold text-ink' : 'text-ink-faint'}`}>
            {rank}
          </span>
          <span className="min-w-0">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="min-w-0 truncate text-[13px] text-ink">
                <ThreadTitle text={item.title ?? t('sidebar.untitled')} />
              </span>
              {item.primary_model ? (
                <span className="shrink-0 rounded bg-ink/[0.05] px-1.5 py-px font-mono text-[10.5px] text-ink-soft">
                  {item.primary_model}
                </span>
              ) : null}
              {profiles.slice(0, 2).map((profile) => (
                <span key={profile} className="shrink-0 rounded border border-hairline px-1.5 py-px text-[10.5px] text-ink-faint">
                  {profile}
                </span>
              ))}
              {item.archived ? (
                <span className="shrink-0 rounded-full border border-hairline px-1.5 text-[10.5px] text-ink-faint">{t('sidebar.archived')}</span>
              ) : null}
              {item.deleted ? (
                <span className="shrink-0 rounded-full border border-danger/40 px-1.5 text-[10.5px] text-danger">{t('usage.reliability.deleted.included')}</span>
              ) : null}
              {item.unknown_price_models.length > 0 ? (
                <span className="flex shrink-0 text-amber-ink" title={item.unknown_price_models.join(', ')}><Icon name="partial" size={12} /></span>
              ) : null}
            </span>
            <span className="mt-1 block text-[11px] text-ink-faint tabular-nums sm:hidden">
              {unknownTotal ? '—' : time.formatTokens(itemTokens)}
              {' · '}
              {unknownTotal ? '—' : formatPercent(cacheHitRateOf(item.usage))}
              {' · '}
              {updatedLabel}
            </span>
          </span>
          <span className="hidden truncate text-[12px] text-ink-soft sm:block" title={item.workspace_id}>
            {wsDisplay}
          </span>
          <span data-usage-session-tokens={item.id} className="hidden text-right text-[12px] text-ink-soft tabular-nums sm:block">
            {unknownTotal ? '—' : time.formatTokens(itemTokens)}
            {item.usage.tokens_unknown === true && !unknownTotal ? <KnownSubtotalMarker /> : null}
          </span>
          <span className="hidden text-right text-[12px] text-ink-soft tabular-nums sm:block">
            {unknownTotal ? '—' : formatPercent(cacheHitRateOf(item.usage))}
          </span>
          <span className="hidden text-right text-[12px] text-ink-faint sm:block">
            {updatedLabel}
          </span>
          <span data-usage-session-cost={item.id} className="text-right text-[13px] font-semibold text-ink tabular-nums">
            {unpricedZero ? '—' : formatCostUsd(item.usage.cost_usd_estimated)}
            {item.usage.cost_unknown ? (
              <KnownSubtotalMarker label={unpricedZero ? t('usage.reliability.costUnknown') : undefined} />
            ) : null}
          </span>
        </button>
      </li>
    );
  };

  return (
    <div data-usage-sessions>
      {sessionLocator !== undefined && !located ? (
        locatorSearching ? (
          <p data-usage-locating className={`mb-3 flex items-center gap-2 ${NOTICE_SOFT}`}>
            <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
            {t('usage.sessions.locating')}
          </p>
        ) : (
          <p data-usage-locating className={`mb-3 ${NOTICE_AMBER}`}>{t('usage.sessions.notInPage')}</p>
        )
      ) : null}
      <div aria-hidden className={`${grid} px-2 pb-2 text-[11px] text-ink-faint`}>
        <span className="text-right">#</span>
        <span>{t('usage.col.session')}</span>
        <span className="hidden sm:block">{t('usage.col.workspace')}</span>
        <span className="hidden text-right sm:block">{t('usage.col.tokens')}</span>
        <span className="hidden text-right sm:block">{t('usage.col.cacheHit')}</span>
        <span className="hidden text-right sm:block">{t('usage.col.updated')}</span>
        <span className="text-right">{t('usage.col.cost')}</span>
      </div>
      {visible.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-ink-faint">
          {items.length > 0 && needle !== '' ? t('usage.sessions.noMatch') : t('usage.empty')}
        </p>
      ) : windowed ? (
        <ol
          ref={listRef}
          data-usage-sessions-virtualized="true"
          className="relative border-t border-hairline"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((row) => {
            const item = visible[row.index];
            if (item === undefined) return null;
            return renderSessionRow(item, {
              top: row.start - scrollMargin,
              index: row.index,
              isLast: row.index === visible.length - 1,
            });
          })}
        </ol>
      ) : (
        <ol className="divide-y divide-hairline border-t border-hairline">
          {visible.map((item) => renderSessionRow(item))}
        </ol>
      )}
      {hasNextPage || isFetchNextPageError ? (
        <button
          type="button"
          data-usage-load-more
          onClick={fetchNextPage}
          disabled={isFetchingNextPage}
          className="mt-3 h-9 w-full rounded-md border border-hairline text-[13px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:opacity-50 pointer-coarse:min-h-11"
        >
          {isFetchNextPageError ? t('usage.sessions.loadMoreFailed') : t('usage.sessions.loadMore', { shown: items.length, total })}
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function UsagePage({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { client, scopeId } = useConnection();
  const queryClient = useQueryClient();
  const { t, tp, locale } = useI18n();
  const location = useLocation();
  const [, setSearchParams] = useSearchParams();
  const rawPanel = new URLSearchParams(location.search).get('panel');
  const panel = usagePanelFromSearch(location.search);
  const selectPanel = (next: UsagePanel) => {
    const params = new URLSearchParams(location.search);
    params.set('panel', next);
    setSearchParams(params, { replace: true });
  };
  const [usageNowMs, setUsageNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => { setUsageNowMs(Date.now()); }, 60_000);
    return () => { window.clearInterval(timer); };
  }, []);

  const filters = useMemo<UsageMultiFilters>(
    () => (searchHasUsageMultiParams(location.search) ? parseUsageMultiFilters(location.search) : USAGE_MULTI_FILTER_DEFAULTS),
    [location.search],
  );
  const singleFilters = useMemo(() => toSingleUsageFilters(filters), [filters]);
  useEffect(() => {
    writeStoredUsageFilters(singleFilters);
  }, [singleFilters]);

  const localUsageDate = localDateKey(usageNowMs);
  const timezoneOffsetMinutes = browserTimezoneOffsetMinutes();

  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const metric: UsageMetric = METRIC_SEARCH_TO_METRIC[searchParams.get('metric') ?? ''] ?? 'cost';
  const comparing = searchParams.get('compare') === 'previous';
  const compareAvailable = usageCompareWindow(
    usageRangeWindow(singleFilters, timezoneOffsetMinutes, usageNowMs) ?? { startAt: 0, endAt: 0 },
    timezoneOffsetMinutes,
    usageNowMs,
  ) !== null;
  const bucketParam = searchParams.get('bucket');
  const [selectedBucketKey, setSelectedBucketKey] = useState<string | null>(bucketParam);
  const [sourceSearch, setSourceSearch] = useState('');
  const [sessionSearch, setSessionSearch] = useState('');
  const traceParam = searchParams.get('trace');
  const trace: UsageSessionTraceRequest | undefined = useMemo(() => {
    if (traceParam === null) return undefined;
    try {
      const parsed = JSON.parse(traceParam) as UsageSessionTraceRequest;
      return parsed;
    } catch {
      return undefined;
    }
  }, [traceParam]);
  const setTrace = useCallback((next: UsageSessionTraceRequest | undefined) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (panel === 'history') params.set('panel', 'history');
      if (next === undefined) params.delete('trace');
      else params.set('trace', JSON.stringify(next));
      return params;
    }, { replace: true });
  }, [panel, setSearchParams]);
  const rawSessionParam = searchParams.get('session') ?? searchParams.get('session_id');
  const sessionParam = rawSessionParam !== null && rawSessionParam !== '' ? rawSessionParam : undefined;
  const [dismissedLocator, setDismissedLocator] = useState<string | null>(null);
  const sessionLocator = panel === 'history' && sessionParam !== undefined && sessionParam !== dismissedLocator
    ? sessionParam
    : undefined;

  const hasExplicitView = searchParams.has('view');
  const parsedDetailView = parseUsageDetailView(location.search);
  const tab: DetailTab = sessionLocator !== undefined && !hasExplicitView
    ? 'sessions'
    : VIEW_TO_DETAIL_TAB[parsedDetailView];

  const scrollRef = useRef<HTMLElement | null>(null);
  const restoredVisitRef = useRef<string | null>(null);
  const [pendingScrollRestore, setPendingScrollRestore] = useState<number | null>(null);

  useEffect(() => {
    const visit = getCurrentVisit();
    if (!visit || restoredVisitRef.current === visit.visitId) return;
    restoredVisitRef.current = visit.visitId;
    const saved = getUiSnapshot<{ scrollTop?: number; selectedBucketKey?: string | null }>(visit.visitId);
    setPendingScrollRestore(saved?.scrollTop ?? 0);
    setSelectedBucketKey(saved?.selectedBucketKey ?? null);
  }, [location.key]);

  const selectBucketKeyWithSnapshot = (key: string | null) => {
    setSelectedBucketKey(key);
    const params = new URLSearchParams(location.search);
    if (panel === 'history') params.set('panel', 'history');
    params.delete('bucket');
    if (key !== null) params.set('bucket', key);
    setSearchParams(params, { replace: true });
    const visit = getCurrentVisit();
    if (visit) saveUiSnapshot(visit.visitId, { selectedBucketKey: key });
  };

  const handleScroll = () => {
    if (pendingScrollRestore !== null) return;
    const cur = getCurrentVisit();
    if (cur && scrollRef.current) {
      saveUiSnapshot(cur.visitId, { scrollTop: scrollRef.current.scrollTop });
      saveScrollPosition(cur.visitId, 'main[data-usage-scroll]', scrollRef.current.scrollTop);
    }
  };

  const selectDetailTab = (next: DetailTab) => {
    setSearchParams(new URLSearchParams(usageDetailViewToSearch(DETAIL_TAB_TO_VIEW[next], location.search)), { replace: true });
  };

  const selectSourceAxisTab = (nextGroup: UsageGroupBy) => {
    const nextFilters: UsageMultiFilters = { ...filters, groupBy: nextGroup, advancedDimension: undefined };
    writeStoredUsageFilters(toSingleUsageFilters(nextFilters));
    const searchWithFilters = usageMultiFiltersToSearch(nextFilters, location.search);
    setSearchParams(new URLSearchParams(usageDetailViewToSearch('sources', `?${searchWithFilters}`)), { replace: true });
  };

  const filterKey = usageMultiFiltersToSearch(filters);
  const previousFilters = useRef<{ key: string; visitId?: string }>({ key: filterKey });
  useEffect(() => {
    const visit = getCurrentVisit();
    const changed = previousFilters.current.key !== filterKey;
    const sameVisit = previousFilters.current.visitId === visit?.visitId;
    previousFilters.current = { key: filterKey, visitId: visit?.visitId };
    if (!changed || !sameVisit) return;
    setSelectedBucketKey(null);
    setTrace(undefined);
    if (visit) saveUiSnapshot(visit.visitId, { selectedBucketKey: null });
  }, [filterKey, location.key, setTrace]);

  const applyFilters = (next: UsageMultiFilters) => {
    writeStoredUsageFilters(toSingleUsageFilters(next));
    setSearchParams(new URLSearchParams(usageMultiFiltersToSearch(next, location.search)), { replace: true });
  };

  const applyMetric = (next: UsageMetric) => {
    const params = new URLSearchParams(location.search);
    if (panel === 'history') params.set('panel', 'history');
    params.delete('metric');
    if (next !== 'cost') params.set('metric', next);
    setSearchParams(params, { replace: true });
  };

  const applyCompare = (next: boolean) => {
    const params = new URLSearchParams(location.search);
    if (panel === 'history') params.set('panel', 'history');
    params.delete('compare');
    if (next) params.set('compare', 'previous');
    setSearchParams(params, { replace: true });
  };

  const usageQuery = useInfiniteQuery({
    queryKey: ['usage-v2', scopeId, filters, localUsageDate, timezoneOffsetMinutes],
    enabled: panel === 'history',
    queryFn: ({ pageParam, signal }) =>
      client.getUsage(
        buildUsageMultiApiQuery(filters, { timezoneOffsetMinutes, pageSize: SESSION_PAGE_SIZE, pageToken: pageParam }),
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === scopeId ? previousData : undefined,
    retry: false,
    getNextPageParam: (lastPage) =>
      lastPage.sessions.has_more ? (lastPage.sessions.next_page_token ?? undefined) : undefined,
    refetchInterval: (query) => {
      if (panel !== 'history' || query.state.status === 'error') return false;
      const unfinished = query.state.data?.pages.some(({ reliability }) => !reliability.complete &&
        (reliability.incomplete_reason === 'deadline' || reliability.incomplete_reason === 'record_budget'));
      if (unfinished) return 250;
      const isTodayDefault = filters.range === 'today' && filters.includeArchived && !usageMultiFiltersHaveScope(filters);
      return isTodayDefault ? 60_000 : false;
    },
  });

  const {
    data: usageData,
    error: usageError,
    isError: isUsageError,
    isPending: isUsagePending,
    isFetching: isUsageFetching,
    isFetchingNextPage,
    isFetchNextPageError,
    isPlaceholderData,
    hasNextPage,
    fetchNextPage,
    refetch: refetchUsage,
  } = usageQuery;

  const isRefetchingScope = isPlaceholderData && isUsageFetching;
  const recoveredPageError = useRef<unknown>(undefined);
  useEffect(() => {
    if (!isFetchNextPageError || !(usageError instanceof ApiError) || usageError.code !== ErrorCode.PAGE_TOKEN_MISMATCH || recoveredPageError.current === usageError) return;
    recoveredPageError.current = usageError;
    void queryClient.resetQueries({ queryKey: ['usage-v2', scopeId, filters, localUsageDate, timezoneOffsetMinutes], exact: true });
  }, [usageError, isFetchNextPageError, queryClient, scopeId, filters, localUsageDate, timezoneOffsetMinutes]);

  const loadedPageCount = usageData?.pages.length ?? 0;
  const locatedSession =
    sessionLocator !== undefined &&
    (usageData?.pages.some((page) => page.sessions.items.some((item) => item.id === sessionLocator)) ?? false);
  const locatorCanAutoPage = hasNextPage && loadedPageCount <= SESSION_LOCATOR_MAX_AUTO_PAGES;
  const locatorSearching =
    sessionLocator !== undefined &&
    !locatedSession &&
    !isFetchNextPageError &&
    (locatorCanAutoPage || isFetchingNextPage);
  useEffect(() => {
    if (sessionLocator === undefined || locatedSession || isFetchNextPageError || isPlaceholderData) return;
    if (locatorCanAutoPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [
    sessionLocator,
    locatedSession,
    locatorCanAutoPage,
    usageData,
    isFetchingNextPage,
    isFetchNextPageError,
    isPlaceholderData,
    fetchNextPage,
  ]);

  const firstPage = usageData?.pages[0];
  const mainComplete = firstPage?.reliability.complete === true;
  const trend = useMemo(() => firstPage?.trend ?? [], [firstPage]);
  const selectedBucket = trend.find((bucket) => bucket.key === selectedBucketKey);
  useLayoutEffect(() => {
    if (pendingScrollRestore === null || !scrollRef.current) return;
    if (pendingScrollRestore > 0 && panel === 'history' && firstPage === undefined && !isUsageError) return;
    scrollRef.current.scrollTop = pendingScrollRestore;
    setPendingScrollRestore(null);
  }, [pendingScrollRestore, panel, firstPage, selectedBucketKey, isUsageError]);

  const serverRange = firstPage?.query.range;
  const rangeWindow = useMemo(() => {
    if (
      serverRange?.start_at !== null &&
      serverRange?.start_at !== undefined &&
      serverRange?.end_at !== null &&
      serverRange?.end_at !== undefined
    ) {
      return { startAt: serverRange.start_at, endAt: serverRange.end_at };
    }
    return usageRangeWindow(singleFilters, timezoneOffsetMinutes, usageNowMs);
  }, [serverRange?.start_at, serverRange?.end_at, singleFilters, timezoneOffsetMinutes, usageNowMs]);
  const compareWindow = useMemo(() => {
    if (!comparing || rangeWindow === null) return null;
    return selectedBucket === undefined || selectedBucket === null
      ? usageCompareWindow(rangeWindow, timezoneOffsetMinutes, usageNowMs)
      : usageBucketCompareWindow(rangeWindow, selectedBucket, timezoneOffsetMinutes, usageNowMs);
  }, [comparing, rangeWindow, selectedBucket, timezoneOffsetMinutes, usageNowMs]);
  const compareQuery = useQuery({
    queryKey: ['usage-v2', scopeId, 'compare', filters, compareWindow, localUsageDate, timezoneOffsetMinutes],
    enabled: panel === 'history' && compareWindow !== null && mainComplete && !isPlaceholderData && !isUsageError,
    retry: false,
    queryFn: ({ signal }) =>
      client.getUsage(
        buildUsageMultiApiQuery(filters, {
          timezoneOffsetMinutes,
          pageSize: 1,
          window: compareWindow ?? undefined,
        }),
        { signal },
      ),
  });
  useEffect(() => {
    if (panel === 'history') return;
    void queryClient.cancelQueries({ queryKey: ['usage-v2'] });
  }, [panel, queryClient]);
  const priorSource: UsageSourcePrior | undefined = comparing
    ? {
        priorByKey: new Map(aggregateSourceRows(compareQuery.data?.trend ?? [], filters.groupBy).map((row) => [row.key, row])),
        complete: compareQuery.data?.reliability.complete === true,
      }
    : undefined;

  const workspacesQuery = useQuery({
    queryKey: ['workspaces', 'catalog', scopeId],
    queryFn: () => client.listWorkspaceCatalog(),
    staleTime: 60_000,
    enabled: panel === 'history',
  });
  const workspaces = useMemo(() => workspacesQuery.data?.items ?? [], [workspacesQuery.data]);
  const modelsQuery = useQuery({
    queryKey: ['models', scopeId],
    queryFn: () => client.listModels(),
    staleTime: 60_000,
    enabled: panel === 'history',
  });
  const providersQuery = useQuery({
    queryKey: ['providers', scopeId],
    queryFn: () => client.listProviders(),
    staleTime: 60_000,
    enabled: panel === 'history',
  });
  const profilesQuery = useQuery({
    queryKey: ['named-agent-profiles', scopeId],
    queryFn: () => client.listNamedAgentProfiles(),
    staleTime: 60_000,
    retry: false,
    enabled: panel === 'history' && typeof client.listNamedAgentProfiles === 'function',
  });

  const models = useMemo(() => modelsQuery.data?.items ?? [], [modelsQuery.data]);
  const providers = useMemo(() => providersQuery.data?.items ?? [], [providersQuery.data]);
  const namedProfiles = useMemo(() => profilesQuery.data?.items ?? [], [profilesQuery.data]);

  const mainIsModelDimension = filters.groupBy === 'model' && filters.advancedDimension === undefined;
  const modelAttributionScope = useMemo(
    () => ({
      granularity: filters.granularity,
      range: filters.range,
      workspaceIds: filters.workspaceIds,
      models: filters.models,
      providers: filters.providers,
      profiles: filters.profiles,
      agentIds: filters.agentIds,
      includeArchived: filters.includeArchived,
      startAt: filters.startAt,
      endAt: filters.endAt,
    }),
    [
      filters.granularity,
      filters.range,
      filters.workspaceIds,
      filters.models,
      filters.providers,
      filters.profiles,
      filters.agentIds,
      filters.includeArchived,
      filters.startAt,
      filters.endAt,
    ],
  );
  const modelAttributionQueryKey = useMemo(
    () => ['usage-v2', scopeId, 'model-attribution', modelAttributionScope, localUsageDate, timezoneOffsetMinutes] as const,
    [scopeId, modelAttributionScope, localUsageDate, timezoneOffsetMinutes],
  );

  useEffect(() => {
    if (mainIsModelDimension && mainComplete && !isPlaceholderData && !isUsageError && firstPage !== undefined) {
      queryClient.setQueryData(modelAttributionQueryKey, firstPage);
    }
  }, [mainIsModelDimension, mainComplete, firstPage, isPlaceholderData, isUsageError, queryClient, modelAttributionQueryKey]);

  const modelAttributionQuery = useQuery<UsageResponseWire>({
    queryKey: modelAttributionQueryKey,
    enabled:
      panel === 'history' &&
      !mainIsModelDimension &&
      mainComplete &&
      !isUsageError,
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === scopeId ? previousData : undefined,
    staleTime: 30_000,
    retry: false,
    queryFn: ({ signal }) =>
      client.getUsage(
        buildUsageMultiApiQuery(
          { ...filters, groupBy: 'model', advancedDimension: undefined },
          { timezoneOffsetMinutes, pageSize: 1 },
        ),
        { signal },
      ),
  });

  const modelTrend = useMemo(
    () =>
      mainIsModelDimension && !isPlaceholderData
        ? trend
        : (modelAttributionQuery.data?.trend ?? []),
    [mainIsModelDimension, isPlaceholderData, trend, modelAttributionQuery.data],
  );
  const pricingTrendSource = modelTrend.length > 0 ? modelTrend : trend;
  const pricingTrendGroupBy: UsageGroupBy = modelTrend.length > 0 ? 'model' : filters.groupBy;

  const observedPricingModels = useMemo(() => {
    const names = new Set<string>();
    for (const bucket of pricingTrendSource) {
      for (const group of bucket.groups) {
        if (group.tokens.input_cache_read <= 0) continue;
        const modelId = group.model_alias ?? (
          pricingTrendGroupBy === 'model' &&
          group.key !== USAGE_SOURCE_KEY_UNKNOWN &&
          !group.key.startsWith('provider:') &&
          !group.key.startsWith('profile:')
            ? group.key
            : null
        );
        if (modelId !== null) names.add(modelId);
      }
    }
    return [...names].toSorted((a, b) => a.localeCompare(b));
  }, [pricingTrendSource, pricingTrendGroupBy]);

  const pricingQuery = useQuery<Awaited<ReturnType<typeof client.getUsagePricing>>>({
    queryKey: ['usage-pricing-summary', scopeId, observedPricingModels],
    queryFn: () => client.getUsagePricing(observedPricingModels),
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === scopeId ? previousData : undefined,
    staleTime: 60_000,
    retry: false,
    enabled:
      panel === 'history' &&
      typeof client.getUsagePricing === 'function' &&
      observedPricingModels.length > 0,
  });

  const cacheSavingsUsd = useMemo(
    () => computeCacheSavingsUsd(pricingTrendSource, pricingQuery.data?.items, pricingTrendGroupBy),
    [pricingTrendSource, pricingQuery.data?.items, pricingTrendGroupBy],
  );

  const workspaceNames = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])), [workspaces]);
  const sessionTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const page of usageData?.pages ?? []) {
      for (const item of page.sessions.items) if (item.title !== null) map.set(item.id, item.title);
    }
    return map;
  }, [usageData]);
  const sessionTitleRefCandidates = useMemo(() => {
    const out: string[] = [];
    for (const title of sessionTitles.values()) {
      if (title.includes('[[') || title.includes('/s/')) out.push(title);
    }
    return out;
  }, [sessionTitles]);
  const resolveTitle = useThreadTitleResolver(sessionTitleRefCandidates);
  const workspaceName = useCallback((id: string) => workspaceNames.get(id), [workspaceNames]);
  const sessionTitle = (id: string) => {
    const title = sessionTitles.get(id);
    return title === undefined ? undefined : resolveTitle(title);
  };
  const sourceLookups = { unknownLabel: t(`usage.sources.unknown.${filters.groupBy}`), workspaceName };
  const trendGroupByKey = useMemo(() => {
    const map = new Map<string, UsageTrendBucketWire['groups'][number]>();
    for (const bucket of trend) {
      for (const entry of bucket.groups) {
        if (!map.has(entry.key)) map.set(entry.key, entry);
      }
    }
    return map;
  }, [trend]);
  const trendGroupBySourceKey = useMemo(() => {
    const map = new Map<string, UsageTrendBucketWire['groups'][number]>();
    for (const bucket of trend) {
      for (const entry of bucket.groups) {
        const k = usageSourceKey(entry, filters.groupBy);
        if (!map.has(k)) map.set(k, entry);
      }
    }
    return map;
  }, [trend, filters.groupBy]);

  const summary = firstPage?.summary;
  const reliability = firstPage?.reliability;
  const unpricedCount = reliability?.unknown_price_models.length ?? 0;
  const [pricingOpen, setPricingOpen] = useState(false);

  const groupBy = filters.groupBy;
  const sourceTrend = selectedBucket === undefined ? trend : [selectedBucket];
  const sourceScopeLabel = selectedBucket === undefined
    ? t('usage.sources.wholeRange')
    : `${t('usage.sources.selectedPeriod')} · ${bucketLabel(selectedBucket, filters.granularity, locale)}`;
  const sourceSubtotal = sourceTrend.reduce((sum, bucket) => sum + bucketCost(bucket), 0);

  const openTrace = (row: UsageSourceRow | undefined) => {
    const window: UsageWindow | null = rangeWindow === null
      ? null
      : selectedBucket === undefined
        ? rangeWindow
        : {
            startAt: Math.max(selectedBucket.start_at, rangeWindow.startAt),
            endAt: Math.min(selectedBucket.end_at, rangeWindow.endAt),
          };
    if (window === null) return;
    const request: UsageSessionTraceRequest = {
      window,
      filter: row?.filter ?? undefined,
      label: row === undefined ? sourceScopeLabel : sourceRowLabel(row, groupBy, sourceLookups),
      groupBy,
    };
    const params = new URLSearchParams(location.search);
    params.set('panel', 'history');
    params.set('trace', JSON.stringify(request));
    setSearchParams(params, { replace: true });
  };

  const legacyDimension = filters.advancedDimension;

  const scanPendingPill =
    !isUsageError && firstPage !== undefined && isAdvanceableImport(firstPage.reliability) ? (() => {
      const progress = importProgressOf(firstPage);
      const countingLabel = progress === undefined
        ? t('usage.strip.counting')
        : t('usage.strip.countingProgress', {
            verified: formatGrouped(progress.verified_sources),
            total: formatGrouped(progress.total_sources),
          });
      return (
        <div
          data-usage-scan-pending
          role="status"
          className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-full border border-amber-rule/35 bg-amber-card/55 px-2.5 py-0.5 text-[11.5px] text-amber-ink"
        >
          <span aria-hidden className="status-dot-busy h-1.5 w-1.5 rounded-full bg-amber-rule" />
          <span data-usage-scan-counting className="tabular-nums">{countingLabel}</span>
          {progress !== undefined ? (
            <span data-usage-scan-bytes className="text-[11px] text-amber-ink/80 tabular-nums">
              {formatBytes(progress.read_bytes)} / {formatBytes(progress.total_bytes)}
            </span>
          ) : null}
          <button
            type="button"
            data-usage-continue-scan
            disabled={isUsageFetching}
            onClick={() => void refetchUsage()}
            className="font-medium underline underline-offset-2 hover:text-ink disabled:opacity-50"
          >
            {t(isUsageFetching ? 'usage.loading' : 'usage.continueScan')}
          </button>
        </div>
      );
    })() : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-paper">
      <PageHeader title={t('usage.title')} onToggleSidebar={onToggleSidebar} width="dashboard">
        <PageMoreMenu
          menuId="usage-more"
          entries={[
            {
              key: 'pricing',
              label: unpricedCount > 0 ? tp('usage.prices.missing', unpricedCount) : t('usage.pricing.open'),
              run: () => { setPricingOpen(true); },
            },
            { key: 'export', label: t('usage.export.nav'), run: () => { selectPanel('export'); } },
          ]}
        />
      </PageHeader>
      {pricingOpen ? (
        <PricingPanel models={reliability?.unknown_price_models ?? []} onClose={() => { setPricingOpen(false); }} />
      ) : null}
      <main ref={scrollRef} onScroll={handleScroll} data-usage-scroll style={{ overflowAnchor: 'none' }} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pt-3 pb-10 lg:px-6">
        <div className={`mx-auto ${PAGE_WIDTH.dashboard} space-y-5`} data-usage-page>
          <UsageNavigation panel={panel} onChange={selectPanel} />
          {panel === 'export' ? (
            <UsageExportPanel />
          ) : panel === 'quota' ? (
            <ProviderQuotaPanel />
          ) : panel !== 'history' ? (
            <RequestGovernanceView view={rawPanel === 'limits' ? 'limits' : 'realtime'} />
          ) : <>
            <UsageFilterBar
              filters={filters}
              workspaces={workspaces}
              models={models}
              providers={providers}
              namedProfiles={namedProfiles}
              response={firstPage}
              modelResponse={modelAttributionQuery.data}
              comparing={comparing}
              compareAvailable={compareAvailable}
              onCompareChange={applyCompare}
              onChange={applyFilters}
              utilitySlot={
                <>
                  {scanPendingPill}
                  <UsageRescanActiveBadge />
                </>
              }
              reliabilitySlot={
                firstPage !== undefined ? (
                  <UsageReliabilityDetails
                    summary={firstPage.summary}
                    reliability={firstPage.reliability}
                    onOpenPricing={() => { setPricingOpen(true); }}
                    footerSlot={<UsageRescanControl />}
                  />
                ) : undefined
              }
            />
            {isUsagePending && firstPage === undefined ? (
              <div role="status" className="flex items-center gap-2 py-6 text-[13px] text-ink-faint">
                <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
                {t('usage.loading')}
              </div>
            ) : null}
            {isUsageError && isUnsupportedUsageRead(usageError) ? (
              <p data-usage-unsupported role="status" className="py-6 text-[13px] text-ink-soft">{t('usage.unsupported')}</p>
            ) : isUsageError ? (
              <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2 text-[13px] text-danger">
                <p className="font-medium">{t('usage.loadFailedKeep')}</p>
                <button
                  type="button"
                  onClick={() => void refetchUsage()}
                  className={SECONDARY_BUTTON}
                >
                  {t('common.reload')}
                </button>
              </div>
            ) : null}
            {!isUsageError && usageData !== undefined && firstPage !== undefined ? (
              <div className={isRefetchingScope ? 'space-y-6 opacity-65 transition-opacity' : 'space-y-6'}>
                {isRefetchingScope ? (
                  <div data-usage-refetching role="status" className="flex items-center gap-2 text-[12px] text-ink-faint">
                    <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
                    <span>{t('usage.loading')}</span>
                  </div>
                ) : null}

                {summary !== undefined ? (
                  <UsageKpiBand
                    summary={summary}
                    trend={trend}
                    incomplete={!firstPage.reliability.complete}
                    comparing={comparing}
                    prior={compareQuery.data?.summary}
                    unpricedCount={unpricedCount}
                    onOpenPricing={() => { setPricingOpen(true); }}
                    cacheSavingsUsd={cacheSavingsUsd}
                  />
                ) : null}

                {trend.length === 0 ? (firstPage.reliability.complete ? (
                  <p data-usage-empty className="py-8 text-center text-[13px] text-ink-faint">
                    {filters.range === 'all' && !usageMultiFiltersHaveScope(filters) ? t('usage.emptyAll') : t('usage.empty')}
                  </p>
                ) : null) : (
                  <TrendChart
                    trend={trend}
                    filters={singleFilters}
                    groupBy={groupBy}
                    metric={metric}
                    onMetricChange={applyMetric}
                    onGranularityChange={(granularity) => { applyFilters({ ...filters, granularity }); }}
                    selectedKey={selectedBucketKey}
                    onSelect={selectBucketKeyWithSnapshot}
                    labelForKey={(key) => {
                      if (legacyDimension !== undefined) {
                        const group = trendGroupByKey.get(key);
                        return dimensionKeyLabelLegacy(
                          {
                            key,
                            modelAlias: group?.model_alias ?? null,
                            profileName: group?.profile_name ?? null,
                            agentId: group?.agent_id ?? null,
                          },
                          legacyDimension,
                          sourceLookups,
                          sessionTitle,
                        );
                      }
                      return sourceKeyToLabel(key, groupBy, trendGroupBySourceKey, sourceLookups);
                    }}
                  />
                )}

                {firstPage.reliability.complete || trend.length > 0 ? (
                  <section data-usage-detail className="space-y-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline">
                      <div role="tablist" aria-label={t('usage.sources.title')} className="flex min-w-0 flex-nowrap items-baseline gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" data-usage-tabs>
                        {SOURCE_TABS_ORDER.map((axis) => {
                          const active = tab === 'sources' && groupBy === axis;
                          return (
                            <button
                              key={axis}
                              type="button"
                              role="tab"
                              aria-selected={active}
                              data-usage-tab={axis}
                              data-usage-grouping={axis}
                              onClick={() => { selectSourceAxisTab(axis); }}
                              className={`-mb-px min-h-9 shrink-0 whitespace-nowrap border-b-2 px-3 py-1.5 text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40 pointer-coarse:min-h-11 ${
                                active ? 'border-ink font-medium text-ink' : 'border-transparent text-ink-soft hover:text-ink'
                              }`}
                            >
                              {t(`usage.sources.grouping.${axis}`)}
                            </button>
                          );
                        })}

                        <button
                          type="button"
                          role="tab"
                          aria-selected={tab === 'sessions'}
                          data-usage-tab="sessions"
                          onClick={() => { selectDetailTab('sessions'); }}
                          className={`-mb-px min-h-9 shrink-0 whitespace-nowrap border-b-2 px-3 py-1.5 text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40 pointer-coarse:min-h-11 ${
                            tab === 'sessions' ? 'border-ink font-medium text-ink' : 'border-transparent text-ink-soft hover:text-ink'
                          }`}
                        >
                          {t('usage.tab.sessions')}
                        </button>

                        {legacyDimension !== undefined ? (
                          <button
                            type="button"
                            role="tab"
                            aria-selected={tab === 'breakdown'}
                            data-usage-tab="breakdown"
                            onClick={() => { selectDetailTab('breakdown'); }}
                            className={`-mb-px min-h-9 shrink-0 whitespace-nowrap border-b-2 px-3 py-1.5 text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40 pointer-coarse:min-h-11 ${
                              tab === 'breakdown' ? 'border-ink font-medium text-ink' : 'border-transparent text-ink-soft hover:text-ink'
                            }`}
                          >
                            {t(`usage.dimension.${legacyDimension}`)}
                          </button>
                        ) : null}
                      </div>

                      {tab === 'sources' && selectedBucket !== undefined ? (
                        <div className="flex flex-wrap items-center gap-2 pb-1">
                          <button
                            type="button"
                            data-usage-clear-bucket
                            onClick={() => { selectBucketKeyWithSnapshot(null); }}
                            className="inline-flex h-7 items-center gap-1.5 rounded-full border border-selected-ink/40 bg-panel px-2.5 text-[11.5px] text-ink transition-colors hover:border-selected-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
                          >
                            <span data-usage-source-scope>{bucketLabel(selectedBucket, filters.granularity, locale)}</span>
                            <span data-usage-source-subtotal className="font-semibold tabular-nums">{formatCostUsd(sourceSubtotal)}</span>
                            <Icon name="close" size={12} className="text-ink-faint" />
                          </button>
                          <button
                            type="button"
                            data-usage-open-sessions
                            onClick={() => { openTrace(undefined); }}
                            className="text-[12px] text-ink-soft underline decoration-hairline underline-offset-3 hover:text-ink"
                          >
                            {t('usage.sources.openSessions')}
                          </button>
                        </div>
                      ) : null}

                      {tab === 'sessions' && sessionLocator !== undefined ? (
                        <p className="ml-auto flex items-center gap-2 pb-1 text-[12px] text-ink-soft">
                          <span className="rounded-md bg-ink/[0.05] px-2 py-0.5 font-medium text-ink-soft">
                            {t('usage.sessions.deepLinkChip')}
                          </span>
                          <button type="button" className="text-ink-faint underline hover:text-ink" onClick={() => { setDismissedLocator(sessionLocator); }}>
                            {t('common.close')}
                          </button>
                        </p>
                      ) : tab === 'sources' ? (
                        <label className="ml-auto flex min-w-0 items-center pb-1.5">
                          <span className="sr-only">{t('usage.sources.search')}</span>
                          <input
                            type="search"
                            data-usage-source-search
                            value={sourceSearch}
                            placeholder={t('usage.sources.searchPlaceholder')}
                            onChange={(event) => { setSourceSearch(event.target.value); }}
                            className="h-7 w-40 max-w-full rounded-md border border-hairline bg-paper px-2.5 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-selected-ink"
                          />
                        </label>
                      ) : tab === 'sessions' ? (
                        <label className="ml-auto flex min-w-0 items-center pb-1.5">
                          <span className="sr-only">{t('usage.sessions.searchPlaceholder')}</span>
                          <input
                            type="search"
                            data-usage-sessions-search
                            aria-label={t('usage.sessions.searchPlaceholder')}
                            value={sessionSearch}
                            placeholder={t('usage.sessions.searchPlaceholder')}
                            onChange={(event) => { setSessionSearch(event.target.value); }}
                            className="h-7 w-44 max-w-full rounded-md border border-hairline bg-paper px-2.5 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-selected-ink"
                          />
                        </label>
                      ) : null}
                    </div>

                    {compareQuery.isError ? (
                      <p data-usage-compare-error className={NOTICE_AMBER}>
                        {t('usage.compare.loadFailed')}{' '}
                        <button
                          type="button"
                          onClick={() => { void compareQuery.refetch(); }}
                          className="underline underline-offset-2"
                        >
                          {t('usage.compare.retry')}
                        </button>
                      </p>
                    ) : null}

                    {tab === 'sources' ? (
                      <UsageSources
                        trend={sourceTrend}
                        groupBy={groupBy}
                        metric={metric}
                        prior={priorSource}
                        query={sourceSearch}
                        lookups={sourceLookups}
                        isFilterActive={(row) => isSourceRowFilterActive(filters, row.filter)}
                        onFilterSource={(row) => {
                          if (row.filter === null) return;
                          applyFilters(toggleSourceRowFilter(filters, row.filter));
                        }}
                        onOpenSessions={openTrace}
                      />
                    ) : tab === 'sessions' ? (
                      <SessionsTab
                        data={{ pages: usageData.pages }}
                        search={sessionSearch}
                        fetchNextPage={() => void fetchNextPage()}
                        hasNextPage={hasNextPage}
                        isFetchingNextPage={isFetchingNextPage}
                        isFetchNextPageError={isFetchNextPageError}
                        sessionLocator={sessionLocator}
                        locatorSearching={locatorSearching}
                        workspaceName={workspaceName}
                        summaryCost={summary?.cost_usd_estimated ?? 0}
                        scrollElementRef={scrollRef}
                      />
                    ) : tab === 'breakdown' && legacyDimension !== undefined ? (
                      <DimensionBreakdown
                        trend={trend}
                        dimension={legacyDimension}
                        labelFor={(row) => dimensionKeyLabelLegacy(row, legacyDimension, sourceLookups, sessionTitle)}
                      />
                    ) : null}
                  </section>
                ) : null}
              </div>
            ) : null}
            {trace !== undefined ? (
              <UsageSessionPanel
                request={trace}
                baseFilters={filters}
                timezoneOffsetMinutes={timezoneOffsetMinutes}
                workspaceName={workspaceName}
                onClose={() => { setTrace(undefined); }}
              />
            ) : null}
          </>}
        </div>
      </main>
    </div>
  );
}

function isUnsupportedUsageRead(error: unknown): boolean {
  return error instanceof ApiError && error.code === 40401;
}

const METRIC_SEARCH_TO_METRIC: Record<string, UsageMetric> = {
  cost: 'cost',
  tokens: 'tokens',
  cache: 'cache',
};

function sourceRowLabel(
  row: UsageSourceRow,
  groupBy: UsageGroupBy,
  lookups: { readonly unknownLabel: string; readonly workspaceName: (id: string) => string | undefined },
): string {
  if (row.key === USAGE_SOURCE_KEY_UNKNOWN || row.value === null) return lookups.unknownLabel;
  return groupBy === 'workspace' ? (lookups.workspaceName(row.value) ?? compactIdentifier(row.value)) : row.value;
}

function sourceKeyToLabel(
  key: string,
  groupBy: UsageGroupBy,
  trendGroupBySourceKey: ReadonlyMap<string, UsageTrendBucketWire['groups'][number]>,
  lookups: { readonly unknownLabel: string; readonly workspaceName: (id: string) => string | undefined },
): string {
  if (key === USAGE_SOURCE_KEY_UNKNOWN) return lookups.unknownLabel;
  const group = trendGroupBySourceKey.get(key);
  const value = group === undefined ? key : (usageSourceFilterValue(group, groupBy) ?? key);
  return groupBy === 'workspace' ? (lookups.workspaceName(value) ?? compactIdentifier(value)) : value;
}

function dimensionKeyLabelLegacy(
  row: { key: string; modelAlias: string | null; profileName: string | null; agentId: string | null },
  dimension: 'agent' | 'session',
  lookups: { readonly unknownLabel: string; readonly workspaceName: (id: string) => string | undefined },
  sessionTitle: (id: string) => string | undefined,
): string {
  if (row.key === 'unknown') return lookups.unknownLabel;
  if (dimension === 'agent') {
    return row.profileName ?? (row.agentId ? compactIdentifier(row.agentId) : null) ?? compactIdentifier(row.key);
  }
  return sessionTitle(row.key) ?? compactIdentifier(row.key);
}
