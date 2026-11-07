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

export default {
  ...base,
  config: {
    ...base.config,
    agent_executor_display: { discovery_initialized: true },
    agent_executor_overrides: {
      ...(base.config.agent_executor_overrides ?? {}),
      'agy-cli': { ...(base.config.agent_executor_overrides?.['agy-cli'] ?? {}), show_in_profile_list: true },
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
    },
  ],
  accountSourceUnavailable: false,
  engineDiscovery: { items: executors.filter(item => item.id !== 'native').map(item => ({
    id: item.id, label: item.label, protocol: item.protocol, installed: true, status: 'installed',
    checked_at: '2026-01-01T00:00:00.000Z', components: [],
  })) },
};
