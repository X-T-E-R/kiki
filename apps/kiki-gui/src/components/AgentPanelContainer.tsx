/**
 * Agent panel container — the body of a `panel:<agentId>` preview tab and of
 * the right rail's selected-agent panel.
 *
 * Every agent-scoped field it renders is read from THIS tab's agent. The routed
 * `state` prop describes whichever agent the session page currently shows, so
 * reading todos / plan mode / busy from it would relabel that agent's data as
 * this tab's — a panel tab for a subagent must never present the routed
 * agent's (or the main agent's) todos as that subagent's. The session's live
 * controller registry — the same channel SessionView publishes into — is the
 * per-agent source of truth; when no controller owns the session there is
 * nothing agent-scoped to read, and the panel reports "not reported" instead of
 * borrowing the routed agent's data.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { AgentForest, SessionController, SessionViewState } from '@kiki/session-core/session';
import { MAIN_AGENT_ID } from '@kiki/session-core/session';
import { sumAgentTreeMetrics, UNKNOWN_AGENT_PANEL_METRICS } from '@kiki/session-core/session/agentPanel';
import { useConnection, useOptionalControllerRegistry } from '../state/connection';
import { useI18n } from '../i18n';
import { useAutoCompact } from './useAutoCompact';
import { InspectorOverview, type OverviewFigures } from './agent-panel/InspectorOverview';
import { CockpitOverview } from './rail-variants/CockpitOverview';
import type { RailMode } from './rail-variants/shell';
import { agentUsageCacheHitRate } from './agent-panel/cacheRate';
import type { AgentTokenUsage } from './agent-panel/types';
import { AgentIdentitySection } from './agent-panel/AgentIdentitySection';
import { AgentTodoSection } from './agent-panel/AgentTodoSection';
import { AgentNotesSection } from './agent-panel/AgentNotesSection';
import { AgentHooksSection } from './agent-panel/AgentHooksSection';
import { AgentPlanSection } from './agent-panel/AgentPlanSection';
import { AgentCapabilitiesSection, capabilityCounts } from './agent-panel/AgentCapabilitiesSection';
import { usageSessionDeepLink } from '../lib/usageV2';
import { aggregateTreeCacheHitRate, aggregateTreeCacheReadTokens, aggregateTreeCacheWriteTokens } from './agent-panel/cacheRate';
import {
  agentCapabilitiesErrorText,
  capabilityReasonText,
  isCapabilityUnsupportedError,
  mapPanelSkills,
  mapPanelSubagentTargets,
  mapPanelTools,
} from './agent-panel/mapCapabilities';

const noopSubscribe = (): (() => void) => () => {};
const NO_WAITING: ReadonlySet<string> = new Set();

/**
 * Live view state of the agent this panel belongs to, or `undefined` when no
 * controller owns the session (no live connection) — i.e. no per-agent data
 * exists at all. A subagent without its own state reads as an unloaded empty
 * state, never as the session's main agent.
 */
function useAgentViewState(sessionId: string, agentId: string): SessionViewState | undefined {
  const registry = useOptionalControllerRegistry();
  const subscribeRegistry = useCallback(
    (listener: () => void) => (registry === null ? noopSubscribe() : registry.subscribe(listener)),
    [registry],
  );
  const registryGeneration = useSyncExternalStore(
    subscribeRegistry,
    () => registry?.snapshot() ?? 0,
    () => 0,
  );
  const controller = useMemo(() => {
    if (registry === null) return undefined;
    let found: SessionController | undefined;
    for (const candidate of registry) {
      if (candidate.sessionId === sessionId) {
        found = candidate;
        break;
      }
    }
    return found;
  }, [registry, registryGeneration, sessionId]);
  const subscribeAgent = useCallback(
    (listener: () => void) => {
      if (controller === undefined) return noopSubscribe();
      return agentId === MAIN_AGENT_ID
        ? controller.subscribe(listener)
        : controller.subscribeAgent(agentId, listener);
    },
    [controller, agentId],
  );
  const readAgentState = useCallback(
    (): SessionViewState | undefined =>
      controller === undefined
        ? undefined
        : agentId === MAIN_AGENT_ID
          ? controller.getState()
          : controller.getAgentState(agentId),
    [controller, agentId],
  );
  return useSyncExternalStore(subscribeAgent, readAgentState);
}

/**
 * Slices of the panel the inspector places at different depths: `profile`
 * (the top card: who this agent is, folded to one line, opening onto its
 * tools, skills, subagents and extensions), `work` (todo + plan), `overview`
 * (the resident context / usage summary) and `usage` (the older two-line
 * usage slice). `all` keeps the historical single column for the preview
 * tab body.
 */
export type AgentPanelPart = 'all' | 'work' | 'usage' | 'overview' | 'profile';

export function AgentPanelContainer({ state, forest, agentId, visible = true, part = 'all', overviewMode = 'default', renderOverview, waitingIds, onOpenAgent }: {
  state: SessionViewState;
  forest: AgentForest;
  agentId: string;
  visible?: boolean;
  part?: AgentPanelPart;
  /** The overview part's body: the standard figures or the cockpit instruments. */
  overviewMode?: RailMode;
  renderOverview?: (body: React.ReactNode, scopeSwitch: React.ReactNode) => React.ReactNode;
  /** Agents waiting on the user (cockpit lanes set them apart). */
  waitingIds?: ReadonlySet<string>;
  /** Cockpit lane rows open that agent. */
  onOpenAgent?: (agentId: string) => void;
}) {
  const { klient } = useConnection();
  const { t } = useI18n();
  const navigate = useNavigate();
  const query = { session_id: state.sessionId, agent_id: agentId };
  const node = forest.byId[agentId];
  const agentState = useAgentViewState(state.sessionId, agentId);
  // Poll cadence follows THIS agent's activity — its own view state or its
  // forest node. The routed agent being busy must neither start nor stop it.
  const active = agentState?.busy === true || node?.busy === true ||
    (agentId === MAIN_AGENT_ID && Object.values(forest.byId).some((entry) => entry.busy));
  const capabilities = useQuery({
    queryKey: ['agentCapabilities', query],
    queryFn: ({ signal }) => klient.global.agentPanel.read(query, { signal }),
    // The `work` slice (todo + plan) reads only the live agent state; it never
    // needs the capability/metrics read, so it does not start one.
    enabled: part !== 'work' && visible && state.loaded && !state.resyncing,
    // Overview and setup render side by side and read the same answer.
    staleTime: 5_000,
    refetchInterval: (current) => visible && active && current.state.data?.metrics?.[agentId] !== undefined ? 15_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: visible && active,
    retry: false,
  });
  const refreshSignature = JSON.stringify([
    state.sessionId,
    agentId,
    active,
    agentState?.profile,
    agentState?.model,
    agentState?.permissionMode,
    agentState?.planMode,
  ]);
  const previousSignature = useRef(refreshSignature);
  useEffect(() => {
    if (part === 'work' || !visible || previousSignature.current === refreshSignature || !state.loaded || state.resyncing || capabilities.isFetching) return;
    previousSignature.current = refreshSignature;
    void capabilities.refetch({ cancelRefetch: false });
  }, [part, visible, refreshSignature, state.loaded, state.resyncing, capabilities.isFetching, capabilities.refetch]);
  const data = capabilities.data;
  const profile = data?.profile;
  const metrics = data?.metrics ?? {};
  const usage = metrics[agentId] ?? UNKNOWN_AGENT_PANEL_METRICS;
  const ids = [...new Set([MAIN_AGENT_ID, ...Object.keys(forest.byId), ...Object.keys(metrics)])];
  const treeComplete = ids.every((id) => metrics[id] !== undefined);
  // Sums the agents the server has actually reported, and `null` only when
  // none are known. Callers label an incomplete sum as such rather than
  // passing it off as the whole tree.
  const tree = sumAgentTreeMetrics(ids, metrics);
  const todos = (agentState?.todos ?? []).filter((todo): todo is typeof todo & { status: 'pending' | 'in_progress' | 'done' } =>
    todo.status === 'pending' || todo.status === 'in_progress' || todo.status === 'done');
  const loaded = agentState?.loaded === true;
  const planMode = agentState?.planMode;
  const profileName = profile?.name === 'unknown' ? '' : (profile?.name ?? agentState?.profile ?? '');
  const unavailableReason = data === undefined
    ? undefined
    : capabilityReasonText(t, data.unavailable_reason_code, data.unavailable_reason);

  const subagentTargets = useMemo(() => mapPanelSubagentTargets(data?.targets), [data?.targets]);
  const mappedSkills = useMemo(() => mapPanelSkills(data?.skills), [data?.skills]);
  const mappedTools = useMemo(() => mapPanelTools(data?.tools), [data?.tools]);
  const draftScope = useMemo(() => ({
    workspace_id: state.session?.workspace_id,
    cwd: state.session?.metadata?.cwd,
  }), [state.session?.workspace_id, state.session?.metadata?.cwd]);
  // The resident overview needs the server's automatic compaction point;
  // only that slice starts the read.
  const autoCompact = useAutoCompact({
    sessionId: part === 'overview' && visible ? state.sessionId : undefined,
    agentId,
    refreshKey: `${agentState?.model ?? ''}:${agentState?.maxContextTokens ?? ''}`,
  });
  const [scope, setScope] = useState<'agent' | 'tree'>('agent');

  // Only this agent's own state feeds the checklist, and it renders only when
  // there is something to show: no per-agent data and a still-loading agent
  // both render nothing visible (a status marker stays for assistive tech),
  // and neither ever falls back to the routed agent's todos.
  const todoSection =
    agentState !== undefined && loaded
      ? todos.length > 0
        ? <AgentTodoSection todos={todos.map((todo, index) => ({ ...todo, id: `${agentId}:${index}` }))} />
        : null
      : agentState !== undefined && node !== undefined
        ? <p role="status" data-agent-todos-status="loading" className="sr-only">{t('diagnostics.loading')}</p>
        : <p role="status" data-agent-todos-status="unknown" className="sr-only">{t('diagnostics.unknown')}</p>;
  const planSection = agentState !== undefined ? <AgentPlanSection
    key={`${state.sessionId}:${agentId}`}
    sessionId={state.sessionId}
    agentId={agentId}
    loaded={loaded}
    resyncing={agentState.resyncing}
    planMode={planMode}
  /> : null;
  // The agent's own working notes sit under its checklist: the same writer
  // (TodoList), read-only here, from this agent's state only. The section
  // itself tells a still-loading agent from one that has no notes yet.
  const notesSection = agentState !== undefined
    ? <AgentNotesSection notes={agentState.todoNotes} meta={agentState.todoNotesMeta} status={agentState.todoNotesStatus} loaded={loaded} />
    : null;
  // Which hook rules this agent runs with, and from which file: an on-demand
  // detail under its notes, asked only when this agent has live state.
  const hooksSection = agentState !== undefined
    ? <AgentHooksSection key={`hooks:${state.sessionId}:${agentId}`} sessionId={state.sessionId} agentId={agentId} />
    : null;
  if (part === 'work') {
    return <div data-agent-panel-container data-agent-panel-part="work" className="space-y-4 empty:hidden">
      {todoSection}
      {notesSection}
      {hooksSection}
      {planSection}
    </div>;
  }
  const identityProps = {
    identity: {
      id: agentId, sessionId: state.sessionId, profile: profileName,
      label: node?.label ?? agentId, model: profile?.model ?? agentState?.model,
      thinkingEffort: profile?.thinking_effort,
      thinkingEffortSource: profile?.thinking_effort_source,
      routeDetached: profile?.route_detached,
      profileSource: profile?.profile_source,
      status: node?.status ?? 'unknown', summary: profile?.description,
      description: profile?.description, source: profile?.source, sourceFile: profile?.source_file,
      context: data?.context ?? 'live', isMain: agentId === MAIN_AGENT_ID,
      configContentPreview: profile === undefined ? undefined : JSON.stringify(profile, null, 2),
      rawProfile: profile,
    },
    profilePolicy: profile?.can_spawn_subagents === false ? 'fixed' as const : undefined, dispatchTargets: data?.targets,
    subagentTargets, skills: mappedSkills, toolCapabilities: mappedTools, draftScope, usage,
    // The profile card has no way to mark a count as partial, so it keeps the
    // stricter rule: a tree that is not fully reported shows no total at all.
    // The overview labels its own partial sum instead.
    treeMetrics: agentId === MAIN_AGENT_ID ? {
      ...(treeComplete ? tree : { totalTokens: null, totalCostUsd: null }),
      cacheHitRate: treeComplete ? aggregateTreeCacheHitRate(ids, metrics) : null,
      cacheReadTokens: treeComplete ? aggregateTreeCacheReadTokens(ids, metrics) : null,
      cacheWriteTokens: treeComplete ? aggregateTreeCacheWriteTokens(ids, metrics) : null,
      activeSubagentsCount: Object.values(forest.byId).filter((entry) => entry.agentId !== MAIN_AGENT_ID && entry.busy).length,
      totalSubagentsCount: ids.filter((id) => id !== MAIN_AGENT_ID).length,
    } : undefined,
    onOpenUsageDetail: () => { void navigate(usageSessionDeepLink(state.sessionId)); },
  };
  if (part === 'usage') {
    return <AgentIdentitySection {...identityProps} part="usage" />;
  }
  const facts = overviewFacts({
    t, agentId, state, agentState, forest, usage, metrics, ids, treeComplete, tree,
    compactPoint: autoCompact?.status?.tokens,
  });
  if (part === 'overview') {
    const cockpit = (
      <CockpitOverview
        agentId={agentId}
        forest={forest}
        blocks={state.blocks}
        waitingIds={waitingIds ?? NO_WAITING}
        contextUsed={facts.contextUsed}
        contextLimit={facts.contextLimit}
        compactPoint={facts.compactPoint}
        figures={facts.figures}
        turns={facts.turns}
        toolCalls={facts.toolCalls}
        onOpenAgent={onOpenAgent}
      />
    );
    return <div data-agent-panel-container data-agent-panel-part="overview" data-overview-mode={overviewMode}>
      {overviewMode === 'cockpit' ? (renderOverview === undefined ? cockpit : renderOverview(cockpit, null)) : (
        <InspectorOverview
          contextUsed={facts.contextUsed}
          contextLimit={facts.contextLimit}
          compactPoint={facts.compactPoint}
          figures={facts.figures}
          treeFigures={facts.treeFigures}
          scope={scope}
          onScope={setScope}
          renderLayout={renderOverview}
          startedAt={facts.startedAt}
          turns={facts.turns}
          toolCalls={facts.toolCalls}
        />
      )}
    </div>;
  }
  if (part === 'profile') {
    const counts = data?.tools !== undefined && data.skills !== undefined
      ? capabilityCounts(mappedTools, mappedSkills, subagentTargets)
      : undefined;
    // Hover detail on the folded line; the tabs carry the counts when open.
    const summary = counts === undefined ? undefined : [
      `${t('inspector.cap.tools')} ${counts.toolsOn}`,
      `${t('inspector.cap.skills')} ${counts.skills}`,
      `${t('inspector.cap.subagents')} ${counts.subagents}`,
      `${t('inspector.cap.extensions')} ${counts.extensions}`,
    ].join(' · ');
    // A failed read is one quiet line inside the card, never a banner.
    const capabilityBody = counts !== undefined ? (
      <AgentCapabilitiesSection
        tools={mappedTools}
        skills={mappedSkills}
        subagentTargets={subagentTargets}
        draftScope={draftScope}
        callerProfile={profileName === '' ? undefined : profileName}
      />
    ) : capabilities.isPending ? (
      <p role="status" className="text-[12px] text-ink-faint">{t('inspector.cap.loading')}</p>
    ) : capabilities.isError && isCapabilityUnsupportedError(capabilities.error) ? (
      <p role="status" data-capabilities-unsupported className="sr-only">{t('diagnostics.unknown')}</p>
    ) : capabilities.isError ? (
      <p role="status" data-capabilities-error className="text-[12px] leading-relaxed text-ink-faint">
        {t('inspector.cap.loadFailed')}
        <button type="button" className="ml-1.5 font-medium text-ink-soft transition-colors hover:text-ink" onClick={() => { void capabilities.refetch(); }}>{t('common.retry')}</button>
      </p>
    ) : unavailableReason !== undefined ? (
      <p role="status" className="text-[12px] leading-relaxed text-ink-faint">{unavailableReason}</p>
    ) : null;
    return <div data-agent-panel-container data-agent-panel-part="profile">
      <AgentIdentitySection {...identityProps} part="profile" capabilities={capabilityBody} capabilitySummary={summary} />
    </div>;
  }
  return <div data-agent-panel-container className="space-y-5">
    <AgentIdentitySection identity={{
      id: agentId, sessionId: state.sessionId, profile: profileName,
      label: node?.label ?? agentId, model: profile?.model ?? agentState?.model,
      thinkingEffort: profile?.thinking_effort,
      thinkingEffortSource: profile?.thinking_effort_source,
      routeDetached: profile?.route_detached,
      profileSource: profile?.profile_source,
      status: node?.status ?? 'unknown', summary: profile?.description,
      description: profile?.description, source: profile?.source, sourceFile: profile?.source_file,
      context: data?.context ?? 'live', isMain: agentId === MAIN_AGENT_ID,
      configContentPreview: profile === undefined ? undefined : JSON.stringify(profile, null, 2),
      rawProfile: profile,
    }} profilePolicy={profile?.can_spawn_subagents === false ? 'fixed' : undefined} dispatchTargets={data?.targets}
      subagentTargets={subagentTargets}
      skills={mappedSkills}
      toolCapabilities={mappedTools}
      draftScope={draftScope}
      usage={usage} treeMetrics={agentId === MAIN_AGENT_ID ? {
      ...(treeComplete ? tree : { totalTokens: null, totalCostUsd: null }),
      cacheHitRate: treeComplete ? aggregateTreeCacheHitRate(ids, metrics) : null,
      cacheReadTokens: treeComplete ? aggregateTreeCacheReadTokens(ids, metrics) : null,
      cacheWriteTokens: treeComplete ? aggregateTreeCacheWriteTokens(ids, metrics) : null,
      activeSubagentsCount: Object.values(forest.byId).filter((entry) => entry.agentId !== MAIN_AGENT_ID && entry.busy).length,
      totalSubagentsCount: ids.filter((id) => id !== MAIN_AGENT_ID).length,
    } : undefined} onOpenUsageDetail={() => { void navigate(usageSessionDeepLink(state.sessionId)); }} />
    {capabilities.isPending ? <p role="status" className="text-[12.5px] text-ink-faint">{t('diagnostics.loading')}</p> : null}
    {/* An unsupported capability scope is a gap, not a failure: render nothing
        visible (the marker stays for assistive tech and tests). */}
    {capabilities.isError && isCapabilityUnsupportedError(capabilities.error) ? (
      <p role="status" data-capabilities-unsupported className="sr-only">{t('diagnostics.unknown')}</p>
    ) : null}
    {capabilities.isError && !isCapabilityUnsupportedError(capabilities.error) ? <div role="alert" className="border-l-2 border-danger pl-3 text-[12.5px] text-danger">
      {t('diagnostics.error')} · {agentCapabilitiesErrorText(capabilities.error, t)}
      <button type="button" className="ml-2 font-medium text-ink underline underline-offset-2" onClick={() => { void capabilities.refetch(); }}>{t('common.retry')}</button>
    </div> : null}
    {todoSection}
    {notesSection}
    {agentState !== undefined ? <AgentPlanSection
      key={`${state.sessionId}:${agentId}`}
      sessionId={state.sessionId}
      agentId={agentId}
      loaded={loaded}
      resyncing={agentState.resyncing}
      planMode={planMode}
    /> : null}
    {data !== undefined && (data.tools === undefined || data.skills === undefined) ?
      <p role="status" className="text-[12.5px] leading-relaxed text-ink-faint">{unavailableReason ?? t('diagnostics.unknown')}</p> : null}
    {data?.tools !== undefined && data.skills !== undefined ? <AgentCapabilitiesSection
      tools={mappedTools}
      skills={mappedSkills}
      subagentTargets={subagentTargets}
      draftScope={draftScope}
    /> : null}
  </div>;
}

type Translate = ReturnType<typeof useI18n>['t'];

const known = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

function figuresFrom(usage: AgentTokenUsage, t: Translate): OverviewFigures {
  const cacheRate = agentUsageCacheHitRate(usage);
  return {
    costUsd: known(usage.totalCostUsd) ? usage.totalCostUsd : undefined,
    totalTokens: known(usage.totalTokens) ? usage.totalTokens : undefined,
    inputTokens: known(usage.inputTokens) ? usage.inputTokens : undefined,
    outputTokens: known(usage.outputTokens) ? usage.outputTokens : undefined,
    cacheRate: cacheRate ?? undefined,
    cacheTitle: known(usage.cacheReadTokens) || known(usage.cacheWriteTokens)
      ? t('agentPanel.cacheRawTooltip', {
          read: known(usage.cacheReadTokens) ? usage.cacheReadTokens.toLocaleString() : '—',
          write: known(usage.cacheWriteTokens) ? usage.cacheWriteTokens.toLocaleString() : '—',
        })
      : undefined,
    compactions: known(usage.compactionCount) ? usage.compactionCount : undefined,
    partial: usage.usagePartial === true || usage.costPartial === true,
  };
}

/** Session-record usage (main only): the fallback when the panel read has no row. */
function figuresFromSession(state: SessionViewState): OverviewFigures | undefined {
  const usage = state.session?.usage as typeof state.session extends undefined ? never : NonNullable<typeof state.session>['usage'] | undefined;
  if (usage == null) return undefined;
  const input = usage.input_tokens + usage.cache_read_tokens + usage.cache_creation_tokens;
  const total = input + usage.output_tokens;
  if (total === 0 && usage.total_cost_usd === 0) return undefined;
  return {
    costUsd: usage.total_cost_usd,
    totalTokens: total,
    inputTokens: input,
    outputTokens: usage.output_tokens,
    cacheRate: input > 0 ? Math.round((usage.cache_read_tokens / input) * 100) : undefined,
  };
}

/**
 * Everything the overview shows, derived once. Only known values are returned;
 * each consumer drops what is missing.
 */
function overviewFacts(input: {
  t: Translate;
  agentId: string;
  state: SessionViewState;
  agentState: SessionViewState | undefined;
  forest: AgentForest;
  usage: AgentTokenUsage;
  metrics: Readonly<Record<string, AgentTokenUsage>>;
  ids: readonly string[];
  treeComplete: boolean;
  tree: { totalTokens: number | null; totalCostUsd: number | null };
  compactPoint: number | undefined;
}) {
  const { t, agentId, state, agentState, forest, usage, metrics, ids, treeComplete, tree } = input;
  const isMain = agentId === MAIN_AGENT_ID;
  const node = forest.byId[agentId];
  const contextUsed = known(usage.contextTokens) ? usage.contextTokens
    : agentState?.contextTokens ?? (isMain ? state.contextTokens ?? state.session?.usage?.context_tokens : node?.contextTokens);
  const contextLimit = known(usage.contextLimit) && usage.contextLimit > 0 ? usage.contextLimit
    : agentState?.maxContextTokens ?? (isMain ? state.maxContextTokens ?? (state.session?.usage?.context_limit || undefined) : node?.maxContextTokens);
  const hasPanelUsage = known(usage.totalTokens) || known(usage.totalCostUsd);
  const figures = hasPanelUsage ? figuresFrom(usage, t) : (isMain ? figuresFromSession(state) : undefined) ?? figuresFrom(usage, t);
  // Main's page always offers the tree scope. A tree that is not fully
  // counted yet sums only the agents the server has actually reported and
  // says so, rather than disappearing from the rail or passing a partial sum
  // off as the whole tree.
  const treeFigures: OverviewFigures | undefined = isMain ? {
    costUsd: tree.totalCostUsd ?? undefined,
    totalTokens: tree.totalTokens ?? undefined,
    cacheRate: aggregateTreeCacheHitRate(ids, metrics) ?? undefined,
    incomplete: !treeComplete,
  } : undefined;
  const startedAt = isMain ? state.session?.created_at : node?.startedAt;
  const turns = isMain ? state.session?.usage?.turn_count : undefined;
  const toolCalls = !isMain && node?.toolCallCountKnown === true ? node.toolCallCount : undefined;
  return {
    contextUsed,
    contextLimit,
    compactPoint: input.compactPoint,
    figures,
    treeFigures,
    startedAt,
    turns,
    toolCalls,
  };
}
