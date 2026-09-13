import type { Scope, ScopeSeed } from '@kiki/agent-core-v2';
import { ITaskBoardService } from '@kiki/agent-core-v2/app/taskBoard/taskBoard';
import { IAgentPanelService, RPCError } from '@kiki/klient/host';
import { agentCapabilities } from '../../routes/agentProfileCapabilities';
import { ErrorCode } from '../../protocol/error-codes';
import { createTaskBoardHost } from '../../services/taskBoardHost';
import '../../services/taskBoardTools';

export function panelBoardSeeds(getCore: () => Scope): ScopeSeed {
  const panel: IAgentPanelService = {
    _serviceBrand: undefined,
    async read(query) {
      const result = await agentCapabilities(getCore(), query);
      if (result === 'workspace-not-found') throw new RPCError(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace does not exist');
      if (result === 'profile-not-found') throw new RPCError(ErrorCode.AGENT_PROFILE_NOT_FOUND, 'Main profile is unavailable');
      return result;
    },
  };
  return [[IAgentPanelService, panel], [ITaskBoardService, createTaskBoardHost(getCore)]];
}
