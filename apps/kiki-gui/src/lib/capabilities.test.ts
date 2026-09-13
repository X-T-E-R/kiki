import { describe, expect, it } from 'vitest';

import type { McpServer, SkillDescriptor, Workspace } from '@kiki/protocol';

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
