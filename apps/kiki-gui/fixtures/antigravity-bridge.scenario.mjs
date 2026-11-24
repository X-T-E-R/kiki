/**
 * Scenario: `antigravity-bridge` — showcases the flagship Antigravity 1.5+
 * setup flow (`code_paste` sign-in + update badge), signed-in profile with
 * entitled Gemini / Claude / GPT models & `auto_mode_supported: true`,
 * isolated multi-account instance (`instance-agy-work`), and live 5h & weekly
 * Antigravity quota meters in ProviderQuotaPanel. Mock data only.
 */
import base from './external-main.scenario.mjs';

const future = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();

const executors = [
  { id: 'native', label: 'Kiki', protocol: 'native', status: 'ready', model_binding: 'mapped', thinking_binding: 'mapped' },
  {
    id: 'antigravity-acp',
    label: 'Antigravity',
    protocol: 'acp-v1',
    status: 'ready',
    version: '1.5.11',
    model_binding: 'mapped',
    thinking_binding: 'mapped',
    capabilities: {
      prompt_deliveries: ['append', 'preamble'],
      steer: 'native',
      permission: { via: 'session_mode', trust_engine_settings: false },
      model_binding: 'session_config',
      thinking_binding: true,
      negotiated: {
        agent_version: '1.5.11',
        image: true,
        audio: true,
        pdf: true,
        text_attachment: true,
        native_steering: true,
        permission_modes: ['default', 'auto'],
        models: ['gemini-3.1-pro', 'gemini-3-flash', 'claude-opus-4-6-thinking', 'claude-sonnet-4-6', 'gpt-oss-120b'],
        thinking_levels: ['low', 'medium', 'high'],
        model_thinking_levels: {
          'gemini-3.1-pro': ['low', 'medium', 'high'],
          'gemini-3-flash': ['low', 'medium'],
          'claude-opus-4-6-thinking': ['low', 'medium', 'high'],
          'claude-sonnet-4-6': ['low', 'medium', 'high'],
          'gpt-oss-120b': ['medium'],
        },
      },
    },
    connection: {
      command: 'C:/Users/fixture/.kiki/executors/antigravity/runtime/versions/1.5.11/agy.exe',
      source: 'kiki-managed',
      login_status: 'logged_out',
      default_args: ['acp'],
      home_env: 'GEMINI_HOME',
    },
  },
];

const config = {
  ...base.config,
  agent_executor_display: { discovery_initialized: true, externals_visible: true },
  agent_executor_overrides: {
    'antigravity-acp': { show_in_profile_list: true },
  },
  agent_executor_instances: {
    'instance-agy-work': {
      source_executor: 'antigravity-acp',
      label: 'Antigravity · Work',
      configuration: { kind: 'inherit' },
      proxy: { kind: 'direct' },
    },
  },
};

const providerQuotas = {
  schema_version: '1',
  generated_at: new Date().toISOString(),
  sources: [
    {
      id: 'executor:antigravity-acp',
      label: 'Antigravity',
      kind: 'executor',
      provider_id: 'antigravity-acp',
      account_label: 'alex@example.com',
      enabled: true,
      supported: true,
      status: 'ready',
      refreshing: false,
      refresh_mode: 'explicit',
      checked_at: new Date(Date.now() - 45_000).toISOString(),
      data_as_of: new Date(Date.now() - 45_000).toISOString(),
      auth: { action: 'executor_login', provider: 'antigravity-acp' },
      source: { label: 'Google CloudCode PA', url: 'https://antigravity.google' },
      meters: [
        {
          id: 'gemini-5h',
          label: 'Gemini',
          unit: 'percent',
          unit_label: '%',
          used: 18,
          limit: 100,
          remaining: 82,
          scope: 'account',
          window: { label: '5h', duration_seconds: 18_000, reset_at: future(3.4) },
        },
        {
          id: 'gemini-7d',
          label: 'Gemini',
          unit: 'percent',
          unit_label: '%',
          used: 9,
          limit: 100,
          remaining: 91,
          scope: 'account',
          window: { label: '7d', duration_seconds: 604_800, reset_at: future(126) },
        },
        {
          id: 'argon-5h',
          label: 'Gemini Argon',
          unit: 'percent',
          unit_label: '%',
          used: 36,
          limit: 100,
          remaining: 64,
          scope: 'account',
          window: { label: '5h', duration_seconds: 18_000, reset_at: future(2.8) },
        },
        {
          id: 'claude-gpt-5h',
          label: 'Claude & GPT (shared)',
          unit: 'percent',
          unit_label: '%',
          used: 76,
          limit: 100,
          remaining: 24,
          scope: 'account',
          window: { label: '5h', duration_seconds: 18_000, reset_at: future(1.6) },
        },
        {
          id: 'claude-gpt-7d',
          label: 'Claude & GPT (shared)',
          unit: 'percent',
          unit_label: '%',
          used: 42,
          limit: 100,
          remaining: 58,
          scope: 'account',
          window: { label: '7d', duration_seconds: 604_800, reset_at: future(98) },
        },
      ],
    },
    {
      id: 'executor:antigravity-acp:instance-agy-work',
      label: 'Antigravity · Work',
      kind: 'executor',
      provider_id: 'instance-agy-work',
      account_label: 'work@example.com',
      enabled: true,
      supported: true,
      status: 'auth_required',
      refreshing: false,
      refresh_mode: 'explicit',
      message: 'Start an Antigravity turn to renew sign-in, then refresh limits.',
      auth: { action: 'executor_login', provider: 'instance-agy-work' },
      source: { label: 'Google CloudCode PA', url: 'https://antigravity.google' },
      meters: [],
    },
  ],
};

export default {
  ...base,
  config,
  executors,
  providerQuotas,
  antigravity: {
    release_version: '1.5.11',
    latest_version: '1.5.12',
    layout: 'official-cli',
    versions: ['1.5.11'],
    active_version: '1.5.11',
    signed_in: false,
    install_delay_ms: 400,
    expires_in_secs: 300,
    instances: {
      'instance-agy-work': {
        signed_in: true,
        auth_method: 'oauth-personal',
        account_label: 'work@example.com',
        eligibility: 'ready',
        auto_mode_supported: true,
        models: [
          { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', thinking_levels: ['low', 'medium', 'high'] },
          { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6', thinking_levels: ['low', 'medium', 'high'] },
          { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', thinking_levels: ['low', 'medium', 'high'] },
          { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', thinking_levels: ['medium'] },
        ],
      },
    },
  },
};
