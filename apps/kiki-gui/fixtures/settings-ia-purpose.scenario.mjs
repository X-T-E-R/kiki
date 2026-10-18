/**
 * settings-ia-purpose: the settings-IA base fixture plus the populated shapes
 * the Connection services page needs after the inbound-access cards moved
 * there — the web-access entry, the inbound gate with grants, one external
 * client, and an installed Cloudflare Tunnel plugin whose panel bridge
 * answers `plugin.call`. Purpose-candidate review walks render the real cards
 * from real requests, not error panes.
 */

import base from './settings-ia.scenario.mjs';

const CLOUDFLARE_STATUS = {
  schemaVersion: 1,
  dependency: { state: 'ready', path: 'cloudflared', version: '2026.10.0', installable: true },
  account: { certificate: false, apiToken: false },
  configuration: {
    mode: 'token', tunnelId: '', configPath: '', tokenFile: '',
    credentialsFile: '/fixture/cert.pem', certificatePath: '/fixture/cert.pem',
    publicUrl: 'https://service.example.test', accountId: '', cloudflaredPath: '',
    autoStart: true, tokenConfigured: false,
  },
  service: { state: 'unconfigured', ready: false, manualStop: false, retryCount: 0 },
  login: { state: 'idle' },
};

export default {
  ...base,
  webAccess: {
    enabled: true,
    mode: 'persistent',
    url: 'https://kiki.example.test',
    sessions: [
      { id: 'a1b2c3d4-1111-4111-8111-a1b2c3d4e5f6', label: 'Pixel 8 — Chrome', createdAgoMs: 86_400_000, lastUsedAgoMs: 3_600_000 },
    ],
  },
  externalClients: {
    connections: [
      {
        id: 'conn_chatgpt', name: 'ChatGPT', workspace: 'C:/fixture',
        mode: 'auto', tools: ['Read', 'Write', 'kiki_save_text'],
        allowCommands: false, memoryScopes: ['workspace'], historyScope: 'current',
        status: 'active', createdAt: Date.now() - 20 * 86_400_000, updatedAt: Date.now() - 1_200_000,
      },
    ],
    listener: { enabled: false, state: 'stopped' },
    stdio: { command: 'kiki', args: ['mcp', '--client', 'conn_chatgpt', '--tools'] },
  },
  remoteConnections: {
    inbound: {
      enabled: true,
      configuredEnabled: true,
      grants: [
        { id: 'grant_laptop', label: 'Laptop Kiki', status: 'approved', source: { homeId: 'home_fixture_laptop', hostId: 'host_fixture_laptop' } },
        { id: 'grant_old', label: 'Old desktop', status: 'revoked', source: { homeId: 'home_fixture_old', hostId: 'host_fixture_old' } },
      ],
    },
    connections: [],
  },
  plugins: [
    {
      id: 'kiki-cloudflare', displayName: 'Cloudflare Tunnel', version: '0.3.0',
      enabled: true, globalEnabled: true, state: 'ok',
      skillCount: 0, mcpServerCount: 0, enabledMcpServerCount: 0, hookCount: 0, commandCount: 0,
      hasErrors: false, source: 'local-path', originalSource: 'C:/fixture/plugins/kiki-cloudflare',
    },
  ],
  pluginPanels: {
    'kiki-cloudflare': [{ id: 'cloudflare', label: 'Cloudflare Tunnel', slot: 'settings', html: '<p>cloudflare fixture panel</p>' }],
  },
  pluginCallResponses: {
    'kiki-cloudflare': {
      status: CLOUDFLARE_STATUS,
      tunnels: { items: [] },
      accounts: { items: [] },
    },
  },
  pluginImport: {
    hostShipped: { 'kiki-history': true },
    sources: [
      {
        schemaVersion: 1,
        id: 'claude-code',
        label: 'Claude Code',
        formatVersion: 'claude-code.history.v1',
        pluginId: 'kiki-history',
      },
    ],
    homes: {},
  },
};
