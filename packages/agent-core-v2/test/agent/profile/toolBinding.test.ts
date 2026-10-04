import { describe, expect, it } from 'vitest';

import { parseAgentFileText } from '@kiki/agent-profiles/agentFile';
import { resolveAgentProfileRoute } from '@kiki/agent-profiles/agentProfileRoute';
import { isToolActive } from '@kiki/agent-profiles/toolPolicy';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { effectiveToolBinding, mergeToolBindingOverride } from '#/agent/profile/toolBinding';

function routedProfile(toolAllowPolicies?: readonly (readonly string[])[]) {
  return resolveAgentProfileRoute({ id: 'route', profile: 'base', description: 'Base route', path: '/routes/base.md', promptMode: 'inherit', prompt: '', overriddenFields: [] }, normalizeAgentProfile({ name: 'base', tools: ['Read'], toolAllowPolicies, systemPrompt: () => 'base' })).effectiveProfile;
}

describe('call-layer tool binding', () => {
  it('replaces the routed default selection rather than retaining its synthetic duplicate ceiling', () => {
    const route = routedProfile();
    const effective = effectiveToolBinding(route, { tools: ['*'] }, route);
    expect(isToolActive(effective, 'Grep')).toBe(true);
    expect(isToolActive(effectiveToolBinding(route, undefined, route), 'Grep')).toBe(false);
  });

  it('retains a real independent ceiling even if its names equal the routed selection', () => {
    const route = routedProfile([['Read']]);
    const effective = effectiveToolBinding(route, { tools: ['*'] }, route);
    expect(effective.toolAllowPolicies).toEqual([['Read']]);
    expect(isToolActive(effective, 'Grep')).toBe(false);
    expect(isToolActive(effective, 'Read')).toBe(true);
  });

  it('keeps profile-file caller ceilings and baseline denies under an explicit open selection', () => {
    const root = parseAgentFileText({ path: '/profiles/file.md', source: 'explicit', text: '---\nname: file\ndescription: File profile\n---\nFile' });
    const effective = effectiveToolBinding({ tools: ['Read'], disallowedTools: ['Write'] }, { tools: ['*'], disallowedTools: ['Bash'] }, {
      fileSources: { root, callerCeiling: { activeToolNames: ['Read', 'Grep'], toolAllowPolicies: [['Read']] }, scopedBindings: {}, sourceDefinitions: {}, dependencyIndex: {}, diagnostics: [] },
    });
    expect(isToolActive(effective, 'Read')).toBe(true);
    expect(isToolActive(effective, 'Grep')).toBe(false);
    expect(isToolActive(effective, 'Write')).toBe(false);
    expect(effective.disallowedTools).toEqual(['Write', 'Bash']);
  });

  it('preserves omitted fields and only clears the explicitly supplied call layer', () => {
    const previous = { tools: ['*', 'ThreadRead'], disallowedTools: ['Bash'] };
    expect(mergeToolBindingOverride(previous, {})).toBe(previous);
    expect(mergeToolBindingOverride(previous, { disallowedTools: [] })).toEqual({ tools: previous.tools, disallowedTools: [] });
    expect(mergeToolBindingOverride(previous, { tools: [] })).toEqual({ tools: [], disallowedTools: previous.disallowedTools });
  });
});
