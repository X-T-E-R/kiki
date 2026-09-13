import { ScopeActivation } from '#/_base/di/instantiation';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { IAgentSwarmService } from './agent/swarm';
import { AgentSwarmService } from './agent/swarmService';

export class SwarmFeature extends Feature {
  static override readonly name = 'swarm';

  constructor() {
    super();
    this.contributeAgentService(IAgentSwarmService, AgentSwarmService, {
      activation: ScopeActivation.OnScopeCreated,
    });
  }
}

registerFeature(SwarmFeature);
