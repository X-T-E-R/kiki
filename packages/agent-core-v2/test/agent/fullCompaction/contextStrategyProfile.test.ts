import { describe, expect, it } from 'vitest';
import { agentProfileFromFile } from '@kiki/agent-profiles/agentProfileFromFile';
import { parseAgentFileText } from '@kiki/agent-profiles/agentFile';

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

function effective(agentId: string, strategy: ReturnType<typeof resolveProfile>, override: string | null) {
  const fake = {
    profile: { data: () => ({ executorId: 'native' }), resolveContextStrategy: () => strategy },
    appConfig: { get: () => ({ contextStrategy: 'auto', subagentContextStrategy: 'summarize' }) },
    scope: { agentId }, states: { get: () => override },
  };
  return AgentFullCompactionService.prototype.getContextStrategy.call(fake as unknown as AgentFullCompactionService);
}

describe('context strategy profile precedence', () => {
  it('resolves a matching model-profile entry before its profile top level', () => {
    expect(resolveProfile('test')).toBe('fresh');
    expect(resolveProfile('different')).toBe('auto');
  });

  it('keeps main session override first and reads only each child profile or child default', () => {
    expect(effective('main', resolveProfile('test'), 'summarize')).toMatchObject({ strategy: 'summarize', source: 'session' });
    expect(effective('main', resolveProfile('test'), null)).toMatchObject({ strategy: 'fresh', source: 'profile' });
    expect(effective('child-1', resolveProfile('test'), 'summarize')).toMatchObject({ strategy: 'fresh', source: 'profile' });
    expect(effective('child-2', undefined, 'fresh')).toMatchObject({ strategy: 'summarize', source: 'subagent' });
    expect(effective('main', undefined, null)).toMatchObject({ strategy: 'auto', source: 'global' });
  });
});
