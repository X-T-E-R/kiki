import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentStateService } from '#/agent/state/agentState';
import { ContextAppendMessage } from '#/agent/contextMemory/contextEvents';
import { LifecycleScope } from '#/app/scopes';
import { defineState } from '#/state/state';
import { AgentMessageDelivered } from './messageEvents';

export const agentMessageReceiptsKey = defineState('agentCollaboration.messageReceipts', (): Record<string, true> => ({}))
  .replayable({ schema: z.record(z.string(), z.literal(true)) })
  .on(AgentMessageDelivered, (state, event) => { state[event.messageId] = true; });

export const agentMessageMaterializationsKey = defineState('agentCollaboration.materializedMessages', (): Record<string, true> => ({}))
  .replayable({ schema: z.record(z.string(), z.literal(true)) })
  .on(ContextAppendMessage, (state, event) => {
    if (event.message.origin?.kind === 'agent_message') state[event.message.origin.messageId] = true;
  });

interface IAgentMessageReceiptState {
  readonly _serviceBrand: undefined;
}

const IAgentMessageReceiptState = createDecorator<IAgentMessageReceiptState>('agentMessageReceiptState');

class AgentMessageReceiptState extends Service implements IAgentMessageReceiptState {
  declare readonly _serviceBrand: undefined;

  constructor(@IAgentStateService states: IAgentStateService) {
    super();
    this._register(states.contributeState(agentMessageReceiptsKey));
    this._register(states.contributeState(agentMessageMaterializationsKey));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentMessageReceiptState,
  AgentMessageReceiptState,
  ScopeActivation.OnScopeCreated,
  'messageReceiptState',
);
