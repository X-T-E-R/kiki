import { describe, expect, it } from 'vitest';
import {
  isSubagentToolAllowed,
  subagentToolDefault,
  SUBAGENT_MAIN_ONLY_TOOL_NAMES,
  SUBAGENT_OPT_IN_TOOL_NAMES,
} from '#/subagentToolPolicy';

describe('subagent tool defaults', () => {
  it.each(SUBAGENT_OPT_IN_TOOL_NAMES)('requires an exact opt-in for %s', (name) => {
    expect(subagentToolDefault(name)).toBe('opt-in');
    expect(isSubagentToolAllowed({}, name)).toBe(false);
    expect(isSubagentToolAllowed({ explicitProfileTools: ['*'] }, name)).toBe(false);
    expect(isSubagentToolAllowed({ allowedTools: ['Board*'] }, name)).toBe(false);
    expect(isSubagentToolAllowed({ explicitProfileTools: [name] }, name)).toBe(true);
    expect(isSubagentToolAllowed({ allowedTools: [name] }, name)).toBe(true);
  });

  it.each(SUBAGENT_MAIN_ONLY_TOOL_NAMES)('cannot opt a child into %s', (name) => {
    expect(subagentToolDefault(name)).toBe('main-only');
    expect(isSubagentToolAllowed({ allowedTools: [name], explicitProfileTools: [name] }, name)).toBe(false);
  });

  it('preserves MCP, user and unknown extension defaults', () => {
    expect(isSubagentToolAllowed({}, 'mcp__example__write', 'mcp')).toBe(true);
    expect(isSubagentToolAllowed({}, 'CustomWrite', 'user')).toBe(true);
    expect(isSubagentToolAllowed({}, 'ExtensionWrite')).toBe(true);
    expect(isSubagentToolAllowed({}, 'BoardWrite', 'user')).toBe(true);
    expect(isSubagentToolAllowed({}, 'TodoList')).toBe(true);
    expect(isSubagentToolAllowed({}, 'AgentNotify')).toBe(true);
  });
});
