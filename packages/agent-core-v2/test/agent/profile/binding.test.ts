import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'pathe';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Event } from '#/_base/event';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { InstantiationService } from '#/_base/di/instantiationService';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { ConfigTarget, IConfigService } from '#/app/config/config';
import { TOOLS_SECTION } from '#/agent/toolPolicy/configSection';
import {
  DEFAULT_AGENT_PROFILE_NAME,
  normalizeAgentProfile,
  type AgentProfile,
  type ResolvedAgentProfileRoute,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { BuiltinAgentProfileLoaderService } from '#/app/agentProfileCatalog/builtinAgentProfileLoaderService';
import { registerAgentProfile } from '#/app/agentProfileCatalog/contribution';
import {
  IAgentExecutorRegistry,
  type AgentExecutorDescriptor,
  type AgentExecutorProvider,
} from '#/app/agentExecutor/agentExecutor';
import { descriptorRevisionFromConfig } from '#/app/agentExecutor/agentExecutorRegistryService';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import type { ToolCall } from '#/kosong/contract/message';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { IAgentProfileService, type ResolvedAgentProfile } from '#/agent/profile/profile';
import { ProfileErrors } from '#/agent/profile/errors';
import { IHostClock } from '#/os/interface/hostClock';
import { IAgentAgentsMdReminderService } from '#/agent/agentsMdReminder/agentsMdReminder';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { isToolActive } from '#/agent/toolPolicy/evaluate';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { SELECT_TOOLS_TOOL_NAME } from '#/agent/toolSelect/toolSelect';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAtomicDocumentStore, type IAtomicDocumentStore as AtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { IWireService } from '#/wire/wire';
import { IEventBus } from '#/app/event/eventBus';
import { WarningIssued } from '#/agent/profile/profileOps';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import type { ExecutableTool, ToolExecution, ToolResult, ToolSource } from '#/tool/toolContract';

import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';

import { deferredAgentIdentityStub } from '../../app/agentIdentity/stubs';
import {
  InMemoryWireRecordPersistence,
  agentService,
  appService,
  createTestAgent,
  homeDirServices,
  hostEnvironmentServices,
  sessionService,
  type TestAgentContext,
} from '../../harness';

const MOCK_MODEL = 'mock-model';
const RESUME_PROVIDER = 'resume-provider';
const RESUME_OLD_MODEL = `${RESUME_PROVIDER}/old-model`;
const RESUME_NEW_MODEL = `${RESUME_PROVIDER}/new-model`;
const hostPathClass = process.platform === 'win32' ? 'win32' : 'posix';

function nativeResumeOptions() {
  return {
    initialConfig: {
      providers: {
        [RESUME_PROVIDER]: {
          type: 'kimi',
          apiKey: 'test-key',
          baseUrl: 'https://api.example.test/v1',
        },
      },
      models: {
        [RESUME_OLD_MODEL]: {
          provider: RESUME_PROVIDER,
          model: 'old-model',
          maxContextSize: 1_000_000,
          capabilities: ['thinking'],
          supportEfforts: ['low', 'high'],
        },
        [RESUME_NEW_MODEL]: {
          provider: RESUME_PROVIDER,
          model: 'new-model',
          maxContextSize: 1_000_000,
          capabilities: ['thinking'],
          supportEfforts: ['low', 'high'],
        },
      },
    },
  };
}

function resumeProfile(
  overrides: Partial<Omit<AgentProfile, 'systemPrompt' | 'renderSystemPrompt'>> = {},
): AgentProfile {
  return normalizeAgentProfile({
    name: 'resume-profile',
    modelAlias: RESUME_OLD_MODEL,
    systemPrompt: () => 'resume profile',
    ...overrides,
  });
}

function prepareResumeBinding(
  profile: IAgentProfileService,
  input: Parameters<IAgentProfileService['prepareResumeBinding']>[0],
): Promise<() => void> {
  return Promise.resolve().then(() => profile.prepareResumeBinding(input));
}

function missingProfileCatalog(): ISessionAgentProfileCatalog {
  const defaultProfile = normalizeAgentProfile({
    name: DEFAULT_AGENT_PROFILE_NAME,
    systemPrompt: () => 'missing profile catalog',
  });
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
    get: () => undefined,
    getDefault: () => defaultProfile,
    list: () => [],
    listRoutes: () => [],
    routeDiagnostics: () => [],
    resolveSelection: () => {
      throw new Error('profile catalog is empty');
    },
    inspect: () => undefined,
    load: async () => {},
    reload: async () => {},
  };
}

function profileServices(ctx: TestAgentContext): {
  profile: IAgentProfileService;
  toolPolicy: IAgentToolPolicyService;
} {
  return {
    profile: ctx.get(IAgentProfileService),
    toolPolicy: ctx.get(IAgentToolPolicyService),
  };
}

function createAtomicDocumentStore(): AtomicDocumentStore {
  const documents = new Map<string, unknown>();
  const documentKey = (scope: string, key: string): string => `${scope}/${key}`;
  return {
    _serviceBrand: undefined,
    get: async <T>(scope: string, key: string) => documents.get(documentKey(scope, key)) as T | undefined,
    set: async <T>(scope: string, key: string, value: T) => {
      documents.set(documentKey(scope, key), structuredClone(value));
    },
    update: async <T>(
      scope: string,
      key: string,
      updater: (current: T | undefined) => T | undefined,
    ) => {
      const id = documentKey(scope, key);
      const current = documents.get(id) as T | undefined;
      const next = updater(current);
      if (next !== undefined && next !== current) documents.set(id, structuredClone(next));
      return next ?? current;
    },
    delete: async (scope: string, key: string) => {
      documents.delete(documentKey(scope, key));
    },
    list: async (scope: string, prefix = '') =>
      [...documents.keys()]
        .filter((key) => key.startsWith(`${scope}/${prefix}`))
        .map((key) => key.slice(scope.length + 1)),
    watch: () => Event.None as Event<void>,
    acquire: () => ({ dispose: () => {} }),
  };
}

function disabledDefaultCatalog(): ISessionAgentProfileCatalog {
  const defaultProfile = normalizeAgentProfile({
    name: DEFAULT_AGENT_PROFILE_NAME,
    systemPrompt: () => 'disabled default binding',
  });
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
    get: () => undefined,
    getDefault: () => defaultProfile,
    list: () => [],
    listRoutes: () => [],
    routeDiagnostics: () => [],
    resolveSelection: () => {
      throw new Error('disabled default is not dispatchable');
    },
    inspect: () => undefined,
    load: async () => {},
    reload: async () => {},
  };
}

function routedCatalog(
  modelAlias = MOCK_MODEL,
  thinkingEffort = 'off',
  executor = 'native',
): ISessionAgentProfileCatalog {
  const base = normalizeAgentProfile({
    name: 'reviewer',
    description: 'Reviewer',
    tools: ['Read', 'Bash'],
    disallowedTools: ['Write'],
    subagents: ['explore', 'coder'],
    executor,
    systemPrompt: () => 'base reviewer',
  });
  const {
    renderSystemPrompt: _baseRenderSystemPrompt,
    systemPrompt: _baseSystemPrompt,
    ...baseFields
  } = base;
  const effective = normalizeAgentProfile({
    ...baseFields,
    routeId: 'reviewer.ui-k3',
    modelAlias,
    thinkingEffort,
    toolAllowPolicies: [base.tools!, ['Read']],
    disallowedTools: ['Write', 'Bash'],
    subagents: ['explore'],
    systemPrompt: () => 'routed reviewer',
  });
  const route: ResolvedAgentProfileRoute = {
    id: 'reviewer.ui-k3',
    profile: base.name,
    description: 'UI review route',
    modelAlias,
    thinkingEffort,
    overriddenFields: ['model_alias', 'thinking_effort', 'tools'],
    effectiveProfile: effective,
    lockedModelAlias: modelAlias,
    lockedThinkingEffort: thinkingEffort,
  };
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
    get: (name) => (name === base.name ? base : undefined),
    getDefault: () => base,
    list: () => [base],
    listRoutes: () => [route],
    routeDiagnostics: () => [],
    resolveSelection: ({ profile, route: routeId }) => {
      if (routeId !== route.id || (profile !== undefined && profile !== base.name)) {
        throw new Error(`Unexpected route selection: ${routeId ?? 'none'}`);
      }
      return { profile: effective, baseProfile: base, route };
    },
    inspect: () => undefined,
    load: async () => {},
    reload: async () => {},
  };
}

const DEFAULT_EXTERNAL_EXECUTOR_DESCRIPTOR: AgentExecutorDescriptor = {
  id: 'grok-acp',
  protocol: 'acp-v1',
  command: 'grok',
  args: ['agent', 'stdio'],
  revision: 'test-revision',
};

function externalExecutorRegistry(
  descriptor: AgentExecutorDescriptor = DEFAULT_EXTERNAL_EXECUTOR_DESCRIPTOR,
  validateBinding: AgentExecutorProvider['validateBinding'] = (binding) => ({
    ok: true,
    binding,
  }),
): IAgentExecutorRegistry {
  const provider: AgentExecutorProvider = {
    id: 'test-provider',
    protocol: descriptor.protocol,
    validateOptions: (value) => value as Readonly<Record<string, string | number | boolean>>,
    validateBinding,
    create: () => {
      throw new Error('not used');
    },
  };
  return {
    _serviceBrand: undefined,
    get: (id) => id === 'native'
      ? { id: 'native', protocol: 'native', args: [], revision: 'native' }
      : id === descriptor.id
        ? descriptor
        : undefined,
    resolve: (id = 'native', options = {}) => {
      if (id === 'native') {
        return {
          descriptor: { id: 'native', protocol: 'native', args: [], revision: 'native' },
          options: {},
        };
      }
      if (id !== descriptor.id) throw new Error(`Unknown executor ${id}`);
      return {
        descriptor,
        options: options as Readonly<Record<string, string | number | boolean>>,
        provider,
      };
    },
    validateBinding: (_id, _options, binding) => provider.validateBinding(binding),
    resolveExecutable: async function (id, options) { return this.resolve(id, options); },
    discover: async () => [],
    provider: (protocol) => provider?.protocol === protocol ? provider : undefined,
  };
}

function singleProfileCatalog(profile: AgentProfile): ISessionAgentProfileCatalog {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
    get: (name) => name === profile.name ? profile : undefined,
    getDefault: () => profile,
    list: () => [profile],
    listRoutes: () => [],
    routeDiagnostics: () => [],
    resolveSelection: () => ({ profile, baseProfile: profile, route: undefined }),
    inspect: () => undefined,
    load: async () => {},
    reload: async () => {},
  };
}

describe('AgentProfileService.bind', () => {
  let ctx: TestAgentContext;
  let homeDir: string;

  beforeAll(() => {
    registerAgentProfile({
      name: 'delegates-explore',
      subagents: ['explore'],
      serviceTier: 'priority',
      requestParams: { seed: 42, enabled: true },
      systemPrompt: () => 'delegate test',
    });
  });

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-bind-home-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  function buildContext(): { ctx: TestAgentContext; profile: IAgentProfileService } {
    ctx = createTestAgent(hostEnvironmentServices(homeDir, hostPathClass));
    return { ctx, profile: ctx.get(IAgentProfileService) };
  }

  function buildNativeResumeProfile(profile: AgentProfile): IAgentProfileService {
    ctx = createTestAgent(
      nativeResumeOptions(),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(profile)),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    return ctx.get(IAgentProfileService);
  }

  async function bindNativeResumeProfile(
    profile: AgentProfile,
    model = RESUME_OLD_MODEL,
    thinking = 'low',
  ): Promise<IAgentProfileService> {
    const service = buildNativeResumeProfile(profile);
    await service.bind({
      profile: profile.name,
      model,
      thinking,
      delegationPosition: 'sub',
    });
    return service;
  }

  async function bindExternalResumeProfile(
    profile: AgentProfile,
    registry: IAgentExecutorRegistry,
  ): Promise<IAgentProfileService> {
    ctx = createTestAgent(
      appService(IAgentExecutorRegistry, registry),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(profile)),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    const service = ctx.get(IAgentProfileService);
    await service.bind({ profile: profile.name, delegationPosition: 'sub' });
    return service;
  }

  it('rebuilds the bound prompt from the latest catalog profile and prompt fields', async () => {
    let current = normalizeAgentProfile({
      name: 'rebuild-profile',
      modelAlias: RESUME_OLD_MODEL,
      description: 'old definition',
      systemPrompt: () => 'disk-old',
    });
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => name === current.name ? current : undefined,
      getDefault: () => current,
      list: () => [current],
      listRoutes: () => [],
      routeDiagnostics: () => [],
      resolveSelection: () => ({ profile: current, baseProfile: current }),
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(
      nativeResumeOptions(),
      sessionService(ISessionAgentProfileCatalog, catalog),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    const config = ctx.get(IConfigService);
    const get = config.get.bind(config);
    let shared = 'FIELD_OLD';
    vi.spyOn(config, 'get').mockImplementation(((domain: string) =>
      domain === 'prompt' ? { overrides: { fields: { 'system.shared': shared } } } : get(domain)) as IConfigService['get']);
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({ profile: current.name, model: RESUME_OLD_MODEL, thinking: 'low' });
    expect(profile.getSystemPrompt()).toBe('disk-old\n\nFIELD_OLD');

    current = normalizeAgentProfile({
      name: 'rebuild-profile',
      modelAlias: RESUME_OLD_MODEL,
      description: 'new definition',
      systemPrompt: () => 'disk-new',
    });
    shared = 'FIELD_NEW';
    await profile.rebuildPromptContext();

    expect(profile.getSystemPrompt()).toBe('disk-new\n\nFIELD_NEW');
    expect(profile.data().boundProfile?.description).toBe('new definition');
  });

  it('binds an external profile without persisting descriptor environment secrets', async () => {
    const secret = 'sentinel-profile-secret';
    const descriptorConfig = {
      protocol: 'acp-v1',
      command: 'grok',
      args: ['agent', 'stdio'],
      env: { HARNESS_TOKEN: secret },
    };
    const revision = descriptorRevisionFromConfig(descriptorConfig);
    const external = normalizeAgentProfile({
      name: 'grok-worker',
      executor: 'grok-acp',
      executorOptions: { mode: 'default' },
      modelAlias: 'grok-build',
      systemPrompt: () => 'external worker',
    });
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => name === external.name ? external : undefined,
      getDefault: () => external,
      list: () => [external],
      listRoutes: () => [],
      routeDiagnostics: () => [],
      resolveSelection: () => ({ profile: external, baseProfile: external, route: undefined }),
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent(
      { persistence },
      appService(IAgentExecutorRegistry, externalExecutorRegistry({
        id: 'grok-acp',
        ...descriptorConfig,
        revision,
      })),
      sessionService(ISessionAgentProfileCatalog, catalog),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    const svc = ctx.get(IAgentProfileService);

    await svc.bind({ profile: external.name, delegationPosition: 'sub' });
    await ctx.get(IWireService).flush();

    expect(svc.data()).toMatchObject({
      executorId: 'grok-acp',
      executorProtocol: 'acp-v1',
      executorOptions: { mode: 'default' },
      executorDescriptorRevision: revision,
      modelAlias: 'grok-build',
    });
    const profileRecords = persistence.records.filter((record) => record.type === 'profile.bind');
    expect(profileRecords).toHaveLength(1);
    expect(JSON.stringify(profileRecords)).not.toContain(secret);
    expect(() => svc.resolveModelContext()).toThrow(/unsupported for external executor/);
  });

  it.each([
    ['grok-acp', 'acp-v1', 'grok-4.6'],
    ['cursor-acp', 'acp-v1', 'cursor-fast'],
    ['codex-app-server', 'codex-app-server', 'gpt-5.6-codex'],
  ])('preserves %s model aliases and xhigh effort outside the native model catalog', async (
    executorId,
    protocol,
    modelAlias,
  ) => {
    const external = normalizeAgentProfile({
      name: `${executorId}-worker`,
      executor: executorId,
      modelAlias,
      thinkingEffort: 'xhigh',
      systemPrompt: () => 'external worker',
    });
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent(
      { persistence },
      appService(IAgentExecutorRegistry, externalExecutorRegistry({
        id: executorId,
        protocol,
        command: executorId,
        args: [],
        revision: 'test-revision',
      })),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(external)),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    await ctx.get(IModelService).replaceAll({
      [`native-provider/${modelAlias}`]: {
        provider: 'test-provider',
        model: modelAlias,
        maxContextSize: 1_000_000,
      },
    });
    const svc = ctx.get(IAgentProfileService);

    await svc.bind({ profile: external.name, delegationPosition: 'sub' });
    await ctx.get(IWireService).flush();

    expect(svc.data()).toMatchObject({
      executorId,
      executorProtocol: protocol,
      modelAlias,
      thinkingLevel: 'xhigh',
    });
    expect(persistence.records.find((record) => record.type === 'profile.bind')).toMatchObject({
      modelAlias,
      thinkingEffort: 'xhigh',
    });
    await expect(svc.setModel(`${modelAlias}-next`)).resolves.toEqual({
      model: `${modelAlias}-next`,
    });
    svc.setThinking('xhigh');
    expect(svc.data()).toMatchObject({
      modelAlias: `${modelAlias}-next`,
      thinkingLevel: 'xhigh',
    });
  });

  it.each(['XHIGH', 'on', 'off'])(
    'keeps external effort %s outside colliding native thinking rules',
    async (thinkingEffort) => {
      const modelAlias = 'collision-model';
      const external = normalizeAgentProfile({
        name: `external-${thinkingEffort}`,
        executor: 'grok-acp',
        modelAlias,
        thinkingEffort,
        systemPrompt: () => 'external worker',
      });
      ctx = createTestAgent(
        {
          initialConfig: {
            thinking: { enabled: false, effort: 'low', forcedEffort: 'max' },
            providers: {
              strict: {
                type: 'kimi',
                apiKey: 'test-key',
                baseUrl: 'https://api.example.test/v1',
              },
            },
            models: {
              [modelAlias]: {
                provider: 'strict',
                model: modelAlias,
                maxContextSize: 1_000_000,
                capabilities: ['thinking', 'always_thinking'],
                supportEfforts: ['high'],
              },
            },
          },
        },
        appService(IAgentExecutorRegistry, externalExecutorRegistry()),
        sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(external)),
        hostEnvironmentServices(homeDir, hostPathClass),
      );
      const svc = ctx.get(IAgentProfileService);
      const statuses: AgentStatusUpdated[] = [];
      ctx.get(IEventBus).subscribe(AgentStatusUpdated, (event) => statuses.push(event));

      await svc.bind({ profile: external.name, delegationPosition: 'sub' });
      svc.republishStatus();

      expect(svc.data()).toMatchObject({
        modelAlias,
        thinkingLevel: thinkingEffort,
        modelCapabilities: UNKNOWN_CAPABILITY,
      });
      expect(svc.getEffectiveThinkingLevel()).toBe(thinkingEffort);
      expect(svc.getModelCapabilities()).toBe(UNKNOWN_CAPABILITY);
      expect(svc.getMaxOutputSize()).toBeUndefined();
      expect(svc.resolveRequestParams()).toMatchObject({ thinkingEffort });
      expect(svc.hasProvider()).toBe(true);
      await vi.waitFor(() => {
        expect(statuses.at(-1)).toMatchObject({
          model: modelAlias,
          thinkingEffort,
          maxContextTokens: undefined,
        });
      });
    },
  );

  it('adopts only an executor validator explicit binding normalization', async () => {
    const external = normalizeAgentProfile({
      name: 'validated-worker',
      executor: 'validated-executor',
      modelAlias: 'profile-model',
      thinkingEffort: 'high',
      systemPrompt: () => 'external worker',
    });
    ctx = createTestAgent(
      appService(IAgentExecutorRegistry, externalExecutorRegistry({
        id: 'validated-executor',
        protocol: 'acp-v1',
        command: 'validated',
        args: [],
        revision: 'test-revision',
      }, () => ({
        ok: true,
        binding: { modelAlias: 'executor-model', thinkingEffort: 'xhigh' },
      }))),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(external)),
      hostEnvironmentServices(homeDir, hostPathClass),
    );

    await ctx.get(IAgentProfileService).bind({
      profile: external.name,
      delegationPosition: 'sub',
    });

    expect(ctx.get(IAgentProfileService).data()).toMatchObject({
      modelAlias: 'executor-model',
      thinkingLevel: 'xhigh',
    });
  });

  it('surfaces executor binding validation failures without clamping effort', async () => {
    const external = normalizeAgentProfile({
      name: 'strict-worker',
      executor: 'strict-executor',
      modelAlias: 'strict-model',
      thinkingEffort: 'unsupported',
      systemPrompt: () => 'external worker',
    });
    ctx = createTestAgent(
      appService(IAgentExecutorRegistry, externalExecutorRegistry({
        id: 'strict-executor',
        protocol: 'acp-v1',
        command: 'strict',
        args: [],
        revision: 'test-revision',
      }, (binding) => ({
        ok: false,
        diagnostic: `thinking_effort ${binding.thinkingEffort} is unsupported`,
      }))),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(external)),
      hostEnvironmentServices(homeDir, hostPathClass),
    );

    await expect(ctx.get(IAgentProfileService).bind({
      profile: external.name,
      delegationPosition: 'sub',
    })).rejects.toThrow(/thinking_effort unsupported is unsupported/);
  });

  it('fails an external profile closed when no model is pinned or dispatched', async () => {
    const external = normalizeAgentProfile({
      name: 'grok-worker-unbound',
      executor: 'grok-acp',
      systemPrompt: () => 'external worker',
    });
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => name === external.name ? external : undefined,
      getDefault: () => external,
      list: () => [external],
      listRoutes: () => [],
      routeDiagnostics: () => [],
      resolveSelection: () => ({ profile: external, baseProfile: external, route: undefined }),
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(
      appService(IAgentExecutorRegistry, externalExecutorRegistry()),
      sessionService(ISessionAgentProfileCatalog, catalog),
      hostEnvironmentServices(homeDir, hostPathClass),
    );

    await expect(
      ctx.get(IAgentProfileService).bind({
        profile: external.name,
        delegationPosition: 'sub',
      }),
    ).rejects.toMatchObject({ code: 'model.not_configured' });
  });

  it('intersects a native explore binding with the persistent research ceiling after lease overlays and rebind', async () => {
    const { profile: svc } = buildContext();
    await svc.bind({
      profile: 'explore', model: MOCK_MODEL, executionRestriction: 'research-readonly',
      lease: { name: 'explore', tools: null },
    });
    const policy = ctx.get(IAgentToolPolicyService);
    expect(svc.data().executionRestriction).toBe('research-readonly');
    expect(policy.isToolActive('Read')).toBe(true);
    expect(policy.isToolActive('Bash')).toBe(false);
    expect(policy.isToolActive('Read', 'user')).toBe(false);
    expect(policy.isToolActive('Read', 'mcp')).toBe(false);
    await svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    svc.addActiveTool('Bash');
    expect(svc.data().executionRestriction).toBe('research-readonly');
    expect(policy.isToolActive('Read')).toBe(true);
    expect(policy.isToolActive('Bash')).toBe(false);
    await ctx.expectResumeMatches();
  });

  it('rejects an external research birth before executor resolution', async () => {
    const { profile: svc } = buildContext();
    const resolve = vi.spyOn(ctx.get(IAgentExecutorRegistry), 'resolveExecutable');
    await expect(svc.bind({
      resolvedProfile: normalizeAgentProfile({ name: 'explore', executor: 'external', systemPrompt: () => '' }),
      model: MOCK_MODEL, executionRestriction: 'research-readonly',
    })).rejects.toThrow('native executor');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('binds a profile + model atomically and becomes runnable', async () => {
    const { profile: svc } = buildContext();

    const container = new InstantiationService(new ServiceCollection(), true);
    const catalog = new BuiltinAgentProfileLoaderService(container);
    expect(catalog.get(DEFAULT_AGENT_PROFILE_NAME)).toBeDefined();
    catalog.dispose();
    container.dispose();

    expect(svc.isRunnable()).toBe(false);

    await svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(svc.data().modelAlias).toBe(MOCK_MODEL);
    expect(svc.isRunnable()).toBe(true);
    expect(svc.getActiveToolNames()?.length).toBeGreaterThan(0);
    expect(svc.getSystemPrompt()).toContain('You are Kiki,');
  });

  it('binds the default main-agent profile even when it is hidden from dispatch', async () => {
    ctx = createTestAgent(
      sessionService(ISessionAgentProfileCatalog, disabledDefaultCatalog()),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    const svc = ctx.get(IAgentProfileService);

    await svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(svc.getSystemPrompt()).toBe('disabled default binding');
  });

  it('resolves a bare default_model through the canonical model entry', async () => {
    const { profile: svc } = buildContext();
    const canonicalId = `test-provider/${MOCK_MODEL}`;
    await ctx.get(IModelService).replaceAll({
      [canonicalId]: {
        provider: 'test-provider',
        model: MOCK_MODEL,
        maxContextSize: 1_000_000,
      },
    });
    await ctx.get(IConfigService).set('defaultModel', MOCK_MODEL, ConfigTarget.Memory);

    await svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME });

    expect(svc.data().modelAlias).toBe(canonicalId);
    expect(ctx.get(IModelCatalog).get(svc.data().modelAlias!).id).toBe(canonicalId);
  });

  it('binds a profile model_alias when the caller does not name a model', async () => {
    const pinned = normalizeAgentProfile({
      name: 'reviewer',
      modelAlias: MOCK_MODEL,
      thinkingEffort: 'low',
      systemPrompt: () => 'pinned reviewer',
    });
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => (name === pinned.name ? pinned : undefined),
      getDefault: () => pinned,
      list: () => [pinned],
      listRoutes: () => [],
      routeDiagnostics: () => [],
      resolveSelection: () => ({ profile: pinned, baseProfile: pinned, route: undefined }),
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(
      sessionService(ISessionAgentProfileCatalog, catalog),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    await ctx.get(IConfigService).set('defaultModel', '', ConfigTarget.Memory);
    const svc = ctx.get(IAgentProfileService);

    await svc.bind({ profile: 'reviewer' });

    expect(svc.data()).toMatchObject({
      profileName: 'reviewer',
      modelAlias: MOCK_MODEL,
    });
  });

  it('resolves a bare subagent profile model pin through the canonical model entry', async () => {
    ctx = createTestAgent(
      sessionService(ISessionAgentProfileCatalog, routedCatalog(MOCK_MODEL)),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    const canonicalId = `test-provider/${MOCK_MODEL}`;
    await ctx.get(IModelService).replaceAll({
      [canonicalId]: {
        provider: 'test-provider',
        model: MOCK_MODEL,
        maxContextSize: 1_000_000,
      },
    });
    const svc = ctx.get(IAgentProfileService);

    await svc.bind({ route: 'reviewer.ui-k3' });

    expect(svc.data()).toMatchObject({
      modelAlias: canonicalId,
      lockedModelAlias: canonicalId,
    });
    expect(ctx.get(IModelCatalog).get(svc.data().modelAlias!).id).toBe(canonicalId);
    await expect(svc.setModel(MOCK_MODEL)).resolves.toMatchObject({ model: canonicalId });
  });

  it('normalizes external route locks before comparing and persisting them', async () => {
    ctx = createTestAgent(
      appService(IAgentExecutorRegistry, externalExecutorRegistry({
        id: 'grok-acp',
        protocol: 'acp-v1',
        command: 'grok',
        args: [],
        revision: 'test-revision',
      }, (binding) => ({
        ok: true,
        binding: {
          modelAlias:
            binding.modelAlias === 'vendor-short' ? 'vendor/model' : binding.modelAlias,
          thinkingEffort: binding.thinkingEffort,
        },
      }))),
      sessionService(
        ISessionAgentProfileCatalog,
        routedCatalog('vendor-short', 'xhigh', 'grok-acp'),
      ),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    const svc = ctx.get(IAgentProfileService);

    await svc.bind({
      route: 'reviewer.ui-k3',
      model: 'vendor-short',
      thinking: 'xhigh',
      delegationPosition: 'sub',
    });

    expect(svc.data()).toMatchObject({
      modelAlias: 'vendor/model',
      lockedModelAlias: 'vendor/model',
      thinkingLevel: 'xhigh',
      lockedThinkingEffort: 'xhigh',
    });
  });

  it('does not admit deleted collaboration tools on any builtin profile', () => {
    const container = new InstantiationService(new ServiceCollection(), true);
    const catalog = new BuiltinAgentProfileLoaderService(container);
    const collaborationTools = [
      'spawn_agent',
      'list_agents',
      'wait_agent',
      'followup_task',
      'interrupt_agent',
      'send_message',
    ];

    for (const profileName of ['agent', 'coder', 'explore']) {
      const profile = catalog.get(profileName);
      expect(profile).toBeDefined();
      expect(collaborationTools.filter((name) => isToolActive(profile!, name))).toEqual([]);
    }

    catalog.dispose();
    container.dispose();
  });

  it('waits for the identity freeze instead of racing it', async () => {
    const deferred = deferredAgentIdentityStub();
    ctx = createTestAgent(
      appService(IAgentIdentity, deferred.identity),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    const svc = ctx.get(IAgentProfileService);

    const bound = svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    setTimeout(() => deferred.freeze(), 20);
    await bound;

    expect(svc.data().modelAlias).toBe(MOCK_MODEL);
    expect(svc.isRunnable()).toBe(true);
  });

  it('renders the prompt and disclosure from the injected host clock', async () => {
    const hostClock: IHostClock = {
      _serviceBrand: undefined,
      now: () => new Date('2026-07-29T04:00:00.000Z'),
      timeZone: () => 'Asia/Shanghai',
    };
    ctx = createTestAgent(appService(IHostClock, hostClock), hostEnvironmentServices(homeDir, hostPathClass));
    const svc = ctx.get(IAgentProfileService);

    await svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    expect(svc.getSystemPrompt()).toContain('2026-07-29T04:00:00.000Z');
    expect(svc.data().environmentDisclosure).toMatchObject({
      date: {
        disclosed: true,
        value: { localDate: '2026-07-29', timeZone: 'Asia/Shanghai' },
      },
    });
  });

  it('persists the complete binding in one journal record', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent(
      {
        persistence,
        initialConfig: {
          thinking: { enabled: true, effort: 'low' },
        },
      },
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    ctx.configure({
      modelCapabilities: {
        image_in: false,
        video_in: false,
        audio_in: false,
        thinking: true,
        tool_use: true,
        max_context_tokens: 1_000_000,
      },
    });
    const svc = ctx.get(IAgentProfileService);
    await ctx.get(IWireService).flush();
    const start = persistence.records.length;

    await svc.bind({
      profile: DEFAULT_AGENT_PROFILE_NAME,
      model: MOCK_MODEL,
      thinking: 'on',
    });
    await ctx.get(IWireService).flush();

    const records = persistence.records.slice(start).filter((record) => record.type === 'profile.bind');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: 'profile.bind',
      profileName: DEFAULT_AGENT_PROFILE_NAME,
      modelAlias: MOCK_MODEL,
      thinkingEffort: 'on',
      systemPrompt: expect.stringContaining('You are Kiki,'),
      activeToolNames: expect.arrayContaining(['Read', 'Write', 'Bash']),
      disallowedTools: [],
    });
  });

  it('binds the routed snapshot and warns when a human overrides its pins', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent(
      { persistence },
      hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, routedCatalog()),
    );
    await ctx.get(IModelService).set('other-model', {
      provider: 'test-provider',
      model: 'other-model',
      maxContextSize: 1_000_000,
      capabilities: ['thinking'],
      supportEfforts: ['low', 'high'],
    });
    const { profile, toolPolicy } = profileServices(ctx);

    await profile.bind({ route: 'reviewer.ui-k3' });
    await ctx.get(IWireService).flush();

    expect(profile.data()).toMatchObject({
      profileName: 'reviewer',
      routeId: 'reviewer.ui-k3',
      modelAlias: MOCK_MODEL,
      lockedModelAlias: MOCK_MODEL,
      lockedThinkingEffort: 'off',
      thinkingLevel: 'off',
      systemPrompt: 'routed reviewer',
      activeToolNames: ['Read', 'Bash'],
      toolAllowPolicies: [['Read', 'Bash'], ['Read']],
      disallowedTools: ['Write', 'Bash'],
      subagents: ['explore'],
    });
    expect(toolPolicy.isToolActive('Read')).toBe(true);
    expect(toolPolicy.isToolActive('Bash')).toBe(false);
    expect(toolPolicy.isToolActive('Write')).toBe(false);
    expect(persistence.records.find((record) => record.type === 'profile.bind')).toMatchObject({
      profileName: 'reviewer',
      routeId: 'reviewer.ui-k3',
      toolAllowPolicies: [['Read', 'Bash'], ['Read']],
      lockedModelAlias: MOCK_MODEL,
      lockedThinkingEffort: 'off',
    });
    const warnings: Array<{ code?: string; message: string }> = [];
    ctx.get(IEventBus).subscribe(WarningIssued, (event) => {
      warnings.push({ code: event.code, message: event.message });
    });
    await expect(profile.setModel('other-model')).resolves.toMatchObject({
      model: 'other-model',
    });
    expect(profile.data().modelAlias).toBe('other-model');
    expect(profile.data().lockedModelAlias).toBe(MOCK_MODEL);
    profile.setThinking('high');
    expect(profile.data().thinkingLevel).toBe('high');
    expect(profile.data().lockedThinkingEffort).toBe('off');
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'profile-constraint-override',
          message: expect.stringContaining('locks model_alias'),
        }),
        expect.objectContaining({
          code: 'profile-constraint-override',
          message: expect.stringContaining('locks thinking_effort'),
        }),
      ]),
    );
    await expect(profile.bind({ profile: 'reviewer', model: MOCK_MODEL })).rejects.toMatchObject({
      code: 'agent_profile_route.switch_forbidden',
    });
  });

  it('fails a routed bind atomically when its pinned model alias is unavailable', async () => {
    ctx = createTestAgent(
      hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, routedCatalog('removed-model')),
    );
    const profile = ctx.get(IAgentProfileService);

    await expect(profile.bind({ route: 'reviewer.ui-k3' })).rejects.toMatchObject({
      code: 'agent_profile_route.model_alias_missing',
    });
    expect(profile.data().profileName).toBeUndefined();
    expect(profile.data().routeId).toBeUndefined();
  });

  it('fails a routed bind when the pinned effort cannot be honored exactly', async () => {
    const alias = 'kimi-code/kimi-for-coding';
    ctx = createTestAgent(
      {
        initialConfig: {
          providers: {
            kimi: { type: 'kimi', apiKey: 'test-key', baseUrl: 'https://api.example.test/v1' },
          },
          models: {
            [alias]: {
              provider: 'kimi',
              model: 'kimi-for-coding',
              maxContextSize: 1_000_000,
              capabilities: ['thinking'],
              supportEfforts: ['low', 'high'],
            },
          },
        },
      },
      hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, routedCatalog(alias, 'ultra')),
    );
    const profile = ctx.get(IAgentProfileService);

    await expect(profile.bind({ route: 'reviewer.ui-k3' })).rejects.toMatchObject({
      code: 'agent_profile_route.binding_conflict',
    });
    expect(profile.data().profileName).toBeUndefined();
    expect(profile.data().routeId).toBeUndefined();
  });

  it.each(['main', 'sub'] as const)('applies profile tier over model defaults for %s bindings', async (delegationPosition) => {
    const configured = normalizeAgentProfile({ name: 'tier-helper', modelAlias: 'tier-model', serviceTier: 'flex', systemPrompt: () => '' });
    ctx = createTestAgent({ initialConfig: { models: {
      'tier-model': { provider: 'test-provider', model: 'tier-model', maxContextSize: 1000, serviceTier: 'priority' },
    } } }, hostEnvironmentServices(homeDir, hostPathClass),
    sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(configured)));
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({ profile: configured.name, delegationPosition });
    expect(profile.resolveRequestParams().serviceTier).toBe('flex');
    expect(profile.data().serviceTier).toBe('flex');
    profile.applyBindingSnapshot(profile.data());
    expect(profile.resolveRequestParams().serviceTier).toBe('flex');
    await profile.setModel(MOCK_MODEL);
    expect(profile.resolveRequestParams().serviceTier).toBe('flex');
  });

  it.each([['main', true], ['sub', true], ['main', false], ['sub', false]] as const)('scopes effort to the canonical model and clamps parameter budgets for %s (pinned=%s)', async (delegationPosition, pinned) => {
    const configured = resumeProfile({
      modelAlias: pinned ? RESUME_OLD_MODEL : undefined,
      thinkingEffort: 'medium', contextBudget: 2000, maxCompletionTokens: 500,
      requestParams: { temperature: 0.4 },
      modelProfiles: [{ alias: 'new-model', contextBudget: 1200, requestParams: { top_p: 0.8 }, serviceTier: 'flex' }],
    });
    const options = nativeResumeOptions();
    const models = {
      [RESUME_OLD_MODEL]: { ...options.initialConfig.models[RESUME_OLD_MODEL], maxContextSize: 1000, maxInputSize: 800, maxOutputSize: 400, supportEfforts: ['low', 'medium', 'high'] },
      [RESUME_NEW_MODEL]: { ...options.initialConfig.models[RESUME_NEW_MODEL], maxContextSize: 6000, supportEfforts: ['low', 'medium', 'high', 'max'], overrides: { defaultEffort: 'max', requestParams: { seed: 42, temperature: 0.2 } } },
    };
    ctx = createTestAgent({ initialConfig: {
      ...options.initialConfig,
      thinking: { effort: 'low' },
      models,
    } },  hostEnvironmentServices(homeDir, hostPathClass), sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(configured)));
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({ profile: configured.name, model: RESUME_OLD_MODEL, delegationPosition });
    expect(profile.data().thinkingLevel).toBe(pinned ? 'medium' : 'low');
    expect(profile.resolveModelContext()).toMatchObject({ maxOutputSize: 400, modelCapabilities: { max_context_tokens: 1000, max_input_tokens: 800 } });
    await profile.bind({ profile: configured.name, model: 'new-model', delegationPosition });
    expect(profile.data().thinkingLevel).toBe('max');
    expect(profile.resolveModelContext()).toMatchObject({ maxOutputSize: 500, modelCapabilities: { max_context_tokens: 1200, max_input_tokens: 1200 } });
    expect(profile.resolveRequestParams()).toMatchObject({ sampling: { temperature: 0.4, topP: 0.8 }, requestParams: { seed: 42 }, serviceTier: 'flex' });
    const effortOnly = await profile.prepareResumeBinding({ thinkingEffort: 'low' });
    effortOnly();
    expect(profile.data().thinkingLevel).toBe('low');
    (await profile.prepareResumeBinding({ modelAlias: RESUME_NEW_MODEL }))();
    expect(profile.data().thinkingLevel).toBe('low');
    (await profile.prepareResumeBinding({ modelAlias: RESUME_OLD_MODEL, allowModelChange: true }))();
    expect(profile.data().thinkingLevel).toBe(pinned ? 'medium' : 'low');
    await profile.setModel('new-model');
    expect(profile.data().thinkingLevel).toBe('max');
    await profile.bind({ profile: configured.name, model: RESUME_OLD_MODEL, thinking: 'low', delegationPosition });
    expect(profile.data().thinkingLevel).toBe('low');
  });

  it('restores profile request settings from the binding record without catalog resolution', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent({ persistence }, hostEnvironmentServices(homeDir, hostPathClass));
    const profile = ctx.get(IAgentProfileService);

    await profile.bind({
      profile: 'delegates-explore',
      model: MOCK_MODEL,
    });
    expect(profile.resolveRequestParams()).toMatchObject({
      serviceTier: 'priority',
      requestParams: { seed: 42, enabled: true },
    });
    await ctx.get(IWireService).flush();

    const bindingRecord = persistence.records.find((record) => record.type === 'profile.bind');
    expect(bindingRecord).toMatchObject({
      profileName: 'delegates-explore',
      subagents: ['explore'],
      serviceTier: 'priority',
      requestParams: { seed: 42, enabled: true },
    });

    await ctx.dispose();
    const emptyCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: () => undefined,
      getDefault: () => ({
        name: DEFAULT_AGENT_PROFILE_NAME,
        tools: undefined,
        systemPrompt: () => '',
      }),
      list: () => [],
      load: async () => {},
      reload: async () => {},
    } as unknown as ISessionAgentProfileCatalog;
    ctx = createTestAgent(
      { persistence },
      hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, emptyCatalog),
    );

    await ctx.restorePersisted();

    const restored = ctx.get(IAgentProfileService);
    expect(restored.data()).toMatchObject({
      profileName: 'delegates-explore',
      subagents: ['explore'],
      serviceTier: 'priority',
      requestParams: { seed: 42, enabled: true },
    });
    expect(restored.resolveRequestParams()).toMatchObject({
      serviceTier: 'priority',
      requestParams: { seed: 42, enabled: true },
    });
    expect(restored.data().agentsMdPaths).toEqual(bindingRecord?.['agentsMdPaths']);
  });

  it('refreshes the system prompt from the session cwd after a default bind', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-bind-work-'));
    try {
      await writeFile(join(workDir, 'AGENTS.md'), 'v1 instructions', 'utf-8');
      ctx = createTestAgent(hostEnvironmentServices(homeDir, hostPathClass), { cwd: workDir });
      const svc = ctx.get(IAgentProfileService);
      await svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

      await writeFile(join(workDir, 'AGENTS.md'), 'v2 instructions', 'utf-8');
      await svc.refreshSystemPrompt();

      expect(svc.getSystemPrompt()).toContain('v2 instructions');
    } finally {
      await rm(workDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('setModel applies the default profile when none is bound yet', async () => {
    const { profile: svc } = buildContext();

    expect(svc.data().profileName).toBeUndefined();

    await svc.setModel(MOCK_MODEL);

    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(svc.data().modelAlias).toBe(MOCK_MODEL);
    expect(svc.isRunnable()).toBe(true);
  });

  it('setModel persists the canonical id for a bare alias', async () => {
    const { profile: svc } = buildContext();
    const canonicalId = `test-provider/${MOCK_MODEL}`;
    await ctx.get(IModelService).replaceAll({
      [canonicalId]: {
        provider: 'test-provider',
        model: MOCK_MODEL,
        maxContextSize: 1_000_000,
      },
    });

    await svc.setModel(MOCK_MODEL);

    expect(svc.data().modelAlias).toBe(canonicalId);
  });

  it('setModel keeps the existing profile when one is already bound', async () => {
    const { profile: svc } = buildContext();

    await svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    await svc.setModel(MOCK_MODEL);

    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
  });

  it('rebinds to a different base profile and applies the new profile pins', async () => {
    const first = normalizeAgentProfile({
      name: 'first',
      modelAlias: MOCK_MODEL,
      thinkingEffort: 'low',
      tools: ['Read'],
      systemPrompt: () => 'first profile',
    });
    const second = normalizeAgentProfile({
      name: 'second',
      modelAlias: MOCK_MODEL,
      thinkingEffort: 'off',
      tools: ['Bash'],
      systemPrompt: () => 'second profile',
    });
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => [first, second].find((profile) => profile.name === name),
      getDefault: () => first,
      list: () => [first, second],
      listRoutes: () => [],
      routeDiagnostics: () => [],
      resolveSelection: () => {
        throw new Error('routes are not configured');
      },
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(
      sessionService(ISessionAgentProfileCatalog, catalog),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    ctx.configure({
      modelCapabilities: {
        image_in: false,
        video_in: false,
        audio_in: false,
        thinking: true,
        tool_use: true,
        max_context_tokens: 1_000_000,
      },
    });
    const svc = ctx.get(IAgentProfileService);

    await svc.bind({ profile: first.name, model: MOCK_MODEL, thinking: 'on' });
    await svc.bind({ profile: second.name });

    expect(svc.data().profileName).toBe(second.name);
    expect(svc.data().modelAlias).toBe(MOCK_MODEL);
    expect(svc.data().thinkingLevel).toBe('off');
    expect(svc.getSystemPrompt()).toBe('second profile');
    expect(svc.getActiveToolNames()).toEqual(['Bash']);
    await expect(svc.bind({ profile: 'missing-profile' })).rejects.toThrow(/Unknown agent profile/);
    expect(svc.data().profileName).toBe(second.name);
  });

  it('rejects an unsupported thinking effort atomically before first bind', async () => {
    ctx = createTestAgent(
      {
        initialConfig: {
          providers: {
            kimi: { type: 'kimi', apiKey: 'test-key', baseUrl: 'https://api.example.test/v1' },
          },
          models: {
            'kimi-code/kimi-for-coding': {
              provider: 'kimi',
              model: 'kimi-for-coding',
              maxContextSize: 1_000_000,
              capabilities: ['thinking'],
              supportEfforts: ['low', 'high'],
            },
          },
        },
      },
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    const svc = ctx.get(IAgentProfileService);

    await expect(
      svc.bind({
        profile: DEFAULT_AGENT_PROFILE_NAME,
        model: 'kimi-code/kimi-for-coding',
        thinking: 'ultra',
        strictThinking: true,
      }),
    ).rejects.toThrow(/not supported by model/);

    expect(svc.data().profileName).toBeUndefined();
    await svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: 'kimi-code/kimi-for-coding' });
    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
  });

  it('rejects an explicit unsupported effort even without strictThinking', async () => {
    ctx = createTestAgent(
      {
        initialConfig: {
          providers: {
            kimi: { type: 'kimi', apiKey: 'test-key', baseUrl: 'https://api.example.test/v1' },
          },
          models: {
            'kimi-code/kimi-for-coding': {
              provider: 'kimi',
              model: 'kimi-for-coding',
              maxContextSize: 1_000_000,
              capabilities: ['thinking'],
              supportEfforts: ['low', 'high'],
            },
          },
        },
      },
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    const svc = ctx.get(IAgentProfileService);
    await expect(svc.bind({
      profile: DEFAULT_AGENT_PROFILE_NAME,
      model: 'kimi-code/kimi-for-coding',
      thinking: 'ultra',
    })).rejects.toThrow(/not supported/);
    expect(svc.data().profileName).toBeUndefined();
  });

  it('keeps effort on ordinary resume but resolves defaults on an explicit rebind', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir, hostPathClass));
    ctx.configure({
      modelCapabilities: {
        image_in: false,
        video_in: false,
        audio_in: false,
        thinking: true,
        tool_use: true,
        max_context_tokens: 1_000_000,
      },
    });
    const svc = ctx.get(IAgentProfileService);
    await svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL, thinking: 'off' });
    expect(svc.data().thinkingLevel).toBe('off');
    const apply = await svc.prepareResumeBinding({});
    apply();
    expect(svc.data().thinkingLevel).toBe('off');
    await svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    expect(svc.data().thinkingLevel).toBe('on');
  });

  it('validates a native resume change without mutation and applies both values in one update', async () => {
    const svc = await bindNativeResumeProfile(
      resumeProfile({ allowedModels: [RESUME_OLD_MODEL, RESUME_NEW_MODEL] }),
    );
    const update = vi.spyOn(svc, 'update');

    const apply = await prepareResumeBinding(svc, {
      modelAlias: RESUME_NEW_MODEL,
      thinkingEffort: 'high',
      allowModelChange: true,
    });

    expect(update).not.toHaveBeenCalled();
    expect(svc.data()).toMatchObject({
      modelAlias: RESUME_OLD_MODEL,
      thinkingLevel: 'low',
    });

    apply();

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      modelAlias: RESUME_NEW_MODEL,
      thinkingLevel: 'high',
    }));
    await ctx.get(IWireService).flush();
    expect(svc.data()).toMatchObject({
      modelAlias: RESUME_NEW_MODEL,
      thinkingLevel: 'high',
    });
  });

  it('refreshes model-specific prompt overlays atomically for a confirmed native resume model change', async () => {
    const svc = await bindNativeResumeProfile(
      resumeProfile({
        allowedModels: [RESUME_OLD_MODEL, RESUME_NEW_MODEL],
        modelProfiles: [
          {
            alias: RESUME_OLD_MODEL,
            when: 'model-a',
            promptMode: 'append',
            prompt: 'MODEL_A_OVERLAY',
          },
          {
            alias: RESUME_NEW_MODEL,
            when: 'model-b',
            promptMode: 'append',
            prompt: 'MODEL_B_OVERLAY',
          },
        ],
      }),
    );
    expect(svc.getSystemPrompt()).toContain('MODEL_A_OVERLAY');
    expect(svc.getSystemPrompt()).not.toContain('MODEL_B_OVERLAY');
    const oldPrompt = svc.getSystemPrompt();
    const update = vi.spyOn(svc, 'update');

    const apply = await prepareResumeBinding(svc, {
      modelAlias: RESUME_NEW_MODEL,
      thinkingEffort: 'high',
      allowModelChange: true,
    });

    expect(update).not.toHaveBeenCalled();
    expect(svc.data()).toMatchObject({
      modelAlias: RESUME_OLD_MODEL,
      thinkingLevel: 'low',
      systemPrompt: oldPrompt,
    });
    expect(svc.getSystemPrompt()).toBe(oldPrompt);
    expect(svc.data().boundProfile?.promptBase).toMatchObject({
      text: expect.stringContaining('resume profile'),
      environment: expect.any(Object),
    });

    apply();

    expect(update).toHaveBeenCalledTimes(1);
    const changed = update.mock.calls[0]?.[0];
    expect(changed).toMatchObject({
      modelAlias: RESUME_NEW_MODEL,
      thinkingLevel: 'high',
      systemPrompt: expect.stringContaining('MODEL_B_OVERLAY'),
    });
    expect(changed?.systemPrompt).not.toContain('MODEL_A_OVERLAY');
    await ctx.get(IWireService).flush();
    expect(svc.data()).toMatchObject({
      modelAlias: RESUME_NEW_MODEL,
      thinkingLevel: 'high',
    });
    expect(svc.getSystemPrompt()).toContain('MODEL_B_OVERLAY');
    expect(svc.getSystemPrompt()).not.toContain('MODEL_A_OVERLAY');
  });

  it('leaves native binding state unchanged when the new model cognition overlay cannot load', async () => {
    const profile = resumeProfile({
      allowedModels: [RESUME_OLD_MODEL, RESUME_NEW_MODEL],
    });
    ctx = createTestAgent(
      nativeResumeOptions(),
      homeDirServices(homeDir),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(profile)),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    const svc = ctx.get(IAgentProfileService);
    await svc.bind({
      profile: profile.name,
      model: RESUME_OLD_MODEL,
      thinking: 'low',
      delegationPosition: 'sub',
    });
    const oldPrompt = svc.getSystemPrompt();
    const current = ctx.kimiConfig.models?.[RESUME_NEW_MODEL];
    expect(current).toBeDefined();
    const cognition = { overlay: 'cognition/missing-resume.md' };
    ctx.kimiConfig = {
      ...ctx.kimiConfig,
      models: {
        ...ctx.kimiConfig.models,
        [RESUME_NEW_MODEL]: { ...current!, cognition },
      },
    };
    await ctx.get(IModelService).set(RESUME_NEW_MODEL, {
      ...current!, cognition,
      capabilities: current?.capabilities === undefined ? undefined : [...current.capabilities],
      supportEfforts: current?.supportEfforts === undefined ? undefined : [...current.supportEfforts],
    });
    const update = vi.spyOn(svc, 'update');

    await expect(
      prepareResumeBinding(svc, {
        modelAlias: RESUME_NEW_MODEL,
        thinkingEffort: 'high',
        allowModelChange: true,
      }),
    ).rejects.toMatchObject({ code: ProfileErrors.codes.COGNITION_FILE_MISSING });
    expect(update).not.toHaveBeenCalled();
    expect(svc.data()).toMatchObject({
      modelAlias: RESUME_OLD_MODEL,
      thinkingLevel: 'low',
      systemPrompt: oldPrompt,
    });
    expect(svc.getSystemPrompt()).toBe(oldPrompt);
  });

  it('uses the new model default when a confirmed native resume model change omits effort', async () => {
    const svc = await bindNativeResumeProfile(
      resumeProfile({ allowedModels: [RESUME_OLD_MODEL, RESUME_NEW_MODEL] }),
    );
    const update = vi.spyOn(svc, 'update');
    const apply = await prepareResumeBinding(svc, {
      modelAlias: RESUME_NEW_MODEL,
      allowModelChange: true,
    });
    apply();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      modelAlias: RESUME_NEW_MODEL,
      thinkingLevel: 'high',
    }));
    expect(svc.data()).toMatchObject({ modelAlias: RESUME_NEW_MODEL, thinkingLevel: 'high' });
  });

  it('accepts a canonical-equivalent native alias without model-change confirmation', async () => {
    const svc = await bindNativeResumeProfile(resumeProfile());
    const update = vi.spyOn(svc, 'update');
    const apply = await prepareResumeBinding(svc, { modelAlias: 'old-model' });

    expect(update).not.toHaveBeenCalled();
    apply();

    expect(update).not.toHaveBeenCalled();
    expect(svc.data()).toMatchObject({
      modelAlias: RESUME_OLD_MODEL,
      thinkingLevel: 'low',
    });
  });

  it('requires explicit confirmation for a different native model and names both aliases', async () => {
    const svc = await bindNativeResumeProfile(resumeProfile());

    await expect(
      prepareResumeBinding(svc, { modelAlias: RESUME_NEW_MODEL, allowModelChange: false }),
    ).rejects.toThrow(
      new RegExp(
        `from "${RESUME_OLD_MODEL}" to "${RESUME_NEW_MODEL}".*allow_model_change`,
      ),
    );
    expect(svc.data()).toMatchObject({
      modelAlias: RESUME_OLD_MODEL,
      thinkingLevel: 'low',
    });
  });

  it('rejects invalid native model and effort without changing either binding value', async () => {
    const svc = await bindNativeResumeProfile(resumeProfile());

    await expect(
      prepareResumeBinding(svc, {
        modelAlias: `${RESUME_PROVIDER}/missing-model`,
        allowModelChange: true,
      }),
    ).rejects.toThrow(/not configured/);
    expect(svc.data()).toMatchObject({
      modelAlias: RESUME_OLD_MODEL,
      thinkingLevel: 'low',
    });

    await expect(prepareResumeBinding(svc, { thinkingEffort: 'ultra' })).rejects.toThrow(/not supported/);
    expect(svc.data()).toMatchObject({
      modelAlias: RESUME_OLD_MODEL,
      thinkingLevel: 'low',
    });
  });

  it('rejects a role allowed_models violation before changing the binding', async () => {
    const svc = await bindNativeResumeProfile(
      resumeProfile({ allowedModels: [RESUME_OLD_MODEL] }),
    );

    await expect(
      prepareResumeBinding(svc, { modelAlias: RESUME_NEW_MODEL, allowModelChange: true }),
    ).rejects.toThrow(/allowed_models/);
    expect(svc.data()).toMatchObject({
      modelAlias: RESUME_OLD_MODEL,
      thinkingLevel: 'low',
    });
  });

  it('rejects a role deny_models violation before changing the binding', async () => {
    const svc = await bindNativeResumeProfile(
      resumeProfile({ denyModels: [RESUME_NEW_MODEL] }),
    );

    await expect(
      prepareResumeBinding(svc, { modelAlias: RESUME_NEW_MODEL, allowModelChange: true }),
    ).rejects.toThrow(/deny_models/);
    expect(svc.data()).toMatchObject({
      modelAlias: RESUME_OLD_MODEL,
      thinkingLevel: 'low',
    });
  });

  it('rejects a role allowed_efforts violation before changing the binding', async () => {
    const svc = await bindNativeResumeProfile(
      resumeProfile({ allowedEfforts: ['low'] }),
    );

    await expect(prepareResumeBinding(svc, { thinkingEffort: 'high' })).rejects.toThrow(/allowed_efforts/);
    expect(svc.data()).toMatchObject({
      modelAlias: RESUME_OLD_MODEL,
      thinkingLevel: 'low',
    });
  });

  it('rejects caller allowed_models, deny_models, and allowed_efforts before changing the binding', async () => {
    const cases = [
      {
        constraints: { allowedModels: [RESUME_OLD_MODEL] },
        input: { modelAlias: RESUME_NEW_MODEL, allowModelChange: true },
        message: /allowed_models/,
      },
      {
        constraints: { denyModels: [RESUME_NEW_MODEL] },
        input: { modelAlias: RESUME_NEW_MODEL, allowModelChange: true },
        message: /deny_models/,
      },
      {
        constraints: { allowedEfforts: ['low'] },
        input: { thinkingEffort: 'high' },
        message: /allowed_efforts/,
      },
    ] as const;

    for (const { constraints, input, message } of cases) {
      const svc = await bindNativeResumeProfile(resumeProfile());

      await expect(
        prepareResumeBinding(svc, {
          ...input,
          callerConstraints: [constraints],
        }),
      ).rejects.toThrow(message);
      expect(svc.data()).toMatchObject({
        modelAlias: RESUME_OLD_MODEL,
        thinkingLevel: 'low',
      });
      await ctx.dispose();
    }
  });

  it('rejects model and effort changes against hard route locks before changing the binding', async () => {
    ctx = createTestAgent(
      nativeResumeOptions(),
      sessionService(ISessionAgentProfileCatalog, routedCatalog(RESUME_OLD_MODEL, 'low')),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    const svc = ctx.get(IAgentProfileService);
    await svc.bind({ route: 'reviewer.ui-k3', delegationPosition: 'sub' });

    await expect(
      prepareResumeBinding(svc, { modelAlias: RESUME_NEW_MODEL, allowModelChange: true }),
    ).rejects.toThrow(/locked by its route/);
    await expect(prepareResumeBinding(svc, { thinkingEffort: 'high' })).rejects.toThrow(/locked by its route/);
    expect(svc.data()).toMatchObject({
      modelAlias: RESUME_OLD_MODEL,
      thinkingLevel: 'low',
    });
  });

  it.each([
    ['model', { modelAlias: 'external-new', allowModelChange: true }],
    ['effort', { thinkingEffort: 'high' }],
  ] as const)('rejects an external resume %s change without resolving another executor', async (_, input) => {
    const registry = externalExecutorRegistry();
    const external = normalizeAgentProfile({
      name: 'resume-external',
      executor: 'grok-acp',
      modelAlias: 'external-old',
      thinkingEffort: 'low',
      systemPrompt: () => 'external resume',
    });
    const svc = await bindExternalResumeProfile(external, registry);
    const resolveExecutable = vi.spyOn(registry, 'resolveExecutable');

    await expect(prepareResumeBinding(svc, input)).rejects.toThrow(/does not support changing/);
    expect(resolveExecutable).not.toHaveBeenCalled();
    expect(svc.data()).toMatchObject({
      modelAlias: 'external-old',
      thinkingLevel: 'low',
    });
  });

  it.each([['low', false], ['XHIGH', false], ['XHIGH', true]] as const)('MP-02 accepts an external no-op alias with effort %s (locked=%s) without resolving or replacing an executor', async (thinkingEffort, locked) => {
    const registry = externalExecutorRegistry();
    const external = normalizeAgentProfile({
      name: 'resume-external-noop',
      executor: 'grok-acp',
      modelAlias: 'external-old',
      thinkingEffort,
      systemPrompt: () => 'external resume',
    });
    const svc = await bindExternalResumeProfile(external, registry);
    if (locked) svc.applyBindingSnapshot({ ...svc.data(), lockedModelAlias: 'external-old', lockedThinkingEffort: thinkingEffort });
    const resolveExecutable = vi.spyOn(registry, 'resolveExecutable');
    const update = vi.spyOn(svc, 'update');

    const apply = await prepareResumeBinding(svc, { modelAlias: 'external-old' });
    apply();

    expect(resolveExecutable).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(svc.data()).toMatchObject({
      modelAlias: 'external-old',
      thinkingLevel: thinkingEffort,
    });
  });

  it('persists bound profile metadata and carries it through data and snapshots', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const bound = resumeProfile({
      sourcePath: './profiles/resume.md',
      allowedModels: [RESUME_OLD_MODEL, RESUME_NEW_MODEL],
      denyModels: [`${RESUME_PROVIDER}/blocked-model`],
      allowedEfforts: ['low', 'high'],
    });
    ctx = createTestAgent(
      { ...nativeResumeOptions(), persistence },
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(bound)),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    const svc = ctx.get(IAgentProfileService);
    await svc.bind({
      profile: bound.name,
      model: RESUME_OLD_MODEL,
      thinking: 'low',
      delegationPosition: 'sub',
    });

    expect(svc.data().boundProfile).toMatchObject({
      name: bound.name,
      sourcePath: './profiles/resume.md',
      allowedModels: [RESUME_OLD_MODEL, RESUME_NEW_MODEL],
      denyModels: [`${RESUME_PROVIDER}/blocked-model`],
      allowedEfforts: ['low', 'high'],
      promptBase: {
        text: expect.stringContaining('resume profile'),
        environment: expect.any(Object),
      },
    });
    await ctx.get(IWireService).flush();
    expect(persistence.records.find((record) => record.type === 'profile.bind')).toMatchObject({
      boundProfile: {
        name: bound.name,
        sourcePath: './profiles/resume.md',
        allowedModels: [RESUME_OLD_MODEL, RESUME_NEW_MODEL],
        denyModels: [`${RESUME_PROVIDER}/blocked-model`],
        allowedEfforts: ['low', 'high'],
        promptBase: {
          text: expect.stringContaining('resume profile'),
          environment: expect.any(Object),
        },
      },
    });

    const snapshot = svc.data();
    svc.applyBindingSnapshot(snapshot);
    await ctx.get(IWireService).flush();
    expect(svc.data().boundProfile).toMatchObject({
      name: bound.name,
      sourcePath: './profiles/resume.md',
      allowedModels: [RESUME_OLD_MODEL, RESUME_NEW_MODEL],
      denyModels: [`${RESUME_PROVIDER}/blocked-model`],
      allowedEfforts: ['low', 'high'],
      promptBase: {
        text: expect.stringContaining('resume profile'),
        environment: expect.any(Object),
      },
    });
  });

  it.each(['changed', 'missing'] as const)(
    'restores bound profile constraints and sourcePath when the live catalog is %s',
    async (catalogState) => {
      const persistence = new InMemoryWireRecordPersistence();
      const original = resumeProfile({
        sourcePath: './profiles/original.md',
        allowedModels: [RESUME_OLD_MODEL, RESUME_NEW_MODEL],
        allowedEfforts: ['low', 'high'],
      });
      ctx = createTestAgent(
        { ...nativeResumeOptions(), persistence },
        sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(original)),
        hostEnvironmentServices(homeDir, hostPathClass),
      );
      const initial = ctx.get(IAgentProfileService);
      await initial.bind({
        profile: original.name,
        model: RESUME_OLD_MODEL,
        thinking: 'low',
        delegationPosition: 'sub',
      });
      await ctx.get(IWireService).flush();
      await ctx.dispose();

      const liveCatalog =
        catalogState === 'changed'
          ? singleProfileCatalog(
              resumeProfile({
                sourcePath: './profiles/changed.md',
                allowedModels: [RESUME_OLD_MODEL],
                allowedEfforts: ['low'],
              }),
            )
          : missingProfileCatalog();
      ctx = createTestAgent(
        { ...nativeResumeOptions(), persistence },
        sessionService(ISessionAgentProfileCatalog, liveCatalog),
        hostEnvironmentServices(homeDir, hostPathClass),
      );
      await ctx.restorePersisted();
      const restored = ctx.get(IAgentProfileService);

      expect(restored.data().boundProfile).toMatchObject({
        name: original.name,
        sourcePath: './profiles/original.md',
        allowedModels: [RESUME_OLD_MODEL, RESUME_NEW_MODEL],
        allowedEfforts: ['low', 'high'],
      });
      const apply = await prepareResumeBinding(restored, {
        modelAlias: RESUME_NEW_MODEL,
        thinkingEffort: 'high',
        allowModelChange: true,
      });
      apply();
      expect(restored.data()).toMatchObject({
        modelAlias: RESUME_NEW_MODEL,
        thinkingLevel: 'high',
      });
      expect(restored.data().boundProfile?.sourcePath).toBe('./profiles/original.md');
    },
  );
});

describe('AgentToolPolicyService tool denylist', () => {
  beforeAll(() => {
    registerAgentProfile({
      name: 'deny-builtin',
      disallowedTools: ['Bash'],
      systemPrompt: () => 'deny test',
    });
    registerAgentProfile({
      name: 'deny-over-allow',
      tools: ['Read', 'Bash'],
      disallowedTools: ['Bash'],
      systemPrompt: () => 'deny test',
    });
    registerAgentProfile({
      name: 'deny-mcp',
      disallowedTools: ['mcp__github__*'],
      systemPrompt: () => 'deny test',
    });
  });

  let ctx: TestAgentContext;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-deny-home-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  async function bindProfile(name: string): Promise<IAgentToolPolicyService> {
    ctx = createTestAgent(hostEnvironmentServices(homeDir, hostPathClass));
    await ctx.get(IAgentProfileService).bind({ profile: name, model: MOCK_MODEL });
    return ctx.get(IAgentToolPolicyService);
  }

  it('blocks a denied builtin tool while others stay active', async () => {
    const svc = await bindProfile('deny-builtin');
    expect(svc.isToolActive('Bash')).toBe(false);
    expect(svc.isToolActive('Read')).toBe(true);
  });

  it('denylist wins over the allowlist', async () => {
    const svc = await bindProfile('deny-over-allow');
    expect(svc.isToolActive('Bash')).toBe(false);
    expect(svc.isToolActive('Read')).toBe(true);
    expect(svc.isToolActive('Write')).toBe(false);
  });

  it('matches denied mcp tools by glob', async () => {
    const svc = await bindProfile('deny-mcp');
    expect(svc.isToolActive('mcp__github__create_pr', 'mcp')).toBe(false);
    expect(svc.isToolActive('mcp__other__ping', 'mcp')).toBe(true);
    expect(svc.isToolActive('Read')).toBe(true);
  });

  it('lists available profiles when binding an unknown profile', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir, hostPathClass));
    await expect(
      ctx.get(IAgentProfileService).bind({ profile: 'does-not-exist', model: MOCK_MODEL }),
    ).rejects.toThrow(/Available profiles: .*agent/);
  });

  it('rejects a renamed tool denylist instead of silently restoring AgentRun', async () => {
    registerAgentProfile({
      name: 'deny-stale-agent',
      disallowedTools: ['Agent'],
      systemPrompt: () => 'deny stale Agent',
    });
    ctx = createTestAgent(hostEnvironmentServices(homeDir, hostPathClass));
    await expect(
      ctx.get(IAgentProfileService).bind({ profile: 'deny-stale-agent', model: MOCK_MODEL }),
    ).rejects.toThrow(/disallowedTools does not match any registered or built-in tool/);
  });

  it('persists the denylist in the bind records', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent({ persistence }, hostEnvironmentServices(homeDir, hostPathClass));

    await ctx.get(IAgentProfileService).bind({ profile: 'deny-builtin', model: MOCK_MODEL });
    await ctx.get(IWireService).flush();

    const record = persistence.records.find((candidate) => candidate.type === 'profile.bind');
    expect(record).toMatchObject({ profileName: 'deny-builtin', disallowedTools: ['Bash'] });
  });

  it('persists an unrestricted tool policy when the profile has no allowlist', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent({ persistence }, hostEnvironmentServices(homeDir, hostPathClass));
    const { profile, toolPolicy } = profileServices(ctx);

    await profile.bind({ profile: 'deny-builtin', model: MOCK_MODEL });
    await ctx.get(IWireService).flush();

    expect(persistence.records.find((record) => record.type === 'profile.bind')).toMatchObject({
      activeToolNames: undefined,
    });
    expect(toolPolicy.isToolActive('Read')).toBe(true);
    expect(toolPolicy.isToolActive('Bash')).toBe(false);
  });

  it('restores the denylist from persisted records on resume without catalog resolution', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent({ persistence }, hostEnvironmentServices(homeDir, hostPathClass));
    await ctx.get(IAgentProfileService).bind({ profile: 'deny-builtin', model: MOCK_MODEL });
    await ctx.get(IWireService).flush();
    await ctx.dispose();

    const emptyCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: () => undefined,
      getDefault: () => ({
        name: DEFAULT_AGENT_PROFILE_NAME,
        tools: undefined,
        systemPrompt: () => '',
      }),
      list: () => [],
      load: async () => {},
      reload: async () => {},
    } as unknown as ISessionAgentProfileCatalog;
    ctx = createTestAgent(
      { persistence },
      hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, emptyCatalog),
    );
    await ctx.restorePersisted();
    const resumed = profileServices(ctx);

    expect(resumed.profile.data().profileName).toBe('deny-builtin');
    expect(resumed.toolPolicy.isToolActive('Bash')).toBe(false);
    expect(resumed.toolPolicy.isToolActive('Read')).toBe(true);
  });
});

describe('AgentToolPolicyService global [tools] config', () => {
  beforeAll(() => {
    registerAgentProfile({
      name: 'config-intersect',
      tools: ['Read', 'Bash'],
      disallowedTools: ['Bash'],
      systemPrompt: () => 'config intersect test',
    });
  });

  let ctx: TestAgentContext;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-tools-config-home-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  async function bindWithToolsConfig(
    tools: Record<string, readonly string[]>,
    profile: string = DEFAULT_AGENT_PROFILE_NAME,
  ): Promise<IAgentToolPolicyService> {
    ctx = createTestAgent({ initialConfig: { tools } }, hostEnvironmentServices(homeDir, hostPathClass));
    await ctx.get(IAgentProfileService).bind({ profile, model: MOCK_MODEL });
    return ctx.get(IAgentToolPolicyService);
  }

  it('treats a non-empty enabled list as a global allowlist', async () => {
    const svc = await bindWithToolsConfig({ enabled: ['Read'] });
    expect(svc.isToolActive('Read')).toBe(true);
    expect(svc.isToolActive('Bash')).toBe(false);
  });

  it('treats an empty enabled list as unconstrained', async () => {
    const svc = await bindWithToolsConfig({ enabled: [] });
    expect(svc.isToolActive('Read')).toBe(true);
    expect(svc.isToolActive('Bash')).toBe(true);
  });

  it('applies disabled as a global denylist', async () => {
    const svc = await bindWithToolsConfig({ disabled: ['Bash'] });
    expect(svc.isToolActive('Bash')).toBe(false);
    expect(svc.isToolActive('Read')).toBe(true);
  });

  it('matches globally disabled mcp tools by glob', async () => {
    const svc = await bindWithToolsConfig({ disabled: ['mcp__github__*'] });
    expect(svc.isToolActive('mcp__github__create_pr', 'mcp')).toBe(false);
    expect(svc.isToolActive('mcp__other__ping', 'mcp')).toBe(true);
    expect(svc.isToolActive('Read')).toBe(true);
  });

  it('intersects the global config with the profile policy instead of overriding it', async () => {
    const svc = await bindWithToolsConfig({ enabled: ['Read', 'Bash'] }, 'config-intersect');
    expect(svc.isToolActive('Read')).toBe(true);
    expect(svc.isToolActive('Bash')).toBe(false);
    expect(svc.isToolActive('Write')).toBe(false);
  });
});

describe('AgentToolPolicyService.setSessionDisabledTools', () => {
  beforeAll(() => {
    registerAgentProfile({
      name: 'session-deny',
      disallowedTools: ['Write'],
      systemPrompt: () => 'session deny test',
    });
  });

  let ctx: TestAgentContext;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-session-deny-home-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  async function bind(profile: string): Promise<IAgentToolPolicyService> {
    ctx = createTestAgent(hostEnvironmentServices(homeDir, hostPathClass));
    await ctx.get(IAgentProfileService).bind({ profile, model: MOCK_MODEL });
    return ctx.get(IAgentToolPolicyService);
  }

  it('rejects when no profile is bound yet', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir, hostPathClass));
    const toolPolicy = ctx.get(IAgentToolPolicyService);

    await expect(toolPolicy.setSessionDisabledTools(['Bash'])).rejects.toThrow(/not bound/);
    expect(toolPolicy.isToolActive('Bash')).toBe(true);
  });

  it('replaces the client-managed denylist on every call', async () => {
    const svc = await bind(DEFAULT_AGENT_PROFILE_NAME);

    await svc.setSessionDisabledTools(['Bash']);
    expect(svc.isToolActive('Bash')).toBe(false);
    expect(svc.isToolActive('Read')).toBe(true);

    await svc.setSessionDisabledTools(['Edit']);
    expect(svc.isToolActive('Bash')).toBe(true);
    expect(svc.isToolActive('Edit')).toBe(false);
  });

  it('keeps the profile own denylist across replacement calls', async () => {
    const svc = await bind('session-deny');

    await svc.setSessionDisabledTools(['Bash']);
    expect(svc.isToolActive('Write')).toBe(false);
    expect(svc.isToolActive('Bash')).toBe(false);

    await svc.setSessionDisabledTools([]);
    expect(svc.isToolActive('Write')).toBe(false);
    expect(svc.isToolActive('Bash')).toBe(true);
  });

  it('persists the session denylist across a resume', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const atomicDocuments = createAtomicDocumentStore();
    const documentServices = appService(IAtomicDocumentStore, atomicDocuments);
    ctx = createTestAgent(
      { persistence },
      documentServices,
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    const { profile, toolPolicy } = profileServices(ctx);
    await profile.bind({ profile: 'session-deny', model: MOCK_MODEL });
    await toolPolicy.setSessionDisabledTools(['Bash']);
    await ctx.get(IWireService).flush();
    await ctx.dispose();

    const emptyCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: () => undefined,
      getDefault: () => ({
        name: DEFAULT_AGENT_PROFILE_NAME,
        tools: undefined,
        systemPrompt: () => '',
      }),
      list: () => [],
      load: async () => {},
      reload: async () => {},
    } as unknown as ISessionAgentProfileCatalog;
    ctx = createTestAgent(
      { persistence },
      documentServices,
      hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, emptyCatalog),
    );
    await ctx.restorePersisted();
    await ctx.get(ISessionToolPolicy).ready;
    const resumed = profileServices(ctx);

    expect(resumed.toolPolicy.isToolActive('Bash')).toBe(false);
    expect(resumed.toolPolicy.isToolActive('Write')).toBe(false);
    expect(resumed.toolPolicy.isToolActive('Read')).toBe(true);

    await resumed.toolPolicy.setSessionDisabledTools(['Edit']);
    expect(resumed.toolPolicy.isToolActive('Bash')).toBe(true);
    expect(resumed.toolPolicy.isToolActive('Edit')).toBe(false);
    expect(resumed.toolPolicy.isToolActive('Write')).toBe(false);
  });

  it('retries persistence after a failed session denylist replacement', async () => {
    const atomicDocuments = createAtomicDocumentStore();
    const persist = atomicDocuments.set.bind(atomicDocuments);
    let attempts = 0;
    atomicDocuments.set = async (...args) => {
      if (args[0].endsWith('/tool-policy')) {
        attempts += 1;
        if (attempts === 1) throw new Error('disk full');
      }
      await persist(...args);
    };
    ctx = createTestAgent(
      appService(IAtomicDocumentStore, atomicDocuments),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    const { profile, toolPolicy } = profileServices(ctx);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    await expect(toolPolicy.setSessionDisabledTools(['Bash'])).rejects.toThrow('disk full');
    expect(toolPolicy.isToolActive('Bash')).toBe(true);
    await toolPolicy.setSessionDisabledTools(['Bash']);

    expect(attempts).toBe(2);
    expect(toolPolicy.isToolActive('Bash')).toBe(false);
  });

  it('removes the skill listing when the session disables Skill', async () => {
    const skillMarker = 'session-policy-skill-marker';
    ctx = createTestAgent(
      hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionSkillCatalog, {
        _serviceBrand: undefined,
        catalog: { getModelSkillListing: () => skillMarker } as never,
        ready: Promise.resolve(),
        onDidChange: Event.None as Event<string>,
        load: async () => {},
        reload: async () => {},
        list: async () => [],
      }),
    );
    const { profile, toolPolicy } = profileServices(ctx);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    expect(profile.getSystemPrompt()).toContain(skillMarker);

    await toolPolicy.setSessionDisabledTools(['Skill']);

    expect(toolPolicy.isToolActive('Skill')).toBe(false);
    expect(profile.getSystemPrompt()).not.toContain(skillMarker);
  });

  it('omits the skill listing when global tools disable Skill', async () => {
    const skillMarker = 'global-policy-skill-marker';
    ctx = createTestAgent(
      { initialConfig: { tools: { disabled: ['Skill'] } } },
      hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionSkillCatalog, {
        _serviceBrand: undefined,
        catalog: { getModelSkillListing: () => skillMarker } as never,
        ready: Promise.resolve(),
        onDidChange: Event.None as Event<string>,
        load: async () => {},
        reload: async () => {},
        list: async () => [],
      }),
    );
    const { profile, toolPolicy } = profileServices(ctx);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    expect(toolPolicy.isToolActive('Skill')).toBe(false);
    expect(profile.getSystemPrompt()).not.toContain(skillMarker);
  });

  it('refreshes the skill listing when global tool policy changes at runtime', async () => {
    const skillMarker = 'live-global-policy-skill-marker';
    ctx = createTestAgent(
      hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionSkillCatalog, {
        _serviceBrand: undefined,
        catalog: { getModelSkillListing: () => skillMarker } as never,
        ready: Promise.resolve(),
        onDidChange: Event.None as Event<string>,
        load: async () => {},
        reload: async () => {},
        list: async () => [],
      }),
    );
    const { profile, toolPolicy } = profileServices(ctx);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    expect(profile.getSystemPrompt()).toContain(skillMarker);

    await ctx
      .get(IConfigService)
      .replace(TOOLS_SECTION, { disabled: ['Skill'] }, ConfigTarget.Memory);

    expect(toolPolicy.isToolActive('Skill')).toBe(false);
    await vi.waitFor(() => expect(profile.getSystemPrompt()).not.toContain(skillMarker));
  });
});

describe('AgentToolPolicyService executor enforcement', () => {
  let ctx: TestAgentContext;
  let homeDir: string;

  beforeAll(() => {
    registerAgentProfile({
      name: 'executor-deny-builtin',
      disallowedTools: ['PolicyProbe'],
      systemPrompt: () => 'executor policy test',
    });
    registerAgentProfile({
      name: 'executor-deny-mcp',
      disallowedTools: ['mcp__blocked__*'],
      systemPrompt: () => 'executor policy test',
    });
  });

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-executor-policy-home-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it.each([
    {
      name: 'profile denylist',
      options: {},
      profile: 'executor-deny-builtin',
      disable: undefined,
    },
    {
      name: 'global tools config',
      options: { initialConfig: { tools: { disabled: ['PolicyProbe'] } } },
      profile: DEFAULT_AGENT_PROFILE_NAME,
      disable: undefined,
    },
    {
      name: 'session denylist',
      options: {},
      profile: DEFAULT_AGENT_PROFILE_NAME,
      disable: ['PolicyProbe'],
    },
  ])('blocks a direct builtin call through $name', async ({ options, profile, disable }) => {
    ctx = createTestAgent(options, hostEnvironmentServices(homeDir, hostPathClass));
    const probe = new PolicyProbeTool('PolicyProbe');
    ctx.get(IAgentToolRegistryService).register(probe);
    const profileService = ctx.get(IAgentProfileService);
    await profileService.bind({ profile, model: MOCK_MODEL });
    if (disable !== undefined) {
      await ctx.get(IAgentToolPolicyService).setSessionDisabledTools(disable);
    }

    const result = await executeDirectToolCall(ctx, 'PolicyProbe');

    expect(result).toMatchObject({
      isError: true,
      output: 'Tool "PolicyProbe" is disabled by the active tool policy',
    });
    expect(probe.calls).toBe(0);
  });

  it('blocks a direct MCP call by glob before execution', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir, hostPathClass));
    await ctx.get(IAgentProfileService).bind({ profile: 'executor-deny-mcp', model: MOCK_MODEL });
    const probe = new PolicyProbeTool('mcp__blocked__write');
    ctx.get(IAgentToolRegistryService).register(probe, { source: 'mcp' });

    const result = await executeDirectToolCall(ctx, probe.name);

    expect(result).toMatchObject({
      isError: true,
      output: `Tool "${probe.name}" is disabled by the active tool policy`,
    });
    expect(probe.calls).toBe(0);
  });

  it('blocks a direct builtin call through the workspace tool-policy gate', async () => {
    ctx = createTestAgent(
      hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionToolPolicyGate, {
        _serviceBrand: undefined,
        disabledTools: ['PolicyProbe'],
        onDidChange: Event.None as Event<void>,
      } satisfies ISessionToolPolicyGate),
    );
    await ctx.get(IAgentProfileService).bind({
      profile: DEFAULT_AGENT_PROFILE_NAME,
      model: MOCK_MODEL,
    });
    const probe = new PolicyProbeTool('PolicyProbe');
    ctx.get(IAgentToolRegistryService).register(probe);

    const result = await executeDirectToolCall(ctx, 'PolicyProbe');

    expect(result).toMatchObject({
      isError: true,
      output: 'Tool "PolicyProbe" is disabled by the active tool policy',
    });
    expect(probe.calls).toBe(0);
  });

  it('applies the workspace gate in the prompt projection (skillActive)', async () => {
    registerAgentProfile({
      name: 'gate-skill-active',
      tools: ['Read', 'Skill'],
      systemPrompt: (context) => `skill-active:${String(context.skillActive)}`,
    });
    ctx = createTestAgent(
      hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionToolPolicyGate, {
        _serviceBrand: undefined,
        disabledTools: ['Skill'],
        onDidChange: Event.None as Event<void>,
      } satisfies ISessionToolPolicyGate),
    );
    const profileService = ctx.get(IAgentProfileService);
    await profileService.bind({ profile: 'gate-skill-active', model: MOCK_MODEL });

    expect(profileService.data().systemPrompt).toBe('skill-active:false');
  });

  it('does not reject SelectTools, the policy-gated disclosure loading entry', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir, hostPathClass));
    await ctx.get(IAgentProfileService).bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    const probe = new PolicyProbeTool(SELECT_TOOLS_TOOL_NAME);
    ctx.get(IAgentToolRegistryService).register(probe);

    const result = await executeDirectToolCall(ctx, SELECT_TOOLS_TOOL_NAME);

    expect(result).toMatchObject({ output: 'executed' });
    expect(result.isError).toBeFalsy();
    expect(probe.calls).toBe(1);
  });

  it.each([
    {
      name: 'global denylist',
      options: { initialConfig: { tools: { disabled: [SELECT_TOOLS_TOOL_NAME] } } },
      disable: undefined,
    },
    {
      name: 'global allowlist',
      options: { initialConfig: { tools: { enabled: ['Read'] } } },
      disable: undefined,
    },
    {
      name: 'session denylist',
      options: {},
      disable: [SELECT_TOOLS_TOOL_NAME],
    },
  ])('blocks SelectTools through an explicit $name', async ({ options, disable }) => {
    ctx = createTestAgent(options, hostEnvironmentServices(homeDir, hostPathClass));
    await ctx.get(IAgentProfileService).bind({
      profile: DEFAULT_AGENT_PROFILE_NAME,
      model: MOCK_MODEL,
    });
    if (disable !== undefined) {
      await ctx.get(IAgentToolPolicyService).setSessionDisabledTools(disable);
    }
    const probe = new PolicyProbeTool(SELECT_TOOLS_TOOL_NAME);
    ctx.get(IAgentToolRegistryService).register(probe);

    const result = await executeDirectToolCall(ctx, SELECT_TOOLS_TOOL_NAME);

    expect(result).toMatchObject({
      isError: true,
      output: `Tool "${SELECT_TOOLS_TOOL_NAME}" is disabled by the active tool policy`,
    });
    expect(probe.calls).toBe(0);
  });

});

describe('AgentProfileService tool-pattern warnings', () => {
  let ctx: TestAgentContext;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-tool-pattern-home-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  function toolPatternWarnings(): readonly { code?: string; message?: string }[] {
    const events = ctx.newEvents() as readonly {
      event: string;
      args?: { code?: string; message?: string };
    }[];
    return events
      .filter((entry) => entry.event === 'warning')
      .map((entry) => entry.args ?? {})
      .filter((args) => args.code === 'tool-pattern-no-match');
  }

  const fileProfile: ResolvedAgentProfile = normalizeAgentProfile({
    name: 'bad-patterns',
    tools: ['Bashh', 'mcp__github'],
    disallowedTools: ['*'],
    systemPrompt: () => 'tool pattern warning test',
  });

  it('bind accepts a tool that the child will inherit from its delegator', async () => {
    const inheritedToolName = 'ParentLookup';
    registerAgentProfile({
      name: 'inherits-parent-user-tool',
      disallowedTools: [inheritedToolName],
      systemPrompt: () => 'inherit parent user tool',
    });
    ctx = createTestAgent(hostEnvironmentServices(homeDir, hostPathClass));

    await expect(
      ctx.get(IAgentProfileService).bind({
        profile: 'inherits-parent-user-tool',
        model: MOCK_MODEL,
        inheritedUserToolNames: [inheritedToolName],
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['sibling', 'SiblingLookup'],
    ['unrelated child', 'UnrelatedChildLookup'],
  ])('rejects a tool registered only on a %s agent', async (kind, toolName) => {
    const other = {
      id: kind,
      accessor: {
        get: () => ({
          _serviceBrand: undefined,
          list: () => [{ name: toolName, description: kind, parameters: {} }],
        }),
      },
    } as unknown as IAgentScopeHandle;
    const profileName = `does-not-inherit-${toolName}`;
    registerAgentProfile({
      name: profileName,
      disallowedTools: [toolName],
      systemPrompt: () => kind,
    });
    ctx = createTestAgent(hostEnvironmentServices(homeDir, hostPathClass));
    vi.spyOn(ctx.get(IAgentLifecycleService), 'list').mockReturnValue([other]);

    await expect(
      ctx.get(IAgentProfileService).bind({ profile: profileName, model: MOCK_MODEL }),
    ).rejects.toThrow(new RegExp(`"${toolName}".*does not match any registered or built-in tool`));
  });

  it('rejects profile entries that can never activate anything', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir, hostPathClass));
    await expect(ctx.get(IAgentProfileService).applyProfile(fileProfile)).rejects.toThrow(
      /"Bashh".*does not match any registered or built-in tool[\s\S]*"mcp__github"[\s\S]*mcp__github__\*[\s\S]*"\*"[\s\S]*disallowedTools/,
    );
    expect(toolPatternWarnings()).toEqual([]);
  });

  it('warns about global [tools] config entries that can never activate anything', async () => {
    ctx = createTestAgent(
      { initialConfig: { tools: { enabled: ['*'] } } },
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    await ctx.get(IAgentProfileService).bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    const messages = toolPatternWarnings().map((warning) => warning.message ?? '');
    expect(
      messages.some(
        (m) =>
          m.includes('"*"') && m.includes('the global [tools] config') && m.includes('enabled'),
      ),
    ).toBe(true);
  });

  it('stays silent for the default profile and an empty [tools] config', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir, hostPathClass));
    await ctx.get(IAgentProfileService).bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    expect(toolPatternWarnings()).toEqual([]);
  });

  it('bind also rejects inert profile tool patterns', async () => {
    registerAgentProfile({
      name: 'bind-bad-patterns',
      tools: ['mcp__github'],
      disallowedTools: ['*'],
      systemPrompt: () => 'bind warning test',
    });
    ctx = createTestAgent(hostEnvironmentServices(homeDir, hostPathClass));
    await expect(
      ctx.get(IAgentProfileService).bind({ profile: 'bind-bad-patterns', model: MOCK_MODEL }),
    ).rejects.toThrow(/"mcp__github"[\s\S]*mcp__github__\*[\s\S]*"\*"[\s\S]*disallowedTools/);
    expect(toolPatternWarnings()).toEqual([]);
  });

  it('rejects inert patterns in every routed allow-policy layer', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir, hostPathClass));
    const catalog = routedCatalog();
    const selection = catalog.resolveSelection({ route: 'reviewer.ui-k3' });
    const effective = normalizeAgentProfile({
      ...selection.profile,
      toolAllowPolicies: [['Read', 'mcp__github'], ['Read', 'Bash*']],
    });

    await expect(ctx.get(IAgentProfileService).applyProfile(effective)).rejects.toThrow(
      /"mcp__github"[\s\S]*profile route "reviewer.ui-k3"[\s\S]*tools policy layer 1[\s\S]*"Bash\*"[\s\S]*tools policy layer 2/,
    );
  });

});

async function executeDirectToolCall(ctx: TestAgentContext, name: string): Promise<ToolResult> {
  const call: ToolCall = {
    type: 'function',
    id: `call_${name}`,
    name,
    arguments: '{}',
  };
  for await (const result of ctx.get(IAgentToolExecutorService).execute([call], {
    signal: new AbortController().signal,
    turnId: 1,
  })) {
    return result.result;
  }
  throw new Error(`No result for tool ${name}`);
}

class PolicyProbeTool implements ExecutableTool<Record<string, never>> {
  readonly description = 'Policy enforcement probe.';
  readonly parameters = { type: 'object', additionalProperties: false };
  calls = 0;

  constructor(
    readonly name: string,
    readonly source?: ToolSource,
  ) {}

  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async () => {
        this.calls += 1;
        return { isError: false, output: 'executed' };
      },
    };
  }
}

describe('agentsMdReminder seeding', () => {
  let ctx: TestAgentContext;
  let homeDir: string;
  let workDir: string;

  beforeAll(() => {
    registerAgentProfile({
      name: 'throws-on-prompt',
      systemPrompt: () => {
        throw new Error('prompt build boom');
      },
    });
  });

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-seed-home-'));
    workDir = await mkdtemp(join(tmpdir(), 'kimi-seed-work-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    await rm(workDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  function buildSeededContext(
    seedInjected: IAgentAgentsMdReminderService['seedInjected'],
  ): IAgentProfileService {
    ctx = createTestAgent(
      { cwd: workDir },
      hostEnvironmentServices(homeDir, hostPathClass),
      agentService(IAgentAgentsMdReminderService, {
        _serviceBrand: undefined,
        seedInjected,
        flushStepHead: async () => {},
      }),
    );
    return ctx.get(IAgentProfileService);
  }

  it('seeds the known-set with the injected paths after a successful bind', async () => {
    const seedInjected = vi.fn<(paths: readonly string[], cwd: string) => void>();
    const profile = buildSeededContext(seedInjected);
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf-8');

    seedInjected.mockClear();
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    expect(seedInjected).toHaveBeenCalledWith(
      [normalize(join(workDir, 'AGENTS.md'))],
      process.platform === 'win32' ? workDir.replaceAll('/', '\\') : workDir,
    );
    expect(profile.data().agentsMdPaths).toEqual([normalize(join(workDir, 'AGENTS.md'))]);
  });

  it('does not seed when the prompt build fails before the bind commits', async () => {
    const seedInjected = vi.fn<(paths: readonly string[], cwd: string) => void>();
    const profile = buildSeededContext(seedInjected);

    seedInjected.mockClear();
    await expect(profile.bind({ profile: 'throws-on-prompt', model: MOCK_MODEL })).rejects.toThrow(
      'prompt build boom',
    );

    expect(seedInjected).not.toHaveBeenCalled();
  });
});
