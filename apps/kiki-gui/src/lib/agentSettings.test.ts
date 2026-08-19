import { describe, expect, it } from 'vitest';

import {
  disabledProfilePatch,
  experimentalFlagRows,
  mergeNamedAgentProfiles,
  subagentGovernanceFromConfig,
  subagentGovernancePatch,
  validateSubagentGovernance,
  workspaceChipDisplay,
  type SubagentGovernanceDraft,
} from './agentSettings';
import type { NamedAgentProfile } from './client';

const validDraft: SubagentGovernanceDraft = {
  models: [
    { id: 'provider/fast', description: 'fast work' },
    { id: 'provider/smart', description: 'hard work' },
  ],
  defaultModel: 'provider/fast',
  force: false,
  enforcePool: true,
  denyModels: 'provider/blocked\nprovider/legacy',
};

describe('subagent settings projection', () => {
  it('reads the secondary pool and deny list from the config echo', () => {
    expect(subagentGovernanceFromConfig({
      providers: {},
      secondary_model: {
        defaultModel: 'provider/fast',
        models: { 'provider/fast': 'fast work' },
        force: false,
        enforcePool: true,
      },
      subagent: { denyModels: ['provider/blocked'] },
    })).toEqual({
      models: [{ id: 'provider/fast', description: 'fast work' }],
      defaultModel: 'provider/fast',
      force: false,
      enforcePool: true,
      denyModels: 'provider/blocked',
    });
  });

  it('builds an exact-replacement pool patch so removed models stay removed', () => {
    expect(subagentGovernancePatch({
      ...validDraft,
      models: [{ id: 'provider/fast', description: ' fast work ' }],
    })).toEqual({
      subagent: { deny_models: ['provider/blocked', 'provider/legacy'] },
      secondary_model: {
        default_model: 'provider/fast',
        models: { 'provider/fast': 'fast work' },
        force: false,
        enforce_pool: true,
      },
      replace_domains: ['secondary_model'],
    });
  });

  it('omits an empty models table so clearing the pool does not leave an invalid empty pool', () => {
    expect(subagentGovernancePatch({
      ...validDraft,
      models: [],
      defaultModel: 'provider/fast',
      enforcePool: false,
    }).secondary_model?.models).toBeUndefined();
  });

  it('rejects invalid force, pool, default, and reserved combinations', () => {
    expect(validateSubagentGovernance(validDraft)).toBeNull();
    expect(validateSubagentGovernance({ ...validDraft, models: [...validDraft.models, validDraft.models[0]!] })).toBe('duplicate_model');
    expect(validateSubagentGovernance({ ...validDraft, models: [{ id: 'primary', description: '' }], defaultModel: 'primary' })).toBe('reserved_primary');
    expect(validateSubagentGovernance({ ...validDraft, defaultModel: '' })).toBe('default_required');
    expect(validateSubagentGovernance({ ...validDraft, defaultModel: 'provider/other' })).toBe('default_not_in_pool');
    expect(validateSubagentGovernance({ ...validDraft, force: true })).toBe('force_pool_conflict');
    expect(validateSubagentGovernance({ ...validDraft, models: [], defaultModel: '', enforcePool: true })).toBe('enforce_requires_pool');
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
