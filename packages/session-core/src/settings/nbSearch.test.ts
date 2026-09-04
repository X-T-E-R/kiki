import { describe, expect, it } from 'vitest';
import {
  nbSearchCapabilitiesSchema,
  nbSearchTestStatusSchema,
  type NbSearchCapabilities,
  type NbSearchConfigPatch,
} from '@moonshot-ai/protocol';

import {
  formatNbSearchOutput,
  nbSearchConfigPatch,
  nbSearchCredentialEnv,
  nbSearchDraftDirty,
  nbSearchDraftFromConfig,
  nbSearchIssueCodes,
  nbSearchReadinessFromCapabilities,
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
