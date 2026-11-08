import base from './external-engines.scenario.mjs';

const AGY_ACCOUNT_SOURCE = 'plugin:fixture-accounts/accounts';
const executors = base.executors.map(item => ({ ...item, connection: {
  ...item.connection,
  home_env: item.id === 'codex-app-server' ? 'CODEX_HOME' : item.connection?.home_env,
} }));
executors.push({
  id: 'agy-cli', label: 'AGY CLI', protocol: 'acp-v1', status: 'ready',
  model_binding: 'mapped', thinking_binding: 'mapped',
  connection: { command: 'C:/fixture/agy/agy-cli-acp.mjs', login_status: 'unknown', default_args: [] },
});

const nowIso = new Date().toISOString();
const plusHoursIso = (hours) => new Date(Date.now() + hours * 3600_000).toISOString();

export default {
  ...base,
  config: {
    ...base.config,
    agent_executor_display: { discovery_initialized: true },
    agent_executor_overrides: {
      ...(base.config.agent_executor_overrides ?? {}),
      'agy-cli': { ...(base.config.agent_executor_overrides?.['agy-cli'] ?? {}), show_in_profile_list: true },
      'codex-app-server': { ...(base.config.agent_executor_overrides?.['codex-app-server'] ?? {}), show_in_profile_list: true },
      'grok-acp': { ...(base.config.agent_executor_overrides?.['grok-acp'] ?? {}), show_in_profile_list: true },
    },
  },
  executors,
  executorAccountSources: {
    'agy-cli': [{ id: AGY_ACCOUNT_SOURCE, label: 'Fixture OAuth' }],
  },
  executorAccounts: {
    'agy-cli': {
      [AGY_ACCOUNT_SOURCE]: [
        { id: 'work', label: 'Work account', status: 'ready' },
        { id: 'signed-out', label: 'Other account', status: 'signed_out' },
      ],
    },
  },
  providerQuotas: {
    schema_version: '1',
    generated_at: nowIso,
    sources: [
      {
        id: 'account-kimi',
        label: 'Kimi Official Account',
        kind: 'provider',
        provider_id: 'kimi',
        account_label: 'team@kimi.example',
        enabled: true,
        supported: true,
        status: 'ready',
        refreshing: false,
        refresh_mode: 'explicit',
        checked_at: nowIso,
        data_as_of: nowIso,
        auth: { action: 'provider_settings', provider: 'kimi' },
        source: { label: 'Official Platform', url: 'https://platform.moonshot.cn' },
        meters: [
          { id: 'balance', label: 'Remaining Balance', unit: 'money', unit_label: 'USD', currency: 'USD', used: 12.5, limit: 100, remaining: 87.5, scope: 'account' },
        ],
      },
      {
        id: 'executor:codex-app-server',
        label: 'Codex',
        kind: 'executor',
        provider_id: 'codex-app-server',
        account_label: 'codex@example.test',
        enabled: true,
        supported: true,
        status: 'ready',
        refreshing: false,
        refresh_mode: 'explicit',
        checked_at: nowIso,
        data_as_of: nowIso,
        auth: { action: 'executor_login', provider: 'codex-app-server' },
        source: { label: 'Codex App Server' },
        meters: [
          { id: 'codex-5h', label: '5h rolling window', unit: 'percent', unit_label: '%', used: 28, limit: 100, remaining: 72, scope: 'account', window: { label: '5h', duration_seconds: 18_000, reset_at: plusHoursIso(3) } },
        ],
      },
      {
        id: 'executor:agy-cli',
        label: 'AGY CLI',
        kind: 'executor',
        provider_id: 'agy-cli',
        account_label: 'agy-cli',
        enabled: true,
        supported: false,
        status: 'unsupported',
        refreshing: false,
        refresh_mode: 'explicit',
        auth: { action: 'executor_login', provider: 'agy-cli' },
        source: { label: 'AGY CLI' },
        meters: [],
      },
      {
        id: 'executor:grok-acp',
        label: 'Grok Build',
        kind: 'executor',
        provider_id: 'grok-acp',
        account_label: 'grok@example.test',
        enabled: true,
        supported: true,
        status: 'ready',
        refreshing: false,
        refresh_mode: 'explicit',
        checked_at: nowIso,
        data_as_of: nowIso,
        auth: { action: 'executor_login', provider: 'grok-acp' },
        source: { label: 'Grok CLI' },
        meters: [
          { id: 'grok-rpm', label: 'Requests (1h window)', unit: 'requests', unit_label: 'req', used: 18, limit: 100, remaining: 82, scope: 'account', window: { label: '1h', duration_seconds: 3600 } },
        ],
      },
    ],
  },
  harnessQuotaSources: [
    {
      id: 'plugin:magpie-harness-quota/antigravity',
      label: 'Magpie · Antigravity',
      engineIds: ['agy-cli'],
      minRefreshIntervalMs: 300_000,
    },
    {
      id: 'plugin:magpie-harness-quota/codex',
      label: 'Magpie · Codex',
      engineIds: ['codex-app-server'],
      minRefreshIntervalMs: 300_000,
      readAt: nowIso,
      readings: [
        {
          accountId: 'work',
          accountLabel: 'Work · codex@example.test',
          pool: 'Codex Plus',
          window: '5h',
          unit: 'percent',
          remaining: 64,
          resetAt: plusHoursIso(4),
          modelIds: ['gpt-5.4', 'gpt-5.3-codex'],
        },
      ],
    },
    {
      id: 'plugin:alpha-telemetry/codex',
      label: 'Alpha Quota Bridge',
      engineIds: ['codex-app-server'],
      minRefreshIntervalMs: 600_000,
      readAt: nowIso,
      readings: [
        {
          accountId: 'team',
          accountLabel: 'Engineering Pool',
          pool: 'Monthly cap',
          unit: 'money',
          remaining: 48.5,
        },
      ],
    },
  ],
  harnessQuotaReadResults: {
    'plugin:magpie-harness-quota/antigravity': {
      readAt: nowIso,
      readings: [
        {
          accountId: 'work',
          accountLabel: 'Work · agy@example.test',
          pool: 'Gemini',
          window: '5h',
          unit: 'percent',
          remaining: 82,
          resetAt: plusHoursIso(3),
          modelIds: ['gemini-3.1-pro-high', 'gemini-3-flash', 'gemini-2.5-pro'],
        },
        {
          accountId: 'work',
          accountLabel: 'Work · agy@example.test',
          pool: 'Claude / GPT',
          window: '5h',
          unit: 'percent',
          remaining: 0,
          resetAt: plusHoursIso(2),
          modelIds: ['claude-opus-4-6-thinking', 'claude-sonnet-4-6', 'gpt-5.4'],
        },
        {
          accountId: 'work',
          accountLabel: 'Work · agy@example.test',
          pool: 'Claude / GPT',
          window: '7d',
          unit: 'percent',
          remaining: undefined,
          modelIds: ['claude-opus-4-6-thinking'],
        },
        {
          accountId: 'personal',
          accountLabel: 'Personal · dev@example.test',
          pool: 'Gemini',
          window: '5h',
          unit: 'percent',
          remaining: 95,
          resetAt: plusHoursIso(4),
          modelIds: ['gemini-3.1-pro-high', 'gemini-3-flash'],
        },
      ],
    },
  },
  accountSourceUnavailable: false,
  engineDiscovery: { items: executors.filter(item => item.id !== 'native').map(item => ({
    id: item.id, label: item.label, protocol: item.protocol, installed: true, status: 'installed',
    checked_at: '2026-01-01T00:00:00.000Z', components: [],
  })) },
};
