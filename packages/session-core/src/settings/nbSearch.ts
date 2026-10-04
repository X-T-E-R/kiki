import type {
  NbSearchCapabilities,
  NbSearchConfigPatch,
  NbSearchSourceConfig,
  NbSearchTestStatus,
} from '@kiki/protocol';

import { LocalizedError } from '../i18n/locale';
import { nbSearchAdvancedDraftFromConfig, validateNbSearchReferences, NbSearchReferenceError, type NbSearchAdvancedDraft } from './nbSearchAdvanced';
export * from './nbSearchAdvanced';

export type NbSearchReadiness = NbSearchTestStatus['search'];

export const NB_SEARCH_MAX_KEYS = 32;

export function parseMultiKey(raw: string | null | undefined): string[] {
  return (raw ?? '').split(',').map((key) => key.trim()).filter((key) => key !== '');
}

export function formatMultiKey(keys: readonly string[]): string {
  return keys.join(',');
}

export function validateKeyList(keys: readonly string[]): {
  readonly valid: boolean;
  readonly tooMany: boolean;
  readonly duplicates: readonly string[];
  readonly empty: boolean;
} {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  let empty = false;
  for (const raw of keys) {
    const key = raw.trim();
    if (key === '') empty = true;
    else if (seen.has(key)) duplicates.add(key);
    else seen.add(key);
  }
  const tooMany = keys.length > NB_SEARCH_MAX_KEYS;
  return { valid: !tooMany && duplicates.size === 0 && !empty, tooMany, duplicates: [...duplicates], empty };
}

export function resolveEffectiveDefaultLane(
  capabilities: NbSearchCapabilities,
  draftDefaultLane: string,
): { readonly laneId: string | undefined; readonly inherited: boolean } {
  return draftDefaultLane === ''
    ? { laneId: capabilities.inherited_configuration === undefined ? capabilities.search.default_lane : capabilities.inherited_configuration.default_search_lane, inherited: true }
    : { laneId: draftDefaultLane, inherited: false };
}

export function nbSearchReuseLocalConfig(source: NbSearchSourceConfig | undefined): boolean {
  return source?.reuse_local_config ?? true;
}

export function nbSearchSourcePatch(reuseLocalConfig: boolean): { readonly nb_search_source: NbSearchSourceConfig } {
  return { nb_search_source: { reuse_local_config: reuseLocalConfig } };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function nbSearchIssueCodes(issues: readonly { readonly code: string }[]): string[] {
  return issues.map((issue) => issue.code);
}

export function formatNbSearchOutput(
  output: NbSearchCapabilities['search']['lanes'][number]['output'],
): string {
  return `${output.channel} · ${output.schema_id}`;
}

/**
 * Derive the same readiness the backend `/nb-search/test` reports, but from
 * an already-fetched capabilities payload, so the status card never triggers
 * a backend call of its own. Mirrors NbSearchService.searchReadiness /
 * fetchReadiness in agent-core-v2.
 */
export function nbSearchReadinessFromCapabilities(capabilities: NbSearchCapabilities): {
  readonly search: NbSearchReadiness;
  readonly fetch: NbSearchReadiness;
} {
  if (capabilities.config_source?.availability === 'unavailable') {
    const readiness = { configured: false, available: false, issues: capabilities.config_source.issues };
    return { search: readiness, fetch: readiness };
  }
  const selection = capabilities.search.default_lane;
  const search: NbSearchReadiness = (() => {
    if (selection === undefined) {
      return { configured: false, available: false, issues: ['DEFAULT_NOT_CONFIGURED'] };
    }
    const lane = capabilities.search.lanes.find((candidate) => candidate.id === selection);
    return {
      configured: true,
      available: lane?.availability === 'ready' && lane.execution_modes.includes('sync'),
      selection,
      issues: lane?.issues.map((issue) => issue.code) ?? ['LANE_NOT_REGISTERED'],
    };
  })();
  const chain = capabilities.fetch.chains.find(
    (candidate) => candidate.input_kind === 'url' && candidate.representation === 'markdown',
  );
  const fetch: NbSearchReadiness = (() => {
    if (chain === undefined) {
      return { configured: false, available: false, issues: ['FETCH_DEFAULT_NOT_CONFIGURED'] };
    }
    const pipelines = chain.pipelines.map((id) =>
      capabilities.fetch.pipelines.find((candidate) => candidate.id === id));
    const issues = pipelines.flatMap(
      (pipeline) => pipeline?.issues.map((issue) => issue.code) ?? ['LANE_NOT_REGISTERED'],
    );
    const available = pipelines.some(
      (pipeline) => pipeline?.availability === 'ready' && pipeline.execution_modes.includes('sync'),
    );
    return {
      configured: true,
      available,
      selection: chain.pipelines.join(' -> '),
      issues: available ? issues : [...issues, 'FETCH_CHAIN_UNAVAILABLE'],
    };
  })();
  return { search, fetch };
}

// ---- config draft ----

/** The url→markdown chain FetchURL falls through; other chains stay untouched. */
export const NB_SEARCH_FETCH_CHAIN_INPUT = 'url';
export const NB_SEARCH_FETCH_CHAIN_REPRESENTATION = 'markdown';

export interface NbSearchExecutionDraft {
  readonly maxProviderCalls: string;
  readonly maxConcurrency: string;
  readonly retryCount: string;
  readonly searchTimeoutMs: string;
  readonly fetchTimeoutMs: string;
  readonly maxInlineBytes: string;
  readonly fetchMaxSourceBytes: string;
  readonly fetchMaxResponseBytes: string;
  readonly fetchMaxContentChars: string;
  readonly fetchMaxRedirects: string;
}

export interface NbSearchProviderDraft {
  readonly providerId?: string;
  readonly enabled: boolean;
  readonly baseUrl: string;
  readonly credentialSlotId: string;
  readonly credentialSlotExplicit: boolean;
  readonly optionsJson: string;
  readonly keyStrategy?: 'round-robin' | 'priority';
  readonly balanceTtlMs?: string;
  readonly isNew?: boolean;
  readonly isDeleted?: boolean;
}

export interface NbSearchDraft {
  readonly defaultSearchLane: string;
  readonly fetchChain: readonly string[];
  /** True while the url→markdown chain inherits the runtime default. */
  readonly fetchChainInherited: boolean;
  readonly providers: Readonly<Record<string, NbSearchProviderDraft>>;
  readonly credentialSlots: NbSearchConfigPatch['credential_slots'];
  readonly execution: NbSearchExecutionDraft;
  readonly advanced?: NbSearchAdvancedDraft;
}

function numberField(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function executionDraftFromConfig(execution: Record<string, unknown>): NbSearchExecutionDraft {
  const fetchLimits = asRecord(execution['fetch']);
  return {
    maxProviderCalls: numberField(execution['max_provider_calls']),
    maxConcurrency: numberField(execution['max_concurrency']),
    retryCount: numberField(execution['retry_count']),
    searchTimeoutMs: numberField(execution['search_timeout_ms']),
    fetchTimeoutMs: numberField(execution['fetch_timeout_ms']),
    maxInlineBytes: numberField(execution['max_inline_bytes']),
    fetchMaxSourceBytes: numberField(fetchLimits['max_source_bytes']),
    fetchMaxResponseBytes: numberField(fetchLimits['max_response_bytes']),
    fetchMaxContentChars: numberField(fetchLimits['max_content_chars']),
    fetchMaxRedirects: numberField(fetchLimits['max_redirects']),
  };
}

function cloneCredentialSlots(
  value: NbSearchConfigPatch['credential_slots'],
): NbSearchConfigPatch['credential_slots'] {
  if (value === undefined || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([id, slot]) => [id, slot === null ? null : { ...slot }]),
  );
}

export function nbSearchCredentialEnv(draft: NbSearchDraft, providerInstanceId: string): string {
  const slotId = draft.providers[providerInstanceId]!.credentialSlotId;
  return draft.credentialSlots?.[slotId]?.env ?? '';
}

export function setNbSearchCredentialEnv(
  draft: NbSearchDraft,
  providerInstanceId: string,
  providerId: string,
  credentialEnv: string,
): NbSearchDraft {
  const slotId = draft.providers[providerInstanceId]!.credentialSlotId;
  const slots = { ...draft.credentialSlots };
  const existing = slots[slotId];
  if (credentialEnv === '') delete slots[slotId];
  else slots[slotId] = { provider_id: existing?.provider_id ?? providerId, env: credentialEnv };
  return {
    ...draft,
    credentialSlots: Object.keys(slots).length === 0 ? undefined : slots,
  };
}

export function nbSearchDraftFromConfig(
  configValue: NbSearchConfigPatch | undefined,
  capabilities: NbSearchCapabilities,
): NbSearchDraft {
  const config = asRecord(configValue);
  const instances = asRecord(config['provider_instances']);
  const credentialSlots = cloneCredentialSlots(configValue?.credential_slots);
  const defaults = asRecord(config['defaults']);
  const lane = defaults['search_lane'];
  const chains = asArray(defaults['fetch_chain']);
  const ownChain = chains
    .map((entry) => asRecord(entry))
    .find(
      (entry) =>
        entry['input_kind'] === NB_SEARCH_FETCH_CHAIN_INPUT
        && (entry['representation'] ?? NB_SEARCH_FETCH_CHAIN_REPRESENTATION) === NB_SEARCH_FETCH_CHAIN_REPRESENTATION,
    );
  const effectiveChain = capabilities.fetch.chains.find(
    (candidate) =>
      candidate.input_kind === NB_SEARCH_FETCH_CHAIN_INPUT
      && candidate.representation === NB_SEARCH_FETCH_CHAIN_REPRESENTATION,
  );
  const optionKeysByProvider = new Map(
    capabilities.providers.descriptors.map((descriptor) => [descriptor.provider_id, new Set(descriptor.option_keys)]),
  );
  const providers: Record<string, NbSearchProviderDraft> = {};
  for (const instance of capabilities.providers.instances) {
    const override = asRecord(instances[instance.id]);
    const configuredSlotId = asString(override['credential_slot_id']);
    const credentialSlotId = configuredSlotId || instance.credential.slot_id || instance.id;
    const allowedOptionKeys = optionKeysByProvider.get(instance.provider_id) ?? new Set<string>();
    const options = Object.fromEntries(
      Object.entries(asRecord(override['options'])).filter(([key]) => allowedOptionKeys.has(key)),
    );
    providers[instance.id] = {
      enabled: typeof override['enabled'] === 'boolean' ? override['enabled'] : instance.enabled,
      baseUrl: asString(override['base_url']),
      credentialSlotId,
      credentialSlotExplicit: configuredSlotId !== '',
      optionsJson: Object.keys(options).length > 0 ? JSON.stringify(options, null, 2) : '',
      keyStrategy: override['key_strategy'] === 'round-robin' || override['key_strategy'] === 'priority'
        ? override['key_strategy']
        : undefined,
      balanceTtlMs: typeof override['balance_ttl_ms'] === 'number' ? numberField(override['balance_ttl_ms']) : undefined,
    };
  }
  return {
    defaultSearchLane: typeof lane === 'string' ? lane : '',
    fetchChain: ownChain !== undefined
      ? asArray(ownChain['pipelines']).map((id) => asString(id)).filter((id) => id !== '')
      : [...(effectiveChain?.pipelines ?? [])],
    fetchChainInherited: ownChain === undefined,
    providers,
    credentialSlots,
    execution: executionDraftFromConfig(asRecord(config['execution'])),
    advanced: nbSearchAdvancedDraftFromConfig(configValue, capabilities),
  };
}

function parsePositiveInt(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0) {
    throw new LocalizedError({ key: 'st.nbSearch.invalidNumber', params: { value: trimmed } });
  }
  return value;
}

function assignNumber(target: Record<string, unknown>, key: string, raw: string): void {
  const value = parsePositiveInt(raw);
  // Empty means "no override": under full-domain replace the key must leave
  // the object, not linger from the loaded config.
  if (value === undefined) delete target[key];
  else target[key] = value;
}

/**
 * Build the full-domain replace body. The draft starts from the complete
 * saved `nb_search` object (unknown keys ride along), so a replace never
 * drops fields this editor does not render. Instances whose draft equals the
 * inherited runtime state are omitted — under replace semantics omitting the
 * key removes a stale override.
 */
export function nbSearchConfigPatch(
  configValue: NbSearchConfigPatch | undefined,
  draft: NbSearchDraft,
  capabilities: NbSearchCapabilities,
): { readonly nb_search: NbSearchConfigPatch; readonly replace_domains: readonly ['nb_search'] } {
  const config = asRecord(configValue);
  const result: Record<string, unknown> = { ...config };
  const optionKeysByProvider = new Map(
    capabilities.providers.descriptors.map((descriptor) => [descriptor.provider_id, new Set(descriptor.option_keys)]),
  );

  const baselineDraft = nbSearchDraftFromConfig(configValue, capabilities);
  const instances: Record<string, unknown> = { ...asRecord(config['provider_instances']) };
  let providerInstancesChanged = false;
  for (const [id, providerDraft] of Object.entries(draft.providers)) {
    const existingInstance = capabilities.providers.instances.find((instance) => instance.id === id);
    const baselineProvider = baselineDraft.providers[id] ?? { ...providerDraft, isNew: false };
    if (providerDraft.isDeleted) {
      delete instances[id];
      providerInstancesChanged = true;
      continue;
    }
    if (!providerDraft.isNew && JSON.stringify(providerDraft) === JSON.stringify(baselineProvider)) continue;
    const providerId = providerDraft.providerId ?? existingInstance?.provider_id;
    if (providerId === undefined || ((!existingInstance || providerDraft.optionsJson !== baselineProvider.optionsJson) && !optionKeysByProvider.has(providerId))) throw new Error(`Unknown provider for instance: ${id}`);
    const instance = existingInstance ?? { id, provider_id: providerId, enabled: true };
    const optionsText = providerDraft.optionsJson.trim();
    const allowedOptionKeys = optionKeysByProvider.get(instance.provider_id) ?? new Set<string>();
    let options: Record<string, unknown> = {};
    if (optionsText !== '') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(optionsText);
      } catch {
        throw new LocalizedError({ key: 'st.nbSearch.invalidOptions', params: { id: instance.id } });
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new LocalizedError({ key: 'st.nbSearch.invalidOptions', params: { id: instance.id } });
      }
      options = parsed as Record<string, unknown>;
      if (Object.keys(options).some((key) => !allowedOptionKeys.has(key))) {
        throw new LocalizedError({ key: 'st.nbSearch.invalidOptions', params: { id: instance.id } });
      }
    }
    const balanceTtlMs = parsePositiveInt(providerDraft.balanceTtlMs ?? '');
    if (balanceTtlMs !== undefined && (balanceTtlMs < 60_000 || balanceTtlMs > 86_400_000)) {
      throw new RangeError(`Provider balance TTL for ${instance.id} must be between 60000 and 86400000 milliseconds.`);
    }
    const providerChanged =
      providerDraft.enabled !== baselineProvider.enabled
      || providerDraft.baseUrl !== baselineProvider.baseUrl
      || providerDraft.credentialSlotId !== baselineProvider.credentialSlotId
      || providerDraft.credentialSlotExplicit !== baselineProvider.credentialSlotExplicit
      || providerDraft.optionsJson !== baselineProvider.optionsJson
      || providerDraft.keyStrategy !== baselineProvider.keyStrategy
      || providerDraft.balanceTtlMs !== baselineProvider.balanceTtlMs
      || providerDraft.isNew === true;
    if (!providerChanged) continue;
    providerInstancesChanged = true;
    const savedInstance = asRecord(instances[instance.id]);
    const hiddenOptions = Object.fromEntries(
      Object.entries(asRecord(savedInstance['options'])).filter(([key]) => !allowedOptionKeys.has(key)),
    );
    const mergedOptions = { ...hiddenOptions, ...options };
    const nextInstance = {
      ...savedInstance,
      provider_id: instance.provider_id,
      enabled: providerDraft.enabled,
      credential_slot_id: providerDraft.credentialSlotExplicit
        ? providerDraft.credentialSlotId
        : undefined,
      base_url: providerDraft.baseUrl.trim() === '' ? undefined : providerDraft.baseUrl.trim(),
      key_strategy: providerDraft.keyStrategy,
      balance_ttl_ms: balanceTtlMs,
      options: !providerDraft.isNew && providerDraft.optionsJson === baselineProvider.optionsJson ? savedInstance['options'] : mergedOptions,
    };
    const inherited =
      providerDraft.enabled === instance.enabled
      && nextInstance.base_url === undefined
      && !providerDraft.credentialSlotExplicit
      && nextInstance.key_strategy === undefined
      && nextInstance.balance_ttl_ms === undefined
      && Object.keys(asRecord(nextInstance.options)).length === 0
      && !providerDraft.isNew
      && instance.id === `${instance.provider_id}.default`
      && Object.keys(savedInstance).every((key) => [
        'provider_id', 'enabled', 'credential_slot_id', 'base_url', 'key_strategy', 'balance_ttl_ms', 'options',
      ].includes(key));
    if (inherited) delete instances[instance.id];
    else instances[instance.id] = nextInstance;
  }
  if (providerInstancesChanged) {
    if (Object.keys(instances).length > 0) result['provider_instances'] = instances;
    else delete result['provider_instances'];
  }
  if (draft.credentialSlots === undefined) delete result['credential_slots'];
  else result['credential_slots'] = cloneCredentialSlots(draft.credentialSlots);

  const defaults: Record<string, unknown> = { ...asRecord(config['defaults']) };
  if (draft.defaultSearchLane === '') delete defaults['search_lane'];
  else defaults['search_lane'] = draft.defaultSearchLane;
  const keptFetchChains = asArray(asRecord(config['defaults'])['fetch_chain'])
    .map((entry) => asRecord(entry))
    .filter(
      (entry) =>
        !(
          entry['input_kind'] === NB_SEARCH_FETCH_CHAIN_INPUT
          && (entry['representation'] ?? NB_SEARCH_FETCH_CHAIN_REPRESENTATION) === NB_SEARCH_FETCH_CHAIN_REPRESENTATION
        ),
    );
  if (draft.fetchChainInherited) {
    if (keptFetchChains.length === 0) delete defaults['fetch_chain'];
    else defaults['fetch_chain'] = keptFetchChains;
  } else {
    if (draft.fetchChain.length === 0) {
      throw new LocalizedError({ key: 'st.nbSearch.chainEmpty' });
    }
    defaults['fetch_chain'] = [
      ...keptFetchChains,
      {
        input_kind: NB_SEARCH_FETCH_CHAIN_INPUT,
        representation: NB_SEARCH_FETCH_CHAIN_REPRESENTATION,
        pipelines: [...draft.fetchChain],
      },
    ];
  }
  const advanced = draft.advanced;
  const baselineAdvanced = baselineDraft.advanced;
  const changed = (left: unknown, right: unknown) => JSON.stringify(left) !== JSON.stringify(right);
  if (advanced !== undefined && baselineAdvanced !== undefined) {
    const referenceChanges = changed(advanced.lanes, baselineAdvanced.lanes)
      || changed(advanced.presets, baselineAdvanced.presets)
      || changed(advanced.fetchChains, baselineAdvanced.fetchChains)
      || changed(advanced.routing, baselineAdvanced.routing)
      || draft.defaultSearchLane !== baselineDraft.defaultSearchLane
      || Object.values(draft.providers).some((provider) => provider.isDeleted);
    if (referenceChanges) {
      const issues = validateNbSearchReferences(configValue, draft, capabilities);
      if (issues.length > 0) throw new NbSearchReferenceError(issues);
    }
    if (changed(advanced.lanes, baselineAdvanced.lanes)) {
      if (Object.keys(advanced.lanes).length === 0) delete result['lanes'];
      else result['lanes'] = structuredClone(advanced.lanes);
    }
    if (changed(advanced.presets, baselineAdvanced.presets)) {
      if (Object.keys(advanced.presets).length === 0) delete result['presets'];
      else result['presets'] = structuredClone(advanced.presets);
    }
    if (changed(advanced.fetchChains, baselineAdvanced.fetchChains)) {
      const ownChains = advanced.fetchChains.filter((chain) => !chain.inherited);
      if (ownChains.some((chain) => chain.pipelines.length === 0)) throw new LocalizedError({ key: 'st.nbSearch.chainEmpty' });
      if (ownChains.length === 0) delete defaults['fetch_chain'];
      else defaults['fetch_chain'] = advanced.fetchChains.filter((chain) => chain.pipelines.length > 0).map((chain) => {
        const saved = asArray(asRecord(config['defaults'])['fetch_chain']).map(asRecord).find((entry) => entry['input_kind'] === chain.inputKind && (entry['representation'] ?? 'markdown') === chain.representation);
        return { ...saved, input_kind: chain.inputKind, representation: chain.representation, pipelines: [...chain.pipelines] };
      });
    }
    if (changed(advanced.fileScopes, baselineAdvanced.fileScopes) || changed(advanced.routing, baselineAdvanced.routing)) {
      const fetchConfig = { ...asRecord(config['fetch']) };
      if (changed(advanced.fileScopes, baselineAdvanced.fileScopes)) {
        if (advanced.fileScopes === undefined) delete fetchConfig['file_scopes'];
        else fetchConfig['file_scopes'] = structuredClone(advanced.fileScopes);
      }
      if (changed(advanced.routing, baselineAdvanced.routing)) {
        if (advanced.routing === undefined) delete fetchConfig['routing'];
        else fetchConfig['routing'] = structuredClone(advanced.routing);
      }
      if (Object.keys(fetchConfig).length > 0) result['fetch'] = fetchConfig;
      else delete result['fetch'];
    }
  }
  if (Object.keys(defaults).length > 0) result['defaults'] = defaults;
  else delete result['defaults'];

  const execution: Record<string, unknown> = { ...asRecord(config['execution']) };
  assignNumber(execution, 'max_provider_calls', draft.execution.maxProviderCalls);
  assignNumber(execution, 'max_concurrency', draft.execution.maxConcurrency);
  assignNumber(execution, 'retry_count', draft.execution.retryCount);
  assignNumber(execution, 'search_timeout_ms', draft.execution.searchTimeoutMs);
  assignNumber(execution, 'fetch_timeout_ms', draft.execution.fetchTimeoutMs);
  assignNumber(execution, 'max_inline_bytes', draft.execution.maxInlineBytes);
  const fetchLimits: Record<string, unknown> = { ...asRecord(execution['fetch']) };
  assignNumber(fetchLimits, 'max_source_bytes', draft.execution.fetchMaxSourceBytes);
  assignNumber(fetchLimits, 'max_response_bytes', draft.execution.fetchMaxResponseBytes);
  assignNumber(fetchLimits, 'max_content_chars', draft.execution.fetchMaxContentChars);
  assignNumber(fetchLimits, 'max_redirects', draft.execution.fetchMaxRedirects);
  if (advanced !== undefined && baselineAdvanced !== undefined
    && (advanced.qualityMinContentChars !== baselineAdvanced.qualityMinContentChars
      || changed(advanced.qualityBlockedMarkers, baselineAdvanced.qualityBlockedMarkers))) {
    const quality = { ...asRecord(fetchLimits['quality']) };
    assignNumber(quality, 'min_content_chars', advanced.qualityMinContentChars);
    if (advanced.qualityBlockedMarkers === undefined) delete quality['blocked_markers'];
    else quality['blocked_markers'] = [...advanced.qualityBlockedMarkers];
    if (Object.keys(quality).length > 0) fetchLimits['quality'] = quality;
    else delete fetchLimits['quality'];
  }
  if (Object.keys(fetchLimits).length > 0) execution['fetch'] = fetchLimits;
  else delete execution['fetch'];
  if (Object.keys(execution).length > 0) result['execution'] = execution;
  else delete result['execution'];

  return { nb_search: result as NbSearchConfigPatch, replace_domains: ['nb_search'] };
}

/** Dirty check for the page-level guard: any field away from the loaded baseline. */
export function nbSearchDraftDirty(baseline: NbSearchDraft, draft: NbSearchDraft): boolean {
  return JSON.stringify(baseline) !== JSON.stringify(draft);
}
