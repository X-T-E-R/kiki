import { readApiErrorMessage } from './api-error';
import {
  fetchCustomRegistry,
  resolveCustomRegistryMaxContextSize,
  resolveCustomRegistryCapabilities,
  type CustomRegistryProviderEntry,
  type CustomRegistrySource,
} from './custom-registry';
import {
  applyManagedKimiCodeConfig,
  fetchManagedKimiCodeModels,
  KIMI_CODE_PLATFORM_ID,
  KIMI_CODE_PROVIDER_NAME,
  resolveKimiCodeRuntimeAuth,
  type ManagedKimiCodeModelInfo,
  type ManagedKimiConfigShape,
  type ManagedKimiModelAlias,
  type ManagedKimiOAuthRef,
} from './managed-kimi-code';
import { isManagedKimiCodeBaseUrl } from './managed-usage';
import {
  capabilitiesForModel,
  fetchOpenPlatformModels,
  filterModelsByPrefix,
  getOpenPlatformById,
  isOpenPlatformId,
} from './open-platform';
import {
  assertProviderCredential,
  assertProviderHeaders,
  sanitizeProviderError,
  sanitizeProviderUrl,
} from './provider-error';
import { isRecord } from './utils';

/**
 * Host capabilities the refresh orchestrator needs. Intentionally typed against
 * {@link ManagedKimiConfigShape} (the oauth package's own minimal config shape)
 * rather than the SDK's full `KimiConfig`, so this module has no dependency on
 * `agent-core` / the SDK and can be reused by both the CLI and the daemon.
 */
export interface RefreshProviderHost {
  getConfig(): Promise<ManagedKimiConfigShape>;
  removeProvider(providerId: string): Promise<ManagedKimiConfigShape>;
  setConfig(patch: ManagedKimiConfigShape): Promise<ManagedKimiConfigShape>;
  resolveOAuthToken(providerName: string, oauthRef?: ManagedKimiOAuthRef): Promise<string>;
  /**
   * Product User-Agent sent on custom-registry (api.json) fetches, e.g.
   * `kimi-code-cli/1.2.3`. When omitted the fetch falls back to the runtime
   * default (`User-Agent: node`).
   */
  readonly userAgent?: string;
}

export interface ProviderChange {
  readonly providerId: string;
  /** User-facing name when available. */
  readonly providerName: string;
  readonly added: number;
  readonly removed: number;
}

/** One model reported by a provider's own catalog endpoint. */
export interface DiscoveredModel {
  /** Model id exactly as the remote catalog reports it. */
  readonly remoteId: string;
  readonly displayName?: string;
  readonly maxContextSize?: number;
  readonly capabilities?: readonly string[];
  readonly supportEfforts?: readonly string[];
}

/** A provider catalog fetched during this refresh. */
export interface DiscoveredProviderModels {
  readonly providerId: string;
  /** Epoch milliseconds when the catalog was fetched. */
  readonly fetchedAt: number;
  readonly models: readonly DiscoveredModel[];
}

export interface RefreshResult {
  /**
   * Providers whose model list was actually persisted. Managed Kimi Code
   * (OAuth) is the only provider this refresh writes back; every other
   * provider is reported through `discovered` instead.
   */
  readonly changed: readonly ProviderChange[];
  /**
   * Providers that were refreshed successfully without a persisted change:
   * managed providers whose model list stayed identical, and every non-managed
   * provider that produced a `discovered` entry.
   */
  readonly unchanged: readonly string[];
  readonly failed: ReadonlyArray<{ readonly provider: string; readonly reason: string }>;
  /**
   * Model catalogs discovered from non-managed providers (open platforms,
   * managed-endpoint API-key providers, generic API-key providers, custom
   * registries). These are suggestions only — nothing is written to config.
   * Omitted entirely when no provider was probed.
   */
  readonly discovered?: readonly DiscoveredProviderModels[];
}

export type RefreshProviderScope = 'all' | 'oauth';

export interface RefreshProviderOptions {
  readonly scope?: RefreshProviderScope;
  /**
   * Refresh only this provider. When set, managed / open-platform branches
   * skip every other provider and a custom-registry group is only reported for
   * the target entry.
   */
  readonly providerId?: string;
}

interface ProviderView {
  readonly type?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly oauth?: ManagedKimiOAuthRef;
  readonly source?: unknown;
  readonly env?: unknown;
}

const PROVIDER_API_KEY_ENV_NAMES: Readonly<Record<string, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  kimi: 'KIMI_API_KEY',
  openai: 'OPENAI_API_KEY',
  openai_responses: 'OPENAI_API_KEY',
};

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Mirrors agent-core's provider credential resolution: the inline `apiKey`
 * wins, followed by the provider type's declared key in its config `env` bag.
 */
function resolveProviderApiKey(provider: ProviderView): string | undefined {
  const inline = nonEmptyString(provider.apiKey);
  if (inline !== undefined) return inline;
  if (!isRecord(provider.env) || provider.type === undefined) return undefined;
  const envName = PROVIDER_API_KEY_ENV_NAMES[provider.type];
  return envName === undefined ? undefined : nonEmptyString(provider.env[envName]);
}

/** Credential-shaped values from a provider's config `env` bag, for redaction. */
function providerEnvBag(
  provider: ProviderView,
): Readonly<Record<string, string | undefined>> | undefined {
  if (!isRecord(provider.env)) return undefined;
  const bag: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(provider.env)) {
    if (typeof value === 'string') bag[key] = value;
  }
  return Object.keys(bag).length > 0 ? bag : undefined;
}

function readProvider(
  config: ManagedKimiConfigShape,
  providerId: string,
): ProviderView | undefined {
  const provider = config.providers[providerId];
  if (provider === undefined) return undefined;
  return provider as ProviderView;
}

function readModel(
  config: ManagedKimiConfigShape,
  alias: string,
): ManagedKimiModelAlias | undefined {
  const model = config.models?.[alias];
  if (model === undefined) return undefined;
  return model as ManagedKimiModelAlias;
}

function readCustomRegistrySource(provider: ProviderView): CustomRegistrySource | undefined {
  const source = provider.source;
  if (typeof source !== 'object' || source === null) return undefined;
  const candidate = source as Record<string, unknown>;
  if (candidate['kind'] !== 'apiJson') return undefined;
  const url = candidate['url'];
  const apiKey = candidate['apiKey'];
  if (typeof url !== 'string' || url.length === 0) return undefined;
  if (typeof apiKey !== 'string') return undefined;
  return { kind: 'apiJson', url, apiKey };
}

interface GenericProviderModel {
  readonly id: string;
}

function parseGenericProviderModels(payload: unknown, baseUrl: string): GenericProviderModel[] {
  if (!isRecord(payload) || !Array.isArray(payload['data'])) {
    throw new Error(`Unexpected models response for ${sanitizeProviderUrl(baseUrl)}.`);
  }
  const ids = new Set<string>();
  for (const item of payload['data']) {
    if (!isRecord(item)) continue;
    const id = nonEmptyString(item['id']);
    if (id !== undefined) ids.add(id);
  }
  return [...ids].map((id) => ({ id }));
}

async function fetchGenericProviderModels(
  providerId: string,
  provider: ProviderView,
  apiKey: string,
): Promise<GenericProviderModel[]> {
  const baseUrl = nonEmptyString(provider.baseUrl);
  if (baseUrl === undefined) return [];
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  // Reject an invalid credential before the request headers exist: the fetch
  // implementation quotes the offending header value verbatim in its own
  // TypeError, which would hand the key back to the caller.
  assertProviderCredential(apiKey);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (provider.type === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  assertProviderHeaders(headers);

  const response = await fetch(`${normalizedBaseUrl}/models`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const message = await readApiErrorMessage(
      response,
      `Failed to list models for provider "${providerId}" (HTTP ${response.status}).`,
    );
    throw new Error(sanitizeProviderError(message, { apiKey, baseUrl: normalizedBaseUrl, headers }));
  }
  return parseGenericProviderModels(await response.json(), normalizedBaseUrl);
}

function isGenericProviderSource(provider: ProviderView): boolean {
  return (
    provider.oauth === undefined
    && provider.source === undefined
    && nonEmptyString(provider.baseUrl) !== undefined
    && !isManagedKimiCodeBaseUrl(provider.baseUrl)
  );
}

type ProviderSourceStatus = 'missing' | 'missing-credentials' | 'ready';

function providerSourceStatus(providerId: string, provider: ProviderView): ProviderSourceStatus {
  if (isOpenPlatformId(providerId)) {
    return nonEmptyString(provider.apiKey) === undefined ? 'missing-credentials' : 'ready';
  }
  if (
    providerId === KIMI_CODE_PROVIDER_NAME
    && provider.type === 'kimi'
    && provider.oauth !== undefined
  ) {
    return 'ready';
  }
  if (
    provider.type === 'kimi'
    && provider.oauth === undefined
    && readCustomRegistrySource(provider) === undefined
    && isManagedKimiCodeBaseUrl(provider.baseUrl)
  ) {
    return resolveProviderApiKey(provider) === undefined ? 'missing-credentials' : 'ready';
  }
  if (
    providerId !== KIMI_CODE_PROVIDER_NAME
    && readCustomRegistrySource(provider) !== undefined
  ) {
    return 'ready';
  }
  if (isGenericProviderSource(provider)) {
    return resolveProviderApiKey(provider) === undefined ? 'missing-credentials' : 'ready';
  }
  return 'missing';
}

// ── discovered-catalog mapping ─────────────────────────────────────────

function discoveredModelFromKimiModel(model: ManagedKimiCodeModelInfo): DiscoveredModel {
  const capabilities = capabilitiesForModel(model);
  return {
    remoteId: model.id,
    displayName: model.displayName,
    maxContextSize: Number.isInteger(model.contextLength) && model.contextLength > 0
      ? model.contextLength
      : undefined,
    capabilities,
    supportEfforts: model.supportEfforts,
  };
}

function discoveredModelsFromCustomEntry(entry: CustomRegistryProviderEntry): DiscoveredModel[] {
  const models: DiscoveredModel[] = [];
  for (const model of Object.values(entry.models)) {
    models.push({
      remoteId: model.id,
      displayName: model.name ?? model.id,
      maxContextSize: resolveCustomRegistryMaxContextSize(model),
      capabilities: resolveCustomRegistryCapabilities(model),
      supportEfforts: model.support_efforts,
    });
  }
  return models;
}

function customRegistrySourceKey(source: CustomRegistrySource): string {
  return JSON.stringify([source.url]);
}

function customRegistrySourceCredentialKey(source: CustomRegistrySource): string {
  return JSON.stringify([source.url, source.apiKey]);
}

async function fetchCustomRegistryFromSources(
  sources: readonly CustomRegistrySource[],
  userAgent?: string,
): Promise<{
  readonly entries: Awaited<ReturnType<typeof fetchCustomRegistry>>;
  readonly source: CustomRegistrySource;
}> {
  let lastError: unknown;
  for (const source of sources) {
    try {
      return {
        entries: await fetchCustomRegistry(source, { userAgent }),
        source,
      };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  if (typeof lastError === 'string') throw new Error(lastError);
  throw new Error('No custom registry sources configured.');
}

// ── managed (persisted) refresh helpers ────────────────────────────────

function collectModelIdsForAliases(
  config: ManagedKimiConfigShape,
  aliasKeys: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const aliasKey of aliasKeys) {
    const alias = readModel(config, aliasKey);
    if (alias !== undefined && alias.model.length > 0) {
      ids.add(alias.model);
    }
  }
  return ids;
}

function providerAliasKeys(config: ManagedKimiConfigShape, providerId: string): Set<string> {
  const keys = new Set<string>();
  for (const [alias, raw] of Object.entries(config.models ?? {})) {
    if ((raw as ManagedKimiModelAlias).provider === providerId) keys.add(alias);
  }
  return keys;
}

function generatedProviderAliasKeys(
  config: ManagedKimiConfigShape,
  providerId: string,
  aliasPrefix: string,
): Set<string> {
  const keys = new Set<string>();
  for (const [alias, raw] of Object.entries(config.models ?? {})) {
    const model = raw as ManagedKimiModelAlias;
    if (model.provider === providerId && alias.startsWith(aliasPrefix)) {
      keys.add(alias);
    }
  }
  return keys;
}

function computeChanges(oldIds: Set<string>, newIds: Set<string>): { added: number; removed: number } {
  let added = 0;
  for (const id of newIds) {
    if (!oldIds.has(id)) added++;
  }
  let removed = 0;
  for (const id of oldIds) {
    if (!newIds.has(id)) removed++;
  }
  return { added, removed };
}

interface ProviderModelSnapshot {
  readonly alias: string;
  readonly model: ManagedKimiModelAlias;
}

// Compare the full model metadata for the relevant aliases, not just model IDs:
// a registry can change capabilities (e.g. enabling reasoning) without changing
// any model ID. Spreading the whole alias keeps this in sync with the schema
// automatically; only `capabilities` needs normalizing because its order is not
// meaningful.
function providerModelSnapshot(
  config: ManagedKimiConfigShape,
  providerId: string,
  aliasKeys: ReadonlySet<string>,
): string {
  const snapshots: ProviderModelSnapshot[] = [];
  for (const alias of aliasKeys) {
    const model = readModel(config, alias);
    if (model === undefined || model.provider !== providerId) continue;
    snapshots.push({
      alias,
      model: {
        ...model,
        capabilities: model.capabilities === undefined ? undefined : model.capabilities.toSorted(),
      },
    });
  }
  snapshots.sort((a, b) => a.alias.localeCompare(b.alias));
  return JSON.stringify(snapshots);
}

function providerModelsEqual(
  config: ManagedKimiConfigShape,
  nextConfig: ManagedKimiConfigShape,
  providerId: string,
  aliasKeys: ReadonlySet<string>,
): boolean {
  return (
    providerModelSnapshot(config, providerId, aliasKeys) ===
    providerModelSnapshot(nextConfig, providerId, aliasKeys)
  );
}

function providerRefreshAliasKeys(
  config: ManagedKimiConfigShape,
  nextConfig: ManagedKimiConfigShape,
  providerId: string,
  aliasPrefix: string,
): Set<string> {
  const keys = generatedProviderAliasKeys(config, providerId, aliasPrefix);
  for (const key of providerAliasKeys(nextConfig, providerId)) keys.add(key);
  return keys;
}

function preserveUserProviderAliases(
  config: ManagedKimiConfigShape,
  providerId: string,
  refreshedAliasKeys: ReadonlySet<string>,
): Record<string, ManagedKimiModelAlias> {
  const preserved: Record<string, ManagedKimiModelAlias> = {};
  for (const [alias, raw] of Object.entries(config.models ?? {})) {
    const model = raw as ManagedKimiModelAlias;
    if (model.provider !== providerId || refreshedAliasKeys.has(alias)) continue;
    preserved[alias] = structuredClone(model);
  }
  return preserved;
}

function restoreProviderAliases(
  config: ManagedKimiConfigShape,
  aliases: Record<string, ManagedKimiModelAlias>,
): void {
  if (Object.keys(aliases).length === 0) return;
  config.models = {
    ...config.models,
    ...aliases,
  };
}

function restoreDefaultSelection(
  config: ManagedKimiConfigShape,
  defaultModel: string | undefined,
  defaultEnabled: boolean | undefined,
): void {
  if (defaultModel === undefined || readModel(config, defaultModel) === undefined) return;
  config.defaultModel = defaultModel;
  // A refresh may have just learned that the default model cannot disable
  // thinking — never restore a stale thinking-off selection onto it.
  const capabilities = readModel(config, defaultModel)?.capabilities ?? [];
  const enabled = capabilities.includes('always_thinking') ? true : defaultEnabled;
  if (enabled !== undefined) {
    config.thinking = { ...config.thinking, enabled };
  }
}

// `apply*` may leave `defaultModel` pointing at an alias that no longer exists
// (e.g. the previously-selected model was dropped from the registry). The host's
// `setConfig` deep-merge cannot clear a key, so the matching `removeProvider`
// call handles disk cleanup while this drops the dangling reference in memory.
function clampDanglingDefault(config: ManagedKimiConfigShape): void {
  if (config.defaultModel !== undefined && readModel(config, config.defaultModel) === undefined) {
    config.defaultModel = undefined;
    config.thinking = undefined;
  }
}

function clearDefaultThinkingWhenDefaultRemoved(
  config: ManagedKimiConfigShape,
  previousDefaultModel: string | undefined,
): void {
  if (previousDefaultModel !== undefined && config.defaultModel === undefined) {
    config.thinking = undefined;
  }
}

/**
 * Refresh remote model metadata for the configured providers.
 *
 * Only the managed Kimi Code (OAuth) provider is written back to config, via
 * the host's `removeProvider` / `setConfig`. Every other provider kind —
 * open platforms (moonshot-cn, moonshot-ai, …), managed-endpoint API-key
 * providers (a hand-written `type: 'kimi'` provider pointed at the managed
 * Kimi Code endpoint), generic API-key providers (`GET {baseUrl}/models` with
 * Anthropic or Bearer auth) and custom registries (`provider.source`) — is
 * fetched and returned as a *suggestion* in `discovered`. Those branches never
 * call `removeProvider` / `setConfig`, never add a provider, and never touch
 * the user's configured provider connection: the manual refresh only reports
 * what the remote catalog currently offers. Custom registries are only probed
 * for providers that are already configured; entries that appear upstream
 * without a configured provider are ignored.
 *
 * `discovered` entries always carry the remote ids as reported by the endpoint,
 * never ids reverse-engineered from configured aliases. An empty remote catalog
 * is a successful empty model list (it clears previously suggested models), not
 * a failure. Failures are collected per-provider, sanitized of credential
 * material, and never abort the whole refresh. Pass `providerId` to scope the
 * refresh to a single provider; pass `scope: 'oauth'` to touch only the managed
 * provider.
 */
export async function refreshProviderModels(
  host: RefreshProviderHost,
  options: RefreshProviderOptions = {},
): Promise<RefreshResult> {
  const changed: ProviderChange[] = [];
  const unchanged: string[] = [];
  const failed: Array<{ provider: string; reason: string }> = [];
  const discovered: DiscoveredProviderModels[] = [];
  const scope = options.scope ?? 'all';
  const targetId = options.providerId;

  let config = await host.getConfig();

  // ---------------------------------------------------------------------------
  // 1. Managed Kimi Code (OAuth) — the only persisted (write-back) branch
  // ---------------------------------------------------------------------------
  const managedProvider = readProvider(config, KIMI_CODE_PROVIDER_NAME);
  const managedWanted = targetId === undefined || targetId === KIMI_CODE_PROVIDER_NAME;
  if (
    managedWanted &&
    managedProvider !== undefined &&
    managedProvider.type === 'kimi' &&
    managedProvider.oauth !== undefined
  ) {
    let managedBaseUrl = nonEmptyString(managedProvider.baseUrl);
    let managedAccessToken: string | undefined;
    try {
      const auth = resolveKimiCodeRuntimeAuth({
        configuredBaseUrl: managedProvider.baseUrl,
        configuredOAuthRef: managedProvider.oauth,
      });
      managedBaseUrl = auth.baseUrl;
      const accessToken = await host.resolveOAuthToken(KIMI_CODE_PROVIDER_NAME, auth.oauthRef);
      managedAccessToken = accessToken;
      const models = await fetchManagedKimiCodeModels({
        accessToken,
        baseUrl: auth.baseUrl,
      });
      if (models.length > 0) {
        const next = structuredClone(config);
        applyManagedKimiCodeConfig(next, {
          models,
          baseUrl: auth.baseUrl,
          oauthKey: auth.oauthRef.key,
          oauthHost: auth.oauthRef.oauthHost,
          preserveDefaultModel: true,
        });
        const refreshedAliasKeys = providerRefreshAliasKeys(
          config,
          next,
          KIMI_CODE_PROVIDER_NAME,
          `${KIMI_CODE_PLATFORM_ID}/`,
        );
        restoreProviderAliases(
          next,
          preserveUserProviderAliases(config, KIMI_CODE_PROVIDER_NAME, refreshedAliasKeys),
        );
        restoreDefaultSelection(next, config.defaultModel, config.thinking?.enabled);
        clampDanglingDefault(next);
        clearDefaultThinkingWhenDefaultRemoved(next, config.defaultModel);

        if (providerModelsEqual(config, next, KIMI_CODE_PROVIDER_NAME, refreshedAliasKeys)) {
          unchanged.push(KIMI_CODE_PROVIDER_NAME);
        } else {
          const { added, removed } = computeChanges(
            collectModelIdsForAliases(config, refreshedAliasKeys),
            collectModelIdsForAliases(next, refreshedAliasKeys),
          );
          await host.removeProvider(KIMI_CODE_PROVIDER_NAME);
          config = await host.setConfig({
            providers: next.providers,
            models: next.models,
            defaultModel: next.defaultModel,
            thinking: next.thinking,
          });
          changed.push({
            providerId: KIMI_CODE_PROVIDER_NAME,
            providerName: 'Kimi Code',
            added,
            removed,
          });
        }
      }
    } catch (error) {
      failed.push({
        provider: KIMI_CODE_PROVIDER_NAME,
        reason: sanitizeProviderError(error, {
          secrets: [managedAccessToken],
          baseUrl: managedBaseUrl,
          env: providerEnvBag(managedProvider),
        }),
      });
    }
  }

  // The oauth scope stops here, but a targeted refresh of the managed provider
  // must fall through: branch 2 no-ops on a non-open-platform id, branch 2.5
  // handles a hand-written `managed:kimi-code` that carries an API key instead
  // of an oauth ref, and branch 3 no-ops when no registry group contains it.
  if (scope === 'oauth') {
    return { changed, unchanged, failed };
  }

  // ---------------------------------------------------------------------------
  // 2. Open Platforms (moonshot-cn, moonshot-ai, …) — suggestion only
  // ---------------------------------------------------------------------------
  const openPlatformIds = Object.keys(config.providers).filter((id) => isOpenPlatformId(id));
  for (const providerId of openPlatformIds) {
    if (targetId !== undefined && targetId !== providerId) continue;
    const platform = getOpenPlatformById(providerId);
    if (platform === undefined) continue;

    const providerConfig = readProvider(config, providerId);
    if (providerConfig === undefined) continue;
    const apiKey = providerConfig.apiKey;
    if (typeof apiKey !== 'string' || apiKey.length === 0) continue;

    try {
      const models = filterModelsByPrefix(await fetchOpenPlatformModels(platform, apiKey), platform);
      discovered.push({
        providerId,
        fetchedAt: Date.now(),
        models: models.map((model) => discoveredModelFromKimiModel(model)),
      });
      unchanged.push(providerId);
    } catch (error) {
      failed.push({
        provider: providerId,
        reason: sanitizeProviderError(error, {
          apiKey,
          baseUrl: platform.baseUrl,
          env: providerEnvBag(providerConfig),
        }),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 2.5. Managed-endpoint API-key providers (hand-configured distributed keys)
  // ---------------------------------------------------------------------------
  // A hand-written `type: 'kimi'` provider whose baseUrl is exactly the managed
  // Kimi Code endpoint, carrying an API key (inline or via `env.KIMI_API_KEY`)
  // instead of an oauth ref, gets its model list read from `{baseUrl}/models`
  // just like the OAuth branch — but it is user-owned, so the catalog is only
  // suggested. Strict baseUrl matching keeps proxies / gateways with an
  // untrusted `/models` schema out.
  for (const providerId of Object.keys(config.providers)) {
    if (isOpenPlatformId(providerId)) continue;
    if (targetId !== undefined && targetId !== providerId) continue;
    const provider = readProvider(config, providerId);
    if (provider === undefined) continue;
    if (provider.type !== 'kimi') continue;
    if (provider.oauth !== undefined) continue;
    if (readCustomRegistrySource(provider) !== undefined) continue;
    if (!isManagedKimiCodeBaseUrl(provider.baseUrl)) continue;
    const apiKey = resolveProviderApiKey(provider);
    if (apiKey === undefined) continue;

    try {
      const models = await fetchManagedKimiCodeModels({
        accessToken: apiKey,
        baseUrl: provider.baseUrl,
        credentialKind: 'apiKey',
      });
      discovered.push({
        providerId,
        fetchedAt: Date.now(),
        models: models.map((model) => discoveredModelFromKimiModel(model)),
      });
      unchanged.push(providerId);
    } catch (error) {
      failed.push({
        provider: providerId,
        reason: sanitizeProviderError(error, {
          apiKey,
          baseUrl: provider.baseUrl,
          env: providerEnvBag(provider),
        }),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 2.75. Generic API-key providers with an OpenAI-shaped /models endpoint
  // ---------------------------------------------------------------------------
  for (const providerId of Object.keys(config.providers)) {
    if (isOpenPlatformId(providerId)) continue;
    if (targetId !== undefined && targetId !== providerId) continue;
    const provider = readProvider(config, providerId);
    if (provider === undefined || !isGenericProviderSource(provider)) continue;
    const apiKey = resolveProviderApiKey(provider);
    if (apiKey === undefined) continue;

    try {
      const models = await fetchGenericProviderModels(providerId, provider, apiKey);
      discovered.push({
        providerId,
        fetchedAt: Date.now(),
        models: models.map((model) => ({ remoteId: model.id })),
      });
      unchanged.push(providerId);
    } catch (error) {
      failed.push({
        provider: providerId,
        reason: sanitizeProviderError(error, {
          apiKey,
          baseUrl: provider.baseUrl,
          env: providerEnvBag(provider),
        }),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Custom Registry providers (grouped by URL, with API-key candidates)
  // ---------------------------------------------------------------------------
  const customSources = new Map<
    string,
    {
      readonly sources: CustomRegistrySource[];
      readonly sourceKeys: Set<string>;
      readonly providerIds: string[];
    }
  >();
  for (const providerId of Object.keys(config.providers)) {
    if (providerId === KIMI_CODE_PROVIDER_NAME) continue;
    if (isOpenPlatformId(providerId)) continue;
    const provider = readProvider(config, providerId);
    if (provider === undefined) continue;
    const source = readCustomRegistrySource(provider);
    if (source === undefined) continue;
    const key = customRegistrySourceKey(source);
    const sourceKey = customRegistrySourceCredentialKey(source);
    const entry = customSources.get(key);
    if (entry !== undefined) {
      if (!entry.sourceKeys.has(sourceKey)) {
        entry.sources.push(source);
        entry.sourceKeys.add(sourceKey);
      }
      entry.providerIds.push(providerId);
    } else {
      customSources.set(key, {
        sources: [source],
        sourceKeys: new Set([sourceKey]),
        providerIds: [providerId],
      });
    }
  }

  for (const { sources, providerIds } of customSources.values()) {
    // When scoped to a single provider, only refresh the registry group it
    // belongs to and only report the target entry (siblings under the same URL
    // are left alone).
    if (targetId !== undefined && !providerIds.includes(targetId)) continue;
    let entries: Awaited<ReturnType<typeof fetchCustomRegistry>>;
    try {
      ({ entries } = await fetchCustomRegistryFromSources(sources, host.userAgent));
    } catch (error) {
      const reportedIds = targetId !== undefined ? [targetId] : providerIds;
      const reason = sanitizeProviderError(error, {
        secrets: sources.map((source) => source.apiKey),
        baseUrl: sources[0]?.url,
      });
      for (const providerId of reportedIds) {
        failed.push({ provider: providerId, reason });
      }
      continue;
    }

    const entriesByProviderId = new Map(
      Object.values(entries).map((entry) => [entry.id, entry]),
    );
    for (const providerId of providerIds) {
      if (targetId !== undefined && providerId !== targetId) continue;
      const entry = entriesByProviderId.get(providerId);
      // A configured provider that the registry no longer lists yields an
      // empty suggestion: the manual refresh never removes a provider record,
      // it only stops suggesting models for it.
      discovered.push({
        providerId,
        fetchedAt: Date.now(),
        models: entry === undefined ? [] : discoveredModelsFromCustomEntry(entry),
      });
      unchanged.push(providerId);
    }
  }

  if (
    targetId !== undefined
    && !changed.some((entry) => entry.providerId === targetId)
    && !unchanged.includes(targetId)
    && !failed.some((entry) => entry.provider === targetId)
  ) {
    const targetProvider = readProvider(config, targetId);
    const sourceStatus =
      targetProvider === undefined ? 'missing' : providerSourceStatus(targetId, targetProvider);
    failed.push({
      provider: targetId,
      reason:
        sourceStatus === 'missing-credentials'
          ? 'provider model source requires an API key'
          : sourceStatus === 'ready'
            ? 'provider model source was unavailable or returned no models'
            : 'provider has no refreshable model source',
    });
  }

  return {
    changed,
    unchanged,
    failed,
    discovered: discovered.length > 0 ? discovered : undefined,
  };
}
