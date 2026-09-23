import { describe, expect, it } from 'vitest';

import { subagentToolsDraftFromConfig, subagentToolsPatch, subagentDispatchPoliciesDraftFromConfig, subagentDispatchPoliciesPatch, DEFAULT_MAIN_DISPATCH_POLICY, DEFAULT_SUBAGENT_DISPATCH_POLICY } from './subagentToolsSettings';

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

describe('dispatch policy defaults', () => {
  it('defaults the main agents to advisory and declared subagents to strict', () => {
    expect(DEFAULT_MAIN_DISPATCH_POLICY).toBe('advisory');
    expect(DEFAULT_SUBAGENT_DISPATCH_POLICY).toBe('strict');
    expect(subagentDispatchPoliciesDraftFromConfig(null)).toEqual({
      mainDispatchPolicy: 'advisory',
      subagentDispatchPolicy: 'strict',
    });
    expect(subagentDispatchPoliciesDraftFromConfig({})).toEqual({
      mainDispatchPolicy: 'advisory',
      subagentDispatchPolicy: 'strict',
    });
  });

  it('reads the camel projection keys and falls back on malformed values', () => {
    expect(subagentDispatchPoliciesDraftFromConfig({
      subagent: { mainDispatchPolicy: 'strict', subagentDispatchPolicy: 'advisory' },
    })).toEqual({ mainDispatchPolicy: 'strict', subagentDispatchPolicy: 'advisory' });
    expect(subagentDispatchPoliciesDraftFromConfig({
      subagent: { mainDispatchPolicy: 'nonsense', subagentDispatchPolicy: 42 },
    })).toEqual({ mainDispatchPolicy: 'advisory', subagentDispatchPolicy: 'strict' });
  });

  it('patches only the changed keys as snake_case, preserving the other domain', () => {
    expect(subagentDispatchPoliciesPatch(
      { mainDispatchPolicy: 'strict', subagentDispatchPolicy: 'strict' },
      { mainDispatchPolicy: 'advisory', subagentDispatchPolicy: 'strict' },
    )).toEqual({ subagent: { main_dispatch_policy: 'strict', subagent_dispatch_policy: undefined } });
    expect(subagentDispatchPoliciesPatch(
      { mainDispatchPolicy: 'advisory', subagentDispatchPolicy: 'advisory' },
      { mainDispatchPolicy: 'advisory', subagentDispatchPolicy: 'strict' },
    )).toEqual({ subagent: { main_dispatch_policy: undefined, subagent_dispatch_policy: 'advisory' } });
  });

  it('sends no patch when nothing changed and defaults stay invisible', () => {
    const draft = subagentDispatchPoliciesDraftFromConfig(null);
    expect(subagentDispatchPoliciesPatch(draft)).toEqual({ subagent: undefined });
  });
});
