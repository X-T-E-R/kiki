import { ScopeActivation } from '#/_base/di/instantiation';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { IAgentModelSteeringService } from './modelSteering';
import { AgentModelSteeringService } from './modelSteeringService';

export class ModelSteeringFeature extends Feature {
  static override readonly name = 'modelSteering';

  constructor() {
    super();
    this.contributeAgentService(IAgentModelSteeringService, AgentModelSteeringService, {
      activation: ScopeActivation.OnScopeCreated,
    });
  }
}

registerFeature(ModelSteeringFeature);
