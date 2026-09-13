import { Service } from '#/_base/di/service';
import { IInstantiationService } from '#/_base/di/instantiation';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { SwarmInjection } from './injection/swarmInjection';
import { IAgentSwarmService, type SwarmModeTrigger } from './swarm';
import { SwarmModeEnter, SwarmModeExit, swarmKey } from '../swarmOps';

export class AgentSwarmService extends Service implements IAgentSwarmService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IInstantiationService instantiation: IInstantiationService,
    @IEventBus eventBus: IEventBus,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentStateService private readonly agentState: IAgentStateService,
  ) {
    super();
    this.agentState.contributeState(swarmKey);
    this._register(instantiation.createInstance(SwarmInjection, {
      getTrigger: () => this.agentState.get(swarmKey),
    }));
    this._register(eventBus.subscribe(TurnEnded, () => {
      const trigger = this.agentState.get(swarmKey);
      if (trigger === 'task' || trigger === 'tool') this.exit();
    }));
  }

  enter(trigger: SwarmModeTrigger): void {
    if (this.agentState.get(swarmKey) !== null) return;
    void this.dispatcher.dispatch(new SwarmModeEnter({ trigger }));
  }

  exit(): void {
    if (this.agentState.get(swarmKey) === null) return;
    const history = this.context.get();
    void this.dispatcher.dispatch(new SwarmModeExit({}));
    this.context.publishTrailingRemoval(history);
  }

  get isActive(): boolean {
    return this.agentState.get(swarmKey) !== null;
  }
}
