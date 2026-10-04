import { createDecorator } from '#/_base/di/instantiation';
import type { AgentHooksInspect } from '@kiki/protocol';

export interface IAgentHookRules {
  readonly _serviceBrand: undefined;
  inspect(): Promise<AgentHooksInspect>;
}
export const IAgentHookRules = createDecorator<IAgentHookRules>('agentHookRules');
