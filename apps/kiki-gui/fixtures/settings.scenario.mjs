/**
 * settings — demo data for the settings panels and responsive screenshots.
 *
 * No session-side event script is needed; the proof runner navigates to
 * /settings and reads the catalog endpoints served here.
 */

import { fid, sessionRecord, ts } from './helpers.mjs';

const SID = 'session_fixture_settings';
const WSID = 'wd_fixture_000000000000';

const SEARCH_SOURCE_CONFIGURATION = {
  lanes: {
    'exa.search': { provider_instance_id: 'exa.default', operation_id: 'search', latency: 'fast', cost: 'cheap' },
    'tavily.search': { provider_instance_id: 'tavily.default', operation_id: 'search', latency: 'fast', cost: 'cheap' },
    'searxng.search': { provider_instance_id: 'searxng.default', operation_id: 'search', latency: 'medium', cost: 'free' },
    'github.repositories': { provider_instance_id: 'github.default', operation_id: 'repositories', latency: 'fast', cost: 'free' },
    'example.documents': { provider_instance_id: 'example.default', operation_id: 'documents', latency: 'fast', cost: 'free' },
    'direct.fetch': { provider_instance_id: 'direct-http.default', operation_id: 'fetch', latency: 'fast', cost: 'free' },
    'jina.reader': { provider_instance_id: 'jina-reader.default', operation_id: 'reader', latency: 'medium', cost: 'free' },
    'tavily.extract': { provider_instance_id: 'tavily.default', operation_id: 'extract', latency: 'medium', cost: 'cheap' },
    'browser.render': { provider_instance_id: 'browser-render.default', operation_id: 'render', latency: 'slow', cost: 'expensive' },
  },
  presets: {},
  provider_instance_ids: [
    'brave', 'browser-render', 'context7', 'direct-http', 'duckduckgo', 'exa', 'firecrawl', 'github',
    'grok', 'grok-multi-agent', 'jina-reader', 'openai-compatible', 'parallel', 'searxng', 'tavily',
    'wayback', 'zhipu', 'example',
  ].map((provider) => `${provider}.default`),
  default_search_lane: 'github.repositories',
  fetch_chains: [{ input_kind: 'url', representation: 'markdown', pipelines: ['jina.reader', 'direct.fetch'] }],
  file_scopes: [],
};
const SEARCH_LOCAL_LANES = {
  'exa.search': { ...SEARCH_SOURCE_CONFIGURATION.lanes['exa.search'], evidence_groups: ['fixture-local'] },
};
const SEARCH_LOCAL_PRESETS = { 'fixture-fast': { lanes: ['exa.search', 'github.repositories'] } };
const SEARCH_LOCAL_CHAINS = [{ input_kind: 'url', representation: 'markdown', pipelines: ['direct.fetch', 'jina.reader'] }];
const SEARCH_LOCAL_SCOPES = [{ id: 'fixture-docs', root: 'C:/fixture/search-docs', media_types: ['text/plain', 'text/markdown'] }];
// Fetch routing as the saved config stores it: ordered user rules, each one a
// site plus path patterns and a complete pipeline list or the default chain.
const SEARCH_LOCAL_ROUTING = {
  enabled: true,
  builtin_enabled: true,
  rules: [
    { id: 'docs-reference', match: { origin: 'https://docs.example.test', path_globs: ['/reference/**'] }, action: { pipelines: ['direct.fetch'] } },
    { id: 'articles-keep-readers', match: { origin: 'https://news.example.test', path_globs: ['/articles/**'] }, action: { pipelines: ['direct.fetch', 'jina.reader'] } },
    { id: 'keep-old-chain', match: { origin: 'https://raw.githubusercontent.com', path_globs: ['/fixture/special/**'] }, action: { use: 'default' } },
  ],
};

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: settings demo' })],
  snapshots: {
    [SID]: { messages: [], has_more: false },
  },
  config: {
    default_provider: 'fixture',
    default_model: 'fixture/kiki-pro',
    default_permission_mode: 'manual',
    default_plan_mode: false,
    request_identity: {
      overrides: { client: { user_agent: 'host' } },
    },
    thinking: { enabled: true, effort: 'high' },
    // Engine defaults as GET /config returns them (camelCase, defaults filled).
    worktree: {
      enabled: true, root: '', branchPrefix: 'kiki/', defaultBase: 'head', gitTimeoutMs: 300000,
      cleanup: { auto: true, afterDays: 7, disposableIgnored: ['node_modules/', '.turbo/', 'dist/', '.venv/', 'target/'] },
    },
    session_residency: { idleTtlMs: 600000, maxLiveSessions: 8, minIdleMs: 60000, sweepIntervalMs: 30000, maxConcurrentRestores: 1, maxQueuedRestores: 8 },
    retry: { maxAttempts: 4, policies: [{ match: 'rate_limit', maxAttempts: 6, backoff: 1000, retry: true }] },
    loop_control: { maxAttemptsPerStep: 5 },
    merge_all_available_skills: true,
    extra_skill_dirs: ['C:/fixture/skills'],
    // Session titles: the feature is on, a model is picked, and one moment
    // is ticked beside the default one. The card has to read this as "two of
    // three moments", never as a fallback to the fast model.
    session_title: {
      model: 'fixture/kiki-lite',
      triggers: ['first_user_message', 'first_turn_completed'],
    },
    experimental: { search_worker: true, auto_session_title: true },
    // nb_search: one configured service (Exa, with a two-key credential) out of
    // the whole engine catalogue. This is the S1 acceptance shape: the page must
    // open on the service in use, not on every instance the engine ships.
    nb_search: {
      credential_slots: {
        'exa.default': { provider_id: 'exa', env: 'NB_SEARCH_EXA_API_KEY' },
      },
      provider_instances: {
        'exa.default': {
          provider_id: 'exa',
          enabled: true,
          credential_slot_id: 'exa.default',
          options: {},
        },
      },
      lanes: SEARCH_LOCAL_LANES,
      presets: SEARCH_LOCAL_PRESETS,
      defaults: { search_lane: 'exa.search', fetch_chain: SEARCH_LOCAL_CHAINS },
      fetch: { file_scopes: SEARCH_LOCAL_SCOPES, routing: SEARCH_LOCAL_ROUTING },
      execution: {
        max_concurrency: 4, search_timeout_ms: 30000,
        fetch: { quality: { min_content_chars: 1200, blocked_markers: ['Access denied', 'Please enable JavaScript'] } },
      },
    },
    providers: {
      fixture: {
        type: 'openai',
        has_api_key: true,
      },
      alt: {
        type: 'anthropic',
        has_api_key: false,
      },
    },
  },
  // The two keys the fixture already saved for Exa. The engine stores a key
  // list as one ordered comma-separated value, which is what the editor splits
  // back into rows.
  nbSearchManagedCredentials: { 'exa.default': 'fixture-managed-exa-key,fixture-managed-exa-key-2' },
  // /api/nb-search/* — secret-free capabilities + on-demand readiness for
  // the Search & retrieval settings leaf. The instance catalogue mirrors the
  // engine's own 17 defaults (plus the synthetic `example` used for typed-output
  // rendering); only `exa.default` carries a saved override, so the service list
  // opens with one row and everything else waits in the directory.
  nbSearchCapabilities: {
    schema_version: '3.0',
    revision: 'config-fixture-nbsearch',
    inherited_configuration: SEARCH_SOURCE_CONFIGURATION,
    configuration: {
      ...SEARCH_SOURCE_CONFIGURATION,
      lanes: { ...SEARCH_SOURCE_CONFIGURATION.lanes, ...SEARCH_LOCAL_LANES },
      presets: SEARCH_LOCAL_PRESETS,
      default_search_lane: 'exa.search',
      fetch_chains: SEARCH_LOCAL_CHAINS,
      file_scopes: SEARCH_LOCAL_SCOPES,
      routing: SEARCH_LOCAL_ROUTING,
    },
    providers: {
      descriptors: [
        { provider_id: 'brave', adapter_version: '1', query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'required', endpoint: 'optional' }, option_keys: [] },
        { provider_id: 'browser-render', adapter_version: '1', query_operations: [], fetch_operations: [{ operation_id: 'render' }], activation: { credential: 'none', endpoint: 'none' }, option_keys: [] },
        { provider_id: 'context7', adapter_version: '1', query_operations: [{ operation_id: 'docs', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'required', endpoint: 'optional' }, option_keys: [] },
        { provider_id: 'direct-http', adapter_version: '1', query_operations: [], fetch_operations: [{ operation_id: 'fetch' }], activation: { credential: 'none', endpoint: 'none' }, option_keys: [] },
        { provider_id: 'duckduckgo', adapter_version: '1', query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'none', endpoint: 'none' }, option_keys: [] },
        { provider_id: 'exa', adapter_version: '1', query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'required', endpoint: 'optional' }, option_keys: ['user_location'] },
        { provider_id: 'firecrawl', adapter_version: '1', query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [{ operation_id: 'scrape' }], activation: { credential: 'required', endpoint: 'optional' }, option_keys: [] },
        { provider_id: 'github', adapter_version: '1', query_operations: [{ operation_id: 'repositories', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'required', endpoint: 'none' }, option_keys: [] },
        { provider_id: 'grok', adapter_version: '1', query_operations: [{ operation_id: 'synthesis', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'required', endpoint: 'none' }, option_keys: ['model'] },
        { provider_id: 'grok-multi-agent', adapter_version: '1', query_operations: [{ operation_id: 'research', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'required', endpoint: 'none' }, option_keys: ['model', 'reasoning_effort'] },
        { provider_id: 'jina-reader', adapter_version: '1', query_operations: [], fetch_operations: [{ operation_id: 'reader' }], activation: { credential: 'none', endpoint: 'optional' }, option_keys: [] },
        { provider_id: 'openai-compatible', adapter_version: '1', query_operations: [{ operation_id: 'synthesis', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [{ operation_id: 'fetch' }], activation: { credential: 'required', endpoint: 'required' }, option_keys: ['model'] },
        { provider_id: 'parallel', adapter_version: '1', query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'required', endpoint: 'none' }, option_keys: [] },
        { provider_id: 'searxng', adapter_version: '1', query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'none', endpoint: 'required' }, option_keys: [] },
        { provider_id: 'tavily', adapter_version: '1', query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [{ operation_id: 'extract' }], activation: { credential: 'required', endpoint: 'optional' }, option_keys: [] },
        { provider_id: 'wayback', adapter_version: '1', query_operations: [], fetch_operations: [{ operation_id: 'fetch' }], activation: { credential: 'none', endpoint: 'none' }, option_keys: [] },
        { provider_id: 'zhipu', adapter_version: '1', query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'required', endpoint: 'none' }, option_keys: [] },
        // Synthetic provider used only to exercise typed-output rendering.
        { provider_id: 'example', adapter_version: '1', query_operations: [{ operation_id: 'documents', output: { channel: 'typed', schema_id: 'example.documents@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'none', endpoint: 'none' }, option_keys: [] },
      ],
      instances: [
        { id: 'brave.default', provider_id: 'brave', enabled: true, availability: 'unavailable', issues: [{ code: 'CREDENTIAL_NOT_CONFIGURED' }], credential: { requirement: 'required', configured: false, slot_id: 'brave.default' }, endpoint: { requirement: 'optional', configured: false } },
        { id: 'browser-render.default', provider_id: 'browser-render', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'none', configured: false }, endpoint: { requirement: 'none', configured: false } },
        { id: 'context7.default', provider_id: 'context7', enabled: true, availability: 'unavailable', issues: [{ code: 'CREDENTIAL_NOT_CONFIGURED' }], credential: { requirement: 'required', configured: false, slot_id: 'context7.default' }, endpoint: { requirement: 'optional', configured: false } },
        { id: 'direct-http.default', provider_id: 'direct-http', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'none', configured: false }, endpoint: { requirement: 'none', configured: false } },
        { id: 'duckduckgo.default', provider_id: 'duckduckgo', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'none', configured: false }, endpoint: { requirement: 'none', configured: false } },
        { id: 'exa.default', provider_id: 'exa', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'required', configured: true, slot_id: 'exa.default' }, endpoint: { requirement: 'optional', configured: false } },
        { id: 'firecrawl.default', provider_id: 'firecrawl', enabled: true, availability: 'unavailable', issues: [{ code: 'CREDENTIAL_NOT_CONFIGURED' }], credential: { requirement: 'required', configured: false, slot_id: 'firecrawl.default' }, endpoint: { requirement: 'optional', configured: false } },
        { id: 'github.default', provider_id: 'github', enabled: true, availability: 'ready', issues: [{ code: 'RATE_LIMIT_UNAUTHENTICATED' }], credential: { requirement: 'required', configured: false, slot_id: 'github.default' }, endpoint: { requirement: 'none', configured: false } },
        { id: 'grok.default', provider_id: 'grok', enabled: true, availability: 'unavailable', issues: [{ code: 'CREDENTIAL_NOT_CONFIGURED' }], credential: { requirement: 'required', configured: false, slot_id: 'grok.default' }, endpoint: { requirement: 'none', configured: false } },
        { id: 'grok-multi-agent.default', provider_id: 'grok-multi-agent', enabled: true, availability: 'unavailable', issues: [{ code: 'CREDENTIAL_NOT_CONFIGURED' }], credential: { requirement: 'required', configured: false, slot_id: 'grok-multi-agent.default' }, endpoint: { requirement: 'none', configured: false } },
        { id: 'jina-reader.default', provider_id: 'jina-reader', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'none', configured: false, slot_id: 'jina-reader.default' }, endpoint: { requirement: 'optional', configured: false } },
        { id: 'openai-compatible.default', provider_id: 'openai-compatible', enabled: true, availability: 'unavailable', issues: [{ code: 'CREDENTIAL_NOT_CONFIGURED' }, { code: 'ENDPOINT_NOT_CONFIGURED' }], credential: { requirement: 'required', configured: false, slot_id: 'openai-compatible.default' }, endpoint: { requirement: 'required', configured: false } },
        { id: 'parallel.default', provider_id: 'parallel', enabled: true, availability: 'unavailable', issues: [{ code: 'CREDENTIAL_NOT_CONFIGURED' }], credential: { requirement: 'required', configured: false, slot_id: 'parallel.default' }, endpoint: { requirement: 'none', configured: false } },
        { id: 'searxng.default', provider_id: 'searxng', enabled: true, availability: 'unavailable', issues: [{ code: 'ENDPOINT_NOT_CONFIGURED' }], credential: { requirement: 'none', configured: false }, endpoint: { requirement: 'required', configured: false } },
        { id: 'tavily.default', provider_id: 'tavily', enabled: true, availability: 'unavailable', issues: [{ code: 'CREDENTIAL_NOT_CONFIGURED' }], credential: { requirement: 'required', configured: false, slot_id: 'tavily.default' }, endpoint: { requirement: 'optional', configured: false } },
        { id: 'wayback.default', provider_id: 'wayback', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'none', configured: false }, endpoint: { requirement: 'none', configured: false } },
        { id: 'zhipu.default', provider_id: 'zhipu', enabled: true, availability: 'unavailable', issues: [{ code: 'CREDENTIAL_NOT_CONFIGURED' }], credential: { requirement: 'required', configured: false, slot_id: 'zhipu.default' }, endpoint: { requirement: 'none', configured: false } },
        { id: 'example.default', provider_id: 'example', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'none', configured: false }, endpoint: { requirement: 'none', configured: false } },
      ],
    },
    search: {
      default_lane: 'exa.search',
      lanes: [
        { id: 'exa.search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: ['sync', 'async'], availability: 'ready', issues: [], latency: 'fast', cost: 'cheap' },
        { id: 'tavily.search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: [], availability: 'unavailable', issues: [{ code: 'CREDENTIAL_NOT_CONFIGURED' }, { code: 'PROVIDER_DISABLED' }], latency: 'fast', cost: 'cheap' },
        { id: 'searxng.search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: [], availability: 'unavailable', issues: [{ code: 'ENDPOINT_NOT_CONFIGURED' }], latency: 'medium', cost: 'free' },
        { id: 'github.repositories', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: ['sync', 'async'], availability: 'ready', issues: [{ code: 'RATE_LIMIT_UNAUTHENTICATED' }], latency: 'fast', cost: 'free' },
        { id: 'example.documents', output: { channel: 'typed', schema_id: 'example.documents@1' }, execution_modes: ['sync', 'async'], availability: 'ready', issues: [], latency: 'fast', cost: 'free' },
      ],
      presets: [],
      limits: { max_queries: 64, max_results: 100, max_timeout_ms: 3_600_000, max_inline_bytes: 65_536 },
    },
    fetch: {
      default_representation: 'markdown',
      inputs: [{ kind: 'url', enabled: true, max_bytes: 2_097_152 }],
      chains: [{ input_kind: 'url', representation: 'markdown', pipelines: ['direct.fetch', 'jina.reader'] }],
      pipelines: [
        { id: 'direct.fetch', input_kinds: ['url'], media_types: ['text/html', 'text/plain'], representations: ['markdown', 'text'], execution_modes: ['sync', 'async'], egress: 'url', stages: [{ id: 'direct-http', role: 'acquire' }], availability: 'ready', issues: [], latency: 'fast', cost: 'free' },
        { id: 'jina.reader', input_kinds: ['url'], media_types: ['text/html'], representations: ['markdown', 'text'], execution_modes: ['sync', 'async'], egress: 'url', stages: [{ id: 'jina-reader', role: 'reader' }], availability: 'unavailable', issues: [{ code: 'LANE_NOT_CONFIGURED' }], latency: 'medium', cost: 'free' },
        { id: 'tavily.extract', input_kinds: ['url'], media_types: ['text/html'], representations: ['markdown', 'text'], execution_modes: [], egress: 'url', stages: [{ id: 'tavily-extract', role: 'extract' }], availability: 'unavailable', issues: [{ code: 'CREDENTIAL_NOT_CONFIGURED' }], latency: 'medium', cost: 'cheap' },
        { id: 'browser.render', input_kinds: ['url'], media_types: ['text/html'], representations: ['markdown', 'text'], execution_modes: ['async'], egress: 'url', stages: [{ id: 'browser.chromium', role: 'acquire' }], availability: 'ready', issues: [], latency: 'slow', cost: 'expensive' },
      ],
      limits: { max_source_bytes: 2_097_152, max_response_bytes: 2_097_152, max_content_chars: 200_000, max_redirects: 5, max_timeout_ms: 60_000, max_inline_bytes: 65_536 },
      // What the server reports for fetch routing: the maintained package plus
      // one user rule, so the Fetch tab opens on a state with something to read
      // rather than on an empty editor.
      routing: {
        enabled: true,
        builtin_enabled: true,
        package: {
          id: 'kiki-common-direct',
          version: '1',
          maintainer: 'Kiki',
          summary: 'Known GitHub raw text and repository JSON endpoints, npm metadata, and PyPI JSON; direct-only.',
        },
        builtin_rules: [
          { id: 'github-raw-text', match: { origin: 'https://raw.githubusercontent.com', path_globs: ['/**/*.md', '/**/LICENSE'] }, action: { pipelines: ['direct.fetch'] } },
          { id: 'github-repository-json', match: { origin: 'https://api.github.com', path_globs: ['/repos/*/*', '/repos/*/*/contents/**'] }, action: { pipelines: ['direct.fetch'] } },
          { id: 'npm-metadata', match: { origin: 'https://registry.npmjs.org', path_globs: ['/*', '/*/*'] }, action: { pipelines: ['direct.fetch'] } },
          { id: 'pypi-json', match: { origin: 'https://pypi.org', path_globs: ['/pypi/*/json'] }, action: { pipelines: ['direct.fetch'] } },
        ],
        disabled_builtin_rules: [],
        rules: [
          {
            id: 'docs-reference',
            match: { origin: 'https://docs.example.test', path_globs: ['/reference/**'] },
            action: { pipelines: ['direct.fetch'] },
          },
          {
            id: 'articles-keep-readers',
            match: { origin: 'https://news.example.test', path_globs: ['/articles/**'] },
            action: { pipelines: ['direct.fetch', 'jina.reader'] },
          },
          {
            id: 'keep-old-chain',
            match: { origin: 'https://raw.githubusercontent.com', path_globs: ['/fixture/special/**'] },
            action: { use: 'default' },
          },
        ],
      },
    },
    jobs: { result_ttl_seconds: 259_200, cancel_supported: true },
  },
  nbSearchTest: {
    revision: 'config-fixture-nbsearch',
    search: { configured: true, available: true, selection: 'exa.search', issues: [] },
    fetch: { configured: true, available: true, selection: 'direct.fetch -> jina.reader', issues: ['LANE_NOT_CONFIGURED'] },
  },
  models: [
    {
      provider: 'fixture',
      model: 'fixture/kiki-pro',
      display_name: 'Kiki Pro',
      max_context_size: 262144,
      support_efforts: ['low', 'medium', 'high'],
      default_effort: 'high',
      capabilities: ['reasoning', 'vision'],
      request_identity: {
        overrides: { request: { logical_id: 'turn' } },
      },
    },
    {
      provider: 'fixture',
      model: 'fixture/kiki-lite',
      display_name: 'Kiki Lite',
      max_context_size: 131072,
      capabilities: ['chat'],
    },
    {
      provider: 'alt',
      model: 'alt/claude-x',
      display_name: 'Alt Claude X',
      max_context_size: 200000,
      capabilities: ['reasoning', 'tools'],
    },
  ],
  providers: [
    {
      id: 'fixture',
      type: 'openai',
      has_api_key: true,
      status: 'connected',
      default_model: 'fixture/kiki-pro',
      request_identity: { preset: 'kimi_code' },
      models: ['fixture/kiki-pro', 'fixture/kiki-lite'],
      // Write-only extras: names only, values never read back.
      custom_header_keys: ['X-Team'],
      env_keys: ['KIMI_BASE_URL'],
    },
    {
      // The OAuth-managed provider: its collapsed summary still carries the
      // request-identity badge, and its editor keeps the non-credential save
      // surface while id/protocol/credentials stay locked.
      id: 'alt',
      type: 'anthropic',
      has_api_key: false,
      status: 'unconfigured',
      default_model: 'alt/claude-x',
      request_identity: { preset: 'none' },
      models: ['alt/claude-x'],
    },
  ],
  auth: {
    ready: true,
    providers_count: 2,
    default_model: 'fixture/kiki-pro',
    managed_provider: { name: 'alt', status: 'authenticated' },
  },
  oauth: {
    flow_id: fid('oauth'),
    provider: 'fixture',
    status: 'pending',
    verification_uri: 'https://fixture.test/verify',
    verification_uri_complete: 'https://fixture.test/verify?code=ABCD-EFGH',
    user_code: 'ABCD-EFGH',
    expires_in: 600,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    interval: 5,
  },
  oauthStart: {
    flow_id: fid('oauth'),
    provider: 'fixture',
    status: 'pending',
    verification_uri: 'https://fixture.test/verify',
    verification_uri_complete: 'https://fixture.test/verify?code=WXYZ-1234',
    user_code: 'WXYZ-1234',
    expires_in: 600,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    interval: 5,
  },
  tools: [
    {
      name: 'Bash',
      description: 'Run shell commands in the workspace.',
      input_schema: { type: 'object' },
      source: 'builtin',
    },
    {
      name: 'Read',
      description: 'Read a file from the workspace.',
      input_schema: { type: 'object' },
      source: 'builtin',
    },
    {
      name: 'FixtureMcpTool',
      description: 'A tool provided by the fixture MCP server.',
      input_schema: { type: 'object' },
      source: 'mcp',
      mcp_server_id: 'mcp_fixture_0001',
    },
  ],
  mcpServers: [
    {
      id: 'mcp_fixture_0001',
      name: 'fixture-mcp',
      transport: 'stdio',
      status: 'connected',
      tool_count: 1,
    },
  ],
  // /api/plugins — the settings Plugins leaf lists this one contributor.
  plugins: [
    {
      id: 'fixture-plugin',
      displayName: 'fixture-plugin',
      version: '2.0.0',
      enabled: true,
      state: 'ok',
      skillCount: 1,
      mcpServerCount: 1,
      enabledMcpServerCount: 1,
      hookCount: 0,
      commandCount: 2,
      hasErrors: false,
      source: 'local-path',
      originalSource: 'C:/fixture/plugins/fixture-plugin',
    },
  ],
  pluginInfos: {
    'fixture-plugin': {
      id: 'fixture-plugin',
      displayName: 'fixture-plugin',
      version: '2.0.0',
      enabled: true,
      state: 'ok',
      skillCount: 1,
      mcpServerCount: 1,
      enabledMcpServerCount: 1,
      hookCount: 0,
      commandCount: 2,
      hasErrors: false,
      source: 'local-path',
      originalSource: 'C:/fixture/plugins/fixture-plugin',
      root: 'C:/fixture/plugins/fixture-plugin',
      installedAt: '2026-01-01T00:00:00.000Z',
      manifest: {
        name: 'fixture-plugin',
        version: '2.0.0',
        description: 'Fixture plugin used by the settings leaf.',
      },
      mcpServers: [
        {
          name: 'fixture-plugin-mcp',
          runtimeName: 'fixture-plugin:fixture-plugin-mcp',
          enabled: true,
          transport: 'http',
          url: 'https://mcp.fixture.example',
        },
      ],
      diagnostics: [],
    },
  },
  pluginMarketplace: [
    {
      id: 'catalog-notes',
      tier: 'curated',
      displayName: 'Catalog Notes',
      description: 'A sample catalog entry from the configured marketplace.',
      version: '1.2.0',
      source: 'https://example.test/catalog-notes.zip',
    },
    {
      id: 'fixture-plugin',
      tier: 'official',
      displayName: 'fixture-plugin',
      description: 'Already installed; the action stays disabled Installed.',
      version: '2.0.0',
      source: 'https://example.test/fixture-plugin.zip',
      installed: { version: '2.0.0', enabled: true },
    },
    {
      id: 'catalog-update',
      tier: 'third-party',
      displayName: 'Catalog Update',
      description: 'Installed with a newer catalog version.',
      version: '3.1.0',
      source: 'https://example.test/catalog-update.zip',
      installed: { version: '3.0.0', enabled: true },
      updateAvailable: true,
    },
  ],
  // /api/mcp/servers — one writable user-level entry and one read-only
  // plugin entry, so the manager's editable/read-only split is exercised.
  mcpManagedServers: [
    {
      name: 'fixture-mcp',
      config: { transport: 'stdio', command: 'node', args: ['fixture-mcp.js'] },
      source: 'global',
      origin: '/home/fixture/mcp.json',
      mutable: true,
    },
    {
      name: 'fixture-plugin-mcp',
      config: { transport: 'http', url: 'https://mcp.fixture.example', headerKeys: ['Authorization'] },
      source: 'plugin',
      origin: 'fixture-plugin',
      mutable: false,
      plugin: { id: 'fixture-plugin', name: 'Fixture Plugin' },
    },
  ],
  workspaceSkills: {
    [WSID]: [
      {
        name: 'review',
        description: 'Review code changes and suggest improvements.',
        path: 'skills/review',
        source: 'workspace',
        type: 'skill',
      },
      {
        name: 'test',
        description: 'Generate tests for the current file.',
        path: 'skills/test',
        source: 'workspace',
        type: 'skill',
      },
    ],
  },
  workspaces: [
    {
      id: WSID,
      root: 'C:/fixture',
      name: 'fixture',
      created_at: ts(120),
      last_opened_at: ts(2),
      session_count: 1,
      pinned: false,
    },
    {
      id: 'wd_fixture_000000000001',
      root: 'C:/fixture/other',
      name: 'other',
      created_at: ts(120),
      last_opened_at: ts(60),
      session_count: 0,
      pinned: true,
    },
    {
      id: 'wd_fixture_000000000002',
      root: 'C:/fixture/third',
      name: 'third',
      created_at: ts(120),
      last_opened_at: ts(90),
      session_count: 0,
      pinned: false,
    },
  ],
  // Expanded rows; GET /agents merges the three `reviewer` rows (same
  // name+source+file across the workspaces) into one with workspace_ids.
  // `main` splits the settings agents section into the main-agent card and
  // the subagent-profiles card; `frontend` carries the read-only projection
  // fields (model_profiles / spawn_constraints / subagents). The two
  // same-name pairs demonstrate the override rules: the user `explore.md`
  // carries `override: true` and shadows the built-in explore, while the
  // user `scout.md` lacks the flag and loses to the built-in scout.
  agentProfiles: [
    {
      name: 'agent',
      source: 'builtin',
      description: 'General-purpose built-in assistant.',
      main: true,
      subagents: ['explore', 'reviewer'],
      routes: [],
    },
    {
      name: 'explore',
      source: 'builtin',
      description: 'Read-only codebase exploration agent.',
      main: false,
      routes: [],
    },
    {
      name: 'explore',
      source: 'user',
      workspace_id: WSID,
      source_file: 'C:/fixture/user/agents/explore.md',
      description: 'Team-tuned read-only explorer replacing the built-in.',
      override: true,
      main: false,
      routes: [],
    },
    {
      name: 'scout',
      source: 'builtin',
      description: 'Fast first-pass triage agent.',
      main: false,
      routes: [],
    },
    {
      name: 'scout',
      source: 'user',
      workspace_id: WSID,
      source_file: 'C:/fixture/user/agents/scout.md',
      description: 'Same-named file profile without the override flag.',
      main: false,
      routes: [],
    },
    {
      name: 'reviewer',
      source: 'workspace',
      workspace_id: WSID,
      source_file: 'C:/fixture/shared/agents/reviewer.md',
      description: 'Review code changes and suggest improvements.',
      main: false,
      routes: [],
    },
    {
      name: 'reviewer',
      source: 'workspace',
      workspace_id: 'wd_fixture_000000000001',
      source_file: 'C:/fixture/shared/agents/reviewer.md',
      description: 'Review code changes and suggest improvements.',
      main: false,
      routes: [],
    },
    {
      name: 'reviewer',
      source: 'workspace',
      workspace_id: 'wd_fixture_000000000002',
      source_file: 'C:/fixture/shared/agents/reviewer.md',
      description: 'Review code changes and suggest improvements.',
      main: false,
      routes: [],
    },
    {
      name: 'frontend',
      source: 'user',
      workspace_id: WSID,
      source_file: 'C:/fixture/user/agents/frontend.md',
      description: 'Owns a UI slice end to end.',
      main: false,
      model_profiles: [
        {
          alias: 'fast',
          when: 'Quick style or copy tweaks',
          thinking_effort: 'low',
          allowed_efforts: ['low', 'medium'],
          prompt_mode: 'append',
        },
      ],
      spawn_constraints: {
        allowed_models: ['fixture/kiki-lite'],
        allowed_efforts: ['low', 'medium'],
      },
      subagents: [
        {
          name: 'explore',
          model_alias: 'fixture/kiki-lite',
          thinking_effort: 'low',
          allowed_models: ['fixture/kiki-lite'],
          disallowed_tools: ['Bash'],
          delegation_notice: 'off',
        },
        // Dedicated (scoped) subagents: private children referenced by source
        // path — one resolved, one unavailable with a diagnostic.
        {
          name: 'writer',
          source: './_private/research/writer.md',
          scope: 'private',
          status: 'ready',
          model_alias: 'fixture/kiki-lite',
        },
        {
          name: 'archivist',
          source: './_private/research/archivist.md',
          scope: 'private',
          status: 'unavailable',
          diagnostic: 'source file missing: ./_private/research/archivist.md',
        },
      ],
      routes: [],
    },
  ],
};
