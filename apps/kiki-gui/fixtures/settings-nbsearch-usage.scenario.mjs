import base from './settings-nbsearch.scenario.mjs';

const firecrawlLane = {
  provider_instance_id: 'firecrawl.default', operation_id: 'search', latency: 'fast', cost: 'cheap',
};
const teamUsage = {
  scope: 'team', unit: 'credits', used: 300, limit: 1000, remaining: 700,
  checked_at: '2026-01-01T12:00:00.000Z',
};

/** Two reads of the same team's remaining credits are not two team balances. */
export default {
  ...base,
  config: {
    ...base.config,
    nb_search: {
      ...base.config.nb_search,
      provider_instances: {
        'firecrawl.default': { provider_id: 'firecrawl', enabled: true, credential_slot_id: 'firecrawl.default', options: {} },
      },
      credential_slots: { 'firecrawl.default': { provider_id: 'firecrawl', env: 'FIXTURE_FIRECRAWL_API_KEY' } },
      lanes: { 'firecrawl.search': firecrawlLane },
      presets: { 'fixture-firecrawl': { lanes: ['firecrawl.search'] } },
      defaults: { ...base.config.nb_search.defaults, search_lane: 'firecrawl.search' },
    },
  },
  nbSearchManagedCredentials: { 'firecrawl.default': 'fixture-firecrawl-key-one,fixture-firecrawl-key-two' },
  nbSearchCapabilities: {
    ...base.nbSearchCapabilities,
    configuration: {
      ...base.nbSearchCapabilities.configuration,
      lanes: { ...base.nbSearchCapabilities.inherited_configuration.lanes, 'firecrawl.search': firecrawlLane },
      presets: { 'fixture-firecrawl': { lanes: ['firecrawl.search'] } },
      default_search_lane: 'firecrawl.search',
    },
  },
  nbSearchKeyUsage: {
    'firecrawl.default': {
      provider_instance_id: 'firecrawl.default', provider_id: 'firecrawl', balance_supported: true,
      keys: [
        { key_index: 1, state: 'unknown', usage: teamUsage },
        { key_index: 2, state: 'unknown', usage: { ...teamUsage, used: null, limit: null }, usage_error: 'unavailable' },
      ],
    },
  },
  nbSearchTest: {
    revision: 'config-fixture-nbsearch-usage',
    search: { configured: true, available: true, selection: 'firecrawl.search', issues: [] },
    fetch: base.nbSearchTest.fetch,
  },
};
