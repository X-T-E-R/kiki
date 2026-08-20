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
  resolveAgentCollaborationBinding,
  resolveSubagentBinding,
  SUBAGENT_SECTION,
  type SubagentBindingOwner,
  type SubagentBindingRequest,
  type SubagentRoleModelConstraints,
} from '#/session/subagent/configSection';
import { parseAgentRouteFileText } from '#/workspace/workspaceAgentProfileLoader/internal/agentRouteFile';

import { stubFlag } from '../../app/flag/stubs';
import { StubConfigService } from '../../kosong/stubs';

const own: SubagentBindingOwner = { modelAlias: 'provider/main', thinkingLevel: 'medium' };
const flags = stubFlag(false);

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
  requested: string | SubagentBindingRequest | undefined,
  constraints: SubagentRoleModelConstraints | undefined,
  profileRequest: SubagentBindingRequest = {},
  denyModels?: readonly string[],
) {
  return resolveSubagentBinding(
    config(denyModels),
    flags,
    own,
    requested,
    profileRequest,
    catalog,
    constraints,
  );
}

function bindCollaboration(
  request: Pick<SubagentBindingRequest, 'modelAlias' | 'thinkingEffort'>,
  constraints: SubagentRoleModelConstraints | undefined,
  profile: SubagentBindingRequest = {},
  denyModels?: readonly string[],
) {
  return resolveAgentCollaborationBinding(
    config(denyModels),
    flags,
    own,
    request,
    profile,
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

describe('role model constraints at bind time: role allowed_models / deny_models only narrow, machine [subagent].deny_models stays authoritative', () => {
  it('rejects any other dispatch-time model_alias when allowed_models has a single pin', () => {
    const pin: SubagentRoleModelConstraints = { allowedModels: ['fast-model'] };

    expect(bindSubagent({ modelAlias: 'fast-model' }, pin)).toMatchObject({
      model: 'fast-model',
    });
    expect(bindSubagent(undefined, pin, { modelAlias: 'fast-model' })).toMatchObject({
      model: 'fast-model',
    });
    const error = configError(() => bindSubagent({ modelAlias: 'k3-review' }, pin));
    expect(error.message).toContain('provider/k3');
    expect(error.message).toContain('not in this agent\'s allowed_models');
    expect(error.message).toContain('Permitted models: fast-model');
    expect(error.details?.['permittedModels']).toEqual(['fast-model']);
  });

  it('rejects a dispatch-time model_alias listed only in the role deny_models', () => {
    const error = configError(() =>
      bindSubagent({ modelAlias: 'heavy-model' }, { denyModels: ['heavy-model'] }),
    );
    expect(error.message).toContain('provider/heavy');
    expect(error.message).toContain('denied by this agent\'s deny_models');
    expect(error.message).not.toContain('[subagent].deny_models');
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

  it('enforces the same constraints in both binding entry points', () => {
    const pin: SubagentRoleModelConstraints = { allowedModels: ['fast-model'] };
    const deny: SubagentRoleModelConstraints = { denyModels: ['heavy-model'] };

    expect(bindCollaboration({ modelAlias: 'fast-model' }, pin)).toMatchObject({
      model: 'fast-model',
    });
    expect(configError(() => bindCollaboration({ modelAlias: 'k3-review' }, pin)).message).toContain(
      'allowed_models',
    );
    expect(configError(() => bindCollaboration({ modelAlias: 'heavy-model' }, deny)).message).toContain(
      'this agent\'s deny_models',
    );
  });

  it('matches a bare allowlist/denylist entry against a qualified dispatch alias', () => {
    expect(
      bindSubagent({ modelAlias: 'provider/fast' }, { allowedModels: ['fast'] }),
    ).toMatchObject({ model: 'provider/fast' });
    expect(
      configError(() =>
        bindSubagent({ modelAlias: 'provider/heavy' }, { denyModels: ['heavy-model'] }),
      ).message,
    ).toContain('provider/heavy');
  });

  it('rejects a route-pinned model_alias that the base profile constraints forbid', () => {
    const resolved = resolveAgentProfileRoute(routePin('k3-review'), reviewer());
    expect(resolved.effectiveProfile.allowedModels).toEqual(['fast-model']);
    expect(resolved.effectiveProfile.modelAlias).toBe('k3-review');
    expect(resolved.lockedModelAlias).toBe('k3-review');

    const error = configError(() =>
      bindSubagent(undefined, {
        allowedModels: resolved.effectiveProfile.allowedModels,
        denyModels: resolved.effectiveProfile.denyModels,
      }, { modelAlias: resolved.effectiveProfile.modelAlias }),
    );
    expect(error.message).toContain('provider/k3');
    expect(error.message).toContain('allowed_models');
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

  it('does not let constraint-like fields on the tool request grant permission', () => {
    const error = configError(() =>
      bindSubagent(
        { modelAlias: 'k3-review', allowedModels: ['k3-review'] } as SubagentBindingRequest,
        { allowedModels: ['fast-model'] },
      ),
    );
    expect(error.message).toContain('allowed_models');
  });

  it('intersects role allowed_efforts with a matching model_profiles entry', () => {
    const constraints: SubagentRoleModelConstraints = {
      allowedEfforts: ['high', 'max'],
      modelProfiles: [
        {
          alias: 'fast-model',
          when: 'when fast',
          allowedEfforts: ['max'],
        },
      ],
    };

    expect(
      bindSubagent({ modelAlias: 'fast-model', thinkingEffort: 'max' }, constraints),
    ).toMatchObject({ thinking: 'max' });
    const error = configError(() =>
      bindSubagent({ modelAlias: 'fast-model', thinkingEffort: 'high' }, constraints),
    );
    expect(error.message).toContain('allowed_efforts');
    expect(error.message).toContain('max');
    expect(
      configError(() =>
        bindCollaboration({ modelAlias: 'fast-model', thinkingEffort: 'high' }, constraints),
      ).message,
    ).toContain('allowed_efforts');
  });
});
