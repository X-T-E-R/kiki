import { randomUUID } from 'node:crypto';

import { LifecycleScope } from '#/app/scopes';
import { IInstantiationService, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IEventService } from '#/app/event/event';
import { ErrorCodes, Error2 } from '#/errors';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { expandCommandArguments } from '#/app/plugin/commands';
import { IPluginService } from '#/app/plugin/plugin';
import { ISessionPluginUsageService } from '#/session/pluginUsage/sessionPluginUsageService';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { promptMetadataTextFromText } from '#/agent/prompt/promptMetadataText';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { applyPromptMetadataUpdate } from '#/session/sessionMetadata/promptMetadata';
import { IEventDispatcher } from '#/state/eventDispatcher';

import {
  IAgentPluginCommandService,
  PluginCommandActivated,
  type ActivatePluginCommandPayload,
} from './pluginCommand';

export class AgentPluginCommandService implements IAgentPluginCommandService {
  declare readonly _serviceBrand: undefined;
  private readonly sessionPluginUsage?: ISessionPluginUsageService;

  constructor(
    @IPluginService private readonly plugins: IPluginService,
    @IAgentPromptService private readonly promptService: IAgentPromptService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    this.sessionPluginUsage = optionalService(instantiation, ISessionPluginUsageService);
  }

  async activate(payload: ActivatePluginCommandPayload): Promise<void> {
    const available = await this.plugins.listPluginCommands('*');
    let def = available.find(
      (command) => command.pluginId === payload.pluginId && command.name === payload.commandName,
    );
    if (def === undefined) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        `Plugin command "${payload.pluginId}:${payload.commandName}" was not found`,
      );
    }
    if (this.sessionPluginUsage !== undefined) {
      await this.sessionPluginUsage.set(payload.pluginId, 'on');
      def = (await this.plugins.listPluginCommands(
        this.sessionContext.workspaceId,
        this.sessionContext.sessionId,
      )).find((command) => command.pluginId === payload.pluginId && command.name === payload.commandName);
      if (def === undefined) {
        throw new Error2(
          ErrorCodes.REQUEST_INVALID,
          `Plugin command "${payload.pluginId}:${payload.commandName}" is not available in this session`,
        );
      }
    }
    const commandArgs = payload.args ?? '';
    const expanded = expandCommandArguments(def.body, commandArgs);
    const origin = {
      kind: 'plugin_command' as const,
      activationId: randomUUID(),
      pluginId: payload.pluginId,
      commandName: payload.commandName,
      commandArgs: payload.args,
      trigger: 'user-slash' as const,
    };
    await this.dispatcher.dispatch(
      new PluginCommandActivated({
        activationId: origin.activationId,
        pluginId: origin.pluginId,
        commandName: origin.commandName,
        commandArgs: origin.commandArgs,
        trigger: origin.trigger,
      }),
    );
    await this.promptService.enqueue({ message: {
      role: 'user',
      content: [{ type: 'text', text: expanded }],
      toolCalls: [],
      origin,
    } });
    if (this.scopeContext.agentId === MAIN_AGENT_ID) {
      await applyPromptMetadataUpdate(
        {
          metadata: this.metadata,
          eventService: this.eventService,
          sessionId: this.sessionContext.sessionId,
        },
        promptMetadataTextFromPluginCommand(payload),
      );
    }
  }
}

function optionalService<T>(instantiation: IInstantiationService, id: ServiceIdentifier<T>): T | undefined {
  try {
    return instantiation.invokeFunction((accessor) => accessor.get(id));
  } catch {
    return undefined;
  }
}

function promptMetadataTextFromPluginCommand(
  payload: ActivatePluginCommandPayload,
): string | undefined {
  const args = payload.args?.trim();
  const command = `/${payload.pluginId}:${payload.commandName}`;
  return promptMetadataTextFromText(
    args === undefined || args.length === 0 ? command : `${command} ${args}`,
  );
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPluginCommandService,
  AgentPluginCommandService,
  ScopeActivation.OnScopeCreated,
  'pluginCommand',
);
