/**
 * settings — demo data for the settings panels and responsive screenshots.
 *
 * No session-side event script is needed; the proof runner navigates to
 * /settings and reads the catalog endpoints served here.
 */

import { fid, sessionRecord, ts } from './helpers.mjs';

const SID = 'session_fixture_settings';
const WSID = 'wd_fixture_000000000000';

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
    merge_all_available_skills: true,
    extra_skill_dirs: ['C:/fixture/skills'],
    experimental: { search_worker: true },
    // nb_search: partial setup — exa has a credential slot and the default
    // lane, tavily is declared but its credential env var is missing, so the
    // Search & retrieval leaf renders ready and attention states together.
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
        'tavily.default': { provider_id: 'tavily', enabled: false, options: {} },
      },
      defaults: { search_lane: 'exa.search' },
      execution: { max_concurrency: 4, search_timeout_ms: 30000 },
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
  // /api/v1/nb-search/* — secret-free capabilities + on-demand readiness for
  // the Search & retrieval settings leaf. Matches the partial nb_search seed
  // above: WebSearch ready on exa.search, FetchURL degraded (jina.reader has
  // no credential), tavily/searxng attention states for the provider cards.
  nbSearchCapabilities: {
    schema_version: '3.0',
    revision: 'config-fixture-nbsearch',
    providers: {
      descriptors: [
        { provider_id: 'exa', adapter_version: '1', query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'required', endpoint: 'optional' }, option_keys: ['user_location'] },
        { provider_id: 'tavily', adapter_version: '1', query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'required', endpoint: 'optional' }, option_keys: [] },
        { provider_id: 'searxng', adapter_version: '1', query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'none', endpoint: 'required' }, option_keys: [] },
        { provider_id: 'direct-http', adapter_version: '1', query_operations: [], fetch_operations: [], activation: { credential: 'none', endpoint: 'none' }, option_keys: [] },
        { provider_id: 'jina-reader', adapter_version: '1', query_operations: [], fetch_operations: [], activation: { credential: 'none', endpoint: 'optional' }, option_keys: [] },
      ],
      instances: [
        { id: 'exa.default', provider_id: 'exa', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'required', configured: true, slot_id: 'exa.default' }, endpoint: { requirement: 'optional', configured: false } },
        { id: 'tavily.default', provider_id: 'tavily', enabled: false, availability: 'unavailable', issues: [{ code: 'CREDENTIAL_NOT_CONFIGURED' }, { code: 'PROVIDER_DISABLED' }], credential: { requirement: 'required', configured: false, slot_id: 'tavily.default' }, endpoint: { requirement: 'optional', configured: false } },
        { id: 'searxng.default', provider_id: 'searxng', enabled: true, availability: 'unavailable', issues: [{ code: 'ENDPOINT_NOT_CONFIGURED' }], credential: { requirement: 'none', configured: false }, endpoint: { requirement: 'required', configured: false } },
        { id: 'direct-http.default', provider_id: 'direct-http', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'none', configured: false }, endpoint: { requirement: 'none', configured: false } },
        { id: 'jina-reader.default', provider_id: 'jina-reader', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'none', configured: false, slot_id: 'jina-reader.default' }, endpoint: { requirement: 'optional', configured: false } },
      ],
    },
    search: {
      default_lane: 'exa.search',
      lanes: [
        { id: 'exa.search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: ['sync', 'async'], availability: 'ready', issues: [], latency: 'fast', cost: 'cheap' },
        { id: 'tavily.search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: [], availability: 'unavailable', issues: [{ code: 'CREDENTIAL_NOT_CONFIGURED' }, { code: 'PROVIDER_DISABLED' }], latency: 'fast', cost: 'cheap' },
        { id: 'searxng.search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: [], availability: 'unavailable', issues: [{ code: 'ENDPOINT_NOT_CONFIGURED' }], latency: 'medium', cost: 'free' },
        { id: 'github.repositories', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: ['sync', 'async'], availability: 'ready', issues: [{ code: 'RATE_LIMIT_UNAUTHENTICATED' }], latency: 'fast', cost: 'free' },
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
  // /api/v1/plugins — the settings Plugins leaf lists this one contributor.
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
  // /api/v2/mcp/servers — one writable user-level entry and one read-only
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
