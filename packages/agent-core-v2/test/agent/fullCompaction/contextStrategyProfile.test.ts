import { describe, expect, it } from 'vitest';
import { agentProfileFromFile } from '@kiki/agent-profiles/agentProfileFromFile';
import { parseAgentFileText } from '@kiki/agent-profiles/agentFile';
import { modelProfilePatchToWire, modelProfileToWire, modelProfileUpdateFromWire } from '@kiki/agent-profiles/modelPromptProjection';
import { namedAgentModelProfileSchema, updateNamedAgentModelProfileEntrySchema } from '@kiki/protocol';

import { AgentFullCompactionService } from '#/agent/fullCompaction/fullCompactionService';
import { AgentProfileService } from '#/agent/profile/profileService';

const profile = agentProfileFromFile(parseAgentFileText({
  path: '/agents/custom.md', source: 'user',
  text: '---\nname: custom\ndescription: Custom\ncontext_strategy: auto\nmodel_profiles:\n  - alias: test\n    context_strategy: fresh\n---\nbody',
}), () => ({ text: 'base', environment: { cwd: '', date: { disclosed: false } } }));

function resolveProfile(modelId: string, selected = profile) {
  const fake = {
    profileState: { boundProfile: selected, profileName: selected.name },
    activeProfile: selected,
    catalog: { get: () => selected },
    tryResolveRawModel: () => ({ id: modelId }),
    models: { resolveId: (id: string) => id },
  };
  return AgentProfileService.prototype.resolveContextStrategy.call(fake as unknown as AgentProfileService);
}

function resolveModelStrategy(
  model: { id: string; contextStrategy?: 'summarize' | 'auto' | 'fresh' } | undefined,
  record?: { contextStrategy?: 'summarize' | 'auto' | 'fresh'; overrides?: { contextStrategy?: 'summarize' | 'auto' | 'fresh' } },
) {
  const fake = {
    modelAlias: 'test',
    isExternalExecutor: false,
    tryResolveRawModel: () => model,
    models: { resolveId: (id: string) => id, get: () => record },
  };
  return AgentProfileService.prototype.resolveModelContextStrategy.call(fake as unknown as AgentProfileService);
}

function effective(
  agentId: string,
  strategy: ReturnType<typeof resolveProfile>,
  override: string | null,
  config: { contextStrategy?: 'summarize' | 'auto' | 'fresh'; subagentContextStrategy?: 'summarize' | 'auto' | 'fresh' } = { contextStrategy: 'auto', subagentContextStrategy: 'summarize' },
  executorId = 'native',
  modelStrategy?: 'summarize' | 'auto' | 'fresh',
) {
  const fake = {
    profile: {
      data: () => ({ executorId }),
      resolveContextStrategy: () => strategy,
      resolveModelContextStrategy: () => modelStrategy,
    },
    appConfig: { get: () => config },
    scope: { agentId }, states: { get: () => override },
  };
  return AgentFullCompactionService.prototype.getContextStrategy.call(fake as unknown as AgentFullCompactionService);
}

describe('context strategy profile precedence', () => {
  it('resolves a matching model-profile entry before its profile top level', () => {
    expect(resolveProfile('test')).toBe('fresh');
    expect(resolveProfile('different')).toBe('auto');
  });

  it('resolves model-level contextStrategy from the resolved model or stored record', () => {
    expect(resolveModelStrategy({ id: 'test', contextStrategy: 'fresh' })).toBe('fresh');
    expect(resolveModelStrategy(undefined, { contextStrategy: 'summarize' })).toBe('summarize');
    expect(resolveModelStrategy(undefined, { contextStrategy: 'summarize', overrides: { contextStrategy: 'fresh' } })).toBe('fresh');
  });

  it('keeps main session override first, then profile, then model, then child or global default', () => {
    expect(effective('main', resolveProfile('test'), 'summarize', undefined, 'native', 'auto')).toMatchObject({ strategy: 'summarize', source: 'session' });
    expect(effective('main', resolveProfile('test'), null, undefined, 'native', 'summarize')).toMatchObject({ strategy: 'fresh', source: 'profile' });
    expect(effective('main', undefined, null, { contextStrategy: 'auto' }, 'native', 'fresh')).toMatchObject({ strategy: 'fresh', source: 'model' });
    expect(effective('child-1', resolveProfile('test'), 'summarize', undefined, 'native', 'auto')).toMatchObject({ strategy: 'fresh', source: 'profile' });
    expect(effective('child-model', undefined, 'summarize', { subagentContextStrategy: 'summarize' }, 'native', 'fresh')).toMatchObject({ strategy: 'fresh', source: 'model' });
    expect(effective('child-2', undefined, 'fresh')).toMatchObject({ strategy: 'summarize', source: 'subagent' });
    expect(effective('child-3', undefined, 'summarize', {})).toMatchObject({ strategy: 'auto', source: 'subagent' });
    expect(effective('child-4', undefined, null, { subagentContextStrategy: 'fresh' })).toMatchObject({ strategy: 'fresh', source: 'subagent' });
    expect(effective('child-5', 'auto', null, {}, 'codex', 'fresh')).toMatchObject({ strategy: 'summarize', source: 'executor' });
    expect(effective('main', undefined, null)).toMatchObject({ strategy: 'auto', source: 'global' });
  });

  it('projects and round-trips context_strategy on model_profiles wire contracts', () => {
    const wire = namedAgentModelProfileSchema.parse(modelProfileToWire(profile.modelProfiles![0]!));
    expect(wire).toMatchObject({ alias: 'test', context_strategy: 'fresh' });
    const parsedUpdate = updateNamedAgentModelProfileEntrySchema.parse({ alias: 'test', context_strategy: 'summarize' });
    expect(modelProfileUpdateFromWire(parsedUpdate)).toMatchObject({ alias: 'test', contextStrategy: 'summarize' });
    const clearedUpdate = updateNamedAgentModelProfileEntrySchema.parse({ alias: 'test', context_strategy: null });
    expect(modelProfilePatchToWire(modelProfileUpdateFromWire(clearedUpdate))).toMatchObject({ alias: 'test', context_strategy: null });
  });
});
