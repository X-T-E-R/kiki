/**
 * UsagePage (/usage) — the Activity & cross-session usage surface. A bare
 * `/usage` visit opens Live (`realtime`), with Usage (`history`) and Quotas
 * (`quota`) as sibling tabs, while model prices and export sit behind the
 * header's `⋯`.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { ErrorCode, type Session } from '@kiki/protocol';

import { formatBytes } from '@kiki/session-core/composer/media';
import { readLastSessionId } from '@kiki/session-core/settings';
import { spaceStorageKey } from '@kiki/session-core/storage';
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
  burnRatePerHour,
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
  usageWindowLabel,
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
import { QuotaHeadroomStrip } from './usage/QuotaHeadroomStrip';
import { DimensionBreakdown } from './usage/UsageBreakdown';
import { UsageFilterBar } from './usage/UsageFilterBar';
import { UsageReliabilityDetails } from './usage/UsageReliabilityDetails';
import { UsageRescanControl } from './usage/UsageRescanControl';
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
const TOP_SESSIONS_OVERVIEW_LIMIT = 6;

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

/** How old a shared governance read may be and still be told as "now". */
const LIVE_BAND_FRESH_MS = 5_000;

function LiveBand({ onOpen }: { readonly onOpen: () => void }) {
  const { client, scopeId } = useConnection();
  const { t, time } = useI18n();
  const live = useQuery({
    queryKey: ['request-governance', scopeId],
    queryFn: () => client.getRequestGovernance(),
    enabled: false,
  });
  const snapshot = live.data;
  if (snapshot === undefined || live.isError || Date.now() - live.dataUpdatedAt > LIVE_BAND_FRESH_MS) return null;
  if (snapshot.active === 0 && snapshot.queued === 0) return null;
  const waiting = snapshot.waiting.reduce<(typeof snapshot.waiting)[number] | undefined>(
    (longest, row) => (longest === undefined || row.waitedMs > longest.waitedMs ? row : longest),
    undefined,
  );
  return (
    <p data-usage-live-band role="status" className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12.5px] text-ink-soft">
      <span className="text-ink">{t('usage.live.band', { active: snapshot.active, queued: snapshot.queued })}</span>
      {waiting !== undefined ? (
        <span className="min-w-0 text-ink-faint">
          {waiting.modelId}
          {waiting.blockingRules.length > 0 ? ` ${t('usage.governance.blockedBy', { rules: waiting.blockingRules.join(', ') })}` : ''}
          {` · ${time.formatDuration(waiting.waitedMs)}`}
        </span>
      ) : null}
      <button
        type="button"
        data-usage-live-band-open
        onClick={onOpen}
        className="inline-flex min-h-8 items-center gap-1 rounded-sm font-medium text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
      >
        {t('usage.governance.realtime')}
        <Icon name="arrowRight" size={12} />
      </button>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Editorial 4-column KPI band
// ---------------------------------------------------------------------------

function Kpi({ id, label, value, hint, dataValue, children }: {
  readonly id: string;
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: ReactNode;
  readonly dataValue?: string;
  readonly children?: ReactNode;
}) {
  const valueProps = dataValue === undefined ? {} : { [dataValue]: true };
  return (
    <section
      data-usage-kpi={id}
      className="flex min-w-0 flex-col py-1 lg:px-5 first:lg:pl-0 last:lg:pr-0"
    >
      <p className="text-[11.5px] font-medium tracking-[-0.005em] text-ink-faint">{label}</p>
      <div
        {...valueProps}
        className="mt-1.5 flex min-w-0 items-baseline gap-2 truncate font-display text-[27px] leading-none tracking-tight text-ink tabular-nums"
      >
        {value}
      </div>
      {hint !== undefined ? <div className="mt-2 text-[12px] leading-snug">{hint}</div> : null}
      {children}
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
  todayResponse,
  reuseTodaySummary,
  enabled,
}: {
  readonly summary: UsageResponseWire['summary'];
  readonly trend: readonly UsageTrendBucketWire[];
  readonly incomplete: boolean;
  readonly comparing: boolean;
  readonly prior: UsageResponseWire['summary'] | undefined;
  readonly unpricedCount: number;
  readonly onOpenPricing: () => void;
  readonly cacheSavingsUsd: number | undefined;
  readonly todayResponse: UsageResponseWire | undefined;
  readonly reuseTodaySummary: boolean;
  readonly enabled: boolean;
}) {
  const { client, scopeId } = useConnection();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { t, tp, time } = useI18n();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [lastSessionId, setLastSessionId] = useState<string | undefined>(() => readLastSessionId());

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => { setNowMs(Date.now()); }, 60_000);
    return () => { window.clearInterval(timer); };
  }, [enabled]);

  useEffect(() => {
    const syncLastSession = (event?: StorageEvent) => {
      const key = event?.key;
      const currentKey = spaceStorageKey('kiki.lastSessionId');
      if (key !== undefined && key !== null && key !== 'kiki.lastSessionId' && key !== currentKey && !key.startsWith('kiki.space.')) return;
      const next = readLastSessionId();
      setLastSessionId((current) => (current === next ? current : next));
    };
    const onStorage = (event: StorageEvent) => { syncLastSession(event); };
    window.addEventListener('storage', onStorage);
    syncLastSession();
    return () => { window.removeEventListener('storage', onStorage); };
  }, [scopeId]);

  const todayQuery = useQuery({
    queryKey: ['usage-v2-strip', scopeId, localDateKey(nowMs), browserTimezoneOffsetMinutes()],
    enabled: enabled && !incomplete && !reuseTodaySummary && todayResponse === undefined,
    queryFn: ({ signal }) =>
      client.getUsage(
        buildUsageMultiApiQuery(
          { ...USAGE_MULTI_FILTER_DEFAULTS, range: 'today', includeArchived: true },
          { timezoneOffsetMinutes: browserTimezoneOffsetMinutes(), pageSize: 1 },
        ),
        { signal },
      ),
    refetchInterval: (query) => {
      if (!enabled || incomplete || reuseTodaySummary) return false;
      const response = query.state.data;
      const continueCounting = response !== undefined && !response.reliability.complete &&
        (response.reliability.incomplete_reason === 'deadline' || response.reliability.incomplete_reason === 'record_budget');
      return continueCounting ? 250 : 60_000;
    },
    staleTime: 30_000,
  });

  const sessionQuery = useQuery({
    queryKey: ['usage-v2-strip-session', scopeId, lastSessionId],
    queryFn: ({ signal }) => client.getSession(lastSessionId!, { signal }),
    enabled: enabled && lastSessionId !== undefined,
    retry: false,
    staleTime: 30_000,
  });

  useEffect(() => {
    return () => { void queryClient.cancelQueries({ queryKey: ['usage-v2-strip-session', scopeId, lastSessionId] }); };
  }, [scopeId, lastSessionId, queryClient]);

  useEffect(() => {
    if (enabled) return;
    void queryClient.cancelQueries({ queryKey: ['usage-v2-strip-session', scopeId, lastSessionId] });
  }, [enabled, scopeId, lastSessionId, queryClient]);

  const costUnknown = summary.cost_unknown || incomplete;
  const tokensUnknown = usageTokenTotalIsUnknown(summary) || (incomplete && totalTokensOf(summary) === 0);
  const cacheHit = cacheHitRateOf(summary);
  const input = summary.tokens.input_other + summary.tokens.input_cache_read + summary.tokens.input_cache_creation;
  const composition = [
    { key: 'read', label: t('usage.tokens.cacheRead'), value: summary.tokens.input_cache_read, fill: 'bg-success/75' },
    { key: 'write', label: t('usage.tokens.cacheWrite'), value: summary.tokens.input_cache_creation, fill: 'bg-amber-rule' },
    { key: 'fresh', label: t('usage.composition.fresh'), value: summary.tokens.input_other, fill: 'bg-ink/30' },
  ];

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

  const todayData = todayResponse ?? todayQuery.data;
  const todaySummary = todayData?.summary;
  const todayIncomplete = todayData?.reliability.complete === false;
  const todayProgress = importProgressOf(todayData);
  const todayCountingLabel = todayProgress === undefined
    ? t('usage.strip.counting')
    : t('usage.strip.countingProgress', {
        verified: formatGrouped(todayProgress.verified_sources),
        total: formatGrouped(todayProgress.total_sources),
      });
  const todayTokenTotalUnknown = todaySummary !== undefined && usageTokenTotalIsUnknown(todaySummary);
  const todayKnownTokenTotal = todaySummary === undefined ? undefined : totalTokensOf(todaySummary);
  const todayEmptyPartial = todayIncomplete && todayKnownTokenTotal === 0 && todaySummary?.cost_usd_estimated === 0;
  const todayHasNoKnownTokens = todayTokenTotalUnknown || (todayIncomplete && todayKnownTokenTotal === 0);
  const todayHasUnknownSubtotal = todaySummary !== undefined && !todayTokenTotalUnknown && todaySummary.tokens_unknown === true;
  const todayHasUnknownCost = todaySummary !== undefined && todaySummary.cost_unknown === true;
  const knownTodayTokens = todaySummary === undefined || todayHasNoKnownTokens ? undefined : todayKnownTokenTotal;
  const burnRate = knownTodayTokens !== undefined ? burnRatePerHour(knownTodayTokens, nowMs) : undefined;

  const current: Session | undefined = sessionQuery.data?.id === lastSessionId ? sessionQuery.data : undefined;
  const currentAccounting = current?.usage?.accounting;
  const currentCost = currentAccounting?.cost_usd_estimated ?? (typeof current?.usage?.total_cost_usd === 'number' ? current.usage.total_cost_usd : undefined);
  const currentUsageError = currentAccounting === undefined ? current?.usage_error : undefined;
  const currentCostUnknown = currentAccounting?.cost_unknown === true || currentAccounting?.complete === false || currentUsageError === 'agent-read-failed';

  const activityHeadline = activity.hasTurns && activity.hasRequests
    ? t('usage.kpi.turnsRequests', { turns: formatGrouped(activity.turns), requests: formatGrouped(activity.requests) })
    : activity.hasTurns
      ? t('usage.kpi.turnsOnly', { turns: formatGrouped(activity.turns) })
      : tp('usage.sessionChip', summary.session_count);

  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-4 border-b border-hairline pb-4 sm:grid-cols-2 lg:grid-cols-4 lg:gap-x-0 lg:divide-x lg:divide-hairline">
      <Kpi
        id="cost"
        label={t('usage.kpi.estimatedCost')}
        dataValue="data-usage-summary-cost"
        value={costUnknown && tokensUnknown && summary.cost_usd_estimated === 0 ? '—' : formatCostUsd(summary.cost_usd_estimated)}
        hint={(costOutcome !== undefined || unpricedCount > 0) ? (
          <div className="flex flex-wrap items-center gap-2">
            {costOutcome !== undefined ? <CompareCell outcome={costOutcome} /> : null}
            {unpricedCount > 0 ? (
              <button
                type="button"
                data-usage-unpriced-trigger
                onClick={onOpenPricing}
                className="inline-flex items-center gap-1 rounded-full border border-amber-rule/45 bg-amber-card px-2 py-0.5 text-[11px] font-medium text-amber-ink transition-colors hover:border-amber-rule focus-visible:outline-2 focus-visible:outline-selected-ink"
              >
                <Icon name="partial" size={12} />
                <span>{tp('usage.kpi.unpricedCount', unpricedCount)}</span>
              </button>
            ) : null}
          </div>
        ) : undefined}
      />

      <Kpi
        id="tokens"
        label={t('usage.card.tokens')}
        dataValue="data-usage-summary-tokens"
        value={tokensUnknown ? '—' : time.formatTokens(totalTokensOf(summary))}
        hint={(
          <span data-usage-summary-input-output className="text-ink-faint tabular-nums">
            {tokensUnknown
              ? '— / —'
              : t('usage.kpi.inputOutput', {
                  input: time.formatTokens(input),
                  output: time.formatTokens(summary.tokens.output),
                })}
          </span>
        )}
      >
        {!tokensUnknown && input > 0 ? (
          <div className="mt-2" title={t('usage.cacheHitHint')}>
            <div aria-hidden className="flex h-1 overflow-hidden rounded-full bg-hairline/70">
              {composition.map((part) => (
                <span key={part.key} className={part.fill} style={{ width: `${(part.value / input) * 100}%` }} />
              ))}
            </div>
            <ul className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11px] text-ink-faint">
              {composition.map((part) => (
                <li key={part.key} className="inline-flex items-center gap-1">
                  <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${part.fill}`} />
                  {part.label} <span className="tabular-nums">{time.formatTokens(part.value)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Kpi>

      <Kpi
        id="cache"
        label={t('usage.kpi.cacheHit')}
        dataValue="data-usage-summary-cache"
        value={tokensUnknown ? '—' : formatCachePercent(cacheHit)}
        hint={(
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-ink-faint">
            {cacheOutcome !== undefined ? <CompareCell outcome={cacheOutcome} points /> : null}
            {!tokensUnknown && summary.tokens.input_cache_read > 0 ? (
              <span className="tabular-nums">
                {t('usage.kpi.cacheReadVolume', { tokens: time.formatTokens(summary.tokens.input_cache_read) })}
              </span>
            ) : cacheHit === null && !tokensUnknown ? (
              <span>{t('usage.kpi.cacheHitNone')}</span>
            ) : null}
            {cacheSavingsUsd !== undefined ? (
              <span data-usage-cache-savings className="font-medium text-success tabular-nums">
                {t('usage.kpi.cacheSaved', { cost: formatCostUsd(cacheSavingsUsd) })}
              </span>
            ) : null}
          </div>
        )}
      />

      <Kpi
        id="activity"
        label={t('usage.kpi.activity')}
        dataValue="data-usage-summary-activity"
        value={<span className="truncate text-[23px] leading-none tracking-tight">{activityHeadline}</span>}
        hint={(
          <div data-usage-strip className="space-y-1 text-[11.5px] text-ink-faint">
            {perTurnCost !== undefined ? (
              <div className="tabular-nums">{t('usage.kpi.avgPerTurn', { cost: formatCostUsd(perTurnCost) })}</div>
            ) : null}
            {todaySummary !== undefined ? (
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 tabular-nums">
                {todayEmptyPartial ? (
                  <>
                    <span data-usage-strip-tokens>
                      <span data-usage-strip-incomplete className="text-amber-ink">{todayCountingLabel}</span>
                    </span>
                    <span data-usage-strip-burn-rate className="sr-only">{todayCountingLabel}</span>
                  </>
                ) : reuseTodaySummary ? (
                  <>
                    {burnRate !== undefined ? (
                      <span data-usage-strip-burn-rate>
                        {t('usage.kpi.todayBurn', { rate: t('usage.strip.burnRateValue', { rate: formatGrouped(burnRate) }) })}
                      </span>
                    ) : null}
                    {todayIncomplete ? (
                      <span data-usage-strip-incomplete className="text-amber-ink">{todayCountingLabel}</span>
                    ) : null}
                    <span data-usage-strip-tokens className="sr-only">
                      {`${todayTokenTotalUnknown ? '—' : time.formatTokens(totalTokensOf(todaySummary))} · ${todayTokenTotalUnknown ? '—' : formatCostUsd(todaySummary.cost_usd_estimated)}`}
                    </span>
                  </>
                ) : (
                  <>
                    <span data-usage-strip-tokens>
                      {t('usage.strip.today')}{' '}
                      {todayTokenTotalUnknown ? '—' : time.formatTokens(totalTokensOf(todaySummary))}
                      {' · '}
                      {todayTokenTotalUnknown ? '—' : formatCostUsd(todaySummary.cost_usd_estimated)}
                      {todayHasUnknownSubtotal || todayHasUnknownCost ? <KnownSubtotalMarker /> : null}
                    </span>
                    {burnRate !== undefined ? (
                      <>
                        <span aria-hidden>·</span>
                        <span data-usage-strip-burn-rate>{t('usage.strip.burnRateValue', { rate: formatGrouped(burnRate) })}</span>
                      </>
                    ) : null}
                    {todayIncomplete ? (
                      <span data-usage-strip-incomplete className="text-amber-ink">{todayCountingLabel}</span>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
            {current !== undefined ? (
              <div className="flex min-w-0 items-center gap-1.5 pt-0.5">
                <button
                  type="button"
                  onClick={() => void navigate(`/s/${current.id}`)}
                  className="min-w-0 truncate text-left text-ink-soft underline-offset-2 hover:text-ink hover:underline"
                >
                  <ThreadTitle text={current.title.trim() !== '' ? current.title : t('sidebar.untitled')} />
                </button>
                <span data-usage-strip-current-cost className="shrink-0 text-ink-faint tabular-nums">
                  {currentUsageError === 'read-failed' || currentCost === undefined ? '—' : formatCostUsd(currentCost)}
                  {currentCostUnknown && currentCost !== undefined ? <KnownSubtotalMarker /> : null}
                </span>
              </div>
            ) : null}
          </div>
        )}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview Costliest Sessions Rail (zero extra HTTP requests; fed by page 1)
// ---------------------------------------------------------------------------

function TopSessionsRail({
  items,
  totalSessions,
  summaryCost,
  workspaceName,
  onViewAll,
}: {
  readonly items: UsageResponseWire['sessions']['items'];
  readonly totalSessions: number;
  readonly summaryCost: number;
  readonly workspaceName: (id: string) => string | undefined;
  readonly onViewAll: () => void;
}) {
  const { t, time } = useI18n();
  const navigate = useNavigate();
  const topItems = items.slice(0, TOP_SESSIONS_OVERVIEW_LIMIT);

  return (
    <aside
      data-usage-top-sessions
      aria-label={t('usage.topSessions.title')}
      className="min-w-0 xl:border-l xl:border-hairline xl:pl-7"
    >
      <div className="flex min-h-8 items-center justify-between gap-3">
        <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-ink">
          {t('usage.topSessions.title')}
        </h3>
        <button
          type="button"
          data-usage-open-sessions
          onClick={onViewAll}
          className="inline-flex min-h-7 items-center gap-1 rounded px-1.5 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
        >
          <span>{t('usage.topSessions.viewAll', { count: formatGrouped(totalSessions) })}</span>
          <Icon name="arrowRight" size={12} />
        </button>
      </div>

      <ol className="mt-3 divide-y divide-hairline border-t border-hairline">
        {topItems.map((item, idx) => {
          const itemTokens = totalTokensOf(item.usage);
          const unknownTotal = usageTokenTotalIsUnknown(item.usage);
          const unpricedZero = item.usage.cost_unknown && item.usage.cost_usd_estimated === 0 && (itemTokens > 0 || unknownTotal);
          const share = summaryCost > 0 ? item.usage.cost_usd_estimated / summaryCost : 0;
          const wsDisplay = workspaceName(item.workspace_id) ?? compactIdentifier(item.workspace_id);
          const titleDisplay = item.title && item.title.trim() !== '' ? item.title : compactIdentifier(item.id);
          const fillPct = share > 0 ? Math.max(2, Math.min(100, share * 100)) : 0;

          return (
            <li key={item.id} className="relative overflow-hidden">
              {fillPct > 0 ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-[3px] left-0 rounded-r-sm bg-ink/[0.035]"
                  style={{ width: `${fillPct}%` }}
                />
              ) : null}
              <button
                type="button"
                data-usage-top-session={item.id}
                onClick={() => void navigate(`/s/${item.id}`)}
                className="relative grid w-full grid-cols-[1.25rem_minmax(0,1fr)_auto] items-baseline gap-x-2.5 px-1.5 py-2 text-left transition-colors hover:bg-ink/[0.03] focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
              >
                <span className={`text-right text-[11.5px] tabular-nums ${idx < 3 ? 'font-semibold text-ink' : 'text-ink-faint'}`}>
                  {idx + 1}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-medium text-ink" title={item.title ?? item.id}>
                    <ThreadTitle text={titleDisplay} />
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-faint">
                    <span className="max-w-32 truncate" title={item.workspace_id}>{wsDisplay}</span>
                    {item.primary_model ? (
                      <span className="max-w-36 truncate font-mono text-[10px] text-ink-soft">{item.primary_model}</span>
                    ) : null}
                    <span className="tabular-nums">
                      {unknownTotal ? '—' : time.formatTokens(itemTokens)}
                    </span>
                  </span>
                </span>
                <span className="shrink-0 text-right text-[12.5px] font-semibold text-ink tabular-nums">
                  {unpricedZero ? '—' : formatCostUsd(item.usage.cost_usd_estimated)}
                  {item.usage.cost_unknown ? (
                    <KnownSubtotalMarker label={unpricedZero ? t('usage.reliability.costUnknown') : undefined} />
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Sessions tab — enriched with primary model, profiles, and instant local search
// ---------------------------------------------------------------------------

function SessionsTab({
  data,
  fetchNextPage,
  hasNextPage,
  isFetchingNextPage,
  isFetchNextPageError,
  sessionLocator,
  locatorSearching,
  workspaceName,
  summaryCost,
}: {
  data: { pages: readonly UsageResponseWire[] };
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  sessionLocator: string | undefined;
  locatorSearching: boolean;
  workspaceName: (id: string) => string | undefined;
  summaryCost: number;
}) {
  const { t, time } = useI18n();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const items = useMemo(() => data.pages.flatMap((page) => page.sessions.items), [data.pages]);
  const total = data.pages[0]?.sessions.total ?? items.length;
  const located = sessionLocator !== undefined && items.some((item) => item.id === sessionLocator);
  const needle = search.trim().toLocaleLowerCase();
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
          <p data-usage-locating className={`mb-3 ${NOTICE_AMBER}`}>{t('usage.sessions.notInPage')}</p>
        )
      ) : null}
      {items.length > 0 && sessionLocator === undefined ? (
        <div className="mb-2.5 flex justify-end">
          <input
            type="search"
            data-usage-sessions-search
            aria-label={t('usage.sessions.searchPlaceholder')}
            value={search}
            placeholder={t('usage.sessions.searchPlaceholder')}
            onChange={(event) => { setSearch(event.target.value); }}
            className="h-8 w-56 max-w-full rounded-md border border-hairline bg-paper px-2.5 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:border-selected-ink"
          />
        </div>
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
      ) : (
        <ol className="divide-y divide-hairline border-t border-hairline">
          {visible.map((item) => {
            const rank = items.indexOf(item) + 1;
            const itemTokens = totalTokensOf(item.usage);
            const unknownTotal = usageTokenTotalIsUnknown(item.usage);
            const unpricedZero = item.usage.cost_unknown && item.usage.cost_usd_estimated === 0 && (itemTokens > 0 || unknownTotal);
            const share = summaryCost > 0 ? item.usage.cost_usd_estimated / summaryCost : 0;
            const profiles = item.profile_names ?? [];
            const updatedLabel = time.relativeTime(new Date(item.updated_at).toISOString());
            const wsDisplay = workspaceName(item.workspace_id) ?? compactIdentifier(item.workspace_id);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  data-usage-session={item.id}
                  onClick={() => void navigate(`/s/${item.id}`)}
                  className={`${grid} w-full rounded-md px-2 py-2.5 text-left transition-colors hover:bg-ink/[0.03] focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11`}
                >
                  <span className={`text-right text-[12px] tabular-nums ${rank <= 3 ? 'font-semibold text-ink' : 'text-ink-faint'}`}>
                    {rank}
                  </span>
                  <span className="min-w-0">
                    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="min-w-0 truncate text-[13px] text-ink"><ThreadTitle text={item.title ?? t('sidebar.untitled')} /></span>
                      {item.primary_model !== undefined && item.primary_model !== null && item.primary_model !== '' ? (
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
                    <span className="mt-1 block w-full max-w-48"><ShareBarSmall ratio={share} /></span>
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
          })}
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

function ShareBarSmall({ ratio }: { ratio: number }) {
  const width = ratio <= 0 ? 0 : Math.max(2, Math.min(100, ratio * 100));
  return (
    <span aria-hidden className="block h-1 w-full overflow-hidden rounded-full bg-hairline/70">
      <span className="block h-full rounded-full bg-ink/50" style={{ width: `${width}%` }} />
    </span>
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

  const selectTab = (next: DetailTab) => {
    setSearchParams(new URLSearchParams(usageDetailViewToSearch(DETAIL_TAB_TO_VIEW[next], location.search)), { replace: true });
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
  const reuseTodaySummary =
    filters.range === 'today' &&
    filters.includeArchived &&
    !usageMultiFiltersHaveScope(filters) &&
    !isPlaceholderData;
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
    void queryClient.cancelQueries({ queryKey: ['usage-v2-strip'] });
    void queryClient.cancelQueries({ queryKey: ['usage-v2-strip-session'] });
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
  const resolveTitle = useThreadTitleResolver([...sessionTitles.values()]);
  const workspaceName = (id: string) => workspaceNames.get(id);
  const sessionTitle = (id: string) => {
    const title = sessionTitles.get(id);
    return title === undefined ? undefined : resolveTitle(title);
  };
  const sourceLookups = { unknownLabel: t(`usage.sources.unknown.${filters.groupBy}`), workspaceName };

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
  const tabs: readonly (readonly [DetailTab, string])[] = [
    ['sources', t('usage.tab.sources')],
    ['sessions', t('usage.tab.sessions')],
    ...(legacyDimension !== undefined
      ? ([['breakdown', t(`usage.dimension.${legacyDimension}`)]] as const)
      : []),
  ];

  // Compact inline scan-pending status pill inside the filter utility slot (only while actively advancing)
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
        <div className={`mx-auto ${PAGE_WIDTH.dashboard} space-y-4`} data-usage-page>
          <UsageNavigation panel={panel} onChange={selectPanel} />
          {panel === 'export' ? (
            <UsageExportPanel />
          ) : panel === 'quota' ? (
            <ProviderQuotaPanel />
          ) : panel !== 'history' ? (
            <RequestGovernanceView view={rawPanel === 'limits' ? 'limits' : 'realtime'} />
          ) : <>
            <LiveBand onOpen={() => { selectPanel('realtime'); }} />
            <QuotaHeadroomStrip enabled={panel === 'history'} onOpenQuota={() => { selectPanel('quota'); }} />
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
              reliabilitySlot={
                firstPage !== undefined ? (
                  <UsageReliabilityDetails
                    summary={firstPage.summary}
                    reliability={firstPage.reliability}
                    onOpenPricing={() => { setPricingOpen(true); }}
                  />
                ) : undefined
              }
              utilitySlot={
                <>
                  {scanPendingPill}
                  <UsageRescanControl />
                </>
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
              <div className={isRefetchingScope ? 'space-y-4 opacity-65 transition-opacity' : 'space-y-4'}>
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
                    todayResponse={reuseTodaySummary ? firstPage : undefined}
                    reuseTodaySummary={reuseTodaySummary}
                    enabled={panel === 'history' && !isUsagePending}
                  />
                ) : null}

                {trend.length === 0 ? (firstPage.reliability.complete ? (
                  <p data-usage-empty className="py-8 text-center text-[13px] text-ink-faint">
                    {filters.range === 'all' && !usageMultiFiltersHaveScope(filters) ? t('usage.emptyAll') : t('usage.empty')}
                  </p>
                ) : null) : (
                  <div className="pt-1">
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
                          const group = trend.flatMap((bucket) => bucket.groups).find((entry) => entry.key === key);
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
                        return sourceKeyToLabel(key, groupBy, trend, sourceLookups);
                      }}
                    />
                  </div>
                )}

                {firstPage.reliability.complete || trend.length > 0 ? (
                  <section data-usage-detail>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-hairline">
                      <div role="tablist" aria-label={t('usage.sources.title')} className="flex flex-wrap items-baseline gap-1" data-usage-tabs>
                        {tabs.map(([id, label]) => (
                          <button
                            key={id}
                            type="button"
                            role="tab"
                            aria-selected={tab === id}
                            data-usage-tab={id}
                            onClick={() => { selectTab(id); }}
                            className={`-mb-px min-h-9 border-b-2 px-3 py-1.5 text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40 pointer-coarse:min-h-11 ${
                              tab === id ? 'border-ink font-medium text-ink' : 'border-transparent text-ink-soft hover:text-ink'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      {tab === 'sources' && selectedBucket !== undefined ? (
                        <button
                          type="button"
                          data-usage-clear-bucket
                          onClick={() => { selectBucketKeyWithSnapshot(null); }}
                          className="inline-flex h-7 items-center gap-1.5 rounded-full border border-selected-ink/40 bg-panel px-2.5 text-[11.5px] text-ink transition-colors hover:border-selected-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
                        >
                          <span data-usage-source-scope>{bucketLabel(selectedBucket, filters.granularity, locale)}</span>
                          <Icon name="close" size={12} className="text-ink-faint" />
                        </button>
                      ) : null}
                      {tab === 'sources' && selectedBucket !== undefined ? (
                        <span data-usage-source-subtotal className="ml-auto pb-1 text-[13px] font-semibold text-ink tabular-nums">
                          {formatCostUsd(sourceSubtotal)}
                        </span>
                      ) : rangeWindow !== null ? (
                        <span data-usage-range-note className="ml-auto pb-1 text-[11.5px] text-ink-faint tabular-nums">
                          {usageWindowLabel(rangeWindow, locale)}
                        </span>
                      ) : null}
                      {tab === 'sessions' && sessionLocator !== undefined ? (
                        <p className="ml-auto flex items-center gap-2 text-[12px] text-ink-soft">
                          <span className="rounded-md bg-ink/[0.05] px-2 py-0.5 font-medium text-ink-soft">
                            {t('usage.sessions.deepLinkChip')}
                          </span>
                          <button type="button" className="text-ink-faint underline hover:text-ink" onClick={() => { setDismissedLocator(sessionLocator); }}>
                            {t('common.close')}
                          </button>
                        </p>
                      ) : null}
                    </div>
                    {compareQuery.isError ? (
                      <p data-usage-compare-error className={`mt-2 ${NOTICE_AMBER}`}>
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
                      selectedBucket === undefined && firstPage.sessions.items.length > 0 ? (
                        <div className="mt-4 grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1.45fr)_minmax(290px,0.95fr)] xl:items-start">
                          <UsageSources
                            trend={sourceTrend}
                            groupBy={groupBy}
                            metric={metric}
                            prior={priorSource}
                            lookups={sourceLookups}
                            isFilterActive={(row) => isSourceRowFilterActive(filters, row.filter)}
                            onFilterSource={(row) => {
                              if (row.filter === null) return;
                              applyFilters(toggleSourceRowFilter(filters, row.filter));
                            }}
                            onOpenSessions={openTrace}
                            onSwitchGrouping={(next) => { applyFilters({ ...filters, groupBy: next, advancedDimension: undefined }); }}
                          />
                          <TopSessionsRail
                            items={firstPage.sessions.items}
                            totalSessions={firstPage.sessions.total}
                            summaryCost={summary?.cost_usd_estimated ?? 0}
                            workspaceName={workspaceName}
                            onViewAll={() => { selectTab('sessions'); }}
                          />
                        </div>
                      ) : (
                        <div className="mt-4">
                          <UsageSources
                            trend={sourceTrend}
                            groupBy={groupBy}
                            metric={metric}
                            prior={priorSource}
                            lookups={sourceLookups}
                            isFilterActive={(row) => isSourceRowFilterActive(filters, row.filter)}
                            onFilterSource={(row) => {
                              if (row.filter === null) return;
                              applyFilters(toggleSourceRowFilter(filters, row.filter));
                            }}
                            onOpenSessions={openTrace}
                            onSwitchGrouping={(next) => { applyFilters({ ...filters, groupBy: next, advancedDimension: undefined }); }}
                          />
                          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                            <button
                              type="button"
                              data-usage-open-sessions
                              onClick={() => {
                                if (selectedBucket !== undefined) openTrace(undefined);
                                else selectTab('sessions');
                              }}
                              className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-1 text-[13px] text-ink underline underline-offset-4 transition-colors hover:text-ink-soft focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
                            >
                              {t('usage.sources.openSessions')}
                            </button>
                          </div>
                        </div>
                      )
                    ) : tab === 'sessions' ? (
                      <div className="mt-3">
                        <SessionsTab
                          data={{ pages: usageData.pages }}
                          fetchNextPage={() => void fetchNextPage()}
                          hasNextPage={hasNextPage}
                          isFetchingNextPage={isFetchingNextPage}
                          isFetchNextPageError={isFetchNextPageError}
                          sessionLocator={sessionLocator}
                          locatorSearching={locatorSearching}
                          workspaceName={workspaceName}
                          summaryCost={summary?.cost_usd_estimated ?? 0}
                        />
                      </div>
                    ) : tab === 'breakdown' && legacyDimension !== undefined ? (
                      <div className="mt-3">
                        <DimensionBreakdown
                          trend={trend}
                          dimension={legacyDimension}
                          labelFor={(row) => dimensionKeyLabelLegacy(row, legacyDimension, sourceLookups, sessionTitle)}
                        />
                      </div>
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
  trend: readonly UsageTrendBucketWire[],
  lookups: { readonly unknownLabel: string; readonly workspaceName: (id: string) => string | undefined },
): string {
  if (key === USAGE_SOURCE_KEY_UNKNOWN) return lookups.unknownLabel;
  const group = trend.flatMap((bucket) => bucket.groups).find((entry) => usageSourceKey(entry, groupBy) === key);
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
