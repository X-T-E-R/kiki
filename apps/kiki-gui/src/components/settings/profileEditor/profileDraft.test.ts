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

describe('profile draft allow_kiki_subagents', () => {
  const lead: NamedAgentProfile = { ...base, main: true, executor: 'claude-acp' };

  it('writes true to enable and null to disable, never false', () => {
    const baseline = draftFromProfile(lead);
    expect(baseline.allowKikiSubagents).toBe(false);
    expect(patchBody(lead, baseline, { ...baseline, allowKikiSubagents: true }).allow_kiki_subagents).toBe(true);
    const on = { ...lead, allow_kiki_subagents: true };
    const onDraft = draftFromProfile(on);
    expect(patchBody(on, onDraft, { ...onDraft, allowKikiSubagents: false }).allow_kiki_subagents).toBeNull();
    expect('allow_kiki_subagents' in patchBody(on, onDraft, onDraft)).toBe(false);
  });

  it('clears the flag when the profile stops being an external main', () => {
    const on = { ...lead, allow_kiki_subagents: true };
    const draft = draftFromProfile(on);
    expect(patchBody(on, draft, { ...draft, main: false }).allow_kiki_subagents).toBeNull();
    expect(patchBody(on, draft, { ...draft, executor: '' }).allow_kiki_subagents).toBeNull();
  });

  it('does not write the flag for a native or subagent profile', () => {
    const native = draftFromProfile({ ...base, main: true });
    expect('allow_kiki_subagents' in patchBody({ ...base, main: true }, native, { ...native, allowKikiSubagents: true })).toBe(false);
  });
});
