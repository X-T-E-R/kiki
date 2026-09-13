import { createDecorator } from '@kiki/agent-core-v2/_base/di/instantiation';
import type { AgentCapabilitiesQuery, AgentCapabilitiesResponse } from '@kiki/protocol';

/** Host projection of the whitelisted agent panel; not an engine service locator. */
export interface IAgentPanelService {
  readonly _serviceBrand: undefined;
  read(query: AgentCapabilitiesQuery): Promise<AgentCapabilitiesResponse>;
}
export const IAgentPanelService = createDecorator<IAgentPanelService>('agentPanelService');
