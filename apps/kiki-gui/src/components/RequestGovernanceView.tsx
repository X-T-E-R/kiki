/**
 * The Live tab (`运行 → 实时`): answers "how many concurrent requests are running,
 * which models/caps hold them, and which conversation needs me?" on first paint
 * without full-width chart bars or a 9-rule config wall.
 *
 * Reading order:
 *   1. Prominent top concurrency strip (`24/28` bold tabular figures: concurrent
 *      requests + queued, active agents + main/sub split, active sessions + freshness
 *      & PauseAllExecutions)
 *   2. Needs you (approvals / questions / budget pauses — only when real items exist)
 *   3. Live concurrency (`实时并发` — open by default when active/queued/capped, with
 *      inline quiet dimension tabs `模型 · 提供商 · 执行器 · 角色`, compact `w-20`
 *      cap meters `active / limit` when capped, and `N 并发` when uncapped)
 *   4. Current sessions (all active, queued-waiting, and held/recovery sessions with
 *      per-session `N 并发 · Model · M 个智能体`)
 *   5. Footer disclosures (closed by default):
 *      - Agent breakdown (`executor / profile / model / role / session`)
 *      - Manage concurrency rules (opens ConcurrencyRulesEditor inline on click or ?panel=limits)
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { ModelCatalogItem, RequestGovernanceSnapshot, RoomListItem, Session } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';
import { buildConversationInbox, type InboxReason } from '@kiki/session-core/sessions';
import { formatWorkingDuration } from './composerWorking';

import { useI18n } from '../i18n';
import {
  liveInventorySessionIds,
  usePausedSessionDiscovery,
  useSessionExecutions,
} from '../lib/executionControls';
import { useLiveAgentGovernance, type LiveAgentDimensionKind, type LiveAgentSnapshot } from '../lib/liveAgentGovernance';
import { useRequestGovernance } from '../lib/useRequestGovernance';
import { sanitizeDisplayTitle, useSessionNames } from '../lib/threadTitles';
import { ROOM_ITEMS_QUERY_KEY } from '../lib/useConversationList';
import { useConnection } from '../state/connection';
import { cachedSessionsFromQueryData } from '../lib/threadRefs';
import { useSessionSeen } from '../lib/sessionSeen';
import { DisclosureChevron, Icon } from './icons';
import { ConcurrencyRulesEditor, type GovernanceRule } from './usage/ConcurrencyRulesEditor';
import {
  PauseAllExecutions,
  SessionExecutionActions,
  sessionLabelOf,
  sessionLabelText,
  type SessionLabel,
} from './usage/ExecutionControls';
import {
  formatRuntimeModelLabel,
  projectLiveRuntime,
  type LiveConcurrencyBucketRow,
  type LiveConcurrencyDimension,
  type LivePendingRow,
  type LivePressuredRuleRow,
  type LiveSessionRow,
} from './usage/liveRuntimeProjection';
import { AxisGroup } from './usage/usageShared';

export const CONCURRENCY_RULES_SETTINGS_HREF = '/settings/ai?tab=defaults#st-card-concurrency';

const EMPTY_MODELS: readonly ModelCatalogItem[] = [];
const EMPTY_ROOMS: readonly RoomListItem[] = [];

const REASON_LABEL_KEY: Record<InboxReason, I18nKey> = {
  approval: 'activity.reason.approval',
  question: 'activity.reason.question',
  budget: 'activity.reason.budget',
  interrupted: 'activity.reason.interrupted',
  completed: 'activity.reason.completed',
  failed: 'activity.reason.failed',
  cancelled: 'activity.reason.cancelled',
  running: 'activity.reason.running',
};

/**
 * The sidebar's Activity badge: live active and queued model request counts in
 * quiet tabular figures (`3`, `3 · +1`, `+1` in the expanded sidebar; `3`,
 * `3+1`, `+1` in the collapsed rail) while work is running or waiting, and
 * silent when idle.
 */
export function RequestGovernanceBadge({ compact = false }: { compact?: boolean }) {
  const { snapshot, stale } = useRequestGovernance({ background: true });
  const { t } = useI18n();
  if (snapshot === undefined || (snapshot.active === 0 && snapshot.queued === 0)) return null;
  const title = `${t('usage.governance.badge', { active: snapshot.active, queued: snapshot.queued })}${stale ? ` · ${t('usage.governance.stale', { time: snapshot.asOf })}` : ''}`;
  const label = snapshot.active > 0 && snapshot.queued > 0
    ? (compact ? `${snapshot.active}+${snapshot.queued}` : `${snapshot.active} · +${snapshot.queued}`)
    : snapshot.active > 0
      ? String(snapshot.active)
      : `+${snapshot.queued}`;
  return (
    <span
      data-request-governance-badge
      data-stale={stale || undefined}
      title={title}
      aria-label={title}
      className={compact
        ? 'absolute -right-2 -bottom-1 whitespace-nowrap rounded bg-paper px-0.5 font-mono text-[10px] leading-3 text-[var(--kiki-chart-muted)] tabular-nums'
        : 'ml-auto shrink-0 font-mono text-[12px] leading-4 text-[var(--kiki-chart-muted)] tabular-nums'}
    >
      {label}
    </span>
  );
}

function useSharedClockMs(active: boolean, frozenAtMs?: number): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    const timer = setInterval(() => { setNowMs(Date.now()); }, 1000);
    return () => { clearInterval(timer); };
  }, [active]);
  return active ? nowMs : (frozenAtMs ?? nowMs);
}

function formatLiveElapsed(
  startedAtMs: number | undefined,
  waitedMs: number | undefined,
  nowMs: number,
  t: (key: I18nKey, params?: Record<string, string | number>) => string,
): string | undefined {
  const elapsed = startedAtMs !== undefined
    ? Math.max(0, nowMs - startedAtMs)
    : waitedMs !== undefined
      ? Math.max(0, waitedMs)
      : undefined;
  if (elapsed === undefined) return undefined;
  return formatWorkingDuration(elapsed, t);
}

export function RequestGovernanceView({ view = 'realtime' }: { view?: 'realtime' | 'limits' } = {}) {
  const { snapshot: requestSnapshot, stale: requestStale, loading: requestLoading } = useRequestGovernance();
  const liveAgent = useLiveAgentGovernance();
  const { client } = useConnection();
  const { t, locale, time } = useI18n();
  const queryClient = useQueryClient();
  const limitsRef = useRef<HTMLDivElement>(null);
  const manageBtnRef = useRef<HTMLButtonElement>(null);

  const [rulesOpen, setRulesOpen] = useState<boolean>(view === 'limits');
  const [focusRuleRequest, setFocusRuleRequest] = useState<{ readonly id: string; readonly seq: number } | null>(null);
  const [breakdownOpen, setBreakdownOpen] = useState<boolean>(false);
  const [chosenConcurrencyDim, setChosenConcurrencyDim] = useState<LiveConcurrencyDimension | null>(null);

  const agentSnapshot = liveAgent.snapshot ?? undefined;
  const rules: readonly GovernanceRule[] = useMemo(() => {
    if (requestSnapshot !== undefined) return requestSnapshot.rules;
    return (agentSnapshot?.rules ?? []).map((rule): GovernanceRule => ({
      ...rule,
      executors: rule.executors ? [...rule.executors] : undefined,
      profiles: rule.profiles ? [...rule.profiles] : undefined,
      models: rule.models ? [...rule.models] : undefined,
      providers: rule.providers ? [...rule.providers] : undefined,
      roles: rule.roles ? [...rule.roles] : undefined,
      subagentsOnly: rule.subagentsOnly ?? false,
      maxConcurrent: rule.maxConcurrent ?? 1,
    }));
  }, [requestSnapshot, agentSnapshot]);
  const enabledRules = rules.filter((rule) => rule.enabled).length;

  useEffect(() => {
    if (view !== 'limits') return;
    setRulesOpen(true);
    requestAnimationFrame(() => {
      limitsRef.current?.scrollIntoView?.({ block: 'start' });
      limitsRef.current?.focus({ preventScroll: true });
    });
  }, [view]);

  const catalogModels = queryClient.getQueryData<{ readonly items?: readonly ModelCatalogItem[] }>(['models'])?.items ?? EMPTY_MODELS;

  const seen = useSessionSeen();
  const cachedSessions = useMemo(() => {
    const byId = new Map<string, Session>();
    for (const [, data] of queryClient.getQueriesData({ queryKey: ['sessions'] })) {
      for (const session of cachedSessionsFromQueryData(data)) {
        if (!byId.has(session.id)) byId.set(session.id, session);
      }
    }
    return [...byId.values()];
  }, [queryClient, requestSnapshot?.asOf, agentSnapshot?.asOf]);

  const fallbackSessionsQuery = useQuery({
    queryKey: ['live-pending-sessions-head'],
    queryFn: () => client.listSessions({ page_size: 50 }),
    enabled: cachedSessions.length === 0 && typeof client?.listSessions === 'function',
    staleTime: 15_000,
    retry: false,
  });

  const inboxSessions = cachedSessions.length > 0
    ? cachedSessions
    : (fallbackSessionsQuery.data?.items ?? []);
  const cachedRooms = queryClient.getQueryData<readonly RoomListItem[]>(ROOM_ITEMS_QUERY_KEY) ?? EMPTY_ROOMS;
  const inbox = useMemo(
    () => buildConversationInbox(inboxSessions, cachedRooms, seen),
    [inboxSessions, cachedRooms, seen],
  );

  const liveSessionIds = liveInventorySessionIds(agentSnapshot?.agents);
  const pausedDiscovery = usePausedSessionDiscovery();
  const executionSessionIds = useMemo(
    () => [...new Set([...liveSessionIds, ...pausedDiscovery.sessionIds])],
    [liveSessionIds, pausedDiscovery.sessionIds],
  );
  const { states: executionStates, readError: executionReadError, refetch: refetchExecutions } = useSessionExecutions(executionSessionIds);

  const sessionDimensionIds = useMemo(
    () => (agentSnapshot?.dimensions ?? [])
      .filter((row) => row.dimension === 'session' && row.id !== null && row.id !== '' && row.id !== 'unknown')
      .map((row) => row.id!),
    [agentSnapshot?.dimensions],
  );
  const fetchedSessionIds = useMemo(
    () => [...new Set([...executionSessionIds, ...sessionDimensionIds])],
    [executionSessionIds, sessionDimensionIds],
  );
  const nameOf = useSessionNames(fetchedSessionIds);
  const cachedTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of cachedSessions) {
      map.set(s.id, s.title ?? '');
    }
    return map;
  }, [cachedSessions]);
  const labelOf = (sessionId: string) => {
    const entry = nameOf(sessionId);
    if (entry.known) return sessionLabelOf(sessionId, entry, t);
    const cached = cachedTitleById.get(sessionId);
    if (cached !== undefined) {
      return sessionLabelOf(sessionId, { title: sanitizeDisplayTitle(cached), known: true }, t);
    }
    return sessionLabelOf(sessionId, entry, t);
  };

  const projection = useMemo(
    () => projectLiveRuntime({
      requestSnapshot,
      agentSnapshot,
      rules,
      executionStates,
      inboxNeedsYou: inbox.needsYou,
      models: catalogModels,
      locale,
      unknownModelLabel: locale === 'zh' ? '模型未提供' : 'Model unavailable',
      queuedLabel: t('usage.governance.queued'),
      pausedLabel: t('usage.execution.phase.paused'),
      pausingLabel: t('usage.execution.phase.pausing'),
      failedLabel: t('usage.execution.phase.failed'),
      roleRootLabel: t('usage.governance.roleRoot'),
      roleSubagentLabel: t('usage.governance.roleSubagent'),
      executorKikiLabel: t('usage.governance.executorKiki'),
      unknownExecutorLabel: t('usage.governance.unknownExecutor'),
      resolveSessionLabel: labelOf,
      untitledLabel: t('sidebar.untitled'),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requestSnapshot, agentSnapshot, rules, executionStates, inbox.needsYou, catalogModels, locale, nameOf, t],
  );

  const anyStale = (requestSnapshot !== undefined && requestStale) || (agentSnapshot !== undefined && liveAgent.stale);
  const latestAsOf = requestSnapshot?.asOf ?? agentSnapshot?.asOf;
  const frozenAtMs = latestAsOf !== undefined ? Date.parse(latestAsOf) : undefined;
  const hasTimedRows = projection.sessionRows.some((row) => row.startedAtMs !== undefined);
  const nowMs = useSharedClockMs(hasTimedRows && !anyStale, Number.isFinite(frozenAtMs) ? frozenAtMs : undefined);

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['request-governance'] });
    void liveAgent.refetch?.();
    if (executionReadError !== undefined) refetchExecutions();
    else if (pausedDiscovery.error !== undefined) void pausedDiscovery.refresh();
  };

  const openRulesEditor = (ruleId?: string) => {
    if (ruleId !== undefined) {
      setFocusRuleRequest((prev) => ({ id: ruleId, seq: (prev?.seq ?? 0) + 1 }));
    }
    setRulesOpen(true);
    requestAnimationFrame(() => {
      limitsRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      limitsRef.current?.focus({ preventScroll: true });
    });
  };

  const toggleRulesEditor = () => {
    setRulesOpen((open) => {
      const next = !open;
      if (!next) {
        setFocusRuleRequest(null);
        requestAnimationFrame(() => { manageBtnRef.current?.focus(); });
      }
      return next;
    });
  };

  const bothMissing = requestSnapshot === undefined && agentSnapshot === undefined && projection.pendingRows.length === 0 && projection.sessionRows.length === 0;
  if (bothMissing) {
    const stillLoading = requestLoading || liveAgent.loading;
    return (
      <p role="status" className="py-12 text-center text-[13px] leading-5 text-ink-faint">
        {t(stillLoading ? 'usage.governance.loading' : 'usage.governance.unavailable')}
        {stillLoading ? null : (
          <button
            type="button"
            data-governance-retry
            onClick={refreshAll}
            className="ml-2 font-normal text-ink underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink"
          >
            {t('usage.execution.retryRefresh')}
          </button>
        )}
      </p>
    );
  }

  const totalActiveAgents = agentSnapshot?.totalActive ?? agentSnapshot?.active;
  const mainAgents = agentSnapshot?.mainActive ?? agentSnapshot?.main ?? 0;
  const subAgents = agentSnapshot?.subActive ?? agentSnapshot?.subagent ?? 0;
  const independentAgents = agentSnapshot?.independentActive ?? agentSnapshot?.independent ?? 0;
  const agentsQueued = agentSnapshot?.queued ?? 0;
  const asOfLabel = latestAsOf !== undefined ? (time.absoluteTime(latestAsOf) ?? latestAsOf) : undefined;
  const executionVisibleError = executionReadError ?? pausedDiscovery.error;
  const needsRefreshHint = anyStale || requestSnapshot === undefined || agentSnapshot === undefined || executionVisibleError !== undefined;
  const refreshHintTitle = [
    anyStale && asOfLabel ? t('usage.governance.stale', { time: asOfLabel }) : undefined,
    requestSnapshot === undefined ? t('usage.governance.unavailable') : undefined,
    agentSnapshot === undefined ? t('usage.governance.agentsUnavailable') : undefined,
    executionVisibleError !== undefined ? t('usage.execution.staleState') : undefined,
    t('usage.execution.retryRefresh'),
  ].filter(Boolean).join(' · ');

  const isIdle = projection.pendingRows.length === 0
    && projection.sessionRows.length === 0
    && projection.unattributedWaiters.length === 0
    && (requestSnapshot?.active ?? 0) === 0
    && (requestSnapshot?.queued ?? 0) === 0
    && (totalActiveAgents ?? 0) === 0;

  const { availableDimensions, defaultDimension, rowsByDimension, pressuredRules } = projection.concurrency;
  const activeConcurrencyDim: LiveConcurrencyDimension = chosenConcurrencyDim !== null && availableDimensions.includes(chosenConcurrencyDim)
    ? chosenConcurrencyDim
    : defaultDimension;
  const shownConcurrencyRows = rowsByDimension[activeConcurrencyDim];
  const shownInlineRuleIds = new Set(shownConcurrencyRows.map((r) => r.ruleId).filter((id): id is string => id !== undefined));
  const extraPressuredRules = pressuredRules.filter((r) => !shownInlineRuleIds.has(r.ruleId));
  const showConcurrencySection = !isIdle && (shownConcurrencyRows.length > 0 || extraPressuredRules.length > 0);
  const showSessionsColumn = projection.sessionRows.length > 0 || projection.unattributedWaiters.length > 0;
  const splitLiveColumns = showConcurrencySection && showSessionsColumn;
  const concurrencyGridCols = 'grid-cols-[minmax(0,1fr)_2.75rem_2.75rem_4.75rem] sm:grid-cols-[minmax(0,1fr)_3.25rem_3.25rem_5.25rem]';

  const manageRulesLabel = enabledRules > 0
    ? (locale === 'zh' ? `管理并发规则（${enabledRules} 条启用）` : `Manage concurrency rules (${enabledRules} active)`)
    : (locale === 'zh' ? '管理并发规则' : 'Manage concurrency rules');

  return (
    <div className="space-y-6" data-request-governance>
      {/* 1. Prominent top concurrency strip (24px/28px tabular figures, zero card boxes) */}
      <div
        data-governance-live
        className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3 border-b border-hairline pb-4"
      >
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3 sm:gap-x-10">
          {/* Stat 1: Concurrent model requests (+ queued inline when > 0) */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[12px] leading-4 text-ink-soft">
              {locale === 'zh' ? '并发请求' : 'Concurrent requests'}
            </span>
            <div className="flex items-baseline gap-2">
              <span data-governance-active className="font-sans text-[24px] leading-7 font-bold text-ink tabular-nums">
                {requestSnapshot === undefined ? '—' : requestSnapshot.active}
              </span>
              {requestSnapshot !== undefined && requestSnapshot.queued > 0 ? (
                <span className="inline-flex items-baseline gap-0.5 text-[13px] leading-5 text-amber-ink tabular-nums">
                  <span aria-hidden>+</span>
                  <span data-governance-queued>{requestSnapshot.queued}</span>
                  <span>{locale === 'zh' ? ' 排队' : ' queued'}</span>
                </span>
              ) : (
                <span data-governance-queued className="sr-only">
                  {requestSnapshot === undefined ? '—' : 0}
                </span>
              )}
            </div>
          </div>

          {/* Stat 2: Active agents (with main / sub split when nonzero) */}
          <div className="flex flex-col gap-0.5" data-governance-live-agents>
            <span className="text-[12px] leading-4 text-ink-soft">
              {locale === 'zh' ? '运行中智能体' : 'Active agents'}
            </span>
            {agentSnapshot !== undefined ? (
              <div className="flex items-baseline gap-2">
                <span
                  data-governance-total-agents
                  title={`${t('usage.governance.mainAgents')} ${mainAgents} · ${t('usage.governance.subagents')} ${subAgents}${independentAgents > 0 ? ` · ${t('usage.governance.independentAgents')} ${independentAgents}` : ''}`}
                  className="font-sans text-[24px] leading-7 font-bold text-ink tabular-nums"
                >
                  {totalActiveAgents}
                </span>
                {(totalActiveAgents ?? 0) > 0 ? (
                  <span className="inline-flex items-baseline gap-1 text-[12px] leading-4 text-ink-faint tabular-nums">
                    <span>
                      {locale === 'zh' ? '主 ' : 'main '}
                      <span data-governance-main-agents>{mainAgents}</span>
                    </span>
                    <span aria-hidden>·</span>
                    <span>
                      {locale === 'zh' ? '子 ' : 'sub '}
                      <span data-governance-sub-agents>{subAgents}</span>
                    </span>
                    {independentAgents > 0 ? (
                      <>
                        <span aria-hidden>·</span>
                        <span>
                          {locale === 'zh' ? '独 ' : 'ind '}
                          <span data-governance-independent-agents>{independentAgents}</span>
                        </span>
                      </>
                    ) : (
                      <span className="sr-only" data-governance-independent-agents>{independentAgents}</span>
                    )}
                  </span>
                ) : (
                  <>
                    <span className="sr-only" data-governance-main-agents>{mainAgents}</span>
                    <span className="sr-only" data-governance-sub-agents>{subAgents}</span>
                    <span className="sr-only" data-governance-independent-agents>{independentAgents}</span>
                  </>
                )}
                {agentsQueued > 0 ? (
                  <span className="inline-flex items-baseline gap-0.5 text-[12px] leading-4 text-amber-ink tabular-nums">
                    <span aria-hidden>+</span>
                    <span data-governance-agents-queued>{agentsQueued}</span>
                    <span>{locale === 'zh' ? ' 排队' : ' queued'}</span>
                  </span>
                ) : (
                  <span className="sr-only" data-governance-agents-queued>{agentsQueued}</span>
                )}
              </div>
            ) : (
              <span className="inline-flex min-h-7 items-center gap-1 text-[12px] leading-4 text-ink-faint" data-governance-agents-status>
                <span>{t(liveAgent.loading ? 'usage.governance.agentsLoading' : 'usage.governance.agentsUnavailable')}</span>
                {liveAgent.loading ? null : (
                  <button
                    type="button"
                    data-governance-agents-retry
                    aria-label={t('usage.execution.retryRefresh')}
                    title={t('usage.execution.retryRefresh')}
                    onClick={() => { void liveAgent.refetch(); }}
                    className="inline-flex h-6 w-6 items-center justify-center rounded text-amber-ink transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
                  >
                    <Icon name="refresh" size={12} />
                  </button>
                )}
              </span>
            )}
          </div>

          {/* Stat 3: Active sessions */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[12px] leading-4 text-ink-soft">
              {locale === 'zh' ? '活跃会话' : 'Active sessions'}
            </span>
            <div className="flex items-baseline gap-2">
              <span data-governance-active-sessions className="font-sans text-[24px] leading-7 font-bold text-ink tabular-nums">
                {projection.sessionRows.length}
              </span>
              {projection.pendingRows.length > 0 ? (
                <span className="text-[12px] leading-4 text-accent-ink tabular-nums">
                  {locale === 'zh' ? `+${projection.pendingRows.length} 待处理` : `+${projection.pendingRows.length} needs you`}
                </span>
              ) : null}
            </div>
          </div>
        </div>

        {/* Right cluster: freshness + refresh icon + PauseAllExecutions */}
        <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2 self-center">
          {asOfLabel !== undefined ? (
            <span
              data-governance-stale-time={anyStale ? '' : undefined}
              className="text-[12px] leading-4 text-ink-faint tabular-nums"
            >
              {locale === 'zh' ? `更新于 ${asOfLabel}` : `Updated ${asOfLabel}`}
            </span>
          ) : null}
          {needsRefreshHint ? (
            <span data-execution-stale={executionVisibleError !== undefined ? '' : undefined}>
              <button
                type="button"
                data-governance-stale={requestStale || undefined}
                data-governance-agents-stale={liveAgent.stale && agentSnapshot !== undefined ? '' : undefined}
                data-governance-agents-retry={liveAgent.stale && agentSnapshot !== undefined ? '' : undefined}
                data-execution-stale-retry={executionVisibleError !== undefined ? '' : undefined}
                aria-label={refreshHintTitle}
                title={refreshHintTitle}
                onClick={refreshAll}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-amber-ink transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11"
              >
                <Icon name="refresh" size={12} />
              </button>
            </span>
          ) : (
            <button
              type="button"
              aria-label={t('usage.execution.retryRefresh')}
              title={t('usage.execution.retryRefresh')}
              onClick={refreshAll}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11"
            >
              <Icon name="refresh" size={12} />
            </button>
          )}
          {agentSnapshot !== undefined ? (
            <PauseAllExecutions snapshot={agentSnapshot} states={executionStates} labelOf={labelOf} />
          ) : null}
        </div>
      </div>

      {/* 2. Needs you (only when real pending approvals/questions/budget pauses exist) */}
      {projection.pendingRows.length > 0 ? (
        <section data-governance-needs-you aria-labelledby="live-needs-you-heading" className="space-y-2">
          <div className="flex items-baseline gap-2">
            <h2 id="live-needs-you-heading" className="font-sans text-[16px] leading-6 font-bold text-ink">
              {locale === 'zh' ? '需要处理' : 'Needs you'}
            </h2>
            <span className="text-[13px] leading-5 text-ink-faint tabular-nums">
              {projection.pendingRows.length}
            </span>
          </div>
          <ul className="divide-y divide-hairline border-t border-hairline">
            {projection.pendingRows.map((row) => (
              <PendingRuntimeRow key={row.key} row={row} onRetryRead={refreshAll} />
            ))}
          </ul>
        </section>
      ) : null}

      {/* 3 & 4. Live Concurrency + Current Sessions (2-column split on desktop when both are present) */}
      {(showConcurrencySection || showSessionsColumn) ? (
        <div
          className={splitLiveColumns
            ? 'grid gap-x-8 gap-y-6 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.28fr)] lg:items-start'
            : 'space-y-6'}
        >
          {showConcurrencySection ? (
            <section
              data-governance-concurrency
              aria-labelledby="live-concurrency-heading"
              className={splitLiveColumns ? 'min-w-0 space-y-2' : 'max-w-[560px] space-y-2'}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="live-concurrency-heading" className="font-sans text-[16px] leading-6 font-bold text-ink">
                  {locale === 'zh' ? '实时并发' : 'Live concurrency'}
                </h2>
                {availableDimensions.length > 1 ? (
                  <div
                    role="group"
                    aria-label={t('usage.governance.byDimension')}
                    data-axis="governance-dimension"
                    className="flex flex-wrap items-center gap-0.5 rounded-md bg-ink/[0.04] p-0.5"
                  >
                    {availableDimensions.map((dim) => {
                      const selected = dim === activeConcurrencyDim;
                      const label = dim === 'executor'
                        ? t('usage.governance.executor')
                        : t(`usage.governance.${dim}` as I18nKey);
                      return (
                        <button
                          key={dim}
                          type="button"
                          data-axis-value={dim}
                          aria-pressed={selected}
                          onClick={() => { setChosenConcurrencyDim(dim); }}
                          className={`h-7 rounded-[5px] px-2.5 text-[12px] leading-4 font-normal transition-colors focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11 ${
                            selected
                              ? 'bg-paper text-ink'
                              : 'text-ink-soft hover:text-ink'
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>

              <div
                aria-hidden
                className={`grid ${concurrencyGridCols} items-baseline gap-x-2 pt-0.5 pb-1 text-[11px] leading-4 text-ink-faint select-none`}
              >
                <span>{locale === 'zh' ? '目标' : 'Target'}</span>
                <span className="text-right">{locale === 'zh' ? '运行中' : 'Active'}</span>
                <span className="text-right">{locale === 'zh' ? '排队' : 'Queued'}</span>
                <span className="text-right">{locale === 'zh' ? '上限' : 'Cap'}</span>
              </div>

              {shownConcurrencyRows.length > 0 ? (
                <div data-governance-dimensions data-governance-dimension={activeConcurrencyDim}>
                  <ol className="divide-y divide-hairline border-t border-hairline">
                    {shownConcurrencyRows.map((row) => (
                      <LiveConcurrencyRow
                        key={row.key}
                        row={row}
                        locale={locale}
                        gridCols={concurrencyGridCols}
                        onJumpToRule={openRulesEditor}
                      />
                    ))}
                  </ol>
                </div>
              ) : null}

              {extraPressuredRules.length > 0 ? (
                <div data-governance-cap-pressure className={shownConcurrencyRows.length > 0 ? 'pt-1' : undefined}>
                  <ol className="divide-y divide-hairline border-t border-hairline">
                    {extraPressuredRules.map((rule) => (
                      <PressuredRuleRow
                        key={rule.ruleId}
                        rule={rule}
                        gridCols={concurrencyGridCols}
                        onJumpToRule={openRulesEditor}
                      />
                    ))}
                  </ol>
                </div>
              ) : null}
            </section>
          ) : null}

          {showSessionsColumn ? (
            <div className={splitLiveColumns ? 'min-w-0 space-y-6 lg:border-l lg:border-hairline lg:pl-8' : 'space-y-6'}>
              {projection.sessionRows.length > 0 ? (
                <section
                  data-governance-sessions
                  data-execution-sessions
                  aria-labelledby="live-sessions-heading"
                  className="space-y-2"
                >
                  <div className="flex items-baseline gap-2">
                    <h2 id="live-sessions-heading" className="font-sans text-[16px] leading-6 font-bold text-ink">
                      {locale === 'zh' ? '当前会话' : 'Current sessions'}
                    </h2>
                    <span data-governance-sessions-count className="text-[13px] leading-5 text-ink-faint tabular-nums">
                      {projection.sessionRows.length}
                    </span>
                  </div>
                  <ul className="divide-y divide-hairline border-t border-hairline">
                    {projection.sessionRows.map((row) => (
                      <ActiveRuntimeSessionRow
                        key={row.sessionId}
                        row={row}
                        nowMs={nowMs}
                        onRetryRead={refetchExecutions}
                        onJumpToRule={openRulesEditor}
                      />
                    ))}
                  </ul>
                  {requestSnapshot !== undefined && requestSnapshot.queued > requestSnapshot.waiting.length ? (
                    <p data-governance-waiting-showing className="text-[12px] leading-4 text-ink-faint tabular-nums">
                      {t('usage.governance.waitingShowing', { shown: requestSnapshot.waiting.length, total: requestSnapshot.queued })}
                    </p>
                  ) : null}
                </section>
              ) : null}

              {projection.unattributedWaiters.length > 0 ? (
                <section data-governance-unattributed-waiters className="space-y-2">
                  <h2 className="font-sans text-[16px] leading-6 font-bold text-ink">
                    {locale === 'zh' ? '未关联会话的请求' : 'Unattributed queued requests'}
                  </h2>
                  <ul className="divide-y divide-hairline border-t border-hairline">
                    {projection.unattributedWaiters.map((waiter) => {
                      const model = formatRuntimeModelLabel(waiter.modelId, catalogModels, locale === 'zh' ? '模型未提供' : 'Model unavailable');
                      return (
                        <li
                          key={waiter.attemptId}
                          data-governance-waiter={waiter.attemptId}
                          className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[13px] leading-5"
                        >
                          <span className="text-ink">{locale === 'zh' ? '未关联会话的请求' : 'Unattributed request'}</span>
                          <span className="text-ink-soft" title={model.technical}>{model.display}</span>
                          {waiter.blockingRules.length > 0 ? (
                            <button
                              type="button"
                              onClick={() => { openRulesEditor(waiter.blockingRules[0]); }}
                              className="text-[12px] leading-4 text-ink-faint underline-offset-2 hover:text-ink hover:underline"
                            >
                              {t('usage.governance.blockedBy', { rules: waiter.blockingRules.join(', ') })}
                            </button>
                          ) : null}
                          <span className="ml-auto text-[12px] leading-4 text-ink-faint tabular-nums">
                            {time.formatDuration(waiter.waitedMs)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {isIdle ? (
        <p data-governance-idle className="py-8 text-[13px] leading-5 text-ink-faint">
          {t('usage.governance.idleNow')}
        </p>
      ) : null}

      {/* 5. Footer disclosures: Agent dimension details + Manage concurrency rules (closed by default) */}
      <div className="space-y-4 border-t border-hairline pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {agentSnapshot !== undefined ? (
            <button
              type="button"
              data-governance-breakdown-toggle
              aria-expanded={breakdownOpen}
              aria-controls="usage-live-breakdown"
              onClick={() => { setBreakdownOpen((open) => !open); }}
              className="inline-flex min-h-8 items-center gap-1 rounded-md px-1 text-[13px] leading-5 font-normal text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
            >
              <span>{locale === 'zh' ? '智能体维度明细' : 'Agent breakdown'}</span>
              <DisclosureChevron open={breakdownOpen} size={12} className="text-ink-faint" />
            </button>
          ) : (
            <span />
          )}

          <span data-governance-rules-summary>
            <button
              ref={manageBtnRef}
              type="button"
              data-governance-manage
              aria-expanded={rulesOpen}
              aria-controls="usage-limits-editor"
              onClick={toggleRulesEditor}
              className="inline-flex min-h-8 items-center gap-1 rounded-md px-1 text-[13px] leading-5 font-normal text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
            >
              <span>{manageRulesLabel}</span>
              <DisclosureChevron open={rulesOpen} size={12} className="text-ink-faint" />
            </button>
          </span>
        </div>

        {breakdownOpen && agentSnapshot !== undefined ? (
          <div id="usage-live-breakdown" data-governance-breakdown className="border-t border-hairline pt-4">
            <AgentDimensionBreakdown
              agentSnapshot={agentSnapshot}
              models={catalogModels}
              labelOf={labelOf}
            />
          </div>
        ) : null}

        <div
          ref={limitsRef}
          id="usage-limits"
          role="region"
          aria-label={t('usage.governance.limitsTitle')}
          tabIndex={-1}
          className="scroll-mt-4 outline-none"
        >
          {rulesOpen ? (
            <div id="usage-limits-editor" className="border-t border-hairline pt-4">
              <ConcurrencyRulesEditor rules={rules} focusRuleRequest={focusRuleRequest} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function LiveConcurrencyRow({
  row,
  locale,
  gridCols,
  onJumpToRule,
}: {
  readonly row: LiveConcurrencyBucketRow;
  readonly locale: 'zh' | 'en';
  readonly gridCols: string;
  readonly onJumpToRule: (ruleId: string) => void;
}) {
  const isAtOrOverCap = row.limit !== undefined && (row.queued > 0 || row.active >= row.limit);
  const ratioPct = row.limit !== undefined && row.limit > 0
    ? Math.min(100, Math.round((row.active / row.limit) * 100))
    : 0;
  const rowTooltip = [
    row.technical ?? row.display,
    row.activeAgents !== undefined
      ? (locale === 'zh' ? `${row.activeAgents} 个智能体运行中` : `${row.activeAgents} active agents`)
      : undefined,
  ].filter(Boolean).join(' · ');

  return (
    <li
      data-governance-row={row.id}
      data-governance-concurrency-row={row.id}
      className={`grid min-h-10 ${gridCols} items-center gap-x-2 py-2 tabular-nums`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-[13px] leading-5 text-ink" title={rowTooltip}>
          {row.display}
        </span>
        {row.subDetail !== undefined ? (
          <span className="hidden shrink-0 text-[12px] leading-4 text-ink-faint min-[440px]:inline">
            {row.subDetail}
          </span>
        ) : null}
        {row.ruleId !== undefined ? (
          <button
            type="button"
            data-governance-row-rule={row.ruleId}
            onClick={() => { onJumpToRule(row.ruleId!); }}
            className="hidden shrink-0 rounded font-mono text-[12px] leading-4 text-ink-faint underline-offset-2 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink min-[440px]:inline"
          >
            {row.ruleId}
          </button>
        ) : null}
      </div>

      <span data-governance-row-active className="text-right text-[13px] leading-5 font-bold text-ink">
        {row.active}
      </span>

      {row.queued > 0 ? (
        <span data-governance-row-queued className="text-right text-[12px] leading-4 text-amber-ink">
          +{row.queued}
        </span>
      ) : (
        <span className="text-right text-[12px] leading-4 text-ink-faint">—</span>
      )}

      {row.limit !== undefined ? (
        <span className="flex items-center justify-end gap-1.5">
          <span
            aria-hidden
            data-governance-meter
            className="inline-flex h-1.5 w-7 shrink-0 overflow-hidden rounded-full bg-ink/[0.08]"
          >
            <span
              className={`h-full rounded-full transition-[width] duration-200 ${isAtOrOverCap ? 'bg-attention' : 'bg-ink/70'}`}
              style={{ width: `${ratioPct}%` }}
            />
          </span>
          <span data-governance-row-cap className="text-right text-[13px] leading-5 text-ink">
            <span className="font-bold">{row.active}</span>
            <span className="text-ink-faint"> / {row.limit}</span>
          </span>
        </span>
      ) : (
        <span data-governance-row-uncapped className="text-right text-[13px] leading-5 text-ink-faint">
          —
        </span>
      )}
    </li>
  );
}

function PressuredRuleRow({
  rule,
  gridCols,
  onJumpToRule,
}: {
  readonly rule: LivePressuredRuleRow;
  readonly gridCols: string;
  readonly onJumpToRule: (ruleId: string) => void;
}) {
  const isAtOrOverCap = rule.queued > 0 || rule.active >= rule.limit;
  const ratioPct = rule.limit > 0 ? Math.min(100, Math.round((rule.active / rule.limit) * 100)) : 0;

  return (
    <li
      data-governance-pressure-rule={rule.ruleId}
      className={`grid min-h-10 ${gridCols} items-center gap-x-2 py-2 tabular-nums`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={() => { onJumpToRule(rule.ruleId); }}
          className="shrink-0 rounded font-mono text-[13px] leading-5 text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink"
        >
          {rule.ruleId}
        </button>
        <span className="min-w-0 truncate text-[12px] leading-4 text-ink-faint" title={rule.targetSummary}>
          {rule.targetSummary}
        </span>
      </div>

      <span className="text-right text-[13px] leading-5 font-bold text-ink">
        {rule.active}
      </span>

      {rule.queued > 0 ? (
        <span className="text-right text-[12px] leading-4 text-amber-ink">
          +{rule.queued}
        </span>
      ) : (
        <span className="text-right text-[12px] leading-4 text-ink-faint">—</span>
      )}

      <span className="flex items-center justify-end gap-1.5">
        <span
          aria-hidden
          data-governance-meter
          className="inline-flex h-1.5 w-7 shrink-0 overflow-hidden rounded-full bg-ink/[0.08]"
        >
          <span
            className={`h-full rounded-full transition-[width] duration-200 ${isAtOrOverCap ? 'bg-attention' : 'bg-ink/70'}`}
            style={{ width: `${ratioPct}%` }}
          />
        </span>
        <span className="text-right text-[13px] leading-5 text-ink">
          <span className="font-bold">{rule.active}</span>
          <span className="text-ink-faint"> / {rule.limit}</span>
        </span>
      </span>
    </li>
  );
}

function PendingRuntimeRow({
  row,
  onRetryRead,
}: {
  readonly row: LivePendingRow;
  readonly onRetryRead: () => void;
}) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const reasonText = t(REASON_LABEL_KEY[row.reason]);
  return (
    <li
      data-governance-pending-row={row.sessionId}
      className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 py-2.5 min-[720px]:grid min-[720px]:grid-cols-[minmax(12rem,1.15fr)_minmax(10rem,1fr)_auto] min-[720px]:items-center"
    >
      <button
        type="button"
        onClick={() => { void navigate(row.href); }}
        title={row.title}
        className="min-w-0 truncate text-left text-[13px] leading-5 font-normal text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
      >
        {row.title}
      </button>
      <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-5 text-ink-soft">
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-attention" />
        <span className="truncate">{reasonText}</span>
        {row.activeRequests > 0 ? (
          <span className="shrink-0 text-[12px] leading-4 text-ink tabular-nums">
            · {locale === 'zh' ? `${row.activeRequests} 并发` : `${row.activeRequests} concurrent`}
          </span>
        ) : row.runningAgentCount > 0 ? (
          <span className="shrink-0 text-[12px] leading-4 text-ink-faint tabular-nums">
            · {locale === 'zh' ? `${row.runningAgentCount} 个智能体` : `${row.runningAgentCount} agents`}
          </span>
        ) : null}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {row.roomId === undefined && row.executionState !== undefined ? (
          <SessionExecutionActions
            sessionId={row.sessionId}
            state={row.executionState}
            onRetryRead={onRetryRead}
          />
        ) : null}
        <button
          type="button"
          data-governance-pending-action={row.sessionId}
          onClick={() => { void navigate(row.href); }}
          className="inline-flex min-h-8 shrink-0 items-center gap-0.5 rounded-md px-2 text-[13px] leading-5 font-normal text-accent-ink transition-colors hover:bg-attention-soft/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
        >
          <span>{locale === 'zh' ? '处理' : 'Handle'}</span>
          <span aria-hidden>›</span>
        </button>
      </div>
    </li>
  );
}

function ActiveRuntimeSessionRow({
  row,
  nowMs,
  onRetryRead,
  onJumpToRule,
}: {
  readonly row: LiveSessionRow;
  readonly nowMs: number;
  readonly onRetryRead: () => void;
  readonly onJumpToRule: (ruleId: string) => void;
}) {
  const { t, locale, time } = useI18n();
  const navigate = useNavigate();
  const [agentsExpanded, setAgentsExpanded] = useState(false);

  const elapsed = formatLiveElapsed(row.startedAtMs, row.waitedMs, nowMs, t);
  const name = sessionLabelText(row.label);
  const phaseTone = row.phaseKind === 'failed'
    ? 'text-danger'
    : row.phaseKind === 'paused'
      ? 'text-selected-ink'
      : row.phaseKind === 'queued' || row.phaseKind === 'pausing'
        ? 'text-amber-ink'
        : 'text-ink-soft';
  const showConcurrencyLead = row.activeRequests > 0 && row.phaseKind === 'running';

  return (
    <li
      data-execution-session={row.sessionId}
      data-execution-paused={row.phaseKind === 'paused' || row.phaseKind === 'failed' ? row.sessionId : undefined}
      data-governance-waiter={row.waiterAttemptIds[0]}
      className="py-2"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5">
        <div className="min-w-0">
          <button
            type="button"
            data-execution-session-open
            title={`${name}\n${row.sessionId}`}
            onClick={() => { void navigate(row.href); }}
            className="group flex min-h-7 w-full min-w-0 items-center gap-2 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
          >
            <span className={`min-w-0 truncate text-[13px] leading-5 font-normal underline-offset-2 group-hover:underline ${row.label.titled ? 'text-ink' : 'text-ink-soft'}`}>
              {row.label.text}
            </span>
            {row.label.titled ? null : (
              <span className="shrink-0 font-mono text-[12px] leading-4 text-ink-faint tabular-nums">
                {row.label.shortId}
              </span>
            )}
          </button>

          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] leading-4">
            {showConcurrencyLead ? (
              <span
                data-governance-session-concurrency={row.activeRequests}
                data-execution-phase={row.executionState?.phase ?? row.phaseKind}
                className="shrink-0 text-ink tabular-nums"
              >
                {locale === 'zh' ? `${row.activeRequests} 并发` : `${row.activeRequests} concurrent`}
              </span>
            ) : (
              <>
                <span data-execution-phase={row.executionState?.phase ?? row.phaseKind} className={`shrink-0 ${phaseTone}`}>
                  {row.phaseKind === 'paused' ? t('usage.execution.pausedHint') : row.phaseLabel}
                </span>
                {row.activeRequests > 0 ? (
                  <>
                    <span aria-hidden className="text-ink-faint">·</span>
                    <span data-governance-session-concurrency={row.activeRequests} className="shrink-0 text-ink tabular-nums">
                      {locale === 'zh' ? `${row.activeRequests} 并发` : `${row.activeRequests} concurrent`}
                    </span>
                  </>
                ) : null}
              </>
            )}
            {showConcurrencyLead && row.queuedRequests > 0 ? (
              <>
                <span aria-hidden className="text-ink-faint">·</span>
                <span className="shrink-0 text-amber-ink tabular-nums">
                  +{row.queuedRequests}{locale === 'zh' ? ' 排队' : ' queued'}
                </span>
              </>
            ) : null}
            {row.modelDisplay !== undefined ? (
              <>
                <span aria-hidden className="text-ink-faint">·</span>
                <span className="min-w-0 truncate text-ink-soft" title={row.modelTechnical ?? row.modelDisplay}>
                  {row.modelDisplay}
                </span>
              </>
            ) : null}
            {row.agents.length > 1 ? (
              <>
                <span aria-hidden className="text-ink-faint">·</span>
                <button
                  type="button"
                  data-governance-extra-agents={row.sessionId}
                  aria-expanded={agentsExpanded}
                  onClick={() => { setAgentsExpanded((open) => !open); }}
                  className="shrink-0 rounded text-ink-faint tabular-nums underline-offset-2 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink"
                >
                  {locale === 'zh' ? `${row.agents.length} 个智能体` : `${row.agents.length} agents`}
                </button>
              </>
            ) : row.agents.length === 1 && row.activeRequests > 0 ? (
              <>
                <span aria-hidden className="text-ink-faint">·</span>
                <span className="shrink-0 text-ink-faint tabular-nums">
                  {locale === 'zh' ? '1 个智能体' : '1 agent'}
                </span>
              </>
            ) : null}
            {row.blockingRules.length > 0 ? (
              <>
                <span aria-hidden className="text-ink-faint">·</span>
                <button
                  type="button"
                  onClick={() => { onJumpToRule(row.blockingRules[0]!); }}
                  className="min-w-0 truncate rounded font-mono text-ink-faint underline-offset-2 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink"
                >
                  {t('usage.governance.blockedBy', { rules: row.blockingRules.join(', ') })}
                </button>
              </>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2">
          <span
            aria-label={elapsed === undefined ? (locale === 'zh' ? '时长未知' : 'Duration unknown') : undefined}
            className="shrink-0 text-right text-[12px] leading-4 text-ink-faint tabular-nums"
          >
            {elapsed ?? '—'}
          </span>
          {row.executionState !== undefined ? (
            <SessionExecutionActions
              sessionId={row.sessionId}
              state={row.executionState}
              onRetryRead={onRetryRead}
            />
          ) : null}
          <button
            type="button"
            aria-label={locale === 'zh' ? `打开 ${name}` : `Open ${name}`}
            onClick={() => { void navigate(row.href); }}
            className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink min-[720px]:inline-flex pointer-coarse:h-11 pointer-coarse:w-11"
          >
            <span aria-hidden>›</span>
          </button>
        </div>
      </div>

      {agentsExpanded && row.agents.length > 1 ? (
        <ul
          data-governance-session-agents={row.sessionId}
          className="mt-2 ml-3 space-y-1 border-l border-hairline pl-3"
        >
          {row.agents.map((agent) => (
            <li key={agent.agentId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-0.5 text-[12px] leading-4">
              <button
                type="button"
                onClick={() => { void navigate(agent.href); }}
                className="font-mono text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink"
              >
                {agent.profileId ?? agent.agentId}
              </button>
              <span className="text-ink-faint">
                {agent.role === 'main'
                  ? t('usage.governance.mainAgents')
                  : agent.role === 'subagent'
                    ? t('usage.governance.subagents')
                    : t('usage.governance.independentAgents')}
              </span>
              {agent.modelDisplay !== undefined ? (
                <span className="text-ink-soft" title={agent.modelTechnical}>{agent.modelDisplay}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Secondary multi-column agent breakdown (`executor / profile / model / role / session`)
 * under the optional footer disclosure — single dimension at a time, zero bars.
 */
function AgentDimensionBreakdown({
  agentSnapshot,
  models,
  labelOf,
}: {
  readonly agentSnapshot: LiveAgentSnapshot;
  readonly models: readonly ModelCatalogItem[];
  readonly labelOf: (sessionId: string) => SessionLabel;
}) {
  const { t, locale } = useI18n();
  const unknownModel = locale === 'zh' ? '模型未提供' : 'Model unavailable';

  const AGENT_DIM_KEYS = ['executor', 'profile', 'model', 'role', 'session'] as const;
  const [chosenAgentDim, setChosenAgentDim] = useState<LiveAgentDimensionKind | null>(null);
  const agentDimensions = agentSnapshot.dimensions ?? [];
  const presentAgentDims = AGENT_DIM_KEYS.filter((opt) =>
    agentDimensions.some((row) => row.dimension === opt));
  const agentDim: LiveAgentDimensionKind = chosenAgentDim !== null && presentAgentDims.includes(chosenAgentDim)
    ? chosenAgentDim
    : (presentAgentDims[0] ?? 'executor');
  const shownAgentRows = agentDimensions.filter((row) => row.dimension === agentDim);

  const agentRowLabel = (id: string | null): { display: string; title: string } => {
    if (agentDim === 'executor') {
      if (id === null || id === '') return { display: t('usage.governance.unknownExecutor'), title: '' };
      const lower = id.toLowerCase();
      if (lower === 'kiki' || lower === 'builtin' || lower === 'native' || lower === 'local') {
        const text = t('usage.governance.executorKiki');
        return { display: text, title: id };
      }
      return { display: id, title: id };
    }
    if (id === null || id === '' || id === 'unknown') {
      const text = agentDim === 'model'
        ? t('usage.governance.unknownModelByExecutor')
        : agentDim === 'session'
          ? t('usage.governance.session')
          : t('usage.governance.unknownExecutor');
      return { display: text, title: text };
    }
    if (agentDim === 'session') {
      const text = sessionLabelText(labelOf(id));
      return { display: text, title: `${text}\n${id}` };
    }
    if (agentDim === 'model') {
      const m = formatRuntimeModelLabel(id, models, unknownModel);
      return { display: m.display, title: m.technical ?? m.display };
    }
    return { display: id, title: id };
  };

  return (
    <section className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-sans text-[14px] leading-5 font-bold text-ink">{t('usage.governance.viewAgents')}</h3>
        <AxisGroup
          label={t('usage.governance.byDimension')}
          dataAxis="governance-agent-dimension"
          options={presentAgentDims.length > 0 ? presentAgentDims : AGENT_DIM_KEYS}
          value={agentDim}
          onChange={(next) => { setChosenAgentDim(next); }}
          labelFor={(option) => {
            if (option === 'executor') return t('usage.governance.executor');
            if (option === 'profile') return t('usage.governance.profile');
            if (option === 'model') return t('usage.governance.model');
            return t(`usage.governance.${option}` as I18nKey);
          }}
        />
      </div>
      {shownAgentRows.length === 0 ? (
        <p data-governance-agents-empty className="text-[13px] leading-5 text-ink-faint">{t('usage.governance.idleAgents')}</p>
      ) : (
        <div data-governance-agent-dimensions data-governance-agent-dimension={agentDim}>
          <div aria-hidden className="hidden grid-cols-[minmax(0,1fr)_3.75rem_3.75rem_3.75rem] gap-x-2 pb-1.5 text-[12px] leading-4 text-ink-faint sm:grid">
            <span>{t('usage.governance.target')}</span>
            <span className="text-right">{t('usage.governance.mainAgents')}</span>
            <span className="text-right">{t('usage.governance.subagents')}</span>
            <span className="text-right">{t('usage.governance.totalAgents')}</span>
          </div>
          <ol className="divide-y divide-hairline border-t border-hairline">
            {shownAgentRows.map((row) => {
              const mainCount = row.mainActive ?? row.main ?? 0;
              const subCount = row.subActive ?? row.subagent ?? 0;
              const totalCount = row.totalActive ?? row.active ?? 0;
              const label = agentRowLabel(row.id);
              return (
                <li key={`${row.dimension}:${row.id ?? 'unknown'}`} data-governance-agent-row={row.id ?? 'unknown'} className="py-2">
                  <div className="flex flex-col gap-0.5 sm:grid sm:grid-cols-[minmax(0,1fr)_3.75rem_3.75rem_3.75rem] sm:items-baseline sm:gap-x-2">
                    <span className="min-w-0 truncate text-[13px] leading-5 text-ink" title={label.title}>{label.display}</span>
                    <span className="text-[12px] leading-4 text-ink-soft tabular-nums sm:hidden">
                      {`${t('usage.governance.mainAgents')} ${mainCount} · ${t('usage.governance.subagents')} ${subCount} · ${t('usage.governance.totalAgents')} ${totalCount}`}
                    </span>
                    <span className="hidden text-right text-[13px] leading-5 text-ink tabular-nums sm:inline">{mainCount}</span>
                    <span className="hidden text-right text-[13px] leading-5 text-ink-soft tabular-nums sm:inline">{subCount}</span>
                    <span className="hidden text-right text-[13px] leading-5 text-ink tabular-nums sm:inline">{totalCount}</span>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </section>
  );
}
