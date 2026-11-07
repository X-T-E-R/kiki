import { pluginModelRequestSchema, type PluginModelRequest, type PluginModelEvent, type PluginModelsApi } from '@kiki/protocol';
import { createDecorator } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { pluginModelCatalog } from '#/app/plugin/pluginModelCatalog';
import { IPluginModelRequests } from '#/app/plugin/pluginModelRequests';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { IProviderService } from '#/kosong/provider/provider';
import { IRequestIdentityRegistry } from '#/session/requestIdentity/requestIdentityRegistry';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentUsageService } from '#/agent/usage/usage';
import type { ModelRequester, ModelRequestInput, ModelRequestParams, ModelRequestEvent } from '#/kosong/model/modelRequester';

export interface IAgentPluginModels {
  readonly _serviceBrand: undefined;
  api(pluginId: string, signal: AbortSignal): PluginModelsApi;
  request(requester: ModelRequester, input: ModelRequestInput, signal: AbortSignal, params: ModelRequestParams, purpose: string): AsyncIterable<ModelRequestEvent>;
}
export const IAgentPluginModels = createDecorator<IAgentPluginModels>('agentPluginModels');

export class AgentPluginModels implements IAgentPluginModels {
  declare readonly _serviceBrand: undefined;
  constructor(
    @IModelCatalog private readonly catalog: IModelCatalog,
    @IModelService private readonly models: IModelService,
    @IProviderService private readonly providers: IProviderService,
    @IPluginModelRequests private readonly requests: IPluginModelRequests,
    @IRequestIdentityRegistry private readonly identities: IRequestIdentityRegistry,
    @ISessionContext private readonly session: ISessionContext,
    @IAgentScopeContext private readonly agent: IAgentScopeContext,
    @IAgentUsageService private readonly usage: IAgentUsageService,
  ) {}

  api(pluginId: string, signal: AbortSignal): PluginModelsApi {
    return {
      list: (options) => pluginModelCatalog(this.catalog, options?.candidates),
      stream: (input, options) => this.stream(pluginId, input, options?.signal === undefined ? signal : AbortSignal.any([signal, options.signal])),
    };
  }

  private async *stream(pluginId: string, raw: PluginModelRequest, signal: AbortSignal): AsyncGenerator<PluginModelEvent> {
    const input = pluginModelRequestSchema.parse(raw);
    signal.throwIfAborted();
    await Promise.all([this.providers.ready, this.models.ready]);
    const target = input.target;
    const requester = 'connectionId' in target
      ? this.catalog.getConnectionRequester(target.connectionId, target.modelName, target.maxContextSize ?? 32768)
      : this.catalog.getRequester(target.modelId);
    yield { type: 'started', modelId: requester.model.id, connectionId: requester.model.providerName, modelName: requester.model.name };
    for await (const event of this.request(requester, {
      systemPrompt: input.systemPrompt ?? '', tools: [],
      messages: input.messages.map((message) => ({ role: message.role, content: [{ type: 'text', text: message.text }], toolCalls: [] })),
    }, signal, { maxCompletionTokens: input.maxOutputTokens, usedContextTokensTrusted: false }, `plugin:${pluginId}`)) {
      if (event.type === 'attempt.discarded') yield { type: 'reset' };
      if (event.type === 'part' && event.part.type === 'text') yield { type: 'delta', text: event.part.text };
      if (event.type === 'usage') yield { type: 'usage', usage: event.usage };
      if (event.type === 'finish') {
        const text = event.message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
        yield { type: 'completed', text, finishReason: event.providerFinishReason };
      }
    }
  }

  request(requester: ModelRequester, input: ModelRequestInput, signal: AbortSignal, params: ModelRequestParams, purpose: string): AsyncIterable<ModelRequestEvent> {
    return this.requests.request(requester, input, signal, params, purpose, {
      sessionId: this.session.sessionId, agentId: this.agent.agentId, parentAgentId: this.agent.parentAgentId,
      snapshot: ({ turnKey, logicalIdKind }) => this.identities.snapshot({ agentId: this.agent.agentId, parentAgentId: this.agent.parentAgentId, turnKey, compactionWindow: 0, logicalIdKind }),
      recordUsage: (usage, usageKnown) => { this.usage.record(requester.model.name, usage, { type: 'operation', requestKind: purpose }, {
        provider: requester.model.providerName, modelAlias: requester.model.id, executorId: 'native', usageKnown,
      }); },
    });
  }
}

registerScopedService(LifecycleScope.Agent, IAgentPluginModels, AgentPluginModels, ScopeActivation.OnDemand, 'pluginModels');
