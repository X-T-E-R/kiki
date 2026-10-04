import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestInstantiationService } from '#/_base/di/test';
import { CodexAppServerExecutorProvider } from '#/agent/execution/codexAppServerExecutorProvider';
import { projectSubagentCapabilities, type SubagentCapabilityServices } from '#/agent/tools/agent/subagentCapabilities';
import { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import { normalizeAgentProfile, type AgentProfile, type ResolvedAgentProfileRoute } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IConfigService } from '#/app/config/config';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import { projectProfileModelMenu, projectSubagentModelCatalog } from '#/session/subagent/modelCatalogProjection';
import { applyLease } from '@kiki/agent-profiles/applySubagentLease';

describe('subagent capability final bindings', () => {
  let ix: TestInstantiationService;
  let services: SubagentCapabilityServices;
  let model: Model;
  const externalStart = vi.fn(() => { throw new Error('External execution is forbidden'); });

  beforeEach(() => {
    ix = new TestInstantiationService();
    model = {
      id: 'example', name: 'example', aliases: [], protocol: 'openai', headers: {},
      capabilities: { ...UNKNOWN_CAPABILITY, thinking: true }, maxContextSize: 1000,
      supportEfforts: ['low', 'high'], defaultEffort: 'low', alwaysThinking: false,
      providerName: 'example',
      imagePolicy: {
        acceptedTypes: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
        convertUnsupported: 'off',
      },
      authProvider: { getAuth: async () => undefined },
    };
    ix.stub(IConfigService, { get: <T>() => undefined as T });
    ix.stub(IModelService, { resolveId: (id) => id });
    ix.stub(IModelCatalog, { get: () => model });
    ix.stub(IProtocolAdapterRegistry, {});
    ix.stub(IAgentExecutorRegistry, {
      resolve: (id = 'native') => ({ descriptor: { id, protocol: id === 'native' ? 'native' : 'codex-app-server', args: [], revision: 'test' }, options: {} }),
      validateBinding: (_id, _options, binding) => CodexAppServerExecutorProvider.validateBinding(binding),
      resolveExecutable: externalStart,
    });
    services = {
      config: ix.get(IConfigService), models: ix.get(IModelService), modelCatalog: ix.get(IModelCatalog),
      executors: ix.get(IAgentExecutorRegistry), protocols: ix.get(IProtocolAdapterRegistry),
    };
  });

  afterEach(() => {
    if (externalStart.mock.calls.length > 0) throw new Error('External execution was attempted');
    ix.dispose();
    vi.clearAllMocks();
  });

  function project(profile: AgentProfile, route?: ResolvedAgentProfileRoute) {
    const catalog = {
      get: () => profile, list: () => [profile], getDefault: () => profile,
      resolveSelection: () => ({ profile: route?.effectiveProfile ?? profile, baseProfile: profile, route }),
    };
    return projectSubagentCapabilities({ catalog, caller: { profileName: 'lead', subagents: [profile.name] },
      profiles: [profile], routes: route === undefined ? [] : [route] }, services);
  }

  function helper(fields: Partial<AgentProfile> = {}): AgentProfile {
    return normalizeAgentProfile({ name: 'helper', modelAlias: 'example', systemPrompt: () => '', ...fields });
  }

  it('projects a model-only profile default and the same missing-default error as dispatch', () => {
    model = { ...model, supportEfforts: undefined, defaultEffort: 'high' };
    expect(project(helper())[0]).toMatchObject({ defaultsAvailable: true, thinkingEffort: 'high', effortSource: 'model' });
    model = { ...model, defaultEffort: undefined };
    expect(project(helper())[0]).toMatchObject({ defaultsAvailable: false, unavailableReason: expect.stringContaining('no resolvable default') });
    expect(project(helper({ thinkingEffort: 'low' }))[0]).toMatchObject({ defaultsAvailable: true, thinkingEffort: 'low' });
  });

  it('shares effective-domain calculation while preserving frozen declarations and main model policy', () => {
    services.models.list = () => ({ example: {}, cheap: {}, outside: {} });
    vi.spyOn(services.models, 'resolveId').mockImplementation((alias) => alias === 'fast' ? 'example' : alias);
    vi.spyOn(services.config, 'get').mockReturnValue({ denyModels: ['example'] });
    const profile = helper({ modelAlias: 'fast', restrictModelsToMenu: true,
      modelProfiles: [{ alias: 'cheap', when: 'Ignored advice', denyModels: ['cheap'] }] });
    const frozen = applyLease(profile, { name: 'helper', modelAlias: 'outside', modelProfiles: [{ alias: 'outside' }] }, (alias) => services.models.resolveId(alias));
    const main = projectProfileModelMenu(frozen, services.models, services.config, 'main', { frozen: true });
    expect(main.declaredModelMenu).toEqual({ aliases: ['cheap'], defaultAlias: 'fast', identities: ['cheap', 'example'] });
    expect(main.effectiveModelAliases).toEqual(['example', 'fast']);
    expect(main.modelConstraintsActive).toBe(true);
    const recommended = projectProfileModelMenu(helper({ preferredModels: ['example'],
      modelProfiles: [{ alias: 'cheap', when: 'Recommended' }] }), services.models, services.config, 'main');
    expect(recommended.modelConstraintsActive).toBe(false);
    expect(recommended.effectiveModelAliases).toContain('outside');
    expect(projectProfileModelMenu(helper({ modelProfiles: [{ alias: 'cheap', allowedModels: [] }] }),
      services.models, services.config, 'main').modelConstraintsActive).toBe(true);
    expect(projectProfileModelMenu(frozen, services.models, services.config, 'sub', { frozen: true }).effectiveModelAliases).toEqual([]);
    expect(projectProfileModelMenu({ name: 'legacy', restrictModelsToMenu: false }, services.models, services.config, 'main', { frozen: true }).effectiveModelAliases).toEqual(['example', 'cheap', 'outside']);
    expect(projectProfileModelMenu(helper({ restrictModelsToMenu: true, modelAlias: undefined }), services.models, services.config, 'main').effectiveModelAliases).toEqual([]);
  });

  it('keeps the original menu distinct from effective candidates under lease and route replacement', () => {
    services.models.list = () => ({ example: {}, cheap: {}, outside: {} });
    const profile = helper({ restrictModelsToMenu: true, modelProfiles: [{ alias: 'cheap', when: 'Never evaluated' }] });
    const route: ResolvedAgentProfileRoute = { id: 'helper.outside', profile: profile.name, modelAlias: 'outside', lockedModelAlias: 'outside', description: '', overriddenFields: ['model_alias'], effectiveProfile: { ...profile, modelAlias: 'outside' } };
    const catalog = { get: () => profile, list: () => [profile], getDefault: () => profile,
      resolveSelection: ({ route: routeId }: { route?: string }) => ({ profile: routeId === undefined ? profile : route.effectiveProfile, baseProfile: profile, route: routeId === undefined ? undefined : route }) };
    const projected = projectSubagentModelCatalog(catalog, { profileName: 'lead', subagentLeases: { helper: { name: 'helper', modelProfiles: [{ alias: 'outside' }], modelAlias: 'outside' } }, spawnPolicy: { denyModels: ['cheap'] } }, { profiles: [profile], routes: [route] }, services.models, services.config);
    expect(projected.aliases).toEqual(['example']);
    expect(projected.routes).toEqual([]);
    expect(projected.profiles[0]).toMatchObject({ modelAlias: 'outside', modelProfiles: [{ alias: 'outside' }], effectiveModelAliases: ['example'],
      modelMenuConstraint: { aliases: ['cheap', 'example'], defaultAlias: 'example' } });
    expect(projected.profiles[0]?.modelMenuDiagnostics?.join(' ')).toContain('outside');
  });

  it('projects only configured allowed models, applying caller leases and retaining permitted routes', () => {
    vi.spyOn(services.models, 'resolveId').mockImplementation((id) => {
      if (id === 'ambiguous') throw new Error('Ambiguous model alias');
      return id === 'short' ? 'cheap' : id;
    });
    services.models.list = () => ({ cheap: {}, alternate: {}, expensive: {}, denied: {} });
    const profile = helper({ modelAlias: 'expensive', allowedModels: ['cheap', 'alternate', 'expensive', 'missing'],
      modelProfiles: [{ alias: 'expensive', when: 'Large tasks' }, { alias: 'short', when: 'Small tasks' }, { alias: 'ambiguous', when: 'Unavailable choice' }] });
    const route: ResolvedAgentProfileRoute = {
      id: 'helper.cheap', description: 'Cheap helper', profile: profile.name, modelAlias: 'cheap', lockedModelAlias: 'cheap',
      overriddenFields: ['modelAlias'], effectiveProfile: { ...profile, modelAlias: 'cheap' },
    };
    const catalog = { get: () => profile, list: () => [profile], getDefault: () => profile,
      resolveSelection: () => ({ profile: route.effectiveProfile, baseProfile: profile, route }) };
    const projected = projectSubagentModelCatalog(catalog, {
      profileName: 'lead', subagents: ['helper'], spawnPolicy: { allowedModels: ['cheap', 'alternate'] },
      subagentLeases: { helper: { name: 'helper', modelAlias: 'cheap', thinkingEffort: 'high' } },
    }, { profiles: [profile], routes: [route] }, services.models, services.config);
    expect(projected.aliases).toEqual(['cheap', 'alternate']);
    expect(projected.profiles[0]).toMatchObject({ modelAlias: 'cheap', thinkingEffort: 'high', allowedModels: ['cheap', 'alternate'] });
    expect(projected.profiles[0]?.modelProfiles).toEqual(profile.modelProfiles);
    expect(projected.profiles[0]?.effectiveModelAliases).toEqual(['cheap', 'alternate', 'short']);
    expect(projected.routes.map((item) => item.id)).toEqual(['helper.cheap']);
    const unrestricted = projectSubagentModelCatalog({ ...catalog, get: () => helper(), getDefault: () => helper() },
      { profileName: 'lead' }, { profiles: [helper()], routes: [] }, services.models, services.config);
    expect(unrestricted.aliases).toContain('expensive');
  });

  it('projects recommended, allowed nonpreferred and blocked targets distinctly', () => {
    const preferred = helper({ name: 'preferred' });
    const alternate = helper({ name: 'alternate' });
    const catalog = {
      get: (name: string) => [preferred, alternate].find((profile) => profile.name === name),
      list: () => [preferred, alternate],
      getDefault: () => preferred,
      resolveSelection: ({ profile }: { readonly profile?: string }) => {
        const selected = [preferred, alternate].find((candidate) => candidate.name === profile)!;
        return { profile: selected, baseProfile: selected };
      },
    };
    const base = { catalog, profiles: [preferred, alternate], routes: [] };
    const advisory = projectSubagentCapabilities({
      ...base,
      caller: {
        profileName: 'lead',
        allowedSubagents: undefined,
        preferredSubagents: ['preferred'],
      },
    }, services);
    expect(advisory.find((target) => target.profile === 'preferred')).toMatchObject({
      dispatchPolicy: 'fixed', recommendationStatus: 'preferred', dispatchAllowed: true,
    });
    expect(advisory.find((target) => target.profile === 'alternate')).toMatchObject({
      dispatchPolicy: 'fixed', recommendationStatus: 'allowed_nonpreferred',
      advisoryDeviation: true, dispatchAllowed: true,
    });

    const strict = projectSubagentCapabilities({
      ...base,
      caller: {
        profileName: 'lead',
        allowedSubagents: ['preferred'],
        preferredSubagents: ['preferred'],
      },
    }, services);
    expect(strict.find((target) => target.profile === 'preferred')).toMatchObject({
      dispatchPolicy: 'fixed', recommendationStatus: 'preferred', dispatchAllowed: true,
      defaultsAvailable: true,
    });
    expect(strict.find((target) => target.profile === 'alternate')).toMatchObject({
      dispatchPolicy: 'fixed', recommendationStatus: 'blocked', dispatchAllowed: false,
      defaultsAvailable: true,
    });
  });

  it('distinguishes a hard effort failure from a runnable soft preference deviation', () => {
    expect(project(helper({ allowedEfforts: ['high'] }))[0]).toMatchObject({ defaultsAvailable: false,
      unavailableReasonCode: 'binding_constraints_unsatisfied', unavailableReason: expect.stringContaining('allowed_efforts') });
    const [conflict] = project(helper({ preferredEfforts: ['high'] }));
    expect(conflict).toMatchObject({ profile: 'helper', defaultsAvailable: true, modelAlias: 'example', thinkingEffort: 'low',
      bindingAdvisories: [expect.objectContaining({ code: 'effort_not_preferred', effectiveValue: 'low', valueSource: 'model-default' })] });
    expect(project(helper({ allowedEfforts: ['low'] }))[0]).toMatchObject({ defaultsAvailable: true, modelAlias: 'example', thinkingEffort: 'low' });
  });

  it('attributes the selected model default instead of the global thinking effort', () => {
    model = { ...model, defaultEffort: 'high' };
    vi.spyOn(services.config, 'get').mockImplementation((section: string) =>
      section === 'thinking' ? { effort: 'low' } : undefined);
    expect(project(helper())[0]).toMatchObject({
      thinkingEffort: 'high', effortSource: 'model', defaultsAvailable: true,
    });
    expect(project(helper({ thinkingEffort: 'low' }))[0]).toMatchObject({
      thinkingEffort: 'low', effortSource: 'profile', defaultsAvailable: true,
    });
    model = { ...model, defaultEffort: undefined };
    expect(project(helper())[0]).toMatchObject({
      defaultsAvailable: false, unavailableReason: expect.stringContaining('no resolvable default'),
    });
  });

  it('CAP-R1 rejects an off route pin for an always-thinking model without replacing the pin', () => {
    model = { ...model, alwaysThinking: true };
    const profile = helper();
    const route = (effort: string): ResolvedAgentProfileRoute => ({
      id: 'helper.route', profile: profile.name, description: '', modelAlias: 'example',
      thinkingEffort: effort, lockedModelAlias: 'example', lockedThinkingEffort: effort,
      overriddenFields: ['modelAlias', 'thinkingEffort'], effectiveProfile: profile,
    });
    const conflict = project(profile, route('off')).find((item) => item.route !== undefined);
    expect(conflict).toMatchObject({
      route: 'helper.route', defaultsAvailable: false,
      unavailableReason: expect.stringContaining('off'),
    });
    expect(project(profile, route('low')).find((item) => item.route !== undefined)).toMatchObject({
      defaultsAvailable: true, thinkingEffort: 'low',
    });
  });

  it('CAP-R2 supplies the real external off default to the existing Codex validator', () => {
    const validate = vi.spyOn(services.executors, 'validateBinding');
    expect(project(helper({ executor: 'external' }))[0]).toMatchObject({
      defaultsAvailable: true, modelAlias: 'example', thinkingEffort: 'off', effortSource: 'executor',
    });
    expect(validate).toHaveBeenCalledWith('external', {}, { modelAlias: 'example', thinkingEffort: 'off' });
  });

  it('CAP-R2 consumes an executor-normalized alias and reports role-policy drift', () => {
    vi.spyOn(services.executors, 'validateBinding').mockImplementation((_id, _options, binding) => ({
      ok: true, binding: { ...binding, modelAlias: binding.modelAlias === 'vendor-short' ? 'vendor/model' : binding.modelAlias },
    }));
    expect(project(helper({ executor: 'external', modelAlias: 'vendor-short' }))[0]).toMatchObject({
      defaultsAvailable: true, modelAlias: 'vendor/model', thinkingEffort: 'off',
    });
    const conflict = project(helper({ executor: 'external', modelAlias: 'vendor-short', preferredModels: ['vendor-short'] }))[0];
    expect(project(helper({ executor: 'external', modelAlias: 'vendor-short', allowedModels: ['vendor-short'] }))[0]).toMatchObject({ defaultsAvailable: false, unavailableReasonCode: 'binding_constraints_unsatisfied' });
    expect(conflict).toMatchObject({
      defaultsAvailable: true,
      modelAlias: 'vendor/model',
      bindingAdvisories: [expect.objectContaining({
        code: 'model_not_preferred',
        effectiveValue: 'vendor/model',
        valueSource: 'executor-normalized',
      })],
    });
  });

  it('projects an inherited model as the caller binding instead of an unavailable literal alias', () => {
    services.models.list = () => ({ example: {} });
    const profile = helper({ modelAlias: 'inherit', thinkingEffort: undefined });
    const catalog = { get: () => profile, list: () => [profile], getDefault: () => profile,
      resolveSelection: () => ({ profile, baseProfile: profile }) };
    const input = { catalog, caller: { profileName: 'lead', modelAlias: 'example',
      effectiveThinkingLevel: 'high', subagents: ['helper'] }, profiles: [profile], routes: [] };
    expect(projectSubagentCapabilities(input, services)[0]).toMatchObject({
      modelAlias: 'example', thinkingEffort: 'high', defaultsAvailable: true,
    });
    expect(projectSubagentModelCatalog(catalog, input.caller, input, services.models, services.config)
      .profiles[0]).toMatchObject({ modelAlias: 'inherit', thinkingEffort: 'high' });
  });

  it('keeps machine [subagent].deny_models as a hard capability failure', () => {
    vi.spyOn(services.config, 'get').mockImplementation((section: string) =>
      section === 'subagent' ? { denyModels: ['example'] } : undefined);
    expect(project(helper())[0]).toMatchObject({
      defaultsAvailable: false,
      unavailableReasonCode: 'binding_constraints_unsatisfied',
    });
  });

  it('keeps a caller-declared frozen target and fills its lease pins after the live profile is removed', () => {
    services.models.list = () => ({ example: {} });
    const live = helper({ name: 'live' });
    const leased = helper({ name: 'leased', modelAlias: undefined });
    const snapshot = {
      publicProfiles: new Map([[leased.name, leased]]),
      resolvableProfiles: new Map([[leased.name, leased]]),
      defaultProfile: live,
      routes: new Map(),
      scopedBindings: new Map(),
      sourceDefinitions: new Map(),
      dependencyIndex: new Map(),
      diagnostics: [],
    };
    const catalog = {
      get: (name: string) => (name === live.name ? live : undefined),
      list: () => [live],
      getDefault: () => live,
      resolveSelection: ({ profile }: { readonly profile?: string }) => {
        if (profile !== live.name) throw new Error('unknown profile');
        return { profile: live, baseProfile: live };
      },
    };
    const caller = {
      profileName: 'lead',
      defaultPolicy: 'advisory' as const,
      subagents: ['leased'],
      subagentLeases: { leased: { name: 'leased', modelAlias: 'example', thinkingEffort: 'high' } },
    };
    const input = { catalog, caller, profiles: [leased], routes: [], snapshot };
    expect(projectSubagentCapabilities(input, services)[0]).toMatchObject({
      profile: 'leased', modelAlias: 'example', modelSource: 'caller-lease',
      thinkingEffort: 'high', effortSource: 'caller-lease', defaultsAvailable: true,
    });
    expect(projectSubagentModelCatalog(catalog, caller, input, services.models, services.config)
      .profiles[0]).toMatchObject({ modelAlias: 'example', thinkingEffort: 'high' });
  });

  it('skips a stale frozen-catalog target whose profile vanished from the snapshot', () => {
    services.models.list = () => ({ example: {} });
    const live = helper({ name: 'live' });
    const ghost = helper({ name: 'ghost' });
    const catalog = {
      get: (name: string) => (name === live.name ? live : undefined),
      list: () => [live],
      getDefault: () => live,
      resolveSelection: ({ profile }: { readonly profile?: string }) => {
        if (profile !== live.name) throw new Error('unknown profile');
        return { profile: live, baseProfile: live };
      },
    };
    const snapshot = {
      publicProfiles: new Map([[live.name, live]]),
      defaultProfile: live,
      routes: new Map(),
      scopedBindings: new Map(),
      sourceDefinitions: new Map(),
      dependencyIndex: new Map(),
      diagnostics: [],
    };
    const projected = projectSubagentModelCatalog(catalog, { profileName: 'lead' },
      { profiles: [live, ghost], routes: [], snapshot }, services.models, services.config);
    expect(projected.profiles.map((profile) => profile.name)).toEqual(['live']);
    expect(projected.aliases).toContain('example');
  });
});
