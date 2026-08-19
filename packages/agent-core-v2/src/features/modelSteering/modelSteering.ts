/**
 * `modelSteering` domain (L4) — `IAgentModelSteeringService` contract.
 *
 * Marker service for the per-model near-field steering injector
 * (`model_steering`). Bound at Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentModelSteeringService {
  readonly _serviceBrand: undefined;
}

export const IAgentModelSteeringService: ServiceIdentifier<IAgentModelSteeringService> =
  createDecorator<IAgentModelSteeringService>('agentModelSteeringService');
