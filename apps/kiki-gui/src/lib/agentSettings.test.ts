import { describe, expect, it } from 'vitest';

import {
  experimentalFlagRows,
  subagentGovernanceFromConfig,
  subagentGovernancePatch,
  validateSubagentGovernance,
  type SubagentGovernanceDraft,
} from './agentSettings';

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
