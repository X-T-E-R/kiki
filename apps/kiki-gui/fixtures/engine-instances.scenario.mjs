import base from './external-engines.scenario.mjs';

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
  config: { ...base.config, agent_executor_display: { discovery_initialized: true } },
  executors,
  engineDiscovery: { items: executors.filter(item => item.id !== 'native').map(item => ({
    id: item.id, label: item.label, protocol: item.protocol, installed: true, status: 'installed',
    checked_at: '2026-01-01T00:00:00.000Z', components: [],
  })) },
};
