import { describe, expect, it } from 'vitest';

import { normalizeAgentProfile, type AgentProfile } from '#/agentProfile';
import { AGENT_PROFILE_SOURCE_PRIORITY } from '#/agentProfileContribution';
import {
  projectAgentProfileCatalog,
  type AgentProfileRegistration,
} from '#/profileCatalog';

function profile(name: string, override = false): AgentProfile {
  return normalizeAgentProfile({ name, override, systemPrompt: () => `prompt:${name}` });
}

function project(
  entries: readonly AgentProfileRegistration[],
  options?: {
    readonly disabledNamedProfiles?: readonly string[];
  },
) {
  const warnings: string[] = [];
  const result = projectAgentProfileCatalog({
    entries,
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

  it('resolves same-name file candidates by priority without a builtin lane', () => {
    const user = profile('explore');
    const workspace = profile('explore');
    const { result, warnings } = project([
      {
        sourceId: 'user',
        priority: AGENT_PROFILE_SOURCE_PRIORITY.user,
        contribution: { profiles: [user] },
      },
      {
        sourceId: 'workspace',
        priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
        contribution: { profiles: [workspace] },
      },
    ]);

    expect(result.profiles.get('explore')).toBe(workspace);
    expect(warnings).toHaveLength(0);
  });

  it('diagnoses both paths when a contribution overrides a same-name file', () => {
    const scanned = { ...profile('agent'), sourcePath: '/agents/agent.md' };
    const system = { ...profile('agent'), sourcePath: '/SYSTEM.md' };
    const { result, warnings } = project([
      { sourceId: 'user', priority: 10, contribution: { profiles: [scanned, system] } },
    ]);
    expect(result.snapshot.defaultProfile?.sourcePath).toBe('/SYSTEM.md');
    expect(warnings).toEqual([expect.stringContaining('/agents/agent.md; keeping higher-priority /SYSTEM.md')]);
  });

  it('anchors the main flag on the default agent profile name', () => {
    const named = profile('agent');
    const { result } = project([
      { sourceId: 'user', priority: 10, contribution: { profiles: [named] } },
    ]);
    expect(result.profiles.get('agent')?.main).toBe(true);
    expect(result.snapshot.defaultProfile?.main).toBe(true);
  });

  it('keeps the disabled default agent on the main binding surface only', () => {
    const named = normalizeAgentProfile({ ...profile('agent'), tools: ['Read'] });
    const { result } = project([
      { sourceId: 'user', priority: 10, contribution: { profiles: [named] } },
    ], { disabledNamedProfiles: ['agent'] });
    expect(result.profiles.has('agent')).toBe(false);
    expect(result.resolvableProfiles.has('agent')).toBe(false);
    expect(result.snapshot.defaultProfile).toMatchObject({ main: true, tools: ['Read'] });
  });

  it('does not make an external executor eligible as a main profile', () => {
    const external = normalizeAgentProfile({ ...profile('agent'), executor: 'example-acp' });
    const { result, warnings } = project([
      { sourceId: 'user', priority: 10, contribution: { profiles: [external] } },
    ]);
    expect(result.profiles.get('agent')).toBeUndefined();
    expect(result.snapshot.defaultProfile).toBeUndefined();
    expect(warnings.join(' ')).toContain('unsupported for main');
  });

  it('keeps private profiles and routes resolvable while omitting them from public projections', () => {
    const hidden = normalizeAgentProfile({ ...profile('writer'), private: true });
    const route = {
      id: 'writer.fast',
      profile: 'writer',
      description: 'fast',
      promptMode: 'inherit' as const,
      prompt: '',
      overriddenFields: [],
      path: '/agents/.routes/writer/fast.md',
    };
    const { result } = project([
      {
        sourceId: 'user',
        priority: AGENT_PROFILE_SOURCE_PRIORITY.user,
        contribution: { profiles: [hidden], routes: [route] },
      },
    ]);

    expect(result.profiles.has('writer')).toBe(false);
    expect(result.resolvableProfiles.get('writer')).toBe(hidden);
    expect(result.routes.has('writer.fast')).toBe(true);
    expect(result.publicRoutes.has('writer.fast')).toBe(false);
    expect(result.snapshot.publicProfiles.has('writer')).toBe(false);
    expect(result.snapshot.resolvableProfiles?.get('writer')).toBe(hidden);
  });

  it('inherits the lower-priority prompt while preserving the winning profile constraints', () => {
    const lower = normalizeAgentProfile({
      name: 'writer',
      tools: ['Read'],
      promptOverrides: { fields: { 'system.language': 'lower', 'system.coding': 'lower coding' } },
      systemPrompt: () => 'LOWER',
    });
    const upper = normalizeAgentProfile({
      name: 'writer',
      override: true,
      tools: ['Bash'],
      systemPromptMode: 'inherit',
      promptOverrides: { fields: { 'system.language': 'upper' } },
      systemPrompt: () => 'UNRESOLVED',
    });
    const { result } = project([
      { sourceId: 'user', priority: 10, contribution: { profiles: [lower] } },
      { sourceId: 'workspace', priority: 30, contribution: { profiles: [upper] } },
    ]);

    expect(result.profiles.get('writer')).toMatchObject({
      tools: ['Bash'],
      systemPromptMode: 'inherit',
      promptOverrides: { fields: { 'system.language': 'upper' } },
    });
    expect(result.profiles.get('writer')?.promptOverrideLayers).toEqual([
      { fields: { 'system.language': 'lower', 'system.coding': 'lower coding' } },
      { fields: { 'system.language': 'upper' } },
    ]);
    expect(result.profiles.get('writer')?.systemPrompt({})).toBe('LOWER');
  });

  it('warns and skips inherit without a base while preserving other profiles', () => {
    const reviewer = profile('reviewer');
    const inherited = normalizeAgentProfile({
      name: 'writer',
      systemPromptMode: 'inherit',
      promptOverrides: { fields: { 'system.language': 'upper' } },
      systemPrompt: () => 'UNRESOLVED',
    });
    const { result, warnings } = project([
      { sourceId: 'workspace', priority: 30, contribution: { profiles: [inherited, reviewer] } },
    ]);
    expect(result.profiles.get('reviewer')).toBe(reviewer);
    expect(result.profiles.has('writer')).toBe(false);
    expect(warnings).toContainEqual(expect.stringMatching(/writer.*no lower-priority base profile/));
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
