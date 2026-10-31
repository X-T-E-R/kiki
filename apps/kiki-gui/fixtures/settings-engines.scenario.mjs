/**
 * settings-engines — the Settings external-engines page against the backend's
 * native-engine discovery: the four engines (Codex, Claude Code, AGY, Grok)
 * each in a different discovery state, so one list reads installed, missing a
 * named dependency, not installed at all, and a detection error side by side.
 *
 * `executors` keeps the catalog the rows still open into; the discovery
 * surface reads `engineDiscovery` (`GET /executors/discovery`, matching
 * `executorDiscoveryResponseSchema`). The seed is a function of the read
 * count: the second read answers the re-detect with AGY installed, so the
 * proof can watch a state land.
 */

import { sessionRecord, ts } from './helpers.mjs';

const SID = 'session_fixture_settings_engines';

const executor = (id, label, protocol, status, version, connection) => ({
  id, label, protocol, status, version,
  model_binding: 'mapped', thinking_binding: 'mapped',
  connection: { login_status: 'unknown', default_args: [], ...connection },
});

const component = (id, label, role, installed, fields = {}) => ({ id, label, role, installed, ...fields });

/** The four engines' discovery items, with AGY's state switchable. */
function discoveryItems(agyInstalled) {
  return [
    {
      id: 'codex-app-server', label: 'Codex', protocol: 'codex-app-server',
      installed: true, status: 'installed', checked_at: ts(4), version: '0.158.0',
      path: 'C:/Program Files/WindowsApps/OpenAI.Codex_1.4.2_x64/app/resources/codex.exe',
      source: 'desktop', source_kind: 'glob',
      components: [component('codex-app-server', 'Codex app-server', 'program', true, {
        path: 'C:/Program Files/WindowsApps/OpenAI.Codex_1.4.2_x64/app/resources/codex.exe', version: '0.158.0',
      })],
    },
    {
      id: 'claude-acp', label: 'Claude Code', protocol: 'acp-v1',
      installed: false, status: 'missing', checked_at: ts(4),
      reason: 'The claude CLI dependency is not installed.', reason_code: 'not_on_path',
      components: [
        component('claude', 'Claude Code CLI', 'dependency', false, {
          // A coded reason localizes through the dictionaries; free text
          // would render as sent.
          reason: 'claude was not found on PATH.', reason_code: 'not_on_path',
        }),
        component('claude-acp', 'claude-agent-acp', 'program', true, {
          path: 'C:/Users/fixture/.kiki/tools/claude-agent-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js', version: '0.84.0',
        }),
      ],
    },
    {
      id: 'agy-cli', label: 'AGY', protocol: 'acp-v1',
      installed: agyInstalled, status: agyInstalled ? 'installed' : 'missing', checked_at: ts(4),
      ...(agyInstalled
        ? {
            path: 'C:/Users/fixture/AppData/Local/Programs/agy/agy.exe', source: 'path', source_kind: 'path-lookup',
            components: [component('agy', 'AGY CLI', 'program', true, { path: 'C:/Users/fixture/AppData/Local/Programs/agy/agy.exe' })],
          }
        : {
            reason: 'agy was not found on this machine.',
            components: [component('agy', 'AGY CLI', 'program', false, { reason: 'agy was not found on PATH.' })],
          }),
    },
    {
      id: 'grok-acp', label: 'Grok Build', protocol: 'acp-v1',
      installed: false, status: 'error', checked_at: ts(26),
      path: 'C:/Users/fixture/.grok/bin/grok.exe', source: 'path', source_kind: 'path-lookup',
      reason: 'The file metadata could not be read.', reason_code: 'metadata_unreadable',
      components: [component('grok', 'Grok Build CLI', 'program', false, {
        path: 'C:/Users/fixture/.grok/bin/grok.exe',
        reason: 'The file exists but its metadata could not be read.', reason_code: 'metadata_unreadable',
      })],
    },
  ];
}

export default {
  config: {
    default_provider: 'fixture',
    default_model: 'fixture/k3',
    providers: { fixture: { type: 'anthropic', has_api_key: true } },
    agent_executor_display: { discovery_initialized: true },
  },
  executors: [
    executor('codex-app-server', 'Codex', 'codex-app-server', 'ready', '0.158.0', {
      command: 'C:/Program Files/WindowsApps/OpenAI.Codex_1.4.2_x64/app/resources/codex.exe', source: 'desktop',
    }),
    executor('claude-acp', 'Claude Code', 'acp-v1', 'ready', '0.84.0', {
      command: 'C:/Users/fixture/.kiki/tools/claude-agent-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js', source: 'kiki-managed',
      install_hint: 'npm install -g @anthropic-ai/claude-code',
    }),
    executor('agy-cli', 'AGY', 'acp-v1', 'unavailable', undefined, {
      command: 'agy', install_hint: 'Install the Antigravity CLI',
    }),
    executor('grok-acp', 'Grok Build', 'acp-v1', 'unavailable', '1.0.40', {
      command: 'C:/Users/fixture/.grok/bin/grok.exe', source: 'path',
    }),
  ],
  // First read: AGY missing. A re-detect (second read) finds it installed.
  engineDiscovery: (calls) => ({ items: discoveryItems(calls >= 1) }),
  sessions: [sessionRecord(SID, { title: 'Fixture: engine settings' })],
};
