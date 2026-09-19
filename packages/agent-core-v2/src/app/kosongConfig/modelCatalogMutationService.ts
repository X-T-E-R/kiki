import { createHash } from 'node:crypto';

import {
  createModelRequestSchema,
  createProviderRequestSchema,
  patchModelRequestSchema,
  patchProviderRequestSchema,
  type CreateModelRequest,
  type CreateProviderRequest,
  type ImagePolicyPatch,
  type ImagePolicyWire,
  type ModelEntity,
  type ModelIssue,
  type ModelProviderSource,
  type PatchModelRequest,
  type PatchProviderRequest,
} from '@kiki/protocol';

import { Disposable } from '#/_base/di/lifecycle';
import { Error2 } from '#/_base/errors/errors';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ConfigTarget, IConfigService } from '#/app/config/config';
import { deepEqual } from '#/app/config/sectionDiff';
import { CONFIG_INVALID_ERROR_CODE } from '#/kosong/contract/errors';
import { toProtocolProvider } from '#/kosong/model/catalog';
import { resolveProviderCredentialState } from '#/kosong/model/catalogService';
import { ModelCatalogErrors } from '#/kosong/model/errors';
import { deriveProviderId, nonEmpty } from '#/kosong/model/modelAuth';
import { IModelOAuthTokens } from '#/kosong/model/modelOAuth';
import type { ModelRecord, ModelsSection } from '#/kosong/model/model';
import { ProtocolSchema } from '#/kosong/protocol/protocol';
import type { ProviderConfig, ProvidersSection } from '#/kosong/provider/provider';
import { getProviderDefinition } from '#/kosong/provider/providerDefinition';
import type { ImagePolicyConfig } from '#/kosong/provider/providerImagePolicy';
import {
  requestIdentityFromWire,
  requestIdentityToWire,
  resolveProviderRequestIdentity,
} from '#/kosong/requestIdentity/requestIdentityPolicy';

import { ModelsDevImportErrors } from './errors';
import {
  DEFAULT_MODEL_SECTION,
  DEFAULT_PROVIDER_SECTION,
  MODELS_SECTION,
  PROVIDERS_SECTION,
} from './configSection';
import {
  IModelCatalogMutationService,
  ModelIssueCodes,
  type ProviderEntity,
} from './modelCatalogMutation';

interface ParsedLike<T> {
  parse(value: unknown): T;
}

function parseOrThrow<T>(schema: ParsedLike<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    const issues = zodIssues(error);
    throw new Error2(
      CONFIG_INVALID_ERROR_CODE,
      issues.length === 0
        ? 'invalid model catalog payload'
        : issues.map((issue) => (issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`)).join('; '),
      { details: { issues }, cause: error },
    );
  }
}

function zodIssues(error: unknown): Array<{ path: string; message: string }> {
  if (typeof error !== 'object' || error === null) return [];
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  return issues.map((issue) => {
    const record = issue as { path?: unknown; message?: unknown };
    const path = Array.isArray(record.path) ? record.path.map(String).join('.') : '';
    return { path, message: typeof record.message === 'string' ? record.message : 'invalid' };
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries: string[] = [];
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      entries.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
    }
    return `{${entries.toSorted().join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function revisionOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 16);
}

function providersOf(config: IConfigService): ProvidersSection {
  return config.inspect<ProvidersSection>(PROVIDERS_SECTION).userValue ?? {};
}

function modelsOf(config: IConfigService): ModelsSection {
  return config.inspect<ModelsSection>(MODELS_SECTION).userValue ?? {};
}

function defaultProviderOf(config: IConfigService): string | undefined {
  return nonEmpty(config.inspect<string>(DEFAULT_PROVIDER_SECTION).userValue);
}

function defaultModelOf(config: IConfigService): string | undefined {
  return nonEmpty(config.inspect<string>(DEFAULT_MODEL_SECTION).userValue);
}

function providerRefOf(record: ModelRecord): string | undefined {
  return nonEmpty(record.providerId) ?? nonEmpty(record.provider);
}

function resolveProviderRef(
  record: ModelRecord,
  defaultProvider: string | undefined,
): { readonly providerId: string; readonly source: ModelProviderSource } {
  const explicit = nonEmpty(record.providerId);
  if (explicit !== undefined) return { providerId: explicit, source: 'provider_id' };
  const legacy = nonEmpty(record.provider);
  if (legacy !== undefined) return { providerId: legacy, source: 'provider' };
  if (defaultProvider !== undefined) {
    return { providerId: defaultProvider, source: 'default_provider' };
  }
  const baseUrl = nonEmpty(record.baseUrl);
  return { providerId: baseUrl === undefined ? '' : deriveProviderId(baseUrl), source: 'flat' };
}

function hasResolvableProtocol(record: ModelRecord, provider: ProviderConfig | undefined): boolean {
  if (record.protocol !== undefined) return true;
  const type = provider?.type;
  if (type === undefined) return false;
  if (ProtocolSchema.safeParse(type).success) return true;
  return getProviderDefinition(type) !== undefined;
}

function modelIssues(
  record: ModelRecord,
  providers: ProvidersSection,
  ref: { readonly providerId: string; readonly source: ModelProviderSource },
): ModelIssue[] {
  const issues: ModelIssue[] = [];
  const provider = ref.source === 'flat' ? undefined : providers[ref.providerId];
  const providerMissing = ref.source !== 'flat' && provider === undefined;
  if (nonEmpty(record.name) === undefined && nonEmpty(record.model) === undefined) {
    issues.push({
      code: ModelIssueCodes.REMOTE_ID_MISSING,
      severity: 'error',
      path: 'remote_id',
      message: 'the model must name the remote model id it sends upstream',
    });
  }
  if (providerMissing) {
    issues.push({
      code: ModelIssueCodes.PROVIDER_MISSING,
      severity: 'error',
      path: 'provider_id',
      message: `provider "${ref.providerId}" is not configured`,
    });
  }
  if (ref.source === 'flat' && nonEmpty(record.baseUrl) === undefined) {
    issues.push({
      code: ModelIssueCodes.ENDPOINT_MISSING,
      severity: 'error',
      path: 'base_url',
      message: 'the model must reference a provider or declare its own base_url',
    });
  }
  if (record.maxContextSize === undefined) {
    issues.push({
      code: ModelIssueCodes.CONTEXT_MISSING,
      severity: 'warning',
      path: 'max_context_size',
      message: 'the model must declare a max_context_size before it can run',
    });
  }
  if (!providerMissing && !hasResolvableProtocol(record, provider)) {
    issues.push({
      code: ModelIssueCodes.PROTOCOL_UNRESOLVED,
      severity: 'warning',
      path: 'protocol',
      message: 'the model protocol cannot be resolved from the model or its provider type',
    });
  }
  if (record.requestIdentity !== undefined) {
    try {
      resolveProviderRequestIdentity({ requestIdentity: record.requestIdentity });
    } catch (error) {
      issues.push({
        code: ModelIssueCodes.REQUEST_IDENTITY_INVALID,
        severity: 'error',
        path: 'request_identity',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return issues;
}

function modelEntity(
  id: string,
  record: ModelRecord,
  providers: ProvidersSection,
  defaultProvider: string | undefined,
): ModelEntity {
  const ref = resolveProviderRef(record, defaultProvider);
  return {
    id,
    provider_id: ref.providerId,
    provider_source: ref.source,
    remote_id: nonEmpty(record.name) ?? nonEmpty(record.model),
    display_name: record.displayName,
    max_context_size: record.maxContextSize,
    max_input_size: record.maxInputSize,
    max_output_size: record.maxOutputSize,
    capabilities: record.capabilities,
    support_efforts: record.supportEfforts,
    default_effort: record.defaultEffort,
    adaptive_thinking: record.adaptiveThinking,
    service_tier: record.serviceTier,
    request_identity: requestIdentityToWire(record.requestIdentity),
    images: imagePolicyToWire(record.images),
    protocol: record.protocol,
    base_url: record.baseUrl,
    revision: revisionOf(record),
    issues: modelIssues(record, providers, ref),
  };
}

function writableRecord(record: ModelRecord): Record<string, unknown> {
  return { ...record } as Record<string, unknown>;
}

function assertTokenBudget(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error2(CONFIG_INVALID_ERROR_CODE, `${field} must be a positive integer`);
  }
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      out[key] = withoutUndefined(entry);
    }
    return out;
  }
  return value;
}

function setCleared(target: object, key: string): void {
  (target as Record<string, unknown>)[key] = undefined;
}

function imagePolicyFromWire(value: ImagePolicyWire): ImagePolicyConfig {
  return {
    acceptedTypes: value.accepted_types,
    convertUnsupported: value.convert_unsupported,
  };
}

function imagePolicyToWire(value: ImagePolicyConfig | undefined): ImagePolicyWire | undefined {
  if (value === undefined) return undefined;
  return {
    accepted_types: value.acceptedTypes,
    convert_unsupported: value.convertUnsupported,
  };
}

function applyImagePolicyPatch(
  current: ImagePolicyConfig | undefined,
  patch: ImagePolicyPatch | null | undefined,
): ImagePolicyConfig | undefined {
  if (patch === undefined) return current;
  if (patch === null) return undefined;
  const next: ImagePolicyConfig = { ...current };
  if (patch.accepted_types !== undefined) {
    next.acceptedTypes = patch.accepted_types === null ? undefined : patch.accepted_types;
  }
  if (patch.convert_unsupported !== undefined) {
    next.convertUnsupported =
      patch.convert_unsupported === null ? undefined : patch.convert_unsupported;
  }
  return next;
}

function applyModelPatch(record: ModelRecord, patch: PatchModelRequest): ModelRecord {
  const next = writableRecord(record);
  const setOrClear = (key: string, value: unknown): void => {
    if (value === undefined) return;
    if (value === null) {
      setCleared(next, key);
      return;
    }
    next[key] = value;
  };
  if (patch.remote_id !== undefined) {
    next['model'] = patch.remote_id;
    if (next['name'] !== undefined) next['name'] = patch.remote_id;
  }
  if (patch.max_context_size !== undefined && patch.max_context_size !== null) {
    assertTokenBudget('max_context_size', patch.max_context_size);
  }
  if (patch.max_input_size !== undefined && patch.max_input_size !== null) {
    assertTokenBudget('max_input_size', patch.max_input_size);
  }
  if (patch.max_output_size !== undefined && patch.max_output_size !== null) {
    assertTokenBudget('max_output_size', patch.max_output_size);
  }
  setOrClear('displayName', patch.display_name);
  setOrClear('maxContextSize', patch.max_context_size);
  setOrClear('maxInputSize', patch.max_input_size);
  setOrClear('maxOutputSize', patch.max_output_size);
  setOrClear('capabilities', patch.capabilities);
  setOrClear('supportEfforts', patch.support_efforts);
  setOrClear('defaultEffort', patch.default_effort);
  setOrClear('adaptiveThinking', patch.adaptive_thinking);
  setOrClear('serviceTier', patch.service_tier);
  if (patch.request_identity !== undefined) {
    if (patch.request_identity === null) {
      setCleared(next, 'requestIdentity');
    } else {
      const policy = requestIdentityFromWire(patch.request_identity);
      resolveProviderRequestIdentity({ requestIdentity: policy });
      next['requestIdentity'] = policy;
    }
  }
  if (patch.images !== undefined) {
    if (patch.images === null) {
      setCleared(next, 'images');
    } else {
      next['images'] = applyImagePolicyPatch(record.images, patch.images);
    }
  }
  return next as ModelRecord;
}

function applyProviderPatch(provider: ProviderConfig, patch: PatchProviderRequest): ProviderConfig {
  const next: ProviderConfig = { ...provider };
  if (patch.type !== undefined) next.type = patch.type;
  if (patch.base_url !== undefined) {
    if (patch.base_url !== null && patch.base_url.includes('${')) {
      throw new Error2(
        CONFIG_INVALID_ERROR_CODE,
        'base_url must not contain an environment variable placeholder',
      );
    }
    const baseUrl = patch.base_url === null ? undefined : nonEmpty(patch.base_url);
    if (baseUrl === undefined) {
      setCleared(next, 'baseUrl');
    } else {
      next.baseUrl = baseUrl;
    }
  }
  if (patch.default_model !== undefined) {
    const defaultModel = patch.default_model === null ? undefined : nonEmpty(patch.default_model);
    if (defaultModel === undefined) {
      setCleared(next, 'defaultModel');
    } else {
      next.defaultModel = defaultModel;
    }
  }
  if (patch.request_identity !== undefined) {
    if (patch.request_identity === null) {
      setCleared(next, 'requestIdentity');
    } else {
      const policy = requestIdentityFromWire(patch.request_identity);
      resolveProviderRequestIdentity({ requestIdentity: policy });
      next.requestIdentity = policy;
    }
  }
  if (patch.images !== undefined) {
    if (patch.images === null) {
      setCleared(next, 'images');
    } else {
      next.images = applyImagePolicyPatch(provider.images, patch.images);
    }
  }
  if (patch.api_key !== undefined) {
    if (patch.api_key === '') {
      setCleared(next, 'apiKey');
    } else {
      next.apiKey = patch.api_key;
    }
  }
  return next;
}

function conflictError(
  entity: 'model' | 'provider',
  id: string,
  expected: string | undefined,
  actual: string,
  current: Record<string, unknown>,
): Error2 {
  return new Error2(
    ModelCatalogErrors.codes.REVISION_CONFLICT,
    `${entity} "${id}" changed since it was read; reload it and reapply the edit`,
    {
      details: {
        entity,
        id,
        expected_revision: expected,
        actual_revision: actual,
        current,
      },
    },
  );
}

function oauthManagedError(id: string, detail: string): Error2 {
  return new Error2(
    ModelsDevImportErrors.codes.PROVIDER_OAUTH_MANAGED,
    `provider ${id} is managed by OAuth login; ${detail} instead`,
  );
}

export class ModelCatalogMutationService
  extends Disposable
  implements IModelCatalogMutationService
{
  declare readonly _serviceBrand: undefined;

  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IModelOAuthTokens private readonly oauth: IModelOAuthTokens,
  ) {
    super();
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async providerEntity(id: string, provider: ProviderConfig): Promise<ProviderEntity> {
    const credential = await resolveProviderCredentialState(id, provider, this.oauth);
    return {
      ...toProtocolProvider(id, provider, modelsOf(this.config), defaultModelOf(this.config), credential),
      revision: revisionOf(provider),
    };
  }

  async readModel(id: string): Promise<ModelEntity> {
    await this.config.ready;
    return this.currentModelEntity(id);
  }

  async readProvider(id: string): Promise<ProviderEntity> {
    await this.config.ready;
    const provider = providersOf(this.config)[id];
    if (provider === undefined) {
      throw new Error2(ModelCatalogErrors.codes.PROVIDER_NOT_FOUND, `provider ${id} does not exist`);
    }
    return this.providerEntity(id, provider);
  }

  private currentModelEntity(id: string): ModelEntity {
    const record = modelsOf(this.config)[id];
    if (record === undefined) {
      throw new Error2(ModelCatalogErrors.codes.MODEL_NOT_FOUND, `model ${id} does not exist`);
    }
    return modelEntity(id, record, providersOf(this.config), defaultProviderOf(this.config));
  }

  async createModel(input: CreateModelRequest): Promise<ModelEntity> {
    await this.config.ready;
    return this.enqueue(async () => {
      const request = parseOrThrow(createModelRequestSchema, input);
      const models = modelsOf(this.config);
      const providers = providersOf(this.config);
      const providerId = request.provider_id;
      if (providers[providerId] === undefined) {
        throw new Error2(
          ModelCatalogErrors.codes.PROVIDER_NOT_FOUND,
          `provider ${providerId} does not exist`,
        );
      }
      const id = nonEmpty(request.id) ?? `${providerId}/${request.remote_id}`;
      if (models[id] !== undefined) {
        throw new Error2(ModelCatalogErrors.codes.MODEL_ALREADY_EXISTS, `model ${id} already exists`);
      }
      if (request.max_context_size !== undefined) {
        assertTokenBudget('max_context_size', request.max_context_size);
      }
      const record: ModelRecord = { provider: providerId, model: request.remote_id };
      if (request.display_name !== undefined) record.displayName = request.display_name;
      if (request.max_context_size !== undefined) record.maxContextSize = request.max_context_size;
      if (request.max_input_size !== undefined) record.maxInputSize = request.max_input_size;
      if (request.max_output_size !== undefined) record.maxOutputSize = request.max_output_size;
      if (request.capabilities !== undefined) record.capabilities = [...request.capabilities];
      if (request.support_efforts !== undefined) {
        record.supportEfforts = [...request.support_efforts];
      }
      if (request.default_effort !== undefined) record.defaultEffort = request.default_effort;
      if (request.adaptive_thinking !== undefined) {
        record.adaptiveThinking = request.adaptive_thinking;
      }
      if (request.service_tier !== undefined) record.serviceTier = request.service_tier;
      if (request.images !== undefined) record.images = imagePolicyFromWire(request.images);
      if (request.request_identity !== undefined) {
        const policy = requestIdentityFromWire(request.request_identity);
        resolveProviderRequestIdentity({ requestIdentity: policy });
        record.requestIdentity = policy;
      }
      await this.writeSections({
        [MODELS_SECTION]: { ...models, [id]: record },
      });
      return modelEntity(id, record, providers, defaultProviderOf(this.config));
    });
  }

  async updateModel(id: string, patch: PatchModelRequest): Promise<ModelEntity> {
    await this.config.ready;
    return this.enqueue(async () => {
      const request = parseOrThrow(patchModelRequestSchema, patch);
      const models = modelsOf(this.config);
      const record = models[id];
      if (record === undefined) {
        throw new Error2(ModelCatalogErrors.codes.MODEL_NOT_FOUND, `model ${id} does not exist`);
      }
      const currentRevision = revisionOf(record);
      const next = applyModelPatch(record, request);
      if (deepEqual(next, record)) return this.currentModelEntity(id);
      if (request.base_revision !== undefined && request.base_revision !== currentRevision) {
        throw conflictError('model', id, request.base_revision, currentRevision, {
          ...this.currentModelEntity(id),
        });
      }
      await this.writeSections(
        { [MODELS_SECTION]: { ...models, [id]: next } },
        { [MODELS_SECTION]: models },
        () =>
          conflictError('model', id, request.base_revision, revisionOf(modelsOf(this.config)[id] ?? next), {
            ...this.currentModelEntity(id),
          }),
      );
      return modelEntity(id, next, providersOf(this.config), defaultProviderOf(this.config));
    });
  }

  async deleteModel(id: string, options?: { readonly baseRevision?: string }): Promise<void> {
    await this.config.ready;
    await this.enqueue(async () => {
      const models = modelsOf(this.config);
      const record = models[id];
      if (record === undefined) {
        throw new Error2(ModelCatalogErrors.codes.MODEL_NOT_FOUND, `model ${id} does not exist`);
      }
      const currentRevision = revisionOf(record);
      if (options?.baseRevision !== undefined && options.baseRevision !== currentRevision) {
        throw conflictError('model', id, options.baseRevision, currentRevision, {
          ...this.currentModelEntity(id),
        });
      }
      const { [id]: _removed, ...rest } = models;
      await this.writeSections(
        { [MODELS_SECTION]: rest },
        { [MODELS_SECTION]: models },
      );
    });
  }

  async createProvider(input: CreateProviderRequest): Promise<ProviderEntity> {
    await this.config.ready;
    return this.enqueue(async () => {
      const request = parseOrThrow(createProviderRequestSchema, input);
      const providers = providersOf(this.config);
      const models = modelsOf(this.config);
      const id = request.id;
      if (providers[id] !== undefined) {
        throw new Error2(
          ModelCatalogErrors.codes.PROVIDER_ALREADY_EXISTS,
          `provider ${id} already exists`,
        );
      }
      for (const entry of request.models ?? []) {
        const alias = `${id}/${entry.remote_id}`;
        if (models[alias] !== undefined) {
          throw new Error2(
            ModelCatalogErrors.codes.MODEL_ALREADY_EXISTS,
            `model ${alias} already exists`,
          );
        }
      }
      const provider: ProviderConfig = { type: request.type };
      if (request.api_key !== undefined && request.api_key !== '') provider.apiKey = request.api_key;
      const baseUrl = request.base_url === undefined ? undefined : nonEmpty(request.base_url);
      if (baseUrl !== undefined) provider.baseUrl = baseUrl;
      if (request.images !== undefined) provider.images = imagePolicyFromWire(request.images);
      if (request.request_identity !== undefined) {
        const policy = requestIdentityFromWire(request.request_identity);
        resolveProviderRequestIdentity({ requestIdentity: policy });
        provider.requestIdentity = policy;
      }
      const nextModels: ModelsSection = { ...models };
      for (const entry of request.models ?? []) {
        if (entry.max_context_size !== undefined) {
          assertTokenBudget('max_context_size', entry.max_context_size);
        }
        const record: ModelRecord = { provider: id, model: entry.remote_id };
        if (entry.display_name !== undefined) record.displayName = entry.display_name;
        if (entry.max_context_size !== undefined) record.maxContextSize = entry.max_context_size;
        if (entry.capabilities !== undefined) record.capabilities = [...entry.capabilities];
        if (entry.max_output_size !== undefined) record.maxOutputSize = entry.max_output_size;
        if (entry.support_efforts !== undefined) {
          record.supportEfforts = [...entry.support_efforts];
        }
        if (entry.adaptive_thinking !== undefined) {
          record.adaptiveThinking = entry.adaptive_thinking;
        }
        if (entry.images !== undefined) record.images = imagePolicyFromWire(entry.images);
        if (entry.request_identity !== undefined) {
          const policy = requestIdentityFromWire(entry.request_identity);
          resolveProviderRequestIdentity({ requestIdentity: policy });
          record.requestIdentity = policy;
        }
        nextModels[`${id}/${entry.remote_id}`] = record;
      }
      if (request.default_model !== undefined) {
        provider.defaultModel = `${id}/${request.default_model}`;
      }
      const sections: Record<string, unknown> = {
        [PROVIDERS_SECTION]: { ...providers, [id]: provider },
        [MODELS_SECTION]: nextModels,
      };
      const firstEntry = (request.models ?? [])[0];
      if (defaultModelOf(this.config) === undefined && firstEntry !== undefined) {
        sections[DEFAULT_MODEL_SECTION] = provider.defaultModel ?? `${id}/${firstEntry.remote_id}`;
      }
      await this.writeSections(sections);
      return this.providerEntity(id, provider);
    });
  }

  async updateProvider(id: string, patch: PatchProviderRequest): Promise<ProviderEntity> {
    await this.config.ready;
    return this.enqueue(async () => {
      const request = parseOrThrow(patchProviderRequestSchema, patch);
      const providers = providersOf(this.config);
      const provider = providers[id];
      if (provider === undefined) {
        throw new Error2(ModelCatalogErrors.codes.PROVIDER_NOT_FOUND, `provider ${id} does not exist`);
      }
      const currentRevision = revisionOf(provider);
      if (provider.oauth !== undefined) {
        if (request.type !== undefined && request.type !== provider.type) {
          throw oauthManagedError(id, 'use POST /oauth/logout to change it');
        }
        if (request.api_key !== undefined) {
          throw oauthManagedError(id, 'use POST /oauth/logout to replace its credential');
        }
      }
      const next = applyProviderPatch(provider, request);
      if (request.default_model !== undefined && next.defaultModel !== undefined) {
        const bound = modelsOf(this.config)[next.defaultModel];
        if (bound === undefined || providerRefOf(bound) !== id) {
          throw new Error2(
            CONFIG_INVALID_ERROR_CODE,
            `default_model ${next.defaultModel} is not a model of provider ${id}`,
          );
        }
      }
      if (deepEqual(next, provider)) return this.providerEntity(id, provider);
      if (request.base_revision !== undefined && request.base_revision !== currentRevision) {
        throw conflictError('provider', id, request.base_revision, currentRevision, {
          ...(await this.providerEntity(id, provider)),
        });
      }
      await this.writeSections(
        { [PROVIDERS_SECTION]: { ...providers, [id]: next } },
        { [PROVIDERS_SECTION]: providers },
        async () =>
          conflictError('provider', id, request.base_revision, revisionOf(providersOf(this.config)[id] ?? next), {
            ...(await this.providerEntity(id, providersOf(this.config)[id] ?? next)),
          }),
      );
      return this.providerEntity(id, next);
    });
  }

  async deleteProvider(id: string): Promise<void> {
    await this.config.ready;
    await this.enqueue(async () => {
      const providers = providersOf(this.config);
      const provider = providers[id];
      if (provider === undefined) {
        throw new Error2(ModelCatalogErrors.codes.PROVIDER_NOT_FOUND, `provider ${id} does not exist`);
      }
      if (provider.oauth !== undefined) {
        throw oauthManagedError(id, 'use POST /oauth/logout');
      }
      const models = modelsOf(this.config);
      const { [id]: _removedProvider, ...restProviders } = providers;
      const restModels = Object.fromEntries(
        Object.entries(models).filter(([, record]) => providerRefOf(record) !== id),
      );
      await this.writeSections(
        { [PROVIDERS_SECTION]: restProviders, [MODELS_SECTION]: restModels },
        { [PROVIDERS_SECTION]: providers, [MODELS_SECTION]: models },
      );
    });
  }

  /**
   * One config transaction. `expected` turns the write into a compare-and-swap
   * on the section it read, and `onStale` converts a lost race into the same
   * structured conflict the revision check reports. Both sides are deep copies:
   * the config layer reads the write value's own `undefined` properties as
   * "remove this key", and the expected value must not alias the live section
   * the engine keeps mutating in place.
   */
  private async writeSections(
    sections: Readonly<Record<string, unknown>>,
    expected?: Readonly<Record<string, unknown>>,
    onStale?: () => Error2 | Promise<Error2>,
  ): Promise<void> {
    try {
      await this.config.replaceSections(
        structuredClone(sections),
        ConfigTarget.User,
        expected === undefined
          ? undefined
          : (withoutUndefined(structuredClone(expected)) as Record<string, unknown>),
      );
    } catch (error) {
      if (onStale !== undefined && error instanceof Error2 && error.code === CONFIG_INVALID_ERROR_CODE) {
        throw await onStale();
      }
      throw error;
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  IModelCatalogMutationService,
  ModelCatalogMutationService,
  ScopeActivation.OnScopeCreated,
  'kosongConfig',
);
