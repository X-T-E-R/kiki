/**
 * UsagePage (/usage) — the cross-session usage dashboard on `GET /api/usage`
 * (V2 aggregation). Reading order, top to bottom:
 *
 *   - a quiet live line (current session, today, burn rate);
 *   - the filter bar: time range first (the question most visits ask), then
 *     workspace, bucket size, breakdown axis, and the archived toggle; every
 *     axis rides the URL so views are deep-linkable, while query-less visits
 *     stay bounded to local today;
 *   - four KPIs: estimated cost, tokens, cache hit rate (cache read share of
 *     input, with the input composition), sessions;
 *   - the trend chart, stacked by the breakdown axis, with cost / tokens /
 *     cache-hit metrics; a bucket opens its session/turn drilldown;
 *   - detail tabs: Sessions (server-ranked by cost, the "most expensive
 *     session" drilldown), the breakdown (share, tokens, cache hit per key,
 *     agent trees, provider/role rollups), and the 5h rhythm.
 *
 * Reliability has one disclosure above the totals; details and missing-price
 * model lists stay collapsed until requested. Full rescans live in the filters.
 *
 * Honesty rules: the no-query state is local today; an explicit all-history
 * query surfaces the server's `defaulted_to_all_history` flag; cost is an
 * estimate flagged "partially unknown" whenever `cost_unknown` is set;
 * `unknown` keys and null provider/parent/profile render as missing data,
 * never reconstructed. Nothing here derives a number the server did not send.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import type { Session, Workspace } from '@kiki/protocol';

import { readLastSessionId } from '@kiki/session-core/settings';
import { formatCostUsd, formatGrouped } from '@kiki/session-core/util';
import { useI18n } from '../i18n';
import { RequestGovernanceView } from './RequestGovernanceView';
import { UsageNavigation, usagePanelFromSearch, type UsagePanel } from './UsageNavigation';
import { UsageExportPanel } from './usage/export/UsageExportPanel';
import { useThreadTitleResolver } from '../lib/threadTitles';
import { ThreadTitle } from './ThreadTitle';
import {
  bucketLabel,
  browserTimezoneOffsetMinutes,
  buildUsageApiQuery,
  burnRatePerHour,
  cacheHitRateOf,
  parseUsageDetailView,
  parseUsageFilters,
  searchHasUsageParams,
  totalTokensOf,
  usageDetailViewToSearch,
  usageFiltersToSearch,
  usageTokenTotalIsUnknown,
  USAGE_DIMENSIONS,
  USAGE_FILTER_DEFAULTS,
  USAGE_GRANULARITIES,
  USAGE_RANGE_PRESETS,
  writeStoredUsageFilters,
  type UsageDetailView,
  type UsageFilters,
  type UsageResponseWire,
  type UsageTrendBucketWire,
} from '../lib/usageV2';
import { useConnection } from '../state/connection';
import { Toggle } from './controls';
import { PageHeader } from './PageChrome';
import { PricingPanel } from './usage/PricingPanel';
import { UsageRescanControl } from './usage/UsageRescanControl';
import { UsageReliabilityDetails } from './usage/UsageReliabilityDetails';
import { segmentClass } from './WorkspaceScopeControl';
import { Icon } from './icons';
import { getCurrentVisit, getUiSnapshot, saveScrollPosition, saveUiSnapshot } from '../lib/navHistory';
import { DimensionBreakdown } from './usage/UsageBreakdown';
import { DrilldownPanel, DrilldownSessionList, TrendChart } from './usage/UsageTrend';
import {
  AxisGroup,
  bucketCost,
  bucketTokens,
  bucketTokenTotalIsUnknown,
  dimensionKeyLabel,
  formatPercent,
  hasUnknownTokenSubtotal,
  KnownSubtotalMarker,
  ShareBar,
  UsageCard,
} from './usage/usageShared';

const SESSION_PAGE_SIZE = 25;
const DAY_MS = 24 * 3600_000;

type DetailTab = 'sessions' | 'breakdown' | 'fiveHour';

const DETAIL_TAB_TO_VIEW: Record<DetailTab, UsageDetailView> = {
  sessions: 'sessions',
  breakdown: 'breakdown',
  fiveHour: 'five_hour',
};
const VIEW_TO_DETAIL_TAB: Record<UsageDetailView, DetailTab> = {
  sessions: 'sessions',
  breakdown: 'breakdown',
  five_hour: 'fiveHour',
};

const NOTICE_AMBER = 'rounded-lg border border-amber-rule/40 bg-amber-card px-3 py-2 text-[12.5px] leading-relaxed text-amber-ink';
const NOTICE_SOFT = 'rounded-lg border border-hairline bg-panel px-3 py-2 text-[12.5px] leading-relaxed text-ink-soft';

function toDateInputValue(ms: number | undefined): string {
  if (ms === undefined) return '';
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

function fromDateInputValue(value: string): number | undefined {
  if (value === '') return undefined;
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return undefined;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

function localDateKey(nowMs: number): string {
  const date = new Date(nowMs);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-');
}

// ---------------------------------------------------------------------------
// Live line — current session, today, burn rate
// ---------------------------------------------------------------------------

function LiveStrip() {
  const { client } = useConnection();
  const { t, time } = useI18n();
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => { setNowMs(Date.now()); }, 60_000);
    return () => { window.clearInterval(timer); };
  }, []);

  const todayQuery = useQuery({
    queryKey: ['usage-v2-strip'],
    queryFn: () =>
      client.getUsage(
        buildUsageApiQuery(
          { ...USAGE_FILTER_DEFAULTS, range: 'today', includeArchived: true },
          { timezoneOffsetMinutes: browserTimezoneOffsetMinutes(), pageSize: 1 },
        ),
      ),
    refetchInterval: 60_000,
  });
  const lastSessionId = useMemo(() => readLastSessionId(), []);
  const sessionQuery = useQuery({
    queryKey: ['usage-v2-strip-session', lastSessionId],
    queryFn: () => client.getSession(lastSessionId!),
    enabled: lastSessionId !== undefined,
    retry: false,
    staleTime: 30_000,
  });

  const today = todayQuery.data?.summary;
  const todayTokenTotalUnknown = today !== undefined && usageTokenTotalIsUnknown(today);
  const todayHasUnknownSubtotal = today !== undefined && hasUnknownTokenSubtotal(today);
  const knownTodayTokens = today === undefined || todayTokenTotalUnknown ? undefined : totalTokensOf(today);
  const rate = knownTodayTokens !== undefined ? burnRatePerHour(knownTodayTokens, nowMs) : undefined;
  const current: Session | undefined = sessionQuery.data;

  const item = (label: string, value: ReactNode, extra?: Record<string, boolean>) => (
    <span className="flex min-w-0 items-baseline gap-1.5" {...extra}>
      <span className="shrink-0 text-ink-faint">{label}</span>
      {value}
    </span>
  );

  return (
    <div
      data-usage-strip
      className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[12.5px]"
    >
      {item(t('usage.strip.currentSession'), current !== undefined ? (
        <>
          <span className="min-w-0 max-w-64 truncate text-ink">
            <ThreadTitle text={current.title.trim() !== '' ? current.title : t('sidebar.untitled')} />
          </span>
          <span className="shrink-0 font-mono text-ink-soft tabular-nums">
            {formatCostUsd(current.usage.total_cost_usd)}
          </span>
        </>
      ) : (
        <span className="text-ink-faint">—</span>
      ))}
      {item(t('usage.strip.today'), today !== undefined ? (
        <span data-usage-strip-tokens className="font-mono text-ink tabular-nums">
          {todayTokenTotalUnknown ? '—' : time.formatTokens(totalTokensOf(today))}
          {' · '}
          {todayTokenTotalUnknown ? '—' : formatCostUsd(today.cost_usd_estimated)}
          {todayHasUnknownSubtotal ? <KnownSubtotalMarker /> : null}
        </span>
      ) : (
        <span className="text-ink-faint">…</span>
      ))}
      {item(t('usage.strip.burnRate'), (
        <span className="font-mono text-ink tabular-nums">
          {rate !== undefined ? t('usage.strip.burnRateValue', { rate: formatGrouped(rate) }) : '…'}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

function FilterBar({
  filters,
  workspaces,
  onChange,
}: {
  filters: UsageFilters;
  workspaces: readonly Workspace[];
  onChange: (next: UsageFilters) => void;
}) {
  const { t } = useI18n();
  // Field-level guard for the custom range: an inverted pair is rejected
  // locally with an inline error instead of being sent (the server answers
  // 40001 and the page would degrade to a load failure).
  const [rangeInvalid, setRangeInvalid] = useState(false);
  const [actionsOnRangeRow, setActionsOnRangeRow] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const rangeRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const filter = filterRef.current;
    const range = rangeRef.current;
    const actions = actionsRef.current;
    if (filter === null || range === null || actions === null) return;
    const measure = () => {
      const gap = Number.parseFloat(getComputedStyle(filter).columnGap) || 0;
      const needed = range.getBoundingClientRect().width + actions.getBoundingClientRect().width + gap;
      setActionsOnRangeRow(needed > 0 && needed <= filter.clientWidth);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    for (const element of [filter, range, actions]) observer?.observe(element);
    return () => { observer?.disconnect(); };
  }, []);
  const dateInput = 'h-8 rounded-md border border-hairline bg-paper px-2 font-mono text-[12px] text-ink outline-none focus:border-selected-ink aria-[invalid=true]:border-danger';
  return (
    <div ref={filterRef} data-usage-filters data-actions-row={actionsOnRangeRow ? 'range' : 'secondary'} className="flex flex-wrap items-start gap-x-5 gap-y-3 border-b border-hairline pt-1 pb-4">
      <div className={actionsOnRangeRow ? 'max-w-full shrink-0' : 'w-full'}>
      <div ref={rangeRef} className="flex w-max max-w-full flex-wrap items-center gap-x-5 gap-y-2">
        <AxisGroup
          label={t('usage.axis.range')}
          dataAxis="range"
          options={USAGE_RANGE_PRESETS}
          value={filters.range}
          onChange={(range) => {
            setRangeInvalid(false);
            if (range === 'custom') {
              const today = new Date();
              today.setHours(0, 0, 0, 0);
              onChange({
                ...filters,
                range,
                startAt: filters.startAt ?? today.getTime() - 6 * DAY_MS,
                endAt: filters.endAt ?? today.getTime() + DAY_MS,
              });
            } else {
              onChange({ ...filters, range, startAt: undefined, endAt: undefined });
            }
          }}
          labelFor={(option) => t(`usage.range.${option}`)}
        />
        {filters.range === 'custom' ? (
          <div className="flex flex-wrap items-center gap-1.5" data-usage-custom-range>
            <input
              type="date"
              aria-label={t('usage.customRange.start')}
              aria-invalid={rangeInvalid}
              value={toDateInputValue(filters.startAt)}
              max={toDateInputValue(filters.endAt !== undefined ? filters.endAt - DAY_MS : undefined)}
              onChange={(event) => {
                const startAt = fromDateInputValue(event.target.value);
                if (startAt === undefined) return;
                if (filters.endAt !== undefined && startAt >= filters.endAt) {
                  setRangeInvalid(true);
                  return;
                }
                setRangeInvalid(false);
                onChange({ ...filters, startAt });
              }}
              className={dateInput}
            />
            <Icon name="arrowRight" size={12} className="text-ink-faint" />
            <input
              type="date"
              aria-label={t('usage.customRange.end')}
              aria-invalid={rangeInvalid}
              value={toDateInputValue(filters.endAt !== undefined ? filters.endAt - DAY_MS : undefined)}
              min={toDateInputValue(filters.startAt)}
              onChange={(event) => {
                const day = fromDateInputValue(event.target.value);
                if (day === undefined) return;
                const endAt = day + DAY_MS;
                if (filters.startAt !== undefined && endAt <= filters.startAt) {
                  setRangeInvalid(true);
                  return;
                }
                setRangeInvalid(false);
                onChange({ ...filters, endAt });
              }}
              className={dateInput}
            />
            {rangeInvalid ? (
              <p role="alert" data-usage-range-error className="text-[12px] text-danger">
                {t('usage.customRange.invalid')}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      </div>
      <div className={`flex max-w-full shrink-0 flex-wrap items-center gap-x-5 gap-y-2 ${actionsOnRangeRow ? 'order-2 w-full' : ''}`}>
        <label className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-[12px] text-ink-faint">{t('usage.workspace.label')}</span>
          <span className="relative min-w-0">
            <select
              data-usage-workspace
              value={filters.workspaceId ?? ''}
              onChange={(event) => {
                onChange({ ...filters, workspaceId: event.target.value === '' ? undefined : event.target.value });
              }}
              className={`${segmentClass(filters.workspaceId !== undefined, 'h-8 max-w-52 pr-7 pl-3 text-[13px]')} cursor-pointer appearance-none truncate border border-hairline bg-paper`}
            >
              <option value="">{t('usage.workspace.all')}</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
              ))}
            </select>
            <Icon name="chevron" size={12} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 rotate-90 text-ink-faint" />
          </span>
        </label>
        <AxisGroup
          label={t('usage.axis.granularity')}
          dataAxis="granularity"
          options={USAGE_GRANULARITIES}
          value={filters.granularity}
          onChange={(granularity) => { onChange({ ...filters, granularity }); }}
          labelFor={(option) => t(`usage.granularity.${option}`)}
        />
        <AxisGroup
          label={t('usage.axis.dimension')}
          dataAxis="dimension"
          options={USAGE_DIMENSIONS}
          value={filters.dimension}
          onChange={(dimension) => { onChange({ ...filters, dimension }); }}
          labelFor={(option) => t(`usage.dimension.${option}`)}
        />
      </div>
      <div ref={actionsRef} className="ml-auto max-w-full shrink-0">
        <UsageRescanControl>
          <Toggle
            label={t('usage.includeArchived')}
            checked={filters.includeArchived}
            onChange={(includeArchived) => { onChange({ ...filters, includeArchived }); }}
          />
        </UsageRescanControl>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI row
// ---------------------------------------------------------------------------

function Kpi({ label, value, hint, dataValue, children }: {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: ReactNode;
  readonly dataValue?: string;
  readonly children?: ReactNode;
}) {
  const valueProps = dataValue === undefined ? {} : { [dataValue]: true };
  return (
    <section className="flex min-w-0 flex-col py-3">
      <p className="text-[11.5px] text-ink-faint">{label}</p>
      <p {...valueProps} className="mt-2 truncate font-mono text-[26px] leading-none tracking-tight text-ink tabular-nums">
        {value}
      </p>
      {hint !== undefined ? <div className="mt-2 text-[12px] leading-snug">{hint}</div> : null}
      {children}
    </section>
  );
}

function KpiRow({ summary }: { readonly summary: UsageResponseWire['summary'] }) {
  const { t, time } = useI18n();
  const totalUnknown = usageTokenTotalIsUnknown(summary);
  const cacheHit = cacheHitRateOf(summary);
  const input = summary.tokens.input_other + summary.tokens.input_cache_read + summary.tokens.input_cache_creation;
  const composition = [
    { key: 'read', label: t('usage.tokens.cacheRead'), value: summary.tokens.input_cache_read, fill: 'bg-success/70' },
    { key: 'write', label: t('usage.tokens.cacheWrite'), value: summary.tokens.input_cache_creation, fill: 'bg-amber-rule' },
    { key: 'fresh', label: t('usage.composition.fresh'), value: summary.tokens.input_other, fill: 'bg-hairline-strong' },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Kpi
        label={t('usage.kpi.estimatedCost')}
        dataValue="data-usage-summary-cost"
        value={totalUnknown ? '—' : formatCostUsd(summary.cost_usd_estimated)}
        hint={!summary.cost_unknown && summary.session_count > 0 && !totalUnknown ? (
          <span className="text-ink-faint">
            {t('usage.kpi.perSession', { cost: formatCostUsd(summary.cost_usd_estimated / summary.session_count) })}
          </span>
        ) : undefined}
      />
      <Kpi
        label={t('usage.card.tokens')}
        dataValue="data-usage-summary-tokens"
        value={totalUnknown ? '—' : time.formatTokens(totalTokensOf(summary))}
        hint={(
          <span data-usage-summary-input-output className="font-mono text-ink-faint tabular-nums">
            {totalUnknown
              ? '— / —'
              : t('usage.kpi.inputOutput', {
                  input: time.formatTokens(input),
                  output: time.formatTokens(summary.tokens.output),
                })}
          </span>
        )}
      />
      <Kpi
        label={t('usage.kpi.cacheHit')}
        dataValue="data-usage-summary-cache"
        value={totalUnknown ? '—' : formatPercent(cacheHit)}
        hint={cacheHit === null && !totalUnknown ? <span className="text-ink-faint">{t('usage.kpi.cacheHitNone')}</span> : undefined}
      >
        {!totalUnknown && input > 0 ? (
          <div className="mt-2" title={t('usage.cacheHitHint')}>
            <div aria-hidden className="flex h-1.5 overflow-hidden rounded-full bg-hairline/70">
              {composition.map((part) => (
                <span key={part.key} className={part.fill} style={{ width: `${(part.value / input) * 100}%` }} />
              ))}
            </div>
            <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-ink-faint">
              {composition.map((part) => (
                <li key={part.key} className="inline-flex items-center gap-1">
                  <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${part.fill}`} />
                  {part.label} <span className="font-mono tabular-nums">{time.formatTokens(part.value)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Kpi>
      <Kpi
        label={t('usage.card.sessions')}
        value={formatGrouped(summary.session_count)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sessions tab — server-ranked by cost, so row one is the most expensive
// ---------------------------------------------------------------------------

function SessionsTab({
  data,
  fetchNextPage,
  hasNextPage,
  isFetchingNextPage,
  sessionLocator,
  locatorSearching,
  workspaceName,
  summaryCost,
}: {
  data: { pages: readonly UsageResponseWire[] };
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  sessionLocator: string | undefined;
  /** True while the locator walk is still pulling pages for the target. */
  locatorSearching: boolean;
  workspaceName: (id: string) => string;
  summaryCost: number;
}) {
  const { t, time } = useI18n();
  const navigate = useNavigate();
  const items = useMemo(() => data.pages.flatMap((page) => page.sessions.items), [data.pages]);
  const total = data.pages[0]?.sessions.total ?? items.length;
  const located = sessionLocator !== undefined && items.some((item) => item.id === sessionLocator);
  const visible = sessionLocator !== undefined && located
    ? items.filter((item) => item.id === sessionLocator)
    : items;
  const grid = 'grid grid-cols-[1.75rem_minmax(0,1fr)_5.5rem] items-center gap-x-3 sm:grid-cols-[1.75rem_minmax(0,1fr)_8rem_4.5rem_4rem_5rem_5.5rem]';

  return (
    <div data-usage-sessions>
      {sessionLocator !== undefined && !located ? (
        locatorSearching ? (
          <p data-usage-locating className={`mb-3 flex items-center gap-2 ${NOTICE_SOFT}`}>
            <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
            {t('usage.sessions.locating')}
          </p>
        ) : (
          <p className={`mb-3 ${NOTICE_AMBER}`}>{t('usage.sessions.notInPage')}</p>
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
        <p className="py-8 text-center text-[13px] text-ink-faint">{t('usage.empty')}</p>
      ) : (
        <ol className="divide-y divide-hairline border-t border-hairline">
          {visible.map((item) => {
            const rank = items.indexOf(item) + 1;
            const unknownTotal = usageTokenTotalIsUnknown(item.usage);
            const share = summaryCost > 0 ? item.usage.cost_usd_estimated / summaryCost : 0;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  data-usage-session={item.id}
                  onClick={() => void navigate(`/s/${item.id}`)}
                  className={`${grid} w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-paper focus-visible:outline-2 focus-visible:outline-selected-ink`}
                >
                  <span className={`text-right font-mono text-[12px] tabular-nums ${rank <= 3 ? 'font-semibold text-ink' : 'text-ink-faint'}`}>
                    {rank}
                  </span>
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 truncate text-[13px] text-ink"><ThreadTitle text={item.title ?? t('sidebar.untitled')} /></span>
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
                    <span className="mt-1 block w-full max-w-48"><ShareBar ratio={share} tone="bg-accent/70" /></span>
                  </span>
                  <span className="hidden truncate text-[12px] text-ink-soft sm:block" title={item.workspace_id}>
                    {workspaceName(item.workspace_id)}
                  </span>
                  <span data-usage-session-tokens={item.id} className="hidden text-right font-mono text-[12px] text-ink-soft tabular-nums sm:block">
                    {unknownTotal ? '—' : time.formatTokens(totalTokensOf(item.usage))}
                    {hasUnknownTokenSubtotal(item.usage) ? <KnownSubtotalMarker /> : null}
                  </span>
                  <span className="hidden text-right font-mono text-[12px] text-ink-soft tabular-nums sm:block">
                    {unknownTotal ? '—' : formatPercent(cacheHitRateOf(item.usage))}
                  </span>
                  <span className="hidden text-right text-[12px] text-ink-faint sm:block">
                    {time.relativeTime(new Date(item.updated_at).toISOString())}
                  </span>
                  <span data-usage-session-cost={item.id} className="text-right font-mono text-[13px] font-semibold text-ink tabular-nums">
                    {unknownTotal ? '—' : formatCostUsd(item.usage.cost_usd_estimated)}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {hasNextPage ? (
        <button
          type="button"
          data-usage-load-more
          onClick={fetchNextPage}
          disabled={isFetchingNextPage}
          className="mt-3 h-9 w-full rounded-md border border-hairline text-[13px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:opacity-50"
        >
          {t('usage.sessions.loadMore', { shown: items.length, total })}
        </button>
      ) : null}
    </div>
  );
}

/**
 * 5h rhythm tab: each window lists its sessions and per-turn locators from
 * the bucket's server drilldown, newest first. Without the 5h granularity
 * there is no honest data, so the tab offers the switch instead.
 */
function FiveHourTab({
  trend,
  filters,
  onSwitchGranularity,
  sessionTitle,
}: {
  trend: readonly UsageTrendBucketWire[];
  filters: UsageFilters;
  onSwitchGranularity: () => void;
  sessionTitle: (id: string) => string | undefined;
}) {
  const { t, locale, time } = useI18n();
  if (filters.granularity !== 'five_hour') {
    return (
      <div className="flex flex-col items-start gap-2 py-6" data-usage-fivehour-hint>
        <p className="text-[13px] text-ink-soft">{t('usage.fiveHour.hint')}</p>
        <button
          type="button"
          onClick={onSwitchGranularity}
          className="h-8 rounded-md border border-hairline bg-paper px-3 text-[13px] font-medium text-ink transition-colors hover:border-hairline-strong hover:text-ink"
        >
          {t('usage.fiveHour.switch')}
        </button>
      </div>
    );
  }
  const windows = [...trend].reverse();
  if (windows.length === 0) {
    return <p className="py-8 text-center text-[13px] text-ink-faint">{t('usage.empty')}</p>;
  }
  return (
    <ol className="space-y-3" data-usage-fivehour>
      {windows.map((bucket) => {
        const unknownTotal = bucketTokenTotalIsUnknown(bucket);
        return (
          <li
            key={bucket.key}
            data-usage-fivehour-window={bucket.key}
            className="rounded-lg border border-hairline bg-paper/50 px-3 pt-2 pb-1"
          >
            <header className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <h3 className="font-mono text-[12.5px] font-semibold text-ink tabular-nums">
                {bucketLabel(bucket, 'five_hour', locale)}
              </h3>
              <span className="ml-auto font-mono text-[12px] text-ink-soft tabular-nums">
                {unknownTotal ? '—' : time.formatTokens(bucketTokens(bucket))} {t('usage.col.tokens')}
                {bucket.groups.some((group) => group.tokens_unknown === true) ? <KnownSubtotalMarker /> : null}
              </span>
              <span className="font-mono text-[12.5px] font-semibold text-ink tabular-nums">
                {unknownTotal ? '—' : formatCostUsd(bucketCost(bucket))}
              </span>
            </header>
            {bucket.drilldown.sessions.length === 0 ? (
              <p className="py-2 text-[12.5px] text-ink-faint">{t('usage.empty')}</p>
            ) : (
              <DrilldownSessionList sessions={bucket.drilldown.sessions} sessionTitle={sessionTitle} />
            )}
            {bucket.drilldown.sessions_truncated ? (
              <p className="pb-2 text-[12px] text-amber-ink">{t('usage.drilldown.sessionsTruncated')}</p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function UsagePage({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { client } = useConnection();
  const { t } = useI18n();
  const location = useLocation();
  const [, setSearchParams] = useSearchParams();
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

  // URL query is the canonical filter state (deep-linkable). A query-less
  // visit always uses the local-today defaults; persisted selections never
  // silently widen or hide this bounded result set.
  const filters = useMemo<UsageFilters>(
    () => (searchHasUsageParams(location.search) ? parseUsageFilters(location.search) : USAGE_FILTER_DEFAULTS),
    [location.search],
  );
  useEffect(() => {
    writeStoredUsageFilters(filters);
  }, [filters]);

  // Today and local bucket boundaries change with the wall clock and browser
  // timezone: read the offset on every render; the minute tick makes
  // midnight/zone changes observable.
  const localUsageDate = localDateKey(usageNowMs);
  const timezoneOffsetMinutes = browserTimezoneOffsetMinutes();

  const sessionParam = new URLSearchParams(location.search).get('session') ?? undefined;
  const [dismissedLocator, setDismissedLocator] = useState<string | null>(null);
  const sessionLocator = sessionParam !== undefined && sessionParam !== dismissedLocator ? sessionParam : undefined;

  // The detail tab rides the URL (`view=`); a session locator without an
  // explicit view pins the sessions tab so the located row is on screen.
  const hasExplicitView = new URLSearchParams(location.search).has('view');
  const tab: DetailTab = sessionLocator !== undefined && !hasExplicitView
    ? 'sessions'
    : VIEW_TO_DETAIL_TAB[parseUsageDetailView(location.search)];
  const scrollRef = useRef<HTMLElement | null>(null);
  const restoredVisitRef = useRef<string | null>(null);
  const [pendingScrollRestore, setPendingScrollRestore] = useState<number | null>(null);

  // Read the target visit after App's layout transition, not the visit left.
  // Restore scroll after the selected bucket/data have expanded the content.
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
    const visit = getCurrentVisit();
    if (visit) {
      saveUiSnapshot(visit.visitId, { selectedBucketKey: key });
    }
  };

  const handleScroll = () => {
    if (pendingScrollRestore !== null) return;
    const cur = getCurrentVisit();
    if (cur && scrollRef.current) {
      saveUiSnapshot(cur.visitId, { scrollTop: scrollRef.current.scrollTop });
      saveScrollPosition(cur.visitId, 'main[data-usage-scroll]', scrollRef.current.scrollTop);
    }
  };

  const selectTab = (next: DetailTab) => {
    setSearchParams(new URLSearchParams(usageDetailViewToSearch(DETAIL_TAB_TO_VIEW[next], location.search)), { replace: true });
  };
  const [selectedBucketKey, setSelectedBucketKey] = useState<string | null>(null);
  const filterKey = usageFiltersToSearch(filters);
  const previousFilters = useRef<{ key: string; visitId?: string }>({ key: filterKey });
  // Only a real filter change within this visit invalidates a bucket, not
  // mount/POP restoration or a panel/tab change with the same query conditions.
  useEffect(() => {
    const visit = getCurrentVisit();
    const changed = previousFilters.current.key !== filterKey;
    const sameVisit = previousFilters.current.visitId === visit?.visitId;
    previousFilters.current = { key: filterKey, visitId: visit?.visitId };
    if (!changed || !sameVisit) return;
    setSelectedBucketKey(null);
    if (visit) saveUiSnapshot(visit.visitId, { selectedBucketKey: null });
  }, [filterKey, location.key]);

  const applyFilters = (next: UsageFilters) => {
    writeStoredUsageFilters(next);
    // New conditions → new result set → the old page token drops with the
    // react-query key; the session locator survives in the URL.
    setSearchParams(new URLSearchParams(usageFiltersToSearch(next, location.search)), { replace: true });
  };

  const usageQuery = useInfiniteQuery({
    queryKey: ['usage-v2', filters, localUsageDate, timezoneOffsetMinutes],
    enabled: panel === 'history',
    queryFn: ({ pageParam }) =>
      client.getUsage(
        buildUsageApiQuery(filters, { timezoneOffsetMinutes, pageSize: SESSION_PAGE_SIZE, pageToken: pageParam }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.sessions.has_more ? (lastPage.sessions.next_page_token ?? undefined) : undefined,
  });
  // A session locator must find its target beyond the first page: keep
  // pulling pages until it appears or the set is exhausted (a failed page
  // stops the walk). `usageQuery.data` is a dep so every arrived page
  // re-evaluates, even when the fetching flags flip within one render.
  const locatedSession =
    sessionLocator !== undefined &&
    (usageQuery.data?.pages.some((page) => page.sessions.items.some((item) => item.id === sessionLocator)) ?? false);
  const locatorSearching =
    sessionLocator !== undefined &&
    !locatedSession &&
    !usageQuery.isFetchNextPageError &&
    (usageQuery.hasNextPage || usageQuery.isFetchingNextPage);
  useEffect(() => {
    if (sessionLocator === undefined || locatedSession || usageQuery.isFetchNextPageError) return;
    if (usageQuery.hasNextPage && !usageQuery.isFetchingNextPage) {
      void usageQuery.fetchNextPage();
    }
  }, [
    sessionLocator,
    locatedSession,
    usageQuery.data,
    usageQuery.hasNextPage,
    usageQuery.isFetchingNextPage,
    usageQuery.isFetchNextPageError,
    usageQuery.fetchNextPage,
  ]);
  // Trend / summary / reliability are page-invariant; read them off page one.
  const firstPage = usageQuery.data?.pages[0];
  const trend = useMemo(() => firstPage?.trend ?? [], [firstPage]);
  const selectedBucket = trend.find((bucket) => bucket.key === selectedBucketKey);
  useLayoutEffect(() => {
    if (pendingScrollRestore === null || !scrollRef.current) return;
    if (pendingScrollRestore > 0 && panel === 'history' && firstPage === undefined && !usageQuery.isError) return;
    scrollRef.current.scrollTop = pendingScrollRestore;
    setPendingScrollRestore(null);
  }, [pendingScrollRestore, panel, firstPage, selectedBucketKey, usageQuery.isError]);

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
    staleTime: 30_000,
  });
  const workspaces = useMemo(() => workspacesQuery.data?.items ?? [], [workspacesQuery.data]);

  // Name lookups: workspaces from the registry, session titles from the rows
  // the server already returned for this result set (never fetched per id).
  const workspaceNames = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])), [workspaces]);
  const sessionTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const page of usageQuery.data?.pages ?? []) {
      for (const item of page.sessions.items) if (item.title !== null) map.set(item.id, item.title);
    }
    return map;
  }, [usageQuery.data]);
  const resolveTitle = useThreadTitleResolver([...sessionTitles.values()]);
  const workspaceName = (id: string) => workspaceNames.get(id);
  const sessionTitle = (id: string) => {
    const title = sessionTitles.get(id);
    return title === undefined ? undefined : resolveTitle(title);
  };
  const lookups = { unknownLabel: t('usage.dim.unknown'), workspaceName, sessionTitle };

  const summary = firstPage?.summary;
  const reliability = firstPage?.reliability;
  const unpricedCount = reliability?.unknown_price_models.length ?? 0;
  const [pricingOpen, setPricingOpen] = useState(false);
  const showAllHistoryChip = firstPage?.query.range.defaulted_to_all_history === true;
  const breakdownTabLabel = t(`usage.dimension.${filters.dimension}`);
  const tabs = [
    ['sessions', t('usage.tab.sessions')],
    ['breakdown', breakdownTabLabel],
    ['fiveHour', t('usage.tab.fiveHour')],
  ] as const;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-paper">
      <PageHeader title={t('usage.title')} onToggleSidebar={onToggleSidebar}>
        <button
          type="button"
          data-usage-pricing-open
          aria-haspopup="dialog"
          onClick={() => { setPricingOpen(true); }}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-11"
        >
          <Icon name="sliders" size={14} />
          {t('usage.pricing.open')}
          {unpricedCount > 0 ? <span className="text-[12px] text-amber-ink tabular-nums">{unpricedCount}</span> : null}
        </button>
      </PageHeader>
      {pricingOpen ? (
        <PricingPanel models={reliability?.unknown_price_models ?? []} onClose={() => { setPricingOpen(false); }} />
      ) : null}
      <main ref={scrollRef} onScroll={handleScroll} data-usage-scroll style={{ overflowAnchor: 'none' }} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pt-4 pb-10 lg:px-8">
        <div className="mx-auto max-w-[1120px] space-y-4" data-usage-page>
          <UsageNavigation panel={panel} onChange={selectPanel} />
          {panel === 'export' ? <UsageExportPanel /> : panel !== 'history' ? <RequestGovernanceView view={new URLSearchParams(location.search).get('panel') === 'limits' ? 'limits' : 'realtime'} /> : <>
          <LiveStrip />
          <FilterBar filters={filters} workspaces={workspaces} onChange={applyFilters} />
          {usageQuery.isPending ? (
            <div role="status" className="flex items-center justify-center gap-2 rounded-xl border border-hairline bg-panel px-4 py-12 text-[13px] text-ink-faint">
              <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
              {t('usage.loading')}
            </div>
          ) : usageQuery.isError ? (
            <div className="rounded-xl border border-danger/30 bg-danger/5 p-5">
              <p className="text-[13px] font-medium text-danger">{t('usage.loadFailed')}</p>
              <p className="mt-1 font-mono text-[12px] text-danger/80">
                {usageQuery.error instanceof Error ? usageQuery.error.message : t('common.unknownError')}
              </p>
              <button
                type="button"
                onClick={() => void usageQuery.refetch()}
                className="mt-3 h-8 rounded-md border border-danger/40 px-3 text-[13px] font-medium text-danger hover:bg-danger/5"
              >
                {t('common.retry')}
              </button>
            </div>
          ) : firstPage !== undefined ? (
            <>
              <div className="flex flex-wrap items-start gap-x-4 gap-y-1">
                <div className="min-w-0 flex-1">
                  <UsageReliabilityDetails summary={firstPage.summary} reliability={firstPage.reliability} />
                </div>
                {showAllHistoryChip ? (
                  <span data-usage-all-history className="py-2 text-[11.5px] text-ink-faint">
                    {t('usage.allHistoryChip')}
                  </span>
                ) : null}
              </div>

              {summary !== undefined ? <KpiRow summary={summary} /> : null}

              {trend.length === 0 ? (
                <p className="rounded-xl border border-hairline bg-panel px-4 py-12 text-center text-[13px] text-ink-faint">
                  {t('usage.empty')}
                </p>
              ) : (
                <TrendChart
                  trend={trend}
                  filters={filters}
                  selectedKey={selectedBucketKey}
                  onSelect={selectBucketKeyWithSnapshot}
                  labelForKey={(key) => {
                    const group = trend.flatMap((bucket) => bucket.groups).find((entry) => entry.key === key);
                    return dimensionKeyLabel(
                      { key, modelAlias: group?.model_alias ?? null, profileName: group?.profile_name ?? null, agentId: group?.agent_id ?? null },
                      filters.dimension,
                      lookups,
                    );
                  }}
                />
              )}
              {selectedBucket !== undefined ? (
                <DrilldownPanel
                  bucket={selectedBucket}
                  filters={filters}
                  sessionTitle={sessionTitle}
                  onClose={() => { selectBucketKeyWithSnapshot(null); }}
                />
              ) : null}

              <UsageCard>
                <div className="-mt-1 mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-hairline">
                  <div role="tablist" aria-label={t('usage.title')} className="flex gap-1" data-usage-tabs>
                    {tabs.map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={tab === id}
                        data-usage-tab={id}
                        onClick={() => { selectTab(id); }}
                        className={`-mb-px min-h-10 border-b-2 px-3 text-[13.5px] transition-colors ${
                          tab === id ? 'border-selected-ink font-semibold text-ink' : 'border-transparent text-ink-soft hover:text-ink'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {tab === 'sessions' && sessionLocator !== undefined ? (
                    <p className="ml-auto flex items-center gap-2 pb-1 text-[12px] text-ink-soft">
                      <span className="rounded-md bg-ink/[0.05] px-2 py-0.5 font-medium text-ink-soft">
                        {t('usage.sessions.deepLinkChip')}
                      </span>
                      <button type="button" className="text-ink-faint underline hover:text-ink" onClick={() => { setDismissedLocator(sessionLocator); }}>
                        {t('common.close')}
                      </button>
                    </p>
                  ) : null}
                </div>
                {tab === 'sessions' ? (
                  <SessionsTab
                    data={{ pages: usageQuery.data.pages }}
                    fetchNextPage={() => void usageQuery.fetchNextPage()}
                    hasNextPage={usageQuery.hasNextPage}
                    isFetchingNextPage={usageQuery.isFetchingNextPage}
                    sessionLocator={sessionLocator}
                    locatorSearching={locatorSearching}
                    workspaceName={(id) => workspaceName(id) ?? id}
                    summaryCost={summary?.cost_usd_estimated ?? 0}
                  />
                ) : tab === 'breakdown' ? (
                  <DimensionBreakdown
                    trend={trend}
                    filters={filters}
                    labelFor={(row) => dimensionKeyLabel(row, filters.dimension, lookups)}
                  />
                ) : (
                  <FiveHourTab
                    trend={trend}
                    filters={filters}
                    sessionTitle={sessionTitle}
                    onSwitchGranularity={() => { applyFilters({ ...filters, granularity: 'five_hour' }); }}
                  />
                )}
              </UsageCard>

            </>
          ) : null}
          </>}
        </div>
      </main>
    </div>
  );
}
