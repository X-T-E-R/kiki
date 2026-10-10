import { describe, expect, it } from 'vitest';

import {
  findInactiveToolPatterns,
  isToolActive,
  isToolActiveComposed,
  literalToolNames,
} from '#/agent/toolPolicy/evaluate';

describe('research-readonly ceiling', () => {
  it('intersects builtin research tools with every existing policy layer', () => {
    const profile = { executionRestriction: 'research-readonly' as const };
    expect(isToolActive(profile, 'Read')).toBe(true);
    expect(isToolActive(profile, 'Read', 'user')).toBe(false);
    expect(isToolActive(profile, 'Read', 'mcp')).toBe(false);
    expect(isToolActive({ ...profile, tools: ['Read', 'Bash'] }, 'Bash')).toBe(false);
    expect(isToolActive({ ...profile, tools: ['Grep'] }, 'Read')).toBe(false);
    expect(isToolActive({ ...profile, toolAllowPolicies: [['Grep']] }, 'Read')).toBe(false);
    expect(isToolActiveComposed({ profile, global: { disabled: ['Read'] } }, 'Read')).toBe(false);
    expect(isToolActiveComposed({ profile, workspaceDisabledTools: ['Read'] }, 'Read')).toBe(false);
    expect(isToolActiveComposed({ profile, sessionDisabledTools: ['Read'] }, 'Read')).toBe(false);
    expect(isToolActive({ tools: undefined }, 'Bash')).toBe(true);
  });
});

describe('findInactiveToolPatterns', () => {
  const known = new Set(['Read', 'Bash', 'Skill']);
  const isKnown = (name: string): boolean => known.has(name);

  it('passes literal known tool names and MCP globs', () => {
    expect(
      findInactiveToolPatterns(['Read', 'Bash', 'mcp__github__*', 'mcp__*'], isKnown),
    ).toEqual([]);
  });

  it('flags a name that matches no known tool (typo, wrong case)', () => {
    expect(findInactiveToolPatterns(['Bashh', 'read'], isKnown)).toEqual([
      { pattern: 'Bashh', kind: 'unknown-tool' },
      { pattern: 'read', kind: 'unknown-tool' },
    ]);
  });

  it('accepts the universal allow pattern while preserving narrower policies and explicit denials', () => {
    expect(findInactiveToolPatterns(['*'], isKnown)).toEqual([
      { pattern: '*', kind: 'wildcard-not-mcp' },
    ]);
    expect(isToolActive({ tools: ['*'] }, 'Read')).toBe(true);
    expect(isToolActive({ tools: ['*'] }, 'mcp__github__create_pr', 'mcp')).toBe(true);
    expect(isToolActive({ tools: ['*'], toolAllowPolicies: [['Bash']] }, 'Read')).toBe(false);
    expect(isToolActive({ tools: ['*'], disallowedTools: ['Read'] }, 'Read')).toBe(false);
    expect(isToolActive({ disallowedTools: ['*'] }, 'Read')).toBe(true);
  });

  it('flags wildcards without the mcp__ prefix', () => {
    expect(findInactiveToolPatterns(['Bash*'])).toEqual([
      { pattern: 'Bash*', kind: 'wildcard-not-mcp' },
    ]);
  });

  it('flags an mcp__ literal that is not a full server__tool name', () => {
    expect(findInactiveToolPatterns(['mcp__github', 'mcp__'])).toEqual([
      { pattern: 'mcp__github', kind: 'incomplete-mcp-name' },
      { pattern: 'mcp__', kind: 'incomplete-mcp-name' },
    ]);
  });

  it('passes a full mcp__server__tool literal', () => {
    expect(findInactiveToolPatterns(['mcp__github__create_issue'], isKnown)).toEqual([]);
  });

  it('skips the unknown-tool check when no vocabulary is provided', () => {
    expect(findInactiveToolPatterns(['AnythingGoes'])).toEqual([]);
  });
});

describe('literalToolNames', () => {
  it('keeps only literal non-MCP names', () => {
    expect(
      literalToolNames(['Read', 'mcp__*', 'Bash*', 'mcp__github__create_issue']),
    ).toEqual(['Read']);
  });
});

describe('isToolActiveComposed workspace veto', () => {
  it('lets the workspace layer veto a tool every other layer allows', () => {
    expect(
      isToolActiveComposed(
        {
          workspaceDisabledTools: ['Bash'],
          profile: { tools: ['Bash', 'Read'] },
          global: { enabled: ['Bash', 'Read'] },
          sessionDisabledTools: [],
        },
        'Bash',
      ),
    ).toBe(false);
    expect(
      isToolActiveComposed(
        {
          workspaceDisabledTools: ['Bash'],
          profile: { tools: ['Bash', 'Read'] },
        },
        'Read',
      ),
    ).toBe(true);
  });

  it('applies the workspace veto to MCP tools by glob', () => {
    expect(
      isToolActiveComposed(
        { workspaceDisabledTools: ['mcp__blocked__*'], profile: {} },
        'mcp__blocked__write',
        'mcp',
      ),
    ).toBe(false);
  });

  it('stays inactive when any classic layer also denies', () => {
    expect(
      isToolActiveComposed(
        {
          workspaceDisabledTools: ['Bash'],
          profile: {},
          sessionDisabledTools: ['Bash'],
        },
        'Bash',
      ),
    ).toBe(false);
  });
});

describe('merged-tool legacy names', () => {
  it('preserves old allowlists and action-specific denials', () => {
    expect(isToolActive({ tools: ['CronCreate'] }, 'Cron')).toBe(true);
    expect(isToolActive({ tools: ['CronCreate'] }, 'CronCreate')).toBe(true);
    expect(isToolActive({ tools: ['CronCreate'] }, 'CronDelete')).toBe(false);
    expect(isToolActive({ tools: ['Cron'] }, 'CronDelete')).toBe(true);
    expect(isToolActive({ tools: ['Cron'], disallowedTools: ['CronDelete'] }, 'CronDelete')).toBe(false);
    expect(isToolActive({ tools: ['Cron'], disallowedTools: ['CronDelete'] }, 'Cron')).toBe(true);
    expect(isToolActive({ tools: ['CreateGoal'] }, 'Goal')).toBe(true);
    expect(isToolActive({ tools: ['Goal'], disallowedTools: ['SetGoalBudget'] }, 'SetGoalBudget')).toBe(false);
  });

  it('preserves old names across composed profile and workspace policy', () => {
    expect(isToolActiveComposed({ profile: { tools: ['CronCreate'] } }, 'Cron')).toBe(true);
    expect(isToolActiveComposed({ profile: { tools: ['Cron'] }, workspaceDisabledTools: ['CronDelete'] }, 'CronDelete')).toBe(false);
  });
});

describe('disabled tool groups', () => {
  it('denies every builtin tool that belongs to a disabled group', () => {
    const policy = { disabledToolGroups: ['fsRead' as const] };
    expect(isToolActive(policy, 'Read')).toBe(false);
    expect(isToolActive(policy, 'Grep')).toBe(false);
    expect(isToolActive(policy, 'Bash')).toBe(true);
  });

  it('keeps unknown and MCP tools untouched by group disables', () => {
    const policy = { disabledToolGroups: ['fsRead' as const, 'web' as const] };
    expect(isToolActive(policy, 'mcp__github__create_issue', 'mcp')).toBe(true);
    expect(isToolActive(policy, 'SomeUserTool', 'user')).toBe(true);
  });

  it('lets an explicit tools entry re-allow a tool from a disabled group', () => {
    const policy = { tools: ['Bash', 'Read'], disabledToolGroups: ['shell' as const, 'fsRead' as const] };
    expect(isToolActive(policy, 'Bash')).toBe(true);
    expect(isToolActive(policy, 'Read')).toBe(true);
  });

  it('still applies the group deny when no explicit tools list exists', () => {
    const policy = { disabledToolGroups: ['shell' as const] };
    expect(isToolActive(policy, 'Bash')).toBe(false);
  });

  it('keeps explicit disallowedTools ahead of the explicit-tools override', () => {
    const policy = {
      tools: ['Bash'],
      disallowedTools: ['Bash'],
      disabledToolGroups: ['shell' as const],
    };
    expect(isToolActive(policy, 'Bash')).toBe(false);
  });

  it('applies group disables inside composed evaluation', () => {
    expect(
      isToolActiveComposed(
        { profile: { disabledToolGroups: ['shell' as const] } },
        'Bash',
      ),
    ).toBe(false);
    expect(
      isToolActiveComposed(
        { profile: { disabledToolGroups: ['shell' as const] }, global: { enabled: ['Bash'] } },
        'Bash',
      ),
    ).toBe(false);
  });
});

describe('contributed subagent opt-in default', () => {
  const name = 'mcp__computer__click';
  const base = { profile: {}, subagent: {}, subagentDefault: 'opt-in' as const };
  it('uses explicit global MCP enablement without dropping any deny layer', () => {
    expect(isToolActiveComposed(base, name, 'mcp')).toBe(false);
    expect(isToolActiveComposed({ ...base, global: { enabled: ['*'] } }, name, 'mcp')).toBe(false);
    const enabled = { ...base, global: { enabled: ['mcp__computer__*'] } };
    expect(isToolActiveComposed(enabled, name, 'mcp')).toBe(true);
    expect(isToolActiveComposed({ ...enabled, global: { ...enabled.global, disabled: ['mcp__computer__*'] } }, name, 'mcp')).toBe(false);
    expect(isToolActiveComposed({ ...enabled, workspaceDisabledTools: [name] }, name, 'mcp')).toBe(false);
    expect(isToolActiveComposed({ ...enabled, profile: { disallowedTools: [name] } }, name, 'mcp')).toBe(false);
    expect(isToolActiveComposed({ ...enabled, sessionDisabledTools: [name] }, name, 'mcp')).toBe(false);
    expect(isToolActiveComposed({ ...enabled, profile: { tools: [] } }, name, 'mcp')).toBe(false);
  });
});
