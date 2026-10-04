/**
 * Contracts for the rail's pure tool grouping, search and state previews.
 */

import { describe, expect, it } from 'vitest';

import {
  extensionOwner,
  matchToolGroups,
  toolGroupPreview,
  toolGroups,
  toolShortName,
  toolStateBucket,
  type ToolGroup,
} from './toolGroups';
import type { AgentToolCapability, CapabilityState } from './types';

function tool(name: string, overrides: Partial<AgentToolCapability> = {}): AgentToolCapability {
  return { name, category: 'edit', state: 'enabled', ...overrides };
}

const titleOf = (group: ToolGroup) => `Title for ${group.token}`;
const states: readonly CapabilityState[] = ['enabled', 'approval-required', 'disabled', 'disconnected', 'unknown'];

describe('extensionOwner and toolShortName', () => {
  it('parses both extension prefixes without treating their tokens as config ids', () => {
    expect(extensionOwner(tool('mcp__github__search'))).toEqual({ kind: 'mcp', owner: 'github', ownerReported: true });
    expect(extensionOwner(tool('plugin__example_plugin__search'))).toEqual({ kind: 'plugin', owner: 'example_plugin', ownerReported: true });
    expect(toolShortName('mcp__github__search_issues')).toBe('search_issues');
    expect(toolShortName('plugin__example_plugin__search__nested')).toBe('search__nested');
    expect(toolShortName('plain_name')).toBe('plain_name');
    expect(toolShortName('mcp__broken')).toBe('mcp__broken');
  });

  it('uses an unknown owner only for extension sources without a parseable owner', () => {
    expect(extensionOwner(tool('mcp__broken', { source: 'mcp', category: 'not-an-owner' })))
      .toEqual({ kind: 'mcp', owner: 'unknown', ownerReported: false });
    expect(extensionOwner(tool('plain', { source: 'plugin' })))
      .toEqual({ kind: 'plugin', owner: 'unknown', ownerReported: false });
    expect(extensionOwner(tool('plain', { source: 'builtin' }))).toBeUndefined();
  });

  it('lets a name prefix win over a conflicting source', () => {
    expect(extensionOwner(tool('mcp__server__tool', { source: 'builtin' })))
      .toEqual({ kind: 'mcp', owner: 'server', ownerReported: true });
    expect(extensionOwner(tool('plugin__example__tool', { source: 'mcp' })))
      .toEqual({ kind: 'plugin', owner: 'example', ownerReported: true });
  });
});

describe('toolGroups', () => {
  it('counts all five states and treats approval-required as on', () => {
    const members = states.map((state) => tool(state, { state }));
    const groups = toolGroups(members);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.counts).toEqual({
      on: 2, total: 5, enabled: 1, approvalRequired: 1, disabled: 1, disconnected: 1, unknown: 1,
    });
    expect(groups[0]!.tools).toEqual(members);
    expect(groups[0]!.tools[2]).toBe(members[2]);
  });

  it('keeps fully off groups and disabled members instead of filtering them out', () => {
    const members = [tool('Write', { state: 'disabled' }), tool('Edit', { state: 'disabled' })];
    const groups = toolGroups(members);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.tools).toEqual(members);
    expect(groups[0]!.counts).toMatchObject({ on: 0, total: 2, disabled: 2 });
  });

  it('separates equal short names belonging to different owners and kinds', () => {
    const groups = toolGroups([
      tool('mcp__github__search'),
      tool('mcp__linear__search'),
      tool('plugin__github__search'),
    ]);
    expect(groups.map((group) => group.key)).toEqual(['mcp:github', 'mcp:linear', 'plugin:github']);
    expect(groups.map((group) => group.token)).toEqual(['github', 'linear', 'github']);
    expect(groups.every((group) => group.extension && group.ownerReported)).toBe(true);
    expect(groups.map((group) => toolShortName(group.tools[0]!.name))).toEqual(['search', 'search', 'search']);
  });

  it('keeps raw known and unknown categories and uses other only for an empty category', () => {
    const groups = toolGroups([
      tool('Read', { category: 'os/backends' }),
      tool('Lookup', { category: 'unfamiliar/domain', source: 'builtin' }),
      tool('Misc', { category: '', source: '' }),
    ]);
    expect(groups.map((group) => [group.kind, group.token, group.key])).toEqual([
      ['builtin', 'os/backends', 'builtin:os/backends'],
      ['builtin', 'unfamiliar/domain', 'builtin:unfamiliar/domain'],
      ['builtin', 'other', 'builtin:other'],
    ]);
    expect(groups.every((group) => !group.extension && group.ownerReported)).toBe(true);
  });

  it('uses stable machine keys and first-appearance order regardless of state counts', () => {
    const members = [
      tool('Z', { category: 'todo', state: 'disabled' }),
      tool('mcp__server__search', { state: 'enabled' }),
      tool('A', { category: 'edit', state: 'approval-required' }),
      tool('B', { category: 'todo', state: 'unknown' }),
    ];
    const before = toolGroups(members);
    const after = toolGroups(members.map((member) => ({ ...member, state: member.state === 'enabled' ? 'disabled' : 'enabled' })));
    expect(before.map((group) => group.key)).toEqual(['builtin:todo', 'mcp:server', 'builtin:edit']);
    expect(after.map((group) => group.key)).toEqual(before.map((group) => group.key));
    expect(before[0]!.tools.map((member) => member.name)).toEqual(['Z', 'B']);
    expect(after[0]!.counts.on).toBe(2);
    expect(before[0]!.counts.on).toBe(0);
    const localized = matchToolGroups(before, '任务', () => '任务工具');
    expect(localized.map((match) => match.group.key)).toEqual(['builtin:todo', 'mcp:server', 'builtin:edit']);
  });

  it('groups missing extension owners without inferring them from name or category', () => {
    const members = [
      tool('mcp__broken', { source: 'mcp', category: 'github' }),
      tool('plain_name', { source: 'mcp', category: 'linear' }),
      tool('plain_plugin', { source: 'plugin' }),
    ];
    const groups = toolGroups(members);
    expect(groups.map((group) => [group.key, group.token, group.ownerReported, group.extension])).toEqual([
      ['mcp:unknown', 'unknown', false, true],
      ['plugin:unknown', 'unknown', false, true],
    ]);
    expect(groups[0]!.tools).toEqual(members.slice(0, 2));
  });

  it('groups user tools together and retains future source strings verbatim', () => {
    const groups = toolGroups([
      tool('CustomA', { source: 'user', category: 'edit' }),
      tool('FutureA', { source: 'something-new' }),
      tool('CustomB', { source: 'user', category: 'todo' }),
      tool('FutureB', { source: 'something-new', category: 'todo' }),
    ]);
    expect(groups.map((group) => [group.key, group.kind, group.token, group.extension, group.ownerReported])).toEqual([
      ['user:custom', 'user', 'custom', false, true],
      ['source:something-new', 'source', 'something-new', false, true],
    ]);
    expect(groups.map((group) => group.tools.map((member) => member.name))).toEqual([
      ['CustomA', 'CustomB'], ['FutureA', 'FutureB'],
    ]);
  });

  it('lets a parseable wire prefix override source during grouping', () => {
    const [group] = toolGroups([tool('mcp__server__tool', { source: 'builtin' })]);
    expect(group).toMatchObject({ key: 'mcp:server', kind: 'mcp', token: 'server', ownerReported: true, extension: true });
  });

  it('does not mutate frozen input arrays or member objects', () => {
    const members = Object.freeze([
      Object.freeze(tool('Second', { state: 'disabled' })),
      Object.freeze(tool('First')),
    ]);
    const groups = toolGroups(members);
    matchToolGroups(groups, 'First', titleOf);
    toolGroupPreview(groups[0]!);
    expect(members.map((member) => member.name)).toEqual(['Second', 'First']);
    expect(members.map((member) => member.state)).toEqual(['disabled', 'enabled']);
    expect(groups[0]!.tools).not.toBe(members);
    expect(toolGroups([])).toEqual([]);
  });
});

describe('matchToolGroups', () => {
  const members = [
    tool('mcp__example__active'),
    tool('mcp__example__off', { state: 'disabled', description: 'Review archived tickets' }),
    tool('mcp__example__lost', { state: 'disconnected', description: 'Offline service' }),
    tool('mcp__example__pending', { state: 'unknown', description: 'Awaiting discovery' }),
  ];
  const groups = toolGroups(members);

  it('finds disabled, disconnected and unknown members by case-insensitive descriptions', () => {
    for (const [query, index] of [[' ARCHIVED ', 1], ['OFFLINE', 2], ['discovery', 3]] as const) {
      const matches = matchToolGroups(groups, query, titleOf);
      expect(matches).toHaveLength(1);
      expect(matches[0]!.matched).toEqual([members[index]]);
      expect(matches[0]!.groupHit).toBe(false);
    }
  });

  it('matches short and full names', () => {
    expect(matchToolGroups(groups, 'PENDING', titleOf)[0]!.matched).toEqual([members[3]]);
    expect(matchToolGroups(groups, 'mcp__example__lost', titleOf)[0]!.matched).toEqual([members[2]]);
  });

  it('returns the whole group for title-only and owner-only matches', () => {
    for (const query of ['localized heading', 'EXAMPLE']) {
      const [match] = matchToolGroups(groups, query, () => 'Localized heading');
      expect(match!.groupHit).toBe(true);
      expect(match!.matched).toBe(groups[0]!.tools);
    }
  });

  it('retains full-group x/y counts when a query narrows matched members', () => {
    const [match] = matchToolGroups(groups, 'archived', titleOf);
    expect(match!.matched).toHaveLength(1);
    expect(match!.group).toBe(groups[0]);
    expect(match!.group.counts).toMatchObject({ on: 1, total: 4, disabled: 1, disconnected: 1, unknown: 1 });
    expect(match!.group.tools).toHaveLength(4);
  });

  it('returns no groups for no match and every group with original membership for empty queries', () => {
    const all = toolGroups([...members, tool('Read', { category: 'os/backends' })]);
    expect(matchToolGroups(all, 'no-such-tool', titleOf)).toEqual([]);
    for (const query of ['', ' \t\n ']) {
      const matches = matchToolGroups(all, query, titleOf);
      expect(matches.map((match) => match.group)).toEqual(all);
      for (const match of matches) {
        expect(match.matched).toBe(match.group.tools);
        expect(match.groupHit).toBe(true);
      }
    }
  });
});

describe('toolGroupPreview', () => {
  it('caps each list independently, shortens extension names and counts all unknowns', () => {
    const members = Array.from({ length: 7 }, (_, index) => states.map((state) =>
      tool(`mcp__example__${state}_${index}`, { state }),
    )).flat();
    const [group] = toolGroups(members);
    expect(toolGroupPreview(group!, 2)).toEqual({
      onNames: ['enabled_0', 'approval-required_0'],
      offNames: ['disabled_0', 'disabled_1'],
      disconnectedNames: ['disconnected_0', 'disconnected_1'],
      unknownCount: 7,
    });
    const preview = toolGroupPreview(group!);
    expect(preview.onNames).toEqual(['enabled_0', 'approval-required_0', 'enabled_1', 'approval-required_1', 'enabled_2']);
    expect(preview.offNames).toEqual(['disabled_0', 'disabled_1', 'disabled_2', 'disabled_3', 'disabled_4']);
    expect(preview.disconnectedNames).toEqual(['disconnected_0', 'disconnected_1', 'disconnected_2', 'disconnected_3', 'disconnected_4']);
    expect(preview.unknownCount).toBe(7);
    expect(toolGroupPreview(group!, 0)).toEqual({ onNames: [], offNames: [], disconnectedNames: [], unknownCount: 7 });
  });

  it('keeps ordinary tool names and empty buckets unchanged', () => {
    const [group] = toolGroups([tool('ordinary__tool'), tool('Another', { state: 'disabled' })]);
    expect(toolGroupPreview(group!)).toEqual({
      onNames: ['ordinary__tool'], offNames: ['Another'], disconnectedNames: [], unknownCount: 0,
    });
    const [plugin] = toolGroups([tool('plugin__example_plugin__lookup')]);
    expect(toolGroupPreview(plugin!).onNames).toEqual(['lookup']);
  });
});

describe('toolStateBucket', () => {
  it('maps all five states without conflating disabled, disconnected or unknown', () => {
    expect(states.map(toolStateBucket)).toEqual(['on', 'on', 'off', 'disconnected', 'unknown']);
  });
});
