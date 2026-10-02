import { createDecorator } from '#/_base/di/instantiation';

export interface IAgentHookRules {
  readonly _serviceBrand: undefined;
  inspect(): Promise<unknown>;
}
export const IAgentHookRules = createDecorator<IAgentHookRules>('agentHookRules');
