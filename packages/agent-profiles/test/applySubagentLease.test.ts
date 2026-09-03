import { describe, expect, it } from 'vitest';

import { normalizeAgentProfile, type AgentProfile } from '#/agentProfile';
import { resolveAgentProfileRoute } from '#/agentProfileRoute';
import {
  appliedDispatchProfile,
  applyLease,
  applySpawnPolicy,
  fillLeasePins,
  intersectSpawnPolicy,
  isDispatchBlocked,
  leaseHasBindingPin,
  routePermittedByProfile,
} from '#/applySubagentLease';
import type { SubagentLease } from '#/subagentLease';

function child(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return normalizeAgentProfile({
    name: 'explore',
    description: 'catalog explore',
    whenToUse: 'scope unknown trees',
    allowedModels: ['grok-4.6', 'gpt-5.6-sol'],
    modelAlias: 'gpt-5.6-sol',
    thinkingEffort: 'medium',
    tools: ['Read', 'Grep', 'Glob'],
    subagents: ['reviewer'],
    systemPrompt: () => 'EXPLORE BODY',
    ...overrides,
  });
}

describe('applyLease', () => {
  it('intersects allowlists, unions denylists, and replaces tools', () => {
    const lease: SubagentLease = {
      name: 'explore',
      allowedModels: ['grok-4.6', 'grok-4.6-fast'],
      denyModels: ['gpt-5.6-sol'],
      tools: ['Bash', 'Read'],
      description: 'caller explore',
    };
    const applied = applyLease(child(), lease);
    expect(applied.allowedModels).toEqual(['grok-4.6']);
    expect(applied.denyModels).toEqual(['gpt-5.6-sol']);
    expect(applied.tools).toEqual(['Bash', 'Read']);
    expect(applied.description).toBe('caller explore');
    expect(applied.subagents).toEqual(['reviewer']);
    expect(child().tools).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('clears leftover route toolAllowPolicies when tools is replaced', () => {
    const routed = resolveAgentProfileRoute(
      {
        id: 'explore.flash',
        profile: 'explore',
        description: 'flash',
        promptMode: 'inherit',
        prompt: '',
        modelAlias: 'k3-256k',
        overriddenFields: ['model_alias'],
        path: '/agents/.routes/explore/flash.md',
      },
      child({ tools: ['Read', 'Grep'] }),
    );
    expect(routed.effectiveProfile.toolAllowPolicies).toEqual([['Read', 'Grep']]);
    const applied = applyLease(routed.effectiveProfile, {
      name: 'explore',
      tools: ['Bash', 'Read'],
    });
    expect(applied.tools).toEqual(['Bash', 'Read']);
    expect(applied.toolAllowPolicies).toBeUndefined();
  });

  it('treats tools: * as full-open replace', () => {
    const applied = applyLease(child({ toolAllowPolicies: [['Read']] }), {
      name: 'explore',
      tools: null,
    });
    expect(applied.tools).toBeUndefined();
    expect(applied.toolAllowPolicies).toBeUndefined();
  });

  it('intersects allowlists after alias identity', () => {
    const resolveId = (alias: string): string =>
      alias === 'grok-4.6' || alias === 'axon-message/grok-4.6'
        ? 'axon-message/grok-4.6'
        : alias;
    const applied = applyLease(
      child({ allowedModels: ['axon-message/grok-4.6', 'gpt-5.6-sol'] }),
      { name: 'explore', allowedModels: ['grok-4.6'] },
      resolveId,
    );
    expect(applied.allowedModels).toEqual(['axon-message/grok-4.6']);
    expect(isDispatchBlocked(applied)).toBe(false);
  });

  it('treats an empty intersection as blocked automatic dispatch', () => {
    const applied = applyLease(child({ allowedModels: ['gpt-5.6-sol'] }), {
      name: 'explore',
      allowedModels: ['grok-4.6'],
    });
    expect(applied.allowedModels).toEqual([]);
    expect(isDispatchBlocked(applied)).toBe(true);
  });

  it('makes a * subagents overlay unrestricted', () => {
    const applied = applyLease(child(), { name: 'explore', subagents: null });
    expect(applied.subagents).toBeUndefined();
  });

  it('overrides a child model pin with the lease pin', () => {
    const applied = applyLease(child({ modelAlias: 'gpt-5.6-sol' }), {
      name: 'explore',
      modelAlias: 'grok-4.6',
    });
    expect(applied.modelAlias).toBe('grok-4.6');
  });

  it('wraps slot 4 around the already composed role body', () => {
    const applied = applyLease(child(), {
      name: 'explore',
      promptMode: 'prepend',
      prompt: 'LEASE PREPEND',
    });
    expect(applied.systemPrompt({})).toBe('LEASE PREPEND\n\nEXPLORE BODY');
  });

  it('wraps with parent_prompt exactly once', () => {
    const applied = applyLease(child(), {
      name: 'explore',
      promptMode: 'wrap',
      prompt: 'BEFORE\n${parent_prompt}\nAFTER',
    });
    expect(applied.systemPrompt({})).toBe('BEFORE\nEXPLORE BODY\nAFTER');
  });
});

describe('leaseHasBindingPin', () => {
  it('is false for description-only leases and true when a pin field is set', () => {
    expect(leaseHasBindingPin({ name: 'explore', whenToUse: 'scope unknown trees' })).toBe(false);
    expect(leaseHasBindingPin({ name: 'explore', modelAlias: 'grok-4.6' })).toBe(true);
    expect(leaseHasBindingPin({ name: 'explore', thinkingEffort: 'high' })).toBe(true);
  });
});

describe('fillLeasePins', () => {
  it('fills omitted tool args and leaves explicit args in place', () => {
    const lease: SubagentLease = {
      name: 'explore',
      modelAlias: 'grok-4.6',
      thinkingEffort: 'high',
    };
    expect(fillLeasePins({}, lease)).toEqual({
      modelAlias: 'grok-4.6',
      thinkingEffort: 'high',
    });
    expect(fillLeasePins({ modelAlias: 'k3-256k' }, lease)).toEqual({
      modelAlias: 'k3-256k',
      thinkingEffort: 'high',
    });
    expect(
      fillLeasePins({}, lease, { lockedModelAlias: 'deepseek-v4-pro' }),
    ).toEqual({
      modelAlias: undefined,
      thinkingEffort: 'high',
    });
  });
});

describe('spawn policy', () => {
  it('intersects parent and child constraints monotonically', () => {
    const parent = { allowedModels: ['grok-4.6', 'grok-4.6-fast'], disallowedTools: ['Write'] };
    const childPolicy = { allowedModels: ['grok-4.6', 'gpt-5.6-sol'], denyModels: ['k3-256k'] };
    expect(intersectSpawnPolicy(parent, childPolicy)).toEqual({
      allowedModels: ['grok-4.6'],
      denyModels: ['k3-256k'],
      disallowedTools: ['Write'],
    });
  });

  it('tightens the spawned child without consuming the child file spawn_constraints', () => {
    const profile = child({ spawnConstraints: { allowedModels: ['k3-256k'] } });
    const applied = applySpawnPolicy(profile, { allowedModels: ['gpt-5.6-sol'] });
    expect(applied.allowedModels).toEqual(['gpt-5.6-sol']);
    expect(applied.spawnConstraints).toEqual({ allowedModels: ['k3-256k'] });
  });

  it('filters a route whose lock is outside the effective allowlist', () => {
    const applied = applyLease(child(), { name: 'explore', allowedModels: ['grok-4.6'] });
    expect(routePermittedByProfile({ modelAlias: 'grok-4.6' }, applied)).toBe(true);
    expect(routePermittedByProfile({ modelAlias: 'gpt-5.6-sol' }, applied)).toBe(false);
  });
});

describe('appliedDispatchProfile', () => {
  it('uses the bound caller lease table rather than the catalog default', () => {
    const catalogChild = child();
    const result = appliedDispatchProfile(
      catalogChild,
      'explore',
      {
        profileName: 'grok-play',
        subagentLeases: { explore: { name: 'explore', modelAlias: 'grok-4.6-fast' } },
        spawnPolicy: { allowedModels: ['grok-4.6', 'grok-4.6-fast'] },
      },
      {
        subagentLeases: { explore: { name: 'explore', modelAlias: 'should-not-apply' } },
        spawnConstraints: { allowedModels: ['gpt-5.6-sol'] },
      },
    );
    expect(result.profile.modelAlias).toBe('grok-4.6-fast');
    expect(result.profile.allowedModels).toEqual(['grok-4.6']);
    expect(result.lease?.modelAlias).toBe('grok-4.6-fast');
  });

  it('falls back to the default profile leases when the caller is unbound', () => {
    const result = appliedDispatchProfile(
      child({ allowedModels: undefined, modelAlias: undefined }),
      'explore',
      {},
      {
        subagentLeases: { explore: { name: 'explore', modelAlias: 'grok-4.6' } },
      },
    );
    expect(result.profile.modelAlias).toBe('grok-4.6');
  });
});
