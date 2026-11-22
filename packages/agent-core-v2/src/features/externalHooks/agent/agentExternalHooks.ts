import { createDecorator } from '#/_base/di/instantiation';

export interface IAgentExternalHooksService {
  readonly _serviceBrand: undefined;
  consumeAutonomousStop(turnId: number): boolean;
}

export const IAgentExternalHooksService =
  createDecorator<IAgentExternalHooksService>('agentExternalHooksService');
