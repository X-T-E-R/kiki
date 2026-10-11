/**
 * plugin-scopes — the four-level plugin answer, on a real session and a real
 * workspace.
 *
 * Self-contained on purpose: this page checks the scope switches themselves,
 * so it declares exactly the rows it needs rather than spreading another
 * scenario and hoping they line up. Every row is one of the cases a screenshot
 * has to be able to show:
 *
 *   - a plugin on everywhere, decided by the global default;
 *   - a plugin with the global default OFF that this conversation turned on,
 *     so a local `on` cannot be read as a global one;
 *   - a plugin the workspace turned off while this conversation inherits it;
 *   - a plugin this conversation turned off over an on global default;
 *   - a plugin the master switch denies, which no lower scope can reach;
 *   - a plugin that failed to load.
 *
 * `globalEnabled` on an installed plugin is the global default, kept distinct
 * from `enabled`, which is the master switch. `research` is seeded the way a
 * "decide later" install lands: installed, master on, global default off.
 */

import { sessionRecord } from './helpers.mjs';

const ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiByeD0iNCIgZmlsbD0iIzlhODg3OCIvPjxwYXRoIGQ9Ik00LjUgNS4yNWg3TTQuNSA4aDVNNC41IDEwLjc1aDMiIHN0cm9rZT0iI2Y2ZjFlOCIgc3Ryb2tlLXdpZHRoPSIxLjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjwvc3ZnPg==';

const SID = 'session_fixture_plugin_scopes';
const WSID = 'wd_plugin_scopes_0123456789ab';
const WSID2 = 'wd_plugin_other_fedcba987654';

const summary = (id, overrides = {}) => ({
  id,
  displayName: id,
  icon: ICON,
  enabled: true,
  globalEnabled: true,
  state: 'ok',
  skillCount: 0,
  mcpServerCount: 0,
  enabledMcpServerCount: 0,
  hookCount: 0,
  commandCount: 0,
  hasErrors: false,
  source: 'local-path',
  originalSource: `C:/kiki/plugins/${id}`,
  ...overrides,
});

const usageRow = (id, displayName, overrides = {}) => ({
  id,
  displayName,
  version: '2.4.0',
  home_enabled: true,
  global_enabled: true,
  state: 'ok',
  override: 'inherit',
  effective: true,
  app_service: false,
  skillCount: 0,
  mcpServerCount: 0,
  ...overrides,
});

export default {
  // The session belongs to the workspace this fixture seeds usage for, so the
  // rail reads the same place the workspace page shows.
  sessions: [sessionRecord(SID, { workspace_id: WSID, title: 'Fixture: plugin scopes' })],
  snapshots: { [SID]: { messages: [], has_more: false } },
  workspaces: [
    {
      id: WSID,
      root: 'C:/fixture/scopes',
      name: 'Scopes workspace',
      created_at: new Date().toISOString(),
      last_opened_at: new Date().toISOString(),
      session_count: 2,
      pinned: false,
      isGit: true,
    },
    {
      id: WSID2,
      root: 'C:/fixture/other',
      name: 'Other workspace',
      created_at: new Date().toISOString(),
      last_opened_at: new Date(Date.now() - 86_400_000).toISOString(),
      session_count: 0,
      pinned: false,
      isGit: false,
    },
  ],
  // Trust is seeded per workspace so the page reads a real answer; the page
  // never grants it on its own.
  workspaceTrust: {
    [WSID]: { trusted: false },
    [WSID2]: { trusted: true },
  },
  workspaceSkills: {
    [WSID]: [
      { name: 'release-checklist', description: 'Walk the release checklist for this repository.', path: 'C:/fixture/.kimi/skills/release-checklist/SKILL.md', source: 'project', prompt_command: true },
      { name: 'kiki-plugins', description: 'Package and publish Kiki plugins.', path: 'builtin:kiki-plugins', source: 'builtin' },
    ],
  },
  // The MCP entries a workspace's own page points at: one this server owns, so
  // the leaf really shows an edit, and one it only reads from a plugin, so the
  // read-only tag is a fact about the entry rather than about the page.
  mcpManagedServers: [
    { name: 'files', config: { transport: 'stdio', command: 'npx', args: ['-y', 'fixture-files'] }, source: 'global', origin: '/home/fixture/mcp.json', mutable: true },
    { name: 'from-plugin', config: { transport: 'sse', url: 'https://plugin.example.test/mcp', headerKeys: [] }, source: 'plugin', origin: 'Plugin fixture', mutable: false },
  ],
  // One installable candidate, so the consent sheet's new question — where
  // this plugin should land — can actually be seen. It declares permissions,
  // because the sheet's scope choice sits below the permission list.
  pluginCandidates: {
    'https://example.test/summarizer.git': {
      plan: {
        id: 'summarizer',
        version: '1.0.0',
        fingerprint: 'a'.repeat(64),
        changes: [],
        consentRequired: true,
        permissions: { fs: 'workspace', net: ['api.example.test'] },
        contributions: ['tool:summarize', 'skill:summarize', 'panel:summary'],
        contextTokens: 1200,
        unsupported: [],
      },
      summary: summary('summarizer', {
        displayName: 'Summarizer',
        version: '1.0.0',
        skillCount: 1,
        commandCount: 1,
        hookCount: 0,
        originalSource: 'https://example.test/summarizer.git',
      }),
      info: {
        root: 'C:/kiki/plugins/managed/summarizer',
        installedAt: '2026-01-01T00:00:00.000Z',
        manifest: { name: 'summarizer' },
        mcpServers: [],
        diagnostics: [],
      },
    },
  },
  plugins: [
    summary('kiki-notes', { displayName: 'Kiki Notes', version: '2.4.0', skillCount: 3 }),
    // The "decide later" plugin: installed, master on, global default off.
    summary('research', { displayName: 'Research', version: '1.4.0', globalEnabled: false, mcpServerCount: 2 }),
    summary('office', { displayName: 'Office tools', version: '0.8.2' }),
    summary('skins', { displayName: 'Skins', version: '3.0.0' }),
    summary('browser-bridge', { displayName: 'Browser bridge', version: '1.1.0', enabled: false, source: 'zip-url', originalSource: 'https://example.test/browser-bridge/releases/1.1.0.zip' }),
    summary('vault', { displayName: 'Vault', version: '0.1.0', state: 'error', hasErrors: true }),
  ],
  pluginUsage: {
    [`session:${SID}`]: {
      workspace_id: WSID,
      workspace_name: 'Scopes workspace',
      workspace_root: 'C:/fixture/scopes',
      plugins: [
        usageRow('kiki-notes', 'Kiki Notes', { skillCount: 3 }),
        usageRow('research', 'Research', {
          global_enabled: false, mcpServerCount: 2, session_override: 'on',
        }),
        usageRow('office', 'Office tools', {
          override: 'off', effective: false, reason: 'workspace_disabled',
        }),
        usageRow('skins', 'Skins', {
          session_override: 'off', effective: false, reason: 'session_disabled', app_service: true,
        }),
        usageRow('browser-bridge', 'Browser bridge', {
          home_enabled: false, effective: false, reason: 'home_disabled', app_service: true,
        }),
        usageRow('vault', 'Vault', {
          state: 'error', effective: false, reason: 'invalid_plugin',
        }),
      ],
    },
    [WSID]: {
      workspace_id: WSID,
      workspace_name: 'Scopes workspace',
      workspace_root: 'C:/fixture/scopes',
      plugins: [
        usageRow('kiki-notes', 'Kiki Notes', { skillCount: 3 }),
        usageRow('research', 'Research', { global_enabled: false, mcpServerCount: 2, override: 'on' }),
        usageRow('office', 'Office tools', { override: 'off', effective: false, reason: 'workspace_disabled' }),
        usageRow('browser-bridge', 'Browser bridge', {
          home_enabled: false, effective: false, reason: 'home_disabled', app_service: true,
        }),
      ],
    },
    [WSID2]: {
      workspace_id: WSID2,
      workspace_name: 'Other workspace',
      workspace_root: 'C:/fixture/other',
      plugins: [
        usageRow('kiki-notes', 'Kiki Notes', { skillCount: 3 }),
        usageRow('research', 'Research', { global_enabled: false, effective: false, reason: 'global_disabled', mcpServerCount: 2 }),
      ],
    },
  },
};