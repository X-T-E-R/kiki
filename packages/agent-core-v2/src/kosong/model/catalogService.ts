import { parseKimiCodeCustomHeaders } from '@kiki/oauth';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2 } from '#/_base/errors/errors';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { ProviderRequestAuth } from '#/kosong/contract/provider';
import type { TokenUsage } from '#/kosong/contract/usage';
import {
  IProtocolAdapterRegistry,
  ProtocolSchema,
  type Protocol,
  type ProtocolProviderOptions,
} from '#/kosong/protocol/protocol';

import { CONFIG_INVALID_ERROR_CODE } from '#/kosong/contract/errors';
import {
  LATEST_OPUS_PROFILE,
  matchKnownAnthropicModelProfile,
  matchUnknownClaudeProfile,
} from '../provider/bases/anthropic/anthropic-profile';
import {
  IProviderService,
  type ProviderConfig,
} from '../provider/provider';
import {
  explainProviderEndpoint,
  getProviderDefinition,
  resolveProviderEndpoint,
} from '../provider/providerDefinition';

import {
  type AuthProvider,
  IModelCatalog,
  type Model,
  type ModelCatalogItem,
  type ModelPingResult,
  type ProviderCatalogItem,
  type ProviderCredentialState,
  type SetDefaultModelResponse,
  StaticAuthProvider,
  toProtocolModel,
  toProtocolModelFallback,
  toProtocolProvider,
} from './catalog';
import { ModelCatalogErrors } from './errors';
import { IHostRequestHeaders } from './hostRequestHeaders';
import {
  assembleModelInspection,
  attributeEffectiveFields,
  attributeProviderOptions,
  type ModelInspection,
  ResolutionTraceCollector,
  TRACE,
} from './inspection';
import { IModelService, type ModelRecord } from './model';
import {
  deriveProviderId,
  effectiveModelConfig,
  nonEmpty,
  resolveModelAuthMaterial,
} from './modelAuth';
import { IModelOAuthTokens } from './modelOAuth';
import type { ResolvedModelAuthMaterial } from './model.types';
import type { ModelRequester } from './modelRequester';
import { ModelRequesterImpl } from './modelRequesterImpl';
import { drivesThinkingThroughTraits } from './thinking';

type MutableProtocolProviderOptions = {
  -readonly [K in keyof ProtocolProviderOptions]: ProtocolProviderOptions[K];
};

interface CatalogEntry {
  readonly model: Model;
  readonly requester: ModelRequester;
  readonly trace: ResolutionTraceCollector;
}

interface CatalogModelOption {
  readonly item: ModelCatalogItem;
  readonly model: Model;
}

export class ModelCatalog extends Disposable implements IModelCatalog {
  declare readonly _serviceBrand: undefined;

  private readonly cache = new Map<string, CatalogEntry>();

  constructor(
    @IProviderService private readonly providers: IProviderService,
    @IModelService private readonly models: IModelService,
    @IModelOAuthTokens private readonly oauth: IModelOAuthTokens,
    @IProtocolAdapterRegistry
    private readonly protocolRegistry: IProtocolAdapterRegistry,
    @IHostRequestHeaders private readonly hostRequestHeaders: IHostRequestHeaders,
  ) {
    super();
    this._register(this.models.onDidChangeModels(() => this.notifyConfigChanged()));
    this._register(this.providers.onDidChangeProviders(() => this.notifyConfigChanged()));
  }

  notifyConfigChanged(): void {
    this.cache.clear();
  }

  get(id: string): Model {
    return this.entry(id).model;
  }

  getRequester(id: string): ModelRequester {
    return this.entry(id).requester;
  }

  findByName(name: string): readonly string[] {
    const out: string[] = [];
    for (const [id, m] of Object.entries(this.models.list())) {
      const alias = m.name === name || m.model === name || (m.aliases ?? []).includes(name);
      if (alias) out.push(id);
    }
    return out;
  }

  private entry(id: string): CatalogEntry {
    const canonicalId = this.models.resolveId(id) ?? id;
    const cached = this.cache.get(canonicalId);
    if (cached !== undefined) return cached;
    const trace = new ResolutionTraceCollector();
    const model = this.buildModel(canonicalId, trace);
    const entry: CatalogEntry = {
      model,
      requester: new ModelRequesterImpl(model, this.protocolRegistry),
      trace,
    };
    this.cache.set(canonicalId, entry);
    return entry;
  }

  inspect(id: string): ModelInspection {
    const { model, trace } = this.entry(id);
    return assembleModelInspection({ id: model.id, model, trace });
  }

  async ping(id: string): Promise<ModelPingResult> {
    const { requester } = this.entry(id);
    const startedAt = Date.now();
    try {
      let text = '';
      let usage: TokenUsage | undefined;
      let finishReason: string | undefined;
      for await (const event of requester.request(
        {
          systemPrompt: 'You are a connectivity probe. Answer with the single word "pong".',
          tools: [],
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }], toolCalls: [] }],
        },
        undefined,
        { maxCompletionTokens: 512 },
      )) {
        if (event.type === 'part' && event.part.type === 'text') {
          text += event.part.text;
        } else if (event.type === 'usage') {
          usage = event.usage;
        } else if (event.type === 'finish') {
          finishReason = event.providerFinishReason ?? event.rawFinishReason;
        }
      }
      return { ok: true, durationMs: Date.now() - startedAt, text: text.trim(), finishReason, usage };
    } catch (error) {
      return {
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listModels(): Promise<readonly ModelCatalogItem[]> {
    const models = this.models.list();
    const items: ModelCatalogItem[] = [];
    const managedOptions = new Map<
      string,
      { readonly index: number; readonly option: CatalogModelOption }
    >();
    for (const [modelId, record] of Object.entries(models)) {
      const providerType = this.providerTypeOf(record);
      try {
        const model = this.get(modelId);
        const option = { item: toProtocolModel(model, record, providerType), model };
        const identity = this.managedCatalogIdentity(model);
        if (identity === undefined) {
          items.push(option.item);
          continue;
        }
        const existing = managedOptions.get(identity);
        if (existing === undefined) {
          managedOptions.set(identity, { index: items.length, option });
          items.push(option.item);
          continue;
        }
        if (this.compareManagedCatalogOptions(option, existing.option) < 0) {
          managedOptions.set(identity, { index: existing.index, option });
          items[existing.index] = option.item;
        }
      } catch {
        items.push(toProtocolModelFallback(modelId, record, providerType));
      }
    }
    return items;
  }

  private managedCatalogIdentity(model: Model): string | undefined {
    if (!model.providerName.startsWith('managed:')) return undefined;
    return [model.providerName, model.protocol, model.baseUrl ?? '', model.name].join('\u0000');
  }

  private compareManagedCatalogOptions(a: CatalogModelOption, b: CatalogModelOption): number {
    const defaultModel = this.models.getDefaultModel();
    const rank = (option: CatalogModelOption): number => {
      if (option.model.id === defaultModel) return 0;
      const providerPrefix = option.model.providerName.slice('managed:'.length);
      if (option.model.id === `${providerPrefix}/${option.model.name}`) return 1;
      if (option.model.id === `${option.model.providerName}/${option.model.name}`) return 2;
      return 3;
    };
    return rank(a) - rank(b) || a.model.id.localeCompare(b.model.id);
  }

  async listProviders(): Promise<readonly ProviderCatalogItem[]> {
    const providers = this.providers.list();
    const models = this.models.list();
    const globalDefaultModel = this.models.getDefaultModel();
    const out: ProviderCatalogItem[] = [];
    for (const [providerId, provider] of Object.entries(providers)) {
      out.push(await this.toCatalogProvider(providerId, provider, models, globalDefaultModel));
    }
    return out;
  }

  async getProvider(providerId: string): Promise<ProviderCatalogItem> {
    const provider = this.providers.get(providerId);
    if (provider === undefined) {
      throw new Error2(
        ModelCatalogErrors.codes.PROVIDER_NOT_FOUND,
        `provider ${providerId} does not exist`,
      );
    }
    const models = this.models.list();
    const globalDefaultModel = this.models.getDefaultModel();
    return this.toCatalogProvider(providerId, provider, models, globalDefaultModel);
  }

  async setDefaultModel(modelId: string): Promise<SetDefaultModelResponse> {
    const canonicalId = this.models.resolveId(modelId);
    if (canonicalId === undefined) {
      throw new Error2(
        ModelCatalogErrors.codes.MODEL_NOT_FOUND,
        `model ${modelId} does not exist`,
      );
    }
    const record = this.models.get(canonicalId);
    if (record === undefined) {
      throw new Error2(
        ModelCatalogErrors.codes.MODEL_NOT_FOUND,
        `model ${modelId} does not exist`,
      );
    }
    const model = this.get(canonicalId);
    await this.models.setDefaultModel(canonicalId);
    return {
      default_model: canonicalId,
      model: toProtocolModel(model, record, this.providerTypeOf(record)),
    };
  }

  private async toCatalogProvider(
    providerId: string,
    provider: ProviderConfig,
    models: Readonly<Record<string, ModelRecord>>,
    globalDefaultModel: string | undefined,
  ): Promise<ProviderCatalogItem> {
    const credential = await this.resolveCredential(providerId, provider);
    return toProtocolProvider(providerId, provider, models, globalDefaultModel, credential);
  }

  private async resolveCredential(
    providerId: string,
    provider: ProviderConfig,
  ): Promise<ProviderCredentialState> {
    return {
      hasApiKey: hasConfiguredApiKey(provider),
      hasOAuthToken: await this.hasCachedToken(providerId, provider),
    };
  }

  private async hasCachedToken(providerId: string, provider: ProviderConfig): Promise<boolean> {
    if (provider.oauth === undefined) return false;
    return this.oauth.hasCachedAccessToken(providerId, provider.oauth);
  }

  private providerTypeOf(record: ModelRecord): string | undefined {
    const providerId =
      record.providerId ?? record.provider ?? this.providers.getDefaultProvider();
    return this.providers.get(providerId ?? '')?.type ?? record.protocol;
  }

  private buildModel(id: string, trace: ResolutionTraceCollector): Model {
    const configuredModel = this.models.get(id);
    if (configuredModel === undefined) {
      throw new Error2(
        CONFIG_INVALID_ERROR_CODE,
        `Model "${id}" is not configured in config.toml.`,
        { details: { model: id } },
      );
    }
    trace.capture(TRACE.configuredModel, configuredModel);
    trace.record('model.record', { kind: 'config', detail: '[models.*] section' });

    const routingModel = effectiveModelConfig(configuredModel);
    const { providerConfig, providerName, resolvedBaseUrl: rawBaseUrl } =
      this.resolveProviderContext(id, routingModel, trace);
    trace.capture(TRACE.providerConfig, providerConfig);
    trace.capture(TRACE.providerName, providerName);
    trace.capture(TRACE.rawBaseUrl, rawBaseUrl);

    const protocol = this.resolveProtocol(id, routingModel, providerConfig, trace);
    const model = effectiveModelConfig(
      configuredModel,
      providerConfig?.type ?? configuredModel.protocol,
    );
    trace.capture(TRACE.effectiveModel, model);
    const wireName = model.name ?? model.model;
    const profileAttribution = profileForAttribution(configuredModel, providerConfig, wireName);
    attributeEffectiveFields(
      trace,
      configuredModel,
      model,
      profileAttribution.profile,
      profileAttribution.inferred,
    );

    const auth = resolveModelAuthMaterial(
      {
        modelId: id,
        model,
        provider: providerConfig,
        providerName,
      },
      trace,
    );
    trace.capture(TRACE.authMaterial, auth);
    const authProvider = this.buildAuthProvider(providerName, auth);

    const providerType = providerConfig?.type ?? protocol;
    const resolvedBaseUrl =
      protocol === 'anthropic' && rawBaseUrl !== undefined
        ? stripTrailingV1(rawBaseUrl)
        : rawBaseUrl;
    if (wireName === undefined) {
      throw new Error2(
        CONFIG_INVALID_ERROR_CODE,
        `Model "${id}" must define a wire-facing name in config.toml.`,
      );
    }
    if (model.maxContextSize === undefined) {
      throw new Error2(
        CONFIG_INVALID_ERROR_CODE,
        `Model "${id}" must define a positive max_context_size in config.toml.`,
      );
    }

    const explainedCapability = this.protocolRegistry.explainCapability(
      protocol,
      wireName,
      providerType,
    );
    trace.capture(TRACE.detectedCapability, explainedCapability.capability);
    trace.capture(TRACE.capabilitySource, explainedCapability.source);
    const capabilities = resolveModelCapabilities(
      model.capabilities,
      explainedCapability.capability,
      model.maxContextSize,
      model.maxInputSize,
    );
    const providerOptions = buildProtocolProviderOptions(
      model,
      protocol,
      providerConfig,
      resolvedBaseUrl,
    );
    if (providerOptions !== undefined) {
      attributeProviderOptions(trace, providerOptions, providerConfig?.env);
    }
    const declared = new Set((model.capabilities ?? []).map((c) => c.trim().toLowerCase()));

    trace.capture(TRACE.hostHeaders, this.hostRequestHeaders.headers);
    trace.capture(TRACE.thirdPartyHeaders, this.hostRequestHeaders.thirdPartyHeaders);
    trace.capture(TRACE.identitySlug, this.hostRequestHeaders.identitySlug);
    return {
      id,
      name: wireName,
      aliases: model.aliases ?? [],
      protocol,
      baseUrl: resolvedBaseUrl,
      headers: resolveOutboundHeaders(
        providerConfig?.type,
        providerConfig?.customHeaders,
        this.hostRequestHeaders,
      ),
      capabilities,
      maxContextSize: model.maxContextSize,
      maxInputSize: model.maxInputSize,
      maxOutputSize: model.maxOutputSize,
      displayName: model.displayName,
      reasoningKey: model.reasoningKey,
      supportEfforts: model.supportEfforts,
      defaultEffort: model.defaultEffort,
      overrides: configuredModel.overrides,
      contextBudget: model.contextBudget,
      maxCompletionTokens: model.maxCompletionTokens,
      requestParams: model.requestParams,
      serviceTier: model.serviceTier,
      alwaysThinking: declared.has('always_thinking'),
      providerType,
      providerName,
      authProvider,
      providerOptions,
    };
  }

  private resolveProviderContext(
    id: string,
    model: ModelRecord,
    trace: ResolutionTraceCollector,
  ): {
    readonly providerConfig: ProviderConfig | undefined;
    readonly providerName: string;
    readonly resolvedBaseUrl: string | undefined;
  } {
    const providerId =
      model.providerId ?? model.provider ?? this.providers.getDefaultProvider();
    if (providerId !== undefined) {
      trace.record('provider', {
        kind: 'config',
        detail:
          model.providerId !== undefined
            ? `model.providerId '${providerId}'`
            : model.provider !== undefined
              ? `model.provider '${providerId}'`
              : `[defaultProvider] '${providerId}'`,
      });
      trace.capture(TRACE.providerSynthesized, false);
      const providerConfig = this.providers.get(providerId);
      if (providerConfig === undefined) {
        throw new Error2(
          CONFIG_INVALID_ERROR_CODE,
          `Provider "${providerId}" referenced by model "${id}" is not configured.`,
        );
      }
      const fromModel = nonEmpty(model.baseUrl);
      const fromProvider = nonEmpty(providerConfig.baseUrl);
      let baseUrl: string | undefined;
      if (fromModel !== undefined) {
        baseUrl = fromModel;
        trace.record('resolved.baseUrl', { kind: 'config', detail: 'model.baseUrl' });
      } else if (fromProvider !== undefined) {
        baseUrl = fromProvider;
        trace.record('resolved.baseUrl', {
          kind: 'config',
          detail: `provider '${providerId}' baseUrl`,
        });
      } else {
        const endpointType = providerConfig.type ?? model.protocol;
        const endpoint =
          endpointType === undefined
            ? {}
            : explainProviderEndpoint(endpointType, providerConfig.env ?? {});
        baseUrl = nonEmpty(endpoint.baseUrl);
        if (endpoint.baseUrlEnvName !== undefined) {
          trace.record('resolved.baseUrl', {
            kind: 'env',
            detail: `${endpoint.baseUrlEnvName} (provider '${providerId}' env bag)`,
          });
        } else if (endpoint.baseUrlIsDefault === true) {
          trace.record('resolved.baseUrl', {
            kind: 'builtin',
            detail: `provider definition '${endpointType}' defaultBaseUrl`,
          });
        }
      }
      return { providerConfig, providerName: providerId, resolvedBaseUrl: baseUrl };
    }

    const modelBaseUrl = nonEmpty(model.baseUrl);
    if (modelBaseUrl === undefined) {
      throw new Error2(
        CONFIG_INVALID_ERROR_CODE,
        `Model "${id}" must set either providerId or baseUrl in config.toml.`,
      );
    }
    trace.record('provider', {
      kind: 'synthesized',
      detail: 'flat model — provider synthesized from the baseUrl host',
    });
    trace.capture(TRACE.providerSynthesized, true);
    trace.record('resolved.baseUrl', { kind: 'config', detail: 'model.baseUrl (flat)' });
    const originName = deriveProviderId(modelBaseUrl);
    return {
      providerConfig: undefined,
      providerName: originName,
      resolvedBaseUrl: modelBaseUrl,
    };
  }

  private resolveProtocol(
    id: string,
    model: ModelRecord,
    provider: ProviderConfig | undefined,
    trace: ResolutionTraceCollector,
  ): Protocol {
    if (model.protocol !== undefined) {
      trace.record('resolved.protocol', { kind: 'config', detail: 'model.protocol' });
      return model.protocol;
    }
    const providerType = provider?.type;
    if (providerType !== undefined) {
      const asProtocol = ProtocolSchema.safeParse(providerType);
      if (asProtocol.success) {
        trace.record('resolved.protocol', {
          kind: 'config',
          detail: `provider type '${providerType}' is itself a wire protocol`,
        });
        return asProtocol.data;
      }
      const definition = getProviderDefinition(providerType);
      if (definition !== undefined) {
        trace.record('resolved.protocol', {
          kind: 'builtin',
          detail: `vendor '${providerType}' declared baseProtocol`,
        });
        return definition.baseProtocol;
      }
    }
    throw new Error2(
      CONFIG_INVALID_ERROR_CODE,
      `Model "${id}" must declare a wire protocol (config: models.<id>.protocol).`,
    );
  }

  private buildAuthProvider(providerName: string, auth: ResolvedModelAuthMaterial): AuthProvider {
    if (auth.apiKey !== undefined) {
      return new StaticAuthProvider(auth.apiKey);
    }
    if (auth.oauth !== undefined) {
      const oauthRef = auth.oauth;
      const providerKey = auth.oauthProviderKey ?? providerName;
      const tokens = this.oauth;
      return {
        canRefresh: true,
        async getAuth(options): Promise<ProviderRequestAuth | undefined> {
          const apiKey = await tokens.getAccessToken(providerKey, oauthRef, {
            force: options?.force === true,
          });
          return { apiKey };
        },
      };
    }
    return new StaticAuthProvider(undefined);
  }
}

export function resolveOutboundHeaders(
  providerType: string | undefined,
  customHeaders: Readonly<Record<string, string>> | undefined,
  host: Pick<IHostRequestHeaders, 'headers' | 'thirdPartyHeaders'>,
): Readonly<Record<string, string>> {
  const forwardsAll =
    providerType !== undefined &&
    getProviderDefinition(providerType)?.hostHeaders === 'full';
  const hostLayer = forwardsAll ? host.headers : host.thirdPartyHeaders;
  return { ...parseKimiCodeCustomHeaders(), ...hostLayer, ...customHeaders };
}

function resolveModelCapabilities(
  declaredCapabilities: readonly string[] | undefined,
  detected: ModelCapability,
  maxContextSize: number,
  maxInputSize: number | undefined,
): ModelCapability {
  const declared = new Set((declaredCapabilities ?? []).map((c) => c.trim().toLowerCase()));
  return {
    image_in: declared.has('image_in') || detected.image_in,
    video_in: declared.has('video_in') || detected.video_in,
    audio_in: declared.has('audio_in') || detected.audio_in,
    thinking: declared.has('thinking') || declared.has('always_thinking') || detected.thinking,
    tool_use: declared.has('tool_use') || detected.tool_use,
    max_context_tokens: maxContextSize,
    max_input_tokens: maxInputSize,
    dynamically_loaded_tools:
      declared.has('dynamically_loaded_tools') ||
      detected.dynamically_loaded_tools === true,
  };
}

function stripTrailingV1(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '');
}

function buildProtocolProviderOptions(
  model: ModelRecord,
  protocol: Protocol,
  provider: ProviderConfig | undefined,
  baseUrl: string | undefined,
): ProtocolProviderOptions | undefined {
  const options: MutableProtocolProviderOptions = {};

  switch (protocol) {
    case 'anthropic':
      if (model.maxOutputSize !== undefined) options.defaultMaxTokens = model.maxOutputSize;
      if (model.supportEfforts !== undefined) options.supportEfforts = model.supportEfforts;
      if (model.adaptiveThinking !== undefined) options.adaptiveThinking = model.adaptiveThinking;
      if (model.betaApi !== undefined) options.betaApi = model.betaApi;
      break;
    case 'openai': {
      const reasoningKey = nonEmpty(model.reasoningKey);
      if (reasoningKey !== undefined) options.reasoningKey = reasoningKey;
      if (model.offEffort !== undefined) options.offEffort = model.offEffort;
      break;
    }
    case 'google-genai': {
      const project = vertexAIProject(provider);
      const location = vertexAILocation(provider, baseUrl);
      if (project !== undefined && location !== undefined) {
        options.vertexai = true;
        options.project = project;
        options.location = location;
      }
      break;
    }
    case 'openai_responses':
      if (model.offEffort !== undefined) options.offEffort = model.offEffort;
      break;
    default: {
      const exhaustive: never = protocol;
      void exhaustive;
    }
  }

  return Object.values(options).some((value) => value !== undefined)
    ? options
    : undefined;
}

function profileForAttribution(
  configuredModel: ModelRecord,
  providerConfig: ProviderConfig | undefined,
  wireName: string | undefined,
): { readonly profile: typeof LATEST_OPUS_PROFILE | undefined; readonly inferred: boolean } {
  if (wireName === undefined) return { profile: undefined, inferred: false };
  const profileArg = providerConfig?.type ?? configuredModel.protocol;
  const gateProtocol = configuredModel.protocol ?? profileArg;
  const known = matchKnownAnthropicModelProfile(wireName);
  const infer =
    profileArg !== undefined &&
    !drivesThinkingThroughTraits(profileArg) &&
    gateProtocol === 'anthropic';
  if (infer) {
    const fallback = known ?? matchUnknownClaudeProfile(wireName);
    return { profile: fallback, inferred: known === undefined && fallback !== undefined };
  }
  return { profile: known, inferred: false };
}

function vertexAIProject(provider: ProviderConfig | undefined): string | undefined {
  return envValue(provider?.env, 'GOOGLE_CLOUD_PROJECT');
}

function vertexAILocation(
  provider: ProviderConfig | undefined,
  baseUrl: string | undefined,
): string | undefined {
  return envValue(provider?.env, 'GOOGLE_CLOUD_LOCATION') ?? locationFromVertexAIBaseUrl(baseUrl);
}

function envValue(env: Record<string, string> | undefined, key: string): string | undefined {
  return nonEmpty(env?.[key]);
}

function locationFromVertexAIBaseUrl(baseUrl: string | undefined): string | undefined {
  const url = nonEmpty(baseUrl);
  if (url === undefined) return undefined;
  try {
    const host = new URL(url).hostname;
    const suffix = '-aiplatform.googleapis.com';
    return host.endsWith(suffix) ? nonEmpty(host.slice(0, -suffix.length)) : undefined;
  } catch {
    return undefined;
  }
}

function hasConfiguredApiKey(provider: ProviderConfig): boolean {
  if (nonEmpty(provider.apiKey) !== undefined) return true;
  if (provider.type === undefined) return false;
  return resolveProviderEndpoint(provider.type, provider.env ?? {}).apiKey !== undefined;
}

registerScopedService(
  LifecycleScope.App,
  IModelCatalog,
  ModelCatalog,
  ScopeActivation.OnScopeCreated,
  'modelCatalog',
);
