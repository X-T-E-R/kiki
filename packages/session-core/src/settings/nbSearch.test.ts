import { describe, expect, it } from 'vitest';

import {
  nbSearchConfigPatch,
  nbSearchCredentialSlotId,
  nbSearchDraftDirty,
  nbSearchDraftFromConfig,
  nbSearchReadinessFromCapabilities,
  parseNbSearchCapabilities,
  parseNbSearchTestStatus,
  type NbSearchCapabilities,
} from './nbSearch';

const CAPABILITIES: NbSearchCapabilities = {
  schema_version: '3.0',
  revision: 'config-test',
  providers: {
    descriptors: [
      {
        provider_id: 'exa',
        adapter_version: '1',
        activation: { credential: 'required', endpoint: 'optional' },
        option_keys: ['user_location'],
      },
      {
        provider_id: 'direct-http',
        adapter_version: '1',
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
      { id: 'exa.search', execution_modes: ['sync'], availability: 'unavailable', issues: [{ code: 'LANE_NOT_CONFIGURED' }], latency: 'fast', cost: 'cheap' },
      { id: 'github.repositories', execution_modes: ['sync', 'async'], availability: 'ready', issues: [], latency: 'fast', cost: 'free' },
    ],
    limits: { max_timeout_ms: 3_600_000 },
  },
  fetch: {
    chains: [
      { input_kind: 'url', representation: 'markdown', pipelines: ['direct.fetch', 'jina.reader'] },
      { input_kind: 'file', representation: 'markdown', pipelines: ['direct.local'] },
    ],
    pipelines: [
      { id: 'direct.fetch', execution_modes: ['sync'], availability: 'ready', issues: [], latency: 'fast', cost: 'free' },
      { id: 'jina.reader', execution_modes: ['sync', 'async'], availability: 'unavailable', issues: [{ code: 'LANE_NOT_CONFIGURED' }], latency: 'medium', cost: 'free' },
      { id: 'direct.local', execution_modes: ['sync', 'async'], availability: 'ready', issues: [], latency: 'fast', cost: 'free' },
    ],
  },
};

describe('parseNbSearchCapabilities', () => {
  it('parses the wire payload and tolerates missing subtrees', () => {
    const parsed = parseNbSearchCapabilities(CAPABILITIES);
    expect(parsed.providers.instances.map((instance) => instance.id)).toEqual(['exa.default', 'direct-http.default']);
    expect(parsed.search.lanes[0]?.issues[0]?.code).toBe('LANE_NOT_CONFIGURED');
    expect(parsed.fetch.chains[0]?.pipelines).toEqual(['direct.fetch', 'jina.reader']);

    const empty = parseNbSearchCapabilities({});
    expect(empty.providers.instances).toEqual([]);
    expect(empty.search.lanes).toEqual([]);
    expect(empty.fetch.chains).toEqual([]);
  });
});

describe('parseNbSearchTestStatus', () => {
  it('parses readiness entries with optional selection', () => {
    const parsed = parseNbSearchTestStatus({
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
    expect(draft.providers['exa.default']).toEqual({ enabled: true, baseUrl: '', credentialEnv: '', optionsJson: '' });
    expect(draft.execution.maxProviderCalls).toBe('');
  });

  it('round-trips saved overrides into the draft', () => {
    const draft = nbSearchDraftFromConfig({
      defaults: {
        search_lane: 'exa.search',
        fetch_chain: [{ input_kind: 'url', representation: 'markdown', pipelines: ['jina.reader'] }],
      },
      provider_instances: { 'exa.default': { provider_id: 'exa', enabled: false, base_url: 'https://exa.example.com', options: { user_location: 'US' } } },
      credential_slots: { 'exa.default': { provider_id: 'exa', env: 'TEAM_EXA_API_KEY' } },
      execution: { max_concurrency: 4, fetch: { max_redirects: 3 } },
    }, CAPABILITIES);
    expect(draft.defaultSearchLane).toBe('exa.search');
    expect(draft.fetchChainInherited).toBe(false);
    expect(draft.fetchChain).toEqual(['jina.reader']);
    expect(draft.providers['exa.default']).toEqual({
      enabled: false,
      baseUrl: 'https://exa.example.com',
      credentialEnv: 'TEAM_EXA_API_KEY',
      optionsJson: JSON.stringify({ user_location: 'US' }, null, 2),
    });
    expect(draft.execution.maxConcurrency).toBe('4');
    expect(draft.execution.fetchMaxRedirects).toBe('3');
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

  it('writes only edited provider instances and carries unknown keys through', () => {
    const base = nbSearchDraftFromConfig({ presets: { fast: { lanes: ['exa.search'] } } }, CAPABILITIES);
    const draft = {
      ...base,
      defaultSearchLane: 'exa.search',
      providers: {
        ...base.providers,
        'exa.default': { ...base.providers['exa.default']!, credentialEnv: 'TEAM_EXA_API_KEY' },
      },
    };
    const patch = nbSearchConfigPatch({ presets: { fast: { lanes: ['exa.search'] } } }, draft, CAPABILITIES);
    expect(patch.nb_search['presets']).toEqual({ fast: { lanes: ['exa.search'] } });
    expect(patch.nb_search['defaults']).toEqual({ search_lane: 'exa.search' });
    expect(patch.nb_search['provider_instances']).toEqual({
      'exa.default': {
        provider_id: 'exa',
        enabled: true,
        credential_slot_id: 'exa.default',
        base_url: undefined,
        options: {},
      },
    });
    expect(patch.nb_search['credential_slots']).toEqual({
      'exa.default': { provider_id: 'exa', env: 'TEAM_EXA_API_KEY' },
    });
  });

  it('clears a saved default lane when the draft selects fail-closed', () => {
    const config = { defaults: { search_lane: 'exa.search' } };
    const draft = nbSearchDraftFromConfig(config, CAPABILITIES);
    const patch = nbSearchConfigPatch(config, { ...draft, defaultSearchLane: '' }, CAPABILITIES);
    expect(patch.nb_search['defaults']).toBeUndefined();
  });

  it('replaces only the url→markdown chain and keeps sibling chains', () => {
    const config = {
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

  it('writes numeric execution fields and removes emptied ones', () => {
    const config = { execution: { max_concurrency: 4, retry_count: 1, fetch: { max_redirects: 5, quality: { min_content_chars: 100, blocked_markers: [] } } } };
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

  it('rejects malformed numbers, options JSON, and empty custom chains', () => {
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
      fetchChainInherited: false,
      fetchChain: [],
    }, CAPABILITIES)).toThrowError(/at least one pipeline/);
  });
});

describe('nbSearchCredentialSlotId / nbSearchDraftDirty', () => {
  it('falls back to the instance id when the slot id is absent', () => {
    expect(nbSearchCredentialSlotId(CAPABILITIES.providers.instances[0]!)).toBe('exa.default');
    expect(nbSearchCredentialSlotId(CAPABILITIES.providers.instances[1]!)).toBe('direct-http.default');
  });

  it('compares drafts structurally', () => {
    const base = nbSearchDraftFromConfig(undefined, CAPABILITIES);
    expect(nbSearchDraftDirty(base, base)).toBe(false);
    expect(nbSearchDraftDirty(base, { ...base, defaultSearchLane: 'exa.search' })).toBe(true);
  });
});
