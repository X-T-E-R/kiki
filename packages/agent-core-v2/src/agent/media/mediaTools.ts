import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentMediaToolsRegistrar {
  readonly _serviceBrand: undefined;
  refresh(): void;
}

export const IAgentMediaToolsRegistrar: ServiceIdentifier<IAgentMediaToolsRegistrar> =
  createDecorator<IAgentMediaToolsRegistrar>('agentMediaToolsRegistrar');
