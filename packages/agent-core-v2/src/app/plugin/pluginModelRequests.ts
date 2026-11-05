import { createDecorator } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IConfigService } from '#/app/config/config';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IRequestIdentityCatalog } from '#/app/requestIdentity/requestIdentityCatalog';
import { REQUEST_IDENTITY_SECTION } from '#/app/kosongConfig/configSection';
import { IModelService } from '#/kosong/model/model';
import { IProviderService } from '#/kosong/provider/provider';
import { getProviderDefinition } from '#/kosong/provider/providerDefinition';
import { defaultOAuthRequestIdentity, type RequestIdentityPolicy } from '#/kosong/requestIdentity/requestIdentityPolicy';
import { projectRequestIdentity } from '#/kosong/requestIdentity/requestIdentityProjector';
import type { RequestIdentitySnapshot } from '#/session/requestIdentity/requestIdentityRegistry';
import { requestModelWithRetry } from '#/agent/stepRetry/modelRequestRetry';
import { RETRY_SECTION, type RetryConfig } from '#/agent/stepRetry/configSection';
import type { ModelRequester, ModelRequestInput, ModelRequestParams, ModelRequestEvent } from '#/kosong/model/modelRequester';
import { emptyUsage, type TokenUsage } from '#/kosong/contract/usage';

export interface PluginModelRequestContext {
  readonly sessionId: string;
  readonly agentId: string;
  readonly parentAgentId?: string;
  snapshot(input: { readonly turnKey: string; readonly logicalIdKind: 'uuidv7' | 'uuidv4'; readonly turnIndex: boolean }): Promise<RequestIdentitySnapshot>;
  recordUsage(usage: TokenUsage, known: boolean): void | Promise<void>;
}

export interface IPluginModelRequests {
  readonly _serviceBrand: undefined;
  request(requester: ModelRequester, input: ModelRequestInput, signal: AbortSignal, params: ModelRequestParams, purpose: string, context: PluginModelRequestContext): AsyncIterable<ModelRequestEvent>;
}
export const IPluginModelRequests = createDecorator<IPluginModelRequests>('pluginModelRequests');

export class PluginModelRequests implements IPluginModelRequests {
  declare readonly _serviceBrand: undefined;
  constructor(
    @IModelService private readonly models: IModelService,
    @IProviderService private readonly providers: IProviderService,
    @IConfigService private readonly config: IConfigService,
    @IRequestIdentityCatalog private readonly identities: IRequestIdentityCatalog,
    @IAgentIdentity private readonly identity: IAgentIdentity,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {}

  async *request(requester: ModelRequester, input: ModelRequestInput, signal: AbortSignal, params: ModelRequestParams, purpose: string, context: PluginModelRequestContext): AsyncGenerator<ModelRequestEvent> {
    signal.throwIfAborted();
    await this.identities.ready;
    const model = requester.model;
    const provider = this.providers.get(model.providerName);
    const record = this.models.get(this.models.resolveId(model.id) ?? model.id);
    const policy = this.identities.resolveLayers(defaultOAuthRequestIdentity(provider), this.config.get<RequestIdentityPolicy | undefined>(REQUEST_IDENTITY_SECTION), provider?.requestIdentity, record?.requestIdentity);
    const logicalRequestId = crypto.randomUUID();
    const snapshot = await context.snapshot({ turnKey: `${purpose}:${logicalRequestId}`, logicalIdKind: policy.lineage.format === 'codex' ? 'uuidv7' : 'uuidv4', turnIndex: policy.request.turnIndex === 'agent_session' });
    const kimi = model.providerType !== undefined && getProviderDefinition(model.providerType)?.requestIdentityDeviceHeaders === true;
    const host = this.identity.current();
    const projection = projectRequestIdentity({ policy, protocol: model.protocol, model: model.name,
      rawSessionId: context.sessionId, rawAgentId: context.agentId, parentAgentId: context.parentAgentId,
      subagentKind: context.parentAgentId === undefined ? undefined : 'agent', isKimiProvider: kimi, snapshot,
      runtimeVersion: this.bootstrap.clientIdentity.version, platform: this.bootstrap.platform, arch: this.bootstrap.arch,
      hostRequestHeaders: kimi ? host.upstreamRequestHeaders : host.requestHeaders, profile: this.identities.render(policy, model.name),
    });
    let attempted = false;
    let usage: TokenUsage | undefined;
    const recordUsage = async () => {
      if (!attempted) return;
      const recorded = usage;
      usage = undefined;
      attempted = false;
      await context.recordUsage(recorded ?? emptyUsage(), recorded !== undefined);
    };
    const requestParams = {
      ...params, headers: projection.headers, requestIdentity: projection.wire,
      cacheKey: params.cacheKey ?? projection.cacheKey, requestParams: { ...params.requestParams, ...projection.params },
      onRequestAttempt: () => { attempted = true; params.onRequestAttempt?.(); },
      attribution: { logicalRequestId, sessionId: context.sessionId, agentId: context.agentId, parentAgentId: context.parentAgentId, purpose, waitBudget: { waitedMs: 0 } },
    };
    try {
      for await (const event of requestModelWithRetry(requester, input, signal, requestParams, () => this.config.get<RetryConfig | undefined>(RETRY_SECTION))) {
        if (event.type === 'usage') { usage = event.usage; attempted = true; }
        if (event.type === 'attempt.discarded') await recordUsage();
        yield event;
      }
    } finally { await recordUsage(); }
  }
}

registerScopedService(LifecycleScope.App, IPluginModelRequests, PluginModelRequests, ScopeActivation.OnDemand, 'pluginModels');
