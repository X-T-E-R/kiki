import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { AgentForest, SessionViewState } from '@kiki/session-core/session';
import { sumAgentTreeMetrics, UNKNOWN_AGENT_PANEL_METRICS } from '@kiki/session-core/session/agentPanel';
import { useConnection } from '../state/connection';
import { useI18n } from '../i18n';
import { AgentIdentitySection } from './agent-panel/AgentIdentitySection';
import { AgentTodoSection } from './agent-panel/AgentTodoSection';
import { AgentPlanSection } from './agent-panel/AgentPlanSection';
import { AgentCapabilitiesSection } from './agent-panel/AgentCapabilitiesSection';
import { usageSessionDeepLink } from '../lib/usageV2';
import { aggregateTreeCacheHitRate, aggregateTreeCacheReadTokens, aggregateTreeCacheWriteTokens } from './agent-panel/cacheRate';

export function AgentPanelContainer({ state, forest, agentId }: {
  state: SessionViewState;
  forest: AgentForest;
  agentId: string;
}) {
  const { klient } = useConnection();
  const { t } = useI18n();
  const navigate = useNavigate();
  const query = { session_id: state.sessionId, agent_id: agentId };
  const active = state.busy || (agentId === 'main' && Object.values(forest.byId).some((node) => node.busy));
  const capabilities = useQuery({
    queryKey: ['agentCapabilities', query],
    queryFn: ({ signal }) => klient.global.agentPanel.read(query, { signal }),
    enabled: state.loaded && !state.resyncing,
    refetchInterval: (current) => active && current.state.data?.metrics?.[agentId] !== undefined ? 5_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: active,
    retry: false,
  });
  const refreshSignature = JSON.stringify([state.sessionId, agentId, active, state.profile, state.model, state.permissionMode, state.planMode]);
  const previousSignature = useRef(refreshSignature);
  useEffect(() => {
    if (previousSignature.current === refreshSignature) return;
    previousSignature.current = refreshSignature;
    if (state.loaded && !state.resyncing) void capabilities.refetch();
  }, [refreshSignature, state.loaded, state.resyncing, capabilities.refetch]);
  const data = capabilities.data;
  const profile = data?.profile;
  const node = forest.byId[agentId];
  const metrics = data?.metrics ?? {};
  const usage = metrics[agentId] ?? UNKNOWN_AGENT_PANEL_METRICS;
  const ids = [...new Set(['main', ...Object.keys(forest.byId), ...Object.keys(metrics)])];
  const tree = sumAgentTreeMetrics(ids, metrics);
  const todos = state.todos.filter((todo): todo is typeof todo & { status: 'pending' | 'in_progress' | 'done' } =>
    todo.status === 'pending' || todo.status === 'in_progress' || todo.status === 'done');
  const profileName = profile?.name === 'unknown' ? t('diagnostics.unknown') : (profile?.name ?? state.profile ?? t('diagnostics.unknown'));
  return <div data-agent-panel-container className="space-y-3">
    <AgentIdentitySection identity={{
      id: agentId, profile: profileName,
      label: node?.label ?? agentId, model: profile?.model ?? state.model,
      thinkingEffort: profile?.thinking_effort,
      status: node?.status ?? 'unknown', summary: profile?.description,
      description: profile?.description, source: profile?.source, sourceFile: profile?.source_file,
      context: data?.context ?? 'live', isMain: agentId === 'main',
      configContentPreview: profile === undefined ? undefined : JSON.stringify(profile, null, 2),
      rawProfile: profile,
    }} usage={usage} treeMetrics={agentId === 'main' ? {
      ...tree,
      cacheHitRate: aggregateTreeCacheHitRate(ids, metrics),
      cacheReadTokens: aggregateTreeCacheReadTokens(ids, metrics),
      cacheWriteTokens: aggregateTreeCacheWriteTokens(ids, metrics),
      activeSubagentsCount: Object.values(forest.byId).filter((entry) => entry.agentId !== 'main' && entry.busy).length,
      totalSubagentsCount: ids.filter((id) => id !== 'main').length,
    } : undefined} onOpenUsageDetail={() => { void navigate(usageSessionDeepLink(state.sessionId)); }} />
    {capabilities.isPending ? <p role="status">{t('diagnostics.loading')}</p> : null}
    {capabilities.isError ? <div role="alert" className="text-danger text-xs">
      {t('diagnostics.error')} · {capabilities.error.message}
      <button type="button" onClick={() => { void capabilities.refetch(); }}>{t('common.retry')}</button>
    </div> : null}
    {state.loaded ? <AgentTodoSection todos={todos.map((todo, index) => ({ ...todo, id: `${agentId}:${index}` }))} />
      : <p role="status">{t('diagnostics.loading')}</p>}
    {state.loaded ? <AgentPlanSection
      key={`${state.sessionId}:${agentId}`}
      sessionId={state.sessionId}
      agentId={agentId}
      loaded={state.loaded}
      resyncing={state.resyncing}
      planMode={state.planMode}
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
