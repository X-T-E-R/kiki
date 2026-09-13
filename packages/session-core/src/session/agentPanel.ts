import type { AgentPanelMetrics } from '@kiki/protocol';

export const UNKNOWN_AGENT_PANEL_METRICS: AgentPanelMetrics = Object.freeze({
  inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
  totalTokens: null, totalCostUsd: null, contextTokens: null, contextLimit: null,
  compactionCount: null,
});

export function sumAgentTreeMetrics(
  agentIds: readonly string[],
  metrics: Readonly<Record<string, AgentPanelMetrics>>,
): { totalTokens: number | null; totalCostUsd: number | null } {
  const ids = [...new Set(agentIds)];
  const sum = (field: 'totalTokens' | 'totalCostUsd'): number | null => {
    if (ids.length === 0) return null;
    let result = 0;
    let known = false;
    for (const id of ids) {
      const value = metrics[id]?.[field];
      if (value === null || value === undefined || !Number.isFinite(value) || value < 0) continue;
      known = true;
      result += value;
    }
    return known ? result : null;
  };
  return { totalTokens: sum('totalTokens'), totalCostUsd: sum('totalCostUsd') };
}
