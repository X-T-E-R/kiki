import { describe, expect, it } from 'vitest';

import { subagentToolsDraftFromConfig, subagentToolsPatch } from './subagentToolsSettings';

describe('subagentToolsSettings', () => {
  it('reads the camel allowedTools projection and treats a missing section as no override', () => {
    expect(subagentToolsDraftFromConfig({ subagent: { allowedTools: ['BoardRead', 'BoardRead', 'BoardWrite'] } })).toEqual({
      serverAllowedTools: ['BoardRead', 'BoardWrite'],
    });
    expect(subagentToolsDraftFromConfig({ subagent: {} })).toEqual({ serverAllowedTools: [] });
    expect(subagentToolsDraftFromConfig({})).toEqual({ serverAllowedTools: [] });
    expect(subagentToolsDraftFromConfig(null)).toEqual({ serverAllowedTools: [] });
  });

  it('updates only allowed_tools without replacing the subagent domain', () => {
    expect(subagentToolsPatch(['BoardRead'])).toEqual({
      subagent: { allowed_tools: ['BoardRead'] },
    });
  });

  it('an empty list restores the server default and normalizes duplicates', () => {
    const patch = subagentToolsPatch([]);
    expect(patch.subagent).toEqual({ allowed_tools: [] });
    expect(subagentToolsPatch(['BoardRead', 'BoardRead']).subagent).toEqual({ allowed_tools: ['BoardRead'] });
  });
});
