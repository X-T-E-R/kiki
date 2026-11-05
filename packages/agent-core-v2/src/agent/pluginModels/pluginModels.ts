import { pluginModelRequestSchema, type PluginModelRequest, type PluginModelEvent, type PluginModelsApi } from '@kiki/protocol';
import { createDecorator } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IConfigService } from '#/app/config/config';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IRequestIdentityCatalog } from '#/app/requestIdentity/requestIdentityCatalog';
import { pluginModelCatalog } from '#/app/plugin/pluginModelCatalog';
import { REQUEST_IDENTITY_SECTION } from '#/app/kosongConfig/configSection';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { IProviderService } from '#/kosong/provider/provider';
import { getProviderDefinition } from '#/kosong/provider/providerDefinition';
import { defaultOAuthRequestIdentity, type RequestIdentityPolicy } from '#/kosong/requestIdentity/requestIdentityPolicy';
import { projectRequestIdentity } from '#/kosong/requestIdentity/requestIdentityProjector';
import { IRequestIdentityRegistry } from '#/session/requestIdentity/requestIdentityRegistry';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentUsageService } from '#/agent/usage/usage';
import { requestModelWithRetry } from '#/agent/stepRetry/modelRequestRetry';
import { RETRY_SECTION, type RetryConfig } from '#/agent/stepRetry/configSection';
import type { ModelRequester, ModelRequestInput, ModelRequestParams, ModelRequestEvent } from '#/kosong/model/modelRequester';
import { emptyUsage, type TokenUsage } from '#/kosong/contract/usage';

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
    @IConfigService private readonly config: IConfigService,
    @IRequestIdentityCatalog private readonly identityCatalog: IRequestIdentityCatalog,
    @IRequestIdentityRegistry private readonly identities: IRequestIdentityRegistry,
    @IAgentIdentity private readonly identity: IAgentIdentity,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionContext private readonly session: ISessionContext,
    @IAgentScopeContext private readonly agent: IAgentScopeContext,
    @IAgentUsageService private readonly usage: IAgentUsageService,
  ) {}

  api(pluginId: string, signal: AbortSignal): PluginModelsApi {
    return {
      list: () => pluginModelCatalog(this.catalog),
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

  async *request(requester: ModelRequester, input: ModelRequestInput, signal: AbortSignal, params: ModelRequestParams, purpose: string): AsyncGenerator<ModelRequestEvent> {
    signal.throwIfAborted();
    await this.identityCatalog.ready;
    const model = requester.model;
    const provider = this.providers.get(model.providerName);
    const record = this.models.get(this.models.resolveId(model.id) ?? model.id);
    const policy = this.identityCatalog.resolveLayers(defaultOAuthRequestIdentity(provider), this.config.get<RequestIdentityPolicy | undefined>(REQUEST_IDENTITY_SECTION), provider?.requestIdentity, record?.requestIdentity);
    const logicalRequestId = crypto.randomUUID();
    const snapshot = await this.identities.snapshot({ agentId: this.agent.agentId, parentAgentId: this.agent.parentAgentId, turnKey: `${purpose}:${logicalRequestId}`, compactionWindow: 0, logicalIdKind: policy.lineage.format === 'codex' ? 'uuidv7' : 'uuidv4' });
    const kimi = model.providerType !== undefined && getProviderDefinition(model.providerType)?.requestIdentityDeviceHeaders === true;
    const host = this.identity.current();
    const projection = projectRequestIdentity({ policy, protocol: model.protocol, model: model.name,
      rawSessionId: this.session.sessionId, rawAgentId: this.agent.agentId, parentAgentId: this.agent.parentAgentId,
      subagentKind: this.agent.parentAgentId === undefined ? undefined : 'agent', isKimiProvider: kimi, snapshot,
      runtimeVersion: this.bootstrap.clientIdentity.version, platform: this.bootstrap.platform, arch: this.bootstrap.arch,
      hostRequestHeaders: kimi ? host.upstreamRequestHeaders : host.requestHeaders, profile: this.identityCatalog.render(policy, model.name),
    });
    let attempted = false;
    let usage: TokenUsage | undefined;
    const recordUsage = () => {
      if (!attempted) return;
      this.usage.record(model.name, usage ?? emptyUsage(), { type: 'operation', requestKind: purpose }, {
        provider: model.providerName, modelAlias: model.id, executorId: 'native', usageKnown: usage !== undefined,
      });
      usage = undefined;
      attempted = false;
    };
    const requestParams = {
      ...params, headers: projection.headers, requestIdentity: projection.wire,
      cacheKey: params.cacheKey ?? projection.cacheKey, requestParams: { ...params.requestParams, ...projection.params },
      onRequestAttempt: () => { attempted = true; params.onRequestAttempt?.(); },
      attribution: { logicalRequestId, sessionId: this.session.sessionId, agentId: this.agent.agentId, parentAgentId: this.agent.parentAgentId, purpose, waitBudget: { waitedMs: 0 } },
    };
    try {
      for await (const event of requestModelWithRetry(requester, input, signal, requestParams, () => this.config.get<RetryConfig | undefined>(RETRY_SECTION))) {
        if (event.type === 'usage') { usage = event.usage; attempted = true; }
        if (event.type === 'attempt.discarded') recordUsage();
        yield event;
      }
    } finally { recordUsage(); }
  }
}

registerScopedService(LifecycleScope.Agent, IAgentPluginModels, AgentPluginModels, ScopeActivation.OnDemand, 'pluginModels');
