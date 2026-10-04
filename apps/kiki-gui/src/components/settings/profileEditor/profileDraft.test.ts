import { describe, expect, it } from 'vitest';
import type { NamedAgentProfile } from '@kiki/protocol';

import { allowedSubagentsOpen, canSpawnDraft, draftFromProfile, openAllowedSubagents, patchBody, toggleKikiContext } from './profileDraft';

const base: NamedAgentProfile = {
  name: 'helper', description: 'Helper', main: false, source: 'user',
  source_file: '/fixture/helper.md', workspace_id: 'ws-one', disabled: false, routes: [],
};

describe('profile draft subagent dispatch fields', () => {
  it('reads an absent field as not declared, not as a grant', () => {
    const policy = draftFromProfile(base).subagentPolicy;
    expect(policy.canSpawnSubagents).toBeUndefined();
    expect(policy.allowedSubagents).toBeUndefined();
    expect(policy.preferredSubagents).toBeUndefined();
    expect(policy.denySubagents).toBeUndefined();
    expect(canSpawnDraft(policy.canSpawnSubagents)).toBe(true);
  });

  it('keeps an empty allowed list apart from an absent one, and both apart from the switch', () => {
    const absent = draftFromProfile(base).subagentPolicy;
    const empty = draftFromProfile({ ...base, allowed_subagents: [] }).subagentPolicy;
    expect(empty.allowedSubagents).toEqual([]);
    expect(empty.canSpawnSubagents).toBeUndefined();
    const leaf = draftFromProfile({ ...base, can_spawn_subagents: false }).subagentPolicy;
    expect(leaf.canSpawnSubagents).toBe(false);
    expect(leaf.allowedSubagents).toBeUndefined();
    expect(canSpawnDraft(leaf.canSpawnSubagents)).toBe(false);
  });

  it('recommends without silently restricting: a preferred-only edit writes no allowed list and no false', () => {
    const baseline = draftFromProfile(base);
    const body = patchBody(base, baseline, {
      ...baseline, subagentPolicy: { ...baseline.subagentPolicy, preferredSubagents: ['explore'] },
    });
    expect(body.preferred_subagents).toEqual(['explore']);
    expect(body).not.toHaveProperty('allowed_subagents');
    expect(body).not.toHaveProperty('can_spawn_subagents');
    expect(body).not.toHaveProperty('deny_subagents');
    expect(body).not.toHaveProperty('subagent_policy');
  });

  it('writes null to drop this layer and nothing at all when untouched', () => {
    const profile: NamedAgentProfile = {
      ...base, can_spawn_subagents: false,
      allowed_subagents: ['explore'], preferred_subagents: ['explore'], deny_subagents: ['legacy'],
    };
    const baseline = draftFromProfile(profile);
    expect('can_spawn_subagents' in patchBody(profile, baseline, baseline)).toBe(false);
    expect(patchBody(profile, baseline, {
      ...baseline, subagentPolicy: { ...baseline.subagentPolicy, canSpawnSubagents: undefined },
    }).can_spawn_subagents).toBeNull();
    expect(patchBody(profile, baseline, {
      ...baseline, subagentPolicy: { ...baseline.subagentPolicy, allowedSubagents: undefined },
    }).allowed_subagents).toBeNull();
    expect(patchBody(profile, baseline, {
      ...baseline, subagentPolicy: { ...baseline.subagentPolicy, preferredSubagents: [] },
    }).preferred_subagents).toEqual([]);
  });

  it('round-trips nested source, lease pins and per-child prompts through an unrelated edit', () => {
    const profile: NamedAgentProfile = {
      ...base,
      allowed_subagents: [{
        name: 'explore', source: 'scoped/agents/explore.md', model_alias: 'fixture/sol', thinking_effort: 'high',
        model_prompts: 'replace', model_profiles: [{ alias: 'fixture/sol' }],
      }, 'reviewer'],
    };
    const baseline = draftFromProfile(profile);
    // An untouched list rides along with nothing: a description edit cannot
    // restate the preset list, let alone drop a scoped source.
    const body = patchBody(profile, baseline, { ...baseline, description: 'A different summary' });
    expect(body.description).toBe('A different summary');
    expect(body).not.toHaveProperty('allowed_subagents');

    // Reordering writes the scoped entry as a bare name, which the server
    // merges onto the mapping already on disk, and the pin comes back whole.
    const reordered = baseline.subagentPolicy.allowedSubagents!.toReversed();
    const moved = patchBody(profile, baseline, {
      ...baseline, subagentPolicy: { ...baseline.subagentPolicy, allowedSubagents: reordered },
    });
    expect(moved.allowed_subagents).toEqual(['reviewer', 'explore']);
  });

  it('writes only the changed pin and leaves the nested per-child prompts to the sparse merge', () => {
    const profile: NamedAgentProfile = {
      ...base,
      allowed_subagents: [{
        name: 'explore', source: 'scoped/agents/explore.md', model_alias: 'fixture/sol', thinking_effort: 'high',
        model_prompts: 'replace', model_profiles: [{ alias: 'fixture/sol' }],
      }],
    };
    const baseline = draftFromProfile(profile);
    const moved = patchBody(profile, baseline, {
      ...baseline,
      subagentPolicy: {
        ...baseline.subagentPolicy,
        allowedSubagents: [{ ...baseline.subagentPolicy.allowedSubagents![0]!, modelAlias: 'fixture/k3' }],
      },
    });
    // Only the pin is restated; source, prompts and model_profiles are omitted
    // so the server keeps what is already on disk.
    expect(moved.allowed_subagents).toEqual([{
      name: 'explore', model_alias: 'fixture/k3', thinking_effort: 'high',
      model_prompts: undefined, model_profiles: undefined,
    }]);
  });

  it('keeps a source-only scoped lease when the list stops limiting presets', () => {
    // A scoped lease whose only configuration is its private source is still a
    // real mapping: dropping it would delete a definition the server resolves.
    const profile: NamedAgentProfile = {
      ...base,
      allowed_subagents: ['*', { name: 'explore', source: 'scoped/agents/explore.md' }],
    };
    const baseline = draftFromProfile(profile);
    expect(allowedSubagentsOpen(baseline.subagentPolicy.allowedSubagents)).toBe(true);
    const opened = openAllowedSubagents(baseline.subagentPolicy.allowedSubagents);
    expect(opened?.map((entry) => entry.name)).toEqual(['*', 'explore']);
    const body = patchBody(profile, baseline, {
      ...baseline, subagentPolicy: { ...baseline.subagentPolicy, allowedSubagents: opened },
    });
    // The source is not restated, so the server's sparse merge keeps it.
    expect(body.allowed_subagents).toEqual(['*', 'explore']);
  });

  it('keeps a source-only lease when the open domain is written back unchanged', () => {
    const profile: NamedAgentProfile = {
      ...base,
      allowed_subagents: ['*', { name: 'explore', source: 'scoped/agents/explore.md' }, 'reviewer'],
    };
    const baseline = draftFromProfile(profile);
    // Reordering the named leases under an open domain must not drop the
    // scoped one, and a genuinely bare name may go.
    const rows = [...baseline.subagentPolicy.allowedSubagents!].filter((entry) => entry.name !== '*').toReversed();
    const body = patchBody(profile, baseline, {
      ...baseline, subagentPolicy: { ...baseline.subagentPolicy, allowedSubagents: [{ name: '*', modelAlias: '', effort: '' }, ...rows] },
    });
    // 'reviewer' is a bare name beside the wildcard, which already says it, so
    // it is normalised away; the scoped lease is kept and the order stands.
    expect(body.allowed_subagents).toEqual(['*', 'explore']);
  });

  it('keeps a lease pin when the list stops limiting presets', () => {
    const profile: NamedAgentProfile = {
      ...base,
      allowed_subagents: [{ name: 'explore', model_alias: 'fixture/sol', thinking_effort: 'high' }],
    };
    const baseline = draftFromProfile(profile);
    const opened = openAllowedSubagents(baseline.subagentPolicy.allowedSubagents);
    const body = patchBody(profile, baseline, {
      ...baseline, subagentPolicy: { ...baseline.subagentPolicy, allowedSubagents: opened },
    });
    // "Stop limiting" opens the domain and carries the pin; it does not drop it.
    expect(body.allowed_subagents).toEqual(['*', 'explore']);
    // With nothing pinned there is no key left to write.
    expect(openAllowedSubagents([{ name: 'reviewer', modelAlias: '', effort: '' }])).toBeUndefined();
  });

  it.each([
    { name: 'explore', can_spawn_subagents: false },
    { name: 'explore', allowed_subagents: [] },
    { name: 'explore', preferred_subagents: ['reviewer'] },
    { name: 'explore', deny_subagents: ['worker'] },
    { name: 'explore', deny_models: ['fixture/blocked'] },
    { name: 'explore', tools: [] },
    { name: 'explore', disallowed_tools: ['Bash'] },
  ])('keeps the complete readonly mapping when opening and reordering: %j', (lease) => {
    const profile: NamedAgentProfile = { ...base, allowed_subagents: [lease, 'reviewer'] };
    const baseline = draftFromProfile(profile);
    expect(baseline.subagentPolicy.allowedSubagents![0]!.lease).toEqual(lease);
    const opened = openAllowedSubagents(baseline.subagentPolicy.allowedSubagents);
    expect(opened?.map((entry) => entry.name)).toEqual(['*', 'explore']);
    const body = patchBody(profile, baseline, {
      ...baseline, subagentPolicy: { ...baseline.subagentPolicy, allowedSubagents: opened!.toReversed() },
    });
    expect(body.allowed_subagents).toEqual(['*', 'explore']);
    expect(body).not.toHaveProperty('preferred_subagents');
    expect(body).not.toHaveProperty('can_spawn_subagents');
  });

  it('keeps denial and preference independent of the preset list', () => {
    const profile: NamedAgentProfile = { ...base, deny_subagents: ['legacy'] };
    const baseline = draftFromProfile(profile);
    const body = patchBody(profile, baseline, {
      ...baseline, subagentPolicy: { ...baseline.subagentPolicy, denySubagents: ['legacy', 'other'] },
    });
    expect(body.deny_subagents).toEqual(['legacy', 'other']);
    expect(body).not.toHaveProperty('allowed_subagents');
    expect(body).not.toHaveProperty('preferred_subagents');
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


describe('profile draft model menu and advice', () => {
  it('defaults the menu restriction to off, preserves untouched fields, and writes booleans on change', () => {
    const baseline = draftFromProfile(base);
    expect(baseline.restrictModelsToMenu).toBe(false);
    expect(patchBody(base, baseline, baseline)).not.toHaveProperty('restrict_models_to_menu');
    expect(patchBody(base, baseline, { ...baseline, restrictModelsToMenu: true }).restrict_models_to_menu).toBe(true);
    const restricted = { ...base, restrict_models_to_menu: true };
    const enabled = draftFromProfile(restricted);
    expect(patchBody(restricted, enabled, { ...enabled, restrictModelsToMenu: false }).restrict_models_to_menu).toBe(false);
  });

  it('round-trips soft advice separately from hard constraints and removes only edited advice', () => {
    const profile = { ...base, preferred_models: ['fixture/fast'], discouraged_models: ['fixture/costly'],
      preferred_efforts: ['low'], allowed_models: ['fixture/fast'], deny_models: ['fixture/blocked'] };
    const baseline = draftFromProfile(profile);
    expect(baseline.preferredModels).toEqual(['fixture/fast']);
    expect(baseline.discouragedModels).toEqual(['fixture/costly']);
    expect(baseline.preferredEfforts).toEqual(['low']);
    const patch = patchBody(profile, baseline, { ...baseline, preferredModels: [], preferredEfforts: ['high'] });
    expect(patch.preferred_models).toBeNull();
    expect(patch.preferred_efforts).toEqual(['high']);
    expect(patch).not.toHaveProperty('allowed_models');
    expect(patch).not.toHaveProperty('deny_models');
    expect(patch).not.toHaveProperty('discouraged_models');
  });
});
