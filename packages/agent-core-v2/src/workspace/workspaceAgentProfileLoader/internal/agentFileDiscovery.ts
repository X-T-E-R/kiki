import type { DiscoverAgentFilesWarn } from '@kiki/agent-profiles/agentFileDiscovery';
import type { AgentFileDiscoveryResult, AgentFileRoot } from '@kiki/agent-profiles/agentFileTypes';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { discoverCachedAgentFiles } from '#/agent/profile/agentFileDiscoveryCache';

export type { DiscoverAgentFilesWarn };

export function discoverAgentFiles(
  fs: IHostFileSystem,
  roots: readonly AgentFileRoot[],
  warn?: DiscoverAgentFilesWarn,
  options?: { readonly includeRoutes?: boolean },
): Promise<AgentFileDiscoveryResult> {
  return discoverCachedAgentFiles(fs, roots, warn, options);
}
