import { describe, expect, it } from 'vitest';

import { getAgentProfileContributions } from '#/app/agentProfileCatalog/contribution';
import '#/session/agentLifecycle/profile/profiles';

function profile(name: string) {
  const found = getAgentProfileContributions().find((p) => p.name === name);
  expect(found, `builtin profile "${name}" is registered`).toBeDefined();
  return found!;
}

describe('builtin agent profiles', () => {
  it('wires thread communication and WaitFor into the default profile without Tower tools', () => {
    const agent = profile('agent');
    expect(agent.tools).toEqual(
      expect.arrayContaining([
        'list_threads',
        'read_thread',
        'send_message_to_thread',
        'wait_threads',
        'WaitFor',
      ]),
    );
    expect(agent.tools?.some((tool) => tool.startsWith('Tower'))).toBe(false);
    expect(agent.main).toBe(true);
    expect(agent.subagents).toBeUndefined();
  });
});
