import { describe, expect, it } from 'vitest';
import type { NamedAgentProfile } from '@kiki/protocol';

import { draftFromProfile, patchBody, toggleKikiContext } from './profileDraft';

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

describe('profile draft kiki_context', () => {
  const lead: NamedAgentProfile = { ...base, main: true, executor: 'claude-acp' };

  it('reads an absent field as undefined and an explicit [] as an empty list', () => {
    expect(draftFromProfile(lead).kikiContext).toBeUndefined();
    expect(draftFromProfile({ ...lead, kiki_context: [] }).kikiContext).toEqual([]);
    expect(draftFromProfile({ ...lead, kiki_context: ['hooks', 'memory', 'memory'] }).kikiContext).toEqual(['memory', 'hooks']);
  });

  it('writes the list when a group turns on, and nothing when untouched', () => {
    const baseline = draftFromProfile(lead);
    const on = { ...baseline, kikiContext: toggleKikiContext(baseline.kikiContext, 'board', true, baseline.kikiContext) };
    expect(patchBody(lead, baseline, on).kiki_context).toEqual(['board']);
    expect('kiki_context' in patchBody(lead, baseline, baseline)).toBe(false);
    const empty = { ...lead, kiki_context: [] as NamedAgentProfile['kiki_context'] };
    expect('kiki_context' in patchBody(empty, draftFromProfile(empty), draftFromProfile(empty))).toBe(false);
  });

  it('turning the last group off writes [] for a written list, but leaves an absent field absent', () => {
    const listed = { ...lead, kiki_context: ['memory'] as NamedAgentProfile['kiki_context'] };
    const listedDraft = draftFromProfile(listed);
    const off = toggleKikiContext(listedDraft.kikiContext, 'memory', false, listedDraft.kikiContext);
    expect(off).toEqual([]);
    expect(patchBody(listed, listedDraft, { ...listedDraft, kikiContext: off }).kiki_context).toEqual([]);

    const absent = draftFromProfile(lead);
    const roundTrip = toggleKikiContext(toggleKikiContext(undefined, 'cron', true, undefined), 'cron', false, undefined);
    expect(roundTrip).toBeUndefined();
    expect('kiki_context' in patchBody(lead, absent, { ...absent, kikiContext: roundTrip })).toBe(false);
  });

  it('removing the field sends null, which is not the same as []', () => {
    const empty = { ...lead, kiki_context: [] as NamedAgentProfile['kiki_context'] };
    const draft = draftFromProfile(empty);
    expect(patchBody(empty, draft, { ...draft, kikiContext: undefined }).kiki_context).toBeNull();
    const listed = { ...lead, kiki_context: ['history', 'hooks'] as NamedAgentProfile['kiki_context'] };
    const listedDraft = draftFromProfile(listed);
    expect(patchBody(listed, listedDraft, { ...listedDraft, kikiContext: undefined }).kiki_context).toBeNull();
  });

  it('drops the field when the profile stops being an external main, and never writes it for a native one', () => {
    const listed = { ...lead, kiki_context: ['memory'] as NamedAgentProfile['kiki_context'] };
    const draft = draftFromProfile(listed);
    expect(patchBody(listed, draft, { ...draft, main: false }).kiki_context).toBeNull();
    expect(patchBody(listed, draft, { ...draft, executor: '' }).kiki_context).toBeNull();
    const native = draftFromProfile({ ...base, main: true });
    expect('kiki_context' in patchBody({ ...base, main: true }, native, { ...native, kikiContext: ['memory'] })).toBe(false);
  });

  it('keeps delegation on its own flag', () => {
    const baseline = draftFromProfile(lead);
    const body = patchBody(lead, baseline, { ...baseline, allowKikiSubagents: true, kikiContext: ['threads'] });
    expect(body.allow_kiki_subagents).toBe(true);
    expect(body.kiki_context).toEqual(['threads']);
  });
});
