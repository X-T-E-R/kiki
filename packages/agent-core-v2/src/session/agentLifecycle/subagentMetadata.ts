import type { AgentMeta, DelegatorRef } from '#/session/sessionMetadata/sessionMetadata';

const REQUEST_IDENTITY_PARENT_TURN_LABEL = 'requestIdentityParentTurn';
const REQUEST_IDENTITY_ROOT_AGENT_LABEL = 'requestIdentityRootAgent';
const REQUEST_IDENTITY_ROOT_TURN_LABEL = 'requestIdentityRootTurn';

/** `agentLifecycle` domain — persisted subagent relationship labels: the helpers that record and read
 *  the requester → subagent relationship without making the flat lifecycle registry interpret
 *  parentage itself. */
export function subagentLabels(
  parentAgentId: string,
  options: { readonly swarmItem?: string } = {},
): Readonly<Record<string, string>> {
  const labels: Record<string, string> = { parentAgentId };
  if (options.swarmItem !== undefined) {
    labels['swarmItem'] = options.swarmItem;
  }
  return labels;
}

export function withSubagentProfile(
  labels: Readonly<Record<string, string>> | undefined,
  profileName: string | undefined,
): Readonly<Record<string, string>> | undefined {
  if (profileName === undefined || profileName.length === 0) return labels;
  return { ...labels, profileName };
}

export function requestIdentitySpawnLabels(
  parentAgentId: string,
  parentTurnId: number,
  parentMeta: AgentMeta | undefined,
): Readonly<Record<string, string>> {
  return {
    [REQUEST_IDENTITY_PARENT_TURN_LABEL]: String(parentTurnId),
    [REQUEST_IDENTITY_ROOT_AGENT_LABEL]:
      parentMeta?.labels?.[REQUEST_IDENTITY_ROOT_AGENT_LABEL] ?? parentAgentId,
    [REQUEST_IDENTITY_ROOT_TURN_LABEL]:
      parentMeta?.labels?.[REQUEST_IDENTITY_ROOT_TURN_LABEL] ?? String(parentTurnId),
  };
}

export function requestIdentitySpawnContext(meta: AgentMeta | undefined): {
  readonly parentTurnKey?: string;
  readonly rootAgentId?: string;
  readonly rootTurnKey?: string;
} {
  const parentTurn = meta?.labels?.[REQUEST_IDENTITY_PARENT_TURN_LABEL];
  const rootAgentId = meta?.labels?.[REQUEST_IDENTITY_ROOT_AGENT_LABEL];
  const rootTurn = meta?.labels?.[REQUEST_IDENTITY_ROOT_TURN_LABEL];
  return {
    parentTurnKey: parentTurn === undefined ? undefined : `turn:${parentTurn}`,
    rootAgentId,
    rootTurnKey: rootTurn === undefined ? undefined : `turn:${rootTurn}`,
  };
}

export function delegatorRef(meta: AgentMeta | undefined): DelegatorRef | undefined {
  if (meta?.delegator !== undefined) return meta.delegator;
  const agentId = firstNonEmpty(meta?.labels?.['parentAgentId'], meta?.parentAgentId ?? undefined);
  return agentId === undefined ? undefined : { kind: 'agent', agentId };
}

export function labelsFromAgentMeta(
  meta: AgentMeta,
): Readonly<Record<string, string>> | undefined {
  const labels: Record<string, string> = { ...meta.labels };
  const parentAgentId = subagentParentAgentId(meta);
  if (parentAgentId !== undefined) {
    labels['parentAgentId'] = parentAgentId;
  }
  const swarmItem = subagentSwarmItem(meta);
  if (swarmItem !== undefined) {
    labels['swarmItem'] = swarmItem;
  }
  return Object.keys(labels).length > 0 ? labels : undefined;
}

export function isSubagentMeta(meta: AgentMeta | undefined): boolean {
  if (meta === undefined) return false;
  if (subagentParentAgentId(meta) !== undefined) return true;
  return meta.type === 'sub';
}

export function subagentParentAgentId(meta: AgentMeta | undefined): string | undefined {
  const ref = delegatorRef(meta);
  return ref?.kind === 'agent' ? ref.agentId : undefined;
}

export function subagentSwarmItem(meta: AgentMeta | undefined): string | undefined {
  if (meta === undefined) return undefined;
  return firstNonEmpty(meta.labels?.['swarmItem'], meta.swarmItem);
}

export function subagentProfileName(meta: AgentMeta | undefined): string | undefined {
  if (meta === undefined) return undefined;
  return firstNonEmpty(meta.labels?.['profileName'], meta.labels?.['collaborationAgentType']);
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.length > 0);
}
