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
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { AgentForest, SessionController, SessionViewState } from '@kiki/session-core/session';
import { MAIN_AGENT_ID } from '@kiki/session-core/session';
import { sumAgentTreeMetrics, UNKNOWN_AGENT_PANEL_METRICS } from '@kiki/session-core/session/agentPanel';
import { useConnection, useOptionalControllerRegistry } from '../state/connection';
import { useI18n } from '../i18n';
import { AgentIdentitySection } from './agent-panel/AgentIdentitySection';
import { AgentTodoSection } from './agent-panel/AgentTodoSection';
import { AgentPlanSection } from './agent-panel/AgentPlanSection';
import { AgentCapabilitiesSection } from './agent-panel/AgentCapabilitiesSection';
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
 * Slices of the panel the inspector places at different depths: `work`
 * (todo + plan, near the top), `usage` (context and known metrics), and
 * `setup` (model, profile, capabilities — collapsed by default). `all`
 * keeps the historical single column for the preview tab body.
 */
export type AgentPanelPart = 'all' | 'work' | 'usage' | 'setup';

export function AgentPanelContainer({ state, forest, agentId, visible = true, part = 'all' }: {
  state: SessionViewState;
  forest: AgentForest;
  agentId: string;
  visible?: boolean;
  part?: AgentPanelPart;
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
  const tree = treeComplete ? sumAgentTreeMetrics(ids, metrics) : { totalTokens: null, totalCostUsd: null };
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
  if (part === 'work') {
    return <div data-agent-panel-container data-agent-panel-part="work" className="space-y-4 empty:hidden">
      {todoSection}
      {planSection}
    </div>;
  }
  const identityProps = {
    identity: {
      id: agentId, profile: profileName,
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
    profilePolicy: profile?.subagent_policy, dispatchTargets: data?.targets,
    subagentTargets, skills: mappedSkills, toolCapabilities: mappedTools, draftScope, usage,
    treeMetrics: agentId === MAIN_AGENT_ID ? {
      ...tree,
      cacheHitRate: treeComplete ? aggregateTreeCacheHitRate(ids, metrics) : null,
      cacheReadTokens: treeComplete ? aggregateTreeCacheReadTokens(ids, metrics) : null,
      cacheWriteTokens: treeComplete ? aggregateTreeCacheWriteTokens(ids, metrics) : null,
      activeSubagentsCount: Object.values(forest.byId).filter((entry) => entry.agentId !== MAIN_AGENT_ID && entry.busy).length,
      totalSubagentsCount: ids.filter((id) => id !== MAIN_AGENT_ID).length,
    } : undefined,
    onOpenUsageDetail: () => { void navigate(usageSessionDeepLink(state.sessionId)); },
  };
  // A failed or unsupported capability read is a quiet, recoverable line in
  // the (collapsed) setup chapter — never a red wall above the agent's work.
  const capabilityStatus = <>
    {capabilities.isPending && visible ? <p role="status" className="text-[12px] text-ink-faint">{t('diagnostics.loading')}</p> : null}
    {capabilities.isError && isCapabilityUnsupportedError(capabilities.error) ? (
      <p role="status" data-capabilities-unsupported className="sr-only">{t('diagnostics.unknown')}</p>
    ) : null}
    {capabilities.isError && !isCapabilityUnsupportedError(capabilities.error) ? <p role="alert" className="text-[12px] leading-relaxed text-ink-soft">
      {t('diagnostics.error')} · {agentCapabilitiesErrorText(capabilities.error, t)}
      <button type="button" className="ml-1.5 font-medium text-ink transition-colors hover:text-accent" onClick={() => { void capabilities.refetch(); }}>{t('common.retry')}</button>
    </p> : null}
  </>;
  if (part === 'usage') {
    return <AgentIdentitySection {...identityProps} part="usage" />;
  }
  if (part === 'setup') {
    return <div data-agent-panel-container data-agent-panel-part="setup" className="space-y-3">
      <AgentIdentitySection {...identityProps} part="setup" />
      {capabilityStatus}
      {data !== undefined && (data.tools === undefined || data.skills === undefined) && unavailableReason !== undefined ?
        <p role="status" className="text-[12px] leading-relaxed text-ink-faint">{unavailableReason}</p> : null}
      {data?.tools !== undefined && data.skills !== undefined ? <AgentCapabilitiesSection
        tools={mappedTools}
        skills={mappedSkills}
        subagentTargets={subagentTargets}
        draftScope={draftScope}
      /> : null}
    </div>;
  }
  return <div data-agent-panel-container className="space-y-5">
    <AgentIdentitySection identity={{
      id: agentId, profile: profileName,
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
    }} profilePolicy={profile?.subagent_policy} dispatchTargets={data?.targets}
      subagentTargets={subagentTargets}
      skills={mappedSkills}
      toolCapabilities={mappedTools}
      draftScope={draftScope}
      usage={usage} treeMetrics={agentId === MAIN_AGENT_ID ? {
      ...tree,
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
    {capabilities.isError && !isCapabilityUnsupportedError(capabilities.error) ? <div role="alert" className="border-l-2 border-danger pl-2.5 text-[12.5px] text-danger">
      {t('diagnostics.error')} · {agentCapabilitiesErrorText(capabilities.error, t)}
      <button type="button" className="ml-2 font-medium text-ink underline underline-offset-2" onClick={() => { void capabilities.refetch(); }}>{t('common.retry')}</button>
    </div> : null}
    {todoSection}
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
