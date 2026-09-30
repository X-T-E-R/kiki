import { describe, expect, it } from 'vitest';

import {
  normalizeAgentProfile,
  type AgentProfile,
  type AgentProfileRouteDefinition,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { resolveAgentProfileRoute } from '#/app/agentProfileCatalog/agentProfileRoute';
import { Error2, ErrorCodes, isError2 } from '#/errors';
import { IModelService } from '#/kosong/model/model';
import {
  resolveSubagentBinding,
  SUBAGENT_MODEL_UNBOUND_HINT,
  SUBAGENT_SECTION,
  type SubagentBindingRequest,
  type SubagentRoleModelConstraints,
} from '#/session/subagent/configSection';
import { roleBindingAdvisories } from '#/session/subagent/modelConstraints';
import { parseAgentRouteFileText } from '#/workspace/workspaceAgentProfileLoader/internal/agentRouteFile';

import { StubConfigService } from '../../kosong/stubs';

function models(aliases: Record<string, string> = {}): IModelService {
  return {
    resolveId: (id: string) => aliases[id],
  } as unknown as IModelService;
}

function config(denyModels?: readonly string[]): StubConfigService {
  return new StubConfigService(
    denyModels === undefined ? {} : { [SUBAGENT_SECTION]: { denyModels: [...denyModels] } },
  );
}

function configError(run: () => unknown): Error2 {
  try {
    run();
  } catch (error) {
    expect(isError2(error)).toBe(true);
    expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
    return error as Error2;
  }
  throw new Error('Expected CONFIG_INVALID');
}

const catalog = models({
  fast: 'provider/fast',
  'provider/fast': 'provider/fast',
  'fast-model': 'provider/fast',
  'k3-review': 'provider/k3',
  'provider/k3': 'provider/k3',
  blocked: 'provider/blocked',
  'provider/blocked': 'provider/blocked',
  'heavy-model': 'provider/heavy',
  'provider/heavy': 'provider/heavy',
});

function bindSubagent(
  requested: SubagentBindingRequest | undefined,
  constraints: SubagentRoleModelConstraints | undefined,
  profileRequest: SubagentBindingRequest = {},
  denyModels?: readonly string[],
) {
  return resolveSubagentBinding(
    config(denyModels),
    requested ?? {},
    profileRequest,
    catalog,
    constraints,
  );
}

function reviewer(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return normalizeAgentProfile({
    name: 'reviewer',
    description: 'reviewer',
    allowedModels: ['fast-model'],
    systemPrompt: () => 'BASE',
    ...overrides,
  });
}

function routePin(modelAlias: string): AgentProfileRouteDefinition {
  return {
    id: 'reviewer.ui-k3',
    profile: 'reviewer',
    description: 'pinned',
    promptMode: 'inherit',
    prompt: '',
    modelAlias,
    overriddenFields: ['model_alias'],
    path: '/agents/.routes/reviewer/ui-k3.md',
  };
}

describe('model-scoped effort defaults', () => {
  it('does not carry the profile default effort onto another model', () => {
    expect(bindSubagent(
      { modelAlias: 'provider/heavy' }, undefined,
      { modelAlias: 'fast-model', thinkingEffort: 'medium' },
    ).thinking).toBeUndefined();
  });

  it('matches canonical aliases and gives the model entry priority over the profile default', () => {
    const role = { modelProfiles: [{ alias: 'fast-model', when: 'fast', thinkingEffort: 'max' }] };
    expect(bindSubagent(
      { modelAlias: 'provider/fast' }, role,
      { modelAlias: 'fast', thinkingEffort: 'medium' },
    ).thinking).toBe('max');
    expect(bindSubagent(
      { modelAlias: 'provider/fast', thinkingEffort: 'low' }, role,
      { modelAlias: 'fast', thinkingEffort: 'medium' },
    ).thinking).toBe('low');
  });

  it('does not apply an unpinned profile effort to a dispatched model', () => {
    expect(bindSubagent(
      { modelAlias: 'fast' }, undefined, { thinkingEffort: 'medium' },
    ).thinking).toBeUndefined();
  });
});

describe('subagent model selection', () => {
  it('uses [subagent].default_model only for an unpinned spawn', () => {
    const configured = new StubConfigService({ [SUBAGENT_SECTION]: { defaultModel: 'fast-model' } });
    expect(resolveSubagentBinding(configured, {}, {}, catalog).model).toBe('fast-model');
    expect(resolveSubagentBinding(configured, {}, { modelAlias: 'provider/k3' }, catalog).model).toBe('provider/k3');
    expect(resolveSubagentBinding(configured, { modelAlias: 'provider/heavy' }, { modelAlias: 'provider/k3' }, catalog).model).toBe('provider/heavy');
  });

  it('fails closed with MODEL_NOT_CONFIGURED when no source supplies a model', () => {
    let thrown: unknown;
    try {
      resolveSubagentBinding(config(), {}, {}, catalog, undefined, { profileName: 'reviewer' });
    } catch (error) {
      thrown = error;
    }
    expect(isError2(thrown)).toBe(true);
    expect((thrown as Error2).code).toBe(ErrorCodes.MODEL_NOT_CONFIGURED);
    expect((thrown as Error2).message).toContain('No model is bound for agent profile "reviewer"');
    expect((thrown as Error2).message).toContain(SUBAGENT_MODEL_UNBOUND_HINT);
    expect((thrown as Error2).details?.['profile']).toBe('reviewer');
  });

  it('reports which source the bound model came from', () => {
    expect(bindSubagent({ modelAlias: 'fast-model' }, undefined)).toMatchObject({
      model: 'fast-model',
    });
    expect(bindSubagent(undefined, undefined, { modelAlias: 'provider/fast' })).toMatchObject({
      model: 'provider/fast',
    });
  });
});

describe('explicit caller-model inheritance', () => {
  const caller = { modelAlias: 'provider/k3', thinkingEffort: 'high' };

  it('binds a profile inherit pin to the caller model and effective effort', () => {
    expect(resolveSubagentBinding(config(), {}, { modelAlias: 'inherit' }, catalog, undefined,
      { profileName: 'reviewer' }, caller)).toMatchObject({
      model: 'provider/k3', thinking: 'high', displayModel: 'inherit',
    });
  });

  it('lets an explicit profile effort pin win when the tool selects inherit', () => {
    expect(resolveSubagentBinding(config(), { modelAlias: 'inherit' }, {
      modelAlias: 'fast-model', thinkingEffort: 'low',
    }, catalog, undefined, { profileName: 'reviewer' }, caller)).toMatchObject({
      model: 'provider/k3', thinking: 'low',
    });
    expect(resolveSubagentBinding(config(), { modelAlias: 'inherit' }, {
      thinkingEffort: 'medium',
    }, catalog, undefined, { profileName: 'reviewer' }, caller).thinking).toBe('medium');
  });

  it('prefers an explicit profile or tool effort pin to the inherited effort', () => {
    const profile = { modelAlias: 'inherit', thinkingEffort: 'low' };
    expect(resolveSubagentBinding(config(), {}, profile, catalog, undefined,
      { profileName: 'reviewer' }, caller).thinking).toBe('low');
    expect(resolveSubagentBinding(config(), { modelAlias: 'inherit', thinkingEffort: 'medium' },
      profile, catalog, undefined, { profileName: 'reviewer' }, caller).thinking).toBe('medium');
  });

  it('applies machine model denials to the resolved caller model', () => {
    const error = configError(() => resolveSubagentBinding(config(['provider/blocked']), {},
      { modelAlias: 'inherit' }, catalog, undefined, { profileName: 'reviewer' },
      { modelAlias: 'blocked', thinkingEffort: 'high' }));
    expect(error.message).toContain('[subagent].deny_models');
  });

  it('rejects inherit without a bound caller rather than interpreting it as a configured alias', () => {
    const error = configError(() => resolveSubagentBinding(config(), {}, { modelAlias: 'inherit' },
      catalog, undefined, { profileName: 'reviewer' }));
    expect(error.message).toContain('requires a caller agent');
  });
});

describe('literal hard constraints and explicit soft recommendations', () => {
  const evaluate = (
    model: string,
    constraints: SubagentRoleModelConstraints,
    thinking?: string,
  ) => roleBindingAdvisories({
    model,
    requestedModel: model,
    thinking,
    requestedThinking: thinking,
    constraints,
    models: catalog,
    ruleSource: 'profile:reviewer',
    modelValueSource: 'dispatch-explicit',
    thinkingValueSource: 'dispatch-explicit',
  });

  it('rejects an explicit model outside allowed_models with a structured hard error', () => {
    const constraints = { allowedModels: ['fast-model'] };
    expect(() => bindSubagent({ modelAlias: 'k3-review' }, constraints)).toThrow(/Hard constraint/);
    expect(() => evaluate('k3-review', constraints)).toThrowError(expect.objectContaining({
      code: ErrorCodes.PROFILE_CONSTRAINT_VIOLATION,
      details: expect.objectContaining({ strength: 'hard', ruleSource: 'profile:reviewer.allowed_models',
        ruleValues: ['fast-model'], requestedValue: 'k3-review', effectiveValue: 'provider/k3', valueSource: 'dispatch-explicit' }),
    }));
  });

  it('rejects deny_models and empty allowlists instead of advising', () => {
    expect(() => bindSubagent({ modelAlias: 'heavy-model' }, { denyModels: ['heavy-model'] })).toThrow(/deny_models/);
    expect(() => evaluate('fast-model', { allowedModels: [] })).toThrow(/allowed_models/);
    expect(() => evaluate('fast-model', { allowedEfforts: [] }, 'off')).toThrow(/allowed_efforts/);
  });

  it('records only explicit soft recommendation deviations', () => {
    const constraints = { preferredModels: ['fast-model'], preferredEfforts: ['max'] };
    expect(bindSubagent({ modelAlias: 'k3-review', thinkingEffort: 'high' }, constraints)).toMatchObject({ model: 'k3-review', thinking: 'high' });
    expect(evaluate('k3-review', constraints, 'high')).toMatchObject([
      { code: 'model_not_preferred', ruleSource: 'profile:reviewer.preferred_models', effectiveValue: 'provider/k3' },
      { code: 'effort_not_preferred', ruleSource: 'profile:reviewer.preferred_efforts', effectiveValue: 'high' },
    ]);
    expect(evaluate('heavy-model', { discouragedModels: ['heavy-model'] })).toMatchObject([{ code: 'model_discouraged' }]);
    expect(evaluate('fast-model', { allowedModels: ['fast'], preferredModels: ['fast'] })).toEqual([]);
    expect(() => evaluate('k3-review', { allowedModels: ['fast'], preferredModels: ['k3-review'] })).toThrow(/allowed_models/);
  });

  it('does not let role allowed_models re-permit a machine [subagent].deny_models entry', () => {
    const error = configError(() =>
      bindSubagent(
        { modelAlias: 'blocked' },
        { allowedModels: ['blocked', 'fast-model'] },
        {},
        ['provider/blocked'],
      ),
    );
    expect(error.message).toContain('[subagent].deny_models');
    expect(error.details?.['deniedModels']).toEqual(['provider/blocked']);
  });

  it('matches canonical aliases when evaluating role guidance', () => {
    expect(bindSubagent({ modelAlias: 'provider/fast' }, { allowedModels: ['fast'] }))
      .toMatchObject({ model: 'provider/fast' });
    expect(() => evaluate('provider/heavy', { denyModels: ['heavy-model'] })).toThrow(/deny_models/);
  });

  it('does not let a route pin widen a base allowlist', () => {
    const resolved = resolveAgentProfileRoute(routePin('k3-review'), reviewer());
    expect(() => bindSubagent(undefined, resolved.effectiveProfile, { modelAlias: resolved.effectiveProfile.modelAlias })).toThrow(/allowed_models/);
  });

  it('rejects a route sidecar that declares allowed_models as an unknown field', () => {
    expect(() =>
      parseAgentRouteFileText({
        path: '/agents/.routes/reviewer/fast.md',
        expectedProfile: 'reviewer',
        expectedRouteName: 'fast',
        text: [
          '---',
          'id: reviewer.fast',
          'profile: reviewer',
          'description: fast',
          'prompt_mode: inherit',
          'allowed_models: [fast-model]',
          '---',
          '',
        ].join('\n'),
      }),
    ).toThrow(/Unknown frontmatter field "allowed_models"/);
  });

  it('does not admit constraint-like overrides from a tool request', () => {
    expect(() => bindSubagent(
      { modelAlias: 'k3-review', allowedModels: ['k3-review'] } as SubagentBindingRequest,
      { allowedModels: ['fast-model'] },
    )).toThrow(/allowed_models/);
  });

  it('enforces role and canonical model-profile efforts independently', () => {
    const constraints = {
      allowedEfforts: ['high', 'max'],
      modelProfiles: [{ alias: 'fast-model', allowedEfforts: ['max'] }],
    };
    expect(() => bindSubagent({ modelAlias: 'fast', thinkingEffort: 'high' }, constraints)).toThrow(/model_profiles:fast-model.allowed_efforts/);
    expect(evaluate('provider/fast', constraints, 'max')).toEqual([]);
    expect(() => evaluate('fast', { modelConstraintProfiles: [{ alias: 'fast-model', allowedEfforts: ['max'] }] }, 'high')).toThrow(/allowed_efforts/);
  });
});
