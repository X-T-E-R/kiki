import { describe, expect, it } from 'vitest';
import type { NamedAgentProfile } from '@kiki/protocol';

import { draftFromProfile, patchBody } from './profileDraft';

const base: NamedAgentProfile = {
  name: 'helper', description: 'Helper', main: false, source: 'user',
  source_file: '/fixture/helper.md', workspace_id: 'ws-one', disabled: false, routes: [],
};

describe('profile draft subagent_policy', () => {
  it('reads an absent policy as inherit, not advisory', () => {
    expect(draftFromProfile(base).subagentPolicy).toBe('inherit');
    expect(draftFromProfile({ ...base, subagent_policy: 'advisory' }).subagentPolicy).toBe('advisory');
    expect(draftFromProfile({ ...base, subagent_policy: 'strict' }).subagentPolicy).toBe('strict');
  });

  it('writes null to clear, the value to set, and nothing when unchanged', () => {
    const strict = { ...base, subagent_policy: 'strict' as const };
    const baseline = draftFromProfile(strict);
    expect(patchBody(strict, baseline, { ...baseline, subagentPolicy: 'inherit' }).subagent_policy).toBeNull();
    expect(patchBody(strict, baseline, { ...baseline, subagentPolicy: 'advisory' }).subagent_policy).toBe('advisory');
    expect('subagent_policy' in patchBody(strict, baseline, baseline)).toBe(false);
    const unset = draftFromProfile(base);
    expect(patchBody(base, unset, { ...unset, subagentPolicy: 'strict' }).subagent_policy).toBe('strict');
  });
});
