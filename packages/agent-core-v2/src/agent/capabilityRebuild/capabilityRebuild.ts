import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentCapabilityRebuildService {
  readonly _serviceBrand: undefined;
}

export const IAgentCapabilityRebuildService: ServiceIdentifier<IAgentCapabilityRebuildService> =
  createDecorator<IAgentCapabilityRebuildService>('agentCapabilityRebuildService');
