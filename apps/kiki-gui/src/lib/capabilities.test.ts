import { describe, expect, it } from 'vitest';

import type { McpServer, SkillDescriptor, Workspace } from '@kiki/protocol';

import { bridgeBody } from '../components/capabilities/PluginPanelHost';
import type { PluginMarketplaceEntry } from './client';
import {
  catalogMatches,
  installedMatches,
  localizeEntry,
  pluginOrigin,
  hasAnyPermission,
  planContributionGroups,
  pluginContributions,
  pluginPermissions,
  pluginPrerequisites,
  pluginUpdate,
  shelveCatalog,
  toolDisplayName,
} from './pluginCatalog';

import {
  filterMcpServers,
  groupSkills,
  mcpServerMatchesQuery,
  normalizeCapQuery,
  pickWorkspace,
  skillGroupId,
  skillMatchesQuery,
} from './capabilities';

function skill(name: string, source: string, description = '', path = `skills/${name}`): SkillDescriptor {
  // The wire is looser than the protocol enum (see module header), so the
  // fixtures cast freely to cover legacy/unknown sources.
  return { name, description, path, source } as SkillDescriptor;
}

function server(id: string, name: string, status: McpServer['status'] = 'connected'): McpServer {
  return { id, name, transport: 'stdio', status, tool_count: 1 };
}

function workspace(id: string, name = id): Workspace {
  return {
    id,
    name,
    root: `C:/fixture/${name}`,
    created_at: '2026-01-01T00:00:00.000Z',
    last_opened_at: '2026-01-01T00:00:00.000Z',
    session_count: 0,
  } as Workspace;
}

describe('skillGroupId', () => {
  it('maps every known source onto its display group', () => {
    expect(skillGroupId('plugin')).toBe('plugin');
    expect(skillGroupId('project')).toBe('project');
    expect(skillGroupId('user')).toBe('user');
    expect(skillGroupId('extra')).toBe('extra');
    expect(skillGroupId('builtin')).toBe('builtin');
  });

  it('treats the legacy workspace spelling as project', () => {
    expect(skillGroupId('workspace')).toBe('project');
  });

  it('buckets unknown sources into other', () => {
    expect(skillGroupId('')).toBe('other');
    expect(skillGroupId('future-source')).toBe('other');
  });
});

describe('normalizeCapQuery', () => {
  it('trims and lowercases', () => {
    expect(normalizeCapQuery('  ReView ')).toBe('review');
    expect(normalizeCapQuery('   ')).toBe('');
  });
});

describe('skillMatchesQuery', () => {
  const entry = skill('review', 'project', 'Review code changes', 'skills/review');

  it('matches name, description, and path case-insensitively', () => {
    expect(skillMatchesQuery(entry, 'REVIEW')).toBe(true);
    expect(skillMatchesQuery(entry, 'code CHANGES')).toBe(true);
    expect(skillMatchesQuery(entry, 'skills/rev')).toBe(true);
  });

  it('passes everything through on an empty query', () => {
    expect(skillMatchesQuery(entry, '')).toBe(true);
  });

  it('rejects non-matches', () => {
    expect(skillMatchesQuery(entry, 'deploy')).toBe(false);
  });
});

describe('groupSkills', () => {
  const catalog = [
    skill('builtin-b', 'builtin'),
    skill('plug', 'plugin'),
    skill('proj', 'workspace'),
    skill('builtin-a', 'builtin'),
    skill('mine', 'user'),
    skill('mystery', 'unknown'),
  ];

  it('groups in display order and drops empty groups', () => {
    const groups = groupSkills(catalog, '');
    expect(groups.map((group) => group.id)).toEqual(['plugin', 'project', 'user', 'builtin', 'other']);
    expect(groups[3]?.skills.map((entry) => entry.name)).toEqual(['builtin-b', 'builtin-a']);
  });

  it('filters before grouping', () => {
    const groups = groupSkills(catalog, 'builtin');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe('builtin');
    expect(groups[0]?.skills).toHaveLength(2);
  });

  it('returns nothing when the query matches nothing', () => {
    expect(groupSkills(catalog, 'zzz-no-match')).toEqual([]);
    expect(groupSkills([], '')).toEqual([]);
  });
});

describe('mcpServerMatchesQuery / filterMcpServers', () => {
  const servers = [
    server('m1', 'filesystem'),
    server('m2', 'web-search', 'error'),
  ];

  it('matches name, transport, and status', () => {
    expect(mcpServerMatchesQuery(servers[0] as McpServer, 'file')).toBe(true);
    expect(mcpServerMatchesQuery(servers[0] as McpServer, 'STDIO')).toBe(true);
    expect(mcpServerMatchesQuery(servers[1] as McpServer, 'error')).toBe(true);
    expect(mcpServerMatchesQuery(servers[0] as McpServer, 'error')).toBe(false);
  });

  it('filters the list and keeps order', () => {
    expect(filterMcpServers(servers, 'e').map((entry) => entry.id)).toEqual(['m1', 'm2']);
    expect(filterMcpServers(servers, 'web').map((entry) => entry.id)).toEqual(['m2']);
    expect(filterMcpServers(servers, 'nope')).toEqual([]);
  });
});

describe('pickWorkspace', () => {
  const workspaces = [workspace('wd_a'), workspace('wd_b')];

  it('honors an explicit existing id', () => {
    expect(pickWorkspace(workspaces, 'wd_b')?.id).toBe('wd_b');
  });

  it('falls back to the first workspace', () => {
    expect(pickWorkspace(workspaces, undefined)?.id).toBe('wd_a');
    expect(pickWorkspace(workspaces, 'wd_gone')?.id).toBe('wd_a');
  });

  it('returns undefined with no workspaces registered', () => {
    expect(pickWorkspace([], undefined)).toBeUndefined();
  });
});

describe('plugin catalog shaping', () => {
  const entry = (id: string, tier: PluginMarketplaceEntry['tier'], keywords: string[] = [], extra: Partial<PluginMarketplaceEntry> = {}): PluginMarketplaceEntry => ({
    id, tier, displayName: id, source: `https://example.test/${id}`, keywords, ...extra,
  });

  it('leads with workspace matches, then shelves the rest by declared tier', () => {
    const shelves = shelveCatalog([
      entry('office', 'official', ['office']),
      entry('pdf', 'curated', ['pdf']),
      entry('tdd', 'curated', ['tdd']),
      entry('odd', 'curated', ['unknown']),
      entry('lens', 'curated', ['sql']),
      entry('theme', 'third-party', ['sql']),
    ], '', new Set(['lens', 'theme']));
    // Tiers, not keywords, decide the shelf: what a package *is* is catalog
    // data, and guessing a category from a word in its keywords was the rule
    // this replaced. A workspace match leads as its own shelf; everything
    // else follows its tier, so the third-party entry drops to `more`.
    expect(shelves.map((shelf) => [shelf.id, shelf.entries.map((item) => item.id)])).toEqual([
      ['recommended', ['lens']], ['official', ['office']], ['community', ['pdf', 'tdd', 'odd']], ['more', ['theme']],
    ]);
    expect(shelveCatalog([entry('office', 'official', ['docx'])], 'DOCX').length).toBe(1);
    expect(shelveCatalog([entry('office', 'official')], 'zzz')).toEqual([]);
  });

  it('breaks a tier into one block per declared sub-group', () => {
    const shelves = shelveCatalog([
      entry('media', 'official', [], { group: 'media' }),
      entry('media-ark', 'official', [], { group: 'media' }),
      entry('writing', 'official', []),
    ], '', new Set());
    expect(shelves.flatMap((shelf) => [shelf.group, ...shelf.entries.map((item) => item.id)])).toEqual([
      'media', 'media', 'media-ark', undefined, 'writing',
    ]);
  });

  it('reads an entry in the reader language and falls back field by field', () => {
    const office = entry('kiki-office', 'official', ['office'], {
      localizations: { zh: { description: '在本机创建 Word、Excel 与 PowerPoint 文件。', keywords: ['办公', '文档'] } },
    });
    // The catalog translated the description and the search words but not the
    // name, so a brand name keeps its own spelling.
    expect(localizeEntry(office, 'en')).toEqual({ displayName: 'kiki-office', description: undefined, keywords: ['office'] });
    expect(localizeEntry(office, 'zh')).toEqual({ displayName: 'kiki-office', description: '在本机创建 Word、Excel 与 PowerPoint 文件。', keywords: ['办公', '文档'] });
    // An entry nobody translated reads exactly as written.
    expect(localizeEntry(entry('notes', 'curated', ['notes']), 'zh')).toEqual({ displayName: 'notes', description: undefined, keywords: ['notes'] });
  });

  it('searches every language the catalog declares, not only the one on screen', () => {
    const office = entry('kiki-office', 'official', ['office'], {
      localizations: { zh: { description: '在本机创建 Word、Excel 与 PowerPoint 文件。', keywords: ['办公', '文档'] } },
    });
    expect(catalogMatches(office, '办公')).toBe(true);
    expect(catalogMatches(office, '文档')).toBe(true);
    // The original words still match, so a reader who knows a package by the
    // name they always saw finds it in a Chinese window.
    expect(catalogMatches(office, 'office')).toBe(true);
    expect(catalogMatches(office, 'kiki-office')).toBe(true);
    expect(catalogMatches(office, 'nope')).toBe(false);
  });

  it('labels an installed plugin by its origin and matches it by name or source', () => {
    const catalogEntries = [entry('office', 'official'), entry('notes', 'curated')];
    expect(pluginOrigin({ id: 'office', source: 'local-path' }, catalogEntries)).toBe('official');
    expect(pluginOrigin({ id: 'notes', source: 'zip-url' }, catalogEntries)).toBe('catalog');
    expect(pluginOrigin({ id: 'mine', source: 'local-path' }, catalogEntries)).toBe('local');
    expect(pluginOrigin({ id: 'fork', source: 'github' }, catalogEntries)).toBe('git');
    expect(pluginOrigin({ id: 'pack', source: 'zip-url' }, catalogEntries)).toBe('zip');
    const fork = { id: 'fork', displayName: 'Fork', originalSource: 'https://github.com/example/fork' };
    expect(installedMatches(fork, 'GITHUB')).toBe(true);
    expect(installedMatches(fork, 'office')).toBe(false);
  });

  it('reads contributions, permissions and prerequisites from either manifest spelling', () => {
    const manifest = {
      'x-kiki': {
        permissions: { exec: ['officecli'], fs: 'outside' },
        tools: [{ name: 'office_view', description: 'View.', accesses: [{ kind: 'file', operation: 'read' }, { kind: 'all' }] }],
        panels: [{ id: 'manuscript', label: 'Manuscript', slot: 'workspace' }],
        themes: [{ id: 'dusk', label: 'Dusk', base: 'dark' }],
        commands: [{ name: 'continue-draft', description: 'Continue.' }],
        prerequisites: { items: [{ id: 'officecli', kind: 'executable', required: true, version: '1.0.152' }] },
      },
    };
    const contributions = pluginContributions('kiki-office', manifest);
    expect(contributions.tools).toEqual([{ name: 'office_view', runtimeName: 'plugin__kiki-office__office_view', description: 'View.', accesses: ['read'] }]);
    expect(contributions.panels[0]?.label).toBe('Manuscript');
    expect(contributions.themes[0]?.id).toBe('dusk');
    expect(contributions.commands[0]?.name).toBe('continue-draft');
    expect(pluginPermissions(manifest)).toMatchObject({ fs: 'outside', exec: ['officecli'] });
    expect(hasAnyPermission(pluginPermissions({ kiki: {} }))).toBe(false);
    expect(pluginPrerequisites(undefined, manifest)).toEqual([expect.objectContaining({ id: 'officecli', version: '1.0.152', required: true })]);
    expect(pluginContributions('p', { kiki: { tools: [{ name: 't', description: '' }] } }).tools[0]?.runtimeName).toBe('plugin__p__t');
  });

  it('shows tool names without their plugin or MCP prefix', () => {
    expect(toolDisplayName('plugin__kiki-office__office_view')).toBe('office_view');
    expect(toolDisplayName('mcp__fixture-fs__read_file')).toBe('read_file');
    expect(toolDisplayName('Read')).toBe('Read');
  });

  it('groups a preview plan by contribution kind in display order', () => {
    expect(planContributionGroups(['skill:0', 'tool:a', 'tool:b', 'hook:0:Stop', 'settings'])).toEqual([
      { kind: 'tool', names: ['a', 'b'] },
      { kind: 'skill', names: [''] },
      { kind: 'hook', names: [''] },
      { kind: 'settings', names: [''] },
    ]);
  });
});

describe('plugin panel bridge', () => {
  it('pins the host session and rejects oversize or malformed requests', () => {
    const base = { channel: 'kiki.panel.v1' as const, kind: 'request' as const, id: 1 };
    expect(bridgeBody({ ...base, method: 'session.summary', ...{ sessionId: 'forged' } } as never, 's1'))
      .toEqual({ method: 'session.summary', session_id: 's1' });
    expect(bridgeBody({ ...base, method: 'session.sendMessage', text: 'hello' }, 's1'))
      .toEqual({ method: 'session.sendMessage', session_id: 's1', text: 'hello' });
    expect(typeof bridgeBody({ ...base, method: 'session.sendMessage', text: 'x'.repeat(16_385) }, 's1')).toBe('string');
    expect(typeof bridgeBody({ ...base, method: 'session.sendMessage', text: '  ' }, 's1')).toBe('string');
    expect(typeof bridgeBody({ ...base, method: 'plugin.call', action: '../x' }, 's1')).toBe('string');
    expect(bridgeBody({ ...base, method: 'plugin.call', action: 'save', args: { a: 1 } }, 's1'))
      .toEqual({ method: 'plugin.call', session_id: 's1', action: 'save', args: { a: 1 } });
  });
});

describe('pluginUpdate', () => {
  const github = { id: 'lint', source: 'github' as const, originalSource: 'https://github.com/example/lint/tree/main' };
  const status = (updateAvailable: boolean, kind: 'branch' | 'tag' = 'branch') => ({
    id: 'lint', source: 'github' as const, latest: { kind, value: kind === 'branch' ? 'main' : 'v2.0.0' },
    displayVersion: kind === 'branch' ? '9e8d7c6b5a41' : 'v2.0.0', updateAvailable,
  });

  it('prefers the catalog answer and reinstalls from the catalog source', () => {
    expect(pluginUpdate(github, { source: 'https://example.test/lint.zip', version: '2.0.0', updateAvailable: true }, [status(true)]))
      .toEqual({ via: 'catalog', source: 'https://example.test/lint.zip', version: '2.0.0' });
  });

  it('falls back to GitHub for GitHub installs and reinstalls from the recorded source', () => {
    expect(pluginUpdate(github, undefined, [status(true)]))
      .toEqual({ via: 'github', source: github.originalSource, version: '9e8d7c6b5a41', branch: 'main' });
    expect(pluginUpdate(github, undefined, [status(true, 'tag')]))
      .toEqual({ via: 'github', source: github.originalSource, version: 'v2.0.0' });
  });

  it('reports nothing when neither channel has an update or the check has not answered', () => {
    expect(pluginUpdate(github, undefined, [status(false)])).toBeUndefined();
    expect(pluginUpdate(github, undefined, undefined)).toBeUndefined();
    expect(pluginUpdate({ ...github, source: 'local-path' }, undefined, [status(true)])).toBeUndefined();
    expect(pluginUpdate(undefined, { source: 'x', updateAvailable: true }, [])).toBeUndefined();
  });
});
