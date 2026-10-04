import { describe, expect, it } from 'vitest';
import {
  nbSearchCapabilitiesSchema,
  nbSearchConfigPatchSchema,
  nbSearchTestStatusSchema,
  type NbSearchCapabilities,
  type NbSearchConfigPatch,
} from '@kiki/protocol';

import {
  NB_SEARCH_MAX_KEYS,
  formatMultiKey,
  formatNbSearchOutput,
  parseMultiKey,
  resolveEffectiveDefaultLane,
  validateKeyList,
  nbSearchConfigPatch,
  nbSearchCredentialEnv,
  nbSearchDraftDirty,
  nbSearchDraftFromConfig,
  nbSearchIssueCodes,
  nbSearchReadinessFromCapabilities,
  nbSearchReuseLocalConfig,
  nbSearchSourcePatch,
  setNbSearchCredentialEnv,
} from './nbSearch';

const CAPABILITIES: NbSearchCapabilities = {
  schema_version: '3.0',
  revision: 'config-test',
  providers: {
    descriptors: [
      {
        provider_id: 'exa',
        adapter_version: '1',
        query_operations: [{
          operation_id: 'search',
          output: { channel: 'results', schema_id: 'nb-search.results@1' },
          built_in_async: true,
        }],
        fetch_operations: [],
        activation: { credential: 'required', endpoint: 'optional' },
        option_keys: ['user_location'],
      },
      {
        provider_id: 'example',
        adapter_version: '1',
        query_operations: [{
          operation_id: 'documents',
          output: { channel: 'typed', schema_id: 'example.documents@1' },
          built_in_async: true,
        }],
        fetch_operations: [],
        activation: { credential: 'none', endpoint: 'none' },
        option_keys: [],
      },
      {
        provider_id: 'direct-http',
        adapter_version: '1',
        query_operations: [],
        fetch_operations: [{ operation_id: 'fetch' }],
        activation: { credential: 'none', endpoint: 'none' },
        option_keys: [],
      },
    ],
    instances: [
      {
        id: 'exa.default',
        provider_id: 'exa',
        enabled: true,
        availability: 'unavailable',
        issues: [{ code: 'CREDENTIAL_NOT_CONFIGURED' }, { code: 'LANE_NOT_CONFIGURED' }],
        credential: { requirement: 'required', configured: false, slot_id: 'exa.default' },
        endpoint: { requirement: 'optional', configured: false },
      },
      {
        id: 'direct-http.default',
        provider_id: 'direct-http',
        enabled: true,
        availability: 'ready',
        issues: [],
        credential: { requirement: 'none', configured: false },
        endpoint: { requirement: 'none', configured: false },
      },
    ],
  },
  search: {
    default_lane: undefined,
    lanes: [
      {
        id: 'exa.search',
        output: { channel: 'results', schema_id: 'nb-search.results@1' },
        execution_modes: ['sync'],
        availability: 'unavailable',
        issues: [{ code: 'LANE_NOT_CONFIGURED' }],
        latency: 'fast',
        cost: 'cheap',
      },
      {
        id: 'github.repositories',
        output: { channel: 'results', schema_id: 'nb-search.results@1' },
        execution_modes: ['sync', 'async'],
        availability: 'ready',
        issues: [],
        latency: 'fast',
        cost: 'free',
      },
      {
        id: 'example.documents',
        output: { channel: 'typed', schema_id: 'example.documents@1' },
        execution_modes: ['sync', 'async'],
        availability: 'ready',
        issues: [],
        latency: 'fast',
        cost: 'free',
      },
    ],
    presets: [],
    limits: { max_queries: 64, max_results: 100, max_timeout_ms: 3_600_000, max_inline_bytes: 65_536 },
  },
  fetch: {
    default_representation: 'markdown',
    inputs: [{ kind: 'url', enabled: true }],
    chains: [
      { input_kind: 'url', representation: 'markdown', pipelines: ['direct.fetch', 'jina.reader'] },
      { input_kind: 'file', representation: 'markdown', pipelines: ['direct.local'] },
    ],
    pipelines: [
      {
        id: 'direct.fetch',
        input_kinds: ['url'],
        media_types: ['text/html'],
        representations: ['markdown'],
        execution_modes: ['sync'],
        egress: 'url',
        stages: [{ id: 'direct-http', role: 'acquire' }],
        availability: 'ready',
        issues: [],
        latency: 'fast',
        cost: 'free',
      },
      {
        id: 'jina.reader',
        input_kinds: ['url'],
        media_types: ['text/html'],
        representations: ['markdown'],
        execution_modes: ['sync', 'async'],
        egress: 'url',
        stages: [{ id: 'jina-reader', role: 'reader' }],
        availability: 'unavailable',
        issues: [{ code: 'LANE_NOT_CONFIGURED' }],
        latency: 'medium',
        cost: 'free',
      },
      {
        id: 'direct.local',
        input_kinds: ['file'],
        media_types: ['text/plain'],
        representations: ['markdown'],
        execution_modes: ['sync', 'async'],
        egress: 'none',
        stages: [{ id: 'direct-file', role: 'acquire' }],
        availability: 'ready',
        issues: [],
        latency: 'fast',
        cost: 'free',
      },
    ],
    limits: {
      max_source_bytes: 2_097_152,
      max_response_bytes: 2_097_152,
      max_content_chars: 200_000,
      max_redirects: 5,
      max_timeout_ms: 60_000,
      max_inline_bytes: 65_536,
    },
  },
  jobs: { result_ttl_seconds: 259_200, cancel_supported: true },
};

describe('shared nb-search contracts', () => {
  it('keeps the capabilities fixture valid and formats shared issue/output shapes', () => {
    const parsed = nbSearchCapabilitiesSchema.parse(CAPABILITIES);
    expect(parsed.providers.instances.map((instance) => instance.id)).toEqual(['exa.default', 'direct-http.default']);
    expect(nbSearchIssueCodes(parsed.search.lanes[0]!.issues)).toEqual(['LANE_NOT_CONFIGURED']);
    expect(formatNbSearchOutput(parsed.search.lanes[0]!.output)).toBe('results · nb-search.results@1');
    expect(formatNbSearchOutput(parsed.search.lanes[1]!.output)).toBe('results · nb-search.results@1');
    expect(formatNbSearchOutput(parsed.search.lanes[2]!.output)).toBe('typed · example.documents@1');
  });

  it('uses the protocol readiness schema with optional selection', () => {
    const parsed = nbSearchTestStatusSchema.parse({
      revision: 'r1',
      search: { configured: false, available: false, issues: ['DEFAULT_NOT_CONFIGURED'] },
      fetch: { configured: true, available: true, selection: 'direct.fetch -> jina.reader', issues: [] },
    });
    expect(parsed.search.configured).toBe(false);
    expect(parsed.fetch.selection).toBe('direct.fetch -> jina.reader');
  });
});

describe('nb-search source preference', () => {
  it('defaults to local-base reuse and saves only the separate host preference', () => {
    expect(nbSearchReuseLocalConfig(undefined)).toBe(true);
    expect(nbSearchReuseLocalConfig({ reuse_local_config: false })).toBe(false);
    expect(nbSearchSourcePatch(false)).toEqual({ nb_search_source: { reuse_local_config: false } });
    expect(nbSearchSourcePatch(true)).toEqual({ nb_search_source: { reuse_local_config: true } });
  });

  it('does not derive a ready fetch fallback when the effective source is invalid', () => {
    const readiness = nbSearchReadinessFromCapabilities({
      ...CAPABILITIES,
      config_source: {
        reuse_local_config: true, layers: ['defaults', 'local', 'environment', 'kiki'],
        local_config: 'present', availability: 'unavailable', issues: ['EFFECTIVE_CONFIG_INVALID'],
      },
    });
    expect(readiness.search).toEqual({ configured: false, available: false, issues: ['EFFECTIVE_CONFIG_INVALID'] });
    expect(readiness.fetch).toEqual(readiness.search);
  });
});

describe('nbSearchReadinessFromCapabilities', () => {
  it('fails closed without a default lane, mirroring the backend test endpoint', () => {
    const readiness = nbSearchReadinessFromCapabilities(CAPABILITIES);
    expect(readiness.search).toEqual({ configured: false, available: false, issues: ['DEFAULT_NOT_CONFIGURED'] });
    expect(readiness.fetch.configured).toBe(true);
    // jina.reader is unavailable but direct.fetch can run sync: available with issues surfaced.
    expect(readiness.fetch.available).toBe(true);
    expect(readiness.fetch.selection).toBe('direct.fetch -> jina.reader');
    expect(readiness.fetch.issues).toEqual(['LANE_NOT_CONFIGURED']);
  });

  it('reports a ready configured lane and an unavailable chain', () => {
    const capabilities: NbSearchCapabilities = {
      ...CAPABILITIES,
      search: { ...CAPABILITIES.search, default_lane: 'github.repositories' },
      fetch: {
        ...CAPABILITIES.fetch,
        pipelines: CAPABILITIES.fetch.pipelines.map((pipeline) => ({
          ...pipeline,
          availability: 'unavailable' as const,
          execution_modes: [],
        })),
      },
    };
    const readiness = nbSearchReadinessFromCapabilities(capabilities);
    expect(readiness.search).toEqual({ configured: true, available: true, selection: 'github.repositories', issues: [] });
    expect(readiness.fetch.available).toBe(false);
    expect(readiness.fetch.issues).toContain('FETCH_CHAIN_UNAVAILABLE');
  });
});

describe('nbSearchDraftFromConfig', () => {
  it('inherits runtime defaults when the config carries no nb_search domain', () => {
    const draft = nbSearchDraftFromConfig(undefined, CAPABILITIES);
    expect(draft.defaultSearchLane).toBe('');
    expect(draft.fetchChainInherited).toBe(true);
    expect(draft.fetchChain).toEqual(['direct.fetch', 'jina.reader']);
    expect(draft.providers['exa.default']).toEqual({
      enabled: true,
      baseUrl: '',
      credentialSlotId: 'exa.default',
      credentialSlotExplicit: false,
      optionsJson: '',
    });
    expect(draft.credentialSlots).toBeUndefined();
    expect(nbSearchCredentialEnv(draft, 'exa.default')).toBe('');
    expect(draft.execution.maxProviderCalls).toBe('');
  });

  it('round-trips saved overrides into the draft', () => {
    const config: NbSearchConfigPatch = {
      defaults: {
        search_lane: 'exa.search',
        fetch_chain: [{ input_kind: 'url', representation: 'markdown', pipelines: ['jina.reader'] }],
      },
      provider_instances: {
        'exa.default': {
          provider_id: 'exa',
          enabled: false,
          credential_slot_id: 'team-search',
          base_url: 'https://exa.example.com',
          options: { user_location: 'US', retired_option: true },
        },
      },
      credential_slots: { 'team-search': { provider_id: 'exa', env: 'TEAM_EXA_API_KEY' } },
      execution: { max_concurrency: 4, fetch: { max_redirects: 3 } },
    };
    const draft = nbSearchDraftFromConfig(config, CAPABILITIES);
    expect(draft.defaultSearchLane).toBe('exa.search');
    expect(draft.fetchChainInherited).toBe(false);
    expect(draft.fetchChain).toEqual(['jina.reader']);
    expect(draft.providers['exa.default']).toEqual({
      enabled: false,
      baseUrl: 'https://exa.example.com',
      credentialSlotId: 'team-search',
      credentialSlotExplicit: true,
      optionsJson: JSON.stringify({ user_location: 'US' }, null, 2),
    });
    expect(nbSearchCredentialEnv(draft, 'exa.default')).toBe('TEAM_EXA_API_KEY');
    expect(draft.execution.maxConcurrency).toBe('4');
    expect(draft.execution.fetchMaxRedirects).toBe('3');

    const edited = setNbSearchCredentialEnv(
      draft,
      'exa.default',
      'exa',
      'ROTATED_EXA_API_KEY',
    );
    const patch = nbSearchConfigPatch(config, edited, CAPABILITIES);
    expect(patch.nb_search.provider_instances?.['exa.default']?.credential_slot_id).toBe('team-search');
    expect(patch.nb_search.credential_slots).toEqual({
      'team-search': { provider_id: 'exa', env: 'ROTATED_EXA_API_KEY' },
    });
  });
});

describe('credential slot preservation', () => {
  it('reads and preserves a capability default slot without a provider override', () => {
    const config: NbSearchConfigPatch = {
      credential_slots: {
        'exa.default': { provider_id: 'exa', env: 'TEAM_EXA_API_KEY' },
      },
    };
    const draft = nbSearchDraftFromConfig(config, CAPABILITIES);
    expect(draft.providers['exa.default']!.credentialSlotExplicit).toBe(false);
    expect(nbSearchCredentialEnv(draft, 'exa.default')).toBe('TEAM_EXA_API_KEY');
    const patch = nbSearchConfigPatch(config, { ...draft, defaultSearchLane: 'github.repositories' }, CAPABILITIES);
    expect(patch.nb_search.provider_instances).toBeUndefined();
    expect(patch.nb_search.credential_slots).toEqual(config.credential_slots);
  });

  it('preserves a non-matching unresolved explicit slot reference', () => {
    const config: NbSearchConfigPatch = {
      provider_instances: {
        'exa.default': { provider_id: 'exa', credential_slot_id: 'team-missing' },
      },
    };
    const draft = nbSearchDraftFromConfig(config, CAPABILITIES);
    expect(draft.providers['exa.default']!.credentialSlotId).toBe('team-missing');
    expect(draft.providers['exa.default']!.credentialSlotExplicit).toBe(true);
    expect(nbSearchCredentialEnv(draft, 'exa.default')).toBe('');
    const patch = nbSearchConfigPatch(config, { ...draft, defaultSearchLane: 'github.repositories' }, CAPABILITIES);
    expect(patch.nb_search.provider_instances).toEqual(config.provider_instances);
    expect(patch.nb_search.credential_slots).toBeUndefined();
  });

  it('uses one canonical draft value for two instances that share a slot', () => {
    const sharedInstance = {
      ...CAPABILITIES.providers.instances[0]!,
      credential: {
        ...CAPABILITIES.providers.instances[0]!.credential,
        slot_id: 'shared-search',
      },
    };
    const capabilities: NbSearchCapabilities = {
      ...CAPABILITIES,
      providers: {
        ...CAPABILITIES.providers,
        instances: [
          sharedInstance,
          { ...sharedInstance, id: 'exa.backup' },
          CAPABILITIES.providers.instances[1]!,
        ],
      },
    };
    const config: NbSearchConfigPatch = {
      credential_slots: {
        'shared-search': { provider_id: 'exa', env: 'SHARED_EXA_API_KEY' },
      },
    };
    const draft = nbSearchDraftFromConfig(config, capabilities);
    expect(nbSearchCredentialEnv(draft, 'exa.default')).toBe('SHARED_EXA_API_KEY');
    expect(nbSearchCredentialEnv(draft, 'exa.backup')).toBe('SHARED_EXA_API_KEY');
    const edited = setNbSearchCredentialEnv(draft, 'exa.backup', 'exa', 'ROTATED_SHARED_API_KEY');
    expect(nbSearchCredentialEnv(edited, 'exa.default')).toBe('ROTATED_SHARED_API_KEY');
    expect(nbSearchCredentialEnv(edited, 'exa.backup')).toBe('ROTATED_SHARED_API_KEY');
    const patch = nbSearchConfigPatch(config, edited, capabilities);
    expect(patch.nb_search.credential_slots).toEqual({
      'shared-search': { provider_id: 'exa', env: 'ROTATED_SHARED_API_KEY' },
    });
  });

  it('keeps default, shared, orphan, and null slots unchanged for lane/execution-only edits', () => {
    const config: NbSearchConfigPatch = {
      credential_slots: {
        'exa.default': { provider_id: 'exa', env: 'TEAM_EXA_API_KEY' },
        shared: { provider_id: 'exa', env: 'SHARED_EXA_API_KEY' },
        orphan: { provider_id: 'example', env: 'ORPHAN_API_KEY' },
        retired: null,
      },
    };
    const base = nbSearchDraftFromConfig(config, CAPABILITIES);
    const draft = {
      ...base,
      defaultSearchLane: 'github.repositories',
      execution: { ...base.execution, maxConcurrency: '8' },
    };
    const patch = nbSearchConfigPatch(config, draft, CAPABILITIES);
    expect(patch.nb_search.credential_slots).toEqual(config.credential_slots);
  });
});

describe('nbSearchConfigPatch', () => {
  it('always replaces only the nb_search domain', () => {
    const draft = nbSearchDraftFromConfig(undefined, CAPABILITIES);
    const patch = nbSearchConfigPatch(undefined, draft, CAPABILITIES);
    expect(patch.replace_domains).toEqual(['nb_search']);
    expect(patch.nb_search).toEqual({});
    expect('provider_instances' in patch.nb_search).toBe(false);
  });

  it('writes an implicit default credential slot without inventing a provider override', () => {
    const config: NbSearchConfigPatch = { presets: { fast: { lanes: ['exa.search'] } } };
    const base = nbSearchDraftFromConfig(config, CAPABILITIES);
    const withEnv = setNbSearchCredentialEnv(base, 'exa.default', 'exa', 'TEAM_EXA_API_KEY');
    const draft = { ...withEnv, defaultSearchLane: 'exa.search' };
    const patch = nbSearchConfigPatch(config, draft, CAPABILITIES);
    expect(patch.nb_search['presets']).toEqual({ fast: { lanes: ['exa.search'] } });
    expect(patch.nb_search['defaults']).toEqual({ search_lane: 'exa.search' });
    expect(patch.nb_search['provider_instances']).toBeUndefined();
    expect(patch.nb_search['credential_slots']).toEqual({
      'exa.default': { provider_id: 'exa', env: 'TEAM_EXA_API_KEY' },
    });
  });

  it('clears a saved default lane when the draft selects fail-closed', () => {
    const config: NbSearchConfigPatch = { defaults: { search_lane: 'exa.search' } };
    const draft = nbSearchDraftFromConfig(config, CAPABILITIES);
    const patch = nbSearchConfigPatch(config, { ...draft, defaultSearchLane: '' }, CAPABILITIES);
    expect(patch.nb_search['defaults']).toBeUndefined();
  });

  it('replaces only the url→markdown chain and keeps sibling chains', () => {
    const config: NbSearchConfigPatch = {
      defaults: {
        fetch_chain: [
          { input_kind: 'url', representation: 'markdown', pipelines: ['direct.fetch'] },
          { input_kind: 'file', representation: 'markdown', pipelines: ['direct.local'] },
        ],
      },
    };
    const base = nbSearchDraftFromConfig(config, CAPABILITIES);
    const patch = nbSearchConfigPatch(config, { ...base, fetchChain: ['jina.reader', 'direct.fetch'] }, CAPABILITIES);
    expect(patch.nb_search['defaults']).toEqual({
      fetch_chain: [
        { input_kind: 'file', representation: 'markdown', pipelines: ['direct.local'] },
        { input_kind: 'url', representation: 'markdown', pipelines: ['jina.reader', 'direct.fetch'] },
      ],
    });
  });

  it('removes the saved url→markdown chain when reset to runtime default and preserves siblings', () => {
    const config: NbSearchConfigPatch = {
      defaults: {
        fetch_chain: [
          { input_kind: 'url', representation: 'markdown', pipelines: ['jina.reader'] },
          { input_kind: 'file', representation: 'markdown', pipelines: ['direct.local'] },
        ],
      },
    };
    const base = nbSearchDraftFromConfig(config, CAPABILITIES);
    expect(base.fetchChainInherited).toBe(false);
    const patch = nbSearchConfigPatch(config, { ...base, fetchChainInherited: true }, CAPABILITIES);
    expect(patch.nb_search.defaults?.fetch_chain).toEqual([
      { input_kind: 'file', representation: 'markdown', pipelines: ['direct.local'] },
    ]);
    const reloaded = nbSearchDraftFromConfig(patch.nb_search, CAPABILITIES);
    expect(reloaded.fetchChainInherited).toBe(true);
    expect(reloaded.fetchChain).toEqual(['direct.fetch', 'jina.reader']);
  });

  it('writes numeric execution fields and removes emptied ones', () => {
    const config: NbSearchConfigPatch = {
      execution: {
        max_concurrency: 4,
        retry_count: 1,
        fetch: { max_redirects: 5, quality: { min_content_chars: 100, blocked_markers: [] } },
      },
    };
    const base = nbSearchDraftFromConfig(config, CAPABILITIES);
    const draft = {
      ...base,
      execution: { ...base.execution, maxConcurrency: '', searchTimeoutMs: '30000' },
    };
    const patch = nbSearchConfigPatch(config, draft, CAPABILITIES);
    expect(patch.nb_search['execution']).toEqual({
      retry_count: 1,
      search_timeout_ms: 30000,
      fetch: { max_redirects: 5, quality: { min_content_chars: 100, blocked_markers: [] } },
    });
  });

  it('rejects malformed numbers, undeclared options, and empty custom chains', () => {
    const base = nbSearchDraftFromConfig(undefined, CAPABILITIES);
    expect(() => nbSearchConfigPatch(undefined, {
      ...base,
      execution: { ...base.execution, maxConcurrency: 'two' },
    }, CAPABILITIES)).toThrowError(/not a non-negative whole number/);
    expect(() => nbSearchConfigPatch(undefined, {
      ...base,
      providers: { ...base.providers, 'exa.default': { ...base.providers['exa.default']!, optionsJson: '[1]' } },
    }, CAPABILITIES)).toThrowError(/must be a JSON object/);
    expect(() => nbSearchConfigPatch(undefined, {
      ...base,
      providers: {
        ...base.providers,
        'exa.default': { ...base.providers['exa.default']!, optionsJson: '{"undeclared":true}' },
      },
    }, CAPABILITIES)).toThrowError(/must be a JSON object/);
    expect(() => nbSearchConfigPatch(undefined, {
      ...base,
      fetchChainInherited: false,
      fetchChain: [],
    }, CAPABILITIES)).toThrowError(/at least one pipeline/);
  });
});

describe('nbSearchDraftDirty', () => {
  it('compares drafts structurally', () => {
    const base = nbSearchDraftFromConfig(undefined, CAPABILITIES);
    expect(nbSearchDraftDirty(base, base)).toBe(false);
    expect(nbSearchDraftDirty(base, { ...base, defaultSearchLane: 'exa.search' })).toBe(true);
  });
});

describe('provider instance preservation', () => {
  it('clears only base_url while preserving strategy, TTL, explicit slot, and hidden options', () => {
    const config: NbSearchConfigPatch = {
      provider_instances: {
        'exa.default': {
          provider_id: 'exa',
          base_url: 'https://search.example.test',
          credential_slot_id: 'team-search',
          key_strategy: 'priority',
          balance_ttl_ms: 120_000,
          options: { retired_option: { enabled: true } },
        },
      },
    };
    const base = nbSearchDraftFromConfig(config, CAPABILITIES);
    const patch = nbSearchConfigPatch(config, {
      ...base,
      providers: { ...base.providers, 'exa.default': { ...base.providers['exa.default']!, baseUrl: '' } },
    }, CAPABILITIES);
    const instance = patch.nb_search.provider_instances?.['exa.default'];
    expect(instance?.base_url).toBeUndefined();
    expect(instance?.key_strategy).toBe('priority');
    expect(instance?.balance_ttl_ms).toBe(120_000);
    expect(instance?.credential_slot_id).toBe('team-search');
    expect(instance?.options).toEqual({ retired_option: { enabled: true } });
  });

  it.each([
    { key_strategy: 'round-robin' as const },
    { balance_ttl_ms: 60_000 },
    { credential_slot_id: 'team-search' },
    { options: { retired_option: true } },
  ])('retains an instance when its only remaining override is %j', (override) => {
    const config: NbSearchConfigPatch = {
      provider_instances: {
        'exa.default': { provider_id: 'exa', base_url: 'https://search.example.test', ...override },
      },
    };
    const base = nbSearchDraftFromConfig(config, CAPABILITIES);
    const patch = nbSearchConfigPatch(config, {
      ...base,
      providers: { ...base.providers, 'exa.default': { ...base.providers['exa.default']!, baseUrl: '' } },
    }, CAPABILITIES);
    expect(patch.nb_search.provider_instances?.['exa.default']).toMatchObject(override);
    expect(patch.nb_search.provider_instances?.['exa.default']?.base_url).toBeUndefined();
  });

  it('removes a stale override only when all explicit settings have returned to the inherited state', () => {
    const config: NbSearchConfigPatch = {
      provider_instances: { 'exa.default': { provider_id: 'exa', base_url: 'https://search.example.test' } },
    };
    const base = nbSearchDraftFromConfig(config, CAPABILITIES);
    const patch = nbSearchConfigPatch(config, {
      ...base,
      providers: { ...base.providers, 'exa.default': { ...base.providers['exa.default']!, baseUrl: '' } },
    }, CAPABILITIES);
    expect(patch.nb_search.provider_instances).toBeUndefined();
  });

  it('preserves hidden instance fields rather than mistaking them for an empty default override', () => {
    const savedInstance = {
      provider_id: 'exa', base_url: 'https://search.example.test', future_setting: { enabled: true },
    };
    const config: NbSearchConfigPatch = { provider_instances: { 'exa.default': savedInstance } };
    const base = nbSearchDraftFromConfig(config, CAPABILITIES);
    const patch = nbSearchConfigPatch(config, {
      ...base,
      providers: { ...base.providers, 'exa.default': { ...base.providers['exa.default']!, baseUrl: '' } },
    }, CAPABILITIES);
    expect(patch.nb_search.provider_instances?.['exa.default']).toMatchObject({ future_setting: { enabled: true } });
  });

  it('retains a custom instance identity after clearing its last setting', () => {
    const capabilities: NbSearchCapabilities = {
      ...CAPABILITIES,
      providers: {
        ...CAPABILITIES.providers,
        instances: [...CAPABILITIES.providers.instances, { ...CAPABILITIES.providers.instances[0]!, id: 'exa.backup' }],
      },
    };
    const config: NbSearchConfigPatch = {
      provider_instances: { 'exa.backup': { provider_id: 'exa', base_url: 'https://backup.example.test' } },
    };
    const base = nbSearchDraftFromConfig(config, capabilities);
    const patch = nbSearchConfigPatch(config, {
      ...base,
      providers: { ...base.providers, 'exa.backup': { ...base.providers['exa.backup']!, baseUrl: '' } },
    }, capabilities);
    expect(patch.nb_search.provider_instances?.['exa.backup']?.provider_id).toBe('exa');
    expect(patch.nb_search.provider_instances?.['exa.backup']?.base_url).toBeUndefined();
  });

  it('replaces visible options without dropping hidden saved options', () => {
    const config: NbSearchConfigPatch = {
      provider_instances: {
        'exa.default': { provider_id: 'exa', options: { user_location: 'US', retired_option: true } },
      },
    };
    const base = nbSearchDraftFromConfig(config, CAPABILITIES);
    const patch = nbSearchConfigPatch(config, {
      ...base,
      providers: { ...base.providers, 'exa.default': { ...base.providers['exa.default']!, optionsJson: '' } },
    }, CAPABILITIES);
    expect(patch.nb_search.provider_instances?.['exa.default']?.options).toEqual({ retired_option: true });
  });
});

describe('provider key strategy and balance TTL drafts', () => {
  it('reads, updates, and round-trips explicit strategy and TTL overrides', () => {
    const config: NbSearchConfigPatch = {
      provider_instances: {
        'exa.default': { provider_id: 'exa', key_strategy: 'priority', balance_ttl_ms: 120_000 },
      },
    };
    const base = nbSearchDraftFromConfig(config, CAPABILITIES);
    expect(base.providers['exa.default']?.keyStrategy).toBe('priority');
    expect(base.providers['exa.default']?.balanceTtlMs).toBe('120000');
    expect(nbSearchConfigPatch(config, base, CAPABILITIES).nb_search.provider_instances).toEqual(config.provider_instances);
    const edited = {
      ...base,
      providers: {
        ...base.providers,
        'exa.default': { ...base.providers['exa.default']!, keyStrategy: 'round-robin' as const, balanceTtlMs: ' 60000 ' },
      },
    };
    expect(nbSearchDraftDirty(base, edited)).toBe(true);
    const patch = nbSearchConfigPatch(config, edited, CAPABILITIES);
    expect(patch.nb_search.provider_instances?.['exa.default']).toMatchObject({
      key_strategy: 'round-robin', balance_ttl_ms: 60_000,
    });
    const reloaded = nbSearchDraftFromConfig(patch.nb_search, CAPABILITIES);
    expect(reloaded.providers['exa.default']?.keyStrategy).toBe('round-robin');
    expect(reloaded.providers['exa.default']?.balanceTtlMs).toBe('60000');
  });

  it('removes emptied strategy and TTL without losing the explicit credential slot', () => {
    const config: NbSearchConfigPatch = {
      provider_instances: {
        'exa.default': {
          provider_id: 'exa', credential_slot_id: 'team-search', key_strategy: 'priority', balance_ttl_ms: 120_000,
        },
      },
    };
    const base = nbSearchDraftFromConfig(config, CAPABILITIES);
    const patch = nbSearchConfigPatch(config, {
      ...base,
      providers: {
        ...base.providers,
        'exa.default': { ...base.providers['exa.default']!, keyStrategy: undefined, balanceTtlMs: '' },
      },
    }, CAPABILITIES);
    expect(patch.nb_search.provider_instances?.['exa.default']?.key_strategy).toBeUndefined();
    expect(patch.nb_search.provider_instances?.['exa.default']?.balance_ttl_ms).toBeUndefined();
    expect(patch.nb_search.provider_instances?.['exa.default']?.credential_slot_id).toBe('team-search');
  });

  it.each(['60000', '86400000'])('accepts the inclusive TTL boundary %s milliseconds', (balanceTtlMs) => {
    const base = nbSearchDraftFromConfig(undefined, CAPABILITIES);
    const patch = nbSearchConfigPatch(undefined, {
      ...base,
      providers: { ...base.providers, 'exa.default': { ...base.providers['exa.default']!, balanceTtlMs } },
    }, CAPABILITIES);
    expect(patch.nb_search.provider_instances?.['exa.default']?.balance_ttl_ms).toBe(Number(balanceTtlMs));
  });

  it.each(['59999', '86400001'])('rejects the out-of-range TTL %s milliseconds', (balanceTtlMs) => {
    const base = nbSearchDraftFromConfig(undefined, CAPABILITIES);
    expect(() => nbSearchConfigPatch(undefined, {
      ...base,
      providers: { ...base.providers, 'exa.default': { ...base.providers['exa.default']!, balanceTtlMs } },
    }, CAPABILITIES)).toThrowError(/between 60000 and 86400000 milliseconds/);
  });

  it.each(['60000.5', 'invalid', 'Infinity', '-1'])('rejects non-integer TTL input %s', (balanceTtlMs) => {
    const base = nbSearchDraftFromConfig(undefined, CAPABILITIES);
    expect(() => nbSearchConfigPatch(undefined, {
      ...base,
      providers: { ...base.providers, 'exa.default': { ...base.providers['exa.default']!, balanceTtlMs } },
    }, CAPABILITIES)).toThrowError(/not a non-negative whole number/);
  });

  it.each([
    { keyStrategy: 'priority' as const },
    { balanceTtlMs: '60000' },
    { isDeleted: true },
    { isNew: true },
    { credentialSlotExplicit: true },
    { credentialSlotId: 'team-search' },
  ])('includes provider draft changes in the dirty check: %j', (providerPatch) => {
    const base = nbSearchDraftFromConfig(undefined, CAPABILITIES);
    expect(nbSearchDraftDirty(base, { ...base, providers: { ...base.providers } })).toBe(false);
    expect(nbSearchDraftDirty(base, {
      ...base,
      providers: { ...base.providers, 'exa.default': { ...base.providers['exa.default']!, ...providerPatch } },
    })).toBe(true);
  });

  it('saves credential-slot-only changes and materializes a newly selected default instance', () => {
    const base = nbSearchDraftFromConfig(undefined, CAPABILITIES);
    const patch = nbSearchConfigPatch(undefined, {
      ...base,
      providers: {
        ...base.providers,
        'exa.default': { ...base.providers['exa.default']!, credentialSlotId: 'team-search', credentialSlotExplicit: true },
        'direct-http.default': { ...base.providers['direct-http.default']!, isNew: true },
      },
    }, CAPABILITIES);
    expect(patch.nb_search.provider_instances?.['exa.default']?.credential_slot_id).toBe('team-search');
    expect(patch.nb_search.provider_instances?.['direct-http.default']?.provider_id).toBe('direct-http');
  });

  it('explicitly deletes one instance without validating its discarded fields or touching siblings', () => {
    const capabilities: NbSearchCapabilities = {
      ...CAPABILITIES,
      providers: {
        ...CAPABILITIES.providers,
        instances: [...CAPABILITIES.providers.instances, { ...CAPABILITIES.providers.instances[0]!, id: 'exa.backup' }],
      },
    };
    const config: NbSearchConfigPatch = {
      provider_instances: {
        'exa.default': { provider_id: 'exa', key_strategy: 'priority', balance_ttl_ms: 120_000 },
        'exa.backup': { provider_id: 'exa', key_strategy: 'round-robin', base_url: 'https://backup.example.test' },
      },
      credential_slots: { 'exa.default': { provider_id: 'exa', env: 'EXAMPLE_API_KEY' } },
    };
    const base = nbSearchDraftFromConfig(config, capabilities);
    const patch = nbSearchConfigPatch(config, {
      ...base,
      providers: {
        ...base.providers,
        'exa.default': { ...base.providers['exa.default']!, isDeleted: true, optionsJson: '[1]', balanceTtlMs: 'invalid' },
      },
    }, capabilities);
    expect(patch.nb_search.provider_instances).toEqual({ 'exa.backup': config.provider_instances!['exa.backup'] });
    expect(patch.nb_search.credential_slots).toEqual(config.credential_slots);
  });
});

describe('multi-key credential helpers', () => {
  it('parses comma-separated keys and formats them without extra spaces in priority order', () => {
    const keys = parseMultiKey(' first-key, ,second-key, third-key ,');
    expect(keys).toEqual(['first-key', 'second-key', 'third-key']);
    expect(formatMultiKey(keys)).toBe('first-key,second-key,third-key');
    expect(parseMultiKey(formatMultiKey(keys))).toEqual(keys);
    expect(validateKeyList(keys)).toEqual({ valid: true, tooMany: false, duplicates: [], empty: false });
  });

  it('allows no stored keys and handles missing values', () => {
    expect(parseMultiKey(undefined)).toEqual([]);
    expect(parseMultiKey(null)).toEqual([]);
    expect(parseMultiKey(' , , ')).toEqual([]);
    expect(formatMultiKey([])).toBe('');
    expect(validateKeyList([])).toEqual({ valid: true, tooMany: false, duplicates: [], empty: false });
  });

  it('accepts 32 keys and reports excess keys without silently truncating credentials', () => {
    expect(NB_SEARCH_MAX_KEYS).toBe(32);
    const keys = Array.from({ length: 33 }, (_, index) => `example-key-${index}`);
    const parsed = parseMultiKey(formatMultiKey(keys));
    expect(parsed).toEqual(keys);
    expect(validateKeyList(parsed)).toEqual({ valid: false, tooMany: true, duplicates: [], empty: false });
    expect(validateKeyList(keys.slice(0, 32)).valid).toBe(true);
  });

  it('reports each duplicate once and rejects empty or whitespace-only entries', () => {
    expect(validateKeyList(['key-a', 'key-b', 'key-a', 'key-a', ' key-b '])).toEqual({
      valid: false, tooMany: false, duplicates: ['key-a', 'key-b'], empty: false,
    });
    expect(validateKeyList(['key-a', '', '  '])).toEqual({
      valid: false, tooMany: false, duplicates: [], empty: true,
    });
  });
});

describe('resolveEffectiveDefaultLane', () => {
  it('keeps an explicit draft selection even when it matches the runtime default', () => {
    const capabilities = { ...CAPABILITIES, search: { ...CAPABILITIES.search, default_lane: 'exa.search' } };
    expect(resolveEffectiveDefaultLane(capabilities, 'github.repositories')).toEqual({
      laneId: 'github.repositories', inherited: false,
    });
    expect(resolveEffectiveDefaultLane(capabilities, 'exa.search')).toEqual({ laneId: 'exa.search', inherited: false });
  });

  it('resolves an empty draft to the effective runtime default, including an unconfigured default', () => {
    const capabilities = { ...CAPABILITIES, search: { ...CAPABILITIES.search, default_lane: 'exa.search' } };
    expect(resolveEffectiveDefaultLane(capabilities, '')).toEqual({ laneId: 'exa.search', inherited: true });
    expect(resolveEffectiveDefaultLane(CAPABILITIES, '')).toEqual({ laneId: undefined, inherited: true });
  });
});


describe('advanced nb-search draft contracts', () => {
  const lane = { provider_instance_id: 'exa.default', operation_id: 'search', latency: 'fast', cost: 'cheap', evidence_groups: ['web'] } as const;
  const editableLane = { ...lane, evidence_groups: [...lane.evidence_groups] };

  it('separates async-only from no available execution mode and keeps unavailable compatible pipelines discoverable', async () => {
    const { nbSearchExecutionKind, nbSearchCompatiblePipelines } = await import('./nbSearch');
    expect(nbSearchExecutionKind([])).toBe('none');
    expect(nbSearchExecutionKind(['async'])).toBe('async-only');
    expect(nbSearchExecutionKind(['sync', 'async'])).toBe('sync');
    expect(nbSearchCompatiblePipelines(CAPABILITIES, 'url', 'markdown').map((pipeline) => pipeline.id)).toEqual(['direct.fetch', 'jina.reader']);
    expect(nbSearchCompatiblePipelines(CAPABILITIES, 'inline_bytes', 'text')).toEqual([]);
  });

  it('edits lane and preset CRUD, reports references, and rejects dangling or typed preset lanes', async () => {
    const { setNbSearchLane, setNbSearchPreset, nbSearchLaneReferences, validateNbSearchReferences, NbSearchReferenceError } = await import('./nbSearch');
    let draft = setNbSearchLane(nbSearchDraftFromConfig(undefined, CAPABILITIES), 'team.query', editableLane);
    draft = setNbSearchPreset(draft, 'team', { lanes: ['team.query', 'github.repositories'] });
    draft = { ...draft, defaultSearchLane: 'team.query' };
    expect(nbSearchConfigPatch(undefined, draft, CAPABILITIES).nb_search.lanes?.['team.query']).toEqual(editableLane);
    expect(nbSearchLaneReferences(draft, 'team.query')).toEqual(['defaults.search_lane', 'presets.team']);
    const config = nbSearchConfigPatch(undefined, draft, CAPABILITIES).nb_search;
    draft = setNbSearchLane(draft, 'team.query', undefined);
    expect(validateNbSearchReferences(config, draft, CAPABILITIES).map((issue) => issue.path)).toEqual(['defaults.search_lane', 'presets.team']);
    expect(() => nbSearchConfigPatch(config, draft, CAPABILITIES)).toThrow(NbSearchReferenceError);
    const typed = setNbSearchPreset(nbSearchDraftFromConfig(undefined, CAPABILITIES), 'bad', { lanes: ['example.documents'] });
    expect(validateNbSearchReferences(undefined, typed, CAPABILITIES)[0]?.code).toBe('preset-results');
  });

  it('does not confuse deleting a built-in lane override with deleting a custom lane', async () => {
    const { setNbSearchLane, validateNbSearchReferences } = await import('./nbSearch');
    const capabilities: NbSearchCapabilities = { ...CAPABILITIES, inherited_configuration: {
      lanes: { 'exa.search': editableLane }, presets: {}, provider_instance_ids: ['exa.default'],
      default_search_lane: 'exa.search', fetch_chains: [], file_scopes: [],
    } };
    const config = { lanes: { 'exa.search': { ...editableLane, cost: 'expensive' as const } }, defaults: { search_lane: 'exa.search' }, presets: { saved: { lanes: ['exa.search'] } } };
    const draft = setNbSearchLane(nbSearchDraftFromConfig(config, capabilities), 'exa.search', undefined);
    expect(validateNbSearchReferences(config, draft, capabilities)).toEqual([]);
    expect(nbSearchConfigPatch(config, draft, capabilities).nb_search.lanes).toBeUndefined();
  });

  it('represents all eight input/output pairs and rejects nonexistent or incompatible pipelines', async () => {
    const { setNbSearchFetchChain, validateNbSearchReferences } = await import('./nbSearch');
    const base = nbSearchDraftFromConfig(undefined, CAPABILITIES);
    expect(base.advanced?.fetchChains).toHaveLength(8);
    expect(validateNbSearchReferences(undefined, setNbSearchFetchChain(base, 'inline_text', 'text', ['direct.fetch']), CAPABILITIES)[0]?.code).toBe('pipeline-incompatible');
    expect(validateNbSearchReferences(undefined, setNbSearchFetchChain(base, 'url', 'text', ['not.registered']), CAPABILITIES)[0]?.code).toBe('pipeline');
    expect(() => nbSearchConfigPatch(undefined, setNbSearchFetchChain(base, 'url', 'text', []), CAPABILITIES)).toThrow();
  });

  it('keeps order in multiple chains and restores one chain without dropping the inherited file chain', async () => {
    const { setNbSearchFetchChain } = await import('./nbSearch');
    const capabilities: NbSearchCapabilities = { ...CAPABILITIES, inherited_configuration: {
      lanes: {}, presets: {}, provider_instance_ids: [], fetch_chains: CAPABILITIES.fetch.chains, file_scopes: [],
    } };
    let draft = setNbSearchFetchChain(nbSearchDraftFromConfig(undefined, capabilities), 'url', 'markdown', ['jina.reader', 'direct.fetch']);
    let patch = nbSearchConfigPatch(undefined, draft, capabilities).nb_search;
    expect(patch.defaults?.fetch_chain).toEqual([
      { input_kind: 'url', representation: 'markdown', pipelines: ['jina.reader', 'direct.fetch'] },
      { input_kind: 'file', representation: 'markdown', pipelines: ['direct.local'] },
    ]);
    draft = setNbSearchFetchChain(draft, 'url', 'markdown', [], true);
    patch = nbSearchConfigPatch(undefined, draft, capabilities).nb_search;
    expect(patch.defaults?.fetch_chain).toBeUndefined();
  });

  it('edits structured scopes and quality fields, preserving unedited hidden fields', () => {
    const config: NbSearchConfigPatch = {
      fetch: { file_scopes: [{ id: 'docs', root: '/fixture/documents', media_types: ['text/plain'] }] },
      execution: { max_concurrency: 2, fetch: { max_redirects: 3, quality: { min_content_chars: 100, blocked_markers: ['blocked'] } } },
    };
    const base = nbSearchDraftFromConfig(config, CAPABILITIES);
    const next = { ...base, advanced: { ...base.advanced!, qualityMinContentChars: '0', qualityBlockedMarkers: [], fileScopes: [] } };
    const patch = nbSearchConfigPatch(config, next, CAPABILITIES).nb_search;
    expect(patch.execution).toEqual({ max_concurrency: 2, fetch: { max_redirects: 3, quality: { min_content_chars: 0, blocked_markers: [] } } });
    expect(patch.fetch?.file_scopes).toEqual([]);
    const restored = { ...next, advanced: { ...next.advanced, qualityMinContentChars: '', qualityBlockedMarkers: undefined, fileScopes: undefined } };
    const output = nbSearchConfigPatch(config, restored, CAPABILITIES).nb_search;
    expect(output.execution?.fetch).toEqual({ max_redirects: 3 });
    expect(output.fetch).toBeUndefined();
  });

  it('creates two same-provider instances with stable IDs and isolated slots and patches both before capabilities refresh', async () => {
    const { createNbSearchProviderInstance } = await import('./nbSearch');
    let draft = createNbSearchProviderInstance(nbSearchDraftFromConfig(undefined, CAPABILITIES), CAPABILITIES, 'exa', 'team-a', 'TEAM_A_KEY');
    draft = createNbSearchProviderInstance(draft, CAPABILITIES, 'exa', 'team-b', 'TEAM_B_KEY');
    const patch = nbSearchConfigPatch(undefined, draft, CAPABILITIES).nb_search;
    expect(patch.provider_instances?.['team-a']?.credential_slot_id).toBe('team-a');
    expect(patch.provider_instances?.['team-b']?.credential_slot_id).toBe('team-b');
    expect(patch.credential_slots?.['team-a']?.env).toBe('TEAM_A_KEY');
    expect(patch.credential_slots?.['team-b']?.env).toBe('TEAM_B_KEY');
    expect(() => createNbSearchProviderInstance(draft, CAPABILITIES, 'exa', 'team-a', 'TEAM_C_KEY')).toThrow();
    expect(() => createNbSearchProviderInstance(draft, CAPABILITIES, 'exa', 'team-c', 'TEAM_A_KEY')).toThrow();
    const deleted = { ...draft, providers: { ...draft.providers, 'team-a': { ...draft.providers['team-a']!, isDeleted: true } } };
    expect(nbSearchConfigPatch(undefined, deleted, CAPABILITIES).nb_search.provider_instances?.['team-b']).toEqual(patch.provider_instances?.['team-b']);
  });

  it('keeps an unedited unknown existing provider and all its opaque data without blocking unrelated settings or disabling it', () => {
    const capabilities: NbSearchCapabilities = { ...CAPABILITIES, providers: { ...CAPABILITIES.providers, instances: [...CAPABILITIES.providers.instances, {
      id: 'saved.opaque', provider_id: 'opaque', enabled: true, availability: 'unavailable', issues: [], credential: { requirement: 'unknown', configured: false }, endpoint: { requirement: 'unknown', configured: false },
    }] } };
    const config = { provider_instances: { 'saved.opaque': { provider_id: 'opaque', options: { future: { nested: true } } } } };
    const draft = nbSearchDraftFromConfig(config, capabilities);
    const edited = { ...draft, execution: { ...draft.execution, maxConcurrency: '4' } };
    expect(nbSearchConfigPatch(config, edited, capabilities).nb_search.provider_instances).toEqual(config.provider_instances);
    const disabled = { ...edited, providers: { ...edited.providers, 'saved.opaque': { ...edited.providers['saved.opaque']!, enabled: false } } };
    expect(nbSearchConfigPatch(config, disabled, capabilities).nb_search.provider_instances?.['saved.opaque']).toMatchObject({ enabled: false, options: { future: { nested: true } } });
    const removed = { ...disabled, providers: { ...disabled.providers, 'saved.opaque': { ...disabled.providers['saved.opaque']!, isDeleted: true } } };
    expect(nbSearchConfigPatch(config, removed, capabilities).nb_search.provider_instances).toBeUndefined();
  });
});


describe('advanced schema boundaries and opaque field preservation', () => {
  it('uses the real protocol limits for scopes, marker lists and quality thresholds', () => {
    const base = nbSearchDraftFromConfig(undefined, CAPABILITIES);
    const output = (advanced: typeof base.advanced) => nbSearchConfigPatch(undefined, { ...base, advanced }, CAPABILITIES).nb_search;
    expect(nbSearchConfigPatchSchema.safeParse(output({ ...base.advanced!, qualityMinContentChars: '10000000', qualityBlockedMarkers: Array.from({ length: 64 }, () => 'marker') })).success).toBe(true);
    expect(nbSearchConfigPatchSchema.safeParse(output({ ...base.advanced!, qualityMinContentChars: '10000001' })).success).toBe(false);
    expect(nbSearchConfigPatchSchema.safeParse(output({ ...base.advanced!, qualityBlockedMarkers: Array.from({ length: 65 }, () => 'marker') })).success).toBe(false);
    expect(nbSearchConfigPatchSchema.safeParse(output({ ...base.advanced!, fileScopes: [{ id: 'docs', root: '', media_types: [] }] })).success).toBe(false);
  });

  it('keeps opaque fields in the full domain and edited lane/preset/quality objects; schema legality remains a backend concern', async () => {
    const { setNbSearchLane, setNbSearchPreset } = await import('./nbSearch');
    const config = {
      future_domain: { retain: true },
      lanes: { custom: { provider_instance_id: 'exa.default', operation_id: 'search', latency: 'fast' as const, cost: 'cheap' as const, future_lane: 'keep' } },
      presets: { custom: { lanes: ['custom'], future_preset: 'keep' } },
      execution: { fetch: { quality: { min_content_chars: 80, future_quality: 'keep' } } },
    };
    let draft = nbSearchDraftFromConfig(config, CAPABILITIES);
    draft = setNbSearchLane(draft, 'custom', { provider_instance_id: 'exa.default', operation_id: 'search', latency: 'slow', cost: 'cheap' });
    draft = setNbSearchPreset(draft, 'custom', { lanes: ['custom', 'github.repositories'] });
    draft = { ...draft, advanced: { ...draft.advanced!, qualityMinContentChars: '120' } };
    const patch = nbSearchConfigPatch(config, draft, CAPABILITIES).nb_search;
    expect(patch).toMatchObject({ future_domain: { retain: true }, lanes: { custom: { future_lane: 'keep', latency: 'slow' } }, presets: { custom: { future_preset: 'keep' } }, execution: { fetch: { quality: { future_quality: 'keep', min_content_chars: 120 } } } });
  });
});


describe('reference validation follows the current edit rather than the entire saved catalog', () => {
  const healthy = { provider_instance_id: 'exa.default', operation_id: 'search', latency: 'fast' as const, cost: 'cheap' as const };
  const config: NbSearchConfigPatch = {
    provider_instances: { retired: { provider_id: 'exa', enabled: true, options: {} } },
    lanes: {
      healthy,
      'old.instance': { ...healthy, provider_instance_id: 'retired' },
      'old.operation': { ...healthy, operation_id: 'retired-operation' },
    },
    presets: { healthy: { lanes: ['healthy'] }, old: { lanes: ['missing-query'] } },
    defaults: { search_lane: 'missing-query', fetch_chain: [{ input_kind: 'url', representation: 'text', pipelines: ['missing-pipeline'] }] },
  };
  const caps: NbSearchCapabilities = {
    ...CAPABILITIES,
    configuration: {
      lanes: config.lanes as NonNullable<NbSearchCapabilities['configuration']>['lanes'],
      presets: config.presets as NonNullable<NbSearchCapabilities['configuration']>['presets'],
      provider_instance_ids: ['exa.default', 'direct-http.default', 'retired'],
      default_search_lane: 'missing-query', fetch_chains: config.defaults!.fetch_chain!, file_scopes: [],
    },
    inherited_configuration: {
      lanes: { 'exa.search': healthy }, presets: {}, provider_instance_ids: ['exa.default', 'direct-http.default'],
      fetch_chains: CAPABILITIES.fetch.chains, file_scopes: [],
    },
  };

  it('does not block quality/timeout-only saves on old unreported references', () => {
    const base = nbSearchDraftFromConfig(config, caps);
    const draft = { ...base, execution: { ...base.execution, searchTimeoutMs: '1200' }, advanced: { ...base.advanced!, qualityMinContentChars: '100' } };
    const patch = nbSearchConfigPatch(config, draft, caps).nb_search;
    expect(patch.lanes).toEqual(config.lanes);
    expect(patch.presets).toEqual(config.presets);
    expect(patch.defaults).toEqual(config.defaults);
    expect(patch.execution).toMatchObject({ search_timeout_ms: 1200, fetch: { quality: { min_content_chars: 100 } } });
  });

  it.each(['lane', 'preset'] as const)('allows a healthy %s edit while unrelated old instance/operation/preset/default/pipeline entries stay untouched', async (kind) => {
    const { setNbSearchLane, setNbSearchPreset, validateNbSearchReferences } = await import('./nbSearch');
    const base = nbSearchDraftFromConfig(config, caps);
    const draft = kind === 'lane' ? setNbSearchLane(base, 'healthy', { ...healthy, latency: 'slow' })
      : setNbSearchPreset(base, 'healthy', { lanes: ['healthy', 'github.repositories'] });
    expect(validateNbSearchReferences(config, draft, caps)).toEqual([]);
    const patch = nbSearchConfigPatch(config, draft, caps).nb_search;
    expect(patch.lanes?.['old.instance']).toEqual(config.lanes?.['old.instance']);
    expect(patch.lanes?.['old.operation']).toEqual(config.lanes?.['old.operation']);
    expect(patch.presets?.['old']).toEqual(config.presets?.['old']);
    expect(patch.defaults).toEqual(config.defaults);
  });

  it('allows repairing one old preset or chain reference without requiring all retained old references to resolve', async () => {
    const { setNbSearchPreset, setNbSearchFetchChain, validateNbSearchReferences } = await import('./nbSearch');
    const value: NbSearchConfigPatch = { ...config, presets: { old: { lanes: ['missing-query', 'another-missing'] } }, defaults: { ...config.defaults, fetch_chain: [{ input_kind: 'url', representation: 'markdown', pipelines: ['missing-pipeline', 'another-missing'] }] } };
    let draft = setNbSearchPreset(nbSearchDraftFromConfig(value, caps), 'old', { lanes: ['missing-query', 'healthy'] });
    draft = setNbSearchFetchChain(draft, 'url', 'markdown', ['missing-pipeline', 'direct.fetch']);
    expect(validateNbSearchReferences(value, draft, caps)).toEqual([]);
    expect(nbSearchConfigPatch(value, draft, caps).nb_search.presets?.['old']?.lanes).toEqual(['missing-query', 'healthy']);
  });

  it('rejects new invalid references with their own paths, without reporting unrelated baseline failures', async () => {
    const { setNbSearchLane, setNbSearchPreset, setNbSearchFetchChain, validateNbSearchReferences } = await import('./nbSearch');
    const base = nbSearchDraftFromConfig(config, caps);
    expect(validateNbSearchReferences(config, setNbSearchLane(base, 'new', { ...healthy, provider_instance_id: 'not-registered' }), caps)).toEqual([
      { code: 'instance', path: 'lanes.new', target: 'not-registered' },
    ]);
    expect(validateNbSearchReferences(config, setNbSearchLane(base, 'new', { ...healthy, operation_id: 'not-registered' }), caps)).toEqual([
      { code: 'operation', path: 'lanes.new', target: 'not-registered' },
    ]);
    expect(validateNbSearchReferences(config, setNbSearchPreset(base, 'new', { lanes: ['missing-query'] }), caps)).toEqual([
      { code: 'lane', path: 'presets.new', target: 'missing-query' },
    ]);
    expect(validateNbSearchReferences(config, setNbSearchFetchChain(base, 'inline_text', 'text', ['direct.fetch']), caps)).toEqual([
      { code: 'pipeline-incompatible', path: 'defaults.fetch_chain.inline_text.text', target: 'direct.fetch' },
    ]);
    expect(validateNbSearchReferences(config, { ...base, defaultSearchLane: 'another-missing' }, caps)).toEqual([
      { code: 'lane', path: 'defaults.search_lane', target: 'another-missing' },
    ]);
  });

  it('keeps explicit deletion blocking even if the exact same dangling preset issue already existed before deletion', async () => {
    const { setNbSearchLane, validateNbSearchReferences } = await import('./nbSearch');
    const value: NbSearchConfigPatch = { ...config, presets: { old: { lanes: ['old.instance'] } } };
    const draft = setNbSearchLane(nbSearchDraftFromConfig(value, caps), 'old.instance', undefined);
    expect(validateNbSearchReferences(value, draft, caps)).toEqual([
      { code: 'lane', path: 'presets.old', target: 'old.instance' },
    ]);
    expect(() => nbSearchConfigPatch(value, draft, caps)).toThrow();
    const withDefault: NbSearchConfigPatch = { ...value, defaults: { ...value.defaults, search_lane: 'old.instance' } };
    const deletedDefault = setNbSearchLane(nbSearchDraftFromConfig(withDefault, caps), 'old.instance', undefined);
    expect(validateNbSearchReferences(withDefault, deletedDefault, caps)).toEqual([
      { code: 'lane', path: 'defaults.search_lane', target: 'old.instance' },
      { code: 'lane', path: 'presets.old', target: 'old.instance' },
    ]);
  });

  it('does not waive an already-missing instance reference when the instance is explicitly deleted', async () => {
    const { validateNbSearchReferences } = await import('./nbSearch');
    const value: NbSearchConfigPatch = { ...config, presets: { old: { lanes: ['old.instance'] } } };
    const base = nbSearchDraftFromConfig(value, caps);
    const draft = { ...base, providers: { ...base.providers, retired: {
      providerId: 'exa', enabled: true, baseUrl: '', credentialSlotId: 'retired', credentialSlotExplicit: false, optionsJson: '', isDeleted: true,
    } } };
    expect(validateNbSearchReferences(value, draft, caps)).toEqual([
      { code: 'instance', path: 'lanes.old.instance', target: 'retired' },
      { code: 'lane', path: 'presets.old', target: 'old.instance' },
    ]);
    expect(() => nbSearchConfigPatch(value, draft, caps)).toThrow();
  });

  it('keeps deletion blocking for an unreported pipeline still referenced by an unchanged chain', async () => {
    const { setNbSearchLane, validateNbSearchReferences } = await import('./nbSearch');
    const value: NbSearchConfigPatch = { ...config,
      lanes: { ...config.lanes, 'custom.fetch': { ...healthy, provider_instance_id: 'direct-http.default', operation_id: 'fetch' } },
      defaults: { ...config.defaults, fetch_chain: [{ input_kind: 'url', representation: 'text', pipelines: ['custom.fetch'] }] },
    };
    const draft = setNbSearchLane(nbSearchDraftFromConfig(value, caps), 'custom.fetch', undefined);
    expect(validateNbSearchReferences(value, draft, caps)).toEqual([
      { code: 'pipeline', path: 'defaults.fetch_chain.url.text', target: 'custom.fetch' },
    ]);
    expect(() => nbSearchConfigPatch(value, draft, caps)).toThrow();
  });

  it('checks only newly introduced incompatible pipeline entries, permits registered unavailable lanes, and never changes availability', async () => {
    const { setNbSearchFetchChain, setNbSearchPreset, validateNbSearchReferences } = await import('./nbSearch');
    const value: NbSearchConfigPatch = { ...config, defaults: { ...config.defaults, fetch_chain: [{ input_kind: 'url', representation: 'text', pipelines: ['direct.fetch'] }] } };
    const base = nbSearchDraftFromConfig(value, caps);
    const badChain = setNbSearchFetchChain(base, 'url', 'text', ['direct.fetch', 'jina.reader']);
    expect(validateNbSearchReferences(value, badChain, caps)).toEqual([
      { code: 'pipeline-incompatible', path: 'defaults.fetch_chain.url.text', target: 'jina.reader' },
    ]);
    const preset = setNbSearchPreset(base, 'unavailable', { lanes: ['exa.search'] });
    expect(validateNbSearchReferences(value, preset, caps)).toEqual([]);
    expect(nbSearchConfigPatch(value, preset, caps).nb_search.presets?.['unavailable']).toEqual({ lanes: ['exa.search'] });
    expect(caps.search.lanes.find((lane) => lane.id === 'exa.search')?.availability).toBe('unavailable');
  });

  it('checks unchanged dependents when an operation change turns a results lane into a typed lane', async () => {
    const { createNbSearchProviderInstance, setNbSearchLane, validateNbSearchReferences } = await import('./nbSearch');
    let draft = createNbSearchProviderInstance(nbSearchDraftFromConfig(config, caps), caps, 'example', 'documents');
    draft = setNbSearchLane(draft, 'healthy', { ...healthy, provider_instance_id: 'documents', operation_id: 'documents' });
    expect(validateNbSearchReferences(config, draft, caps)).toEqual([
      { code: 'preset-results', path: 'presets.healthy', target: 'healthy' },
    ]);
  });
});

describe('standard fetch routing consumers', () => {
  const rule = { id: 'docs', match: { origin: 'https://example.com', path_globs: ['/docs/**'], representation: 'markdown' as const }, action: { pipelines: ['direct.fetch'] } };
  it('reuses the standard browser-safe schema and selector while accepting older capability envelopes', async () => {
    const { fetchRoutingConfigSchema, selectFetchRoute, FETCH_ROUTING_PACKAGE, BUILTIN_FETCH_ROUTE_RULES } = await import('@kiki/protocol');
    expect(nbSearchCapabilitiesSchema.safeParse(CAPABILITIES).success).toBe(true);
    expect(nbSearchConfigPatchSchema.parse({ fetch: { routing: { rules: [rule] } } }).fetch?.routing).toEqual({ rules: [rule] });
    expect(fetchRoutingConfigSchema.safeParse({ rules: [{ ...rule, match: { origin: 'https://example.com/path' } }] }).success).toBe(false);
    expect(selectFetchRoute({ url: 'https://example.com/docs/start' }, { rules: [rule] }, ['jina.reader'])).toMatchObject({ origin: 'user', rule_id: 'docs', pipelines: ['direct.fetch'] });
    expect(selectFetchRoute({ url: 'https://raw.githubusercontent.com/example/repo/main/README.md' }, {}, ['jina.reader'])).toMatchObject({ origin: 'builtin', package_id: FETCH_ROUTING_PACKAGE.id, package_version: FETCH_ROUTING_PACKAGE.version });
    expect(BUILTIN_FETCH_ROUTE_RULES).toHaveLength(4);
  });
  it('preserves ordered routing and file scopes on save, and restores inheritance without dropping other fetch fields', () => {
    const config: NbSearchConfigPatch = { fetch: { file_scopes: [{ id: 'docs', root: '/docs' }], routing: { rules: [rule], builtin_enabled: false } } };
    const base = nbSearchDraftFromConfig(config, CAPABILITIES);
    expect(base.advanced?.routing).toEqual(config.fetch?.routing);
    const changed = { ...base, advanced: { ...base.advanced!, routing: { ...base.advanced!.routing!, enabled: false } } };
    expect(nbSearchConfigPatch(config, changed, CAPABILITIES).nb_search.fetch).toEqual({ file_scopes: config.fetch?.file_scopes, routing: { rules: [rule], builtin_enabled: false, enabled: false } });
    const restored = { ...base, advanced: { ...base.advanced!, routing: undefined } };
    expect(nbSearchConfigPatch(config, restored, CAPABILITIES).nb_search.fetch).toEqual({ file_scopes: config.fetch?.file_scopes });
    expect(nbSearchConfigPatch(config, { ...base, advanced: { ...base.advanced!, routing: null } }, CAPABILITIES).nb_search.fetch).toEqual({ file_scopes: config.fetch?.file_scopes, routing: null });
  });
  it('tracks route pipeline references and rejects new incompatible or missing references before save', async () => {
    const { nbSearchLaneReferences, validateNbSearchReferences } = await import('./nbSearch');
    const base = nbSearchDraftFromConfig(undefined, CAPABILITIES);
    const draft = { ...base, advanced: { ...base.advanced!, routing: { rules: [rule] } } };
    expect(nbSearchLaneReferences(draft, 'direct.fetch')).toContain('fetch.routing.rules.docs');
    expect(validateNbSearchReferences(undefined, draft, CAPABILITIES)).toEqual([]);
    const invalid = { ...base, advanced: { ...base.advanced!, routing: { rules: [{ ...rule, action: { pipelines: ['missing'] } }] } } };
    expect(validateNbSearchReferences(undefined, invalid, CAPABILITIES)).toEqual([{ code: 'pipeline', path: 'fetch.routing.rules.docs', target: 'missing' }]);
    expect(() => nbSearchConfigPatch(undefined, invalid, CAPABILITIES)).toThrow('fetch.routing.rules.docs');
  });
});
