/**
 * nb-search settings helpers: wire-shape mirrors of the secret-free
 * `/nb-search/capabilities` + `/nb-search/test` payloads, and the draft/patch
 * mapping for the `nb_search` config domain. Pure and framework-free; the GUI
 * section composes these, the backend contract lives in kap-server's
 * rest-nb-search.ts and agent-core-v2's nbSearch configSection.
 *
 * Secret discipline: credential slots carry only an environment-variable
 * NAME. These types have no field that can hold a secret value, and the
 * capabilities payload is secret-free by construction (kap-server test
 * asserts no credential value leaks).
 */

import { LocalizedError } from '../i18n/locale';

// ---- wire mirrors (secret-free) ----

export interface NbSearchCapabilityIssue {
  readonly code: string;
  readonly execution?: string;
}

export interface NbSearchProviderDescriptor {
  readonly provider_id: string;
  readonly adapter_version: string;
  readonly activation: {
    readonly credential: 'required' | 'none';
    readonly endpoint: 'required' | 'optional' | 'none';
  };
  readonly option_keys: readonly string[];
}

export interface NbSearchProviderInstance {
  readonly id: string;
  readonly provider_id: string;
  readonly enabled: boolean;
  readonly availability: 'ready' | 'unavailable';
  readonly issues: readonly NbSearchCapabilityIssue[];
  readonly credential: {
    readonly requirement: 'required' | 'none' | 'unknown';
    readonly configured: boolean;
    readonly slot_id?: string;
  };
  readonly endpoint: {
    readonly requirement: 'required' | 'optional' | 'none' | 'unknown';
    readonly configured: boolean;
  };
}

export interface NbSearchLane {
  readonly id: string;
  readonly execution_modes: readonly string[];
  readonly availability: 'ready' | 'unavailable';
  readonly issues: readonly NbSearchCapabilityIssue[];
  readonly latency: string;
  readonly cost: string;
}

export interface NbSearchFetchPipeline {
  readonly id: string;
  readonly execution_modes: readonly string[];
  readonly availability: 'ready' | 'unavailable';
  readonly issues: readonly NbSearchCapabilityIssue[];
  readonly latency: string;
  readonly cost: string;
}

export interface NbSearchFetchChain {
  readonly input_kind: string;
  readonly representation?: string;
  readonly pipelines: readonly string[];
}

export interface NbSearchCapabilities {
  readonly schema_version: string;
  readonly revision: string;
  readonly providers: {
    readonly descriptors: readonly NbSearchProviderDescriptor[];
    readonly instances: readonly NbSearchProviderInstance[];
  };
  readonly search: {
    readonly default_lane?: string;
    readonly lanes: readonly NbSearchLane[];
    readonly limits: { readonly max_timeout_ms: number };
  };
  readonly fetch: {
    readonly chains: readonly NbSearchFetchChain[];
    readonly pipelines: readonly NbSearchFetchPipeline[];
  };
}

export interface NbSearchReadiness {
  readonly configured: boolean;
  readonly available: boolean;
  readonly selection?: string;
  readonly issues: readonly string[];
}

export interface NbSearchTestStatus {
  readonly revision: string;
  readonly search: NbSearchReadiness;
  readonly fetch: NbSearchReadiness;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function parseIssue(value: unknown): NbSearchCapabilityIssue {
  const record = asRecord(value);
  const execution = record['execution'];
  return { code: asString(record['code'], 'UNKNOWN'), execution: asString(execution) === '' ? undefined : asString(execution) };
}

function parseIssues(value: unknown): readonly NbSearchCapabilityIssue[] {
  return asArray(value).map(parseIssue);
}

/** Tolerant parse: kap-server already validated the envelope; missing keys degrade to empty lists instead of crashing the panel. */
export function parseNbSearchCapabilities(value: unknown): NbSearchCapabilities {
  const root = asRecord(value);
  const providers = asRecord(root['providers']);
  const search = asRecord(root['search']);
  const fetch = asRecord(root['fetch']);
  const defaultLane = search['default_lane'];
  return {
    schema_version: asString(root['schema_version']),
    revision: asString(root['revision']),
    providers: {
      descriptors: asArray(providers['descriptors']).map((entry) => {
        const record = asRecord(entry);
        const activation = asRecord(record['activation']);
        return {
          provider_id: asString(record['provider_id']),
          adapter_version: asString(record['adapter_version']),
          activation: {
            credential: activation['credential'] === 'none' ? 'none' : 'required',
            endpoint:
              activation['endpoint'] === 'required' || activation['endpoint'] === 'optional'
                ? activation['endpoint']
                : 'none',
          },
          option_keys: asArray(record['option_keys']).map((key) => asString(key)),
        };
      }),
      instances: asArray(providers['instances']).map((entry) => {
        const record = asRecord(entry);
        const credential = asRecord(record['credential']);
        const endpoint = asRecord(record['endpoint']);
        const slotId = credential['slot_id'];
        const credentialRequirement = credential['requirement'];
        const endpointRequirement = endpoint['requirement'];
        return {
          id: asString(record['id']),
          provider_id: asString(record['provider_id']),
          enabled: asBoolean(record['enabled'], true),
          availability: record['availability'] === 'ready' ? 'ready' : 'unavailable',
          issues: parseIssues(record['issues']),
          credential: {
            requirement:
              credentialRequirement === 'required' || credentialRequirement === 'none'
                ? credentialRequirement
                : 'unknown',
            configured: asBoolean(credential['configured']),
            slot_id: typeof slotId === 'string' ? slotId : undefined,
          },
          endpoint: {
            requirement:
              endpointRequirement === 'required' || endpointRequirement === 'optional' || endpointRequirement === 'none'
                ? endpointRequirement
                : 'unknown',
            configured: asBoolean(endpoint['configured']),
          },
        };
      }),
    },
    search: {
      default_lane: typeof defaultLane === 'string' ? defaultLane : undefined,
      lanes: asArray(search['lanes']).map((entry) => {
        const record = asRecord(entry);
        return {
          id: asString(record['id']),
          execution_modes: asArray(record['execution_modes']).map((mode) => asString(mode)),
          availability: record['availability'] === 'ready' ? 'ready' : 'unavailable',
          issues: parseIssues(record['issues']),
          latency: asString(record['latency']),
          cost: asString(record['cost']),
        };
      }),
      limits: { max_timeout_ms: Number(asRecord(search['limits'])['max_timeout_ms'] ?? 0) },
    },
    fetch: {
      chains: asArray(fetch['chains']).map((entry) => {
        const record = asRecord(entry);
        const representation = record['representation'];
        return {
          input_kind: asString(record['input_kind']),
          representation: typeof representation === 'string' ? representation : undefined,
          pipelines: asArray(record['pipelines']).map((id) => asString(id)),
        };
      }),
      pipelines: asArray(fetch['pipelines']).map((entry) => {
        const record = asRecord(entry);
        return {
          id: asString(record['id']),
          execution_modes: asArray(record['execution_modes']).map((mode) => asString(mode)),
          availability: record['availability'] === 'ready' ? 'ready' : 'unavailable',
          issues: parseIssues(record['issues']),
          latency: asString(record['latency']),
          cost: asString(record['cost']),
        };
      }),
    },
  };
}

function parseReadiness(value: unknown): NbSearchReadiness {
  const record = asRecord(value);
  const selection = record['selection'];
  return {
    configured: asBoolean(record['configured']),
    available: asBoolean(record['available']),
    selection: typeof selection === 'string' ? selection : undefined,
    issues: asArray(record['issues']).map((issue) => asString(issue)),
  };
}

export function parseNbSearchTestStatus(value: unknown): NbSearchTestStatus {
  const root = asRecord(value);
  return {
    revision: asString(root['revision']),
    search: parseReadiness(root['search']),
    fetch: parseReadiness(root['fetch']),
  };
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
  readonly enabled: boolean;
  readonly baseUrl: string;
  /** Environment-variable NAME for the credential slot; never a secret value. */
  readonly credentialEnv: string;
  readonly optionsJson: string;
}

export interface NbSearchDraft {
  readonly defaultSearchLane: string;
  readonly fetchChain: readonly string[];
  /** True while the url→markdown chain inherits the runtime default. */
  readonly fetchChainInherited: boolean;
  readonly providers: Readonly<Record<string, NbSearchProviderDraft>>;
  readonly execution: NbSearchExecutionDraft;
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

/** Slot id a provider instance's credential env name lives under. */
export function nbSearchCredentialSlotId(instance: NbSearchProviderInstance): string {
  return instance.credential.slot_id ?? instance.id;
}

export function nbSearchDraftFromConfig(
  configValue: unknown,
  capabilities: NbSearchCapabilities,
): NbSearchDraft {
  const config = asRecord(configValue);
  const instances = asRecord(config['provider_instances']);
  const slots = asRecord(config['credential_slots']);
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
  const providers: Record<string, NbSearchProviderDraft> = {};
  for (const instance of capabilities.providers.instances) {
    const override = asRecord(instances[instance.id]);
    const slot = asRecord(slots[nbSearchCredentialSlotId(instance)]);
    const options = override['options'];
    providers[instance.id] = {
      enabled: typeof override['enabled'] === 'boolean' ? override['enabled'] : instance.enabled,
      baseUrl: asString(override['base_url']),
      credentialEnv: asString(slot['env']),
      optionsJson:
        options !== null && typeof options === 'object' && Object.keys(asRecord(options)).length > 0
          ? JSON.stringify(options, null, 2)
          : '',
    };
  }
  return {
    defaultSearchLane: typeof lane === 'string' ? lane : '',
    fetchChain: ownChain !== undefined
      ? asArray(ownChain['pipelines']).map((id) => asString(id)).filter((id) => id !== '')
      : [...(effectiveChain?.pipelines ?? [])],
    fetchChainInherited: ownChain === undefined,
    providers,
    execution: executionDraftFromConfig(asRecord(config['execution'])),
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
  configValue: unknown,
  draft: NbSearchDraft,
  capabilities: NbSearchCapabilities,
): { readonly nb_search: Record<string, unknown>; readonly replace_domains: readonly ['nb_search'] } {
  const config = asRecord(configValue);
  const result: Record<string, unknown> = { ...config };

  const instances: Record<string, unknown> = {};
  const slots: Record<string, unknown> = {};
  for (const instance of capabilities.providers.instances) {
    const providerDraft = draft.providers[instance.id];
    if (providerDraft === undefined) continue;
    const optionsText = providerDraft.optionsJson.trim();
    let options: Record<string, unknown> | undefined;
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
    }
    const inherited =
      providerDraft.enabled === instance.enabled
      && providerDraft.baseUrl.trim() === ''
      && providerDraft.credentialEnv.trim() === ''
      && optionsText === '';
    if (inherited) continue;
    const slotId = nbSearchCredentialSlotId(instance);
    const env = providerDraft.credentialEnv.trim();
    if (env !== '') {
      slots[slotId] = { provider_id: instance.provider_id, env };
    }
    instances[instance.id] = {
      provider_id: instance.provider_id,
      enabled: providerDraft.enabled,
      credential_slot_id: env === '' ? undefined : slotId,
      base_url: providerDraft.baseUrl.trim() === '' ? undefined : providerDraft.baseUrl.trim(),
      options: options ?? {},
    };
  }
  if (Object.keys(instances).length > 0) result['provider_instances'] = instances;
  else delete result['provider_instances'];
  if (Object.keys(slots).length > 0) result['credential_slots'] = slots;
  else delete result['credential_slots'];

  const defaults: Record<string, unknown> = { ...asRecord(config['defaults']) };
  if (draft.defaultSearchLane === '') delete defaults['search_lane'];
  else defaults['search_lane'] = draft.defaultSearchLane;
  if (!draft.fetchChainInherited) {
    if (draft.fetchChain.length === 0) {
      throw new LocalizedError({ key: 'st.nbSearch.chainEmpty' });
    }
    const kept = asArray(asRecord(config['defaults'])['fetch_chain'])
      .map((entry) => asRecord(entry))
      .filter(
        (entry) =>
          !(
            entry['input_kind'] === NB_SEARCH_FETCH_CHAIN_INPUT
            && (entry['representation'] ?? NB_SEARCH_FETCH_CHAIN_REPRESENTATION) === NB_SEARCH_FETCH_CHAIN_REPRESENTATION
          ),
      );
    defaults['fetch_chain'] = [
      ...kept,
      {
        input_kind: NB_SEARCH_FETCH_CHAIN_INPUT,
        representation: NB_SEARCH_FETCH_CHAIN_REPRESENTATION,
        pipelines: [...draft.fetchChain],
      },
    ];
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
  if (Object.keys(fetchLimits).length > 0) execution['fetch'] = fetchLimits;
  if (Object.keys(execution).length > 0) result['execution'] = execution;
  else delete result['execution'];

  return { nb_search: result, replace_domains: ['nb_search'] };
}

/** Dirty check for the page-level guard: any field away from the loaded baseline. */
export function nbSearchDraftDirty(baseline: NbSearchDraft, draft: NbSearchDraft): boolean {
  return JSON.stringify(baseline) !== JSON.stringify(draft);
}
