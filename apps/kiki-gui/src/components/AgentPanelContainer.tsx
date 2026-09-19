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

export function AgentPanelContainer({ state, forest, agentId }: {
  state: SessionViewState;
  forest: AgentForest;
  agentId: string;
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
    // Session-level gate only: this RPC needs the session open, and its payload
    // is already scoped by `agent_id`, so no agent data leaks through the flag.
    enabled: state.loaded && !state.resyncing,
    refetchInterval: (current) => active && current.state.data?.metrics?.[agentId] !== undefined ? 5_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: active,
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
    if (previousSignature.current === refreshSignature) return;
    previousSignature.current = refreshSignature;
    if (state.loaded && !state.resyncing) void capabilities.refetch();
  }, [refreshSignature, state.loaded, state.resyncing, capabilities.refetch]);
  const data = capabilities.data;
  const profile = data?.profile;
  const metrics = data?.metrics ?? {};
  const usage = metrics[agentId] ?? UNKNOWN_AGENT_PANEL_METRICS;
  const ids = [...new Set([MAIN_AGENT_ID, ...Object.keys(forest.byId), ...Object.keys(metrics)])];
  const tree = sumAgentTreeMetrics(ids, metrics);
  const todos = (agentState?.todos ?? []).filter((todo): todo is typeof todo & { status: 'pending' | 'in_progress' | 'done' } =>
    todo.status === 'pending' || todo.status === 'in_progress' || todo.status === 'done');
  const loaded = agentState?.loaded === true;
  const planMode = agentState?.planMode;
  const profileName = profile?.name === 'unknown' ? t('diagnostics.unknown') : (profile?.name ?? agentState?.profile ?? t('diagnostics.unknown'));
  // Only this agent's own state feeds the checklist: no per-agent data at all
  // reads as not-reported, a known agent whose own state is still loading reads
  // as loading, and neither ever falls back to the routed agent's todos.
  const todoSection =
    agentState !== undefined && loaded
      ? <AgentTodoSection todos={todos.map((todo, index) => ({ ...todo, id: `${agentId}:${index}` }))} />
      : agentState !== undefined && node !== undefined
        ? <p role="status" data-agent-todos-status="loading">{t('diagnostics.loading')}</p>
        : <p role="status" data-agent-todos-status="unknown" className="text-[11.5px] text-ink-faint">{t('diagnostics.unknown')}</p>;
  return <div data-agent-panel-container className="space-y-3">
    <AgentIdentitySection identity={{
      id: agentId, profile: profileName,
      label: node?.label ?? agentId, model: profile?.model ?? agentState?.model,
      thinkingEffort: profile?.thinking_effort,
      status: node?.status ?? 'unknown', summary: profile?.description,
      description: profile?.description, source: profile?.source, sourceFile: profile?.source_file,
      context: data?.context ?? 'live', isMain: agentId === MAIN_AGENT_ID,
      configContentPreview: profile === undefined ? undefined : JSON.stringify(profile, null, 2),
      rawProfile: profile,
    }} usage={usage} treeMetrics={agentId === MAIN_AGENT_ID ? {
      ...tree,
      cacheHitRate: aggregateTreeCacheHitRate(ids, metrics),
      cacheReadTokens: aggregateTreeCacheReadTokens(ids, metrics),
      cacheWriteTokens: aggregateTreeCacheWriteTokens(ids, metrics),
      activeSubagentsCount: Object.values(forest.byId).filter((entry) => entry.agentId !== MAIN_AGENT_ID && entry.busy).length,
      totalSubagentsCount: ids.filter((id) => id !== MAIN_AGENT_ID).length,
    } : undefined} onOpenUsageDetail={() => { void navigate(usageSessionDeepLink(state.sessionId)); }} />
    {capabilities.isPending ? <p role="status">{t('diagnostics.loading')}</p> : null}
    {capabilities.isError ? <div role="alert" className="text-danger text-xs">
      {t('diagnostics.error')} · {capabilities.error.message}
      <button type="button" onClick={() => { void capabilities.refetch(); }}>{t('common.retry')}</button>
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
      <p role="status" className="text-xs text-ink-soft">{data.unavailable_reason ?? t('diagnostics.unknown')}</p> : null}
    {data?.tools !== undefined && data.skills !== undefined ? <AgentCapabilitiesSection
      tools={(data.tools ?? []).map((tool) => ({
        ...tool,
        unavailableReason: tool.unavailable_reason,
        parametersSchema: tool.parameters ? JSON.stringify(tool.parameters, null, 2) : undefined,
        readOnly: tool.read_only,
      }))}
      skills={(data.skills ?? []).map((skill) => ({
        ...skill,
        id: `${skill.source}:${skill.path}`,
        unavailableReason: skill.unavailable_reason,
        argumentHint: skill.argument_hint,
        type: skill.type,
        disableModelInvocation: skill.disable_model_invocation,
        promptCommand: skill.prompt_command,
      }))}
      subagentTargets={data.targets.map((target) => ({
        profile: target.profile, route: target.route, executor: target.executor,
        modelAlias: target.model_alias, thinkingEffort: target.thinking_effort,
        defaultsAvailable: target.defaults_available, launchAllowed: target.launch_allowed,
        launchUnavailableReason: target.launch_unavailable_reason ?? target.unavailable_reason,
        executionRestriction: target.execution_restriction,
      }))}
    /> : null}
  </div>;
}
