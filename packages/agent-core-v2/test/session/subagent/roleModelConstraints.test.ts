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

describe('a subagent model comes only from a profile pin or the dispatch', () => {
  it('fails closed with MODEL_NOT_CONFIGURED when neither source supplies a model', () => {
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

describe('role model constraints are advisory while machine deny stays authoritative', () => {
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

  it('allows a model outside role allowed_models and returns a structured advisory', () => {
    const constraints: SubagentRoleModelConstraints = { allowedModels: ['fast-model'] };
    expect(bindSubagent({ modelAlias: 'k3-review' }, constraints)).toMatchObject({ model: 'k3-review' });
    expect(evaluate('k3-review', constraints)).toEqual([
      expect.objectContaining({
        code: 'model_not_allowed',
        ruleSource: 'profile:reviewer.allowed_models',
        requestedValue: 'k3-review',
        effectiveValue: 'provider/k3',
        valueSource: 'dispatch-explicit',
      }),
    ]);
  });

  it('allows role deny_models and empty allowed_models with prominent advisories', () => {
    expect(bindSubagent({ modelAlias: 'heavy-model' }, { denyModels: ['heavy-model'] }))
      .toMatchObject({ model: 'heavy-model' });
    expect(evaluate('heavy-model', { denyModels: ['heavy-model'] })[0]).toMatchObject({
      code: 'model_denied',
      ruleSource: 'profile:reviewer.deny_models',
    });
    expect(bindSubagent({ modelAlias: 'fast-model' }, { allowedModels: [] }))
      .toMatchObject({ model: 'fast-model' });
    expect(evaluate('fast-model', { allowedModels: [] })[0]).toMatchObject({
      code: 'model_not_allowed',
      ruleValues: [],
    });
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
    expect(evaluate('provider/heavy', { denyModels: ['heavy-model'] })[0]).toMatchObject({
      code: 'model_denied',
      effectiveValue: 'provider/heavy',
    });
  });

  it('allows a route default outside the base profile guidance and reports it', () => {
    const resolved = resolveAgentProfileRoute(routePin('k3-review'), reviewer());
    const constraints = {
      allowedModels: resolved.effectiveProfile.allowedModels,
      denyModels: resolved.effectiveProfile.denyModels,
    };
    expect(bindSubagent(undefined, constraints, { modelAlias: resolved.effectiveProfile.modelAlias }))
      .toMatchObject({ model: 'k3-review' });
    expect(evaluate('k3-review', constraints)[0]).toMatchObject({ code: 'model_not_allowed' });
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

  it('ignores constraint-like fields on the tool request', () => {
    const constraints = { allowedModels: ['fast-model'] };
    expect(bindSubagent(
      { modelAlias: 'k3-review', allowedModels: ['k3-review'] } as SubagentBindingRequest,
      constraints,
    )).toMatchObject({ model: 'k3-review' });
    expect(evaluate('k3-review', constraints)[0]).toMatchObject({ code: 'model_not_allowed' });
  });

  it('allows an effort outside the role and model-profile intersection with an advisory', () => {
    const constraints: SubagentRoleModelConstraints = {
      allowedEfforts: ['high', 'max'],
      modelProfiles: [{ alias: 'fast-model', when: 'when fast', allowedEfforts: ['max'] }],
    };
    expect(bindSubagent({ modelAlias: 'fast-model', thinkingEffort: 'high' }, constraints))
      .toMatchObject({ thinking: 'high' });
    expect(evaluate('fast-model', constraints, 'high')[0]).toMatchObject({
      code: 'effort_not_allowed',
      ruleValues: ['max'],
      effectiveValue: 'high',
    });
  });
});
