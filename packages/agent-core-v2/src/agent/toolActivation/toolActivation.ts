import { createDecorator } from '#/_base/di/instantiation';

export interface IAgentToolActivationService {
  readonly _serviceBrand: undefined;

  activate(): Promise<void>;
  capabilities(): readonly {
    name: string;
    source: 'builtin' | 'user' | 'mcp';
    category: string;
    runtimeAvailable: boolean;
    conditionAvailable: boolean;
  }[];
}

export const IAgentToolActivationService =
  createDecorator<IAgentToolActivationService>('agentToolActivationService');
