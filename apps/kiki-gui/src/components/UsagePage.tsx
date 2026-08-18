/**
 * UsagePage (/usage) — the cross-session usage dashboard. Aggregates the
 * polled Session records' lifetime `usage` counters (the only usage signal
 * the wire exposes): overview totals with a token/cache breakdown, a
 * per-model rollup, per-day activity buckets, and the session ranking with
 * jump-to-session. All aggregation lives in lib/usage (pure, unit-tested);
 * this file owns data fetching and presentation only.
 *
 * Cost surfaces stay hidden while all reported costs are 0. When the server
 * supplies per-model cost decomposition, the model chart uses those recorded
 * aliases rather than assigning the whole session cost to its configured model.
 *
 * Honesty rules (surfaced in the footer + the by-day hint): deleted sessions
 * are invisible to the REST surface, and per-day buckets group sessions by
 * last activity — a bucket's height is the lifetime usage of sessions last
 * active that day, not usage strictly produced that day.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import type { Session } from '@moonshot-ai/protocol';

import { useI18n, type Locale } from '../i18n';
import type { KikiClient } from '../lib/client';
import { switcherSessionLabel } from '../lib/quickSwitcher';
import {
  aggregateUsage,
  bucketSessionsByDay,
  earliestActivityDay,
  filterSessionsByRange,
  formatCostUsd,
  formatGrouped,
  groupUsageByModel,
  localDayStart,
  rankSessionsByCost,
  rankSessionsByTokens,
  USAGE_RANGES,
  usageRangeStart,
  type UsageRange,
} from '../lib/usage';
import { useConnection } from '../state/connection';
import { Toggle } from './controls';

/** Every session the server still holds, archived included (paged exhaustively). */
async function fetchAllSessions(client: KikiClient): Promise<Session[]> {
  const all: Session[] = [];
  let before: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const response = await client.listSessions({
      page_size: 100,
      include_archive: true,
      before_id: before,
    });
    all.push(...response.items);
    if (!response.has_more || response.items.length === 0) break;
    before = response.items.at(-1)?.id;
  }
  return all;
}

type ModelUsageRow = ReturnType<typeof groupUsageByModel>[number];
type UsageCostDetails = Session['usage'] & {
  readonly by_model?: Record<string, number>;
  readonly cost_unknown_models?: readonly string[];
};

function modelUsageWithCosts(sessions: readonly Session[]): ModelUsageRow[] {
  const baseRows = groupUsageByModel(sessions);
  const costs = new Map<string, { costUsd: number; sessions: Set<string> }>();
  for (const session of sessions) {
    const details = session.usage as UsageCostDetails;
    const entries = Object.entries(details.by_model ?? {});
    if (entries.length === 0 && details.total_cost_usd > 0) {
      entries.push([session.agent_config.model, details.total_cost_usd]);
    }
    for (const [model, costUsd] of entries) {
      const entry = costs.get(model) ?? { costUsd: 0, sessions: new Set<string>() };
      entry.costUsd += costUsd;
      entry.sessions.add(session.id);
      costs.set(model, entry);
    }
  }

  const rows = new Map(baseRows.map((row) => [row.model, { ...row, costUsd: 0 }]));
  for (const [model, cost] of costs) {
    const row = rows.get(model);
    rows.set(
      model,
      row === undefined
        ? {
            model,
            sessions: cost.sessions.size,
            turns: 0,
            costUsd: cost.costUsd,
            totalTokens: 0,
          }
        : { ...row, costUsd: cost.costUsd },
    );
  }
  return [...rows.values()].toSorted(
    (a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens,
  );
}

function dayLabel(dayStartMs: number, locale: Locale): string {
  return new Date(dayStartMs).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en', {
    month: 'short',
    day: 'numeric',
  });
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-hairline bg-panel p-5 shadow-[0_2px_4px_rgba(28,25,23,0.03)]">
      <h2 className="mb-4 font-display text-[16px] font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <section className="rounded-2xl border border-hairline bg-panel p-4 shadow-[0_2px_4px_rgba(28,25,23,0.03)]">
      <p className="text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">{label}</p>
      <p className="mt-1.5 font-mono text-[22px] leading-none font-semibold text-ink tabular-nums">
        {value}
      </p>
    </section>
  );
}

export function UsagePage({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { client } = useConnection();
  const { t, tp, locale, time } = useI18n();
  const navigate = useNavigate();
  const [range, setRange] = useState<UsageRange>('30d');
  const [includeArchived, setIncludeArchived] = useState(true);
  // The day-bucket clock is captured once per mount so a page left open over
  // midnight shifts buckets on the next refetch-driven re-render, not mid-view.
  const [nowMs] = useState(() => Date.now());

  const sessionsQuery = useQuery({
    queryKey: ['usage-sessions'],
    queryFn: () => fetchAllSessions(client),
  });
  const allSessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);

  const filtered = useMemo(
    () => filterSessionsByRange(allSessions, range, nowMs, { includeArchived }),
    [allSessions, range, nowMs, includeArchived],
  );
  const totals = useMemo(() => aggregateUsage(filtered), [filtered]);
  const models = useMemo(() => modelUsageWithCosts(filtered), [filtered]);
  const unknownModels = useMemo(
    () =>
      [
        ...new Set(
          filtered.flatMap(
            (session) =>
              (session.usage as UsageCostDetails).cost_unknown_models ?? [],
          ),
        ),
      ].toSorted(),
    [filtered],
  );
  const showCost = totals.costUsd > 0;
  const ranked = useMemo(
    () => (showCost ? rankSessionsByCost(filtered) : rankSessionsByTokens(filtered)),
    [filtered, showCost],
  );
  const untitled = t('sidebar.untitled');

  const todayMs = localDayStart(nowMs);
  const buckets = useMemo(() => {
    const from =
      range === 'all'
        ? (earliestActivityDay(filtered) ?? todayMs)
        : (usageRangeStart(range, nowMs) ?? todayMs);
    return bucketSessionsByDay(filtered, from, todayMs);
  }, [filtered, range, nowMs, todayMs]);
  const maxBucketCost = Math.max(0, ...buckets.map((bucket) => bucket.costUsd));
  const maxBucketTokens = Math.max(0, ...buckets.map((bucket) => bucket.totalTokens));
  const maxModelCost = Math.max(0, ...models.map((model) => model.costUsd));
  const maxModelTokens = Math.max(0, ...models.map((model) => model.totalTokens));

  const tokenCells: readonly { label: string; value: number }[] = [
    { label: t('usage.tokens.input'), value: totals.inputTokens },
    { label: t('usage.tokens.output'), value: totals.outputTokens },
    { label: t('usage.tokens.cacheRead'), value: totals.cacheReadTokens },
    { label: t('usage.tokens.cacheWrite'), value: totals.cacheCreationTokens },
  ];

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
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 lg:px-8">
        <div className="mx-auto max-w-[860px] space-y-5" data-usage-page>
          <div className="flex flex-wrap items-center gap-3">
            <div
              role="group"
              aria-label={t('usage.title')}
              className="inline-flex rounded-lg border border-hairline bg-panel p-0.5"
            >
              {USAGE_RANGES.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  data-range={candidate}
                  onClick={() => { setRange(candidate); }}
                  aria-pressed={range === candidate}
                  className={`rounded-md px-2.5 py-1 text-[11.5px] transition-colors ${
                    range === candidate
                      ? 'bg-accent-soft font-semibold text-accent'
                      : 'text-ink-soft hover:text-ink'
                  }`}
                >
                  {t(`usage.range.${candidate}`)}
                </button>
              ))}
            </div>
            <div className="ml-auto text-[11.5px] text-ink-soft">
              <Toggle
                label={t('usage.includeArchived')}
                checked={includeArchived}
                onChange={setIncludeArchived}
              />
            </div>
          </div>

          {sessionsQuery.isPending ? (
            <div className="flex items-center justify-center gap-2 rounded-2xl border border-hairline bg-panel px-4 py-10 text-[12px] text-ink-faint">
              <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
              {t('usage.loading')}
            </div>
          ) : sessionsQuery.isError ? (
            <div className="rounded-2xl border border-danger/30 bg-danger/5 p-5">
              <p className="text-[12.5px] font-medium text-danger">{t('usage.loadFailed')}</p>
              <p className="mt-1 font-mono text-[10.5px] text-danger/80">
                {sessionsQuery.error instanceof Error
                  ? sessionsQuery.error.message
                  : t('common.unknownError')}
              </p>
              <button
                type="button"
                onClick={() => void sessionsQuery.refetch()}
                className="mt-2 text-[11.5px] font-medium text-danger underline"
              >
                {t('common.retry')}
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <p className="rounded-2xl border border-hairline bg-panel px-4 py-10 text-center text-[12.5px] text-ink-faint">
              {t('usage.empty')}
            </p>
          ) : (
            <>
              {unknownModels.length > 0 ? (
                <p className="rounded-xl border border-accent/25 bg-accent-soft px-3 py-2 text-[11px] leading-relaxed text-ink-soft">
                  {t('usage.partialCost', { models: unknownModels.join(', ') })}
                </p>
              ) : null}
              <div className={`grid grid-cols-2 gap-3 ${showCost ? 'lg:grid-cols-3' : ''}`}>
                {showCost ? (
                  <StatCard label={t('usage.card.cost')} value={formatCostUsd(totals.costUsd)} />
                ) : null}
                <StatCard label={t('usage.card.sessions')} value={formatGrouped(totals.sessions)} />
                <StatCard label={t('usage.card.turns')} value={formatGrouped(totals.turns)} />
                <section className={`col-span-2 rounded-2xl border border-hairline bg-panel p-5 shadow-[0_2px_4px_rgba(28,25,23,0.03)] ${showCost ? 'lg:col-span-3' : ''}`}>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h2 className="text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
                      {t('usage.card.tokens')}
                    </h2>
                    <p className="font-mono text-[22px] leading-none font-semibold text-ink tabular-nums">
                      {time.formatTokens(totals.totalTokens)}
                    </p>
                    {totals.cacheHitRate !== null ? (
                      <span className="rounded-full border border-accent/30 bg-accent-soft px-2 py-0.5 font-mono text-[10px] font-semibold text-accent tabular-nums">
                        {t('usage.cacheHit', { percent: Math.round(totals.cacheHitRate * 100) })}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {tokenCells.map((cell) => (
                      <div key={cell.label}>
                        <p className="text-[10px] text-ink-faint">{cell.label}</p>
                        <p
                          className="mt-0.5 font-mono text-[15px] font-semibold text-ink tabular-nums"
                          title={formatGrouped(cell.value)}
                        >
                          {time.formatTokens(cell.value)}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>
              </div>

              <Card title={t('usage.byModel')}>
                <div className="space-y-3.5">
                  {models.map((model) => {
                    const metric = showCost ? model.costUsd : model.totalTokens;
                    const maxMetric = showCost ? maxModelCost : maxModelTokens;
                    return (
                    <div key={model.model === '' ? '(default)' : model.model}>
                      <div className="flex items-baseline gap-2">
                        <span
                          className={`min-w-0 truncate font-mono text-[12px] ${model.model === '' ? 'text-ink-soft' : 'text-ink'}`}
                        >
                          {model.model === '' ? t('usage.modelDefault') : model.model}
                        </span>
                        <span className="ml-auto shrink-0 font-mono text-[12px] font-semibold text-ink tabular-nums">
                          {showCost ? formatCostUsd(model.costUsd) : time.formatTokens(model.totalTokens)}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hairline/60">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{
                            width: `${maxMetric > 0 ? Math.max(2, (metric / maxMetric) * 100) : 2}%`,
                          }}
                        />
                      </div>
                      <p className="mt-1 font-mono text-[10px] text-ink-faint tabular-nums">
                        {tp('usage.sessionChip', model.sessions)} ·{' '}
                        {t('rail.goalUsage', {
                          turns: formatGrouped(model.turns),
                          tokens: time.formatTokens(model.totalTokens),
                        })}
                      </p>
                    </div>
                    );
                  })}
                </div>
              </Card>

              <Card title={t('usage.byDay')}>
                <div className="flex h-28 items-end gap-[3px]" role="img" aria-label={t('usage.byDay')}>
                  {buckets.map((bucket) => {
                    const isToday = bucket.dayStartMs === todayMs;
                    const metric = showCost ? bucket.costUsd : bucket.totalTokens;
                    const maxMetric = showCost ? maxBucketCost : maxBucketTokens;
                    const height = metric > 0 && maxMetric > 0 ? Math.max(4, (metric / maxMetric) * 100) : 0;
                    const titleParts = [
                      dayLabel(bucket.dayStartMs, locale),
                      `${time.formatTokens(bucket.totalTokens)} ${t('usage.col.tokens')}`,
                    ];
                    if (showCost) titleParts.push(formatCostUsd(bucket.costUsd));
                    titleParts.push(tp('usage.sessionChip', bucket.sessions));
                    return (
                      <div
                        key={bucket.dayStartMs}
                        className="flex min-w-0 flex-1 flex-col justify-end self-stretch"
                        title={titleParts.join(' · ')}
                      >
                        <div
                          className={`w-full rounded-t-[3px] transition-colors ${
                            metric > 0
                              ? isToday
                                ? 'bg-accent'
                                : 'bg-accent/55 hover:bg-accent/80'
                              : 'bg-hairline/70'
                          }`}
                          style={{ height: metric > 0 ? `${height}%` : '2px' }}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="mt-1.5 flex items-baseline justify-between text-[9.5px] text-ink-faint">
                  <span className="font-mono tabular-nums">
                    {buckets.length > 0 ? dayLabel(buckets[0]?.dayStartMs ?? todayMs, locale) : ''}
                  </span>
                  <span className="font-mono tabular-nums">
                    {buckets.length > 1 ? dayLabel(buckets.at(-1)?.dayStartMs ?? todayMs, locale) : ''}
                  </span>
                </div>
                <p className="mt-2 text-[10.5px] leading-snug text-ink-faint">{t('usage.byDayHint')}</p>
              </Card>

              <Card title={showCost ? t('usage.topSessions') : t('usage.topSessionsByTokens')}>
                <div className="flex items-center gap-3 px-2 pb-1 text-[9.5px] font-semibold tracking-[0.06em] text-ink-faint uppercase">
                  <span className="w-6 shrink-0 text-right">#</span>
                  <span className="min-w-0 flex-1">{t('usage.col.session')}</span>
                  <span className="hidden w-36 shrink-0 sm:block">{t('usage.col.model')}</span>
                  <span className="hidden w-20 shrink-0 text-right md:block">{t('usage.col.tokens')}</span>
                  <span className="hidden w-14 shrink-0 text-right md:block">{t('usage.col.turns')}</span>
                  <span className="hidden w-20 shrink-0 text-right lg:block">{t('usage.col.updated')}</span>
                  {showCost ? (
                    <span className="w-20 shrink-0 text-right">{t('usage.col.cost')}</span>
                  ) : null}
                </div>
                <div className="max-h-[340px] overflow-y-auto">
                  {ranked.map((session, index) => {
                    const tokens =
                      session.usage.input_tokens +
                      session.usage.output_tokens +
                      session.usage.cache_read_tokens +
                      session.usage.cache_creation_tokens;
                    return (
                      <button
                        key={session.id}
                        type="button"
                        onClick={() => void navigate(`/s/${session.id}`)}
                        className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-paper"
                      >
                        <span className="w-6 shrink-0 text-right font-mono text-[10px] text-ink-faint tabular-nums">
                          {index + 1}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                          {switcherSessionLabel(session, untitled)}
                          {session.archived === true ? (
                            <span className="ml-1.5 rounded-full border border-hairline px-1.5 py-px text-[9px] text-ink-faint">
                              {t('sidebar.archived')}
                            </span>
                          ) : null}
                        </span>
                        <span className="hidden w-36 shrink-0 truncate font-mono text-[10.5px] text-ink-faint sm:block">
                          {session.agent_config.model === ''
                            ? t('usage.modelDefault')
                            : session.agent_config.model}
                        </span>
                        <span className="hidden w-20 shrink-0 text-right font-mono text-[10.5px] text-ink-faint tabular-nums md:block">
                          {time.formatTokens(tokens)}
                        </span>
                        <span className="hidden w-14 shrink-0 text-right font-mono text-[10.5px] text-ink-faint tabular-nums md:block">
                          {formatGrouped(session.usage.turn_count)}
                        </span>
                        <span className="hidden w-20 shrink-0 text-right font-mono text-[10.5px] text-ink-faint lg:block">
                          {time.relativeTime(session.updated_at)}
                        </span>
                        {showCost ? (
                          <span className="w-20 shrink-0 text-right font-mono text-[11.5px] font-semibold text-ink tabular-nums">
                            {formatCostUsd(session.usage.total_cost_usd)}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </Card>
            </>
          )}

          <p className="pb-2 text-center text-[10.5px] text-ink-faint">{t('usage.footerNote')}</p>
        </div>
      </main>
    </>
  );
}
