import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IAgentLoopService } from '#/agent/loop/loop';

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
    @IAgentLoopService loop: IAgentLoopService,
    @IAgentAgentsMdReminderService reminder: IAgentAgentsMdReminderService,
  ) {
    super();
    this._register(
      loop.hooks.onWillBeginStep.register('agentsMdReminder', async (_ctx, next) => {
        await reminder.flushStepHead();
        await next();
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
