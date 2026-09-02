/**
 * UsagePage (/usage) — the V2 cross-session usage dashboard, rebuilt on
 * `GET /api/v2/usage` (design doc §15.3). Structure:
 *
 *   - a compact live strip (current session, today, burn rate — statusline
 *     style) above the fold;
 *   - the ccusage-style three-axis filter bar (granularity × range ×
 *     dimension) with workspace scope and the archived toggle; the URL query
 *     carries every axis so views are deep-linkable, and the last selection
 *     is persisted for query-less revisits;
 *   - a real time-bucket trend chart (cost/tokens metric toggle, click a
 *     bucket for the session/turn drilldown);
 *   - detail tabs: Sessions (server-sorted cost-descending, paged), the
 *     dimension breakdown (agents render as parent/child trees), and the 5h
 *     rhythm view (drills from trend[i].drilldown.sessions, never guessed);
 *   - a permanently visible data-reliability card (coverage, unknown-price
 *     models, deleted-session inclusion, incomplete reasons).
 *
 * Honesty rules: the no-query state is all history (the server's
 * `defaulted_to_all_history` is surfaced, never hidden); cost is labeled an
 * estimate and flagged "partially unknown" whenever `cost_unknown` is set;
 * `unknown` dimension keys and null provider/parent/profile are shown as
 * missing data, never reconstructed.
 */

import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import type { Session, Workspace } from '@moonshot-ai/protocol';

import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n/locale';
import { formatCostUsd, formatGrouped } from '../lib/usage';
import {
  aggregateDimensionGroups,
  browserTimezoneOffsetMinutes,
  buildAgentTree,
  buildUsageApiQuery,
  bucketLabel,
  burnRatePerHour,
  cacheHitRateOf,
  parseUsageFilters,
  parseUsageDetailView,
  readStoredUsageFilters,
  searchHasUsageParams,
  totalTokensOf,
  USAGE_DIMENSIONS,
  USAGE_FILTER_DEFAULTS,
  USAGE_GRANULARITIES,
  USAGE_RANGE_PRESETS,
  usageDetailViewToSearch,
  usageFiltersToSearch,
  writeStoredUsageFilters,
  type UsageDetailView,
  type UsageDimensionRow,
  type UsageDrilldownSessionWire,
  type UsageFilters,
  type UsageResponseWire,
  type UsageTrendBucketWire,
} from '../lib/usageV2';
import { readLastSessionId } from '../lib/settings';
import { useConnection } from '../state/connection';
import { Toggle } from './controls';

const SESSION_PAGE_SIZE = 25;

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

const INCOMPLETE_REASON_KEYS: Record<
  NonNullable<UsageResponseWire['reliability']['incomplete_reason']>,
  I18nKey
> = {
  session_cap: 'usage.incomplete.sessionCap',
  record_budget: 'usage.incomplete.recordBudget',
  deadline: 'usage.incomplete.deadline',
};

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function Card({ title, aside, children }: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-hairline bg-panel p-5 shadow-[0_2px_4px_rgba(28,25,23,0.03)]">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="font-display text-[16px] font-semibold text-ink">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function AxisGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  labelFor,
  dataAxis,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
  labelFor: (option: T) => string;
  dataAxis: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
        {label}
      </span>
      <div
        role="group"
        aria-label={label}
        data-axis={dataAxis}
        className="inline-flex flex-wrap rounded-lg border border-hairline bg-panel p-0.5"
      >
        {options.map((option) => (
          <button
            key={option}
            type="button"
            data-axis-value={option}
            onClick={() => { onChange(option); }}
            aria-pressed={value === option}
            className={`rounded-md px-2.5 py-1 text-[11.5px] whitespace-nowrap transition-colors ${
              value === option
                ? 'bg-accent-soft font-semibold text-accent'
                : 'text-ink-soft hover:text-ink'
            }`}
          >
            {labelFor(option)}
          </button>
        ))}
      </div>
    </div>
  );
}

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

const DAY_MS = 24 * 3600_000;

function bucketTokens(bucket: UsageTrendBucketWire): number {
  return bucket.groups.reduce((sum, group) => sum + totalTokensOf(group), 0);
}

function bucketCost(bucket: UsageTrendBucketWire): number {
  return bucket.groups.reduce((sum, group) => sum + group.cost_usd_estimated, 0);
}

// ---------------------------------------------------------------------------
// Live strip — current session, today, burn rate
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
  const todayTokens = today !== undefined ? totalTokensOf(today) : undefined;
  const rate =
    todayTokens !== undefined ? burnRatePerHour(todayTokens, nowMs) : undefined;
  const current: Session | undefined = sessionQuery.data;

  return (
    <div
      data-usage-strip
      className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-hairline bg-panel px-3 py-2 text-[11.5px]"
    >
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 text-ink-faint">{t('usage.strip.currentSession')}</span>
        {current !== undefined ? (
          <>
            <span className="min-w-0 truncate font-medium text-ink">
              {current.title.trim() !== '' ? current.title : t('sidebar.untitled')}
            </span>
            <span className="shrink-0 font-mono text-ink-soft tabular-nums">
              {formatCostUsd(current.usage.total_cost_usd)}
            </span>
          </>
        ) : (
          <span className="text-ink-faint">—</span>
        )}
      </span>
      <span className="flex items-baseline gap-1.5">
        <span className="text-ink-faint">{t('usage.strip.today')}</span>
        {today !== undefined ? (
          <span className="font-mono text-ink tabular-nums">
            {time.formatTokens(todayTokens ?? 0)} · {formatCostUsd(today.cost_usd_estimated)}
          </span>
        ) : (
          <span className="text-ink-faint">…</span>
        )}
      </span>
      <span className="flex items-baseline gap-1.5">
        <span className="text-ink-faint">{t('usage.strip.burnRate')}</span>
        <span className="font-mono text-ink tabular-nums">
          {rate !== undefined
            ? t('usage.strip.burnRateValue', { rate: formatGrouped(rate) })
            : '…'}
        </span>
      </span>
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
  return (
    <div data-usage-filters className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <AxisGroup
        label={t('usage.axis.granularity')}
        dataAxis="granularity"
        options={USAGE_GRANULARITIES}
        value={filters.granularity}
        onChange={(granularity) => { onChange({ ...filters, granularity }); }}
        labelFor={(option) => t(`usage.granularity.${option}`)}
      />
      <AxisGroup
        label={t('usage.axis.range')}
        dataAxis="range"
        options={USAGE_RANGE_PRESETS}
        value={filters.range}
        onChange={(range) => {
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
      <AxisGroup
        label={t('usage.axis.dimension')}
        dataAxis="dimension"
        options={USAGE_DIMENSIONS}
        value={filters.dimension}
        onChange={(dimension) => { onChange({ ...filters, dimension }); }}
        labelFor={(option) => t(`usage.dimension.${option}`)}
      />
      <label className="flex items-center gap-1.5 text-[11.5px] text-ink-soft">
        <span className="text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
          {t('usage.workspace.label')}
        </span>
        <select
          data-usage-workspace
          value={filters.workspaceId ?? ''}
          onChange={(event) => {
            onChange({
              ...filters,
              workspaceId: event.target.value === '' ? undefined : event.target.value,
            });
          }}
          className="rounded-lg border border-hairline bg-panel px-2 py-1 text-[11.5px] text-ink outline-none transition-colors focus:border-accent"
        >
          <option value="">{t('usage.workspace.all')}</option>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
      </label>
      <Toggle
        label={t('usage.includeArchived')}
        checked={filters.includeArchived}
        onChange={(includeArchived) => { onChange({ ...filters, includeArchived }); }}
      />
      {filters.range === 'custom' ? (
        <div className="flex items-center gap-1.5" data-usage-custom-range>
          <input
            type="date"
            aria-label={t('usage.customRange.start')}
            value={toDateInputValue(filters.startAt)}
            onChange={(event) => {
              const startAt = fromDateInputValue(event.target.value);
              if (startAt !== undefined) onChange({ ...filters, startAt });
            }}
            className="rounded-lg border border-hairline bg-panel px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-accent"
          />
          <span aria-hidden className="text-ink-faint">→</span>
          <input
            type="date"
            aria-label={t('usage.customRange.end')}
            value={toDateInputValue(
              filters.endAt !== undefined ? filters.endAt - DAY_MS : undefined,
            )}
            onChange={(event) => {
              const day = fromDateInputValue(event.target.value);
              if (day !== undefined) onChange({ ...filters, endAt: day + DAY_MS });
            }}
            className="rounded-lg border border-hairline bg-panel px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-accent"
          />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trend chart + drilldown
// ---------------------------------------------------------------------------

function TrendChart({
  trend,
  filters,
  selectedKey,
  onSelect,
}: {
  trend: readonly UsageTrendBucketWire[];
  filters: UsageFilters;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
}) {
  const { t, locale, time } = useI18n();
  const [metric, setMetric] = useState<'cost' | 'tokens'>('cost');
  const values = trend.map((bucket) => (metric === 'cost' ? bucketCost(bucket) : bucketTokens(bucket)));
  const max = Math.max(0, ...values);
  return (
    <Card
      title={t('usage.trend.title')}
      aside={
        <div
          role="group"
          aria-label={t('usage.trend.title')}
          className="ml-auto inline-flex rounded-lg border border-hairline bg-paper p-0.5"
        >
          {(['cost', 'tokens'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              data-trend-metric={candidate}
              onClick={() => { setMetric(candidate); }}
              aria-pressed={metric === candidate}
              className={`rounded-md px-2 py-0.5 text-[10.5px] transition-colors ${
                metric === candidate
                  ? 'bg-accent-soft font-semibold text-accent'
                  : 'text-ink-soft hover:text-ink'
              }`}
            >
              {t(`usage.trend.metric.${candidate}`)}
            </button>
          ))}
        </div>
      }
    >
      <div
        className="flex h-32 items-end gap-[3px]"
        role="img"
        aria-label={t('usage.trend.title')}
        data-usage-trend
      >
        {trend.map((bucket, index) => {
          const value = values[index] ?? 0;
          const height = value > 0 && max > 0 ? Math.max(4, (value / max) * 100) : 0;
          const selected = selectedKey === bucket.key;
          const title = [
            bucketLabel(bucket, filters.granularity, locale),
            `${time.formatTokens(bucketTokens(bucket))} ${t('usage.col.tokens')}`,
            formatCostUsd(bucketCost(bucket)),
          ].join(' · ');
          return (
            <button
              key={bucket.key}
              type="button"
              data-bucket={bucket.key}
              aria-pressed={selected}
              onClick={() => { onSelect(selected ? null : bucket.key); }}
              title={title}
              className="flex min-w-0 flex-1 flex-col justify-end self-stretch"
            >
              <span
                className={`w-full rounded-t-[3px] transition-colors ${
                  value > 0
                    ? selected
                      ? 'bg-accent'
                      : 'bg-accent/55 hover:bg-accent/80'
                    : 'bg-hairline/70'
                }`}
                style={{ height: value > 0 ? `${height}%` : '2px' }}
              />
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-baseline justify-between text-[9.5px] text-ink-faint">
        <span className="font-mono tabular-nums">
          {trend.length > 0 ? bucketLabel(trend[0]!, filters.granularity, locale) : ''}
        </span>
        <span>{t('usage.trend.clickHint')}</span>
        <span className="font-mono tabular-nums">
          {trend.length > 1 ? bucketLabel(trend.at(-1)!, filters.granularity, locale) : ''}
        </span>
      </div>
    </Card>
  );
}

/**
 * Drilldown session rows with per-turn locators: the session id opens the
 * session, and each returned turn id is its own action that lands on
 * `/s/{id}?turn={n}` so the session view can scroll to that turn. The wire
 * `turn_ids` are rendered, never collapsed into a bare count.
 */
function DrilldownSessionList({
  sessions,
}: {
  sessions: readonly UsageDrilldownSessionWire[];
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <ul className="space-y-1">
      {sessions.map((session) => (
        <li key={session.session_id}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg px-2 py-1.5">
            <button
              type="button"
              data-usage-drilldown-session={session.session_id}
              onClick={() => void navigate(`/s/${session.session_id}`)}
              className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] text-ink transition-colors hover:text-accent hover:underline"
            >
              {session.session_id}
            </button>
            <span className="shrink-0 font-mono text-[10.5px] text-ink-soft tabular-nums">
              {t('usage.drilldown.turns', { count: session.turn_count })}
              {session.turn_ids_truncated ? ` · ${t('usage.drilldown.turnIdsTruncated')}` : ''}
            </span>
            {session.unknown_turn_records > 0 ? (
              <span className="shrink-0 text-[10px] text-amber-ink">
                {t('usage.drilldown.unknownTurns', { count: session.unknown_turn_records })}
              </span>
            ) : null}
          </div>
          {session.turn_ids.length > 0 ? (
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {session.turn_ids.map((turnId) => (
                <button
                  key={turnId}
                  type="button"
                  data-usage-turn={turnId}
                  onClick={() => void navigate(`/s/${session.session_id}?turn=${turnId}`)}
                  title={t('usage.drilldown.turnHint')}
                  className="rounded-md border border-hairline px-1.5 py-0.5 font-mono text-[10px] text-ink-soft tabular-nums transition-colors hover:border-accent hover:text-accent"
                >
                  {t('usage.drilldown.turnId', { id: turnId })}
                </button>
              ))}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function DrilldownPanel({
  bucket,
  filters,
  onClose,
}: {
  bucket: UsageTrendBucketWire;
  filters: UsageFilters;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  return (
    <section
      data-usage-drilldown
      className="rounded-2xl border border-accent/25 bg-accent-soft/40 p-4"
    >
      <div className="flex items-baseline gap-2">
        <h3 className="text-[12px] font-semibold text-ink">
          {t('usage.drilldown.title')} · {bucketLabel(bucket, filters.granularity, locale)}
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md border border-hairline text-ink-soft hover:text-ink"
        >
          <span aria-hidden>✕</span>
        </button>
      </div>
      {bucket.drilldown.sessions.length === 0 ? (
        <p className="mt-2 text-[11.5px] text-ink-faint">{t('usage.empty')}</p>
      ) : (
        <div className="mt-2">
          <DrilldownSessionList sessions={bucket.drilldown.sessions} />
        </div>
      )}
      {bucket.drilldown.sessions_truncated ? (
        <p className="mt-2 text-[10.5px] text-amber-ink">{t('usage.drilldown.sessionsTruncated')}</p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Detail tabs
// ---------------------------------------------------------------------------

function detailKeyLabel(row: UsageDimensionRow, filters: UsageFilters, unknownLabel: string): string {
  if (row.key === 'unknown') return unknownLabel;
  if (filters.dimension === 'model') return row.modelAlias ?? row.key;
  if (filters.dimension === 'agent') return row.profileName ?? row.agentId ?? row.key;
  return row.key;
}

function DimensionBreakdown({
  trend,
  filters,
}: {
  trend: readonly UsageTrendBucketWire[];
  filters: UsageFilters;
}) {
  const { t, time } = useI18n();
  const rows = useMemo(() => aggregateDimensionGroups(trend), [trend]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const maxCost = Math.max(0, ...rows.map((row) => row.costUsdEstimated));
  const unknownLabel = t('usage.dim.unknown');

  const renderRow = (row: UsageDimensionRow, depth: number) => (
    <div key={`${depth}:${row.key}`}>
      <div className="flex items-baseline gap-2" style={{ paddingLeft: depth * 16 }}>
        {depth === 0 && filters.dimension === 'agent' ? (
          <button
            type="button"
            aria-label={row.key}
            aria-expanded={expanded.has(row.key)}
            onClick={() => {
              setExpanded((current) => {
                const next = new Set(current);
                if (next.has(row.key)) next.delete(row.key);
                else next.add(row.key);
                return next;
              });
            }}
            className="w-4 shrink-0 text-[10px] text-ink-faint hover:text-ink"
          >
            {expanded.has(row.key) ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-4 shrink-0" aria-hidden />
        )}
        <span
          className={`min-w-0 truncate font-mono text-[12px] ${
            row.key === 'unknown' ? 'text-ink-soft italic' : 'text-ink'
          }`}
          title={row.key}
        >
          {detailKeyLabel(row, filters, unknownLabel)}
        </span>
        <span className="hidden shrink-0 font-mono text-[10px] text-ink-faint sm:block">
          {row.mixedAttribution
            ? t('usage.dim.mixedAttribution')
            : (row.provider ?? '')}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[12px] font-semibold text-ink tabular-nums">
          {formatCostUsd(row.costUsdEstimated)}
          {row.costUnknown ? '◔' : ''}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hairline/60" style={{ marginLeft: depth * 16 + 16 }}>
        <div
          className="h-full rounded-full bg-accent"
          style={{
            width: `${maxCost > 0 ? Math.max(2, (row.costUsdEstimated / maxCost) * 100) : 2}%`,
          }}
        />
      </div>
      <p
        className="mt-0.5 font-mono text-[10px] text-ink-faint tabular-nums"
        style={{ paddingLeft: depth * 16 + 16 }}
      >
        {time.formatTokens(row.totalTokens)} {t('usage.col.tokens')}
      </p>
    </div>
  );

  if (rows.length === 0) {
    return <p className="py-6 text-center text-[12.5px] text-ink-faint">{t('usage.empty')}</p>;
  }
  if (filters.dimension !== 'agent') {
    return <div className="space-y-3.5">{rows.map((row) => renderRow(row, 0))}</div>;
  }
  const tree = buildAgentTree(rows);
  return (
    <div className="space-y-3.5" data-usage-agent-tree>
      {tree.roots.map((row) => {
        const children = tree.childrenByParent.get(row.agentId ?? row.key) ?? [];
        const open = expanded.has(row.key);
        return (
          <div key={row.key}>
            {renderRow(row, 0)}
            {children.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(row.key)) next.delete(row.key);
                    else next.add(row.key);
                    return next;
                  });
                }}
                className="mt-0.5 block text-[10px] text-accent hover:underline"
                style={{ paddingLeft: 16 }}
              >
                {t('usage.agent.subagents', { count: children.length })}
              </button>
            ) : null}
            {open ? <div className="mt-2 space-y-3">{children.map((child) => renderRow(child, 1))}</div> : null}
          </div>
        );
      })}
      {/* Orphan children: their parent fell outside the current range. */}
      {rows
        .filter(
          (row) =>
            row.parentAgentId !== null &&
            !tree.roots.some(
              (root) => (root.agentId ?? root.key) === row.parentAgentId,
            ),
        )
        .map((row) => renderRow(row, 1))}
    </div>
  );
}

function SessionsTab({
  data,
  fetchNextPage,
  hasNextPage,
  isFetchingNextPage,
  sessionLocator,
  locatorSearching,
  workspaces,
}: {
  data: { pages: readonly UsageResponseWire[] };
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  sessionLocator: string | undefined;
  /** True while the locator walk is still pulling pages for the target. */
  locatorSearching: boolean;
  workspaces: readonly Workspace[];
}) {
  const { t, time } = useI18n();
  const navigate = useNavigate();
  const items = useMemo(() => data.pages.flatMap((page) => page.sessions.items), [data.pages]);
  const total = data.pages[0]?.sessions.total ?? items.length;
  const located = sessionLocator !== undefined && items.some((item) => item.id === sessionLocator);
  const visible =
    sessionLocator !== undefined && located
      ? items.filter((item) => item.id === sessionLocator)
      : items;
  const workspaceName = (id: string) =>
    workspaces.find((workspace) => workspace.id === id)?.name ?? id;

  return (
    <div data-usage-sessions>
      {sessionLocator !== undefined && !located ? (
        locatorSearching ? (
          <p
            data-usage-locating
            className="mb-2 flex items-center gap-2 rounded-lg border border-hairline bg-paper px-3 py-1.5 text-[11px] text-ink-soft"
          >
            <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
            {t('usage.sessions.locating')}
          </p>
        ) : (
          <p className="mb-2 rounded-lg border border-amber-rule/40 bg-amber-card px-3 py-1.5 text-[11px] text-amber-ink">
            {t('usage.sessions.notInPage')}
          </p>
        )
      ) : null}
      <div className="flex items-center gap-3 px-2 pb-1 text-[9.5px] font-semibold tracking-[0.06em] text-ink-faint uppercase">
        <span className="min-w-0 flex-1">{t('usage.col.session')}</span>
        <span className="hidden w-28 shrink-0 sm:block">{t('usage.col.workspace')}</span>
        <span className="hidden w-20 shrink-0 text-right md:block">{t('usage.col.tokens')}</span>
        <span className="hidden w-20 shrink-0 text-right lg:block">{t('usage.col.updated')}</span>
        <span className="w-20 shrink-0 text-right">{t('usage.col.cost')}</span>
      </div>
      {visible.length === 0 ? (
        <p className="py-6 text-center text-[12.5px] text-ink-faint">{t('usage.empty')}</p>
      ) : (
        visible.map((item) => (
          <button
            key={item.id}
            type="button"
            data-usage-session={item.id}
            onClick={() => void navigate(`/s/${item.id}`)}
            className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-paper"
          >
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
              {item.title ?? t('sidebar.untitled')}
              {item.archived ? (
                <span className="ml-1.5 rounded-full border border-hairline px-1.5 py-px text-[9px] text-ink-faint">
                  {t('sidebar.archived')}
                </span>
              ) : null}
              {item.deleted ? (
                <span className="ml-1.5 rounded-full border border-danger/40 px-1.5 py-px text-[9px] text-danger">
                  {t('usage.reliability.deleted.included')}
                </span>
              ) : null}
              {item.unknown_price_models.length > 0 ? (
                <span
                  className="ml-1.5 text-[9.5px] text-amber-ink"
                  title={item.unknown_price_models.join(', ')}
                >
                  ◔
                </span>
              ) : null}
            </span>
            <span className="hidden w-28 shrink-0 truncate font-mono text-[10.5px] text-ink-faint sm:block">
              {workspaceName(item.workspace_id)}
            </span>
            <span className="hidden w-20 shrink-0 text-right font-mono text-[10.5px] text-ink-faint tabular-nums md:block">
              {time.formatTokens(totalTokensOf(item.usage))}
            </span>
            <span className="hidden w-20 shrink-0 text-right font-mono text-[10.5px] text-ink-faint lg:block">
              {time.relativeTime(new Date(item.updated_at).toISOString())}
            </span>
            <span className="w-20 shrink-0 text-right font-mono text-[11.5px] font-semibold text-ink tabular-nums">
              {formatCostUsd(item.usage.cost_usd_estimated)}
            </span>
          </button>
        ))
      )}
      {hasNextPage ? (
        <button
          type="button"
          data-usage-load-more
          onClick={fetchNextPage}
          disabled={isFetchingNextPage}
          className="mt-2 w-full rounded-lg border border-hairline py-1.5 text-[11.5px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:opacity-50"
        >
          {t('usage.sessions.loadMore', { shown: items.length, total })}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The 5h rhythm detail tab (§15.1/§15.3): a second-level view over the 5h
 * window granularity — each window lists its sessions and per-turn locators
 * straight from the bucket's server drilldown, newest window first. Without
 * the 5h granularity selected there is no data to show honestly, so the tab
 * offers the switch instead of a placeholder.
 */
function FiveHourTab({
  trend,
  filters,
  onSwitchGranularity,
}: {
  trend: readonly UsageTrendBucketWire[];
  filters: UsageFilters;
  onSwitchGranularity: () => void;
}) {
  const { t, locale, time } = useI18n();
  if (filters.granularity !== 'five_hour') {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center" data-usage-fivehour-hint>
        <p className="text-[12px] text-ink-faint">{t('usage.fiveHour.hint')}</p>
        <button
          type="button"
          onClick={onSwitchGranularity}
          className="rounded-lg border border-accent/40 bg-accent-soft px-3 py-1.5 text-[11.5px] font-medium text-accent transition-colors hover:border-accent"
        >
          {t('usage.fiveHour.switch')}
        </button>
      </div>
    );
  }
  const windows = [...trend].reverse();
  if (windows.length === 0) {
    return <p className="py-6 text-center text-[12.5px] text-ink-faint">{t('usage.empty')}</p>;
  }
  return (
    <div className="space-y-3" data-usage-fivehour>
      {windows.map((bucket) => (
        <section
          key={bucket.key}
          data-usage-fivehour-window={bucket.key}
          className="rounded-xl border border-hairline bg-paper/60 p-3"
        >
          <header className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-1 pb-2">
            <h3 className="font-mono text-[11.5px] font-semibold text-ink tabular-nums">
              {bucketLabel(bucket, 'five_hour', locale)}
            </h3>
            <span className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-soft tabular-nums">
              {time.formatTokens(bucketTokens(bucket))} {t('usage.col.tokens')}
            </span>
            <span className="shrink-0 font-mono text-[10.5px] font-semibold text-ink tabular-nums">
              {formatCostUsd(bucketCost(bucket))}
            </span>
          </header>
          {bucket.drilldown.sessions.length === 0 ? (
            <p className="px-1 pb-1 text-[11px] text-ink-faint">{t('usage.empty')}</p>
          ) : (
            <DrilldownSessionList sessions={bucket.drilldown.sessions} />
          )}
          {bucket.drilldown.sessions_truncated ? (
            <p className="px-1 pt-1 text-[10.5px] text-amber-ink">
              {t('usage.drilldown.sessionsTruncated')}
            </p>
          ) : null}
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reliability card — always visible
// ---------------------------------------------------------------------------

function ReliabilityCard({ reliability }: { reliability: UsageResponseWire['reliability'] }) {
  const { t, locale, tp } = useI18n();
  const formatMs = (ms: number | null) =>
    ms === null
      ? null
      : new Date(ms).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
  const earliest = formatMs(reliability.coverage.earliest_at);
  const latest = formatMs(reliability.coverage.latest_at);
  const rows: { label: string; value: React.ReactNode }[] = [
    {
      label: t('usage.reliability.coverage'),
      value:
        earliest !== null && latest !== null
          ? `${earliest} → ${latest}`
          : t('usage.reliability.coverageEmpty'),
    },
    { label: t('usage.reliability.scanned'), value: formatGrouped(reliability.scanned_sessions) },
    {
      label: t('usage.reliability.incomplete'),
      value: formatGrouped(reliability.incomplete_sessions),
    },
    {
      label: t('usage.reliability.unknownPrices'),
      value:
        reliability.unknown_price_models.length > 0 ? (
          <span className="font-mono text-amber-ink">
            {reliability.unknown_price_models.join(', ')}
          </span>
        ) : (
          t('usage.reliability.none')
        ),
    },
    {
      label: t('usage.reliability.deleted'),
      value: reliability.includes_deleted_sessions
        ? t('usage.reliability.deleted.included')
        : t('usage.reliability.deleted.excluded'),
    },
  ];
  return (
    <Card title={t('usage.reliability.title')}>
      <p className="mb-3 text-[10.5px] text-ink-faint">{t('usage.reliability.costSource')}</p>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[11.5px] sm:grid-cols-2" data-usage-reliability>
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-ink-faint">{row.label}</dt>
            <dd className="min-w-0 truncate text-right font-mono text-ink-soft tabular-nums">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      {reliability.incomplete_reason !== null ? (
        <p className="mt-3 text-[10.5px] text-amber-ink">
          {tp('usage.sessionChip', reliability.incomplete_sessions)}
        </p>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function UsagePage({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { client } = useConnection();
  const { t, time } = useI18n();
  const location = useLocation();
  const [, setSearchParams] = useSearchParams();

  // URL query is the canonical filter state (deep-linkable). A query-less
  // visit restores the persisted selection; with nothing stored the page
  // shows all history — there is no implicit 30-day default.
  const filters = useMemo<UsageFilters>(
    () =>
      searchHasUsageParams(location.search)
        ? parseUsageFilters(location.search)
        : (readStoredUsageFilters() ?? USAGE_FILTER_DEFAULTS),
    [location.search],
  );
  useEffect(() => {
    writeStoredUsageFilters(filters);
  }, [filters]);

  const sessionParam = new URLSearchParams(location.search).get('session') ?? undefined;
  const [dismissedLocator, setDismissedLocator] = useState<string | null>(null);
  const sessionLocator = sessionParam !== undefined && sessionParam !== dismissedLocator
    ? sessionParam
    : undefined;

  // The detail tab rides the URL (`view=`) so breakdown/5h views are
  // deep-linkable and shareable; a session locator without an explicit view
  // pins the sessions tab so the located row is actually on screen.
  const hasExplicitView = new URLSearchParams(location.search).has('view');
  const tab: DetailTab =
    sessionLocator !== undefined && !hasExplicitView
      ? 'sessions'
      : VIEW_TO_DETAIL_TAB[parseUsageDetailView(location.search)];
  const selectTab = (next: DetailTab) => {
    setSearchParams(
      new URLSearchParams(usageDetailViewToSearch(DETAIL_TAB_TO_VIEW[next], location.search)),
    );
  };
  const [selectedBucketKey, setSelectedBucketKey] = useState<string | null>(null);
  // Bucket keys only exist within the query that produced them.
  useEffect(() => { setSelectedBucketKey(null); }, [filters]);

  const applyFilters = (next: UsageFilters) => {
    writeStoredUsageFilters(next);
    // Condition change → new result set → any old page token is dropped with
    // the react-query key; the session locator survives in the URL.
    setSearchParams(new URLSearchParams(usageFiltersToSearch(next, location.search)));
  };

  const usageQuery = useInfiniteQuery({
    queryKey: ['usage-v2', filters],
    queryFn: ({ pageParam }) =>
      client.getUsage(
        buildUsageApiQuery(filters, {
          timezoneOffsetMinutes: browserTimezoneOffsetMinutes(),
          pageSize: SESSION_PAGE_SIZE,
          pageToken: pageParam,
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.sessions.has_more ? (lastPage.sessions.next_page_token ?? undefined) : undefined,
  });
  // A session locator deep link must find its target even when it sits beyond
  // the first 25 rows: keep pulling pages with the server token until the
  // target appears or the result set is exhausted (a failed page fetch stops
  // the walk instead of retrying forever). `usageQuery.data` is a dep so the
  // walk re-evaluates on every arrived page, even when the fetching flags
  // flip within a single batched render.
  const locatedSession =
    sessionLocator !== undefined &&
    (usageQuery.data?.pages.some((page) =>
      page.sessions.items.some((item) => item.id === sessionLocator),
    ) ?? false);
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

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
    staleTime: 30_000,
  });
  const workspaces = useMemo(
    () => workspacesQuery.data?.items ?? [],
    [workspacesQuery.data],
  );

  const summary = firstPage?.summary;
  const reliability = firstPage?.reliability;
  const summaryTokens = summary !== undefined ? totalTokensOf(summary) : 0;
  const cacheHit = summary !== undefined ? cacheHitRateOf(summary) : null;
  const showAllHistoryChip = firstPage?.query.range.defaulted_to_all_history === true;
  const incompleteReason = reliability?.incomplete_reason ?? null;
  const showIncomplete =
    incompleteReason !== null || (reliability?.incomplete_sessions ?? 0) > 0;

  const breakdownTabLabel = t(`usage.dimension.${filters.dimension}`);

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-panel px-4">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={t('sv.openMenuAria')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-hairline text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink md:hidden"
        >
          <span aria-hidden>☰</span>
        </button>
        <h1 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold tracking-tight text-ink">
          {t('usage.title')}
        </h1>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4 lg:px-8">
        <div className="mx-auto max-w-[860px] space-y-4" data-usage-page>
          <LiveStrip />
          <FilterBar filters={filters} workspaces={workspaces} onChange={applyFilters} />

          {usageQuery.isPending ? (
            <div className="flex items-center justify-center gap-2 rounded-2xl border border-hairline bg-panel px-4 py-10 text-[12px] text-ink-faint">
              <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
              {t('usage.loading')}
            </div>
          ) : usageQuery.isError ? (
            <div className="rounded-2xl border border-danger/30 bg-danger/5 p-5">
              <p className="text-[12.5px] font-medium text-danger">{t('usage.loadFailed')}</p>
              <p className="mt-1 font-mono text-[10.5px] text-danger/80">
                {usageQuery.error instanceof Error ? usageQuery.error.message : t('common.unknownError')}
              </p>
              <button
                type="button"
                onClick={() => void usageQuery.refetch()}
                className="mt-2 text-[11.5px] font-medium text-danger underline"
              >
                {t('common.retry')}
              </button>
            </div>
          ) : firstPage !== undefined ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {showAllHistoryChip ? (
                  <span
                    data-usage-all-history
                    className="rounded-full border border-accent/30 bg-accent-soft px-2.5 py-0.5 text-[10.5px] font-medium text-accent"
                  >
                    {t('usage.allHistoryChip')}
                  </span>
                ) : null}
                {summary?.cost_unknown === true ? (
                  <span className="rounded-full border border-amber-rule/40 bg-amber-card px-2.5 py-0.5 text-[10.5px] font-medium text-amber-ink">
                    {t('usage.kpi.partialUnknown')}
                  </span>
                ) : null}
              </div>

              {showIncomplete ? (
                <p
                  data-usage-incomplete
                  className="rounded-xl border border-amber-rule/40 bg-amber-card px-3 py-2 text-[11px] leading-relaxed text-amber-ink"
                >
                  {incompleteReason !== null ? t(INCOMPLETE_REASON_KEYS[incompleteReason]) : null}
                  {reliability !== undefined && reliability.incomplete_sessions > 0
                    ? ` ${t('usage.incomplete.sessions', { count: reliability.incomplete_sessions })}`
                    : ''}
                </p>
              ) : null}
              {reliability !== undefined && reliability.unknown_price_models.length > 0 ? (
                <p className="rounded-xl border border-accent/25 bg-accent-soft px-3 py-2 text-[11px] leading-relaxed text-ink-soft">
                  {t('usage.partialCost', { models: reliability.unknown_price_models.join(', ') })}
                </p>
              ) : null}

              {summary !== undefined ? (
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <section className="rounded-2xl border border-hairline bg-panel p-4 shadow-[0_2px_4px_rgba(28,25,23,0.03)]">
                    <p className="text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
                      {t('usage.kpi.estimatedCost')}
                    </p>
                    <p className="mt-1.5 font-mono text-[22px] leading-none font-semibold text-ink tabular-nums">
                      {formatCostUsd(summary.cost_usd_estimated)}
                    </p>
                    {summary.cost_unknown ? (
                      <p className="mt-1 text-[10px] text-amber-ink">
                        {summary.cost_usd_estimated > 0
                          ? t('usage.kpi.partialUnknown')
                          : t('usage.kpi.pricingUnknown')}
                      </p>
                    ) : null}
                  </section>
                  <section className="rounded-2xl border border-hairline bg-panel p-4 shadow-[0_2px_4px_rgba(28,25,23,0.03)]">
                    <p className="text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
                      {t('usage.card.tokens')}
                    </p>
                    <p className="mt-1.5 font-mono text-[22px] leading-none font-semibold text-ink tabular-nums">
                      {time.formatTokens(summaryTokens)}
                    </p>
                    {cacheHit !== null ? (
                      <p className="mt-1 text-[10px] text-ink-faint" title={t('usage.cacheHitHint')}>
                        {t('usage.cacheHit', { percent: Math.round(cacheHit * 100) })}
                      </p>
                    ) : null}
                  </section>
                  <section className="rounded-2xl border border-hairline bg-panel p-4 shadow-[0_2px_4px_rgba(28,25,23,0.03)]">
                    <p className="text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
                      {t('usage.card.sessions')}
                    </p>
                    <p className="mt-1.5 font-mono text-[22px] leading-none font-semibold text-ink tabular-nums">
                      {formatGrouped(summary.session_count)}
                    </p>
                  </section>
                  <section className="col-span-2 rounded-2xl border border-hairline bg-panel p-4 shadow-[0_2px_4px_rgba(28,25,23,0.03)] lg:col-span-1">
                    <p className="text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
                      {t('usage.tokens.input')} / {t('usage.tokens.output')}
                    </p>
                    <p className="mt-1.5 font-mono text-[13px] leading-snug font-semibold text-ink tabular-nums">
                      {time.formatTokens(summary.tokens.input_other)} / {time.formatTokens(summary.tokens.output)}
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-ink-faint tabular-nums">
                      {t('usage.tokens.cacheRead')} {time.formatTokens(summary.tokens.input_cache_read)}
                      {' · '}
                      {t('usage.tokens.cacheWrite')} {time.formatTokens(summary.tokens.input_cache_creation)}
                    </p>
                  </section>
                </div>
              ) : null}

              {trend.length === 0 ? (
                <p className="rounded-2xl border border-hairline bg-panel px-4 py-10 text-center text-[12.5px] text-ink-faint">
                  {t('usage.empty')}
                </p>
              ) : (
                <TrendChart
                  trend={trend}
                  filters={filters}
                  selectedKey={selectedBucketKey}
                  onSelect={setSelectedBucketKey}
                />
              )}
              {selectedBucket !== undefined ? (
                <DrilldownPanel
                  bucket={selectedBucket}
                  filters={filters}
                  onClose={() => { setSelectedBucketKey(null); }}
                />
              ) : null}

              <Card
                title={
                  tab === 'sessions'
                    ? t('usage.tab.sessions')
                    : tab === 'breakdown'
                      ? breakdownTabLabel
                      : t('usage.tab.fiveHour')
                }
                aside={
                  <div
                    role="tablist"
                    aria-label={t('usage.title')}
                    className="ml-auto flex gap-1"
                    data-usage-tabs
                  >
                    {(
                      [
                        ['sessions', t('usage.tab.sessions')],
                        ['breakdown', breakdownTabLabel],
                        ['fiveHour', t('usage.tab.fiveHour')],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={tab === id}
                        data-usage-tab={id}
                        onClick={() => { selectTab(id); }}
                        className={`rounded-md px-2.5 py-1 text-[11.5px] transition-colors ${
                          tab === id
                            ? 'bg-accent-soft font-semibold text-accent'
                            : 'text-ink-soft hover:text-ink'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                }
              >
                {tab === 'sessions' ? (
                  <>
                    {sessionLocator !== undefined ? (
                      <p className="mb-2 flex items-center gap-2 text-[11px] text-ink-soft">
                        <span className="rounded-full border border-accent/30 bg-accent-soft px-2 py-0.5 font-medium text-accent">
                          {t('usage.sessions.deepLinkChip')}
                        </span>
                        <button
                          type="button"
                          className="text-ink-faint underline hover:text-ink"
                          onClick={() => { setDismissedLocator(sessionLocator); }}
                        >
                          {t('common.close')}
                        </button>
                      </p>
                    ) : null}
                    <SessionsTab
                      data={{ pages: usageQuery.data.pages }}
                      fetchNextPage={() => void usageQuery.fetchNextPage()}
                      hasNextPage={usageQuery.hasNextPage}
                      isFetchingNextPage={usageQuery.isFetchingNextPage}
                      sessionLocator={sessionLocator}
                      locatorSearching={locatorSearching}
                      workspaces={workspaces}
                    />
                  </>
                ) : tab === 'breakdown' ? (
                  <DimensionBreakdown trend={trend} filters={filters} />
                ) : (
                  <FiveHourTab
                    trend={trend}
                    filters={filters}
                    onSwitchGranularity={() => { applyFilters({ ...filters, granularity: 'five_hour' }); }}
                  />
                )}
              </Card>

              {reliability !== undefined ? <ReliabilityCard reliability={reliability} /> : null}
            </>
          ) : null}
        </div>
      </main>
    </>
  );
}
