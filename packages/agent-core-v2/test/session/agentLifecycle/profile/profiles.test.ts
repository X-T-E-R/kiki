import { describe, expect, it } from 'vitest';

import { getAgentProfileContributions } from '#/app/agentProfileCatalog/contribution';
import { isToolActive } from '#/agent/toolPolicy/evaluate';
import '#/session/agentLifecycle/profile/profiles';

function profile(name: string) {
  const found = getAgentProfileContributions().find((p) => p.name === name);
  expect(found, `builtin profile "${name}" is registered`).toBeDefined();
  return found!;
}

describe('builtin agent profiles', () => {
  it('wires thread communication and TaskWait into the default profile without Tower tools', () => {
    const agent = profile('agent');
    expect(agent.tools).toEqual(
      expect.arrayContaining([
        'ThreadList',
        'ThreadRead',
        'ThreadSend',
        'ThreadWait',
        'TaskWait',
      ]),
    );
    expect(agent.tools?.some((tool) => tool.startsWith('Tower'))).toBe(false);
    expect(agent.main).toBe(true);
    expect(agent.subagents).toBeUndefined();
  });

  it.each(['BoardRead', 'BoardWrite'])('enables %s for the default profile unless explicitly disabled', (tool) => {
    const agent = profile('agent');
    expect(isToolActive(agent, tool)).toBe(true);
    expect(isToolActive({ ...agent, disallowedTools: [tool] }, tool)).toBe(false);
  });

  it.each([
    'AgentRun',
    'AgentSwarm',
    'spawn_agent',
    'list_agents',
    'wait_agent',
    'followup_task',
    'interrupt_agent',
    'send_message',
    'CronCreate',
    'CronList',
    'CronDelete',
    'EnterPlanMode',
    'ExitPlanMode',
  ])('keeps the builtin coder from dispatching, scheduling, or planning via %s', (tool) => {
    expect(profile('coder').tools).not.toContain(tool);
  });

  it('keeps the builtin coder able to do the delegated coding work', () => {
    expect(profile('coder').tools).toEqual(
      expect.arrayContaining(['Read', 'Edit', 'Write', 'Bash']),
    );
  });
});
