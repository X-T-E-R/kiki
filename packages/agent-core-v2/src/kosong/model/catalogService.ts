import { assertProviderCredential, assertProviderHeaders, parseKimiCodeCustomHeaders, sanitizeProviderError } from '@kiki/oauth';
import {
  decisionProtocolForProviderType,
  modelBehaviorToWire,
  type DecisionProtocol,
} from '@kiki/protocol';

import { IRequestAdmission, type RequestAdmissionPort } from './requestAdmission';
import { Disposable } from '#/_base/di/lifecycle';
import { applyModelSettings } from './modelSettings';
import { explainModelProtocol, type ExplainedModelProtocol } from './modelProtocol';
import type { ProviderAdapterDefinition } from '#/kosong/protocol/extensionRegistry';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2 } from '#/_base/errors/errors';
import { UNKNOWN_CAPABILITY, type ModelCapability } from '#/kosong/contract/capability';
import type { ProviderRequestAuth } from '#/kosong/contract/provider';
import type { TokenUsage } from '#/kosong/contract/usage';
import {
  IProtocolAdapterRegistry,
  type Protocol,
  type ProtocolProviderOptions,
} from '#/kosong/protocol/protocol';
import { getProtocolBase } from '#/kosong/protocol/protocolBase';

import { APIStatusError, CONFIG_INVALID_ERROR_CODE } from '#/kosong/contract/errors';
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
  providerEndpointEnvNames,
  resolveProviderApiKey,
} from '../provider/providerDefinition';
import { resolveImagePolicy } from '../provider/providerImagePolicy';
import {
  resolveAnthropicMessageThreads,
  resolveRequestCompression,
  resolveResponsesWebSocket,
} from '../provider/requestCompression';

import {
  type AuthProvider,
  type ConnectionEndpoint,
  groupModelIdsByProvider,
  IModelCatalog,
  type Model,
  type ModelCatalogItem,
  modelBindingOriginFields,
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
  resolveConfiguredModelBaseUrl,
  resolveModelAuthMaterial,
  resolveModelProviderId,
} from './modelAuth';
import { IModelOAuthTokens, oauthRequestAuth } from './modelOAuth';
import type { ResolvedModelAuthMaterial } from './model.types';
import type { ModelRequester } from './modelRequester';
import { ModelRequesterImpl } from './modelRequesterImpl';
import { isApiDefault, parametersToWire, resolveGenerationParameters, resolveModelUsage } from './parameters';
import { requestIdentityToWire } from '../requestIdentity/requestIdentityPolicy';
import { drivesThinkingThroughTraits } from './thinking';

type MutableProtocolProviderOptions = {
  -readonly [K in keyof ProtocolProviderOptions]: ProtocolProviderOptions[K];
};

interface CatalogEntry {
  readonly adapterKey?: string;
  readonly model: Model;
  readonly credentials: readonly string[];
  readonly requester: ModelRequester;
  readonly trace: ResolutionTraceCollector;
}

const DEFAULT_CATALOG_ENTRY_CACHE_MAX = 256;
const CATALOG_ENTRY_CACHE_MAX_ENV = 'KIKI_MODEL_CATALOG_CACHE_MAX';

function resolveCatalogEntryCacheMax(): number {
  const raw = process.env[CATALOG_ENTRY_CACHE_MAX_ENV]?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_CATALOG_ENTRY_CACHE_MAX;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CATALOG_ENTRY_CACHE_MAX;
}

interface CatalogModelOption {
  readonly item: ModelCatalogItem;
  readonly model: Pick<Model, 'id' | 'name' | 'protocol' | 'baseUrl' | 'providerName'>;
}

interface ListModelsCacheEntry {
  readonly revision: number;
  readonly modelsRef: Readonly<Record<string, ModelRecord>>;
  readonly providersRef: Readonly<Record<string, ProviderConfig>>;
  readonly defaultProvider: string | undefined;
  readonly defaultModel: string | undefined;
  readonly adapterFingerprint: string;
  readonly envKeys: readonly string[];
  readonly envFingerprint: string;
  readonly items: readonly ModelCatalogItem[];
}

interface ProviderListProjection {
  readonly providerConfig: ProviderConfig;
  readonly adapter: ProviderAdapterDefinition | undefined;
  readonly providerType: string | undefined;
  readonly isDecision: boolean;
  readonly isManaged: boolean;
  readonly explainedProtocol: ExplainedModelProtocol | undefined;
  readonly protocolSource: ModelCatalogItem['protocol_source'];
  readonly bindingOrigins: Pick<ModelCatalogItem, 'endpoint_source' | 'endpoint_env' | 'auth_source' | 'auth_env'>;
  readonly baseUrl: string | undefined;
  readonly authConflict: boolean;
  readonly resolveCapability: ((wireName: string) => ModelCapability) | undefined;
}

const ANTHROPIC_PROFILE_HINT_RE = /claude|opus|sonnet|haiku|fable|mythos/i;

export class ModelCatalog extends Disposable implements IModelCatalog {
  declare readonly _serviceBrand: undefined;

  private readonly cache = new Map<string, CatalogEntry>();
  private catalogRevision = 0;
  private listModelsCache: ListModelsCacheEntry | undefined;
  private nameIndexModelsRef: Readonly<Record<string, ModelRecord>> | undefined;
  private nameIndex: Map<string, string[]> | undefined;

  constructor(
    @IProviderService private readonly providers: IProviderService,
    @IModelService private readonly models: IModelService,
    @IModelOAuthTokens private readonly oauth: IModelOAuthTokens,
    @IProtocolAdapterRegistry
    private readonly protocolRegistry: IProtocolAdapterRegistry,
    @IHostRequestHeaders private readonly hostRequestHeaders: IHostRequestHeaders,
    @IRequestAdmission private readonly admission: RequestAdmissionPort,
  ) {
    super();
    this._register(this.models.onDidChangeModels(() => this.notifyConfigChanged()));
    this._register(this.models.onDidChangeDefaultModel(() => this.notifyConfigChanged()));
    this._register(this.providers.onDidChangeProviders(() => this.notifyConfigChanged()));
    this._register(this.providers.onDidChangeDefaultProvider(() => { this.notifyConfigChanged(); }));
    this._register(this.providers.onDidChangeTransportDefaults(() => this.notifyConfigChanged()));
  }

  notifyConfigChanged(): void {
    this.catalogRevision += 1;
    this.cache.clear();
    this.listModelsCache = undefined;
    this.nameIndexModelsRef = undefined;
    this.nameIndex = undefined;
  }

  get(id: string, recipeSettings?: Record<string, unknown>): Model {
    return this.entry(id, recipeSettings).model;
  }

  getRequester(id: string, recipeSettings?: Record<string, unknown>): ModelRequester {
    return this.entry(id, recipeSettings).requester;
  }

  getConnectionEndpoint(providerId: string, requestedProtocol?: DecisionProtocol): ConnectionEndpoint {
    const provider = this.providers.get(providerId);
    if (provider === undefined) throw new Error2(CONFIG_INVALID_ERROR_CODE, `Connection "${providerId}" does not exist`);
    const adapter = provider.type === undefined ? undefined : this.protocolRegistry.providerDefinition?.(provider.type);
    const auth = resolveModelAuthMaterial({ modelId: `connection:${providerId}`, model: { provider: providerId }, provider, providerName: providerId, adapter });
    const headers = resolveOutboundHeaders(provider.type, provider.customHeaders, this.hostRequestHeaders, adapter);
    const key = resolveProviderApiKey(provider, adapter);
    const standaloneProtocol = decisionProtocolForProviderType(provider.type);
    const attached = standaloneProtocol === undefined && requestedProtocol !== undefined ? provider.decision?.[requestedProtocol] : undefined;
    const protocol = standaloneProtocol !== undefined
      ? (requestedProtocol === undefined || requestedProtocol === standaloneProtocol ? standaloneProtocol : undefined)
      : (attached === undefined ? undefined : requestedProtocol);
    return {
      providerName: providerId,
      baseUrl: resolveConfiguredModelBaseUrl({}, provider, adapter),
      defaultModel: standaloneProtocol !== undefined ? provider.defaultModel : attached?.model,
      protocol,
      decisionEndpoint: standaloneProtocol !== undefined ? provider.decisionEndpoint : attached?.endpoint,
      headers,
      authProvider: this.buildAuthProvider(providerId, auth),
      credentialSource: auth.apiKey !== undefined ? (provider.apiKey?.trim() ? 'provider' : 'env') : auth.oauth !== undefined ? 'oauth' : Object.values(provider.customHeaders ?? {}).some(Boolean) || Object.keys(headers).some((name) => /^(authorization|x-api-key)$/i.test(name) && headers[name]) ? 'headers' : 'none',
      credentialEnv: key.envName,
    };
  }

  getConnectionRequester(providerId: string, modelName: string, maxContextSize: number): ModelRequester {
    if (decisionProtocolForProviderType(this.providers.get(providerId)?.type) !== undefined) {
      throw new Error2(CONFIG_INVALID_ERROR_CODE, 'Decision connections cannot be used for chat');
    }
    if (this.providers.get(providerId) === undefined) {
      throw new Error2(CONFIG_INVALID_ERROR_CODE, `Connection "${providerId}" does not exist`);
    }
    const built = this.buildModel(`connection:${providerId}/${modelName}`, new ResolutionTraceCollector(), undefined, {
      provider: providerId, name: modelName, maxContextSize,
    });
    return new ModelRequesterImpl(built.model, this.protocolRegistry, this.admission);
  }

  findByName(name: string): readonly string[] {
    const models = this.models.list();
    if (this.nameIndex === undefined || this.nameIndexModelsRef !== models) {
      const index = new Map<string, string[]>();
      const seen = new Set<string>();
      const addKey = (key: string | undefined, id: string): void => {
        if (key === undefined || seen.has(key)) return;
        seen.add(key);
        let list = index.get(key);
        if (list === undefined) {
          list = [];
          index.set(key, list);
        }
        list.push(id);
      };
      for (const [id, m] of Object.entries(models)) {
        seen.clear();
        addKey(m.name, id);
        addKey(m.model, id);
        if (m.aliases !== undefined) {
          for (const alias of m.aliases) addKey(alias, id);
        }
      }
      this.nameIndex = index;
      this.nameIndexModelsRef = models;
    }
    const matches = this.nameIndex.get(name);
    return matches === undefined ? [] : [...matches];
  }

  private entry(id: string, recipeSettings?: Record<string, unknown>): CatalogEntry {
    const canonicalId = this.models.resolveId(id) ?? id;
    const key = recipeSettings === undefined ? canonicalId : `${canonicalId}\0${JSON.stringify(recipeSettings)}`;
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.adapterKey === this.protocolRegistry.adapterCacheKey?.(cached.model.protocol, cached.model.providerType)) return cached;
    const trace = new ResolutionTraceCollector();
    const built = this.buildModel(canonicalId, trace, recipeSettings);
    const entry: CatalogEntry = {
      adapterKey: this.protocolRegistry.adapterCacheKey?.(built.model.protocol, built.model.providerType),
      model: built.model,
      credentials: built.credentials,
      requester: new ModelRequesterImpl(built.model, this.protocolRegistry, this.admission),
      trace,
    };
    const cacheMax = resolveCatalogEntryCacheMax();
    if (this.cache.size >= cacheMax) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, entry);
    return entry;
  }

  inspect(id: string): ModelInspection {
    const { model, trace } = this.entry(id);
    return assembleModelInspection({ id: model.id, model, trace });
  }

  async ping(id: string): Promise<ModelPingResult> {
    const { model, credentials } = this.entry(id);
    const secrets = [...credentials];
    const headers = { ...model.headers };
    const startedAt = Date.now();
    try {
      assertProviderHeaders(headers);
      const requester = new ModelRequesterImpl({
        ...model,
        authProvider: {
          canRefresh: model.authProvider.canRefresh,
          getAuth: async (options) => {
            const auth = await model.authProvider.getAuth(options);
            if (auth?.apiKey !== undefined) {
              secrets.push(auth.apiKey);
              assertProviderCredential(auth.apiKey);
            }
            Object.assign(headers, auth?.headers);
            assertProviderHeaders(headers);
            return auth;
          },
        },
      }, this.protocolRegistry, this.admission);
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
        { maxCompletionTokens: 32, attribution: { logicalRequestId: crypto.randomUUID(), purpose: 'connectivity_probe', waitBudget: { waitedMs: 0 } } },
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
        error: sanitizeProviderError(error, {
          secrets,
          baseUrl: model.baseUrl,
          headers,
        }),
        errorCode: error instanceof Error2 ? error.code : undefined,
        httpStatus: error instanceof APIStatusError ? error.statusCode : undefined,
      };
    }
  }

  async listModels(): Promise<readonly ModelCatalogItem[]> {
    await Promise.all([this.models.ready, this.providers.ready]);
    const models = this.models.list();
    const providers = this.providers.list();
    const defaultProvider = this.providers.getDefaultProvider();
    const defaultModel = this.models.getDefaultModel();
    const adapterFingerprint = this.computeAdapterFingerprint(providers);
    const cached = this.listModelsCache;
    if (
      cached !== undefined &&
      cached.revision === this.catalogRevision &&
      cached.modelsRef === models &&
      cached.providersRef === providers &&
      cached.defaultProvider === defaultProvider &&
      cached.defaultModel === defaultModel &&
      cached.adapterFingerprint === adapterFingerprint &&
      cached.envFingerprint === computeEnvFingerprint(cached.envKeys)
    ) {
      return cached.items;
    }

    const envKeys = new Set<string>();
    const capabilityResolvers = new Map<string, (wireName: string) => ModelCapability>();
    const providerProjections = this.buildProviderListProjections(providers, envKeys, capabilityResolvers);
    const items: ModelCatalogItem[] = [];
    const managedOptions = new Map<
      string,
      { readonly index: number; readonly option: CatalogModelOption }
    >();

    for (const modelId in models) {
      if (!Object.hasOwn(models, modelId)) continue;
      const record = models[modelId]!;
      const providerId = record.providerId ?? record.provider ?? defaultProvider;
      const projection = providerId === undefined ? undefined : providerProjections.get(providerId);
      const providerConfig = projection?.providerConfig;
      const providerType = providerConfig?.type ?? record.protocol;
      if (projection?.isDecision === true || (projection === undefined && decisionProtocolForProviderType(providerType) !== undefined)) {
        continue;
      }
      try {
        const result = this.projectCatalogModelItem(
          modelId,
          record,
          providerId,
          projection,
          envKeys,
          capabilityResolvers,
        );
        if (result.managed === undefined) {
          items.push(result.item);
          continue;
        }
        const identity = this.managedCatalogIdentity(result.managed);
        if (identity === undefined) {
          items.push(result.item);
          continue;
        }
        const option: CatalogModelOption = { item: result.item, model: result.managed };
        const existing = managedOptions.get(identity);
        if (existing === undefined) {
          managedOptions.set(identity, { index: items.length, option });
          items.push(option.item);
          continue;
        }
        if (this.compareManagedCatalogOptions(option, existing.option, defaultModel) < 0) {
          managedOptions.set(identity, { index: existing.index, option });
          items[existing.index] = option.item;
        }
      } catch {
        items.push(toProtocolModelFallback(modelId, record, providerType, providerConfig));
      }
    }

    const trackedEnvKeys = [...envKeys];
    this.listModelsCache = {
      revision: this.catalogRevision,
      modelsRef: models,
      providersRef: providers,
      defaultProvider,
      defaultModel,
      adapterFingerprint,
      envKeys: trackedEnvKeys,
      envFingerprint: computeEnvFingerprint(trackedEnvKeys),
      items,
    };
    return items;
  }

  private computeAdapterFingerprint(providers: Readonly<Record<string, ProviderConfig>>): string {
    if (this.protocolRegistry.adapterCacheKey === undefined) return '';
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const provider of Object.values(providers)) {
      const type = provider.type;
      if (type === undefined || seen.has(type)) continue;
      seen.add(type);
      const key = this.protocolRegistry.adapterCacheKey('openai', type);
      if (key !== undefined) parts.push(`${type}=${key}`);
    }
    return parts.join('\u0000');
  }

  private getCapabilityResolver(
    protocol: Protocol,
    effectiveProviderType: string,
    cache: Map<string, (wireName: string) => ModelCapability>,
  ): (wireName: string) => ModelCapability {
    const resolverKey = `${protocol}\u0000${effectiveProviderType}`;
    let resolveCapability = cache.get(resolverKey);
    if (resolveCapability !== undefined) return resolveCapability;
    const identity = this.protocolRegistry.resolveAdapterIdentity(protocol, effectiveProviderType);
    const base = getProtocolBase(identity.baseId);
    if (base === undefined) {
      resolveCapability = (name) => this.protocolRegistry.resolveCapability(protocol, name, effectiveProviderType);
    } else {
      const capTraits = identity.traits.filter(({ trait }) => trait.capability !== undefined);
      const baseCap = base.capability;
      if (capTraits.length === 0) {
        resolveCapability = baseCap === undefined
          ? () => UNKNOWN_CAPABILITY
          : (name) => baseCap(name) ?? UNKNOWN_CAPABILITY;
      } else {
        resolveCapability = (name) => {
          let traitCapability: ModelCapability | undefined;
          for (const { trait, context } of capTraits) {
            traitCapability = trait.capability!(name, context) ?? traitCapability;
          }
          return traitCapability ?? baseCap?.(name) ?? UNKNOWN_CAPABILITY;
        };
      }
    }
    cache.set(resolverKey, resolveCapability);
    return resolveCapability;
  }

  private buildProviderListProjections(
    providers: Readonly<Record<string, ProviderConfig>>,
    envKeys: Set<string>,
    capabilityResolvers: Map<string, (wireName: string) => ModelCapability>,
  ): Map<string, ProviderListProjection> {
    const out = new Map<string, ProviderListProjection>();
    for (const [providerId, providerConfig] of Object.entries(providers)) {
      const providerType = providerConfig.type;
      if (providerConfig.apiKeyEnv !== undefined && providerConfig.apiKeyEnv.trim().length > 0) {
        envKeys.add(providerConfig.apiKeyEnv.trim());
      }
      if (providerType === 'system_one') envKeys.add('TYPESAFE_API_KEY');
      const isDecision = decisionProtocolForProviderType(providerType) !== undefined;
      if (isDecision) {
        out.set(providerId, {
          providerConfig,
          adapter: undefined,
          providerType,
          isDecision: true,
          isManaged: false,
          explainedProtocol: undefined,
          protocolSource: undefined,
          bindingOrigins: { endpoint_source: 'none', auth_source: 'none' },
          baseUrl: undefined,
          authConflict: false,
          resolveCapability: undefined,
        });
        continue;
      }
      const adapter = providerType === undefined ? undefined : this.protocolRegistry.providerDefinition?.(providerType);
      for (const envName of providerEndpointEnvNames(providerType, adapter)) {
        envKeys.add(envName);
      }
      const explainedProtocol = explainModelProtocol({}, providerConfig, undefined, adapter);
      const protocolSource = providerType === undefined
        ? undefined
        : explainModelProtocol({}, { type: providerType })?.source;
      const bindingOrigins = modelBindingOriginFields({}, providerConfig);
      if (bindingOrigins.auth_env !== undefined) envKeys.add(bindingOrigins.auth_env);
      if (bindingOrigins.endpoint_env !== undefined) envKeys.add(bindingOrigins.endpoint_env);
      const baseUrl = resolveConfiguredModelBaseUrl({}, providerConfig, adapter);
      const providerKey = resolveProviderApiKey({ ...providerConfig, type: providerType }, adapter);
      const authConflict = providerKey.apiKey !== undefined && providerConfig.oauth !== undefined;
      const resolveCapability =
        explainedProtocol === undefined
          ? undefined
          : this.getCapabilityResolver(
              explainedProtocol.protocol,
              providerType ?? explainedProtocol.protocol,
              capabilityResolvers,
            );
      out.set(providerId, {
        providerConfig,
        adapter,
        providerType,
        isDecision: false,
        isManaged: providerId.startsWith('managed:'),
        explainedProtocol,
        protocolSource,
        bindingOrigins,
        baseUrl,
        authConflict,
        resolveCapability,
      });
    }
    return out;
  }

  private projectCatalogModelItem(
    id: string,
    record: ModelRecord,
    providerId: string | undefined,
    projection: ProviderListProjection | undefined,
    envKeys: Set<string>,
    capabilityResolvers: Map<string, (wireName: string) => ModelCapability>,
  ): { readonly item: ModelCatalogItem; readonly managed?: CatalogModelOption['model'] } {
    const providerConfig = projection?.providerConfig;
    const routingModel = record.overrides === undefined && record.maxInputSize === undefined
      ? record
      : effectiveModelConfig(record);

    let providerName: string;
    let rawBaseUrl: string | undefined;
    let adapter: ProviderAdapterDefinition | undefined;

    if (providerId !== undefined) {
      if (providerConfig === undefined) {
        throw new Error2(
          CONFIG_INVALID_ERROR_CODE,
          `Provider "${providerId}" referenced by model "${id}" is not configured.`,
        );
      }
      providerName = providerId;
      adapter =
        routingModel.protocol === undefined
          ? projection!.adapter
          : providerConfig.type === undefined
            ? undefined
            : this.protocolRegistry.providerDefinition?.(providerConfig.type, routingModel.protocol);
      if (routingModel.protocol !== undefined) {
        for (const envName of providerEndpointEnvNames(providerConfig.type, adapter)) {
          envKeys.add(envName);
        }
      }
      rawBaseUrl =
        routingModel.baseUrl === undefined && routingModel.protocol === undefined
          ? projection!.baseUrl
          : resolveConfiguredModelBaseUrl(routingModel, providerConfig, adapter);
    } else {
      const modelBaseUrl = nonEmpty(routingModel.baseUrl);
      if (modelBaseUrl === undefined) {
        throw new Error2(
          CONFIG_INVALID_ERROR_CODE,
          `Model "${id}" must set either providerId or baseUrl in config.toml.`,
        );
      }
      providerName = deriveProviderId(modelBaseUrl);
      rawBaseUrl = modelBaseUrl;
    }

    const resolvedProtocol =
      routingModel.protocol === undefined && projection !== undefined
        ? projection.explainedProtocol
        : explainModelProtocol(routingModel, providerConfig, undefined, adapter);
    if (resolvedProtocol === undefined) {
      throw new Error2(
        CONFIG_INVALID_ERROR_CODE,
        `Model "${id}" must declare a wire protocol (config: models.<id>.protocol).`,
      );
    }
    const protocol = resolvedProtocol.protocol;
    const providerType = providerConfig?.type ?? record.protocol;
    const rawWireName = record.name ?? record.model;
    const effective =
      record.overrides === undefined &&
      record.maxInputSize === undefined &&
      (rawWireName === undefined || !ANTHROPIC_PROFILE_HINT_RE.test(rawWireName))
        ? record
        : effectiveModelConfig(record, providerType);
    const effectiveProviderType = providerConfig?.type ?? protocol;
    const wireName = effective.name ?? effective.model;
    if (wireName === undefined) {
      throw new Error2(
        CONFIG_INVALID_ERROR_CODE,
        `Model "${id}" must define a wire-facing name in config.toml.`,
      );
    }
    if (effective.maxContextSize === undefined) {
      throw new Error2(
        CONFIG_INVALID_ERROR_CODE,
        `Model "${id}" must define a positive max_context_size in config.toml.`,
      );
    }

    const modelApiKey = effective.apiKey === undefined ? undefined : nonEmpty(effective.apiKey);
    if (modelApiKey !== undefined && effective.oauth !== undefined) {
      throw new Error2(CONFIG_INVALID_ERROR_CODE, `Model "${id}" has both apiKey and oauth set in config.toml - they are mutually exclusive. Remove one.`);
    }
    if (modelApiKey === undefined && effective.oauth === undefined && providerConfig !== undefined) {
      const hasConflict =
        effective.protocol === undefined && projection !== undefined
          ? projection.authConflict
          : resolveProviderApiKey({ ...providerConfig, type: providerConfig.type ?? effective.protocol }, adapter).apiKey !== undefined &&
            providerConfig.oauth !== undefined;
      if (hasConflict) {
        throw new Error2(CONFIG_INVALID_ERROR_CODE, `Provider "${providerName}" has both apiKey and oauth set in config.toml - they are mutually exclusive. Remove one.`);
      }
    }

    const generation = resolveGenerationParameters(providerConfig, record);
    const declaredCapabilities = effective.capabilities;
    let alwaysThinking = false;
    let declaredSet: Set<string> | undefined;
    if (declaredCapabilities !== undefined && declaredCapabilities.length > 0) {
      declaredSet = new Set<string>();
      for (const capability of declaredCapabilities) {
        declaredSet.add(capability.trim().toLowerCase());
      }
      alwaysThinking = declaredSet.has('always_thinking');
    }
    const selectedEffort = generation.values.thinkingEffort?.trim().toLowerCase();
    if (selectedEffort === 'off' && alwaysThinking) {
      throw new Error2(CONFIG_INVALID_ERROR_CODE, `Model "${id}" requires thinking; thinking_effort=off is unavailable`);
    }
    if (
      selectedEffort !== undefined &&
      selectedEffort !== 'on' &&
      selectedEffort !== 'off' &&
      effective.supportEfforts !== undefined &&
      effective.supportEfforts.length > 0 &&
      !effective.supportEfforts.includes(selectedEffort)
    ) {
      throw new Error2(CONFIG_INVALID_ERROR_CODE, `Model "${id}" does not support thinking effort "${selectedEffort}"`);
    }

    const resolveCapability =
      record.protocol === undefined && projection?.resolveCapability !== undefined
        ? projection.resolveCapability
        : this.getCapabilityResolver(protocol, effectiveProviderType, capabilityResolvers);
    const detected = resolveCapability(wireName);

    let effectiveCapabilities: string[] | undefined;
    if (declaredSet === undefined) {
      if (
        detected.image_in ||
        detected.video_in ||
        detected.audio_in ||
        detected.thinking ||
        detected.tool_use ||
        detected.dynamically_loaded_tools === true
      ) {
        effectiveCapabilities = [];
        if (detected.image_in) effectiveCapabilities.push('image_in');
        if (detected.video_in) effectiveCapabilities.push('video_in');
        if (detected.audio_in) effectiveCapabilities.push('audio_in');
        if (detected.thinking) effectiveCapabilities.push('thinking');
        if (detected.tool_use) effectiveCapabilities.push('tool_use');
        if (detected.dynamically_loaded_tools === true) effectiveCapabilities.push('dynamically_loaded_tools');
      } else if (declaredCapabilities !== undefined) {
        effectiveCapabilities = [];
      }
    } else {
      effectiveCapabilities = [];
      if (declaredSet.has('image_in') || detected.image_in) effectiveCapabilities.push('image_in');
      if (declaredSet.has('video_in') || detected.video_in) effectiveCapabilities.push('video_in');
      if (declaredSet.has('audio_in') || detected.audio_in) effectiveCapabilities.push('audio_in');
      if (declaredSet.has('thinking') || alwaysThinking || detected.thinking) effectiveCapabilities.push('thinking');
      if (declaredSet.has('tool_use') || detected.tool_use) effectiveCapabilities.push('tool_use');
      if (declaredSet.has('dynamically_loaded_tools') || detected.dynamically_loaded_tools === true) {
        effectiveCapabilities.push('dynamically_loaded_tools');
      }
      if (alwaysThinking) effectiveCapabilities.push('always_thinking');
    }

    const protocolSource =
      record.protocol !== undefined
        ? 'model'
        : projection !== undefined
          ? projection.protocolSource
          : explainModelProtocol(record, effectiveProviderType === undefined ? undefined : { type: effectiveProviderType })?.source;

    const bindingOrigins =
      projection !== undefined &&
      record.baseUrl === undefined &&
      record.protocol === undefined &&
      record.apiKey === undefined &&
      record.oauth === undefined
        ? projection.bindingOrigins
        : modelBindingOriginFields(record, providerConfig ?? (effectiveProviderType === undefined ? undefined : { type: effectiveProviderType }));

    const preferredThinkingEffort =
      generation.sources.thinkingEffort?.detail === '[models.*] legacy generation fields'
        ? undefined
        : generation.values.thinkingEffort;
    const serviceTier = isApiDefault(generation.values.serviceTier)
      ? undefined
      : generation.values.serviceTier;
    const rawRecipe = record.recipe?.trim();
    const recipe = rawRecipe === undefined || rawRecipe === '' || rawRecipe === 'off' ? undefined : rawRecipe;

    const item: ModelCatalogItem = {
      id,
      protocol: record.protocol,
      effective_protocol: protocol,
      protocol_source: protocolSource,
      endpoint_source: bindingOrigins.endpoint_source,
      auth_source: bindingOrigins.auth_source,
      provider_id: providerName,
      remote_id: wireName,
      display_name: effective.displayName ?? wireName,
      max_context_size: effective.maxContextSize,
      auto_compact: effective.autoCompact,
      context_strategy: effective.contextStrategy,
      capabilities: effective.capabilities,
      effective_capabilities: effectiveCapabilities,
      support_efforts: effective.supportEfforts === undefined ? undefined : [...effective.supportEfforts],
      default_effort: preferredThinkingEffort ?? record.overrides?.defaultEffort ?? effective.defaultEffort,
      service_tier: serviceTier,
      pricing_model: record.pricingModel,
      parameters: record.parameters === undefined ? undefined : parametersToWire(record.parameters),
      behavior: record.behavior === undefined ? undefined : modelBehaviorToWire(record.behavior),
      request_identity: record.requestIdentity === undefined ? undefined : requestIdentityToWire(record.requestIdentity),
      images: record.images === undefined
        ? undefined
        : {
            accepted_types: record.images.acceptedTypes === undefined ? undefined : [...record.images.acceptedTypes],
            convert_unsupported: record.images.convertUnsupported,
          },
      recipe,
      recipe_options: recipe === undefined ? undefined : record.recipeOptions,
    };
    if (bindingOrigins.endpoint_env !== undefined) {
      item.endpoint_env = bindingOrigins.endpoint_env;
    }
    if (bindingOrigins.auth_env !== undefined) {
      item.auth_env = bindingOrigins.auth_env;
    }

    if (projection?.isManaged === true || (projection === undefined && providerName.startsWith('managed:'))) {
      const resolvedBaseUrl =
        protocol === 'anthropic' && rawBaseUrl !== undefined
          ? stripTrailingV1(rawBaseUrl)
          : rawBaseUrl;
      return {
        item,
        managed: {
          id,
          name: wireName,
          protocol,
          baseUrl: resolvedBaseUrl,
          providerName,
        },
      };
    }

    return { item };
  }

  private managedCatalogIdentity(model: Pick<Model, 'providerName' | 'protocol' | 'baseUrl' | 'name'>): string | undefined {
    if (!model.providerName.startsWith('managed:')) return undefined;
    return [model.providerName, model.protocol, model.baseUrl ?? '', model.name].join('\u0000');
  }

  private compareManagedCatalogOptions(
    a: CatalogModelOption,
    b: CatalogModelOption,
    defaultModel: string | undefined = this.models.getDefaultModel(),
  ): number {
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
    await Promise.all([this.models.ready, this.providers.ready]);
    const providers = this.providers.list();
    const models = this.models.list();
    const modelsByProvider = groupModelIdsByProvider(models);
    const globalDefaultModel = this.models.getDefaultModel();
    return Promise.all(Object.entries(providers).map(([providerId, provider]) =>
      this.toCatalogProvider(providerId, provider, models, globalDefaultModel, modelsByProvider.get(providerId) ?? [])));
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
      model: toProtocolModel(model, record, this.providerTypeOf(record), this.providerConfigOf(record)),
    };
  }

  private async toCatalogProvider(
    providerId: string,
    provider: ProviderConfig,
    models: Readonly<Record<string, ModelRecord>>,
    globalDefaultModel: string | undefined,
    precomputedModels?: string[],
  ): Promise<ProviderCatalogItem> {
    const adapter = provider.type === undefined ? undefined : this.protocolRegistry.providerDefinition?.(provider.type);
    const credential = await resolveProviderCredentialState(providerId, provider, this.oauth, adapter);
    return toProtocolProvider(providerId, provider, models, globalDefaultModel, credential, precomputedModels);
  }

  private providerTypeOf(record: ModelRecord): string | undefined {
    return this.providerConfigOf(record)?.type ?? record.protocol;
  }

  private providerConfigOf(record: ModelRecord): ProviderConfig | undefined {
    const providerId =
      record.providerId ?? record.provider ?? this.providers.getDefaultProvider();
    return providerId === undefined ? undefined : this.providers.get(providerId);
  }

  private buildModel(
    id: string,
    trace: ResolutionTraceCollector,
    recipeSettings?: Record<string, unknown>,
    transientRecord?: ModelRecord,
  ): { model: Model; credentials: readonly string[] } {
    const savedModel = transientRecord ?? this.models.get(id);
    if (savedModel === undefined) {
      throw new Error2(
        CONFIG_INVALID_ERROR_CODE,
        `Model "${id}" is not configured in config.toml.`,
        { details: { model: id } },
      );
    }
    const configuredModel = applyModelSettings(savedModel, recipeSettings);
    trace.capture(TRACE.configuredModel, configuredModel);
    trace.record('model.record', { kind: 'config', detail: '[models.*] section' });

    const routingModel = effectiveModelConfig(configuredModel);
    const { providerConfig, providerName, resolvedBaseUrl: rawBaseUrl } =
      this.resolveProviderContext(id, routingModel, trace);
    if (decisionProtocolForProviderType(providerConfig?.type) !== undefined) {
      throw new Error2(CONFIG_INVALID_ERROR_CODE, 'Decision connections cannot be used for chat');
    }
    trace.capture(TRACE.providerConfig, providerConfig);
    trace.capture(TRACE.providerName, providerName);
    trace.capture(TRACE.rawBaseUrl, rawBaseUrl);

    const resolvedProtocol = this.resolveProtocol(id, routingModel, providerConfig, trace);
    const protocol = resolvedProtocol.protocol;
    const adapter = providerConfig?.type === undefined ? undefined : this.protocolRegistry.providerDefinition?.(providerConfig.type, protocol);
    const model = effectiveModelConfig(
      configuredModel,
      providerConfig?.type ?? configuredModel.protocol,
    );
    trace.capture(TRACE.effectiveModel, model);
    const generation = resolveGenerationParameters(providerConfig, configuredModel);
    trace.capture(TRACE.generationParameters, generation);
    const wireName = model.name ?? model.model;
    const profileAttribution = profileForAttribution(configuredModel, providerConfig, wireName);
    attributeEffectiveFields(
      trace,
      configuredModel,
      model,
      profileAttribution.profile,
      profileAttribution.inferred,
    );

    const providerType = providerConfig?.type ?? protocol;
    const resolvedBaseUrl =
      protocol === 'anthropic' && rawBaseUrl !== undefined
        ? stripTrailingV1(rawBaseUrl)
        : rawBaseUrl;
    const auth = resolveModelAuthMaterial(
      {
        modelId: id,
        model,
        provider: providerConfig,
        providerName,
        adapter,
      },
      trace,
    );
    trace.capture(TRACE.authMaterial, auth);
    const authProvider = this.buildAuthProvider(providerName, auth);
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
    const imagePolicy = resolveImagePolicy(providerType, providerConfig?.images, configuredModel.images);
    const providerOptions = buildProtocolProviderOptions(
      model,
      protocol,
      providerConfig,
      resolvedBaseUrl,
      imagePolicy.acceptedTypes,
    );
    if (providerOptions !== undefined) {
      attributeProviderOptions(trace, providerOptions, providerConfig?.env);
    }
    const declared = new Set((model.capabilities ?? []).map((c) => c.trim().toLowerCase()));
    const selectedEffort = generation.values.thinkingEffort?.trim().toLowerCase();
    if (selectedEffort === 'off' && declared.has('always_thinking')) {
      throw new Error2(CONFIG_INVALID_ERROR_CODE, `Model "${id}" requires thinking; thinking_effort=off is unavailable`);
    }
    if (selectedEffort !== undefined && selectedEffort !== 'on' && selectedEffort !== 'off'
      && model.supportEfforts !== undefined && model.supportEfforts.length > 0
      && !model.supportEfforts.includes(selectedEffort)) {
      throw new Error2(CONFIG_INVALID_ERROR_CODE, `Model "${id}" does not support thinking effort "${selectedEffort}"`);
    }

    trace.capture(TRACE.hostHeaders, this.hostRequestHeaders.headers);
    trace.capture(TRACE.thirdPartyHeaders, this.hostRequestHeaders.thirdPartyHeaders);
    trace.capture(TRACE.identitySlug, this.hostRequestHeaders.identitySlug);
    const headers = applyModelHintHeader(
      resolveOutboundHeaders(providerConfig?.type, providerConfig?.customHeaders, this.hostRequestHeaders, adapter),
      providerConfig?.modelHintHeader,
      wireName,
    );
    return {
      model: {
        id,
        name: wireName,
        pricingModel: configuredModel.pricingModel,
        aliases: model.aliases ?? [],
        protocol,
        protocolSource: resolvedProtocol.source,
        baseUrl: resolvedBaseUrl,
        requestCompression: resolveRequestCompression(
          this.providers.transportDefaults().requestCompression,
          providerConfig?.requestCompression,
        ),
        responsesWebSocket: resolveResponsesWebSocket(
          this.providers.transportDefaults().responsesWebSocket,
          providerConfig?.responsesWebSocket,
        ),
        anthropicMessageThreads: resolveAnthropicMessageThreads(
          this.providers.transportDefaults().anthropicMessageThreads,
          providerConfig?.anthropicMessageThreads,
        ),
        headers,
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
        autoCompact: model.autoCompact,
        contextStrategy: model.contextStrategy,
        maxCompletionTokens: generation.values.maxCompletionTokens,
        requestParams: model.requestParams,
        serviceTier: isApiDefault(generation.values.serviceTier) ? undefined : generation.values.serviceTier,
        generationParameters: generation.values,
        usageParameters: {
          main: resolveModelUsage(generation, configuredModel, 'main'),
          sub: resolveModelUsage(generation, configuredModel, 'sub'),
          independent: resolveModelUsage(generation, configuredModel, 'independent'),
        },
        preferredThinkingEffort: generation.sources.thinkingEffort?.detail === '[models.*] legacy generation fields'
          ? undefined : generation.values.thinkingEffort,
        alwaysThinking: declared.has('always_thinking'),
        providerType,
        providerName,
        imagePolicy,
        authProvider,
        credentialSource: auth.apiKey !== undefined ? (model.apiKey !== undefined ? 'model' : providerConfig?.apiKey?.trim() ? 'provider' : 'env') : auth.oauth !== undefined ? 'oauth' : Object.values(providerConfig?.customHeaders ?? {}).some(Boolean) || Object.keys(headers).some((name) => /^(authorization|x-api-key)$/i.test(name) && headers[name]) ? 'headers' : 'none',
        credentialEnv: model.apiKey === undefined ? resolveProviderApiKey({ ...providerConfig, type: providerType }, adapter).envName : undefined,
        providerOptions,
      },
      credentials: probeCredentials(auth),
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
    const providerId = resolveModelProviderId(model, this.providers.getDefaultProvider());
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
      const adapter = providerConfig.type === undefined ? undefined : this.protocolRegistry.providerDefinition?.(providerConfig.type, model.protocol);
      const baseUrl = resolveConfiguredModelBaseUrl(model, providerConfig, adapter);
      if (nonEmpty(model.baseUrl) !== undefined) {
        trace.record('resolved.baseUrl', { kind: 'config', detail: 'model.baseUrl' });
      } else if (nonEmpty(providerConfig.baseUrl) !== undefined) {
        trace.record('resolved.baseUrl', {
          kind: 'config',
          detail: `provider '${providerId}' baseUrl`,
        });
      } else {
        const endpointType = providerConfig.type ?? model.protocol;
        const endpoint =
          endpointType === undefined
            ? {}
            : explainProviderEndpoint(endpointType, providerConfig.env ?? {}, adapter);
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
  ): ExplainedModelProtocol {
    const adapter = provider?.type === undefined ? undefined : this.protocolRegistry.providerDefinition?.(provider.type, model.protocol);
    const protocol = explainModelProtocol(model, provider, trace, adapter);
    if (protocol !== undefined) return protocol;
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
          return oauthRequestAuth(providerKey, oauthRef, apiKey);
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
  adapter: ProviderAdapterDefinition | undefined = providerType === undefined ? undefined : getProviderDefinition(providerType),
): Readonly<Record<string, string>> {
  const forwardsAll = adapter?.hostHeaders === 'full';
  const hostLayer = forwardsAll ? host.headers : host.thirdPartyHeaders;
  return { ...parseKimiCodeCustomHeaders(), ...hostLayer, ...customHeaders };
}

function applyModelHintHeader(
  headers: Readonly<Record<string, string>>,
  modelHintHeader: string | undefined,
  modelName: string,
): Readonly<Record<string, string>> {
  const headerName = modelHintHeader?.trim();
  if (headerName === undefined || headerName.length === 0) return headers;
  const normalizedTarget = headerName.toLowerCase();
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedTarget) continue;
    out[key] = value;
  }
  out[headerName] = modelName;
  return out;
}

/**
 * Connection state shared by catalog reads and config mutations. An API key
 * is configured only when its inline or environment value resolves; a cached
 * OAuth token independently marks an OAuth connection as active.
 */
export async function resolveProviderCredentialState(
  providerId: string,
  provider: ProviderConfig,
  oauth: Pick<IModelOAuthTokens, 'hasCachedAccessToken'>,
  adapter?: ProviderAdapterDefinition,
): Promise<ProviderCredentialState> {
  const key = resolveProviderApiKey(provider, adapter);
  return {
    hasApiKey: key.apiKey !== undefined,
    hasOAuthToken:
      provider.oauth === undefined
        ? false
        : await oauth.hasCachedAccessToken(providerId, provider.oauth),
  };
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
  acceptedImageMimes: ReadonlySet<string>,
): ProtocolProviderOptions | undefined {
  const options: MutableProtocolProviderOptions = {};

  switch (protocol) {
    case 'anthropic':
      if (model.maxOutputSize !== undefined) options.defaultMaxTokens = model.maxOutputSize;
      if (model.supportEfforts !== undefined) options.supportEfforts = model.supportEfforts;
      if (model.adaptiveThinking !== undefined) options.adaptiveThinking = model.adaptiveThinking;
      if (model.betaApi !== undefined) options.betaApi = model.betaApi;
      options.acceptedImageMimes = acceptedImageMimes;
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
      } else if (provider?.type === 'vertexai') {
        options.vertexai = true;
        if (project !== undefined) options.project = project;
        if (location !== undefined) options.location = location;
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

function computeEnvFingerprint(envKeys: readonly string[]): string {
  if (envKeys.length === 0) return '';
  const parts: string[] = [];
  for (const key of envKeys) {
    const value = process.env[key];
    parts.push(`${key}=${value === undefined ? '\u0001' : value}`);
  }
  return parts.join('\u0000');
}

function probeCredentials(auth: ResolvedModelAuthMaterial): string[] {
  return auth.apiKey === undefined ? [] : [auth.apiKey];
}

registerScopedService(
  LifecycleScope.App,
  IModelCatalog,
  ModelCatalog,
  ScopeActivation.OnScopeCreated,
  'modelCatalog',
);
