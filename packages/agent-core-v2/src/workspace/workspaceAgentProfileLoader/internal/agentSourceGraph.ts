import {
  agentProfileDefinitionId,
  resolveAgentSourceGraph as resolveSourceGraph,
  type AgentSourceGraphResult,
} from '@kiki/agent-profiles/agentSourceGraph';
import type { AgentFileDefinition } from '@kiki/agent-profiles/agentFileTypes';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { agentProfilesHostFs } from './hostFs';

export { agentProfileDefinitionId, type AgentSourceGraphResult };

export function resolveAgentSourceGraph(
  fs: IHostFileSystem,
  parents: readonly AgentFileDefinition[],
  warn?: (message: string, error?: unknown) => void,
): Promise<AgentSourceGraphResult> {
  return resolveSourceGraph(agentProfilesHostFs(fs), parents, warn);
}
