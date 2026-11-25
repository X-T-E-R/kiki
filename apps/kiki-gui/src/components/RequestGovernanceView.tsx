/**
 * The Live tab: what is running and queued right now — model requests one
 * dimension at a time, then the running agents. The concurrency rules that
 * hold the queue are reported in one line ("limited by 2 rules"); the rule
 * editor itself (`usage/ConcurrencyRulesEditor`) opens under it on request,
 * and a legacy `panel=limits` link opens it straight away and focuses it.
 *
 * On a phone the live tables turn into two-line rows (name; the counts as
 * words) instead of a grid whose last columns would be cut off.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type { RequestGovernanceSnapshot } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../i18n';
import {
  liveInventorySessionIds,
  usePausedSessionDiscovery,
  useSessionExecutions,
} from '../lib/executionControls';
import { useLiveAgentGovernance, type LiveAgentDimensionKind } from '../lib/liveAgentGovernance';
import { useRequestGovernance } from '../lib/useRequestGovernance';
import { useSessionNames } from '../lib/threadTitles';
import { DisclosureChevron, Icon } from './icons';
import { ConcurrencyRulesEditor } from './usage/ConcurrencyRulesEditor';
import { ExecutionSessionList, PauseAllExecutions, sessionLabelOf, sessionLabelText } from './usage/ExecutionControls';
import { AxisGroup, UsageSectionHeading } from './usage/usageShared';

export const CONCURRENCY_RULES_SETTINGS_HREF = '/settings/ai?tab=defaults#st-card-concurrency';

/**
 * The sidebar's Activity badge: live active and queued model request counts in
 * quiet tabular figures (`3`, `3 · +1`, `+1` in the expanded sidebar; `3`,
 * `3+1`, `+1` in the collapsed rail) while work is running or waiting, and
 * silent when idle. A stale read keeps the last non-idle counts and exposes a
 * concise refresh hint in its title.
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
        ? 'absolute -right-2 -bottom-1 whitespace-nowrap rounded bg-paper px-0.5 font-mono text-[9px] leading-3 text-[var(--kiki-chart-muted)] tabular-nums'
        : 'ml-auto shrink-0 font-mono text-[11px] text-[var(--kiki-chart-muted)] tabular-nums'}
    >
      {label}
    </span>
  );
}

export function RequestGovernanceView({ view = 'realtime' }: { view?: 'realtime' | 'limits' } = {}) {
  const { snapshot, stale, loading } = useRequestGovernance();
  const { t, tp } = useI18n();
  const queryClient = useQueryClient();
  const limitsRef = useRef<HTMLDivElement>(null);
  const ready = snapshot !== undefined;
  const [userOpen, setUserOpen] = useState<boolean | null>(view === 'limits' ? true : null);
  const rulesOpen = userOpen ?? (view === 'limits' || (snapshot?.rules.length ?? 0) > 0);
  useEffect(() => {
    if (view !== 'limits' || !ready) return;
    setUserOpen(true);
    limitsRef.current?.scrollIntoView?.({ block: 'start' });
    limitsRef.current?.focus({ preventScroll: true });
  }, [view, ready]);
  if (snapshot === undefined) {
    return (
      <p role="status" className="py-12 text-center text-[13px] text-ink-faint">
        {t(loading ? 'usage.governance.loading' : 'usage.governance.unavailable')}
        {loading ? null : (
          <button
            type="button"
            data-governance-retry
            onClick={() => { void queryClient.invalidateQueries({ queryKey: ['request-governance'] }); }}
            className="ml-2 font-medium text-ink underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink"
          >
            {t('usage.execution.retryRefresh')}
          </button>
        )}
      </p>
    );
  }
  const enabledRules = snapshot.rules.filter((rule) => rule.enabled).length;
  return (
    <div className="space-y-6" data-request-governance>
      <RealtimePanel
        snapshot={snapshot}
        stale={stale}
        onRefresh={() => { void queryClient.invalidateQueries({ queryKey: ['request-governance'] }); }}
        onJumpToRule={() => {
          setUserOpen(true);
          requestAnimationFrame(() => {
            limitsRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
          });
        }}
      />
      <div
        ref={limitsRef}
        id="usage-limits"
        role="region"
        aria-label={t('usage.governance.limitsTitle')}
        tabIndex={-1}
        className="scroll-mt-4 outline-none"
      >
        <p data-governance-rules-summary className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-hairline pt-3 text-[12.5px] text-ink-soft">
          <span>{enabledRules > 0 ? tp('usage.live.rules', enabledRules) : t('usage.governance.emptyTitle')}</span>
          <button
            type="button"
            data-governance-manage
            aria-expanded={rulesOpen}
            aria-controls="usage-limits-editor"
            onClick={() => { setUserOpen(!rulesOpen); }}
            className="inline-flex min-h-8 items-center gap-1 rounded-sm font-medium text-ink underline-offset-2 transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
          >
            {t('usage.live.manageRules')}
            <DisclosureChevron open={rulesOpen} className="text-ink-faint" />
          </button>
        </p>
        {rulesOpen ? (
          <div id="usage-limits-editor" className="pt-4">
            <ConcurrencyRulesEditor rules={snapshot.rules} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live — running and queued right now
// ---------------------------------------------------------------------------

function RealtimePanel({ snapshot, stale, onRefresh, onJumpToRule }: {
  readonly snapshot: RequestGovernanceSnapshot;
  readonly stale: boolean;
  readonly onRefresh: () => void;
  readonly onJumpToRule?: (ruleId: string) => void;
}) {
  const { t, time } = useI18n();
  const liveAgent = useLiveAgentGovernance();

  // Request dimensions
  const dimensions = snapshot.dimensions.filter((row) => row.dimension !== 'session');
  const [chosen, setChosen] = useState<'model' | 'provider' | 'role' | null>(null);
  const present = (['model', 'provider', 'role'] as const).filter((option) =>
    dimensions.some((row) => row.dimension === option));
  const dimension = chosen !== null && present.includes(chosen) ? chosen : present[0];
  const options = dimension === undefined ? [] : present;
  const shown = dimension === undefined ? [] : dimensions.filter((row) => row.dimension === dimension);
  const dimensionLabel = (row: (typeof dimensions)[number]): string => {
    if (row.dimension === 'role') {
      return row.id === 'subagent' ? t('usage.governance.roleSubagent') : t('usage.governance.roleRoot');
    }
    return row.id;
  };

  // Live agent dimensions
  const AGENT_DIMENSION_KEYS = ['executor', 'profile', 'model', 'role', 'session'] as const;
  const [chosenAgentDim, setChosenAgentDim] = useState<LiveAgentDimensionKind | null>(null);
  const agentSnapshot = liveAgent.snapshot ?? undefined;
  const agentDimensions = agentSnapshot?.dimensions ?? [];
  const presentAgentDims = AGENT_DIMENSION_KEYS.filter((opt) =>
    agentDimensions.some((row) => row.dimension === opt));
  const agentDimension: LiveAgentDimensionKind = chosenAgentDim !== null && presentAgentDims.includes(chosenAgentDim)
    ? chosenAgentDim
    : (presentAgentDims[0] ?? 'executor');
  const agentOptions = presentAgentDims.length > 0 ? presentAgentDims : AGENT_DIMENSION_KEYS;
  const shownAgentRows = agentDimensions.filter((row) => row.dimension === agentDimension);

  const executorDisplay = (id: string | null): string => {
    if (id === null || id === undefined || id === '') {
      return t('usage.governance.unknownExecutor');
    }
    const lower = id.toLowerCase();
    if (lower === 'kiki' || lower === 'builtin' || lower === 'native' || lower === 'local') {
      return t('usage.governance.executorKiki');
    }
    return id;
  };

  // Execution pause/resume: one state read per session in the live inventory
  // (deduplicated — the full inventory, not the visible page), merged with the
  // cold-summary discovery so a session paused before a restart still reports
  // its real phase even though its agents left the live inventory.
  const liveSessionIds = liveInventorySessionIds(agentSnapshot?.agents);
  const pausedDiscovery = usePausedSessionDiscovery();
  const executionSessionIds = useMemo(
    () => [...new Set([...liveSessionIds, ...pausedDiscovery.sessionIds])],
    [liveSessionIds, pausedDiscovery.sessionIds],
  );
  const { states: executionStates, readError: executionReadError, refetch: refetchExecutions } = useSessionExecutions(executionSessionIds);

  // Sessions read by name wherever this panel shows one — the session list and
  // the session cut of the breakdown — from the cached lists plus one
  // metadata read per unknown id; actions keep the real id.
  const sessionDimensionIds = agentDimensions
    .filter((row) => row.dimension === 'session' && row.id !== null && row.id !== '' && row.id !== 'unknown')
    .map((row) => row.id!);
  const nameOf = useSessionNames([...new Set([...executionSessionIds, ...sessionDimensionIds])]);
  const labelOf = (sessionId: string) => sessionLabelOf(sessionId, nameOf(sessionId), t);

  const agentRowDisplay = (id: string | null): string => {
    if (agentDimension === 'executor') return executorDisplay(id);
    if (id === null || id === undefined || id === '' || id === 'unknown') {
      if (agentDimension === 'model') return t('usage.governance.unknownModelByExecutor');
      if (agentDimension === 'session') return t('usage.governance.session');
      return t('usage.governance.unknownExecutor');
    }
    if (agentDimension === 'session') return sessionLabelText(labelOf(id));
    return id;
  };
  // One visible recovery line for either read path that failed: the per-session
  // execution read, or the cold paused-session discovery. 40401 (an older
  // server) stays silent on both.
  const executionVisibleError = executionReadError ?? pausedDiscovery.error;
  const retryExecutionReads = () => {
    if (executionReadError !== undefined) refetchExecutions();
    else void pausedDiscovery.refresh();
  };

  const requestSummary = [
    `${t('usage.governance.running')} ${snapshot.active}`,
    `${t('usage.governance.queued')} ${snapshot.queued}`,
  ].join(' · ');
  const agentSummary = agentSnapshot === undefined ? undefined : [
    `${t('usage.governance.mainAgents')} ${agentSnapshot?.mainActive ?? agentSnapshot?.main ?? 0}`,
    `${t('usage.governance.subagents')} ${agentSnapshot?.subActive ?? agentSnapshot?.subagent ?? 0}`,
    ...(agentSnapshot !== null && agentSnapshot !== undefined && (agentSnapshot.independentActive ?? agentSnapshot.independent ?? 0) > 0
      ? [`${t('usage.governance.independentAgents')} ${agentSnapshot.independentActive ?? agentSnapshot.independent ?? 0}`]
      : []),
    ...(agentSnapshot !== null && agentSnapshot !== undefined && agentSnapshot.queued > 0 ? [`${t('usage.governance.queued')} ${agentSnapshot.queued}`] : []),
  ].join(' · ');

  const requestMaxCount = useMemo(
    () => Math.max(1, ...shown.map((row) => row.active + row.queued)),
    [shown],
  );
  const waitingMaxMs = useMemo(
    () => Math.max(1, ...snapshot.waiting.map((row) => row.waitedMs)),
    [snapshot.waiting],
  );
  const agentMaxCount = useMemo(
    () => Math.max(1, ...shownAgentRows.map((row) => row.totalActive ?? row.active ?? 0)),
    [shownAgentRows],
  );
  const showWaitingLedger = snapshot.waiting.length > 0 || snapshot.queued > 0;
  const staleTimeLabel = time.absoluteTime(snapshot.asOf) ?? snapshot.asOf;
  const agentStaleTimeLabel = agentSnapshot === undefined
    ? ''
    : (time.absoluteTime(agentSnapshot.asOf) ?? agentSnapshot.asOf);
  const requestBandTotal = shown.reduce((sum, row) => sum + row.active + row.queued, 0);
  const requestBandActive = shown.reduce((sum, row) => sum + row.active, 0);
  const requestBandQueued = shown.reduce((sum, row) => sum + row.queued, 0);

  return (
    <div className="space-y-8">
      {/* Model requests: a section on the page, not a card — the heading and
          the muted count line carry the group, the count band shows the
          selected dimension's observed running vs queued counts, and the
          tables divide by hairlines. */}
      <section data-governance-live>
        <UsageSectionHeading
          title={t('usage.governance.viewRequests')}
          help={requestSummary}
          actions={(
            <>
              {stale ? (
                <span className="inline-flex items-center gap-1.5">
                  <span data-governance-stale-time className="text-[11.5px] text-amber-ink tabular-nums">
                    {t('usage.governance.stale', { time: staleTimeLabel })}
                  </span>
                  <button
                    type="button"
                    data-governance-stale
                    aria-label={`${t('usage.governance.stale', { time: staleTimeLabel })} · ${t('usage.execution.retryRefresh')}`}
                    title={`${t('usage.governance.stale', { time: staleTimeLabel })} · ${t('usage.execution.retryRefresh')}`}
                    onClick={onRefresh}
                    className="inline-flex min-h-7 min-w-7 items-center justify-center text-amber-ink transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                  >
                    <Icon name="refresh" size={12} className="h-[13px] w-[13px]" />
                  </button>
                </span>
              ) : null}
              <span className="sr-only" data-governance-active>{snapshot.active}</span>
              <span className="sr-only" data-governance-queued>{snapshot.queued}</span>
            </>
          )}
        />
        {shown.length > 0 && dimension !== undefined && requestBandTotal > 0 ? (
          <div
            data-governance-count-band={dimension}
            aria-label={t('usage.governance.countBandAria', { dimension: t(`usage.governance.${dimension}` as I18nKey) })}
            className="mb-4 space-y-1.5"
          >
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-ink/[0.06]">
              {requestBandActive > 0 ? (
                <span
                  data-governance-band-active
                  className="block h-full bg-selected-ink transition-[width] duration-200"
                  style={{ width: `${(requestBandActive / requestBandTotal) * 100}%` }}
                />
              ) : null}
              {requestBandQueued > 0 ? (
                <span
                  data-governance-band-queued
                  className={`block h-full bg-amber-rule transition-[width] duration-200 ${requestBandActive > 0 ? 'border-l border-paper' : ''}`}
                  style={{ width: `${(requestBandQueued / requestBandTotal) * 100}%` }}
                />
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-faint tabular-nums">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-2 w-2 rounded-full bg-selected-ink" />
                <span>{t('usage.governance.running')}</span>
                <span className="font-medium text-ink">{requestBandActive}</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-2 w-2 rounded-full bg-amber-rule" />
                <span>{t('usage.governance.queued')}</span>
                <span className="font-medium text-ink">{requestBandQueued}</span>
              </span>
            </div>
          </div>
        ) : null}
        <div className={`grid gap-x-8 gap-y-6 ${showWaitingLedger ? 'lg:grid-cols-2' : ''}`}>
          <section className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              {options.length > 1 && dimension !== undefined ? (
                <AxisGroup
                  label={t('usage.governance.byDimension')}
                  dataAxis="governance-dimension"
                  options={options}
                  value={dimension}
                  onChange={(next) => { setChosen(next); }}
                  labelFor={(option) => t(`usage.governance.${option}` as I18nKey)}
                />
              ) : <h2 className="text-[11.5px] font-medium text-ink-faint">{t('usage.governance.byDimension')}</h2>}
            </div>
            {shown.length === 0 ? (
              <p data-governance-dimensions-empty className="text-[12.5px] text-ink-faint">{t('usage.governance.idleNow')}</p>
            ) : (
              <div data-governance-dimensions data-governance-dimension={dimension}>
                <div aria-hidden className="hidden grid-cols-[minmax(0,1fr)_3.5rem_3.5rem] pb-2 text-[11px] text-ink-faint sm:grid">
                  <span>{t('usage.governance.target')}</span>
                  <span className="text-right">{t('usage.governance.running')}</span>
                  <span className="text-right">{t('usage.governance.queued')}</span>
                </div>
                <ol className="divide-y divide-hairline border-t border-hairline">
                  {shown.map((row) => {
                    const activePct = (row.active / requestMaxCount) * 100;
                    const queuedPct = (row.queued / requestMaxCount) * 100;
                    return (
                      <li key={`${row.dimension}:${row.id}`} data-governance-row={row.id} className="py-2">
                        <div className="flex flex-col gap-0.5 sm:grid sm:grid-cols-[minmax(0,1fr)_3.5rem_3.5rem] sm:items-baseline">
                          <span className="min-w-0 truncate text-[13px] text-ink" title={row.id}>{dimensionLabel(row)}</span>
                          <span className="text-[12px] text-ink-soft tabular-nums sm:hidden">
                            {`${t('usage.governance.running')} ${row.active} · ${t('usage.governance.queued')} ${row.queued}`}
                          </span>
                          <span className="hidden text-right text-[12.5px] text-ink tabular-nums sm:inline">{row.active}</span>
                          <span className="hidden text-right text-[12.5px] text-ink-soft tabular-nums sm:inline">{row.queued}</span>
                        </div>
                        {row.active + row.queued > 0 ? (
                          <div aria-hidden className="mt-1.5 flex h-1 w-full overflow-hidden rounded-full bg-ink/[0.05]">
                            {row.active > 0 ? (
                              <span className="block h-full bg-selected-ink/80" style={{ width: `${Math.max(2, activePct)}%` }} />
                            ) : null}
                            {row.queued > 0 ? (
                              <span className={`block h-full bg-amber-rule ${row.active > 0 ? 'border-l border-paper' : ''}`} style={{ width: `${Math.max(2, queuedPct)}%` }} />
                            ) : null}
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}
          </section>
          {showWaitingLedger ? (
            <section className="min-w-0" data-governance-waiting>
              <div className="mb-3 flex min-h-8 flex-wrap items-center justify-between gap-2">
                <h2 className="text-[12px] font-medium text-ink-faint">{t('usage.governance.waitingTitle')}</h2>
                {snapshot.queued > snapshot.waiting.length ? (
                  <span data-governance-waiting-showing className="text-[11.5px] text-ink-faint tabular-nums">
                    {t('usage.governance.waitingShowing', { shown: snapshot.waiting.length, total: snapshot.queued })}
                  </span>
                ) : null}
              </div>
              {snapshot.waiting.length > 0 ? (
                <ol className={`divide-y divide-hairline border-t border-hairline ${snapshot.waiting.length > 8 ? 'max-h-[360px] overflow-y-auto pr-1' : ''}`}>
                  {snapshot.waiting.map((row) => {
                    const longWait = row.waitedMs >= 10_000;
                    const cachedSession = row.sessionId === undefined ? undefined : nameOf(row.sessionId);
                    const sessionHint = cachedSession?.title;
                    const waitWidth = Math.max(4, Math.min(100, (row.waitedMs / waitingMaxMs) * 100));
                    return (
                      <li key={row.attemptId} data-governance-waiter={row.attemptId} className="py-2 text-[12.5px]">
                        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                          <span className="min-w-0 truncate font-medium text-ink" title={row.modelId}>{row.modelId}</span>
                          {sessionHint !== undefined ? (
                            <span className="min-w-0 truncate text-[12px] text-ink-soft" title={row.sessionId}>
                              {sessionHint}
                            </span>
                          ) : null}
                          {row.blockingRules.length > 0 ? (
                            onJumpToRule !== undefined ? (
                              <button
                                type="button"
                                onClick={() => { onJumpToRule(row.blockingRules[0]!); }}
                                className="min-w-0 truncate rounded font-mono text-[11.5px] text-ink-faint underline-offset-2 transition-colors hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink"
                              >
                                {t('usage.governance.blockedBy', { rules: row.blockingRules.join(', ') })}
                              </button>
                            ) : (
                              <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-faint">{t('usage.governance.blockedBy', { rules: row.blockingRules.join(', ') })}</span>
                            )
                          ) : null}
                          <span
                            data-governance-wait-long={longWait ? 'true' : undefined}
                            className={`ml-auto shrink-0 tabular-nums ${longWait ? 'font-mono font-medium text-amber-ink' : 'text-ink-soft'}`}
                          >
                            {time.formatDuration(row.waitedMs)}
                          </span>
                        </div>
                        <div aria-hidden className="mt-1.5 flex h-0.5 w-full overflow-hidden rounded-full bg-ink/[0.05]">
                          <span className={`block h-full ${longWait ? 'bg-amber-rule' : 'bg-ink-faint/45'}`} style={{ width: `${waitWidth}%` }} />
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ) : null}
            </section>
          ) : null}
        </div>
      </section>

      <section data-governance-live-agents>
        <UsageSectionHeading
          title={t('usage.governance.viewAgents')}
          help={agentSummary}
          actions={agentSnapshot === undefined ? undefined : (
            <>
              {liveAgent.stale ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-[11.5px] text-amber-ink tabular-nums">
                    {t('usage.governance.stale', { time: agentStaleTimeLabel })}
                  </span>
                  <button
                    type="button"
                    data-governance-agents-stale
                    data-governance-agents-retry
                    aria-label={`${t('usage.governance.stale', { time: agentStaleTimeLabel })} · ${t('usage.execution.retryRefresh')}`}
                    title={`${t('usage.governance.stale', { time: agentStaleTimeLabel })} · ${t('usage.execution.retryRefresh')}`}
                    onClick={() => { void liveAgent.refetch(); }}
                    className="inline-flex min-h-7 min-w-7 items-center justify-center text-amber-ink transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                  >
                    <Icon name="refresh" size={12} className="h-[13px] w-[13px]" />
                  </button>
                </span>
              ) : null}
              {executionVisibleError !== undefined ? (
                <span role="status" data-execution-stale className="inline-flex items-center">
                  <button
                    type="button"
                    data-execution-stale-retry
                    aria-label={`${t('usage.execution.staleState')} · ${t('usage.execution.retryRefresh')}`}
                    title={`${t('usage.execution.staleState')} · ${t('usage.execution.retryRefresh')}`}
                    onClick={retryExecutionReads}
                    className="inline-flex h-7 w-7 items-center justify-center rounded text-amber-ink transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11"
                  >
                    <Icon name="refresh" size={12} />
                  </button>
                </span>
              ) : null}
              <PauseAllExecutions snapshot={agentSnapshot} states={executionStates} labelOf={labelOf} />
              <span className="sr-only" data-governance-main-agents>{agentSnapshot?.mainActive ?? agentSnapshot?.main ?? 0}</span>
              <span className="sr-only" data-governance-sub-agents>{agentSnapshot?.subActive ?? agentSnapshot?.subagent ?? 0}</span>
              <span className="sr-only" data-governance-independent-agents>{agentSnapshot?.independentActive ?? agentSnapshot?.independent ?? 0}</span>
              <span className="sr-only" data-governance-total-agents>{agentSnapshot?.totalActive ?? agentSnapshot?.active ?? 0}</span>
              <span className="sr-only" data-governance-agents-queued>{agentSnapshot?.queued ?? 0}</span>
            </>
          )}
        />
        {agentSnapshot === undefined ? (
          <p role="status" data-governance-agents-status className="text-[12.5px] text-ink-faint">
            {t(liveAgent.isError || !liveAgent.loading ? 'usage.governance.agentsUnavailable' : 'usage.governance.agentsLoading')}
            {liveAgent.isError || !liveAgent.loading ? (
              <button type="button" data-governance-agents-retry className="ml-2 font-medium text-ink underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink" onClick={() => { void liveAgent.refetch(); }}>
                {t('usage.execution.retryRefresh')}
              </button>
            ) : null}
          </p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <AxisGroup
                label={t('usage.governance.byDimension')}
                dataAxis="governance-agent-dimension"
                options={agentOptions}
                value={agentDimension}
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
              <p data-governance-agents-empty className="text-[12.5px] text-ink-faint">{t('usage.governance.idleAgents')}</p>
            ) : (
              <div
                data-governance-agent-dimensions
                data-governance-agent-dimension={agentDimension}
                aria-label={t('usage.governance.agentBandAria', { dimension: t(`usage.governance.${agentDimension}` as I18nKey) })}
              >
                <div aria-hidden className="hidden grid-cols-[minmax(0,1fr)_4.25rem_4.25rem_4.25rem_4.5rem] gap-x-2 pb-2 text-[11px] text-ink-faint sm:grid">
                  <span>{t('usage.governance.target')}</span>
                  <span className="text-right">{t('usage.governance.mainAgents')}</span>
                  <span className="text-right">{t('usage.governance.subagents')}</span>
                  <span className="text-right">{t('usage.governance.independentAgents')}</span>
                  <span className="text-right">{t('usage.governance.totalAgents')}</span>
                </div>
                <ol className="divide-y divide-hairline border-t border-hairline">
                  {shownAgentRows.map((row) => {
                    const mainCount = row.mainActive ?? row.main ?? 0;
                    const subCount = row.subActive ?? row.subagent ?? 0;
                    const indCount = row.independentActive ?? row.independent ?? 0;
                    const totalCount = row.totalActive ?? row.active ?? 0;
                    return (
                      <li key={`${row.dimension}:${row.id ?? 'unknown'}`} data-governance-agent-row={row.id ?? 'unknown'} className="py-2">
                        <div className="flex flex-col gap-0.5 sm:grid sm:grid-cols-[minmax(0,1fr)_4.25rem_4.25rem_4.25rem_4.5rem] sm:items-baseline sm:gap-x-2">
                          <span className="min-w-0 truncate text-[13px] text-ink" title={row.id ?? ''}>
                            {agentRowDisplay(row.id)}
                          </span>
                          <span className="text-[12px] text-ink-soft tabular-nums sm:hidden">
                            {[
                              `${t('usage.governance.mainAgents')} ${mainCount}`,
                              `${t('usage.governance.subagents')} ${subCount}`,
                              `${t('usage.governance.independentAgents')} ${indCount}`,
                              `${t('usage.governance.totalAgents')} ${totalCount}`,
                            ].join(' · ')}
                          </span>
                          <span className="hidden text-right text-[12.5px] text-ink tabular-nums sm:inline">{mainCount}</span>
                          <span className="hidden text-right text-[12.5px] text-ink-soft tabular-nums sm:inline">{subCount}</span>
                          <span className="hidden text-right text-[12.5px] text-ink-faint tabular-nums sm:inline">{indCount}</span>
                          <span className="hidden text-right text-[12.5px] text-ink tabular-nums sm:inline">{totalCount}</span>
                        </div>
                        {totalCount > 0 ? (
                          <div aria-hidden className="mt-1.5 flex h-1 w-full overflow-hidden rounded-full bg-ink/[0.05]">
                            {mainCount > 0 ? (
                              <span className="block h-full bg-ink/70" style={{ width: `${Math.max(2, (mainCount / agentMaxCount) * 100)}%` }} />
                            ) : null}
                            {subCount > 0 ? (
                              <span className={`block h-full bg-selected-ink/80 ${mainCount > 0 ? 'border-l border-paper' : ''}`} style={{ width: `${Math.max(2, (subCount / agentMaxCount) * 100)}%` }} />
                            ) : null}
                            {indCount > 0 ? (
                              <span className={`block h-full bg-ink-faint/55 ${(mainCount > 0 || subCount > 0) ? 'border-l border-paper' : ''}`} style={{ width: `${Math.max(2, (indCount / agentMaxCount) * 100)}%` }} />
                            ) : null}
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}
          </>
        )}
        <ExecutionSessionList liveSessionIds={liveSessionIds} states={executionStates} onRetryRead={refetchExecutions} labelOf={labelOf} />
      </section>
    </div>
  );
}
