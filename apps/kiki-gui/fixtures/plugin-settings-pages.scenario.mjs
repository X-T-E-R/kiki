/**
 * installed-plugin settings pages — the Settings → Plugins leaf and the
 * per-plugin page it opens.
 *
 * Self-contained on purpose: it declares its own installed plugins and their
 * settings rather than spreading another scenario, so this page's states are
 * exactly the ones being checked. Four plugins cover the paths that matter:
 *
 *   `kiki-notes`   — a plugin with settings: string, number and boolean fields
 *                    plus a secret that is already stored, so one page shows a
 *                    plain value reading back and a secret reported as set.
 *   `kimi-webbridge` — the browser bridge, installed and off.
 *   `sketchbook`   — a local-folder plugin that is on.
 *   `broken-tools` — reporting errors.
 *
 * No market is configured, so the leaf's link out to the catalog is exercised
 * against a server that has no catalog of its own — the common case, not a
 * broken one.
 */

const ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiByeD0iMyIgZmlsbD0iI2VlZSIvPjwvc3ZnPg==';

const summary = (id, overrides = {}) => ({
  id,
  displayName: id,
  enabled: true,
  state: 'ok',
  skillCount: 0,
  mcpServerCount: 0,
  enabledMcpServerCount: 0,
  hookCount: 0,
  commandCount: 0,
  hasErrors: false,
  source: 'local-path',
  ...overrides,
});

export default {
  plugins: [
    summary('kiki-notes', {
      displayName: 'Kiki Notes',
      version: '2.4.0',
      icon: ICON,
      enabled: true,
      skillCount: 1,
      originalSource: 'C:/kiki/plugins/kiki-notes',
    }),
    summary('sketchbook', {
      displayName: 'Sketchbook',
      version: '0.9.1',
      enabled: true,
      originalSource: 'C:/kiki/plugins/sketchbook',
    }),
    summary('kimi-webbridge', {
      displayName: 'Kimi Browser Extension',
      version: '1.11.4',
      enabled: false,
      originalSource: 'https://example.test/kimi-webbridge/releases/1.11.4.zip',
      source: 'zip-url',
    }),
    summary('broken-tools', {
      displayName: 'Broken Tools',
      enabled: true,
      state: 'error',
      hasErrors: true,
      originalSource: 'C:/kiki/plugins/broken-tools',
    }),
  ],
  // Only `kiki-notes` declares a form. The others must still get a real page:
  // their state and their management, with no invented empty form.
  pluginSettings: {
    'kiki-notes': {
      schema: {
        schema: {
          type: 'object',
          properties: {
            workspace: {
              type: 'string',
              title: 'Workspace folder',
              description: 'Where notes are stored on the server.',
            },
            maxResults: {
              type: 'number',
              title: 'Results per search',
              description: 'How many notes one search returns.',
              default: 8,
            },
            syncOnOpen: {
              type: 'boolean',
              title: 'Sync when Kiki opens',
              description: 'Pull remote changes before the first search.',
            },
            vaultToken: {
              type: 'string',
              title: 'Vault token',
              description: 'Written only. It is never sent back to this page.',
              secret: true,
            },
          },
        },
      },
      values: { workspace: 'notes-archive', syncOnOpen: true },
      secretsConfigured: ['vaultToken'],
    },
  },
  // No catalog: the leaf links to the market, and the market is the bundled one.
  pluginMarketplace: [],
};