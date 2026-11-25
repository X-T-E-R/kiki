import { randomUUID } from 'node:crypto';

import { ref, type LiveRef } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';
import { isPromiseLike } from '#/_base/lifecycle/disposer';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { abortable } from '#/_base/utils/abort';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import type {
  ExecutableTool,
  ExecutableToolContext,
  ExecutableToolResult,
} from '#/tool/toolContract';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';

import {
  IAgentUserToolService,
  ISessionDeclaredUserTools,
  type UserToolRegistration,
} from './userTool';
import {
  ToolsRegisterUserTool,
  ToolsUnregisterUserTool,
  userToolKey,
} from './userToolOps';

interface UserToolExecutionRequest {
  readonly turnId?: number;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
}

export class AgentUserToolService extends Service implements IAgentUserToolService {
  declare readonly _serviceBrand: undefined;

  private readonly registrations = new Map<string, IDisposable>();
  private readonly declaredByName = new Map<string, UserToolRegistration>();

  constructor(
    @IAgentToolRegistryService private readonly registry: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @ISessionInteractionService private readonly interaction: ISessionInteractionService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IAgentScopeContext private readonly agentContext: IAgentScopeContext,
    @ref(ISessionDeclaredUserTools) declaredUserTools?: LiveRef<readonly UserToolRegistration[]>,
  ) {
    super();
    this.agentState.contributeState(userToolKey);
    const declared = declaredUserTools?.current ?? [];
    for (const tool of declared) {
      if (this.agentContext.agentId !== MAIN_AGENT_ID && tool.inherit !== true) continue;
      this.declaredByName.set(tool.name, tool);
      this.applyRegister(tool);
    }
    this._register(
      this.dispatcher.hooks.onDidRestore.register('user-tool', async (_ctx, next) => {
        this.restoreRegisteredTools();
        await next();
      }),
    );
  }

  list(): readonly UserToolRegistration[] {
    const merged = new Map<string, UserToolRegistration>(this.declaredByName);
    for (const [name, registration] of this.agentState.get(userToolKey)) {
      merged.set(name, registration);
    }
    return [...merged.values()];
  }

  inheritUserTools(parent: IAgentUserToolService): void {
    for (const registration of parent.list()) {
      if (registration.inherit === false) continue;
      this.register(registration);
    }
  }

  register(input: UserToolRegistration): void {
    void this.dispatcher.dispatch(new ToolsRegisterUserTool(input));
    this.applyRegister(input);
  }

  unregister(name: string): void {
    void this.dispatcher.dispatch(new ToolsUnregisterUserTool({ name }));
    this.applyUnregister(name);
  }

  private restoreRegisteredTools(): void {
    const persistedActive = this.profile.getActiveToolNames();
    const durableMap = this.agentState.get(userToolKey);
    for (const registration of this.declaredByName.values()) {
      if (durableMap.has(registration.name)) continue;
      const activate =
        persistedActive === undefined || persistedActive.includes(registration.name);
      this.applyRegister(registration, { activate });
    }
    for (const registration of durableMap.values()) {
      const activate =
        persistedActive === undefined || persistedActive.includes(registration.name);
      this.applyRegister(registration, { activate });
    }
  }

  private applyRegister(input: UserToolRegistration, options?: { readonly activate?: boolean }): void {
    const { name, description, parameters } = input;
    this.applyUnregister(name);
    const tool: ExecutableTool = {
      name,
      foregroundPolicy: 'steerable_wait',
      description,
      parameters,
      resolveExecution: (args) => ({
        approvalRule: name,
        execute: (context) => this.executeUserTool(context, name, args),
      }),
    };
    this.registrations.set(
      name,
      this._register(
        this.registry.register(tool, { source: 'user', disclosure: input.disclosure }),
      ),
    );
    if (options?.activate === false) return;
    this.profile.addActiveTool(name);
  }

  private applyUnregister(name: string): void {
    const registration = this.registrations.get(name);
    if (registration === undefined) return;
    const result = registration.dispose();
    if (isPromiseLike(result)) result.catch(onUnexpectedError);
    this.registrations.delete(name);
    this.profile.removeActiveTool(name);
  }

  private async executeUserTool(
    context: ExecutableToolContext,
    name: string,
    args: unknown,
  ): Promise<ExecutableToolResult> {
    const id = `user_tool_${randomUUID()}`;
    const request = this.interaction.request<UserToolExecutionRequest, ExecutableToolResult>({
      id,
      kind: 'user_tool',
      payload: {
        turnId: context.turnId,
        toolCallId: context.toolCallId,
        name,
        args,
      },
      origin: {
        agentId: this.agentContext.agentId,
        turnId: context.turnId,
      },
    });
    const waitSignal = context.steerSignal === undefined
      ? context.signal
      : AbortSignal.any([context.signal, context.steerSignal]);
    try {
      return await abortable(request, waitSignal);
    } catch (error) {
      if (context.signal.aborted) {
        this.interaction.respond(id, {
          output: `User tool "${name}" was aborted.`,
          isError: true,
        });
        throw error;
      }
      if (context.steerSignal?.aborted === true) {
        const message = `New input arrived while waiting for user tool "${name}" to respond. Read the new input before deciding whether to continue.`;
        this.interaction.respond(id, {
          output: message,
          isError: false,
        });
        return {
          output: message,
          isError: false,
        };
      }
      throw error;
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentUserToolService,
  AgentUserToolService,
  ScopeActivation.OnScopeCreated,
  'userTool',
);
