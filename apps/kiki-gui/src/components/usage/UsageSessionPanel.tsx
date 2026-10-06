/**
 * Session trace — the explicit, on-demand step after reading sources. It opens
 * as a SidePanel rather than pushing another card into the reading flow, keeps
 * the page's own conditions as its base, and lists sessions with their title,
 * workspace and cost for exactly the period in question.
 *
 * A known source row narrows one axis of that base — its own — to the raw value
 * the record carries, so the sessions shown are the ones that produced that
 * row. Provider and profile are native dimensions with their own filter, so
 * both express an exact trace. An unknown or mixed source has no raw value to
 * send: it keeps the base conditions and offers the common time-window list
 * rather than inventing a filter the API would silently ignore.
 */

import { useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { formatCostUsd } from '@kiki/session-core/util';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import {
  buildUsageApiQuery,
  cacheHitRateOf,
  totalTokensOf,
  usageTokenTotalIsUnknown,
  type UsageFilters,
  type UsageGroupBy,
  type UsageResponseWire,
  type UsageSourceRow,
  type UsageWindow,
} from '../../lib/usageV2';
import { SidePanel } from '../SidePanel';
import { ThreadTitle } from '../ThreadTitle';
import { KnownSubtotalMarker, formatPercent } from './usageShared';

const PAGE_SIZE = 25;
/** Turn locators shown at once; the remainder is counted, not dropped. */
const TURN_PAGE = 24;

export interface UsageSessionTraceRequest {
  /** The exact period the reader is looking at. */
  readonly window: UsageWindow;
  /** The source row's exact filter, when the API can express it. */
  readonly filter: { readonly field: 'model' | 'provider' | 'profile' | 'workspace.id'; readonly value: string } | undefined;
  readonly label: string;
  readonly groupBy: UsageGroupBy;
}

/**
 * The filters the trace reads with.
 *
 * It starts from the page's own conditions rather than from nothing: the trace
 * answers "which sessions produced this number", and that number was already
 * narrowed by whatever the reader had selected. A source row then narrows one
 * more axis — its own — to the raw value that record carries. Every other axis,
 * including agent ids, the workspace and the archive flag, is left as the page
 * had it. An unknown row has no raw value to send, so it keeps the base
 * conditions and offers the common time-window trace instead of inventing one.
 */
function traceFilters(base: UsageFilters, request: UsageSessionTraceRequest): UsageFilters {
  const filter = request.filter;
  return {
    ...base,
    // An exact [A,B) window, so the sessions behind the number are the ones
    // that produced it rather than a whole preset re-read.
    range: 'custom',
    startAt: request.window.startAt,
    endAt: request.window.endAt,
    granularity: base.granularity,
    model: filter?.field === 'model' ? filter.value : base.model,
    provider: filter?.field === 'provider' ? filter.value : base.provider,
    profiles: filter?.field === 'profile' ? [filter.value] : base.profiles,
    workspaceId: filter?.field === 'workspace.id' ? filter.value : base.workspaceId,
  };
}

export function UsageSessionPanel({
  request,
  baseFilters,
  timezoneOffsetMinutes,
  workspaceName,
  onClose,
}: {
  readonly request: UsageSessionTraceRequest;
  readonly baseFilters: UsageFilters;
  readonly timezoneOffsetMinutes: number;
  readonly workspaceName: (id: string) => string | undefined;
  readonly onClose: () => void;
}) {
  const { client } = useConnection();
  const { t, time } = useI18n();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const filters = useMemo(() => traceFilters(baseFilters, request), [baseFilters, request]);

  const query = useInfiniteQuery({
    queryKey: ['usage-v2', 'trace', filters, timezoneOffsetMinutes],
    queryFn: ({ pageParam }) =>
      client.getUsage(
        buildUsageApiQuery(filters, { timezoneOffsetMinutes, pageSize: PAGE_SIZE, pageToken: pageParam }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.sessions.has_more ? (lastPage.sessions.next_page_token ?? undefined) : undefined,
  });

  const pages = query.data?.pages ?? [];
  const items = useMemo(() => pages.flatMap((page) => page.sessions.items), [pages]);
  const first = pages[0];
  const summary = first?.summary;
  // The same response's buckets carry this window's per-session turn
  // attribution, so locating a record needs no second request.
  const turnIndex = useMemo(() => {
    const index = new Map<string, { turnIds: number[]; truncated: boolean; unknown: number }>();
    for (const bucket of first?.trend ?? []) {
      for (const entry of bucket.drilldown.sessions) {
        const record = index.get(entry.session_id) ?? { turnIds: [], truncated: false, unknown: 0 };
        for (const turnId of entry.turn_ids) if (!record.turnIds.includes(turnId)) record.turnIds.push(turnId);
        record.truncated ||= entry.turn_ids_truncated;
        record.unknown += entry.unknown_turn_records;
        index.set(entry.session_id, record);
      }
    }
    for (const record of index.values()) record.turnIds.sort((left, right) => left - right);
    return index;
  }, [first]);

  return (
    <SidePanel
      overlayId="usage-session-trace"
      data={{ 'data-usage-session-panel': 'true' }}
      title={t('usage.sessions.panelTitle')}
      description={request.label}
      onClose={onClose}
      width="lg"
    >
      <div className="space-y-4">
        {request.filter !== undefined ? (
          <p className="text-[12.5px] leading-relaxed text-ink-faint">
            {t('usage.sessions.filtered', {
              field: t(`usage.filter.field.${request.filter.field === 'workspace.id' ? 'workspace' : request.filter.field}`),
              value: request.filter.value,
            })}
          </p>
        ) : null}
        {summary !== undefined ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-y border-hairline py-3 sm:grid-cols-4">
            <div>
              <dt className="text-[11.5px] text-ink-faint">{t('usage.sources.windowTotal')}</dt>
              <dd data-usage-trace-total className="font-mono text-[18px] text-ink tabular-nums">
                {usageTokenTotalIsUnknown(summary) ? '—' : formatCostUsd(summary.cost_usd_estimated)}
              </dd>
            </div>
            <div>
              <dt className="text-[11.5px] text-ink-faint">{t('usage.card.tokens')}</dt>
              <dd className="font-mono text-[13px] text-ink tabular-nums">
                {usageTokenTotalIsUnknown(summary) ? '—' : time.formatTokens(totalTokensOf(summary))}
              </dd>
            </div>
            <div>
              <dt className="text-[11.5px] text-ink-faint">{t('usage.kpi.cacheHit')}</dt>
              <dd className="font-mono text-[13px] text-ink tabular-nums">
                {usageTokenTotalIsUnknown(summary) ? '—' : formatPercent(cacheHitRateOf(summary))}
              </dd>
            </div>
            <div>
              <dt className="text-[11.5px] text-ink-faint">{t('usage.card.sessions')}</dt>
              <dd className="font-mono text-[13px] text-ink tabular-nums">{first?.sessions.total ?? 0}</dd>
            </div>
          </dl>
        ) : null}
        {query.isPending ? (
          <p role="status" className="flex items-center gap-2 text-[13px] text-ink-faint">
            <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
            {t('usage.loading')}
          </p>
        ) : query.isError ? (
          <div className="rounded-lg border border-danger/30 bg-danger/5 p-3">
            <p className="text-[13px] text-danger">{t('usage.sessions.loadFailed')}</p>
            <button
              type="button"
              onClick={() => { void query.refetch(); }}
              className="mt-2 h-8 rounded-md border border-danger/40 px-3 text-[13px] text-danger hover:bg-danger/5 pointer-coarse:min-h-11"
            >
              {t('common.retry')}
            </button>
          </div>
        ) : null}
        <ul data-usage-trace-sessions className="divide-y divide-hairline">
          {items.map((item) => (
            <SessionTraceRow
              key={item.id}
              item={item}
              turns={turnIndex.get(item.id)}
              expanded={expanded.has(item.id)}
              workspaceName={workspaceName}
              onOpen={() => { void navigate(`/s/${item.id}`); }}
              onToggle={() => {
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(item.id)) next.delete(item.id);
                  else next.add(item.id);
                  return next;
                });
              }}
              onOpenTurn={(turnId) => { void navigate(`/s/${item.id}?turn=${turnId}`); }}
            />
          ))}
        </ul>
        {query.hasNextPage ? (
          <button
            type="button"
            data-usage-trace-load-more
            onClick={() => { void query.fetchNextPage(); }}
            disabled={query.isFetchingNextPage}
            className="h-9 w-full rounded-md border border-hairline text-[13px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:opacity-50 pointer-coarse:min-h-11"
          >
            {t('usage.sessions.loadMore', { shown: items.length, total: first?.sessions.total ?? items.length })}
          </button>
        ) : null}
        {query.isFetchNextPageError ? (
          <button
            type="button"
            onClick={() => { void query.fetchNextPage(); }}
            className="h-9 w-full rounded-md border border-danger/40 text-[13px] text-danger pointer-coarse:min-h-11"
          >
            {t('usage.sessions.loadMoreFailed')}
          </button>
        ) : null}
      </div>
    </SidePanel>
  );
}

function SessionTraceRow({
  item,
  turns,
  expanded,
  workspaceName,
  onOpen,
  onToggle,
  onOpenTurn,
}: {
  readonly item: UsageResponseWire['sessions']['items'][number];
  /** This window's turn attribution for the session, when the wire has it. */
  readonly turns: { turnIds: number[]; truncated: boolean; unknown: number } | undefined;
  readonly expanded: boolean;
  readonly workspaceName: (id: string) => string | undefined;
  readonly onOpen: () => void;
  readonly onToggle: () => void;
  readonly onOpenTurn: (turnId: number) => void;
}) {
  const { t, time } = useI18n();
  const unknownTotal = usageTokenTotalIsUnknown(item.usage);
  return (
    <li className="py-2.5">
      <div className="flex items-baseline gap-3">
        <button
          type="button"
          data-usage-trace-session={item.id}
          onClick={onOpen}
          className="min-w-0 flex-1 truncate text-left text-[13px] text-ink underline-offset-2 transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink"
        >
          <ThreadTitle text={item.title ?? t('sidebar.untitled')} />
        </button>
        <span className="shrink-0 font-mono text-[13px] font-semibold text-ink tabular-nums">
          {unknownTotal ? '—' : formatCostUsd(item.usage.cost_usd_estimated)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-faint">
        <span className="truncate">{workspaceName(item.workspace_id) ?? item.workspace_id}</span>
        <span className="font-mono tabular-nums">
          {unknownTotal ? '—' : time.formatTokens(totalTokensOf(item.usage))} {t('usage.col.tokens')}
        </span>
        <span className="font-mono tabular-nums">
          {unknownTotal ? '—' : formatPercent(cacheHitRateOf(item.usage))}
        </span>
        <span>{time.relativeTime(new Date(item.updated_at).toISOString())}</span>
        {item.archived ? (
          <span className="rounded-full border border-hairline px-1.5">{t('sidebar.archived')}</span>
        ) : null}
        {item.usage.cost_unknown || item.usage.tokens_unknown === true ? <KnownSubtotalMarker /> : null}
      </div>
      <button
        type="button"
        data-usage-trace-locate={item.id}
        aria-expanded={expanded}
        onClick={onToggle}
        className="mt-1.5 text-[12px] text-ink-soft underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
      >
        {expanded ? t('usage.sessions.hideRaw') : t('usage.sessions.locateRaw')}
      </button>
      {expanded ? (
        turns !== undefined && turns.turnIds.length > 0 ? (
          <div data-usage-trace-turns className="mt-1.5 flex flex-wrap items-center gap-1">
            {/* A busy session can carry hundreds of turns in a week. Showing
                every id turns the locator into a wall of buttons, so the first
                page is offered and the rest counted rather than hidden. */}
            {turns.turnIds.slice(0, TURN_PAGE).map((turnId) => (
              <button
                key={turnId}
                type="button"
                data-usage-trace-turn={turnId}
                onClick={() => { onOpenTurn(turnId); }}
                title={t('usage.drilldown.turnHint')}
                className="min-h-8 rounded-md border border-hairline bg-paper px-2 font-mono text-[11px] text-ink-soft tabular-nums transition-colors hover:border-accent hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
              >
                {t('usage.drilldown.turnId', { id: turnId })}
              </button>
            ))}
            {turns.turnIds.length > TURN_PAGE ? (
              <span data-usage-trace-turns-more className="text-[11.5px] text-ink-faint">
                {t('usage.sessions.moreTurns', { count: turns.turnIds.length - TURN_PAGE })}
              </span>
            ) : null}
            {turns.truncated ? (
              <span className="text-[11.5px] text-amber-ink">{t('usage.drilldown.turnIdsTruncated')}</span>
            ) : null}
            {turns.unknown > 0 ? (
              <span className="text-[11.5px] text-amber-ink">
                {t('usage.drilldown.unknownTurns', { count: turns.unknown })}
              </span>
            ) : null}
          </div>
        ) : (
          // No turn attribution in this window: the session itself is the
          // accurate target, so say that instead of offering a locator that
          // would land nowhere.
          <p data-usage-trace-no-turns className="mt-1 text-[11.5px] text-ink-faint">
            {t('usage.sessions.noTurnAttribution')}
          </p>
        )
      ) : null}
    </li>
  );
}