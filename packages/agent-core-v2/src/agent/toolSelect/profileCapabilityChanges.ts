import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentProfileCapabilityChangesService {
  readonly _serviceBrand: undefined;
}

export const IAgentProfileCapabilityChangesService: ServiceIdentifier<IAgentProfileCapabilityChangesService> =
  createDecorator<IAgentProfileCapabilityChangesService>('agentProfileCapabilityChangesService');
