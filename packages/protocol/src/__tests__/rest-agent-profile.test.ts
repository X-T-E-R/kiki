import { describe, expect, it } from 'vitest';

import {
  agentCapabilityReasonCodeSchema,
  agentCapabilitiesProducerResponseSchema,
  agentCapabilitiesQuerySchema,
  agentCapabilitiesResponseSchema,
  agentProfileSourceDiagnosticCodeSchema,
  listNamedAgentProfilesQuerySchema,
  listNamedAgentProfilesResponseSchema,
  namedAgentProfileSchema,
  patchConfigRequestSchema,
} from '../index';

describe('named agent profile REST protocol', () => {
  it('keeps unknown panel metrics nullable and strips dynamic prompt and credential fields', () => {
    const parsed = agentCapabilitiesResponseSchema.parse({
      context: 'live', owner: { agent_id: 'child' }, available: false, targets: [],
      profile: { name: 'researcher', source: 'workspace', systemPrompt: 'private dynamic context', executor_options: { api_key: 'PRIVATE' } },
      tools: [{ name: 'Read', source: 'builtin', category: 'read', state: 'approval-required' }],
      skills: [{ name: 'workspace-skill', description: 'Example', source: 'project', scope: 'workspace', path: 'skills/example', state: 'disabled' }],
      metrics: { child: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
        totalTokens: null, totalCostUsd: null, contextTokens: null, contextLimit: null, compactionCount: null } },
    });
    expect(parsed.profile).toEqual({ name: 'researcher', source: 'workspace' });
    expect(parsed.metrics?.['child']?.totalTokens).toBeNull();
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE');
    expect(JSON.stringify(parsed)).not.toContain('private dynamic context');
  });

  it('parses merged workspace applicability and the expanded-list query flag', () => {
    expect(listNamedAgentProfilesQuerySchema.parse({
      expand: '1',
      workspace_id: 'wd_a',
    })).toEqual({ expand: true, workspace_id: 'wd_a' });
    expect(listNamedAgentProfilesQuerySchema.parse({})).toEqual({});
    expect(() => listNamedAgentProfilesQuerySchema.parse({ workspace_id: '' })).toThrow();
    expect(namedAgentProfileSchema.parse({
      name: 'reviewer',
      source: 'user',
      workspace_id: 'wd_a',
      workspace_ids: ['wd_a', 'wd_b'],
      main: true,
      subagent_policy: 'advisory',
      model_profiles: [{
        alias: 'fast',
        when: 'Use for small tasks',
        thinking_effort: 'low',
      }],
      spawn_constraints: {
        allowed_models: ['fast'],
        allowed_efforts: ['low'],
      },
      subagents: [
        'explore',
        {
          name: 'reviewer',
          model_alias: 'fast',
          tools: null,
          diagnostic: 'Source path is invalid',
          diagnostic_code: 'agent_profile_source.invalid_path',
          model_profiles: [{ alias: 'fast', when: 'Use for reviews' }],
        },
      ],
      disabled: true,
      routes: [],
    })).toMatchObject({
      workspace_ids: ['wd_a', 'wd_b'],
      main: true,
      subagent_policy: 'advisory',
      model_profiles: [{ alias: 'fast', when: 'Use for small tasks' }],
      spawn_constraints: { allowed_models: ['fast'] },
      subagents: ['explore', { name: 'reviewer', model_alias: 'fast' }],
      disabled: true,
    });
    expect(agentProfileSourceDiagnosticCodeSchema.options).toHaveLength(8);
    expect(namedAgentProfileSchema.safeParse({
      name: 'reviewer',
      source: 'user',
      subagent_policy: 'legacy',
      disabled: false,
      routes: [],
    }).success).toBe(false);
  });

  it('requires catalog responses to declare whether their projection is complete', () => {
    expect(listNamedAgentProfilesResponseSchema.parse({ items: [], complete: false }))
      .toEqual({ items: [], complete: false });
    expect(listNamedAgentProfilesResponseSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it('validates exclusive workspace and live capability addresses', () => {
    expect(listNamedAgentProfilesQuerySchema.parse({ cwd: 'C:/workspace', effective: 'true' }))
      .toEqual({ cwd: 'C:/workspace', effective: true });
    for (const query of [
      { cwd: 'relative' }, { cwd: '/workspace', workspace_id: 'wd_a' },
      { effective: true }, { effective: true, expand: true, cwd: '/workspace' },
    ]) expect(listNamedAgentProfilesQuerySchema.safeParse(query).success).toBe(false);
    for (const query of [
      { session_id: 'session', agent_id: 'main' },
      { cwd: '/workspace', profile: 'lead' }, { workspace_id: 'wd_a', profile: 'lead' },
    ]) expect(agentCapabilitiesQuerySchema.safeParse(query).success).toBe(true);
    for (const query of [
      {}, { session_id: 'session' }, { cwd: 'relative', profile: 'lead' },
      { session_id: 'session', agent_id: 'main', cwd: '/workspace' },
      { cwd: '/workspace', workspace_id: 'wd_a', profile: 'lead' },
    ]) expect(agentCapabilitiesQuerySchema.safeParse(query).success).toBe(false);
  });

  it('separates live launch admission from defaults without inventing draft policy', () => {
    const target = { profile: 'helper', executor: 'native', defaults_available: false,
      dispatch_policy: 'advisory', recommendation_status: 'allowed_nonpreferred', advisory_deviation: true,
      launch_allowed: true, execution_restriction: 'research-readonly' };
    expect(agentCapabilitiesResponseSchema.parse({ context: 'live', owner: { profile: 'lead' }, available: true,
      targets: [target] }).targets[0]).toEqual(target);
    expect(agentCapabilitiesResponseSchema.parse({ context: 'draft', owner: { profile: 'lead' }, available: true,
      targets: [{ profile: 'helper', executor: 'native', defaults_available: true }] }).targets[0])
      .not.toHaveProperty('launch_allowed');
    expect(agentCapabilitiesQuerySchema.safeParse({ session_id: 'session', agent_id: 'main', planActive: false }).success).toBe(false);
  });

  it('validates stable capability reason codes across capability projections', () => {
    const parsed = agentCapabilitiesResponseSchema.parse({
      context: 'live', owner: { agent_id: 'main' }, available: false,
      unavailable_reason: 'Disabled by effective tool policy', unavailable_reason_code: 'tool_policy_disabled',
      targets: [{
        profile: 'helper', executor: 'native', defaults_available: false,
        unavailable_reason: 'No default model is bound; pass model_alias explicitly',
        unavailable_reason_code: 'model_not_configured', launch_allowed: false,
        launch_unavailable_reason: 'Blocked by strict subagent policy',
        launch_unavailable_reason_code: 'strict_subagent_policy_blocked',
      }],
      tools: [{ name: 'AgentRun', source: 'builtin', category: 'agent', state: 'disabled',
        unavailable_reason: 'Disabled by effective tool policy', unavailable_reason_code: 'tool_policy_disabled' }],
      skills: [{ name: 'workspace-skill', description: 'Example', source: 'project', scope: 'workspace',
        path: 'skills/example', state: 'disabled', unavailable_reason: 'Skill tool is not active for this agent',
        unavailable_reason_code: 'skill_tool_inactive' }],
    });
    expect(parsed.unavailable_reason_code).toBe('tool_policy_disabled');
    expect(parsed.targets[0]?.unavailable_reason_code).toBe('model_not_configured');
    expect(parsed.targets[0]?.launch_unavailable_reason_code).toBe('strict_subagent_policy_blocked');
    expect(parsed.tools?.[0]?.unavailable_reason_code).toBe('tool_policy_disabled');
    expect(parsed.skills?.[0]?.unavailable_reason_code).toBe('skill_tool_inactive');
    expect(agentCapabilityReasonCodeSchema.options).toHaveLength(25);

    const futurePayload = {
      context: 'live' as const,
      owner: { agent_id: 'main' },
      available: false,
      unavailable_reason: 'Future top-level reason',
      unavailable_reason_code: 'future_top_level_reason',
      targets: [{
        profile: 'helper', executor: 'native', defaults_available: false,
        unavailable_reason: 'Future binding reason', unavailable_reason_code: 'future_binding_reason',
        launch_allowed: false, launch_unavailable_reason: 'Future launch reason',
        launch_unavailable_reason_code: 'future_launch_reason',
      }],
      tools: [{ name: 'AgentRun', source: 'builtin', category: 'agent', state: 'disabled' as const,
        unavailable_reason: 'Future tool reason', unavailable_reason_code: 'future_tool_reason' }],
      skills: [{ name: 'workspace-skill', description: 'Example', source: 'project', scope: 'workspace' as const,
        path: 'skills/example', state: 'disabled' as const,
        unavailable_reason: 'Future skill reason', unavailable_reason_code: 'future_skill_reason' }],
    };
    const futureParsed = agentCapabilitiesResponseSchema.parse(futurePayload);
    expect(futureParsed.unavailable_reason_code).toBe('future_top_level_reason');
    expect(futureParsed.targets[0]?.launch_unavailable_reason_code).toBe('future_launch_reason');
    expect(futureParsed.tools?.[0]?.unavailable_reason_code).toBe('future_tool_reason');
    expect(futureParsed.skills?.[0]?.unavailable_reason_code).toBe('future_skill_reason');
    expect(agentCapabilitiesProducerResponseSchema.safeParse(futurePayload).success).toBe(false);
    expect(agentCapabilityReasonCodeSchema.safeParse('future_tool_reason').success).toBe(false);
  });

  it('accepts the named-profile disable config patch', () => {
    expect(patchConfigRequestSchema.parse({
      disabled_named_profiles: ['reviewer'],
    })).toEqual({ disabled_named_profiles: ['reviewer'] });
  });
});
