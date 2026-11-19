import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { CoreErrors } from '#/_base/errors/codes';
import { BugIndicatingError, Error2 } from '#/_base/errors/errors';
import { LifecycleScope } from '#/app/scopes';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { ModelRecord } from '#/kosong/model/model';

import { BUILT_IN_MODELS_DEV_JSON } from './builtInModelsDev';
import { ModelsDevImportErrors } from './errors';
import {
  modelsDevProviderModels,
  resolveModelsDevImport,
  type ModelsDevCatalog,
  type ModelsDevModel,
  type ModelsDevProviderEntry,
} from './modelsDev';
import type { ModelsDevModelItem, ModelsDevProviderItem } from './modelsDevImport';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 10 * 60 * 1000;
export const UPSTREAM_FETCH_TIMEOUT_MS = 10_000;

export function loadBuiltInModelsDevCatalog(text?: string): ModelsDevCatalog | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  try {
    return JSON.parse(text) as ModelsDevCatalog;
  } catch {
    return undefined;
  }
}

interface ModelsDevCacheEntry {
  readonly catalog: ModelsDevCatalog;
  readonly fetchedAt: number;
}

export interface ModelsDevUpstreamOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly builtInCatalog?: ModelsDevCatalog;
}

export interface IModelsDevUpstreamService {
  readonly _serviceBrand: undefined;
  upstreamFetch(): typeof fetch;
  getCatalog(
    userAgent: string | (() => Promise<string>),
    options?: { preferLocal?: boolean },
  ): Promise<ModelsDevCatalog>;
}

export const IModelsDevUpstreamService: ServiceIdentifier<IModelsDevUpstreamService> =
  createDecorator<IModelsDevUpstreamService>('modelsDevUpstreamService');

interface TestUpstreamOverrides {
  fetchImpl?: typeof fetch;
  now?: () => number;
  builtInCatalog?: ModelsDevCatalog;
}

let testOverrides: TestUpstreamOverrides | undefined;
const trackedClients = new Set<WeakRef<ModelsDevUpstreamClient>>();

export class ModelsDevUpstreamClient implements IModelsDevUpstreamService {
  declare readonly _serviceBrand: undefined;
  private cache: ModelsDevCacheEntry | undefined;
  private inFlight: Promise<ModelsDevCatalog> | undefined;
  private retryAt = 0;
  private builtInMemo: ModelsDevCatalog | undefined | null;
  private readonly explicitFetch: typeof fetch | undefined;
  private readonly explicitNow: (() => number) | undefined;
  private readonly explicitBuiltIn: boolean;

  constructor(options?: ModelsDevUpstreamOptions) {
    this.explicitFetch = options?.fetchImpl;
    this.explicitNow = options?.now;
    this.explicitBuiltIn = options?.builtInCatalog !== undefined;
    this.builtInMemo = options?.builtInCatalog ?? null;
    if (options === undefined) {
      trackedClients.add(new WeakRef(this));
    }
  }

  reset(): void {
    this.cache = undefined;
    this.inFlight = undefined;
    this.retryAt = 0;
    if (!this.explicitBuiltIn) this.builtInMemo = null;
  }

  upstreamFetch(): typeof fetch {
    return this.explicitFetch ?? testOverrides?.fetchImpl ?? fetch;
  }

  private now(): number {
    return (this.explicitNow ?? testOverrides?.now ?? Date.now)();
  }

  private builtInCatalog(): ModelsDevCatalog | undefined {
    if (!this.explicitBuiltIn && testOverrides?.builtInCatalog !== undefined) {
      return testOverrides.builtInCatalog;
    }
    if (this.builtInMemo === null) {
      this.builtInMemo = loadBuiltInModelsDevCatalog(BUILT_IN_MODELS_DEV_JSON);
    }
    return this.builtInMemo;
  }

  async getCatalog(
    userAgent: string | (() => Promise<string>),
    options: { preferLocal?: boolean } = {},
  ): Promise<ModelsDevCatalog> {
    const now = this.now();
    if (this.cache !== undefined && now - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.catalog;
    }
    const local = this.cache?.catalog ?? this.builtInCatalog();
    if (options.preferLocal === true && local !== undefined) {
      if (now >= this.retryAt) void this.refreshCatalog(userAgent).catch(() => {});
      return local;
    }
    return this.refreshCatalog(userAgent);
  }

  private refreshCatalog(userAgent: string | (() => Promise<string>)): Promise<ModelsDevCatalog> {
    this.inFlight ??= Promise.resolve()
      .then(() => typeof userAgent === 'string' ? userAgent : userAgent())
      .then((ua) => this.fetchAndCache(ua))
      .finally(() => {
        this.retryAt = this.now() + CACHE_TTL_MS;
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private async fetchAndCache(userAgent: string): Promise<ModelsDevCatalog> {
    try {
      const res = await this.upstreamFetch()(MODELS_DEV_URL, {
        headers: { Accept: 'application/json', 'User-Agent': userAgent },
        signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error2(CoreErrors.codes.INTERNAL, `HTTP ${res.status}`, {
          details: { status: res.status },
        });
      }
      const payload: unknown = await res.json();
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new Error2(CoreErrors.codes.INTERNAL, 'unexpected catalog payload shape');
      }
      this.cache = { catalog: payload as ModelsDevCatalog, fetchedAt: this.now() };
      return this.cache.catalog;
    } catch (err) {
      if (this.cache !== undefined) return this.cache.catalog;
      const builtIn = this.builtInCatalog();
      if (builtIn !== undefined) return builtIn;
      throw new Error2(
        ModelsDevImportErrors.codes.CATALOG_UNAVAILABLE,
        `models.dev catalog unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

const defaultUpstreamClient = new ModelsDevUpstreamClient();

export function setModelsDevUpstreamForTest(options: ModelsDevUpstreamOptions): void {
  testOverrides = {
    fetchImpl: options.fetchImpl ?? testOverrides?.fetchImpl,
    now: options.now ?? testOverrides?.now,
    builtInCatalog: options.builtInCatalog ?? testOverrides?.builtInCatalog,
  };
}

export function resetModelsDevUpstreamForTest(): void {
  testOverrides = undefined;
  for (const ref of trackedClients) {
    const client = ref.deref();
    if (client === undefined) trackedClients.delete(ref);
    else client.reset();
  }
}

export function upstreamFetch(): typeof fetch {
  return defaultUpstreamClient.upstreamFetch();
}

export async function getModelsDevCatalog(
  userAgent: string | (() => Promise<string>),
  options: { preferLocal?: boolean } = {},
): Promise<ModelsDevCatalog> {
  return defaultUpstreamClient.getCatalog(userAgent, options);
}

registerScopedService(
  LifecycleScope.App,
  IModelsDevUpstreamService,
  ModelsDevUpstreamClient,
  ScopeActivation.OnDemand,
  'kosongConfig',
);

export function modelsDevEntry(
  catalog: ModelsDevCatalog,
  id: string,
): ModelsDevProviderEntry | undefined {
  return Object.prototype.hasOwnProperty.call(catalog, id) ? catalog[id] : undefined;
}

function capabilityToStrings(capability: ModelCapability): string[] | undefined {
  const caps: string[] = [];
  if (capability.image_in) caps.push('image_in');
  if (capability.video_in) caps.push('video_in');
  if (capability.audio_in) caps.push('audio_in');
  if (capability.thinking) caps.push('thinking');
  if (capability.tool_use) caps.push('tool_use');
  if (capability.dynamically_loaded_tools === true) caps.push('dynamically_loaded_tools');
  return caps.length > 0 ? caps : undefined;
}

function toModelItem(model: ModelsDevModel): ModelsDevModelItem {
  const caps = capabilityToStrings(model.capability);
  return {
    ...(model.name !== undefined ? { name: model.name } : {}),
    ...(caps !== undefined ? { capabilities: caps } : {}),
    ...(model.supportEfforts !== undefined ? { support_efforts: model.supportEfforts } : {}),
    id: model.id,
    max_context_size: model.capability.max_context_tokens,
    reasoning: model.capability.thinking,
  };
}

export function toModelsDevProviderItem(
  id: string,
  entry: ModelsDevProviderEntry,
): ModelsDevProviderItem {
  const resolution = resolveModelsDevImport(entry);
  const models = modelsDevProviderModels(entry).map(toModelItem);
  const base = {
    id,
    name: entry.name || id,
    env_key: entry.env?.[0] ?? null,
    base_url: resolution.kind === 'ok' ? resolution.baseUrl ?? null : null,
    models,
  };
  switch (resolution.kind) {
    case 'ok':
      return {
        ...base,
        wire_type: resolution.wire,
        guessed: resolution.guessed,
        needs_base_url: false,
        rejected: false,
        reject_code: null,
        reject_reason: null,
      };
    case 'needs-base-url':
      return {
        ...base,
        wire_type: resolution.wire,
        guessed: resolution.guessed,
        needs_base_url: true,
        rejected: false,
        reject_code: null,
        reject_reason: null,
      };
    case 'invalid':
      return {
        ...base,
        wire_type: null,
        guessed: false,
        needs_base_url: false,
        rejected: true,
        reject_code: resolution.reason,
        reject_reason: resolution.reason,
      };
  }
  throw new BugIndicatingError(
    `unhandled models.dev import resolution: ${JSON.stringify(resolution)}`,
  );
}

export function modelsDevModelToRecord(providerId: string, model: ModelsDevModel): ModelRecord {
  const caps = capabilityToStrings(model.capability);
  const capabilities =
    model.alwaysThinking === true
      ? caps?.map((cap) => (cap === 'thinking' ? 'always_thinking' : cap))
      : caps;
  const record: ModelRecord = {
    provider: providerId,
    model: model.id,
    maxContextSize: model.capability.max_context_tokens,
  };
  if (model.capability.max_input_tokens !== undefined) {
    record.maxInputSize = model.capability.max_input_tokens;
  }
  if (model.maxOutputSize !== undefined) record.maxOutputSize = model.maxOutputSize;
  if (capabilities !== undefined) record.capabilities = capabilities;
  if (model.name !== undefined) record.displayName = model.name;
  if (model.reasoningKey !== undefined) record.reasoningKey = model.reasoningKey;
  if (model.supportEfforts !== undefined) record.supportEfforts = [...model.supportEfforts];
  if (model.offEffort !== undefined) record.offEffort = model.offEffort;
  if (model.protocol !== undefined) record.protocol = model.protocol;
  if (model.baseUrl !== undefined) record.baseUrl = model.baseUrl;
  return record;
}
