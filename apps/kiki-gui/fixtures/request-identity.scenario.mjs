/**
 * request-identity — Settings › Request identity. The five built-in
 * identities plus one custom copy of Codex that a model uses; the Codex track
 * was updated from npm once (so it can roll back), Claude Code has a staged
 * candidate waiting for Apply, and Grok is pinned after a failed CLI read.
 * Two recent requests show what was actually sent.
 */

const WSID = 'wd_fixture_000000000000';
const SEEDED = '2026-09-30T00:00:00.000Z';
const HOUR = 3_600_000;
const ago = (ms) => new Date(Date.parse('2026-09-30T14:00:00.000Z') - ms).toISOString();

const STAINLESS = [
  { name: 'x-app', value: 'cli' },
  { name: 'anthropic-dangerous-direct-browser-access', value: 'true' },
  { name: 'X-Stainless-Lang', value: 'js' },
  { name: 'X-Stainless-Package-Version', value: '0.94.0' },
  { name: 'X-Stainless-OS', value: '{stainless_os}' },
  { name: 'X-Stainless-Arch', value: '{stainless_arch}' },
  { name: 'X-Stainless-Runtime', value: 'node' },
  { name: 'X-Stainless-Runtime-Version', value: 'v26.3.0' },
  { name: 'X-Stainless-Retry-Count', value: '0' },
  { name: 'X-Stainless-Timeout', value: '600' },
];

const builtin = (id, label, base_preset, track, user_agent, headers) => ({
  id, builtin: true, label, base_preset, track, version: track === null ? { mode: 'kiki' } : { mode: 'track' }, user_agent, headers, params: [],
});

const profiles = [
  builtin('kimi_code', 'Kimi Code', 'kimi_code', null, '', []),
  builtin('codex', 'Codex CLI', 'codex_compatible', 'codex_cli', 'codex_cli_rs/{version} ({os_type} {os_version}; {arch})',
    [{ name: 'originator', value: 'codex_cli_rs' }, { name: 'version', value: '{version}' }]),
  builtin('claude_code', 'Claude Code', 'claude_code_compatible', 'claude_code', 'claude-cli/{version} (external, cli)', STAINLESS),
  builtin('grok_build', 'Grok Build', 'grok_build_compatible', 'grok_cli', 'grok-shell/{version} ({grok_os}; {grok_arch})',
    [{ name: 'x-grok-client-identifier', value: 'grok-shell' }, { name: 'x-grok-client-version', value: '{version}' }]),
  builtin('none', 'None', 'none', null, '', []),
  {
    id: 'custom:codex-1', builtin: false, label: 'Codex TUI（Windows Terminal）', base_preset: 'codex_compatible',
    track: 'codex_cli', version: { mode: 'track' },
    user_agent: 'codex-tui/{version} ({os_type} {os_version}; {arch}) WindowsTerminal',
    headers: [{ name: 'originator', value: 'codex-tui' }, { name: 'version', value: '{version}' }, { name: 'x-openai-internal-codex-residency', value: 'us' }],
    params: [{ name: 'service_tier', value: 'priority' }],
    duplicated_from: 'codex', created_at: ago(26 * HOUR), updated_at: ago(3 * HOUR),
  },
];

const revision = (version, origin, source_detail, at) => ({ version, origin, source_detail, at });

const tracks = [
  {
    id: 'codex_cli', npm_package: '@openai/codex', cli_command: 'codex',
    current: revision('0.159.2', 'npm', '@openai/codex', ago(5 * HOUR)),
    builtin: revision('0.158.0', 'builtin', '@openai/codex', SEEDED),
    candidate: null,
    history: [revision('0.158.0', 'builtin', '@openai/codex', SEEDED)],
    pinned: false,
    last_check: { source: 'npm', at: ago(5 * HOUR), ok: true, version: '0.159.2' },
  },
  {
    id: 'claude_code', npm_package: '@anthropic-ai/claude-code', cli_command: 'claude',
    current: revision('2.1.285', 'builtin', '@anthropic-ai/claude-code', SEEDED),
    builtin: revision('2.1.285', 'builtin', '@anthropic-ai/claude-code', SEEDED),
    candidate: revision('2.1.290', 'local_cli', 'claude --version', ago(12 * 60_000)),
    history: [], pinned: false,
    last_check: { source: 'local_cli', at: ago(12 * 60_000), ok: true, version: '2.1.290' },
  },
  {
    id: 'grok_cli', npm_package: '@xai-official/grok', cli_command: 'grok',
    current: revision('1.0.44', 'builtin', '@xai-official/grok', SEEDED),
    builtin: revision('1.0.44', 'builtin', '@xai-official/grok', SEEDED),
    candidate: null, history: [], pinned: true,
    last_check: { source: 'local_cli', at: ago(2 * HOUR), ok: false, error: 'grok is not installed or did not answer --version' },
  },
];

const usage = [
  { scope: 'global', label: 'global', effective_profile: 'kimi_code', effective_preset: 'kimi_code' },
  { scope: 'provider', provider_id: 'managed:openai-codex', label: 'managed:openai-codex', authored: { profile: 'codex' }, effective_profile: 'codex', effective_preset: 'codex_compatible' },
  { scope: 'model', provider_id: 'managed:openai-codex', model_id: 'managed:openai-codex/gpt-5-codex', label: 'GPT-5 Codex', authored: { profile: 'custom:codex-1' }, effective_profile: 'custom:codex-1', effective_preset: 'codex_compatible' },
  { scope: 'provider', provider_id: 'anthropic', label: 'anthropic', authored: { preset: 'claude_code_compatible' }, effective_profile: 'claude_code', effective_preset: 'claude_code_compatible' },
  { scope: 'model', provider_id: 'anthropic', model_id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5', effective_profile: 'claude_code', effective_preset: 'claude_code_compatible' },
  { scope: 'provider', provider_id: 'deepseek', label: 'deepseek', effective_profile: 'kimi_code', effective_preset: 'kimi_code' },
  { scope: 'model', provider_id: 'deepseek', model_id: 'deepseek/deepseek-chat', label: 'DeepSeek V3.2', authored: { preset: 'codex_compatible' }, effective_profile: null, effective_preset: null,
    error: 'Codex-compatible request identity only supports OpenAI Responses' },
];

const SESSION = '0199a3c2-5f0e-7c11-9d2a-3be0f4c1a7e2';
const observations = [
  {
    at: ago(4 * 60_000), provider_id: 'managed:openai-codex', model: 'gpt-5-codex', protocol: 'openai_responses',
    profile: 'custom:codex-1', preset: 'codex_compatible', session_id: 'session_fixture_basic', agent_id: 'main',
    headers: [
      { name: 'User-Agent', value: 'codex-tui/0.159.2 (Windows 10.0.26100; x86_64) WindowsTerminal' },
      { name: 'originator', value: 'codex-tui' },
      { name: 'version', value: '0.159.2' },
      { name: 'x-openai-internal-codex-residency', value: 'us' },
      { name: 'session-id', value: SESSION },
      { name: 'thread-id', value: SESSION },
      { name: 'x-codex-window-id', value: `${SESSION}:3` },
      { name: 'x-client-request-id', value: '0199a3c9-11b4-7e02-8c55-6f1d2e9a0b37' },
    ],
    params: { service_tier: 'priority' }, cache_key: SESSION, suppressed_user_agent: false,
  },
  {
    at: ago(41 * 60_000), provider_id: 'anthropic', model: 'claude-sonnet-4.5', protocol: 'anthropic',
    profile: 'claude_code', preset: 'claude_code_compatible', session_id: 'session_fixture_basic', agent_id: 'main',
    headers: [
      { name: 'User-Agent', value: 'claude-cli/2.1.285 (external, cli)' },
      { name: 'x-app', value: 'cli' },
      { name: 'X-Stainless-Package-Version', value: '0.94.0' },
      { name: 'X-Claude-Code-Session-Id', value: SESSION },
    ],
    params: {}, cache_key: `{"device_id":"8f14e45fceea167a5a36dedd4bea2543","account_uuid":"","session_id":"${SESSION}"}`, suppressed_user_agent: false,
  },
];

const lineage = {
  codex_compatible: {
    unsupported: ['anthropic', 'openai'],
    error: 'Codex-compatible request identity only supports OpenAI Responses',
    headers: [
      { name: 'session-id', value: '00000000-0000-4000-8000-000000000002' },
      { name: 'thread-id', value: '00000000-0000-4000-8000-000000000003' },
      { name: 'x-codex-window-id', value: '00000000-0000-4000-8000-000000000003:1' },
      { name: 'x-client-request-id', value: '00000000-0000-7000-8000-000000000005' },
    ],
    params: { openai_responses: { prompt_cache_key: '00000000-0000-4000-8000-000000000002' } },
  },
  claude_code_compatible: {
    unsupported: ['openai_responses', 'openai'],
    error: 'Claude Code-compatible request identity only supports Anthropic Messages',
    headers: [{ name: 'X-Claude-Code-Session-Id', value: '00000000-0000-4000-8000-000000000002' }],
    params: { anthropic: { 'metadata.user_id': '{"device_id":"5d41402abc4b2a76b9719d911017c592","account_uuid":"","session_id":"00000000-0000-4000-8000-000000000002"}' } },
  },
  grok_build_compatible: {
    unsupported: ['openai'],
    error: 'Grok Build-compatible request identity requires Responses or Messages',
    headers: [
      { name: 'x-grok-conv-id', value: '00000000-0000-4000-8000-000000000002' },
      { name: 'x-grok-req-id', value: '00000000-0000-7000-8000-000000000005' },
      { name: 'x-grok-model-override', value: 'example-model' },
    ],
  },
  kimi_code: {
    headers: [
      { name: 'User-Agent', value: 'KimiCLI/0.9.0', kind: 'static' },
      { name: 'X-Msh-Platform', value: 'kimi_cli', kind: 'static' },
      { name: 'X-Msh-Device-Id', value: '00000000-0000-4000-8000-000000000001' },
    ],
  },
};

export default {
  config: {
    default_provider: 'managed:openai-codex',
    default_model: 'managed:openai-codex/gpt-5-codex',
    default_permission_mode: 'manual',
    providers: {
      'managed:openai-codex': { type: 'openai_responses', has_api_key: false, request_identity: { profile: 'codex' } },
      anthropic: { type: 'anthropic', base_url: 'https://api.anthropic.com', has_api_key: true, request_identity: { preset: 'claude_code_compatible' } },
      deepseek: { type: 'openai', base_url: 'https://api.deepseek.com/v1', has_api_key: true },
    },
  },
  models: [
    { provider: 'managed:openai-codex', model: 'managed:openai-codex/gpt-5-codex', display_name: 'GPT-5 Codex', max_context_size: 400_000, capabilities: ['thinking', 'tool_use'], support_efforts: ['low', 'medium', 'high'] },
    { provider: 'anthropic', model: 'anthropic/claude-sonnet-4.5', display_name: 'Claude Sonnet 4.5', max_context_size: 200_000, capabilities: ['thinking', 'tool_use'] },
    { provider: 'deepseek', model: 'deepseek/deepseek-chat', display_name: 'DeepSeek V3.2', max_context_size: 128_000, capabilities: ['tool_use'] },
  ],
  requestIdentity: {
    catalog: { profiles, tracks, manifest_url: null, usage, observations },
    lineage,
    checks: {
      codex_cli: { npm: { version: '0.160.0', origin: 'npm', source_detail: '@openai/codex' } },
      claude_code: { npm: { version: '2.1.290', origin: 'npm', source_detail: '@anthropic-ai/claude-code' } },
      grok_cli: { npm: { version: '1.0.44', origin: 'npm', source_detail: '@xai-official/grok' } },
    },
  },
  auth: { ready: true, providers_count: 3, default_model: 'managed:openai-codex/gpt-5-codex', managed_provider: null },
  workspaces: [
    { id: WSID, root: 'C:/fixture/workshop', name: 'workshop', created_at: ago(7_200_000), last_opened_at: ago(0), session_count: 0, pinned: false },
  ],
  sessions: [],
  snapshots: {},
};
