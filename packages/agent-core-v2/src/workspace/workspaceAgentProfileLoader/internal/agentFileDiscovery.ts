import {
  discoverAgentFiles as discoverProfiles,
  type DiscoverAgentFilesWarn,
} from '@kiki/agent-profiles/agentFileDiscovery';
import type { AgentFileDiscoveryResult, AgentFileRoot } from '@kiki/agent-profiles/agentFileTypes';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { agentProfilesHostFs } from './hostFs';

export type { DiscoverAgentFilesWarn };

export function discoverAgentFiles(
  fs: IHostFileSystem,
  roots: readonly AgentFileRoot[],
  warn?: DiscoverAgentFilesWarn,
  options?: { readonly includeRoutes?: boolean },
): Promise<AgentFileDiscoveryResult> {
  return discoverProfiles(agentProfilesHostFs(fs), roots, warn, options);
}
