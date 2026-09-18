import { createDecorator } from '#/_base/di/instantiation';
import type { ToolGroupId } from '@kiki/agent-profiles/toolGroups';

export interface IAgentToolActivationService {
  readonly _serviceBrand: undefined;

  activate(): Promise<void>;
  capabilities(): readonly {
    name: string;
    source: 'builtin' | 'user' | 'mcp';
    category: string;
    group?: ToolGroupId;
    runtimeAvailable: boolean;
    conditionAvailable: boolean;
  }[];
}

export const IAgentToolActivationService =
  createDecorator<IAgentToolActivationService>('agentToolActivationService');
