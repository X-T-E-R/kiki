import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { NamedAgentProfile } from '@kiki/protocol';
import { parseAgentFileText } from '../../../agent-profiles/src/agentFile';
import { subagentToolDefault } from '../../../agent-profiles/src/subagentToolPolicy';
import { isToolActive } from '../../../agent-core-v2/src/agent/toolPolicy/evaluate';
import { defaultRuleToolState, profileToolState } from '../../../../apps/kiki-gui/src/components/settings/subagentTools/toolState';

const tool = { name: 'mcp__fixture__read_file', source: 'mcp' as const };
const options = { editable: true, native: true, serverAllowed: new Set<string>() };

function parsedPolicy(fields: string[]) {
  return parseAgentFileText({
    path: '/fixture/agents/example.md', source: 'user',
    text: ['---', 'name: example', 'description: Fixture', ...fields, '---', 'Fixture prompt.'].join('\n'),
  });
}

function rowFor(fields: string[]) {
  const parsed = parsedPolicy(fields);
  return { parsed, row: profileToolState(tool, {
    tools: parsed.tools ?? null, disallowedTools: parsed.disallowedTools ?? null,
  }, options) };
}

const profile: NamedAgentProfile = {
  name: 'example', source: 'workspace', source_file: '/fixture/workspace-b/agents/example.md',
  workspace_id: 'workspace-b', main: false, disabled: false, routes: [], tools: ['Read'],
};

/** Executes the actual private production chooser, not a mirrored priority policy. */
async function productionChooser(): Promise<(items: readonly NamedAgentProfile[]) => NamedAgentProfile[]> {
  const source = await readFile(new URL('../../../../apps/kiki-gui/src/components/settings/subagentTools/ToolSettingsCard.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('function preferredProfilesByName(');
  const end = source.indexOf('\n/** One line naming', start);
  if (start < 0 || end < 0) throw new Error('Production chooser location changed; update evidence extraction');
  return runInNewContext(`(${stripTypeScriptTypes(source.slice(start, end))})`);
}

describe('subagent tool settings frontend consumption contracts', () => {
  it('keeps parser null, empty and singleton wildcard meanings aligned', () => {
    for (const fields of [[], ['tools: null'], ['tools: []'], ['tools: ["*"]']]) {
      const { parsed, row } = rowFor(fields);
      const allowed = isToolActive(parsed, tool.name, 'mcp');
      expect(row.status === 'blocked').toBe(!allowed);
    }
    const parsed = parsedPolicy(['tools: [Bash]', 'disallowedTools: [Bash]']);
    expect(isToolActive(parsed, 'Bash')).toBe(false);
    expect(profileToolState({ name: 'Bash', source: 'builtin' }, {
      tools: parsed.tools ?? null, disallowedTools: parsed.disallowedTools ?? null,
    }, options).status).toBe('blocked');
  });

  it('shares profile alias matching and reads one subagent category for the merged rows', () => {
    for (const [name, fields, expected] of [
      ['Cron', ['tools: [CronCreate]'], 'allowed'],
      ['Goal', ['tools: [CreateGoal]'], 'allowed'],
      ['Cron', ['tools: [Cron]', 'disallowedTools: [CronCreate, CronList, CronDelete]'], 'blocked'],
      ['Goal', ['tools: [Goal]', 'disallowedTools: [CreateGoal, GetGoal, SetGoalBudget, UpdateGoal]'], 'blocked'],
      ['Cron', ['tools: [Cron]', 'disallowedTools: [CronDelete]'], 'allowed'],
    ] as const) {
      const parsed = parsedPolicy([...fields]);
      expect(isToolActive(parsed, name)).toBe(expected === 'allowed');
      const lists = { tools: parsed.tools ?? null, disallowedTools: parsed.disallowedTools ?? null };
      // The category comes from the one policy table, so this asserts that the
      // GUI row and the engine read the same merged name the same way.
      const access = subagentToolDefault(name, 'builtin');
      const row = profileToolState({ name, source: 'builtin' }, lists, options);
      if (access === 'main-only') {
        expect(row).toEqual({ status: 'fixed', reason: 'main-only', action: null });
        expect(defaultRuleToolState({ name, source: 'builtin' }, new Set([name]))).toEqual({
          status: 'fixed', reason: 'main-only', action: null,
        });
      } else {
        expect(access).toBe('opt-in');
        expect(row.status).toBe(expected === 'allowed' ? 'allowed' : 'blocked');
        // A deny still owns its row: the opt-in control appears once the tool is
        // not denied, and the default rule keeps offering it either way.
        expect(row.action).toBe(expected === 'allowed' ? 'opt-in' : 'editor');
        expect(defaultRuleToolState({ name, source: 'builtin' }, new Set([name])).action).toBe('opt-in');
      }
      // Plugin is a supported non-builtin catalog origin. These assertions cover
      // profile matcher configuration only, not permissions of the builtin executors.
      expect(isToolActive(parsed, name, 'plugin')).toBe(expected === 'allowed');
      const pluginRow = profileToolState({ name, source: 'plugin' }, lists, options);
      expect(pluginRow.status).toBe(expected);
      if (expected === 'blocked') expect(pluginRow.action).toBe('editor');
    }
  });

  it('keeps a lone wildcard out of the names that count as a child opt-in', () => {
    const parsed = parsedPolicy(['tools: ["*"]']);
    const lists = { tools: parsed.tools ?? null, disallowedTools: null };
    // The parser folds a lone '*' to no allowlist, so the row inherits the rule
    // and still offers the opt-in that writes ['*', name].
    expect(profileToolState({ name: 'ThreadRead', source: 'builtin' }, lists, options)).toEqual({
      status: 'blocked', reason: 'opt-in-off', inheritAllows: false, action: 'opt-in',
    });
    expect(profileToolState({ name: 'Read', source: 'builtin' }, lists, options)).toEqual({
      status: 'inherit', inheritAllows: true, reason: 'inherit', action: 'deny',
    });
  });

  it('uses the engine MCP glob allowlist when presenting a concrete registered MCP tool', () => {
    const { parsed, row } = rowFor(['tools: ["mcp__fixture__*"]']);
    expect(isToolActive(parsed, tool.name, 'mcp')).toBe(true);
    expect(row.status).toBe('allowed');
  });

  it('uses the engine MCP glob denylist even when the allowlist names the concrete tool', () => {
    const { parsed, row } = rowFor(['tools: ["mcp__fixture__read_file"]', 'disallowedTools: ["mcp__fixture__*"]']);
    expect(isToolActive(parsed, tool.name, 'mcp')).toBe(false);
    expect(row.status).toBe('blocked');
  });

  it('does not collapse editable same-name files belonging to independent workspaces', async () => {
    const choose = await productionChooser();
    const other = { ...profile, source_file: '/fixture/workspace-a/agents/example.md', workspace_id: 'workspace-a' };
    expect(choose([other, profile])).toHaveLength(2);
  });

  it('saves the same exact object that the filtered subagent picker displays', async () => {
    const choose = await productionChooser();
    const main = { ...profile, source: 'user', source_file: '/fixture/agents/example.md',
      workspace_id: 'workspace-a', main: true, override: true };
    const raw = [main, profile];
    const displayed = choose(raw.filter((item) => !item.main && !item.disabled))[0]!;
    const draftObject = displayed.name;
    const saveTarget = choose(raw).find((item) => item.name === draftObject)!;
    expect(saveTarget.source_file).toBe(displayed.source_file);
    expect(saveTarget.workspace_id).toBe(displayed.workspace_id);
  });
});
