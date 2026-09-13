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
import { projectSubagentModelCatalog } from '#/session/subagent/modelCatalogProjection';

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
      providerName: 'example', authProvider: { getAuth: async () => undefined },
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
    expect(externalStart).not.toHaveBeenCalled();
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
    expect(projected.profiles[0]?.modelProfiles?.map((entry) => entry.alias)).toEqual(['short']);
    expect(projected.routes.map((item) => item.id)).toEqual(['helper.cheap']);
    const unrestricted = projectSubagentModelCatalog({ ...catalog, get: () => helper(), getDefault: () => helper() },
      { profileName: 'lead' }, { profiles: [helper()], routes: [] }, services.models, services.config);
    expect(unrestricted.aliases).toContain('expensive');
  });

  it('CAP-R1 rejects a normalized model default outside the effort allowlist and keeps the visible target', () => {
    const [conflict] = project(helper({ allowedEfforts: ['high'] }));
    expect(conflict).toMatchObject({ profile: 'helper', defaultsAvailable: false });
    expect(conflict).not.toHaveProperty('modelAlias');
    expect(conflict).not.toHaveProperty('thinkingEffort');
    expect(project(helper({ allowedEfforts: ['low'] }))[0]).toMatchObject({
      defaultsAvailable: true, modelAlias: 'example', thinkingEffort: 'low',
    });
  });

  it('CAP-R1 rejects a route effort that an always-thinking model cannot honor', () => {
    model = { ...model, alwaysThinking: true };
    const profile = helper();
    const route = (effort: string): ResolvedAgentProfileRoute => ({
      id: 'helper.route', profile: profile.name, description: '', modelAlias: 'example',
      thinkingEffort: effort, lockedModelAlias: 'example', lockedThinkingEffort: effort,
      overriddenFields: ['modelAlias', 'thinkingEffort'], effectiveProfile: profile,
    });
    const conflict = project(profile, route('off')).find((item) => item.route !== undefined);
    expect(conflict).toMatchObject({ route: 'helper.route', defaultsAvailable: false });
    expect(conflict).not.toHaveProperty('modelAlias');
    expect(conflict).not.toHaveProperty('thinkingEffort');
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

  it('CAP-R2 consumes the executor-normalized model alias and rechecks its final constraints', () => {
    vi.spyOn(services.executors, 'validateBinding').mockImplementation((_id, _options, binding) => ({
      ok: true, binding: { ...binding, modelAlias: binding.modelAlias === 'vendor-short' ? 'vendor/model' : binding.modelAlias },
    }));
    expect(project(helper({ executor: 'external', modelAlias: 'vendor-short' }))[0]).toMatchObject({
      defaultsAvailable: true, modelAlias: 'vendor/model', thinkingEffort: 'off',
    });
    const conflict = project(helper({ executor: 'external', modelAlias: 'vendor-short', allowedModels: ['vendor-short'] }))[0];
    expect(conflict).toMatchObject({ defaultsAvailable: false });
    expect(conflict).not.toHaveProperty('modelAlias');
  });
});
