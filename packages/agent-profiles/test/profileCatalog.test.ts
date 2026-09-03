import { describe, expect, it } from 'vitest';

import { normalizeAgentProfile, type AgentProfile } from '#/agentProfile';
import { AGENT_PROFILE_SOURCE_PRIORITY } from '#/agentProfileContribution';
import {
  BUILTIN_AGENT_PROFILE_SOURCE_ID,
  projectAgentProfileCatalog,
  type AgentProfileRegistration,
} from '#/profileCatalog';

function profile(name: string, override = false): AgentProfile {
  return normalizeAgentProfile({ name, override, systemPrompt: () => `prompt:${name}` });
}

function project(
  entries: readonly AgentProfileRegistration[],
  options?: {
    readonly disabledBuiltinProfiles?: readonly string[];
    readonly disabledNamedProfiles?: readonly string[];
  },
) {
  const warnings: string[] = [];
  const result = projectAgentProfileCatalog({
    entries,
    disabledBuiltinProfiles: new Set(options?.disabledBuiltinProfiles),
    disabledNamedProfiles: new Set(options?.disabledNamedProfiles),
    routeBaseMissingCode: 'agent_profile_route.base_missing',
    warn: (message) => warnings.push(message),
  });
  return { result, warnings };
}

describe('projectAgentProfileCatalog', () => {
  it('merges sources by priority and records suppressed candidates', () => {
    const low = profile('writer');
    const high = profile('writer');
    const { result } = project([
      {
        sourceId: 'user',
        priority: AGENT_PROFILE_SOURCE_PRIORITY.user,
        contribution: { profiles: [low] },
      },
      {
        sourceId: 'workspace',
        priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
        contribution: { profiles: [high] },
      },
    ]);

    expect(result.profiles.get('writer')).toBe(high);
    expect(result.inspections.get('writer')?.suppressed).toEqual([
      { sourceId: 'user', priority: AGENT_PROFILE_SOURCE_PRIORITY.user, reason: 'priority' },
    ]);
  });

  it('requires override true to replace a builtin profile', () => {
    const builtin = profile('agent');
    const candidate = profile('agent');
    const { result, warnings } = project([
      {
        sourceId: BUILTIN_AGENT_PROFILE_SOURCE_ID,
        priority: AGENT_PROFILE_SOURCE_PRIORITY.builtin,
        contribution: { profiles: [builtin] },
      },
      {
        sourceId: 'workspace',
        priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
        contribution: { profiles: [candidate] },
      },
    ]);

    expect(result.profiles.get('agent')).toBe(builtin);
    expect(result.defaultBindingProfile).toBe(builtin);
    expect(warnings).toHaveLength(1);
  });

  it('projects routes and reports a missing route base', () => {
    const base = profile('writer');
    const { result, warnings } = project([
      {
        sourceId: 'workspace',
        priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
        contribution: {
          profiles: [base],
          routes: [
            {
              id: 'writer.fast',
              profile: 'writer',
              description: 'fast',
              promptMode: 'inherit',
              prompt: '',
              overriddenFields: [],
              path: '/agents/.routes/writer/fast.md',
            },
            {
              id: 'missing.fast',
              profile: 'missing',
              description: 'missing',
              promptMode: 'inherit',
              prompt: '',
              overriddenFields: [],
              path: '/agents/.routes/missing/fast.md',
            },
          ],
        },
      },
    ]);

    expect(result.routes.get('writer.fast')?.effectiveProfile).toMatchObject({
      name: 'writer',
      routeId: 'writer.fast',
    });
    expect(result.routeDiagnostics).toEqual([
      expect.objectContaining({
        code: 'agent_profile_route.base_missing',
        routeId: 'missing.fast',
      }),
    ]);
    expect(warnings).toHaveLength(1);
  });
});
