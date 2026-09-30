import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  createDecorator,
  IBootstrapService,
  IConfigService,
  ILogService,
  type ModelRecord,
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from '@kiki/agent-core-v2';

import { IAtomicTomlDocumentStore } from '@kiki/agent-core-v2/persistence/interface/atomicDocumentStore';
import { modelPriceOverrideSchema, usagePricingUpdateSchema, type ModelPriceOverride, type UsagePricingResponse, type UsagePricingUpdate } from '@kiki/protocol';
import { z } from 'zod';

import { getModelPricingRuntimeState } from './runtime';

import { LOCAL_MODEL_PRICE_OVERRIDES, type LocalModelPriceOverride } from './modelPriceOverrides';

const PRICE_CACHE_DIR = 'model-pricing';
const PRICE_FILE_NAME = 'model_prices_and_context_window.json';
const DEFAULT_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1_000;
const FETCH_TIMEOUT_MS = 20_000;
const MINIMUM_CATALOG_KEYS = 1_000;
const MINIMUM_KEY_RATIO = 0.8;
const MINIMUM_BYTE_RATIO = 0.7;
const PROVIDER_PREFIXES = [
  'anthropic',
  'openai',
  'xai',
  'deepseek',
  'dashscope',
  'moonshot',
  'zai',
  'zhipu',
] as const;
const OVERRIDES_KEY = 'overrides.toml';
const overridesSchema = z.record(z.string(), modelPriceOverrideSchema);

export const MODEL_PRICE_URLS = [
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
  'https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json',
] as const;

export interface ModelTokenUsage {
  readonly inputOther?: number;
  readonly output?: number;
  readonly inputCacheRead?: number;
  readonly inputCacheCreation?: number;
}

export interface ModelTokenPrices {
  readonly inputCostPerToken?: number;
  readonly outputCostPerToken?: number;
  readonly cacheReadInputTokenCost?: number;
  readonly cacheCreationInputTokenCost?: number;
}

export type ModelPriceMatchStrategy =
  | 'exact'
  | 'provider-prefix'
  | 'alias'
  | 'family-regex'
  | 'normalized'
  | 'override'
  | 'override-alias';

export interface ModelPriceMatch {
  readonly requestedModel: string;
  readonly catalogModel: string;
  readonly strategy: ModelPriceMatchStrategy;
  readonly prices: ModelTokenPrices;
  readonly currency?: string;
}

interface RawPriceEntry extends Record<string, unknown> {
  readonly input_cost_per_token?: unknown;
  readonly output_cost_per_token?: unknown;
  readonly cache_read_input_token_cost?: unknown;
  readonly cache_creation_input_token_cost?: unknown;
  readonly aliases?: unknown;
}

interface RawFamilyRule {
  readonly pattern?: unknown;
  readonly model_info?: unknown;
}

interface CatalogStats {
  readonly keys: number;
  readonly bytes: number;
}

export interface ValidatedPriceCatalog {
  readonly raw: Record<string, unknown>;
  readonly stats: CatalogStats;
}

export interface PriceCatalogValidationOptions {
  readonly minimumKeys?: number;
  readonly baseline?: CatalogStats;
}

interface LoadedCatalog {
  readonly catalog: ModelPriceCatalog;
  readonly stats: CatalogStats;
  readonly path: string;
  readonly mtimeMs: number;
}

export interface ModelPricingStatus {
  readonly source: 'cache' | 'vendored' | 'empty' | 'refresh';
  readonly path?: string;
  readonly keys: number;
  readonly lastRefreshAt?: number;
  readonly lastRefreshError?: string;
}

export interface IModelPricingService {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  getPricing(models?: readonly string[]): Promise<UsagePricingResponse>;
  setPricing(update: UsagePricingUpdate): Promise<UsagePricingResponse>;
  resolve(model: string): ModelPriceMatch | undefined;
  calculate(model: string, usage: ModelTokenUsage): number | undefined;
  refreshNow(): Promise<boolean>;
  status(): ModelPricingStatus;
}

export const IModelPricingService =
  createDecorator<IModelPricingService>('modelPricingService');

export interface ModelPricingServiceOptions {
  readonly vendoredPath?: string;
  readonly cachePath?: string;
  readonly refreshUrls?: readonly string[];
  readonly refreshIntervalMs?: number;
  readonly minimumKeys?: number;
  readonly fetcher?: typeof fetch;
  readonly scheduleRefresh?: boolean;
  readonly now?: () => number;
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function toPrices(entry: RawPriceEntry): ModelTokenPrices {
  return {
    inputCostPerToken: finiteNonnegative(entry.input_cost_per_token),
    outputCostPerToken: finiteNonnegative(entry.output_cost_per_token),
    cacheReadInputTokenCost: finiteNonnegative(entry.cache_read_input_token_cost),
    cacheCreationInputTokenCost: finiteNonnegative(entry.cache_creation_input_token_cost),
  };
}

function hasBasePrices(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const prices = toPrices(entry as RawPriceEntry);
  return prices.inputCostPerToken !== undefined && prices.outputCostPerToken !== undefined;
}

function normalizeModelId(model: string): string {
  return model.trim().toLowerCase().replaceAll(/[.-]+/g, '-');
}

function aliasesOf(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((alias): alias is string => typeof alias === 'string' && alias.length > 0);
}

function modelCandidates(model: string): readonly string[] {
  const slash = model.indexOf('/');
  const bare = slash > 0 ? model.slice(slash + 1) : model;
  return [...new Set([model, bare, ...PROVIDER_PREFIXES.map((provider) => `${provider}/${bare}`)])];
}

const DATE_SUFFIX_PATTERN = /-?\d{4}$/;

export function validatePriceCatalogText(
  text: string,
  options: PriceCatalogValidationOptions = {},
): ValidatedPriceCatalog {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `model pricing catalog is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('model pricing catalog must be a JSON object');
  }
  const record = raw as Record<string, unknown>;
  const stats = { keys: Object.keys(record).length, bytes: Buffer.byteLength(text) };
  const minimumKeys = options.minimumKeys ?? MINIMUM_CATALOG_KEYS;
  if (stats.keys < minimumKeys) {
    throw new Error(`model pricing catalog has only ${stats.keys} keys (minimum ${minimumKeys})`);
  }
  for (const sample of ['gpt-5', 'claude-sonnet-4-5']) {
    if (!hasBasePrices(record[sample])) {
      throw new Error(`model pricing catalog sample ${sample} is missing token prices`);
    }
  }
  const baseline = options.baseline;
  if (baseline !== undefined) {
    const minimumBaselineKeys = Math.floor(baseline.keys * MINIMUM_KEY_RATIO);
    const minimumBaselineBytes = Math.floor(baseline.bytes * MINIMUM_BYTE_RATIO);
    if (stats.keys < minimumBaselineKeys || stats.bytes < minimumBaselineBytes) {
      throw new Error(
        `model pricing catalog shrank unexpectedly (${stats.keys}/${baseline.keys} keys, ${stats.bytes}/${baseline.bytes} bytes)`,
      );
    }
  }
  return { raw: record, stats };
}

export class ModelPriceCatalog {
  private readonly entries = new Map<string, RawPriceEntry>();
  private readonly aliases = new Map<string, string>();
  private readonly normalized = new Map<string, string | null>();
  private readonly familyRules: readonly { pattern: RegExp; entry: RawPriceEntry; name: string }[];

  constructor(raw: Record<string, unknown>) {
    for (const [name, value] of Object.entries(raw)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      if (name === 'fallback_generalizations' || name === 'sample_spec' || name === 'aliases') continue;
      const entry = value as RawPriceEntry;
      this.entries.set(name, entry);
      for (const alias of aliasesOf(entry['aliases'])) this.aliases.set(alias, name);
    }

    const topLevelAliases = raw['aliases'];
    if (topLevelAliases !== null && typeof topLevelAliases === 'object' && !Array.isArray(topLevelAliases)) {
      for (const [alias, target] of Object.entries(topLevelAliases as Record<string, unknown>)) {
        if (typeof target === 'string') {
          this.aliases.set(alias, target);
        } else {
          for (const expanded of aliasesOf(target)) this.aliases.set(expanded, alias);
        }
      }
    }

    for (const name of [...this.entries.keys(), ...this.aliases.keys()]) {
      const normalized = normalizeModelId(name);
      const target = this.aliases.get(name) ?? name;
      const existing = this.normalized.get(normalized);
      this.normalized.set(normalized, existing === undefined || existing === target ? target : null);
    }

    const familyRules: { pattern: RegExp; entry: RawPriceEntry; name: string }[] = [];
    const fallback = raw['fallback_generalizations'];
    const rules =
      fallback !== null && typeof fallback === 'object' && !Array.isArray(fallback)
        ? (fallback as { rules?: unknown }).rules
        : undefined;
    if (Array.isArray(rules)) {
      for (const [index, candidate] of rules.entries()) {
        if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
        const rule = candidate as RawFamilyRule & { name?: unknown };
        if (typeof rule.pattern !== 'string' || !hasBasePrices(rule.model_info)) continue;
        try {
          familyRules.push({
            pattern: new RegExp(rule.pattern, 'i'),
            entry: rule.model_info as RawPriceEntry,
            name: typeof rule.name === 'string' ? rule.name : `fallback-rule-${index}`,
          });
        } catch {
        }
      }
    }
    this.familyRules = familyRules;
  }

  /** Resolves the priced entry for `model`. Order: the local override table (an override pointing at
   *  a catalog key missing from this snapshot yields no price rather than an invented figure), then
   *  the candidate chain — the exact id, the id without its first routing segment, and that bare
   *  id under every supported pricing-provider prefix. As a last
   *  resort a trailing date pin (`deepseek-v4-pro-0813`) is stripped and the chain retried: a real
   *  name ending in four digits still resolves by its exact id first, and overrides are deliberately
   *  not consulted for the stripped name, which carries a bare id with no `kimi-code/` prefix. */
  resolve(model: string): ModelPriceMatch | undefined {
    const requestedModel = model.trim();
    if (requestedModel.length === 0) return undefined;
    const local = LOCAL_MODEL_PRICE_OVERRIDES[requestedModel];
    if (local !== undefined) {
      return this.resolveOverride(requestedModel, local);
    }

    const direct = this.matchChain(requestedModel, modelCandidates(requestedModel));
    if (direct !== undefined) return direct;
    const stripped = requestedModel.replace(DATE_SUFFIX_PATTERN, '');
    if (stripped.length === 0 || stripped === requestedModel) return undefined;
    return this.matchChain(requestedModel, modelCandidates(stripped));
  }

  private resolveOverride(
    requestedModel: string,
    override: LocalModelPriceOverride,
  ): ModelPriceMatch | undefined {
    if (override.navigateTo !== undefined) {
      const entry = this.entries.get(override.navigateTo);
      if (entry !== undefined) {
        return {
          requestedModel,
          catalogModel: override.navigateTo,
          strategy: 'override-alias',
          prices: toPrices(entry),
        };
      }
      return undefined;
    }
    const prices = override.prices;
    if (prices !== undefined) {
      return {
        requestedModel,
        catalogModel: requestedModel,
        strategy: 'override',
        prices,
      };
    }
    return undefined;
  }

  private matchChain(
    requestedModel: string,
    candidates: readonly string[],
  ): ModelPriceMatch | undefined {
    for (const candidate of candidates) {
      const entry = this.entries.get(candidate);
      if (entry !== undefined) {
        return {
          requestedModel,
          catalogModel: candidate,
          strategy: candidate === requestedModel ? 'exact' : 'provider-prefix',
          prices: toPrices(entry),
        };
      }
    }

    for (const candidate of candidates) {
      const target = this.aliases.get(candidate);
      const entry = target === undefined ? undefined : this.entries.get(target);
      if (target !== undefined && entry !== undefined) {
        return {
          requestedModel,
          catalogModel: target,
          strategy: 'alias',
          prices: toPrices(entry),
        };
      }
    }

    for (const rule of this.familyRules) {
      if (candidates.some((candidate) => rule.pattern.test(candidate))) {
        return {
          requestedModel,
          catalogModel: rule.name,
          strategy: 'family-regex',
          prices: toPrices(rule.entry),
        };
      }
    }

    for (const candidate of candidates) {
      const target = this.normalized.get(normalizeModelId(candidate));
      const entry = target === null || target === undefined ? undefined : this.entries.get(target);
      if (target !== null && target !== undefined && entry !== undefined) {
        return {
          requestedModel,
          catalogModel: target,
          strategy: 'normalized',
          prices: toPrices(entry),
        };
      }
    }
    return undefined;
  }

  calculate(model: string, usage: ModelTokenUsage): number | undefined {
    return calculateMatch(this.resolve(model), usage);
  }
}

function calculateMatch(match: ModelPriceMatch | undefined, usage: ModelTokenUsage): number | undefined {
  const totalTokens = (usage.inputOther ?? 0) + (usage.output ?? 0) +
    (usage.inputCacheRead ?? 0) + (usage.inputCacheCreation ?? 0);
  if (totalTokens === 0) return 0;
  if (match === undefined || (match.currency !== undefined && match.currency !== 'USD')) return undefined;
  const parts: readonly [number, number | undefined][] = [
    [usage.inputOther ?? 0, match.prices.inputCostPerToken],
    [usage.output ?? 0, match.prices.outputCostPerToken],
    [usage.inputCacheRead ?? 0, match.prices.cacheReadInputTokenCost],
    [usage.inputCacheCreation ?? 0, match.prices.cacheCreationInputTokenCost],
  ];
  let cost = 0;
  for (const [tokens, price] of parts) {
    if (tokens === 0) continue;
    if (price === undefined) return undefined;
    cost += tokens * price;
  }
  return Number.isFinite(cost) ? cost : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultVendoredPath(): string {
  const runtime = getModelPricingRuntimeState();
  if (runtime.configured) return runtime.path;
  const besideSource = resolve(
    import.meta.dirname,
    '..',
    '..',
    'vendor',
    'litellm',
    PRICE_FILE_NAME,
  );
  if (existsSync(besideSource)) return besideSource;
  return resolve(process.cwd(), 'packages', 'kap-server', 'vendor', 'litellm', PRICE_FILE_NAME);
}

function readValidatedCatalog(
  path: string,
  minimumKeys: number,
  baseline?: CatalogStats,
): LoadedCatalog {
  const text = readFileSync(path, 'utf8');
  const validated = validatePriceCatalogText(text, { minimumKeys, baseline });
  return {
    catalog: new ModelPriceCatalog(validated.raw),
    stats: validated.stats,
    path,
    mtimeMs: statSync(path).mtimeMs,
  };
}

const pendingDisposals = new Set<Promise<void>>();

export async function drainModelPricingDisposals(): Promise<void> {
  while (pendingDisposals.size > 0) await Promise.all(pendingDisposals);
}

export class ModelPricingService implements IModelPricingService {
  declare readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  private overrides: Record<string, ModelPriceOverride> = {};

  private readonly cachePath: string;
  private readonly vendoredPath: string;
  private readonly refreshUrls: readonly string[];
  private readonly refreshIntervalMs: number;
  private readonly minimumKeys: number;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly abortController = new AbortController();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshPromise: Promise<boolean> | null = null;
  private active: LoadedCatalog | null = null;
  private source: ModelPricingStatus['source'] = 'empty';
  private lastRefreshAt: number | undefined;
  private lastRefreshError: string | undefined;
  private disposed = false;

  constructor(
    @IBootstrapService bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
    @IAtomicTomlDocumentStore private readonly documents: IAtomicTomlDocumentStore,
    @IConfigService private readonly config: IConfigService,
    options: ModelPricingServiceOptions = {},
  ) {
    this.cachePath = options.cachePath ?? join(bootstrap.homeDir, PRICE_CACHE_DIR, PRICE_FILE_NAME);
    this.vendoredPath = options.vendoredPath ?? defaultVendoredPath();
    this.refreshUrls = options.refreshUrls ?? MODEL_PRICE_URLS;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.minimumKeys = options.minimumKeys ?? MINIMUM_CATALOG_KEYS;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.loadInitialCatalog();
    this.ready = Promise.all([this.config.ready, this.loadOverrides()]).then(() => undefined);
    void this.ready.catch((error) => this.log.warn('model pricing: override load failed', { error: errorMessage(error) }));
    if (options.scheduleRefresh !== false) this.scheduleNextRefresh();
  }

  private async loadOverrides(): Promise<void> {
    const stored = await this.documents.get(PRICE_CACHE_DIR, OVERRIDES_KEY);
    this.overrides = overridesSchema.parse(stored ?? {});
  }

  private configuredModel(model: string): { id: string; record: ModelRecord } | undefined {
    const models = this.config.get<Record<string, ModelRecord>>('models') ?? {};
    const direct = Object.hasOwn(models, model) ? models[model] : undefined;
    if (direct !== undefined) return { id: model, record: direct };
    const matches = Object.entries(models).filter(([, record]) =>
      record.aliases?.includes(model) || record.name === model || record.model === model ||
      `${record.providerId ?? record.provider}/${record.name ?? record.model}` === model);
    const match = matches.length === 1 ? matches[0] : undefined;
    return match === undefined ? undefined : { id: match[0], record: match[1] };
  }

  resolve(model: string): ModelPriceMatch | undefined {
    const configured = this.configuredModel(model);
    const pricingModel = configured?.record.pricingModel ?? model;
    const overrideKey = [model, configured?.id, pricingModel].find((key) => key !== undefined && Object.hasOwn(this.overrides, key));
    const override = overrideKey === undefined ? undefined : this.overrides[overrideKey];
    if (override !== undefined && overrideKey !== undefined) {
      return { requestedModel: model, catalogModel: overrideKey, strategy: 'override',
        prices: toPrices(override), currency: override.currency };
    }
    const match = this.active?.catalog.resolve(pricingModel);
    return match === undefined ? undefined : { ...match, requestedModel: model };
  }

  calculate(model: string, usage: ModelTokenUsage): number | undefined {
    return calculateMatch(this.resolve(model), usage);
  }

  async getPricing(models: readonly string[] = []): Promise<UsagePricingResponse> {
    await this.ready;
    const keys = new Set([...models, ...Object.keys(this.config.get<Record<string, ModelRecord>>('models') ?? {}), ...Object.keys(this.overrides)]);
    return {
      items: [...keys].toSorted().map((model): UsagePricingResponse['items'][number] => {
        const match = this.resolve(model);
        const prices = match?.prices;
        const identity = { model, pricing_model: this.configuredModel(model)?.record.pricingModel ?? null,
          matched_key: match?.catalogModel ?? null };
        if (match === undefined || prices?.inputCostPerToken === undefined || prices.outputCostPerToken === undefined) {
          return { ...identity, source: 'unknown', prices: null };
        }
        const source = match.strategy === 'override' ? 'override'
          : this.source === 'vendored' ? 'vendored' : 'litellm-cache';
        return { ...identity, source, prices: {
          input_cost_per_token: prices.inputCostPerToken,
          output_cost_per_token: prices.outputCostPerToken,
          cache_read_input_token_cost: prices.cacheReadInputTokenCost,
          cache_creation_input_token_cost: prices.cacheCreationInputTokenCost,
          currency: match.currency ?? 'USD',
        } };
      }),
      overrides: structuredClone(this.overrides),
    };
  }

  async setPricing(input: UsagePricingUpdate): Promise<UsagePricingResponse> {
    const update = usagePricingUpdateSchema.parse(input);
    await this.ready;
    const next = await this.documents.update<Record<string, ModelPriceOverride>>(PRICE_CACHE_DIR, OVERRIDES_KEY, (current) => {
      const result = overridesSchema.parse(current ?? {});
      for (const [model, price] of Object.entries(update.overrides)) {
        if (price === null) delete result[model];
        else result[model] = price;
      }
      return result;
    });
    this.overrides = overridesSchema.parse(next ?? {});
    return this.getPricing(Object.keys(update.overrides));
  }

  status(): ModelPricingStatus {
    return {
      source: this.source,
      path: this.active?.path,
      keys: this.active?.stats.keys ?? 0,
      lastRefreshAt: this.lastRefreshAt,
      lastRefreshError: this.lastRefreshError,
    };
  }

  refreshNow(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.refreshPromise !== null) return this.refreshPromise;
    const promise = this.refreshFromRemote().finally(() => {
      if (this.refreshPromise === promise) this.refreshPromise = null;
    });
    this.refreshPromise = promise;
    return promise;
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.abortController.abort();
    if (this.refreshPromise !== null) {
      const disposal = this.refreshPromise.then(
        () => undefined,
        () => undefined,
      );
      pendingDisposals.add(disposal);
      void disposal.finally(() => pendingDisposals.delete(disposal));
    }
  }

  private loadInitialCatalog(): void {
    let vendored: LoadedCatalog | null = null;
    try {
      vendored = readValidatedCatalog(this.vendoredPath, this.minimumKeys);
    } catch (error) {
      this.log.warn('model pricing: vendored snapshot unavailable', {
        error: errorMessage(error),
      });
    }
    try {
      this.active = readValidatedCatalog(
        this.cachePath,
        this.minimumKeys,
        vendored?.stats,
      );
      this.source = 'cache';
      return;
    } catch (error) {
      this.log.debug('model pricing: cached snapshot unavailable; using vendored snapshot', {
        error: errorMessage(error),
      });
    }
    if (vendored !== null) {
      this.active = vendored;
      this.source = 'vendored';
    }
  }

  private scheduleNextRefresh(): void {
    if (this.disposed) return;
    const age = this.active === null ? this.refreshIntervalMs : this.now() - this.active.mtimeMs;
    const delay = Math.max(0, this.refreshIntervalMs - Math.max(0, age));
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshNow().finally(() => {
        this.scheduleNextRefresh();
      });
    }, delay);
    this.refreshTimer.unref();
  }

  private async refreshFromRemote(): Promise<boolean> {
    const errors: string[] = [];
    for (const url of this.refreshUrls) {
      try {
        const signal = AbortSignal.any([
          this.abortController.signal,
          AbortSignal.timeout(FETCH_TIMEOUT_MS),
        ]);
        const response = await this.fetcher(url, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        const validated = validatePriceCatalogText(text, {
          minimumKeys: this.minimumKeys,
          baseline: this.active?.stats,
        });
        if (this.disposed) return false;
        mkdirSync(dirname(this.cachePath), { recursive: true });
        const tempPath = `${this.cachePath}.${process.pid}.${randomUUID()}.tmp`;
        try {
          writeFileSync(tempPath, text, 'utf8');
          renameSync(tempPath, this.cachePath);
        } finally {
          rmSync(tempPath, { force: true });
        }
        this.active = {
          catalog: new ModelPriceCatalog(validated.raw),
          stats: validated.stats,
          path: this.cachePath,
          mtimeMs: this.now(),
        };
        this.source = 'refresh';
        this.lastRefreshAt = this.now();
        this.lastRefreshError = undefined;
        this.log.info('model pricing: refreshed LiteLLM catalog', {
          keys: validated.stats.keys,
          source: url,
        });
        return true;
      } catch (error) {
        if (this.disposed) return false;
        errors.push(`${url}: ${errorMessage(error)}`);
      }
    }
    this.lastRefreshError = errors.join('; ');
    this.log.warn('model pricing: refresh failed; keeping the previous catalog', {
      error: this.lastRefreshError,
    });
    return false;
  }
}

registerScopedService(
  LifecycleScope.App,
  IModelPricingService,
  ModelPricingService,
  ScopeActivation.OnDemand,
  'modelPricing',
);
