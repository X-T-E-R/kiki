import type { AgentActivityDimension, AgentActivityPhase, AgentActivitySnapshot, RequestGovernanceConfigPatch, RequestGovernanceSnapshot } from '@kiki/protocol';

export type ConcurrencyRule = RequestGovernanceSnapshot['rules'][number];
export type ConcurrencyResource = ConcurrencyRule['resource'];

export function concurrencyRulesPatch(rules: readonly ConcurrencyRule[]): RequestGovernanceConfigPatch {
  return { rules: rules.map((rule) => ({
    id: rule.id, resource: rule.resource, scope: rule.scope, models: rule.models, providers: rule.providers,
    executors: rule.executors, profiles: rule.profiles, roles: rule.roles,
    subagents_only: rule.subagentsOnly, max_concurrent: rule.maxConcurrent,
    overflow: rule.overflow, max_wait_ms: rule.maxWaitMs, enabled: rule.enabled,
  })) };
}

/** Replace one resource's rules without deleting the other view's rules. */
export function replaceConcurrencyResourceRules(current: readonly ConcurrencyRule[], resource: ConcurrencyResource, replacement: readonly ConcurrencyRule[]): ConcurrencyRule[] {
  if (replacement.some((rule) => rule.resource !== resource)) throw new Error('Rule resource does not match the selected view.');
  const preserved = current.filter((rule) => rule.resource !== resource);
  const ids = new Set(preserved.map((rule) => rule.id));
  for (const rule of replacement) {
    if (ids.has(rule.id)) throw new Error(`Rule ID already exists: ${rule.id}`);
    ids.add(rule.id);
  }
  return [...preserved, ...replacement];
}

export function agentActivityRows(snapshot: AgentActivitySnapshot, dimension: AgentActivityDimension): AgentActivitySnapshot['dimensions'] {
  return snapshot.dimensions.filter((row) => row.dimension === dimension).sort((a, b) => b.active - a.active || b.queued - a.queued || (a.id ?? '').localeCompare(b.id ?? ''));
}

export const agentActivityStatusLabels: Readonly<Record<AgentActivityPhase, { readonly en: string; readonly zh: string }>> = {
  starting: { en: 'Starting', zh: '启动中' },
  running: { en: 'Running', zh: '运行中' },
  tool_waiting: { en: 'Tool execution / waiting', zh: '工具执行／等待' },
  suspended: { en: 'Awaiting approval', zh: '等待审批' },
  cancelling: { en: 'Cancelling', zh: '取消中' },
  finalizing: { en: 'Finalizing', zh: '收尾中' },
};
