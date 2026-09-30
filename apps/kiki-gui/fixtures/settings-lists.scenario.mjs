/**
 * settings-lists — one server holding every settings list at the size the
 * shared list pattern is built for: a dozen connections, forty models, a
 * wall of permission rules, ten notify channels, eighty skills, a full
 * installed-plugins shelf, a dozen MCP servers, thirty agent profiles, a
 * handful of spaces, request identities and priced models. The
 * visual-proof-settings-lists walker shoots every migrated page against it,
 * so before/after pairs share the exact same data.
 */

import { fid, sessionRecord, ts } from './helpers.mjs';
import identity from './request-identity.scenario.mjs';
import { usageV2 } from './usage-dashboard.scenario.mjs';

const SID = 'session_fixture_settings_lists';
const WSID = 'wd_fixture_000000000000';
const HOUR = 3_600_000;

// ---- workspaces (the page is the pattern's reference; kept small here) ----
const workspaces = [
  { id: WSID, root: 'C:/fixture/workshop', name: 'workshop', created_at: ts(90_000), last_opened_at: ts(2), session_count: 3, pinned: true },
  ...Array.from({ length: 12 }, (_, i) => ({
    id: fid(`ws_${i}`),
    root: `C:/fixture/project-${i}`,
    name: `project-${i}`,
    created_at: ts(80_000 + i * 900),
    last_opened_at: ts(30 + i * 1400),
    session_count: i % 4,
    pinned: false,
  })),
];

// ---- connections (providers) and their models ----
const PROVIDERS = [
  ['managed:kimi-code', 'kimi', 'https://api.kimi.example.test/coding/v1', 'connected'],
  ['managed:github-copilot', 'openai', 'https://api.githubcopilot.com', 'connected'],
  ['managed:openai-codex', 'openai_responses', 'https://chatgpt.example.test/backend-api/codex', 'connected'],
  ['deepseek', 'openai', 'https://api.deepseek.com/v1', 'error'],
  ['anthropic', 'anthropic', 'https://api.anthropic.com', 'connected'],
  ['openrouter', 'openai', 'https://openrouter.ai/api/v1', 'connected'],
  ['groq', 'openai', 'https://api.groq.com/openai/v1', 'unconfigured'],
  ['mistral', 'openai', 'https://api.mistral.ai/v1', 'connected'],
  ['together', 'openai', 'https://api.together.xyz/v1', 'error'],
  ['ollama', 'openai', 'http://localhost:11434/v1', 'connected'],
  ['lmstudio', 'openai', 'http://localhost:1234/v1', 'error'],
  ['vllm-office', 'openai', 'http://10.0.0.8:8000/v1', 'connected'],
];
const MODEL_WORDS = ['alpha', 'beta', 'gamma', 'delta', 'kappa', 'sigma', 'omega', 'tau', 'nova', 'flux'];
const models = [];
for (const [pid] of PROVIDERS) {
  const count = pid === 'managed:kimi-code' ? 4 : pid === 'ollama' ? 6 : 3;
  for (let i = 0; i < count; i += 1) {
    const word = MODEL_WORDS[(models.length + i) % MODEL_WORDS.length];
    const id = `${pid}/${word}-${(i + 1) * 7}${pid.startsWith('managed:') ? '' : '-chat'}`;
    models.push({
      provider: pid,
      model: id,
      display_name: `${word[0].toUpperCase()}${word.slice(1)} ${(i + 1) * 7}`,
      max_context_size: [32_768, 128_000, 262_144, 400_000][i % 4],
      capabilities: i % 3 === 0 ? ['thinking', 'tool_use'] : i % 3 === 1 ? ['tool_use', 'image_in'] : ['tool_use'],
      support_efforts: i % 3 === 0 ? ['low', 'medium', 'high'] : [],
    });
  }
}
const providers = PROVIDERS.map(([id, type, baseUrl, status], i) => ({
  id,
  type,
  base_url: baseUrl,
  has_api_key: status !== 'unconfigured' && !id.startsWith('managed:'),
  status,
  models: models.filter((model) => model.provider === id).map((model) => model.model),
  ...(id === 'managed:kimi-code' ? { default_model: 'managed:kimi-code/alpha-7' } : {}),
  ...(i % 5 === 4 ? { custom_header_keys: ['x-team'] } : {}),
}));

// ---- permission rules: a long ordered wall ----
const RULE_TOOLS = ['Bash', 'Edit', 'Write', 'Read', 'WebFetch', 'Task', 'Glob', 'Grep'];
const permissionRules = Array.from({ length: 22 }, (_, i) => ({
  decision: i % 5 === 0 ? 'deny' : i % 3 === 0 ? 'ask' : 'allow',
  pattern: `${RULE_TOOLS[i % RULE_TOOLS.length]}(${i % 2 === 0 ? 'fixtures' : 'src'}/**/${i}${i % 2 === 0 ? ':*)' : ''}`,
  scope: ['user', 'project', 'session-runtime', 'turn-override'][i % 4],
  reason: i % 4 === 0 ? `rule ${i} from the team handbook` : undefined,
}));

// ---- notification channels: ten across three provider instances ----
const slot = (provider, instance, purpose) => ({ provider_id: provider, provider_instance_id: instance, purpose, env: `KIKI_NOTIFY_${instance.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${purpose.toUpperCase()}` });
const notifications = {
  settings: {
    global: { enabled: true, suppress_viewing_session: true, min_work_ms: 60_000, work_stable_ms: 3_000, question_delay_ms: 10_000 },
    provider_instances: {
      'telegram-1': { provider_id: 'telegram', enabled: true, revision: 'r1', options: { token_slot: 'telegram-1.telegram_bot' }, label: 'Kiki bot', health: 'ok' },
      'telegram-2': { provider_id: 'telegram', enabled: true, revision: 'r1', options: { token_slot: 'telegram-2.telegram_bot' }, label: 'Ops bot', health: 'ok' },
      'wecom-1': { provider_id: 'wecom_webhook', enabled: true, revision: 'r1', options: { key_slot: 'wecom-1.wecom_key' }, health: 'unauthorized' },
    },
    channels: Object.fromEntries(Array.from({ length: 10 }, (_, i) => {
      const instance = i < 5 ? 'telegram-1' : i < 8 ? 'telegram-2' : 'wecom-1';
      const broken = i === 3 || i === 9;
      return [`channel-${i}`, {
        provider_instance_id: instance,
        enabled: i !== 7,
        revision: 'r1',
        target: instance === 'wecom-1' ? {} : { chat_id: `${123456789 + i}` },
        directions: ['send'],
        scenes: { work_complete: i % 2 === 0, question_pending: true },
        label: `${['发布群', '值班群', '客户群', '研發群', '个人'][i % 5]} ${i}`,
        health: broken ? 'connection_failed' : 'ok',
      }];
    })),
    credential_slots: {
      'telegram-1.telegram_bot': slot('telegram', 'telegram-1', 'telegram_bot'),
      'telegram-2.telegram_bot': slot('telegram', 'telegram-2', 'telegram_bot'),
      'wecom-1.wecom_key': slot('wecom_webhook', 'wecom-1', 'wecom_key'),
    },
  },
  credentials: {
    'telegram-1.telegram_bot': '7012345678:AAFixtureTokenForScreenshotsOnly00',
    'telegram-2.telegram_bot': '7012345679:AAFixtureTokenForScreenshotsOnly01',
    'wecom-1.wecom_key': 'fixture-wecom-key-0000',
  },
  deliveries: [],
  tests: {},
};

// ---- skills: eighty across the five sources (capabilities-many shape) ----
const SKILL_SOURCES = [
  ['plugin', 14, (name) => `C:/Users/fixture/.kiki/plugins/managed/research/skills/${name}/SKILL.md`],
  ['project', 28, (name) => `C:/fixture/workshop/.kimi/skills/${name}/SKILL.md`],
  ['user', 18, (name) => `C:/Users/fixture/.kimi/skills/${name}/SKILL.md`],
  ['extra', 10, (name) => `C:/fixture/shared/${name}/SKILL.md`],
  ['builtin', 10, (name) => `builtin:${name}`],
];
const VERBS = ['draft', 'review', 'summarize', 'audit', 'refactor', 'explain', 'plan', 'triage', 'document', 'benchmark'];
const NOUNS = ['release-notes', 'pull-requests', 'incident-reports', 'api-changes', 'test-failures', 'onboarding-docs', 'sql-queries', 'design-specs'];
const skills = [];
{
  let index = 0;
  for (const [source, count, pathOf] of SKILL_SOURCES) {
    for (let offset = 0; offset < count; offset += 1) {
      const name = `${VERBS[index % VERBS.length]}-${NOUNS[Math.floor(index / VERBS.length) % NOUNS.length]}`;
      skills.push({
        name,
        description: `${name} with the team's conventions, and flag anything that needs a human decision before it ships.`,
        path: pathOf(name),
        source,
        prompt_command: index % 7 === 0 ? true : undefined,
        argument_hint: index % 14 === 0 ? '[path]' : undefined,
        disable_model_invocation: index % 11 === 5 ? true : undefined,
      });
      index += 1;
    }
  }
}

// ---- installed plugins ----
const plugins = Array.from({ length: 14 }, (_, i) => ({
  id: `plugin-${['calendar', 'ledger', 'radar', 'atlas', 'forge', 'harbor', 'beacon', 'cipher'][i % 8]}-${i}`,
  displayName: `${['Calendar', 'Ledger', 'Radar', 'Atlas', 'Forge', 'Harbor', 'Beacon', 'Cipher'][i % 8]} ${i}`,
  enabled: i % 4 !== 3,
  state: i === 2 || i === 11 ? 'error' : 'ok',
  hasErrors: i === 2 || i === 11,
  version: `0.${i + 1}.0`,
  skillCount: i % 3,
  mcpServerCount: 0,
  enabledMcpServerCount: 0,
  hookCount: 0,
  commandCount: i % 2,
  source: i % 5 === 0 ? 'github' : i % 3 === 0 ? 'local-path' : 'zip-url',
  originalSource: i % 5 === 0 ? `https://github.com/example/plugin-${i}` : i % 3 === 0 ? `C:/fixture/plugins/p${i}` : `https://example.test/plugins/p${i}.zip`,
}));

// ---- MCP servers: twelve configured, most with a live runtime row ----
const MCP_NAMES = ['fetch', 'filesystem', 'github', 'gitlab', 'postgres', 'redis', 'slack', 'jira', 'sentry', 'docker', 'kubernetes', 'playwright'];
const mcpManagedServers = MCP_NAMES.map((name, i) => ({
  name,
  ...(i === 0
    ? { source: 'plugin', origin: 'plugin-radar-0', mutable: false, plugin: { id: 'plugin-radar-0', name: 'Radar 0' } }
    : { source: 'global', origin: 'C:/Users/fixture/.kiki/mcp.json', mutable: true }),
  config: i % 3 === 2
    ? { transport: 'http', url: `https://mcp.example.test/${name}`, headerKeys: i % 4 === 2 ? ['x-api-key'] : undefined }
    : { transport: 'stdio', command: 'npx', args: ['-y', `@fixture/mcp-${name}`], envKeys: i % 4 === 1 ? ['API_KEY'] : undefined },
}));
const mcpServers = MCP_NAMES.map((name, i) => ({
  id: i === 0 ? 'plugin__plugin-radar-0__fetch' : name,
  name,
  transport: i % 3 === 2 ? 'http' : 'stdio',
  status: i === 4 || i === 9 ? 'error' : i === 7 ? 'disconnected' : 'connected',
  tool_count: (i * 3) % 9,
  last_error: i === 4 || i === 9 ? `spawn npx ENOENT: @fixture/mcp-${name} not found` : undefined,
}));

// ---- agent profiles: thirty across builtin / user / workspace / extra ----
const PROFILE_NAMES = ['reviewer', 'planner', 'runner', 'scribe', 'scout', 'mentor', 'auditor', 'builder', 'tester', 'docwriter'];
const agentProfiles = [
  { name: 'agent', source: 'builtin', description: 'General-purpose built-in agent.', main: true, routes: [] },
  ...Array.from({ length: 30 }, (_, i) => {
    const source = i % 6 === 0 ? 'builtin' : i % 3 === 0 ? 'workspace' : i % 3 === 1 ? 'user' : 'extra';
    return {
      name: `${PROFILE_NAMES[i % PROFILE_NAMES.length]}-${Math.floor(i / PROFILE_NAMES.length)}${i % 2 === 0 ? '' : '-x'}`,
      source,
      description: `${PROFILE_NAMES[i % PROFILE_NAMES.length]} profile for the fixture fleet ${i}`,
      main: false,
      routes: [],
      ...(source === 'workspace' ? { workspace_id: WSID } : {}),
      ...(source !== 'builtin' ? { source_file: `C:/fixture/profiles/p${i}.md` } : {}),
      disabled: i % 9 === 8,
      pinned_model_alias: i % 4 === 0 ? 'deepseek/alpha-7-chat' : undefined,
      thinking_effort: i % 4 === 0 ? 'high' : undefined,
      subagents: i % 5 === 0 ? [] : undefined,
    };
  }),
];
const shippedAgentProfiles = PROFILE_NAMES.slice(0, 4).map((name, i) => ({
  template_id: `kiki/${name}`,
  managed: i < 2,
  status: i === 3 ? 'removed' : 'materialized',
  main: false,
  description: `Shipped ${name} template`,
}));

// ---- spaces: main plus seven ----
const spaces = {
  mainPath: 'C:/Users/fixture/.kiki',
  items: Array.from({ length: 7 }, (_, i) => ({
    id: fid(`space_${i}`),
    name: ['acme-confidential', 'thesis-writing', 'client-paper', 'side-quest', 'infra-lab', 'design-ops', 'archive'][i],
    color: ['#0f766e', '#7e22ce', '#b45309', '#0369a1', '#be123c', '#4d7c0f', '#6d28d9'][i],
    path: `D:/spaces/space-${i}`,
    credentials: i % 3 === 0 ? 'isolated' : 'shared',
    live: i === 1,
  })),
  active: 'main',
};

// ---- prices: most catalog-priced, a few overridden, a few unknown ----
const catalogPrices = Object.fromEntries(models.filter((_, i) => i % 3 !== 2).map((model, i) => [
  model.model.replace(/^managed:/, ''),
  {
    input_cost_per_token: (2 + (i % 9)) / 1e6,
    output_cost_per_token: (8 + (i % 9) * 2) / 1e6,
    ...(i % 4 === 0 ? { cache_read_input_token_cost: 0.4 / 1e6, cache_creation_input_token_cost: 1.2 / 1e6 } : {}),
  },
]));
const priceOverrides = {
  'deepseek/alpha-7-chat': { input_cost_per_token: 0.5 / 1e6, output_cost_per_token: 1.5 / 1e6, currency: 'CNY' },
  'ollama/beta-14-chat': { input_cost_per_token: 0, output_cost_per_token: 0, currency: 'USD' },
};

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: settings lists' })],
  snapshots: { [SID]: { messages: [], has_more: false } },
  workspaces,
  models,
  providers,
  notifications,
  oauthMethods: [
    { id: 'kimi-code', label: 'Kimi Code', provider: 'managed:kimi-code', protocol: 'openai', signed_in: true, account: { state: 'known', id: 'dev@example.test' } },
    { id: 'github-copilot', label: 'GitHub Copilot', provider: 'managed:github-copilot', protocol: 'openai', signed_in: true, account: { state: 'known', id: 'octo-dev' } },
    { id: 'openai-codex', label: 'OpenAI Codex', provider: 'managed:openai-codex', protocol: 'openai', signed_in: false },
  ],
  config: {
    default_provider: 'managed:kimi-code',
    default_model: 'managed:kimi-code/alpha-7',
    default_permission_mode: 'manual',
    default_plan_mode: false,
    providers: Object.fromEntries(PROVIDERS.map(([id, type, baseUrl, status]) => [id, {
      type,
      base_url: id.startsWith('managed:') ? undefined : baseUrl,
      has_api_key: status !== 'unconfigured' && !id.startsWith('managed:'),
    }])),
    permission: { rules: permissionRules },
    hooks: [],
    merge_all_available_skills: true,
    extra_skill_dirs: ['C:/fixture/shared'],
    nb_search: {
      credential_slots: { 'exa.default': { provider_id: 'exa', env: 'NB_SEARCH_EXA_API_KEY' } },
      provider_instances: Object.fromEntries(['exa', 'tavily', 'searxng', 'jina', 'brave', 'exa2', 'tavily2', 'searxng2'].map((pid, i) => [
        i < 4 ? `${pid}.default` : `${pid}.team`,
        {
          provider_id: pid.replace(/2$/, ''),
          enabled: i % 4 !== 3,
          credential_slot_id: i < 4 ? `${pid}.default` : undefined,
          options: {},
        },
      ])),
      defaults: { search_lane: 'exa.search' },
      execution: { max_concurrency: 4, search_timeout_ms: 30_000 },
    },
  },
  nbSearchCapabilities: {
    schema_version: '3.0',
    revision: 'config-fixture-lists',
    providers: {
      descriptors: ['exa', 'tavily', 'searxng', 'jina', 'brave'].map((pid) => ({
        provider_id: pid,
        adapter_version: '1',
        query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }],
        fetch_operations: [],
        activation: pid === 'searxng' ? { credential: 'none', endpoint: 'required' } : { credential: 'required', endpoint: 'optional' },
        option_keys: [],
      })),
      instances: ['exa', 'tavily', 'searxng', 'jina', 'brave', 'exa2', 'tavily2', 'searxng2'].map((pid, i) => {
        const provider = pid.replace(/2$/, '');
        const attention = i === 1 || i === 6;
        return {
          id: i < 4 ? `${pid}.default` : `${pid}.team`,
          provider_id: provider,
          enabled: i % 4 !== 3,
          availability: attention ? 'unavailable' : 'ready',
          issues: attention ? [{ code: 'CREDENTIAL_NOT_CONFIGURED' }] : [],
          credential: { requirement: provider === 'searxng' ? 'none' : 'required', configured: !attention && provider !== 'searxng', slot_id: i < 4 ? `${pid}.default` : undefined },
          endpoint: { requirement: provider === 'searxng' ? 'required' : 'optional', configured: false },
        };
      }),
    },
    search: { default_lane: 'exa.search', lanes: [], presets: [], limits: { max_queries: 64, max_results: 100, max_timeout_ms: 3_600_000, max_inline_bytes: 65_536 } },
    fetch: { default_representation: 'markdown', inputs: [], chains: [], pipelines: [], limits: { max_source_bytes: 2_097_152, max_response_bytes: 2_097_152, max_content_chars: 200_000, max_redirects: 5, max_timeout_ms: 60_000, max_inline_bytes: 65_536 } },
    jobs: { result_ttl_seconds: 259_200, cancel_supported: true },
  },
  nbSearchManagedCredentials: { 'exa.default': 'fixture-exa-key' },
  skills,
  sessionSkills: { [SID]: [] },
  workspaceSkills: { [WSID]: skills },
  plugins,
  pluginInfos: {},
  mcpManagedServers,
  mcpServers,
  agentProfiles,
  shippedAgentProfiles,
  spaces,
  requestIdentity: identity.requestIdentity,
  catalogPrices,
  priceOverrides,
  usageV2,
  auth: { ready: true, providers_count: 3, default_model: 'managed:kimi-code/alpha-7', managed_provider: null },
};
