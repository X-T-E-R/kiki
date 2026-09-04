import type {
  NbSearchCapabilities,
  NbSearchConfigPatch,
  NbSearchTestStatus,
} from '@moonshot-ai/protocol';

import { LocalizedError } from '../i18n/locale';

export type NbSearchReadiness = NbSearchTestStatus['search'];

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
  readonly credentialSlotId: string;
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

export function nbSearchDraftFromConfig(
  configValue: NbSearchConfigPatch | undefined,
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
  const optionKeysByProvider = new Map(
    capabilities.providers.descriptors.map((descriptor) => [descriptor.provider_id, new Set(descriptor.option_keys)]),
  );
  const providers: Record<string, NbSearchProviderDraft> = {};
  for (const instance of capabilities.providers.instances) {
    const override = asRecord(instances[instance.id]);
    const configuredSlotId = asString(override['credential_slot_id']);
    const credentialSlotId = configuredSlotId || instance.credential.slot_id || instance.id;
    const slot = configuredSlotId === '' ? {} : asRecord(slots[configuredSlotId]);
    const allowedOptionKeys = optionKeysByProvider.get(instance.provider_id) ?? new Set<string>();
    const options = Object.fromEntries(
      Object.entries(asRecord(override['options'])).filter(([key]) => allowedOptionKeys.has(key)),
    );
    providers[instance.id] = {
      enabled: typeof override['enabled'] === 'boolean' ? override['enabled'] : instance.enabled,
      baseUrl: asString(override['base_url']),
      credentialSlotId,
      credentialEnv: asString(slot['env']),
      optionsJson: Object.keys(options).length > 0 ? JSON.stringify(options, null, 2) : '',
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
  configValue: NbSearchConfigPatch | undefined,
  draft: NbSearchDraft,
  capabilities: NbSearchCapabilities,
): { readonly nb_search: NbSearchConfigPatch; readonly replace_domains: readonly ['nb_search'] } {
  const config = asRecord(configValue);
  const result: Record<string, unknown> = { ...config };
  const optionKeysByProvider = new Map(
    capabilities.providers.descriptors.map((descriptor) => [descriptor.provider_id, new Set(descriptor.option_keys)]),
  );

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
      const allowedOptionKeys = optionKeysByProvider.get(instance.provider_id) ?? new Set<string>();
      if (Object.keys(options).some((key) => !allowedOptionKeys.has(key))) {
        throw new LocalizedError({ key: 'st.nbSearch.invalidOptions', params: { id: instance.id } });
      }
    }
    const inherited =
      providerDraft.enabled === instance.enabled
      && providerDraft.baseUrl.trim() === ''
      && providerDraft.credentialEnv.trim() === ''
      && optionsText === '';
    if (inherited) continue;
    const env = providerDraft.credentialEnv.trim();
    if (env !== '') {
      slots[providerDraft.credentialSlotId] = { provider_id: instance.provider_id, env };
    }
    instances[instance.id] = {
      provider_id: instance.provider_id,
      enabled: providerDraft.enabled,
      credential_slot_id: env === '' ? undefined : providerDraft.credentialSlotId,
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

  return { nb_search: result as NbSearchConfigPatch, replace_domains: ['nb_search'] };
}

/** Dirty check for the page-level guard: any field away from the loaded baseline. */
export function nbSearchDraftDirty(baseline: NbSearchDraft, draft: NbSearchDraft): boolean {
  return JSON.stringify(baseline) !== JSON.stringify(draft);
}
