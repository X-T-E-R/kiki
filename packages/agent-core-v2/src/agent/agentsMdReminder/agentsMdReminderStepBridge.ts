import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';

import { IAgentAgentsMdReminderService } from './agentsMdReminder';

export interface IAgentAgentsMdReminderStepBridge {
  readonly _serviceBrand: undefined;
}

export const IAgentAgentsMdReminderStepBridge: ServiceIdentifier<IAgentAgentsMdReminderStepBridge> =
  createDecorator<IAgentAgentsMdReminderStepBridge>('agentAgentsMdReminderStepBridge');

export class AgentAgentsMdReminderStepBridge
  extends Disposable
  implements IAgentAgentsMdReminderStepBridge
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentAgentsMdReminderService reminder: IAgentAgentsMdReminderService,
  ) {
    super();
    this._register(
      injector.register('agents_md', async () => {
        await reminder.flushStepHead();
        return undefined;
      }),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentAgentsMdReminderStepBridge,
  AgentAgentsMdReminderStepBridge,
  ScopeActivation.OnScopeCreated,
  'agentsMdReminder',
);
