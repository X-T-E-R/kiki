import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SUBAGENT_PROFILE_NAME,
  disabledProfilePatch,
  experimentalFlagRows,
  composerDefaultsForProfile,
  mergeNamedAgentProfiles,
  namedAgentNewSessionBlocked,
  namedAgentOverrideRelations,
  namedAgentSessionHref,
  partitionNamedAgentProfiles,
  resolveCatalogModel,
  shippedEntryForProfile,
  subagentDefaultTargetFromConfig,
  subagentDefaultTargetPatch,
  subagentGovernanceFromConfig,
  subagentGovernancePatch,
  summarizeNamedAgentLease,
  summarizeNamedAgentModelProfile,
  workspaceChipDisplay,
  type SubagentGovernanceDraft,
} from './agentSettings';
import type { NamedAgentProfile, NamedAgentSubagentLease } from '@kiki/protocol';

const validDraft: SubagentGovernanceDraft = {
  denyModels: 'provider/blocked\nprovider/legacy',
};

describe('subagent settings projection', () => {
  it('reads the deny list from the config echo', () => {
    expect(subagentGovernanceFromConfig({
      providers: {},
      subagent: { denyModels: ['provider/blocked'] },
    })).toEqual({ denyModels: 'provider/blocked' });
  });

  it('falls back safely for malformed roots and canonicalizes legacy deny lists', () => {
    expect(subagentGovernanceFromConfig(null)).toEqual({ denyModels: '' });
    expect(subagentGovernanceFromConfig({
      subagent: { denyModels: 'provider/blocked' },
    })).toEqual({ denyModels: 'provider/blocked' });
  });

  it('patches only the deny list — a subagent model has no configured source', () => {
    expect(subagentGovernancePatch(validDraft)).toEqual({
      subagent: { deny_models: ['provider/blocked', 'provider/legacy'] },
    });
  });
});
describe('experimental flags projection', () => {
  it('unions effective flags with saved overrides and preserves both states', () => {
    expect(experimentalFlagRows(
      { experimental_flags: { alpha: true, beta: false } },
      { experimental: { beta: true, custom: false } },
    )).toEqual([
      { id: 'alpha', effective: true, override: undefined },
      { id: 'beta', effective: false, override: true },
      { id: 'custom', effective: false, override: false },
    ]);
  });
});

describe('disabled profile channels', () => {
  it('routes built-in profiles through disabled_builtin_profiles', () => {
    expect(disabledProfilePatch(
      { disabled_builtin_profiles: ['explore'], disabled_named_profiles: ['reviewer'] },
      { name: 'agent', source: 'builtin' },
      false,
    )).toEqual({ disabled_builtin_profiles: ['explore', 'agent'] });
    expect(disabledProfilePatch(
      { disabled_builtin_profiles: ['explore', 'agent'] },
      { name: 'agent', source: 'builtin' },
      true,
    )).toEqual({ disabled_builtin_profiles: ['explore'] });
  });

  it('routes named profiles through disabled_named_profiles, deduped', () => {
    expect(disabledProfilePatch(
      {},
      { name: 'reviewer', source: 'workspace' },
      false,
    )).toEqual({ disabled_named_profiles: ['reviewer'] });
    expect(disabledProfilePatch(
      { disabled_named_profiles: ['reviewer'] },
      { name: 'reviewer', source: 'user' },
      false,
    )).toEqual({ disabled_named_profiles: ['reviewer'] });
    expect(disabledProfilePatch(
      { disabled_named_profiles: ['reviewer', 'frontend'] },
      { name: 'reviewer', source: 'workspace' },
      true,
    )).toEqual({ disabled_named_profiles: ['frontend'] });
  });
});

describe('merged named-agent view', () => {
  const row = (overrides: Partial<NamedAgentProfile>): NamedAgentProfile => ({
    name: 'reviewer',
    source: 'workspace',
    main: false,
    disabled: false,
    routes: [],
    ...overrides,
  });

  it('collapses duplicate name+source+file rows across workspaces', () => {
    const merged = mergeNamedAgentProfiles([
      row({ workspace_id: 'ws-a', source_file: '/shared/reviewer.md' }),
      row({ workspace_id: 'ws-b', source_file: '/shared/reviewer.md' }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.workspace_ids).toEqual(['ws-a', 'ws-b']);
  });

  it('keeps rows distinct when source or file differs, and ORs disabled', () => {
    const merged = mergeNamedAgentProfiles([
      row({ workspace_id: 'ws-a', source_file: '/a/reviewer.md' }),
      row({ workspace_id: 'ws-b', source_file: '/b/reviewer.md', disabled: true }),
      row({ name: 'agent', source: 'builtin' }),
    ]);
    expect(merged).toHaveLength(3);
    expect(merged[2]?.workspace_ids).toEqual([]);
    const disabledMerge = mergeNamedAgentProfiles([
      row({ workspace_id: 'ws-a', source_file: '/shared/reviewer.md' }),
      row({ workspace_id: 'ws-b', source_file: '/shared/reviewer.md', disabled: true }),
    ]);
    expect(disabledMerge[0]?.disabled).toBe(true);
  });

  it('is idempotent over an already-merged server payload', () => {
    const once = mergeNamedAgentProfiles([
      row({ workspace_ids: ['ws-a', 'ws-b'], source_file: '/shared/reviewer.md' }),
    ]);
    const twice = mergeNamedAgentProfiles(once);
    expect(twice).toHaveLength(1);
    expect(twice[0]?.workspace_ids).toEqual(['ws-a', 'ws-b']);
  });
});

describe('workspace chip display', () => {
  it('shows the first ids and compacts the overflow', () => {
    expect(workspaceChipDisplay([])).toEqual({ shown: [], extra: 0 });
    expect(workspaceChipDisplay(['ws-a', 'ws-b'])).toEqual({ shown: ['ws-a', 'ws-b'], extra: 0 });
    expect(workspaceChipDisplay(['ws-a', 'ws-b', 'ws-c', 'ws-d'])).toEqual({ shown: ['ws-a', 'ws-b'], extra: 2 });
  });
});

describe('main/subagent partition', () => {
  const row = (overrides: Partial<NamedAgentProfile>): NamedAgentProfile => ({
    name: 'reviewer',
    source: 'workspace',
    main: false,
    disabled: false,
    routes: [],
    ...overrides,
  });

  it('puts main-flagged profiles in the main bucket and keeps the rest as subagents', () => {
    const buckets = partitionNamedAgentProfiles([
      row({ name: 'agent', source: 'builtin', main: true }),
      row({ name: 'explore', source: 'builtin' }),
      row({ name: 'reviewer', main: true }),
      row({ name: 'frontend', source: 'user' }),
    ]);
    expect(buckets.main.map((profile) => profile.name)).toEqual(['agent', 'reviewer']);
    expect(buckets.sub.map((profile) => profile.name)).toEqual(['explore', 'frontend']);
  });
});

describe('same-name override relations', () => {
  const row = (overrides: Partial<NamedAgentProfile>): NamedAgentProfile => ({
    name: 'explore',
    source: 'builtin',
    main: false,
    disabled: false,
    routes: [],
    ...overrides,
  });

  it('marks an overriding file profile as effective and the built-in as overridden', () => {
    const builtin = row({ name: 'explore', source: 'builtin' });
    const file = row({
      name: 'explore',
      source: 'user',
      override: true,
      source_file: '/home/you/.kiki/agents/explore.md',
    });
    const relations = namedAgentOverrideRelations([builtin, file]);
    expect(relations.get(file)).toEqual({ kind: 'overrides_builtin', builtinName: 'explore' });
    expect(relations.get(builtin)).toEqual({
      kind: 'overridden',
      file: '/home/you/.kiki/agents/explore.md',
    });
  });

  it('marks a non-override file profile as shadowed while the built-in stays canonical', () => {
    const builtin = row({ name: 'explore', source: 'builtin' });
    const file = row({ name: 'explore', source: 'workspace', source_file: '/repo/.kiki/agents/explore.md' });
    const relations = namedAgentOverrideRelations([builtin, file]);
    expect(relations.get(file)).toEqual({ kind: 'shadowed', builtinName: 'explore' });
    expect(relations.has(builtin)).toBe(false);
  });

  it('annotates nothing when the built-in is disabled (the file profile wins outright)', () => {
    const builtin = row({ name: 'explore', source: 'builtin', disabled: true });
    const plain = row({ name: 'explore', source: 'user', source_file: '/a/explore.md' });
    const flagged = row({ name: 'explore', source: 'workspace', override: true, source_file: '/b/explore.md' });
    const relations = namedAgentOverrideRelations([builtin, plain, flagged]);
    expect(relations.size).toBe(0);
  });

  it('annotates nothing when the file profile is disabled (the built-in wins again)', () => {
    const builtin = row({ name: 'explore', source: 'builtin' });
    const file = row({ name: 'explore', source: 'user', override: true, disabled: true });
    expect(namedAgentOverrideRelations([builtin, file]).size).toBe(0);
  });

  it('leaves unrelated and builtin-free names alone, and handles several file rows per name', () => {
    const solo = row({ name: 'reviewer', source: 'user', source_file: '/a/reviewer.md' });
    const builtin = row({ name: 'explore', source: 'builtin' });
    const overriding = row({ name: 'explore', source: 'user', override: true, source_file: '/a/explore.md' });
    const plain = row({ name: 'explore', source: 'workspace', source_file: '/b/explore.md' });
    const relations = namedAgentOverrideRelations([solo, builtin, overriding, plain]);
    expect(relations.has(solo)).toBe(false);
    expect(relations.get(overriding)?.kind).toBe('overrides_builtin');
    expect(relations.get(plain)?.kind).toBe('shadowed');
    expect(relations.get(builtin)).toEqual({ kind: 'overridden', file: '/a/explore.md' });
  });

  it('falls back to the profile name when the overriding file carries no source path', () => {
    const builtin = row({ name: 'explore', source: 'builtin' });
    const file = row({ name: 'explore', source: 'user', override: true });
    expect(namedAgentOverrideRelations([builtin, file]).get(builtin)).toEqual({
      kind: 'overridden',
      file: 'explore',
    });
  });
});

describe('new-session button blocking', () => {
  it('blocks a shadowed file profile even while it is enabled', () => {
    // A session under its name would silently run the same-named built-in.
    expect(namedAgentNewSessionBlocked(
      { disabled: false, main: false },
      { kind: 'shadowed', builtinName: 'explore' },
    )).toBe(true);
  });

  it('keeps the button for an overriding file profile and for a disabled main profile', () => {
    expect(namedAgentNewSessionBlocked(
      { disabled: false, main: false },
      { kind: 'overrides_builtin', builtinName: 'explore' },
    )).toBe(false);
    expect(namedAgentNewSessionBlocked({ disabled: true, main: true })).toBe(false);
  });

  it('blocks a disabled subagent profile without a relation', () => {
    expect(namedAgentNewSessionBlocked({ disabled: true, main: false })).toBe(true);
    expect(namedAgentNewSessionBlocked({ disabled: false, main: false })).toBe(false);
  });
});

describe('named-agent session deep link', () => {
  const row = (overrides: Partial<NamedAgentProfile>): NamedAgentProfile => ({
    name: 'reviewer',
    source: 'workspace',
    main: false,
    disabled: false,
    routes: [],
    ...overrides,
  });

  it('prefers the merged workspace ids, then the single workspace id', () => {
    expect(namedAgentSessionHref(row({ workspace_ids: ['ws-a', 'ws-b'], workspace_id: 'ws-c' })))
      .toBe('/new?workspace=ws-a&agent=reviewer');
    expect(namedAgentSessionHref(row({ workspace_id: 'ws-c' })))
      .toBe('/new?workspace=ws-c&agent=reviewer');
  });

  it('falls back to the most recent workspace and then to an agent-only link', () => {
    expect(namedAgentSessionHref(row({ name: 'agent', source: 'builtin' }), 'ws-recent'))
      .toBe('/new?workspace=ws-recent&agent=agent');
    expect(namedAgentSessionHref(row({ name: 'agent', source: 'builtin' })))
      .toBe('/new?agent=agent');
  });

  it('encodes workspace ids and profile names', () => {
    expect(namedAgentSessionHref(row({ name: 'my agent', workspace_id: 'ws/a' })))
      .toBe('/new?workspace=ws%2Fa&agent=my+agent');
  });
});

describe('subagent lease read-only summary', () => {
  it('surfaces every non-empty field of a full protocol lease', () => {
    const lease: NamedAgentSubagentLease = {
      name: 'explore',
      description: 'Read-only exploration.',
      when_to_use: 'Mapping unfamiliar code.',
      model_alias: 'fixture/kiki-lite',
      thinking_effort: 'low',
      allowed_models: ['fixture/kiki-lite'],
      deny_models: ['fixture/kiki-pro'],
      allowed_efforts: ['low', 'medium'],
      tools: ['Read', 'Glob'],
      disallowed_tools: ['Bash'],
      subagents: ['scout'],
      prompt_mode: 'append',
      prompt: 'Stay read-only.',
      delegation_notice: 'off',
      service_tier: 'flex',
      request_params: { temperature: 0.2, stream: true },
      model_profiles: [
        {
          alias: 'deep',
          when: 'Thorough pass',
          thinking_effort: 'high',
          allowed_efforts: ['medium', 'high'],
          prompt_mode: 'prepend',
          prompt: 'Check twice.',
        },
      ],
    };
    const summary = summarizeNamedAgentLease(lease);
    expect(summary.headline).toBe('explore · fixture/kiki-lite · low');
    expect(summary.details).toEqual([
      { label: 'description', value: 'Read-only exploration.' },
      { label: 'whenToUse', value: 'Mapping unfamiliar code.' },
      { label: 'serviceTier', value: 'flex' },
      { label: 'delegationNotice', value: 'off' },
      { label: 'promptMode', value: 'append' },
      { label: 'allowedModels', value: 'fixture/kiki-lite' },
      { label: 'deniedModels', value: 'fixture/kiki-pro' },
      { label: 'allowedEfforts', value: 'low, medium' },
      { label: 'tools', value: 'Read, Glob' },
      { label: 'disallowedTools', value: 'Bash' },
      { label: 'subagents', value: 'scout' },
      { label: 'prompt', value: 'Stay read-only.' },
      { label: 'requestParams', value: '{"temperature":0.2,"stream":true}' },
      { label: 'modelProfile', value: 'deep → Thorough pass · high' },
      { label: 'allowedEfforts', value: 'medium, high' },
      { label: 'promptMode', value: 'prepend' },
      { label: 'prompt', value: 'Check twice.' },
    ]);
  });

  it('renders nothing but the headline for empty and explicitly cleared fields', () => {
    const summary = summarizeNamedAgentLease({
      name: 'explore',
      tools: null,
      subagents: null,
      service_tier: null,
      request_params: null,
      allowed_models: [],
    });
    expect(summary.headline).toBe('explore');
    expect(summary.details).toEqual([]);
  });

  it('marks a scoped source lease and surfaces its source path, status, and diagnostic', () => {
    const ready = summarizeNamedAgentLease({
      name: 'writer',
      source: './_private/research/writer.md',
      scope: 'private',
      status: 'ready',
      model_alias: 'fixture/kiki-lite',
    });
    expect(ready.headline).toBe('writer · fixture/kiki-lite');
    expect(ready.scoped).toBe(true);
    expect(ready.status).toBe('ready');
    expect(ready.diagnostic).toBeUndefined();
    expect(ready.details).toEqual([
      { label: 'leaseSource', value: './_private/research/writer.md' },
    ]);

    const unavailable = summarizeNamedAgentLease({
      name: 'archivist',
      source: './_private/research/archivist.md',
      scope: 'private',
      status: 'unavailable',
      diagnostic: 'source file missing: ./_private/research/archivist.md',
    });
    expect(unavailable.scoped).toBe(true);
    expect(unavailable.status).toBe('unavailable');
    expect(unavailable.diagnostic).toBe('source file missing: ./_private/research/archivist.md');
    expect(unavailable.details).toEqual([
      { label: 'leaseSource', value: './_private/research/archivist.md' },
    ]);
  });

  it('ignores stray projection fields on a lease without private scope', () => {
    const summary = summarizeNamedAgentLease({
      name: 'explore',
      source: './_private/research/writer.md',
      status: 'unavailable',
      diagnostic: 'should not surface',
    });
    expect(summary.scoped).toBe(false);
    expect(summary.status).toBeUndefined();
    expect(summary.diagnostic).toBeUndefined();
    expect(summary.details).toEqual([]);
  });
});

describe('model profile read-only summary', () => {
  it('keeps the headline shape and surfaces optional contract fields', () => {
    const summary = summarizeNamedAgentModelProfile({
      alias: 'fast',
      when: 'Quick tweaks',
      thinking_effort: 'low',
      allowed_efforts: ['low', 'medium'],
      prompt_mode: 'wrap',
      prompt: 'Be terse.',
    });
    expect(summary.headline).toBe('fast → Quick tweaks · low');
    expect(summary.details).toEqual([
      { label: 'allowedEfforts', value: 'low, medium' },
      { label: 'promptMode', value: 'wrap' },
      { label: 'prompt', value: 'Be terse.' },
    ]);
  });

  it('surfaces budgets, service tier, and request params without requiring when', () => {
    const summary = summarizeNamedAgentModelProfile({
      alias: 'fast',
      context_budget: 4096,
      max_completion_tokens: 512,
      service_tier: 'flex',
      request_params: { temperature: 0.2, stream: true },
    });
    expect(summary.headline).toBe('fast');
    expect(summary.details).toEqual([
      { label: 'contextBudget', value: '4096' },
      { label: 'maxCompletionTokens', value: '512' },
      { label: 'serviceTier', value: 'flex' },
      { label: 'requestParams', value: '{"temperature":0.2,"stream":true}' },
    ]);
  });

  it('omits the effort suffix and every detail when fields are empty', () => {
    const summary = summarizeNamedAgentModelProfile({
      alias: 'fast',
      when: 'Quick tweaks',
      allowed_efforts: [],
      prompt: '',
    });
    expect(summary.headline).toBe('fast → Quick tweaks');
    expect(summary.details).toEqual([]);
  });
});

describe('composerDefaultsForProfile', () => {
  const row = (overrides: Partial<NamedAgentProfile>): NamedAgentProfile => ({
    name: 'agent',
    source: 'builtin',
    main: true,
    disabled: false,
    routes: [],
    ...overrides,
  });

  it('returns the selected profile pins and omits blank fields', () => {
    expect(composerDefaultsForProfile([
      row({ name: 'grok-only', pinned_model_alias: 'grok-4.6', thinking_effort: 'high' }),
      row({ name: 'agent' }),
    ], 'grok-only')).toEqual({ model: 'grok-4.6', thinking: 'high' });
    expect(composerDefaultsForProfile([
      row({ name: 'agent', pinned_model_alias: '  ', thinking_effort: '' }),
    ], 'agent')).toEqual({ model: undefined, thinking: undefined });
  });

  it('returns empty defaults when the named profile is missing', () => {
    expect(composerDefaultsForProfile([row({ name: 'agent' })], 'missing')).toEqual({
      model: undefined,
      thinking: undefined,
    });
  });
});


describe('resolveCatalogModel', () => {
  const catalog = [
    { provider_id: 'alpha', id: 'alpha/k3-256k', remote_id: 'k3-256k' },
    { provider_id: 'beta', id: 'beta/k3-256k', remote_id: 'k3-256k' },
    { provider_id: 'fixture', id: 'fixture/kiki-pro', remote_id: 'kiki-pro' },
    { provider_id: 'openai', id: 'fast-model', remote_id: 'fast-model' },
    { provider_id: 'managed:kimi-code', id: 'k3-review', remote_id: 'k3-review' },
  ];

  it('prefers an exact catalog key', () => {
    expect(resolveCatalogModel(catalog, 'fixture/kiki-pro')?.provider_id).toBe('fixture');
    expect(resolveCatalogModel(catalog, 'fast-model')?.provider_id).toBe('openai');
  });

  it('resolves an ambiguous bare id to the first catalog row in server order', () => {
    expect(resolveCatalogModel(catalog, 'k3-256k')?.id).toBe('alpha/k3-256k');
  });

  it('resolves a provider-qualified id to the matching bare key', () => {
    expect(resolveCatalogModel(catalog, 'openai/fast-model')?.id).toBe('fast-model');
    expect(resolveCatalogModel(catalog, 'kimi-code/k3-review')?.id).toBe('k3-review');
    expect(resolveCatalogModel(catalog, 'anthropic/fast-model')).toBeUndefined();
  });

  it('returns undefined for unknown ids', () => {
    expect(resolveCatalogModel(catalog, 'missing')).toBeUndefined();
    expect(resolveCatalogModel(catalog, 'other/k3-256k')).toBeUndefined();
    expect(resolveCatalogModel(catalog, 'alpha/')).toBeUndefined();
  });
});

describe('subagent default target', () => {
  it('mirrors the engine fallback when the key is unset or malformed', () => {
    expect(DEFAULT_SUBAGENT_PROFILE_NAME).toBe('general');
    expect(subagentDefaultTargetFromConfig({})).toEqual({ mode: 'profile', name: 'general' });
    expect(subagentDefaultTargetFromConfig({ subagent: {} })).toEqual({ mode: 'profile', name: 'general' });
    expect(subagentDefaultTargetFromConfig({ subagent: { defaultProfile: 42 } })).toEqual({ mode: 'profile', name: 'general' });
  });

  it('treats a blank value as strict and trims profile names', () => {
    expect(subagentDefaultTargetFromConfig({ subagent: { defaultProfile: '' } })).toEqual({ mode: 'strict' });
    expect(subagentDefaultTargetFromConfig({ subagent: { defaultProfile: '   ' } })).toEqual({ mode: 'strict' });
    expect(subagentDefaultTargetFromConfig({ subagent: { defaultProfile: ' explore ' } })).toEqual({ mode: 'profile', name: 'explore' });
  });

  it('writes strict as the empty string and profile names verbatim', () => {
    expect(subagentDefaultTargetPatch({ mode: 'strict' })).toEqual({ subagent: { default_profile: '' } });
    expect(subagentDefaultTargetPatch({ mode: 'profile', name: 'explore' })).toEqual({ subagent: { default_profile: 'explore' } });
  });
});

describe('shippedEntryForProfile', () => {
  const entry = {
    template_id: 'general',
    status: 'custom' as const,
    managed: true,
    main: false,
    active_path: 'C:/fixture/user/agents/builtin/general.md',
  };

  it('matches by the normalized on-disk path, never by name', () => {
    expect(shippedEntryForProfile(
      { source_file: 'C:\\fixture\\user\\agents\\builtin\\general.md' },
      [entry],
    )?.template_id).toBe('general');
    // A same-named file elsewhere is not the managed built-in copy.
    expect(shippedEntryForProfile({ source_file: 'C:/fixture/other/general.md' }, [entry])).toBeUndefined();
    expect(shippedEntryForProfile({ source_file: undefined }, [entry])).toBeUndefined();
  });

  it('ignores unmanaged entries and entries without an active path', () => {
    expect(shippedEntryForProfile({ source_file: 'C:/fixture/user/agents/builtin/general.md' }, [
      { ...entry, managed: false },
    ])).toBeUndefined();
    expect(shippedEntryForProfile({ source_file: 'C:/fixture/user/agents/builtin/general.md' }, [
      { ...entry, active_path: undefined },
    ])).toBeUndefined();
  });
});
