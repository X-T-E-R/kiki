import { describe, expect, it } from 'vitest';

import { isToolActive } from '#/agent/toolPolicy/evaluate';
import { ShippedAgentProfileSourceService } from '#/app/shippedAgentProfiles/shippedAgentProfileSourceService';

function source() {
  return new ShippedAgentProfileSourceService();
}

describe('shipped agent profiles', () => {
  it('enables ThreadCreate by default while allowing an independent tool disable', () => {
    const agent = source().get('agent')!;
    expect(agent.tools).toEqual(expect.arrayContaining([
      'ThreadCreate', 'ThreadList', 'ThreadRead', 'ThreadSend', 'ThreadWait', 'TaskWait',
    ]));
    expect(isToolActive(agent, 'ThreadCreate')).toBe(true);
    expect(isToolActive({ ...agent, disallowedTools: ['ThreadCreate'] }, 'ThreadCreate')).toBe(false);
    expect(isToolActive({ ...agent, disallowedTools: ['ThreadCreate'] }, 'ThreadList')).toBe(true);
    expect(agent.main).toBe(true);
    expect(agent.subagents).toBeUndefined();
  });

  it.each(['BoardRead', 'BoardWrite'])('enables %s for the default profile unless explicitly disabled', (tool) => {
    const agent = source().get('agent')!;
    expect(isToolActive(agent, tool)).toBe(true);
    expect(isToolActive({ ...agent, disallowedTools: [tool] }, tool)).toBe(false);
  });

  it('keeps the shipped general profile a strict leaf with editing tools', () => {
    const general = source().get('general')!;
    expect(general.tools).toEqual(
      expect.arrayContaining(['Read', 'Edit', 'Write', 'Bash', 'Skill']),
    );
    expect(general.tools).not.toContain('AgentRun');
    expect(general.tools).not.toContain('TaskWait');
    expect(general.subagents).toEqual([]);
    expect(general.main).toBeUndefined();
  });

  it('renders shipped profiles against the terminal base prompt', () => {
    const rendered = source().get('explore')!.renderSystemPrompt({});
    expect(rendered.text).toContain('read-only evidence explorer');
    expect(rendered.text).toContain('You are Kiki');
  });
});
