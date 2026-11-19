import type { Scope, ScopeSeed } from '@kiki/agent-core-v2';
import { IAgentPanelService, RPCError } from '@kiki/klient/host';
import { agentCapabilities } from '../../routes/agentProfileCapabilities';
import { ErrorCode } from '@kiki/protocol';

export function panelBoardSeeds(getCore: () => Scope): ScopeSeed {
  const panel: IAgentPanelService = {
    _serviceBrand: undefined,
    async read(query, signal) {
      const result = await agentCapabilities(getCore(), query, signal);
      if (result === 'workspace-not-found') throw new RPCError(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace does not exist');
      if (result === 'profile-not-found') throw new RPCError(ErrorCode.AGENT_PROFILE_NOT_FOUND, 'Main profile is unavailable');
      return result;
    },
  };
  return [[IAgentPanelService, panel]];
}
