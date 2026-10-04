import { describe, expect, it } from 'vitest';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { listAvailableSubagentTargets, resolveSubagentDispatch, resolveSubagentTarget } from '#/app/agentProfileCatalog/subagentDispatch';
import { parseSpawnConstraints, parseSubagentList, SubagentLeaseParseError } from '#/app/agentProfileCatalog/subagentLease';
import { ErrorCodes, isError2 } from '#/errors';
import type { IModelService } from '#/kosong/model/model';

const PATH = '/tmp/agents/team.md';

describe('parseSubagentList', () => {
  it('parses names without leases and a standalone wildcard without a ceiling', () => {
    expect(parseSubagentList('explore, worker-lite', PATH)).toEqual({ allowedSubagents: ['explore', 'worker-lite'] });
    expect(parseSubagentList(['*'], PATH).allowedSubagents).toBeUndefined();
    expect(parseSubagentList(['explore', '*', 'explore'], PATH).allowedSubagents).toBeUndefined();
    expect(parseSubagentList(['writer', 'writer'], PATH).allowedSubagents).toEqual(['writer']);
    expect(parseSubagentList(['*', 'writer', { name: 'writer', source: './_private/writer.md' }], PATH).subagentLeases?.['writer']?.source).toBe('./_private/writer.md');
  });
  it('keeps a named lease wildcard open locally, and an empty preset domain distinct from leaf', () => {
    const parsed = parseSubagentList([{ name: 'worker-lite', allowed_subagents: ['*'], tools: ['*'] }], PATH);
    expect(parsed.subagentLeases?.['worker-lite']?.allowedSubagents).toBeUndefined();
    expect(parsed.subagentLeases?.['worker-lite']?.tools).toBeNull();
    const empty = parseSubagentList([{ name: 'worker-lite', allowed_subagents: [] }], PATH).subagentLeases?.['worker-lite'];
    expect(empty?.allowedSubagents).toEqual([]);
    expect(empty?.canSpawnSubagents).toBeUndefined();
  });
  it('parses a source lease with its overlay', () => {
    expect(parseSubagentList([{ name: 'research-writer', source: './_private/writer.md', model_alias: 'model-a' }], PATH).subagentLeases?.['research-writer'])
      .toMatchObject({ name: 'research-writer', source: './_private/writer.md', modelAlias: 'model-a' });
  });
  it.each(['/tmp/writer.md', 'C:\\tmp\\writer.md', '~/writer.md', 'https://example.test/writer.md', '${HOME}/writer.md', '%USERPROFILE%/writer.md', './writer.txt'])('rejects unsafe source path %s', (source) => {
    expect(() => parseSubagentList([{ name: 'writer', source }], PATH)).toThrow(SubagentLeaseParseError);
  });
  it('rejects duplicate aliases, mappings without names and removed lease fields', () => {
    expect(() => parseSubagentList([{ name: 'writer', source: './_private/writer.md' }, { name: 'writer', source: './_private/other.md' }], PATH)).toThrow(/more than one lease/);
    expect(() => parseSubagentList([{ model_alias: 'model-a' }], PATH)).toThrow(SubagentLeaseParseError);
    expect(() => parseSubagentList([{ name: 'writer', subagents: [] }], PATH)).toThrow(/unknown key "subagents"/);
  });
});

describe('parseSpawnConstraints', () => {
  it('parses the closed field set without changing the model/tool axis', () => {
    expect(parseSpawnConstraints({ allowed_models: ['model-a'], deny_models: ['model-b'], allowed_efforts: ['high'], disallowed_tools: ['Bash'] }, PATH))
      .toEqual({ allowedModels: ['model-a'], denyModels: ['model-b'], allowedEfforts: ['high'], disallowedTools: ['Bash'] });
    expect(() => parseSpawnConstraints({ model_alias: 'model-a' }, PATH)).toThrow(/unknown key "model_alias"/);
    expect(parseSpawnConstraints({ allowed_models: [] }, PATH)).toEqual({ allowedModels: [] });
    expect(parseSpawnConstraints({ allowed_models: '*' }, PATH)).toBeUndefined();
    expect(parseSpawnConstraints({ deny_models: [] }, PATH)).toBeUndefined();
  });
});

const publicProfile = normalizeAgentProfile({ name: 'writer', definitionId: 'public-writer', systemPrompt: () => 'PUBLIC' });
const privateProfile = normalizeAgentProfile({ name: 'writer', definitionId: 'private-writer', systemPrompt: () => 'PRIVATE' });
const brokenProfile = normalizeAgentProfile({ name: 'broken', definitionId: 'public-broken', systemPrompt: () => 'PUBLIC BROKEN' });
const snapshot = {
  publicProfiles: new Map([['writer', publicProfile], ['broken', brokenProfile]]),
  defaultProfile: publicProfile,
  routes: new Map(),
  scopedBindings: new Map([['parent-definition', new Map([
    ['writer', { parentDefinitionId: 'parent-definition', alias: 'writer', source: './_private/writer.md', lease: { name: 'writer', source: './_private/writer.md' }, status: 'ready' as const, sourceDefinitionId: 'private-writer', profile: privateProfile }],
    ['broken', { parentDefinitionId: 'parent-definition', alias: 'broken', source: './_private/broken.md', lease: { name: 'broken', source: './_private/broken.md' }, status: 'unavailable' as const }],
  ])]]),
  sourceDefinitions: new Map([['private-writer', privateProfile]]), dependencyIndex: new Map(), diagnostics: [],
};
const catalog = {
  get: (name: string) => snapshot.publicProfiles.get(name), getDefault: () => publicProfile,
  list: () => [...snapshot.publicProfiles.values()], snapshot: () => snapshot,
  resolveSelection: () => ({ profile: publicProfile, baseProfile: publicProfile }),
};

describe('resolveSubagentDispatch', () => {
  it('allows preference-only exceptions even under a former host strict default', () => {
    const caller = { profileName: 'parent', preferredSubagents: ['writer'], defaultPolicy: 'strict' as const };
    expect(resolveSubagentDispatch(catalog, caller, { profileName: 'writer' }).decision).toMatchObject({ policyMode: 'fixed', recommendationStatus: 'preferred', allowed: true });
    expect(resolveSubagentDispatch(catalog, caller, { profileName: 'broken' }).decision).toMatchObject({ recommendationStatus: 'allowed_nonpreferred', advisoryDeviation: true, allowed: true });
  });
  it('honors preset hard allow and deny after scoped alias resolution', () => {
    const caller = { profileName: 'parent', profileDefinitionId: 'parent-definition', allowedSubagents: ['writer', 'broken'], preferredSubagents: ['writer'], denySubagents: ['broken'] };
    const resolved = resolveSubagentDispatch(catalog, caller, { profileName: 'writer' });
    expect(resolved.scoped).toBe(true);
    expect(resolved.selection.profile.definitionId).toBe('private-writer');
    expect(() => resolveSubagentDispatch(catalog, { ...caller, denySubagents: ['writer'] }, { profileName: 'writer' }))
      .toThrowError(expect.objectContaining({ code: ErrorCodes.AGENT_TYPE_NOT_ALLOWED }));
    expect(() => resolveSubagentDispatch(catalog, { ...caller, allowedSubagents: [] }, { profileName: 'writer' }))
      .toThrowError(expect.objectContaining({ code: ErrorCodes.AGENT_TYPE_NOT_ALLOWED }));
  });
  it('does not fall back to a same-name public profile when scoped is unavailable', () => {
    expect(() => resolveSubagentDispatch(catalog, { profileName: 'parent', profileDefinitionId: 'parent-definition', allowedSubagents: ['broken'] }, { profileName: 'broken' }))
      .toThrowError(expect.objectContaining({ code: ErrorCodes.SCOPED_PROFILE_UNAVAILABLE }));
  });
  it('does not treat an explicit unregistered MD or its name as a selected preset', () => {
    for (const name of ['writer', 'temporary']) {
      const definition = normalizeAgentProfile({ name, systemPrompt: () => 'FILE' });
      const resolved = resolveSubagentDispatch(catalog, { profileName: 'parent', allowedSubagents: [], denySubagents: ['writer'], preferredSubagents: ['writer'] }, { resolvedProfile: definition, selectionKind: 'profile_file' });
      expect(resolved.selection.profile).toBe(definition);
      expect(resolved.decision).toMatchObject({ allowed: true, recommendationStatus: 'unconfigured', advisoryDeviation: false, selectionKind: 'profile_file' });
    }
  });
  it('closes every new selection with false without redefining resume', () => {
    for (const selectionKind of ['profile', 'route', 'scoped', 'profile_file'] as const) {
      expect(() => resolveSubagentDispatch(catalog, { profileName: 'parent', canSpawnSubagents: false }, { resolvedProfile: publicProfile, selectionKind }))
        .toThrowError(expect.objectContaining({ code: ErrorCodes.AGENT_TYPE_NOT_ALLOWED }));
    }
  });
  it('uses a route base preset identity for hard permission', () => {
    const route = { id: 'writer.fast', profile: 'writer', description: 'Route', overriddenFields: [], effectiveProfile: { ...publicProfile, routeId: 'writer.fast' } };
    const routed = { ...catalog, snapshot: undefined, resolveSelection: () => ({ profile: route.effectiveProfile, baseProfile: publicProfile, route }) };
    expect(() => resolveSubagentDispatch(routed, { profileName: 'parent', allowedSubagents: ['writer.fast'] }, { routeId: 'writer.fast' })).toThrowError(expect.objectContaining({ code: ErrorCodes.AGENT_TYPE_NOT_ALLOWED }));
    expect(resolveSubagentDispatch(routed, { profileName: 'parent', allowedSubagents: ['writer'] }, { routeId: 'writer.fast' }).decision.requestedProfile).toBe('writer');
  });
  it('reports the effective hard domain in a structured error', () => {
    try {
      resolveSubagentDispatch(catalog, { profileName: 'parent', allowedSubagents: [] }, { profileName: 'writer' });
      throw new Error('expected dispatch rejection');
    } catch (error) {
      expect(isError2(error)).toBe(true);
      if (isError2(error)) expect(error.details).toMatchObject({ profileName: 'writer', allowlist: [], dispatchDecision: { policyMode: 'fixed', recommendationStatus: 'blocked' } });
    }
  });
});

describe('resolved subagent targets', () => {
  const models = { resolveId: (id: string) => id } as unknown as IModelService;
  const worker = normalizeAgentProfile({ name: 'worker', tools: ['Read', 'Write'], modelAlias: 'base-model', allowedModels: ['base-model', 'leased-model'], systemPrompt: () => 'WORKER' });
  const main = normalizeAgentProfile({ name: 'agent', main: true, systemPrompt: () => 'MAIN' });
  const reviewer = normalizeAgentProfile({ name: 'reviewer', systemPrompt: () => 'REVIEWER' });
  const local = {
    get: (name: string) => [main, worker, reviewer].find((profile) => profile.name === name), getDefault: () => main, list: () => [main, worker, reviewer],
    resolveSelection: ({ profile }: { profile?: string }) => { const selected = [main, worker, reviewer].find((item) => item.name === profile)!; return { profile: selected, baseProfile: selected }; },
  };
  it('cannot open a leaf with a caller lease and does not mechanically propagate the parent preset list', () => {
    const leaf = { ...worker, canSpawnSubagents: false };
    const target = resolveSubagentTarget(local, { profileName: 'parent', allowedSubagents: ['worker'], subagentLeases: { worker: { name: 'worker', canSpawnSubagents: true, allowedSubagents: ['reviewer'] } } }, { resolvedProfile: leaf }, models);
    expect(target.effectiveProfile.canSpawnSubagents).toBe(false);
    const independent = resolveSubagentTarget(local, { profileName: 'parent', allowedSubagents: ['worker'] }, { profileName: 'worker' }, models);
    expect(independent.effectiveProfile.allowedSubagents).toBeUndefined();
  });
  it('returns the effective profile after caller lease and spawn constraints', () => {
    const lease = { name: 'worker', tools: ['Read'], modelAlias: 'leased-model' };
    const spawnPolicy = { allowedModels: ['leased-model'], disallowedTools: ['Bash'] };
    const target = resolveSubagentTarget(local, { profileName: 'parent', allowedSubagents: ['worker'], subagentLeases: { worker: lease }, spawnPolicy }, { profileName: 'worker' }, models);
    expect(target.selection.profile).toBe(worker);
    expect(target.effectiveProfile).toMatchObject({ name: 'worker', tools: ['Read'], modelAlias: 'leased-model', allowedModels: ['leased-model'], disallowedTools: ['Bash'] });
    expect(target.lease).toBe(lease);
    expect(target.spawnPolicy).toBe(spawnPolicy);
  });
  it('does not apply a preset caller lease to an MD that happens to share its name', () => {
    const definition = { ...worker, modelAlias: 'base-model', allowedSubagents: ['reviewer'] };
    const target = resolveSubagentTarget(local, { profileName: 'parent', allowedSubagents: [], subagentLeases: { worker: { name: 'worker', modelAlias: 'leased-model', canSpawnSubagents: false } }, spawnPolicy: { disallowedTools: ['Bash'] } }, { resolvedProfile: definition, selectionKind: 'profile_file' }, models);
    expect(target.lease).toBeUndefined();
    expect(target.effectiveProfile).toMatchObject({ modelAlias: 'base-model', allowedSubagents: ['reviewer'], disallowedTools: ['Bash'] });
    expect(target.effectiveProfile.canSpawnSubagents).toBeUndefined();
  });
  it('filters preset catalogs by hard policy and sorts by soft preference', () => {
    const caller = { profileName: 'parent', allowedSubagents: ['worker', 'reviewer'], preferredSubagents: ['reviewer'], denySubagents: ['worker'] };
    expect(listAvailableSubagentTargets(local, caller, { profiles: local.list(), routes: [{ id: 'worker.route', profile: 'worker', description: 'Route', overriddenFields: [] }] }, models).profiles.map((item) => item.name)).toEqual(['reviewer']);
  });
  it('keeps unavailable scoped aliases out of the catalog without public fallback', () => {
    const caller = { profileName: 'parent', profileDefinitionId: 'parent-definition', allowedSubagents: ['broken'] };
    expect(listAvailableSubagentTargets(catalog, caller, { profiles: catalog.list(), routes: [], snapshot }, models).profiles).toEqual([]);
    expect(() => resolveSubagentTarget(catalog, caller, { profileName: 'broken', snapshot }, models)).toThrowError(expect.objectContaining({ code: ErrorCodes.SCOPED_PROFILE_UNAVAILABLE }));
  });
});
