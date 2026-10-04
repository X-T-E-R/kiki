import { describe, expect, it } from 'vitest';
import { upgradePersistedSubagentPermissions } from '../src/persistedSubagentPermissions';

describe('persisted subagent permissions', () => {
  it('upgrades the frozen definition graph without touching identity, prompts, models or dispatch provenance', () => {
    const decision = { version: 1, selectionKind: 'profile_file', requestedProfile: 'reviewer', allowed: true };
    const input = {
      profileName: 'reviewer', modelAlias: 'historical-model', profileDefinitionId: 'root-id',
      systemPrompt: 'frozen rendered prompt', subagentPolicy: 'advisory', subagents: ['explore'],
      dispatchDecision: decision, requestParams: { subagents: 'opaque-provider-value' },
      boundProfile: {
        name: 'reviewer', definitionId: 'root-id', modelAlias: 'historical-model',
        subagents: [], fileDefinition: { name: 'reviewer', prompt: 'ROOT', subagents: [] },
        subagentLeases: { explore: { name: 'explore', source: './_private/explore.md', subagents: [] } },
        fileSources: {
          root: { name: 'reviewer', definitionId: 'root-id', prompt: 'ROOT', subagents: [] },
          sourceDefinitions: { 'source-id': { name: 'explore', definitionId: 'source-id', prompt: 'SOURCE', subagents: ['reviewer'] } },
          scopedBindings: { 'root-id': { explore: { source: './_private/explore.md', sourceDefinitionId: 'source-id', lease: { name: 'explore', subagents: [] } } } },
          dependencyIndex: { 'source-id': ['root-id'] }, diagnostics: [],
        },
      },
    };
    const output = upgradePersistedSubagentPermissions(input) as unknown as Record<string, unknown>;
    expect(output).toMatchObject({ profileName: 'reviewer', modelAlias: 'historical-model', profileDefinitionId: 'root-id',
      systemPrompt: 'frozen rendered prompt', preferredSubagents: ['explore'], requestParams: input.requestParams,
      boundProfile: { name: 'reviewer', definitionId: 'root-id', modelAlias: 'historical-model', canSpawnSubagents: false,
        fileDefinition: { prompt: 'ROOT', canSpawnSubagents: false },
        subagentLeases: { explore: { source: './_private/explore.md', canSpawnSubagents: false } },
        fileSources: { root: { definitionId: 'root-id', canSpawnSubagents: false },
          sourceDefinitions: { 'source-id': { definitionId: 'source-id', prompt: 'SOURCE', allowedSubagents: ['reviewer'] } },
          scopedBindings: { 'root-id': { explore: { sourceDefinitionId: 'source-id', lease: { canSpawnSubagents: false } } } },
          dependencyIndex: input.boundProfile.fileSources.dependencyIndex } } });
    expect(output['dispatchDecision']).toEqual(decision);
    expect(output).not.toHaveProperty('subagents');
    expect(upgradePersistedSubagentPermissions(output)).toEqual(output);
    expect(input.boundProfile.subagents).toEqual([]);
  });

  it('retains already explicit permissions and upgrades old empty hard lists to a full leaf', () => {
    expect(upgradePersistedSubagentPermissions({ subagents: [], subagentPolicy: 'strict' })).toEqual({ allowedSubagents: [], canSpawnSubagents: false });
    expect(upgradePersistedSubagentPermissions({ subagentDeclaration: { kind: 'all' }, subagents: [], allowedSubagents: ['explore'] })).toEqual({ allowedSubagents: ['explore'] });
  });
});
