/**
 * `agentCollaboration` domain — the caller's direct child agents.
 *
 * Reads the persisted relationship and name labels so every dispatch surface
 * resolves the same working set: a caller owns the children it delegated to,
 * whether they were started one at a time or as a swarm batch, and never
 * reaches a grandchild.
 */

import type { AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import {
  subagentParentAgentId,
  subagentSwarmItem,
} from '#/session/agentLifecycle/subagentMetadata';

import {
  COLLABORATION_AGENT_TYPE_LABEL,
  COLLABORATION_LATEST_TASK_LABEL,
  COLLABORATION_TASK_NAME_LABEL,
} from './registry';

export const AGENT_NAME_PATTERN = /^[a-z0-9_]+$/u;
export const RESERVED_AGENT_NAME = 'root';

export interface DirectChildAgent {
  readonly agentId: string;
  readonly name?: string;
  readonly profileName?: string;
  readonly latestTaskId?: string;
  readonly swarmItem?: string;
  readonly meta: AgentMeta;
}

export function agentNameIssue(value: string): string | undefined {
  if (value === RESERVED_AGENT_NAME) return `"${RESERVED_AGENT_NAME}" is reserved`;
  if (!AGENT_NAME_PATTERN.test(value)) {
    return 'must match ^[a-z0-9_]+$';
  }
  return undefined;
}

export function directChildAgents(
  agents: Readonly<Record<string, AgentMeta>> | undefined,
  callerAgentId: string,
): DirectChildAgent[] {
  return Object.entries(agents ?? {})
    .flatMap(([agentId, meta]) => {
      if (subagentParentAgentId(meta) !== callerAgentId) return [];
      return [
        {
          agentId,
          name: meta.labels?.[COLLABORATION_TASK_NAME_LABEL],
          profileName: meta.labels?.[COLLABORATION_AGENT_TYPE_LABEL] ?? meta.displayName,
          latestTaskId: meta.labels?.[COLLABORATION_LATEST_TASK_LABEL],
          swarmItem: subagentSwarmItem(meta),
          meta,
        },
      ];
    })
    .sort(byNameThenId);
}

export function findDirectChild(
  children: readonly DirectChildAgent[],
  ref: string,
): DirectChildAgent | undefined {
  const matches = children.filter((child) => child.name === ref || child.agentId === ref);
  return matches.length === 1 ? matches[0] : undefined;
}

function byNameThenId(left: DirectChildAgent, right: DirectChildAgent): number {
  if (left.name !== undefined && right.name !== undefined) {
    return left.name.localeCompare(right.name);
  }
  if (left.name !== undefined) return -1;
  if (right.name !== undefined) return 1;
  return left.agentId.localeCompare(right.agentId);
}
