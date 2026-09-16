import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

/** `modelSteering` domain (L4) — `IAgentModelSteeringService` contract (Agent scope): marker service
 *  for the per-model near-field steering injector (`model_steering`). */
export interface IAgentModelSteeringService {
  readonly _serviceBrand: undefined;
}

export const IAgentModelSteeringService: ServiceIdentifier<IAgentModelSteeringService> =
  createDecorator<IAgentModelSteeringService>('agentModelSteeringService');
