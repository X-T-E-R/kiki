/**
 * Subagent wire projection — shared display-name and persisted-label resolution.
 */

import type { AgentMeta } from '@moonshot-ai/agent-core-v2';

export function resolveSubagentDisplayName(
  userLabel: string | undefined,
  spawnedName: string | undefined,
  agentId: string,
): string {
  return firstNonEmpty(userLabel, spawnedName, agentId) ?? agentId;
}

export function subagentUserLabel(meta: AgentMeta | undefined): string | undefined {
  return firstNonEmpty(
    meta?.userLabel,
    meta?.labels?.['swarmItem'],
    meta?.swarmItem,
    meta?.labels?.['collaborationTaskName'],
  );
}

export function subagentParentAgentId(meta: AgentMeta | undefined): string | undefined {
  if (meta?.delegator !== undefined) {
    return meta.delegator.kind === 'agent' ? meta.delegator.agentId : undefined;
  }
  return firstNonEmpty(meta?.labels?.['parentAgentId'], meta?.parentAgentId ?? undefined);
}

export function isPersistedSubagent(agentId: string, meta: AgentMeta | undefined): boolean {
  if (agentId === 'main' || meta === undefined) return false;
  return meta.type === 'sub' || subagentParentAgentId(meta) !== undefined;
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.length > 0);
}
