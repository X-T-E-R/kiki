/**
 * capabilities — the /capabilities page and the settings Skills / MCP /
 * Plugins leaves. Official plugins carry the real repository icons and
 * manifests (plugins/official/*), so the marketplace, detail and consent
 * sheets render what a user would see. Covers: installed strip (one healthy,
 * one broken, one off), catalog shelves with overflow, a relevance match,
 * preview outcomes (no-permission skin pack; permissioned tool plugin with a
 * prerequisite binary; changed-fingerprint failure), a sandboxed panel, a
 * plugin skin, MCP servers in every state, and a mixed skill catalog.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sessionRecord } from './helpers.mjs';

const SID = 'session_fixture_capabilities';
const WSID = 'wd_fixture_000000000000';
const OFFICIAL = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'plugins', 'official');

function svgDataUri(file) {
  return `data:image/svg+xml;base64,${readFileSync(file).toString('base64')}`;
}
function manifest(id) {
  return JSON.parse(readFileSync(join(OFFICIAL, id, 'kimi.plugin.json'), 'utf8'));
}

const OFFICE_ICON = svgDataUri(join(OFFICIAL, 'kiki-office', 'icon.svg'));
const WRITING_ICON = svgDataUri(join(OFFICIAL, 'kiki-writing', 'icon.svg'));
const OFFICE_MANIFEST = manifest('kiki-office');
const WRITING_MANIFEST = manifest('kiki-writing');
const WRITING_PANEL = readFileSync(join(OFFICIAL, 'kiki-writing', 'panel.html'), 'utf8');

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

const WRITING = summary('kiki-writing', {
  displayName: 'Kiki Writing',
  version: '0.1.0',
  icon: WRITING_ICON,
  commandCount: 1,
  originalSource: 'C:/kiki/plugins/official/kiki-writing',
});
const RESEARCH = summary('research', {
  displayName: 'Research pack',
  version: '1.4.0',
  skillCount: 2,
  mcpServerCount: 1,
  enabledMcpServerCount: 1,
  hookCount: 1,
  commandCount: 3,
  source: 'github',
  originalSource: 'https://github.com/example/research-pack',
  github: { owner: 'example', repo: 'research-pack', ref: { kind: 'tag', value: 'v1.4.0' }, installedSha: '8f3c2a1b9d7e6f5a4c3b2a1908f7e6d5c4b3a291' },
  rollback: { version: '1.3.2', source: 'github', originalSource: 'https://github.com/example/research-pack' },
});
const BROKEN = summary('broken-tools', {
  displayName: 'Broken tools',
  version: '0.2.1',
  enabled: false,
  state: 'error',
  hasErrors: true,
  mcpServerCount: 1,
  originalSource: 'C:/fixture/plugins/broken-tools',
});

const SKETCHBOOK = summary('sketchbook', {
  displayName: 'Sketchbook',
  version: '0.3.0',
  enabled: false,
  skillCount: 2,
  originalSource: 'D:/work/plugins/sketchbook',
});

// GitHub install tracking a branch; the catalog does not list it, so only
// the GitHub check knows its head moved.
const LINT_RULES = summary('lint-rules', {
  displayName: 'Lint rules',
  version: '0.4.0',
  skillCount: 1,
  commandCount: 1,
  source: 'github',
  originalSource: 'https://github.com/example/lint-rules/tree/main',
  github: { owner: 'example', repo: 'lint-rules', ref: { kind: 'branch', value: 'main' }, installedSha: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d' },
});

const catalog = (id, tier, displayName, description, keywords, extra = {}) => ({
  id, tier, displayName, description, keywords, version: '1.0.0', source: `https://github.com/example/${id}`, ...extra,
});

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: capabilities demo' })],
  snapshots: { [SID]: { messages: [], has_more: false } },
  config: {
    default_model: 'fixture/kiki-pro',
    plugins: { marketplaceUrl: 'C:/kiki/plugins/marketplace.json' },
  },
  plugins: [WRITING, RESEARCH, BROKEN, SKETCHBOOK, LINT_RULES],
  pluginGithubUpdates: [
    { id: 'lint-rules', source: 'github', current: { kind: 'branch', value: 'main' }, latest: { kind: 'branch', value: 'main' }, displayVersion: '9e8d7c6b5a41', updateAvailable: true },
    { id: 'research', source: 'github', current: { kind: 'tag', value: 'v1.4.0' }, latest: { kind: 'tag', value: 'v1.4.0' }, displayVersion: 'v1.4.0', updateAvailable: false },
  ],
  pluginInfos: {
    'kiki-writing': {
      ...WRITING,
      root: 'C:/Users/fixture/.kiki/plugins/managed/kiki-writing',
      installedAt: '2026-09-20T09:12:00.000Z',
      manifest: {
        ...WRITING_MANIFEST,
        'x-kiki': {
          ...WRITING_MANIFEST['x-kiki'],
          themes: [{ schemaVersion: 1, id: 'manuscript', label: 'Manuscript', base: 'light', path: './themes/manuscript.json' }],
        },
      },
      mcpServers: [],
      diagnostics: [],
    },
    research: {
      ...RESEARCH,
      root: 'C:/Users/fixture/.kiki/plugins/managed/research',
      installedAt: '2026-09-18T15:40:00.000Z',
      manifest: {
        name: 'research',
        version: '1.4.0',
        description: 'Search, fetch and cite public sources.',
        'x-kiki': { permissions: { net: ['*.example.com'], fs: 'workspace' } },
      },
      mcpServers: [{ name: 'fetch', runtimeName: 'plugin__research__fetch', enabled: true, transport: 'stdio', command: 'node' }],
      diagnostics: [],
    },
    'broken-tools': {
      ...BROKEN,
      root: 'C:/fixture/plugins/broken-tools',
      installedAt: '2026-09-10T11:00:00.000Z',
      manifest: { name: 'broken-tools', version: '0.2.1' },
      mcpServers: [],
      diagnostics: [{ severity: 'error', message: 'x-kiki.engines.kiki "^0.9.0" does not match this Kiki (0.4.0).' }],
    },
  },
  pluginMarketplace: [
    catalog('kiki-office', 'official', 'Kiki Office Suite', 'Create and edit local Word, Excel and PowerPoint files.', ['office', 'docx', 'xlsx', 'pptx'], {
      version: '0.1.0', icon: OFFICE_ICON, source: 'C:/kiki/plugins/official/kiki-office',
      relevance: { fileGlobs: ['**/*.docx', '**/*.xlsx', '**/*.pptx'], commands: ['officecli'] },
    }),
    catalog('kiki-writing', 'official', 'Kiki Writing', 'A focused manuscript panel and draft command.', ['writing', 'manuscript'], {
      version: '0.1.0', icon: WRITING_ICON, source: 'C:/kiki/plugins/official/kiki-writing',
      installed: { version: '0.1.0', enabled: true },
    }),
    catalog('kimi-webbridge', 'official', 'Kimi Browser Extension', 'Control your real browser from Kiki.', ['browser', 'automation'], { version: '1.11.4' }),
    catalog('kimi-datasource', 'official', 'Kimi Datasource', 'Official datasource workflows.', ['data', 'mcp'], { version: '3.3.0' }),
    catalog('research', 'curated', 'Research pack', 'Search, fetch and cite public sources in a brief.', ['web'], {
      version: '1.5.0', installed: { version: '1.4.0', enabled: true }, updateAvailable: true,
    }),
    catalog('superpowers', 'curated', 'Superpowers', 'Planning, TDD, debugging and delivery workflows for coding agents.', ['skills', 'planning', 'tdd']),
    catalog('vercel-plugin', 'curated', 'Vercel Plugin', 'Skills, agents and conventions for the Vercel platform.', ['vercel', 'deployment']),
    catalog('modern-web-guidance', 'curated', 'Modern Web Guidance', 'Web platform best practices and browser compatibility data from the Chrome team.', ['web', 'css']),
    catalog('review-kit', 'curated', 'Review Kit', 'Structured code review checklists and a reviewer agent.', ['code-review']),
    catalog('git-flow', 'curated', 'Git Flow', 'Branching, release notes and changelog automation.', ['git']),
    catalog('test-doctor', 'curated', 'Test Doctor', 'Find flaky tests and explain failures from CI logs.', ['debugging']),
    catalog('api-scout', 'curated', 'API Scout', 'Generate typed clients from OpenAPI documents.', ['agents']),
    catalog('linear-sync', 'curated', 'Linear Sync', 'Read and update Linear issues from a session.', ['planning']),
    catalog('notion-pages', 'curated', 'Notion Pages', 'Draft and publish Notion pages from your notes.', ['notes']),
    catalog('pdf-tools', 'curated', 'PDF Tools', 'Read, split and annotate PDF documents.', ['pdf']),
    catalog('sql-lens', 'curated', 'SQL Lens', 'Explore local databases and explain query plans.', ['sql']),
    catalog('community-theme-pack', 'third-party', 'Community Theme Pack', 'Twelve community skins for Kiki.', []),
  ],
  pluginRecommendations: ['kiki-office', 'pdf-tools'],
  pluginSettings: {
    research: {
      schema: {
        schemaVersion: 1,
        schema: {
          type: 'object',
          properties: {
            region: { type: 'string', title: 'Search region', description: 'Two-letter region code sent with every search.', default: 'us' },
            maxResults: { type: 'number', title: 'Results per search', default: 8 },
            safeSearch: { type: 'boolean', title: 'Safe search', description: 'Filter explicit results.' },
            apiKey: { type: 'string', title: 'API key', secret: true },
          },
        },
      },
      values: { region: 'de', safeSearch: true },
      secretsConfigured: ['apiKey'],
    },
  },
  pluginCandidates: {
    'C:/kiki/plugins/official/kiki-office': {
      plan: {
        id: 'kiki-office', version: '0.1.0',
        fingerprint: 'a'.repeat(64),
        changes: [],
        consentRequired: true,
        permissions: OFFICE_MANIFEST['x-kiki'].permissions,
        contributions: [...OFFICE_MANIFEST['x-kiki'].tools.map((tool) => `tool:${tool.name}`), 'skill:0', 'settings'],
        contextTokens: 1840,
        unsupported: [],
      },
      summary: summary('kiki-office', { displayName: 'Kiki Office Suite', version: '0.1.0', icon: OFFICE_ICON, skillCount: 1, originalSource: 'C:/kiki/plugins/official/kiki-office' }),
      info: {
        ...summary('kiki-office', { displayName: 'Kiki Office Suite', version: '0.1.0', icon: OFFICE_ICON, skillCount: 1, originalSource: 'C:/kiki/plugins/official/kiki-office' }),
        root: 'C:/Users/fixture/.kiki/plugins/managed/kiki-office',
        installedAt: '2026-09-28T10:00:00.000Z',
        manifest: OFFICE_MANIFEST,
        prerequisites: { origin: 'plugin-declared', items: OFFICE_MANIFEST['x-kiki'].prerequisites },
        mcpServers: [],
        diagnostics: [],
      },
    },
    'https://github.com/example/community-theme-pack': {
      plan: {
        id: 'community-theme-pack', version: '1.0.0', fingerprint: 'b'.repeat(64), changes: [], consentRequired: false,
        contributions: ['theme:dusk', 'theme:paper', 'theme:ink'], contextTokens: 0, unsupported: [],
      },
      summary: summary('community-theme-pack', { displayName: 'Community Theme Pack', version: '1.0.0', source: 'github' }),
    },
    'https://github.com/example/superpowers': {
      plan: {
        id: 'superpowers', version: '1.0.0', fingerprint: 'c'.repeat(64), changes: [], consentRequired: false,
        contributions: ['skill:0', 'skill:1', 'skill:2', 'command:plan'], contextTokens: 420, unsupported: ['hooks/SessionStart'],
      },
      summary: summary('superpowers', { displayName: 'superpowers', version: '1.0.0', source: 'github', skillCount: 3 }),
    },
    'https://github.com/example/lint-rules/tree/main': {
      plan: {
        id: 'lint-rules', version: '0.4.0', fingerprint: 'd'.repeat(64), changes: [], consentRequired: false,
        contributions: ['skill:0', 'command:lint'], contextTokens: 310, unsupported: [],
      },
      summary: LINT_RULES,
    },
    'https://github.com/example/sql-lens': {
      error: { code: 40001, msg: 'The plugin requires Kiki ^0.9.0; this server runs 0.4.0.' },
    },
  },
  pluginPrerequisiteFailures: [],
  pluginPanels: {
    'kiki-writing': [{ id: 'manuscript', label: 'Manuscript', slot: 'workspace', html: WRITING_PANEL }],
  },
  pluginSkins: [
    { id: 'kiki-writing:manuscript', name: 'Manuscript', variants: ['light'], plugin: { id: 'kiki-writing', version: '0.1.0' } },
  ],
  mcpServers: [
    { id: 'mcp_fixture_0001', name: 'fixture-fs', transport: 'stdio', status: 'connected', tool_count: 4 },
    { id: 'mcp_fixture_0002', name: 'fixture-web', transport: 'http', status: 'error', last_error: 'spawn failed: ENOENT fixture-web\n    at ChildProcess._handle.onexit (node:internal/child_process:286:19)', tool_count: 0 },
    { id: 'mcp_fixture_0003', name: 'fixture-legacy', transport: 'sse', status: 'disconnected', tool_count: 2 },
    { id: 'plugin__research__fetch', name: 'fetch', transport: 'stdio', status: 'connected', tool_count: 1 },
  ],
  mcpManagedServers: [
    { name: 'fixture-fs', config: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/fixture'] }, source: 'global', origin: 'C:/Users/fixture/.kiki/mcp.json', mutable: true },
    { name: 'fixture-web', config: { transport: 'http', url: 'https://mcp.example.test/web' }, source: 'global', origin: 'C:/Users/fixture/.kiki/mcp.json', mutable: true },
    { name: 'fixture-legacy', config: { transport: 'sse', url: 'https://legacy.example.test/sse' }, source: 'global', origin: 'C:/fixture/.kimi/mcp.json', mutable: true },
    { name: 'fetch', config: { transport: 'stdio', command: 'node', args: ['fetch.mjs'] }, source: 'plugin', origin: 'research', mutable: false, plugin: { id: 'research', name: 'Research pack' } },
  ],
  tools: [
    { name: 'Read', description: 'Read a file from the workspace.', input_schema: {}, source: 'builtin', active: true },
    { name: 'Edit', description: 'Replace text in a file.', input_schema: {}, source: 'builtin', active: true },
    { name: 'Bash', description: 'Run a shell command.', input_schema: {}, source: 'builtin', active: true },
    { name: 'WebFetch', description: 'Fetch a URL and return readable text.', input_schema: {}, source: 'builtin', active: false },
    { name: 'mcp__fixture-fs__read_file', description: 'Read a file through the filesystem server.', input_schema: {}, source: 'mcp', mcp_server_id: 'mcp_fixture_0001', active: true },
    { name: 'mcp__fixture-fs__list_directory', description: 'List a directory.', input_schema: {}, source: 'mcp', mcp_server_id: 'mcp_fixture_0001', active: true },
    { name: 'mcp__fixture-fs__search_files', description: 'Search files by pattern.', input_schema: {}, source: 'mcp', mcp_server_id: 'mcp_fixture_0001', active: true },
    { name: 'mcp__fixture-fs__get_file_info', description: 'Stat a file.', input_schema: {}, source: 'mcp', mcp_server_id: 'mcp_fixture_0001', active: true },
    { name: 'plugin__kiki-writing__continue_draft', description: 'Continue the current manuscript scene.', input_schema: {}, source: 'plugin', active: true },
  ],
  workspaceSkills: {
    [WSID]: [
      { name: 'web-research', description: 'Search and synthesize public sources into a cited brief.', path: 'C:/Users/fixture/.kiki/plugins/managed/research/skills/web-research/SKILL.md', source: 'plugin' },
      { name: 'data-scrape', description: 'Extract structured tables from pages the plugin has fetched.', path: 'C:/Users/fixture/.kiki/plugins/managed/research/skills/data-scrape/SKILL.md', source: 'plugin' },
      { name: 'release-checklist', description: 'Walk the release checklist for this repository and tick off each gate.', path: 'C:/fixture/.kimi/skills/release-checklist/SKILL.md', source: 'project', prompt_command: true },
      { name: 'fixture-lint', description: 'Run the workspace lint suite and summarize failures.', path: 'C:/fixture/.kimi/skills/fixture-lint/SKILL.md', source: 'project' },
      { name: 'morning-brief', description: 'A personal daily digest kept in the home skills folder.', path: 'C:/Users/fixture/.kimi/skills/morning-brief/SKILL.md', source: 'user', disable_model_invocation: true },
      { name: 'team-glossary', description: 'Shared team terminology loaded from an extra skill folder.', path: 'C:/fixture/shared/team-glossary/SKILL.md', source: 'extra' },
      { name: 'kiki-ops', description: 'Kiki product usage and configuration operations.', path: 'builtin:kiki-ops', source: 'builtin' },
      { name: 'kiki-profile', description: 'Create or modify Kiki agent profile files.', path: 'builtin:kiki-profile', source: 'builtin' },
      { name: 'kiki-skins', description: 'Author and install GUI skins.', path: 'builtin:kiki-skins', source: 'builtin' },
      { name: 'kiki-plugins', description: 'Package and publish Kiki plugins.', path: 'builtin:kiki-plugins', source: 'builtin' },
      { name: 'kiki-cron', description: 'Schedule recurring agent tasks.', path: 'builtin:kiki-cron', source: 'builtin' },
    ],
  },
  workspaces: [
    {
      id: WSID,
      root: 'C:/fixture',
      name: 'fixture',
      created_at: new Date().toISOString(),
      last_opened_at: new Date().toISOString(),
      session_count: 1,
      pinned: false,
    },
  ],
};
