import { describe, expect, it } from 'vitest';
import { isToolActive as engineToolActive } from '../../agent-core-v2/src/agent/toolPolicy/evaluate';
import { parseAgentFileText } from '../src/agentFile';
import { isToolActive, type ToolActivationPolicy, type ToolSource } from '../src/toolPolicy';
import * as sharedAliases from '../src/toolAliases';
import * as legacyEntry from '../../agent-core-v2/src/agent/toolPolicy/toolAliases';

const cases: [ToolActivationPolicy, string, boolean][] = [
  [{ tools: ['CronCreate'] }, 'Cron', true],
  [{ tools: ['CronCreate'] }, 'CronCreate', true],
  [{ tools: ['CronCreate'] }, 'CronDelete', false],
  [{ tools: ['Cron'] }, 'CronDelete', true],
  [{ tools: ['Cron'], disallowedTools: ['CronDelete'] }, 'CronDelete', false],
  [{ tools: ['Cron'], disallowedTools: ['CronDelete'] }, 'Cron', true],
  [{ tools: ['Cron'], disallowedTools: ['CronCreate', 'CronList', 'CronDelete'] }, 'Cron', false],
  [{ disallowedTools: ['Cron'] }, 'CronCreate', false],
  [{ tools: ['CreateGoal'] }, 'Goal', true],
  [{ tools: ['Goal'] }, 'UpdateGoal', true],
  [{ tools: ['Goal'], disallowedTools: ['SetGoalBudget'] }, 'SetGoalBudget', false],
  [{ tools: ['Goal'], disallowedTools: ['SetGoalBudget'] }, 'Goal', true],
  [{ tools: ['Goal'], disallowedTools: ['CreateGoal', 'GetGoal', 'SetGoalBudget', 'UpdateGoal'] }, 'Goal', false],
  [{ disallowedTools: ['Goal'] }, 'UpdateGoal', false],
  [{ tools: ['CronCreate'], toolAllowPolicies: [['CronList']] }, 'Cron', true],
  [{ tools: ['CronCreate'], toolAllowPolicies: [['CronList']] }, 'CronCreate', false],
];

describe('shared profile tool matching', () => {
  it('preserves the old core alias entry as the same shared implementation', () => {
    expect(legacyEntry.canonicalToolName).toBe(sharedAliases.canonicalToolName);
    expect(legacyEntry.legacyToolNames).toBe(sharedAliases.legacyToolNames);
    expect(legacyEntry.isLegacyToolName).toBe(sharedAliases.isLegacyToolName);
    expect(sharedAliases.canonicalToolName('CronCreate')).toBe('Cron');
    expect(sharedAliases.legacyToolNames('Goal')).toEqual(['CreateGoal', 'GetGoal', 'SetGoalBudget', 'UpdateGoal']);
  });

  it.each(cases)('keeps established engine alias semantics for %j / %s', (policy, name, expected) => {
    expect(engineToolActive(policy, name)).toBe(expected);
    expect(isToolActive(policy, name)).toBe(expected);
  });

  it('keeps MCP and plugin globs alongside exact builtin/plugin names', () => {
    const inputs: [ToolActivationPolicy, string, ToolSource, boolean][] = [
      [{ tools: ['mcp__fixture__*'] }, 'mcp__fixture__read', 'mcp', true],
      [{ tools: ['mcp__fixture__*'], disallowedTools: ['mcp__*__read'] }, 'mcp__fixture__read', 'mcp', false],
      [{ tools: ['plugin__*'] }, 'plugin__fixture__read', 'plugin', true],
      [{ tools: ['plugin__fixture__*'] }, 'plugin__fixture__read', 'plugin', true],
      [{ tools: ['plugin__fixture__*'] }, 'plugin__other__read', 'plugin', false],
      [{ tools: ['plugin__fixture__*'], disallowedTools: ['plugin__fixture__*'] }, 'plugin__fixture__read', 'plugin', false],
      [{ tools: ['plugin__fixture__*'], disallowedTools: ['plugin__other__*'] }, 'plugin__fixture__read', 'plugin', true],
      [{ tools: ['Bash*'] }, 'Bash', 'builtin', false],
      [{ disallowedTools: ['*'] }, 'Bash', 'builtin', true],
      [{ tools: ['PluginTool'], disallowedTools: ['Plugin*'] }, 'PluginTool', 'plugin', true],
      [{ tools: [] }, 'Read', 'builtin', false],
      [{ disallowedTools: [] }, 'Read', 'builtin', true],
    ];
    for (const [policy, name, source, expected] of inputs) {
      expect(engineToolActive(policy, name, source)).toBe(expected);
      expect(isToolActive(policy, name, source)).toBe(expected);
    }
  });

  it('allows only the explicit browser operation namespace and preserves exact and namespace denies', () => {
    const name = 'browser__codex_browser_js';
    for (const active of [isToolActive, engineToolActive]) {
      expect(active({ tools: ['browser__*'] }, name)).toBe(true);
      expect(active({ tools: ['BrowserConnections', 'BrowserTabs'] }, name)).toBe(false);
      expect(active({ tools: [] }, name)).toBe(false);
      expect(active({ tools: ['browser__*'], disallowedTools: [name] }, name)).toBe(false);
      expect(active({ tools: ['*'], disallowedTools: ['browser__*'] }, name)).toBe(false);
      expect(active({ tools: ['browser__*'], toolAllowPolicies: [['Read']] }, name)).toBe(false);
      for (const invalid of ['browser__Read', 'browser__codex_', 'browser__codex_test-X', 'other__codex_browser_js', 'Bash']) {
        expect(active({ tools: ['browser__*'] }, invalid)).toBe(false);
      }
      expect(active({ tools: ['browser__*'] }, name, 'plugin')).toBe(false);
    }
  });

  it('grants browser__ego_run with Bash and keeps browser__* from allowing it', () => {
    const name = 'browser__ego_run';
    for (const active of [isToolActive, engineToolActive]) {
      expect(active({ tools: ['browser__*'] }, name)).toBe(false);
      expect(active({ tools: ['*'], disallowedTools: ['browser__*'] }, name)).toBe(false);
      expect(active({ tools: ['Bash', 'BrowserTabs'] }, name)).toBe(true);
      expect(active({ tools: ['BrowserConnections', 'BrowserTabs', 'browser__*'] }, name)).toBe(false);
      expect(active({ tools: [name] }, name)).toBe(true);
      expect(active({ tools: ['Bash'], disallowedTools: [name] }, name)).toBe(false);
      expect(active({ tools: ['Bash'], disallowedTools: ['browser__*'] }, name)).toBe(false);
      expect(active({ tools: ['browser__*'] }, 'browser__codex_browser_js')).toBe(true);
    }
  });

  it('does not let an empty allow list or a star bypass a Bash deny for browser__ego_run', () => {
    const name = 'browser__ego_run';
    for (const active of [isToolActive, engineToolActive]) {
      expect(active({}, name)).toBe(true);
      expect(active({ tools: ['*'] }, name)).toBe(true);
      expect(active({ disallowedTools: ['Bash'] }, name)).toBe(false);
      expect(active({ tools: ['*'], disallowedTools: ['Bash'] }, name)).toBe(false);
      expect(active({ tools: [name], disallowedTools: ['Bash'] }, name)).toBe(true);
      expect(active({ tools: [name], disallowedTools: ['browser__*'] }, name)).toBe(false);
    }
  });

  it('uses parser normalization for null, empty and singleton wildcard without treating arbitrary raw stars as a glob', () => {
    for (const [field, expected] of [['tools: null', true], ['tools: []', false], ['tools: ["*"]', true]] as const) {
      const parsed = parseAgentFileText({ path: '/fixture/example.md', source: 'user',
        text: ['---', 'name: example', 'description: Fixture', field, '---', 'Prompt.'].join('\n') });
      expect(isToolActive(parsed, 'Read')).toBe(expected);
      expect(engineToolActive(parsed, 'Read')).toBe(expected);
    }
    expect(isToolActive({ tools: ['*'] }, 'Read')).toBe(true);
    const parsed = parseAgentFileText({ path: '/fixture/mixed.md', source: 'user', text: '---\nname: mixed\ndescription: Mixed\ntools: ["*", ThreadRead]\n---\n${skills_section}' });
    expect(parsed.tools).toEqual(['*', 'ThreadRead']);
    expect(isToolActive(parsed, 'Read')).toBe(true);
    expect(engineToolActive(parsed, 'Read')).toBe(true);
    expect(isToolActive({ ...parsed, disallowedTools: ['Read'] }, 'Read')).toBe(false);
    expect(isToolActive({ tools: ['*', 'ThreadRead'], toolAllowPolicies: [['Read']] }, 'Write')).toBe(false);
    expect(isToolActive({ tools: ['*', 'ThreadRead'] }, 'mcp__fixture__read', 'mcp')).toBe(true);
  });
});
