import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'pathe';
import { executorPromptSchema } from '@kiki/agent-profiles/executorPrompt';
import type { ExecutorBinding } from '@kiki/agent-profiles/ports';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Event } from '#/_base/event';
import { IMemoryStore } from '#/app/memory/memoryStore';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAgentMemorySnapshot } from '#/app/memory/memorySnapshot';
import { IThreadCommunicationService } from '#/app/threadCommunication/threadCommunication';
import { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
import { IAgentPlanService } from '#/features/plan/plan';
import { ErrorCodes } from '#/errors';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { ConfigTarget, IConfigService } from '#/app/config/config';
import { TOOLS_SECTION } from '#/agent/toolPolicy/configSection';
import {
  DEFAULT_AGENT_PROFILE_NAME,
  normalizeAgentProfile,
  type AgentProfile,
  type ResolvedAgentProfileRoute,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { BuiltinAgentProfileLoaderService } from '#/app/agentProfileCatalog/builtinAgentProfileLoaderService';
import { ShippedAgentProfileSourceService } from '#/app/shippedAgentProfiles/shippedAgentProfileSourceService';
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
import { resolveExecutionBinding, resolveSelectedExecutionBinding } from '#/agent/profile/executionBinding';
import { IAgentProfileService, type PreparedModelSwitchBinding, type ProfileBindingSnapshot, type ResolvedAgentProfile } from '#/agent/profile/profile';
import { IAgentModelSwitchService } from '#/agent/modelSwitch/modelSwitch';
import { freezeBoundProfile } from '#/agent/profile/boundProfile';
import { RESEARCH_READONLY_TOOLS } from '#/agent/profile/executionRestriction';
import { ProfileErrors } from '#/agent/profile/errors';
import { IHostClock } from '#/os/interface/hostClock';
import { IAgentAgentsMdReminderService } from '#/agent/agentsMdReminder/agentsMdReminder';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { isToolActive } from '#/agent/toolPolicy/evaluate';
import { IAgentToolExecutorService, type ToolExecutionResult } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { SELECT_TOOLS_TOOL_NAME } from '#/agent/toolSelect/toolSelect';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAtomicDocumentStore, type IAtomicDocumentStore as AtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { readPersistedAgentProfileSnapshot } from '#/session/agentProfileSnapshot';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { IWireService } from '#/wire/wire';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentLoopService } from '#/agent/loop/loop';
import { WarningIssued } from '#/agent/profile/profileOps';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import type { ExecutableTool, ToolExecution, ToolResult, ToolSource } from '#/tool/toolContract';

import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IPersonaStore } from '#/app/persona/personaStore';

import { deferredAgentIdentityStub } from '../../app/agentIdentity/stubs';
import {
  InMemoryWireRecordPersistence,
  agentService,
  appService,
  appServices,
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
          defaultEffort: 'high',
        },
        [RESUME_NEW_MODEL]: {
          provider: RESUME_PROVIDER,
          model: 'new-model',
          maxContextSize: 1_000_000,
          capabilities: ['thinking'],
          supportEfforts: ['low', 'high'],
          defaultEffort: 'high',
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
    allowedSubagents: ['explore', 'coder'],
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
    allowedSubagents: ['explore'],
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
    list: () => [descriptor],
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
  let resumeOperation = 0;

  async function commitResumeBinding(binding: PreparedModelSwitchBinding): Promise<void> {
    const metadata = ctx.get(ISessionMetadata);
    if ((await metadata.read()).agents?.['main'] === undefined) await metadata.registerAgent('main', { type: 'main' });
    const receipt = await ctx.get(IAgentModelSwitchService).execute({
      operationId: `profile-resume-${++resumeOperation}`, model: binding.model, thinking: binding.thinking, mode: 'direct',
    }, { binding });
    expect(receipt.state, JSON.stringify(receipt.error)).toBe('completed');
  }

  async function prepareResumeBinding(
    profile: IAgentProfileService,
    input: Parameters<IAgentProfileService['prepareResumeBinding']>[0],
  ): Promise<() => Promise<void>> {
    const binding = await profile.prepareResumeBinding(input);
    return () => commitResumeBinding(binding);
  }

  beforeAll(() => {
    registerAgentProfile({
      name: 'delegates-explore',
      allowedSubagents: ['explore'],
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

  it('admits a frozen native binding without preparing Memory and propagates first-prompt preparation failure', async () => {
    ctx = createTestAgent(nativeResumeOptions(), hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(resumeProfile())));
    const service = ctx.get(IAgentProfileService);
    let release!: (value: string) => void;
    const held = new Promise<string>((resolve) => { release = resolve; });
    const read = vi.spyOn(ctx.get(IAgentMemorySnapshot), 'get').mockReturnValue(held);
    await service.bind({ profile: 'resume-profile', model: RESUME_OLD_MODEL, thinking: 'high', deferPromptContext: true });
    expect(read).not.toHaveBeenCalled();
    expect(service.data()).toMatchObject({ profileName: 'resume-profile', modelAlias: RESUME_OLD_MODEL, thinkingLevel: 'high',
      boundProfile: { promptContextPending: true } });
    expect(service.data().systemPrompt).toContain('resume profile');
    let settled = false;
    const preparation = service.preparePromptConfiguration().then(() => { settled = true; });
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    expect(settled).toBe(false);
    release('SAVED_MEMORY_FIXTURE');
    await preparation;
    expect(service.data().boundProfile?.promptContextPending).toBeUndefined();
    expect(service.data().systemPrompt).toContain('resume profile');
    await service.bind({ profile: 'resume-profile', model: RESUME_OLD_MODEL, thinking: 'high', deferPromptContext: true });
    read.mockRejectedValueOnce(new Error('memory projection unavailable'));
    await expect(service.preparePromptConfiguration()).rejects.toThrow('memory projection unavailable');
    expect(service.data().boundProfile?.promptContextPending).toBe(true);
  });

  it.each(['', 'main: false\n'])('binds an explicit profile file without main curation (%s)', async (main) => {
    const path = join(homeDir, 'selected.md');
    await writeFile(path, `---\nname: resume-profile\ndescription: Explicit file fixture\n${main}model_alias: ${RESUME_OLD_MODEL}\ntools: [Read]\ndisallowedTools: [Bash]\n---\nEXPLICIT_FILE_BODY\n\${builtin_prompt}\n`);
    ctx = createTestAgent(nativeResumeOptions(), hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(resumeProfile())));
    const service = ctx.get(IAgentProfileService);
    const before = service.data();
    const preview = await service.resolveFile(path);
    expect(preview.sourcePath?.toLowerCase()).toBe(path.replaceAll('\\', '/').toLowerCase());
    expect(service.data()).toEqual(before);
    await service.bind({ execution: { executor: 'native', profile_file: path } });
    expect(service.data()).toMatchObject({ profileName: 'resume-profile', modelAlias: RESUME_OLD_MODEL,
      execution: { selection: { executor: 'native', profile_file: preview.sourcePath } } });
    expect(service.data().systemPrompt).toContain('EXPLICIT_FILE_BODY');
    expect(service.data().systemPrompt).not.toContain('resume profile');
    expect(service.data().boundProfile?.fileSources?.root.path).toBe(preview.sourcePath);
    expect(service.data().disallowedTools).toContain('Bash');
    await service.rebuildPromptContext();
    expect(service.data().systemPrompt).toContain('EXPLICIT_FILE_BODY');
    expect(service.data().systemPrompt).not.toContain('resume profile');
    const frozen = service.data();
    await writeFile(path, '---\nname: invalid\nexecutor: missing-executor\n---\ninvalid');
    await expect(service.bind({ execution: { executor: 'native', profile_file: path } })).rejects.toThrow('Unable to load profile file');
    expect(service.data()).toEqual(frozen);
    await expect(service.bind({ execution: { executor: 'native', profile_file: join(homeDir, 'missing.md') } })).rejects.toThrow('Unable to load profile file');
    expect(service.data()).toEqual(frozen);
    service.applyBindingSnapshot(JSON.parse(JSON.stringify(frozen)) as ProfileBindingSnapshot);
    await service.preparePromptConfiguration();
    expect(service.data().systemPrompt).toContain('EXPLICIT_FILE_BODY');
    expect(service.data().systemPrompt).not.toContain('resume profile');
  });

  it('inherits a same-name profile for an explicit file and keeps executor policy', async () => {
    const path = join(homeDir, 'inherit.md');
    await writeFile(path, '---\nname: resume-profile\ndescription: Inherit fixture\nmain: false\nsystem_prompt_mode: inherit\nprompt_overrides:\n  fields:\n    system.shared: Fixture shared field\nmodel_alias: ' + RESUME_OLD_MODEL + '\n---\n');
    ctx = createTestAgent(nativeResumeOptions(), hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(resumeProfile({ allowedSubagents: ['explore'] }))));
    const service = ctx.get(IAgentProfileService);
    await service.bind({ execution: { executor: 'native', profile_file: path } });
    expect(service.data().systemPrompt).toContain('resume profile');
    expect(service.data().boundProfile?.allowedSubagents).toEqual(['explore']);
    const frozen = service.data();
    await expect(service.bind({ execution: { executor: 'missing-executor', profile_file: path } })).rejects.toThrow('Unknown agent executor "missing-executor"');
    expect(service.data()).toEqual(frozen);
    vi.spyOn(ctx.get(ISessionAgentProfileCatalog), 'getDefault').mockReturnValue(normalizeAgentProfile({ name: 'agent', systemPrompt: () => 'CHANGED_DEFAULT' }));
    service.applyBindingSnapshot(JSON.parse(JSON.stringify(frozen)) as ProfileBindingSnapshot);
    await service.preparePromptConfiguration();
    expect(service.data().systemPrompt).toContain('resume profile');
    expect(service.data().systemPrompt).not.toContain('CHANGED_DEFAULT');
  });

  it('binds a direct executor without a synthetic profile and clears inherited profile state', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const build = () => createTestAgent({ persistence, autoConfigure: false }, appService(IAgentExecutorRegistry, externalExecutorRegistry()), hostEnvironmentServices(homeDir, hostPathClass));
    ctx = build();
    const service = ctx.get(IAgentProfileService);
    service.applyBindingSnapshot({ profileName: 'old-profile', modelAlias: 'old-model', thinkingLevel: 'high',
      systemPrompt: 'OLD_KIKI_SYSTEM', executorId: 'grok-acp', executorProtocol: 'acp-v1',
      executorDescriptorRevision: 'test-revision', roomPrompt: 'OLD_ROOM', personaId: 'old-persona' });
    const metadata = ctx.get(ISessionMetadata);
    await metadata.registerAgent('main', { executor: 'grok-acp', personaId: 'old-persona' });
    await service.bind({ execution: { executor: 'grok-acp' } });
    expect((await metadata.read()).agents?.['main']?.personaId).toBeUndefined();
    expect(service.data()).toMatchObject({ systemPrompt: '', thinkingLevel: 'off', kikiContext: [], allowKikiSubagents: false,
      execution: { selection: { executor: 'grok-acp' }, effective: { kiki_context: [], allow_kiki_subagents: false } } });
    expect(service.data().profileName).toBeUndefined();
    expect(service.data().modelAlias).toBeUndefined();
    expect(service.data().roomPrompt).toBeUndefined();
    expect(service.data().personaId).toBeUndefined();
    expect(service.isRunnable()).toBe(true);
    const frozen = service.data();
    await service.preparePromptConfiguration();
    expect(service.data().execution).toEqual(frozen.execution);
    service.applyBindingSnapshot(frozen);
    expect(service.data().execution).toEqual(frozen.execution);
    await ctx.get(IWireService).flush();
    const projected = await readPersistedAgentProfileSnapshot({
      storage: { size: async () => persistence.records.length, mtime: async () => 1 } as unknown as IFileSystemStorageService,
      appendLog: { read: async function* () { yield* persistence.records; } } as unknown as IAppendLogStore,
    }, 'test-workspace', 'test-session', 'main', undefined);
    expect(projected?.execution).toEqual(frozen.execution);
    expect(projected?.profileName).toBeUndefined();
    await ctx.dispose();
    ctx = build();
    await ctx.restorePersisted();
    const restored = ctx.get(IAgentProfileService);
    expect(restored.data().execution).toEqual(frozen.execution);
    expect(restored.data().systemPrompt).toBe('');
    expect(restored.data().modelAlias).toBeUndefined();
    expect(restored.isRunnable()).toBe(true);
  });

  it('freezes native agent defaults and advertised selections, preserving a binding on unknown or unsupported discovery', async () => {
    let discovered: { nativeAgents: readonly string[] } | undefined;
    const registry = { ...externalExecutorRegistry(), lastNegotiated: () => discovered };
    const persistence = new InMemoryWireRecordPersistence();
    const build = () => createTestAgent({ persistence, autoConfigure: false }, appService(IAgentExecutorRegistry, registry), hostEnvironmentServices(homeDir, hostPathClass));
    ctx = build();
    const service = ctx.get(IAgentProfileService);
    await ctx.get(IConfigService).set('agentExecutorOverrides', { 'grok-acp': { defaults: { native_agent: 'engine-default' } } }, ConfigTarget.Memory);
    await service.bind({ execution: { executor: 'grok-acp' } });
    const initial = service.data();
    expect(initial.execution?.effective.native_agent).toBe('engine-default');
    await expect(service.bind({ execution: { executor: 'grok-acp', overrides: { native_agent: 'specialist' } } })).rejects.toThrow('have not been discovered');
    expect(service.data()).toEqual(initial);
    discovered = { nativeAgents: [] };
    await expect(service.bind({ execution: { executor: 'grok-acp', overrides: { native_agent: 'specialist' } } })).rejects.toThrow('does not advertise');
    expect(service.data()).toEqual(initial);
    discovered = { nativeAgents: ['engine-default', 'specialist'] };
    await service.bind({ execution: { executor: 'grok-acp', overrides: { native_agent: 'specialist' } } });
    const selected = service.data();
    expect(selected.execution?.effective.native_agent).toBe('specialist');
    expect(selected.execution!.generation).toBe(initial.execution!.generation + 1);
    service.applyBindingSnapshot(JSON.parse(JSON.stringify(selected)) as ProfileBindingSnapshot);
    expect(service.data().execution).toEqual(selected.execution);
    await ctx.get(IWireService).flush();
    await ctx.dispose();
    ctx = build();
    await ctx.restorePersisted();
    const restored = ctx.get(IAgentProfileService);
    expect(restored.data().execution).toEqual(selected.execution);
    discovered = undefined;
    await restored.preparePromptConfiguration();
    expect(restored.data().execution?.effective.native_agent).toBe('specialist');
    await ctx.get(IConfigService).set('agentExecutorOverrides', { 'grok-acp': { defaults: { native_agent: 'engine-default' } } }, ConfigTarget.Memory);
    await restored.bind({ execution: { executor: 'grok-acp', overrides: { native_agent: null } } });
    expect(restored.data().execution?.effective.native_agent).toBe('engine-default');
    expect(restored.data().execution?.selection.overrides?.native_agent).toBeUndefined();
  });

  it('resolves harness defaults, profile and session overrides without filling omitted vendor controls', async () => {
    const external = normalizeAgentProfile({ name: 'optional-custom', executor: 'grok-acp', modelAlias: 'profile-model',
      systemPrompt: () => 'ONLY_PROFILE_BODY', kikiContext: ['history'], allowKikiSubagents: true, canSpawnSubagents: false });
    ctx = createTestAgent(appService(IAgentExecutorRegistry, externalExecutorRegistry()),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(external)), hostEnvironmentServices(homeDir, hostPathClass));
    await ctx.get(IConfigService).set('agentExecutorOverrides', { 'grok-acp': { defaults: {
      model_alias: 'settings-model', thinking_effort: 'low', permission_mode: 'auto', kiki_context: ['memory'], allow_kiki_subagents: true,
    } } }, ConfigTarget.Memory);
    const service = ctx.get(IAgentProfileService);
    await service.bind({ execution: { executor: 'grok-acp', profile: external.name,
      overrides: { model: 'session-model', kiki_context: [], allow_kiki_subagents: false } } });
    expect(service.data().execution).toMatchObject({ effective: { model: 'session-model', thinking: 'low', permission_mode: 'auto',
      kiki_context: [], allow_kiki_subagents: false }, sources: { model: 'session', thinking: 'harness-settings', kiki_context: 'session' } });
    expect(service.data().systemPrompt).toBe('ONLY_PROFILE_BODY');
    await service.bind({ execution: { executor: 'grok-acp', profile: external.name, overrides: { model: null, kiki_context: null, allow_kiki_subagents: null } } });
    expect(service.data().execution).toMatchObject({ effective: { model: 'profile-model', kiki_context: ['history'], allow_kiki_subagents: true }, sources: { model: 'profile' } });
    expect(service.data().canSpawnSubagents).toBe(false);
    await ctx.get(IConfigService).replace('agentExecutorOverrides', { 'grok-acp': { defaults: {
      kiki_context: [], allow_kiki_subagents: false,
    } } }, ConfigTarget.Memory);
    await service.bind({ execution: { executor: 'grok-acp' } });
    expect(service.data().execution).toMatchObject({ effective: { kiki_context: [], allow_kiki_subagents: false },
      sources: { thinking: 'harness-default', kiki_context: 'harness-settings', allow_kiki_subagents: 'harness-settings' } });
    expect(service.data().execution?.effective.thinking).toBeUndefined();
  });

  it('resolves executor, model, and effort from the selected executor group', () => {
    const native = normalizeAgentProfile({
      name: 'role', modelAlias: 'native-pin', thinkingEffort: 'high', executorOptions: { pin: true },
      kikiContext: ['history'], allowKikiSubagents: true, systemPrompt: () => 'role',
    });
    const engineDefault = { model: 'engine-default', thinkingFor: () => 'low' };
    const same = resolveExecutionBinding({ executor: 'native' }, undefined, native, undefined, engineDefault);
    expect(same.effective).toMatchObject({ model: 'native-pin', thinking: 'high', kiki_context: ['history'], allow_kiki_subagents: true });
    expect(same.sources).toMatchObject({ model: 'profile', thinking: 'profile' });
    const bare = resolveExecutionBinding({ executor: 'grok-acp' }, undefined, native, undefined);
    expect(bare.effective.model).toBeUndefined();
    expect(bare.effective.thinking).toBeUndefined();
    expect(bare.sources).toMatchObject({ model: 'harness-default', thinking: 'harness-default', kiki_context: 'profile' });
    const filled = resolveExecutionBinding({ executor: 'grok-acp' }, undefined, native, undefined, engineDefault);
    expect(filled.effective).toMatchObject({ model: 'engine-default', thinking: 'low', kiki_context: ['history'], allow_kiki_subagents: true });
    expect(filled.sources).toMatchObject({ model: 'harness-default', thinking: 'harness-default' });
    const explicit = resolveExecutionBinding({ executor: 'grok-acp', overrides: { model: 'raw', thinking: 'max' } }, {
      model_alias: 'settings-model', thinking_effort: 'low',
    }, native, undefined, engineDefault);
    expect(explicit.effective).toMatchObject({ model: 'raw', thinking: 'max' });
    expect(explicit.sources).toMatchObject({ model: 'session', thinking: 'session' });
    const cleared = resolveExecutionBinding({ executor: 'grok-acp', overrides: { model: null, thinking: null } }, {
      model_alias: 'settings-model', thinking_effort: 'low',
    }, native, explicit);
    expect(cleared.effective).toMatchObject({ model: 'settings-model', thinking: 'low' });
    expect(cleared.sources).toMatchObject({ model: 'harness-settings', thinking: 'harness-settings' });
    const previous = resolveExecutionBinding({ executor: 'native', overrides: { model: 'old-native', thinking: 'high' } }, undefined, undefined, undefined);
    const switched = resolveExecutionBinding({ executor: 'grok-acp' }, undefined, native, previous);
    expect(switched.effective.model).toBeUndefined();
    expect(switched.selection.overrides).toBeUndefined();
    const open = normalizeAgentProfile({ name: 'open', systemPrompt: () => 'open' });
    const kept = resolveExecutionBinding({ executor: 'native', profile: 'open' }, undefined, open, previous);
    expect(kept.effective.model).toBe('old-native');
    expect(kept.sources['model']).toBe('session');
    expect(kept.selection.overrides).toEqual({ model: 'old-native' });
    const pinnedProfile = normalizeAgentProfile({ name: 'pinned', modelAlias: 'native-pin', systemPrompt: () => 'pin' });
    const adopted = resolveExecutionBinding({ executor: 'native', profile: 'pinned' }, undefined, pinnedProfile, kept);
    expect(adopted.effective.model).toBe('native-pin');
    expect(adopted.sources['model']).toBe('profile');
    expect(adopted.selection.overrides?.model).toBeUndefined();
    const clearedPin = resolveExecutionBinding({ executor: 'native', profile: 'open', overrides: { model: null } }, {
      model_alias: 'settings-model',
    }, open, adopted);
    expect(clearedPin.effective.model).toBe('settings-model');
    expect(clearedPin.sources['model']).toBe('harness-settings');
    expect(resolveExecutionBinding({ executor: 'native', profile: 'open' }, undefined, open, undefined).effective.model).toBeUndefined();
    expect(resolveExecutionBinding({ executor: 'native', profile: 'open' }, undefined, open, undefined, undefined, 'live-model').effective)
      .toMatchObject({ model: 'live-model' });
    expect(resolveExecutionBinding({ executor: 'grok-acp' }, undefined, open, previous, undefined, 'old-native').effective.model).toBeUndefined();
    const external = normalizeAgentProfile({
      name: 'ext', executor: 'grok-acp', modelAlias: 'raw-id', thinkingEffort: 'max', systemPrompt: () => 'x',
    });
    expect(resolveExecutionBinding({ executor: 'grok-acp' }, undefined, external, undefined, engineDefault).effective)
      .toMatchObject({ model: 'raw-id', thinking: 'max' });
  });

  it('deletes a previous thinking override on null and keeps it when thinking is omitted', () => {
    const previous = resolveExecutionBinding({ executor: 'grok-acp', overrides: { model: 'raw', thinking: 'max' } }, undefined, undefined, undefined);
    const cleared = resolveSelectedExecutionBinding({ executor: 'grok-acp' }, { thinking: null }, undefined, undefined, previous);
    expect(cleared.selection.overrides?.thinking).toBeUndefined();
    expect(cleared.selection.overrides?.model).toBe('raw');
    const kept = resolveSelectedExecutionBinding({ executor: 'grok-acp' }, {}, undefined, undefined, previous);
    expect(kept.selection.overrides).toEqual({ model: 'raw', thinking: 'max' });
    const replaced = resolveSelectedExecutionBinding({ executor: 'grok-acp' }, { thinking: 'low' }, undefined, undefined, previous);
    expect(replaced.selection.overrides?.thinking).toBe('low');
    expect(replaced.effective.thinking).toBe('low');
  });

  it('keeps the live model when an unpinned profile is selected and still applies a pin or an explicit clear', async () => {
    const open = normalizeAgentProfile({ name: 'open', systemPrompt: () => 'OPEN' });
    const other = normalizeAgentProfile({ name: 'other', systemPrompt: () => 'OTHER' });
    const pinned = normalizeAgentProfile({ name: 'pinned', modelAlias: 'mock-pin', systemPrompt: () => 'PINNED' });
    const profiles = [open, other, pinned];
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => profiles.find((profile) => profile.name === name),
      getDefault: () => open,
      list: () => profiles,
      listRoutes: () => [],
      routeDiagnostics: () => [],
      resolveSelection: ({ profile: name }) => {
        const profile = profiles.find((candidate) => candidate.name === name);
        if (profile === undefined) throw new Error(`Unknown agent profile: "${name ?? ''}"`);
        return { profile, baseProfile: profile };
      },
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(
      appService(IAgentExecutorRegistry, externalExecutorRegistry()),
      sessionService(ISessionAgentProfileCatalog, catalog),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    ctx.kimiConfig = { ...ctx.kimiConfig, models: { ...ctx.kimiConfig.models,
      'mock-pin': { provider: 'test-provider', model: 'mock-pin', maxContextSize: 1_000_000, defaultEffort: 'off' },
    } };
    await ctx.ready;
    const service = ctx.get(IAgentProfileService);
    await service.bind({ profile: 'open', model: MOCK_MODEL });
    expect(service.data().execution).toBeUndefined();
    expect(service.getModel()).toBe(MOCK_MODEL);

    await service.bind({ execution: { executor: 'native', profile: 'other' } });
    expect(service.data()).toMatchObject({
      profileName: 'other', modelAlias: MOCK_MODEL,
      execution: {
        selection: { executor: 'native', profile: 'other', overrides: { model: MOCK_MODEL } },
        effective: { model: MOCK_MODEL }, sources: { model: 'session' },
      },
    });

    await service.bind({ execution: { executor: 'native', profile: 'pinned' } });
    expect(service.data()).toMatchObject({
      profileName: 'pinned', modelAlias: 'mock-pin',
      execution: { selection: { executor: 'native', profile: 'pinned' }, effective: { model: 'mock-pin' }, sources: { model: 'profile' } },
    });
    expect(service.data().execution?.selection.overrides?.model).toBeUndefined();

    await service.bind({ execution: { executor: 'native', profile: 'other' } });
    expect(service.getModel()).toBe('mock-pin');
    expect(service.data().execution).toMatchObject({
      selection: { profile: 'other', overrides: { model: 'mock-pin' } },
      effective: { model: 'mock-pin' }, sources: { model: 'session' },
    });

    await ctx.get(IConfigService).set('agentExecutorOverrides', { native: { defaults: { model_alias: MOCK_MODEL } } }, ConfigTarget.Memory);
    await service.bind({ execution: { executor: 'native', profile: 'other', overrides: { model: null } } });
    expect(service.data()).toMatchObject({
      profileName: 'other', modelAlias: MOCK_MODEL,
      execution: { effective: { model: MOCK_MODEL }, sources: { model: 'harness-settings' } },
    });
    expect(service.data().execution?.selection.overrides?.model).toBeUndefined();

    await service.bind({ execution: { executor: 'grok-acp', profile: 'other' } });
    expect(service.data().executorId).toBe('grok-acp');
    expect(service.data().modelAlias).toBeUndefined();
    expect(service.data().execution?.effective.model).toBeUndefined();
    expect(service.data().execution?.selection.overrides).toBeUndefined();
  });

  it('selects an external executor on a native profile without borrowing its model, effort, or options', async () => {
    const native = normalizeAgentProfile({
      name: 'native-role', modelAlias: 'mock-model', thinkingEffort: 'high', executorOptions: { pin: 'native-pin' },
      serviceTier: 'priority', requestParams: { seed: 7 }, contextBudget: 1000, maxCompletionTokens: 50,
      kikiContext: ['history'], allowKikiSubagents: true, canSpawnSubagents: false, allowedSubagents: ['explore'],
      disallowedTools: ['Bash'], tools: ['Read'], systemPrompt: () => 'NATIVE_ROLE_BODY',
    });
    ctx = createTestAgent(appService(IAgentExecutorRegistry, externalExecutorRegistry()),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(native)), hostEnvironmentServices(homeDir, hostPathClass));
    const service = ctx.get(IAgentProfileService);
    await service.bind({ execution: { executor: 'grok-acp', profile: native.name, overrides: { model: 'session-raw', thinking: 'max' } } });
    expect(service.data()).toMatchObject({
      profileName: 'native-role', executorId: 'grok-acp', executorOptions: {}, modelAlias: 'session-raw', thinkingLevel: 'max',
      canSpawnSubagents: false, allowedSubagents: ['explore'],
      execution: {
        selection: { executor: 'grok-acp', profile: native.name, overrides: { model: 'session-raw', thinking: 'max' } },
        effective: { model: 'session-raw', thinking: 'max', kiki_context: ['history'], allow_kiki_subagents: true },
        sources: { model: 'session', thinking: 'session', kiki_context: 'profile', allow_kiki_subagents: 'profile' },
      },
    });
    expect(service.data().systemPrompt).toContain('NATIVE_ROLE_BODY');
    expect(service.data().disallowedTools).toContain('Bash');
    expect(service.data().serviceTier).toBeUndefined();
    expect(service.data().requestParams).toBeUndefined();
    expect(native.serviceTier).toBe('priority');
    expect(native.executorOptions).toEqual({ pin: 'native-pin' });
    await ctx.get(IConfigService).set('agentExecutorOverrides', { 'grok-acp': { defaults: {
      model_alias: 'engine-raw', thinking_effort: 'low',
    } } }, ConfigTarget.Memory);
    await service.bind({ execution: { executor: 'grok-acp', profile: native.name, overrides: { model: null, thinking: null } } });
    expect(service.data().execution).toMatchObject({
      effective: { model: 'engine-raw', thinking: 'low' },
      sources: { model: 'harness-settings', thinking: 'harness-settings' },
    });
    expect(service.data().modelAlias).toBe('engine-raw');
    await ctx.get(IConfigService).replace('agentExecutorOverrides', {}, ConfigTarget.Memory);
    await service.bind({ execution: { executor: 'grok-acp', profile: native.name, overrides: { model: null, thinking: null } } });
    expect(service.data().execution?.effective.model).toBeUndefined();
    expect(service.data().execution?.effective.thinking).toBeUndefined();
    expect(service.data().execution?.sources).toMatchObject({ model: 'harness-default', thinking: 'harness-default' });
    expect(service.data().modelAlias).toBeUndefined();
    expect(service.data().executorId).toBe('grok-acp');
    expect(service.data().executorOptions).toEqual({});
    expect(service.data().profileName).toBe('native-role');
    const generation = service.data().execution?.generation ?? 0;
    await service.rebuildPromptContext();
    expect(service.data().executorId).toBe('grok-acp');
    expect(service.data().modelAlias).toBeUndefined();
    expect(service.data().execution?.selection.executor).toBe('grok-acp');
    expect(service.data().execution?.generation).toBeGreaterThanOrEqual(generation);
  });

  it('drops an explicit native effort and returns the model default when no execution is bound', async () => {
    ctx = createTestAgent(nativeResumeOptions(), hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(resumeProfile())));
    const service = ctx.get(IAgentProfileService);
    await service.bind({ profile: 'resume-profile', model: RESUME_OLD_MODEL });
    service.setThinking('low');
    expect(service.data()).toMatchObject({
      thinkingLevel: 'low', thinkingEffortExplicit: true, modelAlias: RESUME_OLD_MODEL, profileName: 'resume-profile',
    });
    expect(service.data().execution).toBeUndefined();
    service.restoreDefaultThinking();
    expect(service.data()).toMatchObject({
      thinkingLevel: 'high', thinkingEffortExplicit: false, modelAlias: RESUME_OLD_MODEL, profileName: 'resume-profile',
    });
    expect(service.data().execution).toBeUndefined();
  });

  it('clears a native execution thinking override without pinning the resolved default', async () => {
    ctx = createTestAgent(nativeResumeOptions(), hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(resumeProfile())));
    const service = ctx.get(IAgentProfileService);
    await service.bind({ execution: { executor: 'native', profile: 'resume-profile', overrides: { thinking: 'low' } } });
    const before = service.data();
    expect(before.thinkingLevel).toBe('low');
    expect(before.thinkingEffortExplicit).toBe(true);
    expect(before.execution?.selection.overrides?.thinking).toBe('low');
    await service.bind({ execution: before.execution!.selection, thinking: null });
    const after = service.data();
    expect(after.execution?.selection.overrides?.thinking).toBeUndefined();
    expect(after.thinkingLevel).toBe('high');
    expect(after.thinkingEffortExplicit).toBe(false);
    expect(after.modelAlias).toBe(before.modelAlias);
    expect(after.executorId).toBe('native');
    expect(after.profileName).toBe('resume-profile');
  });

  it('clears a native effort pin to the executor default rather than the model default', async () => {
    ctx = createTestAgent(nativeResumeOptions(), hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(resumeProfile())));
    await ctx.get(IConfigService).set('agentExecutorOverrides', { native: { defaults: { thinking_effort: 'low' } } }, ConfigTarget.Memory);
    const service = ctx.get(IAgentProfileService);
    await service.bind({ execution: { executor: 'native', profile: 'resume-profile', overrides: { thinking: 'high' } } });
    await service.bind({ execution: service.data().execution!.selection, thinking: null });
    expect(service.data().execution?.effective.thinking).toBe('low');
    expect(service.data().execution?.sources['thinking']).toBe('harness-settings');
    expect(service.data().execution?.selection.overrides?.thinking).toBeUndefined();
    expect(service.data().thinkingLevel).toBe('low');
  });

  it('deletes an external thinking override through the current selection and keeps an omitted thinking', async () => {
    const native = normalizeAgentProfile({ name: 'native-role', systemPrompt: () => 'BODY' });
    ctx = createTestAgent(appService(IAgentExecutorRegistry, externalExecutorRegistry()),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(native)), hostEnvironmentServices(homeDir, hostPathClass));
    const service = ctx.get(IAgentProfileService);
    await service.bind({ execution: { executor: 'grok-acp', overrides: { model: 'session-raw', thinking: 'max' } } });
    const bound = service.data();
    expect(bound.execution?.selection.overrides).toEqual({ model: 'session-raw', thinking: 'max' });
    await service.bind({ execution: bound.execution!.selection });
    expect(service.data().execution?.selection.overrides?.thinking).toBe('max');
    await service.bind({ execution: bound.execution!.selection, thinking: null });
    const cleared = service.data();
    expect(cleared.execution?.selection.overrides?.thinking).toBeUndefined();
    expect(cleared.execution?.selection.overrides?.model).toBe('session-raw');
    expect(cleared.modelAlias).toBe('session-raw');
    expect(cleared.executorId).toBe('grok-acp');
    expect(cleared.profileName).toBe(bound.profileName);
    expect(cleared.execution?.effective.thinking).not.toBe('max');
  });

  it('selects the native executor on an external profile from the native engine default', async () => {
    const external = normalizeAgentProfile({
      name: 'external-role', executor: 'grok-acp', modelAlias: 'profile-raw', thinkingEffort: 'high',
      executorOptions: { pin: 'external-pin' }, kikiContext: ['memory'], allowKikiSubagents: false,
      disallowedTools: ['Write'], allowedSubagents: ['explore'], systemPrompt: () => 'EXTERNAL_ROLE_BODY',
    });
    ctx = createTestAgent(appService(IAgentExecutorRegistry, externalExecutorRegistry()),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(external)), hostEnvironmentServices(homeDir, hostPathClass));
    const service = ctx.get(IAgentProfileService);
    await service.bind({ execution: { executor: 'grok-acp', profile: external.name, overrides: { model: 'session-raw', thinking: 'max' } } });
    const externalGeneration = service.data().execution?.generation ?? 0;
    await service.bind({ execution: { executor: 'native', profile: external.name } });
    expect(service.data()).toMatchObject({
      profileName: 'external-role', executorId: 'native', modelAlias: 'mock-model', thinkingLevel: 'off',
      allowedSubagents: ['explore'],
      execution: {
        selection: { executor: 'native', profile: external.name },
        effective: { model: 'mock-model', thinking: 'off', kiki_context: ['memory'], allow_kiki_subagents: false },
        sources: { model: 'harness-default', thinking: 'harness-default', kiki_context: 'profile' },
      },
    });
    expect(service.data().executorOptions).toBeUndefined();
    expect(service.data().systemPrompt).toContain('EXTERNAL_ROLE_BODY');
    expect(service.data().disallowedTools).toContain('Write');
    expect(service.data().execution?.generation).toBeGreaterThan(externalGeneration);
    expect(external.modelAlias).toBe('profile-raw');
    expect(external.executorOptions).toEqual({ pin: 'external-pin' });
    await service.bind({ execution: { executor: 'native', profile: external.name, overrides: { model: 'mock-model', thinking: 'off' } } });
    expect(service.data().execution?.sources).toMatchObject({ model: 'session', thinking: 'session' });
    await service.bind({ execution: { executor: 'native', profile: external.name, overrides: { model: null, thinking: null } } });
    expect(service.data()).toMatchObject({
      executorId: 'native', modelAlias: 'mock-model', thinkingLevel: 'off',
      execution: { effective: { model: 'mock-model', thinking: 'off' }, sources: { model: 'harness-default', thinking: 'harness-default' } },
    });
    expect(service.data().modelAlias).not.toBe('profile-raw');
    const generation = service.data().execution?.generation ?? 0;
    await service.rebuildPromptContext();
    expect(service.data().executorId).toBe('native');
    expect(service.data().modelAlias).toBe('mock-model');
    expect(service.data().execution?.selection.executor).toBe('native');
    expect(service.data().execution?.generation).toBeGreaterThanOrEqual(generation);
  });

  it('keeps the active binding when an executor selection is rejected', async () => {
    const native = normalizeAgentProfile({
      name: 'native-role', modelAlias: 'mock-model', disallowedTools: ['Bash'], systemPrompt: () => 'NATIVE_ROLE_BODY',
    });
    const external = normalizeAgentProfile({
      name: 'external-role', executor: 'grok-acp', modelAlias: 'profile-raw', serviceTier: 'priority', systemPrompt: () => 'EXTERNAL_ROLE_BODY',
    });
    ctx = createTestAgent(appService(IAgentExecutorRegistry, externalExecutorRegistry(DEFAULT_EXTERNAL_EXECUTOR_DESCRIPTOR, (binding) =>
      binding.modelAlias === 'rejected-model'
        ? { ok: false, diagnostic: 'fixture executor rejects rejected-model' }
        : { ok: true, binding })),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(native)), hostEnvironmentServices(homeDir, hostPathClass));
    const service = ctx.get(IAgentProfileService);
    await service.bind({ execution: { executor: 'grok-acp', profile: native.name, overrides: { model: 'kept-raw' } } });
    const frozen = service.data();
    await expect(service.bind({ execution: { executor: 'grok-acp', profile: native.name, overrides: { model: 'rejected-model' } } })).rejects.toThrow('fixture executor rejects rejected-model');
    expect(service.data()).toEqual(frozen);
    await expect(service.bind({ execution: { executor: 'missing-executor', profile: native.name } })).rejects.toThrow('Unknown executor missing-executor');
    expect(service.data()).toEqual(frozen);
    await expect(service.bind({ execution: { executor: 'grok-acp', profile: native.name }, executionRestriction: 'research-readonly' })).rejects.toThrow('Research-readonly agents require the native executor.');
    expect(service.data()).toEqual(frozen);
    await ctx.dispose();
    ctx = createTestAgent(appService(IAgentExecutorRegistry, externalExecutorRegistry()),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(external)), hostEnvironmentServices(homeDir, hostPathClass));
    const externalService = ctx.get(IAgentProfileService);
    const before = externalService.data();
    await expect(externalService.bind({ execution: { executor: 'grok-acp', profile: external.name } })).rejects.toThrow('cannot declare service_tier');
    expect(externalService.data()).toEqual(before);
    await expect(externalService.bind({ execution: { executor: 'other-acp', profile: external.name } })).rejects.toThrow('cannot declare service_tier');
    expect(externalService.data()).toEqual(before);
  });

  it('restores a cross-executor binding with the selected executor, model, and generation', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const native = normalizeAgentProfile({
      name: 'native-role', modelAlias: 'mock-model', thinkingEffort: 'high', executorOptions: { pin: 'native-pin' },
      disallowedTools: ['Bash'], systemPrompt: () => 'NATIVE_ROLE_BODY',
    });
    const build = () => createTestAgent({ persistence, autoConfigure: false },
      appService(IAgentExecutorRegistry, externalExecutorRegistry()),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(native)),
      hostEnvironmentServices(homeDir, hostPathClass));
    ctx = build();
    const service = ctx.get(IAgentProfileService);
    await service.bind({ execution: { executor: 'grok-acp', profile: native.name, overrides: { model: 'kept-raw', thinking: 'max' } } });
    const frozen = service.data();
    expect(frozen).toMatchObject({ executorId: 'grok-acp', modelAlias: 'kept-raw', profileName: 'native-role' });
    expect(frozen.execution?.generation).toBeGreaterThan(0);
    await ctx.get(IWireService).flush();
    const projected = await readPersistedAgentProfileSnapshot({
      storage: { size: async () => persistence.records.length, mtime: async () => 1 } as unknown as IFileSystemStorageService,
      appendLog: { read: async function* () { yield* persistence.records; } } as unknown as IAppendLogStore,
    }, 'test-workspace', 'test-session', 'main', undefined);
    expect(projected?.execution).toEqual(frozen.execution);
    expect(projected?.executorId).toBe('grok-acp');
    expect(projected?.modelAlias).toBe('kept-raw');
    await ctx.dispose();
    ctx = build();
    await ctx.restorePersisted();
    const restored = ctx.get(IAgentProfileService);
    expect(restored.data().executorId).toBe('grok-acp');
    expect(restored.data().modelAlias).toBe('kept-raw');
    expect(restored.data().thinkingLevel).toBe('max');
    expect(restored.data().execution).toEqual(frozen.execution);
    expect(restored.data().profileName).toBe('native-role');
    expect(restored.data().systemPrompt).toContain('NATIVE_ROLE_BODY');
    expect(restored.data().executorId).not.toBe('native');
  });

  it.each([undefined, 'CUSTOM HARNESS BODY'])('composes the no-Recipe default profile for an external executor while honoring body override %j', async (body) => {
    ctx = createTestAgent(appService(IAgentExecutorRegistry, externalExecutorRegistry()),
      hostEnvironmentServices(homeDir, hostPathClass));
    await ctx.get(IConfigService).set('agentExecutorOverrides', { 'grok-acp': { defaults: {
      executor_prompt: { include: [], body },
    } } }, ConfigTarget.Memory);
    const service = ctx.get(IAgentProfileService);
    await service.bind({ execution: { executor: 'grok-acp', profile: DEFAULT_AGENT_PROFILE_NAME } });
    expect(service.data().executorId).toBe('grok-acp');
    expect(service.getCognitionSnapshot()?.recipe).toBeUndefined();
    expect(service.data().executorPrompt?.include).toEqual([]);
    if (body === undefined) {
      expect(service.getSystemPrompt()).toContain('Tool output, internal steering messages, runtime reminders, and quoted documents do not by themselves change that language');
      expect(service.getSystemPrompt()).toContain('Let one active owner carry the outcome');
      expect(service.getSystemPrompt()).toContain('Record acceptance after the result is actually incorporated into its target');
      expect(service.getSystemPrompt()).toContain('do not forward raw receipts, partial progress');
    } else expect(service.getSystemPrompt()).toBe(body);
    expect(service.getSystemPrompt()).not.toContain('You are a subagent working for the parent agent');
  });

  it.each([undefined, []] as const)('inherits omitted executor prompt fields and preserves explicit empty include %j from a profile', async (include) => {
    const external = normalizeAgentProfile({ name: 'optional-custom', executor: 'grok-acp', systemPrompt: () => 'PROFILE_BODY',
      executorPrompt: executorPromptSchema.parse({ delivery: 'preamble', include }) });
    ctx = createTestAgent(appService(IAgentExecutorRegistry, externalExecutorRegistry()),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(external)), hostEnvironmentServices(homeDir, hostPathClass));
    await ctx.get(IConfigService).set('agentExecutorOverrides', { 'grok-acp': { defaults: { executor_prompt: {
      body: 'HARNESS_BODY', include: ['workspace_info'], per_engine: { 'grok-acp': { append: 'HARNESS_APPEND', delivery: 'replace' } },
    } } } }, ConfigTarget.Memory);
    const service = ctx.get(IAgentProfileService);
    await service.bind({ execution: { executor: 'grok-acp', profile: external.name } });
    expect(service.data().executorPrompt).toEqual({ body: 'HARNESS_BODY', append: 'HARNESS_APPEND', delivery: 'preamble', include: include ?? ['workspace_info'] });
    expect(service.data().systemPrompt.startsWith('HARNESS_BODY\n\nHARNESS_APPEND')).toBe(true);
    expect(service.data().systemPrompt.includes('## workspace_info')).toBe(include === undefined);
    expect(service.data().systemPrompt.includes('## Space')).toBe(include === undefined);
    expect(service.data().systemPrompt.includes(`Kiki home (server host): ${JSON.stringify(ctx.get(IBootstrapService).homeDir)}`)).toBe(include === undefined);
    expect(service.data().systemPrompt).not.toContain('See runtime snapshot');
    expect(service.data().execution?.sources).toMatchObject({ 'executor_prompt.body': 'harness-settings',
      'executor_prompt.append': 'harness-settings', 'executor_prompt.delivery': 'profile', 'executor_prompt.include': include === undefined ? 'harness-settings' : 'profile' });
    const before = service.data();
    await ctx.get(IConfigService).replace('agentExecutorOverrides', { 'grok-acp': { defaults: { executor_prompt: { body: 'UPDATED_BODY' } } } }, ConfigTarget.Memory);
    await service.preparePromptConfiguration();
    await service.refreshSystemPrompt();
    expect(service.data().systemPrompt).toBe(before.systemPrompt);
    expect(service.data().execution).toEqual(before.execution);
    await service.rebuildPromptContext();
    expect(service.data().systemPrompt).toBe('UPDATED_BODY');
    expect(service.data().execution?.selection).toEqual(before.execution?.selection);
    expect(service.data().execution?.generation).toBe(before.execution!.generation + 1);
  });

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

  it.each(['private', 'deleted', 'invalid'] as const)('keeps an already bound profile when a reload makes it %s', async (change) => {
    const original = normalizeAgentProfile({
      name: 'active-worker', modelAlias: RESUME_OLD_MODEL, systemPrompt: () => 'stable prompt',
    });
    let current: AgentProfile | undefined = original;
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => name === current?.name ? current : undefined,
      getDefault: () => original,
      list: () => current === undefined || current.private === true ? [] : [current],
      listRoutes: () => [],
      routeDiagnostics: () => [],
      resolveSelection: ({ profile, route }) => {
        if (route !== undefined) throw new Error('not a route');
        if (current === undefined || current.private === true || profile !== current.name) {
          throw new Error(`Unknown agent profile: "${profile ?? ''}"`);
        }
        return { profile: current, baseProfile: current };
      },
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(
      nativeResumeOptions(),
      sessionService(ISessionAgentProfileCatalog, catalog),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({ profile: original.name, model: RESUME_OLD_MODEL, thinking: 'low' });
    const binding = profile.data().boundProfile!;
    const inputs = binding.promptBase!.inputs!;
    if (change === 'private') {
      current = normalizeAgentProfile({
        name: original.name, private: true, modelAlias: RESUME_OLD_MODEL,
        systemPrompt: () => 'hidden prompt',
      });
    } else {
      current = undefined;
    }
    await profile.refreshSystemPrompt();
    expect(profile.data().boundProfile).toEqual(binding);

    await profile.rebuildPromptContext();
    const rebuilt = profile.data().boundProfile!;
    expect({ ...rebuilt, promptBase: binding.promptBase }).toEqual(binding);
    expect(rebuilt.promptBase).toEqual({
      ...binding.promptBase,
      inputs: {
        ...inputs,
        cognition: { ...inputs.cognition, revision: inputs.cognition.revision + 1 },
        revision: expect.any(String),
      },
    });
    expect(rebuilt.promptBase!.inputs!.revision).not.toBe(inputs.revision);
    await profile.refreshSystemPrompt();
    expect(profile.data().boundProfile).toEqual(rebuilt);
    expect(profile.getSystemPrompt()).toContain('stable prompt');
    expect(profile.data().profileName).toBe(original.name);
  });

  it.each([
    { tools: undefined, active: true },
    { tools: [] as string[], active: false },
    { tools: ['MemoryRead', 'AgentRun'], active: true },
  ])('keeps external harness tool activation subject to the authored allow and deny policies: $active', async ({ tools, active }) => {
    const external = normalizeAgentProfile({ name: 'external-main', executor: 'grok-acp',
      tools, disallowedTools: ['MemoryWrite'], allowKikiSubagents: true, kikiContext: ['memory'],
      systemPrompt: () => 'external main' });
    ctx = createTestAgent({ initialConfig: { memory: { enabled: true, approval: 'auto', budget: 2000, workspaces: {} } } },
      appServices((reg) => reg.definePartialInstance(IMemoryStore, { get: async () => undefined })),
      appService(IAgentExecutorRegistry, externalExecutorRegistry()),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(external)),
      hostEnvironmentServices(homeDir, hostPathClass));
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({ profile: external.name, delegationPosition: 'main' });
    expect(profile.data().activeToolNames).toEqual(tools);
    expect(ctx.get(IConfigService).get('memory')).toMatchObject({ enabled: true, approval: 'auto' });
    const policy = ctx.get(IAgentToolPolicyService);
    expect(policy.isToolActive('MemoryRead')).toBe(active);
    expect(policy.isToolActive('AgentRun')).toBe(active);
    expect(policy.isToolActive('MemoryWrite')).toBe(false);
    const executed: ToolExecutionResult[] = [];
    for await (const execution of ctx.get(IAgentToolExecutorService).execute([
      { id: 'external-memory', type: 'function', name: 'MemoryRead', arguments: JSON.stringify({ id: 'm_missing' }) },
    ], { signal: new AbortController().signal, turnId: 0 })) executed.push(execution);
    expect(executed).toHaveLength(1);
    expect(executed[0]!.result.isError === true, JSON.stringify(executed[0]!.result)).toBe(!active);
    if (!active) {
      expect(ctx.get(IAgentToolRegistryService).resolve('MemoryRead')).toBeUndefined();
      expect(executed[0]!.result.output).toBe('Tool "MemoryRead" not found');
    }
    await ctx.get(ISessionToolPolicy).setDisabledTools(['MemoryRead']);
    expect(policy.isToolActive('MemoryRead')).toBe(false);
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
    { saved: true, selected: undefined, effective: true },
    { saved: true, selected: false, effective: false },
    { saved: false, selected: true, effective: true },
    { saved: undefined, selected: undefined, effective: undefined },
  ])('freezes legacy external MCP injection $saved/$selected across cold restore', async ({ saved, selected, effective }) => {
    const external = normalizeAgentProfile({ name: 'bridge-worker', executor: 'grok-acp', modelAlias: 'vendor-model',
      injectKikiMcp: selected, kikiContext: ['memory'], systemPrompt: () => 'external worker' });
    const persistence = new InMemoryWireRecordPersistence();
    const build = () => createTestAgent({ persistence, autoConfigure: false },
      appService(IAgentExecutorRegistry, externalExecutorRegistry()),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(external)), hostEnvironmentServices(homeDir, hostPathClass));
    ctx = build();
    await ctx.get(IConfigService).set('agentExecutorOverrides', { 'grok-acp': { defaults: { inject_kiki_mcp: saved } } }, ConfigTarget.Memory);
    const service = ctx.get(IAgentProfileService);
    await service.bind({ profile: external.name, delegationPosition: 'sub' });
    expect(service.data().injectKikiMcp).toBe(effective);
    expect(service.data().execution).toBeUndefined();
    const frozen = service.data();
    service.applyBindingSnapshot(frozen);
    expect(service.data().injectKikiMcp).toBe(effective);
    await ctx.get(IWireService).flush();
    expect(persistence.records.filter((record) => record.type === 'profile.bind').at(-1)?.['injectKikiMcp']).toBe(effective);
    await ctx.dispose();
    ctx = build();
    await ctx.restorePersisted();
    expect(ctx.get(IAgentProfileService).data().injectKikiMcp).toBe(effective);
    expect(ctx.get(IAgentProfileService).data().execution).toBeUndefined();
  });

  it('keeps absent external effort as vendor default and preserves an explicit off choice', async () => {
    const seen: ExecutorBinding[] = [];
    const external = normalizeAgentProfile({
      name: 'external-vendor-default', executor: 'grok-acp', modelAlias: 'vendor-model',
      systemPrompt: () => 'external worker',
    });
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent(
      { persistence },
      appService(IAgentExecutorRegistry, externalExecutorRegistry(DEFAULT_EXTERNAL_EXECUTOR_DESCRIPTOR, (binding) => {
        seen.push(binding);
        return { ok: true, binding };
      })),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(external)),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    const svc = ctx.get(IAgentProfileService);
    await svc.bind({ profile: external.name, delegationPosition: 'main' });
    expect(seen.at(-1)?.thinkingEffort).toBeUndefined();
    expect(svc.data()).toMatchObject({ thinkingLevel: 'off', thinkingEffortExplicit: false });
    expect(persistence.records.find((record) => record.type === 'profile.bind')).toMatchObject({
      thinkingEffort: 'off', thinkingEffortExplicit: false,
    });

    svc.setThinking('off');
    expect(seen.at(-1)?.thinkingEffort).toBe('off');
    expect(svc.data().thinkingEffortExplicit).toBe(true);

    await svc.bind({ profile: external.name, delegationPosition: 'main' });
    expect(seen.at(-1)?.thinkingEffort).toBeUndefined();
    expect(svc.data().thinkingEffortExplicit).toBe(false);
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
    expect(svc.setEffort('high')).toEqual({ effort: 'high' });
    expect(svc.data()).toMatchObject({
      modelAlias: `${modelAlias}-next`,
      thinkingLevel: 'high',
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
    const tools = ctx.get(IAgentToolRegistryService);
    tools.register(new PolicyProbeTool('HistorySearch'));
    tools.register(new PolicyProbeTool('HistoryRead'));
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

  it('binds an external driver without a local model and exposes image media capability', async () => {
    const { profile: svc } = buildContext();

    await svc.bind({ driver: 'external' });

    expect(svc.data().driver).toBe('external');
    expect(svc.data().modelAlias).toBeUndefined();
    expect(svc.isRunnable()).toBe(false);
    expect(svc.getModelCapabilities()).toMatchObject({ image_in: true, video_in: false });
    expect(svc.getActiveToolNames()?.length).toBeGreaterThan(0);
  });

  it('clears the external driver only when a local model binding is explicit', async () => {
    const { profile: svc } = buildContext();

    await svc.bind({ driver: 'external' });
    expect(svc.isRunnable()).toBe(false);

    await svc.bind({ model: MOCK_MODEL });

    expect(svc.data().driver).toBeUndefined();
    expect(svc.data().modelAlias).toBe(MOCK_MODEL);
    expect(svc.isRunnable()).toBe(true);
  });

  it('binds a profile + model atomically and becomes runnable', async () => {
    const { profile: svc } = buildContext();

    const catalog = new BuiltinAgentProfileLoaderService(new ShippedAgentProfileSourceService());
    expect(catalog.get(DEFAULT_AGENT_PROFILE_NAME)).toBeDefined();
    await catalog.dispose();

    expect(svc.isRunnable()).toBe(false);

    await svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(svc.data().modelAlias).toBe(MOCK_MODEL);
    expect(svc.isRunnable()).toBe(true);
    expect(svc.getActiveToolNames()?.length).toBeGreaterThan(0);
    expect(svc.getSystemPrompt()).toContain('You are Kiki,');
  });

  it('binds a persona profile and model and replaces the default identity prefix', async () => {
    const personaProfile = normalizeAgentProfile({
      name: 'persona-profile',
      systemPrompt: () => 'You are Kiki, an interactive general AI agent.\n\nProfile capabilities.',
      tools: [],
    });
    const persona = {
      definition: {
        id: 'lin-lan',
        name: '林岚',
        title: '发布协调',
        profile: 'persona-profile',
        modelAlias: MOCK_MODEL,
        description: '先给结论。',
      },
      revision: 'r1',
    } as const;
    const personaStore = {
      _serviceBrand: undefined,
      onDidChange: Event.None,
      get: async (id: string) => id === 'lin-lan' ? persona : undefined,
    } as unknown as IPersonaStore;
    ctx = createTestAgent(
      appService(IPersonaStore, personaStore),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(personaProfile)),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    const svc = ctx.get(IAgentProfileService);

    const metadata = ctx.get(ISessionMetadata);
    await metadata.registerAgent('main', { type: 'main' });
    await svc.bind({ persona: 'lin-lan' });

    expect((await metadata.read()).agents?.['main']?.personaId).toBe('lin-lan');
    expect(svc.data()).toMatchObject({ profileName: 'persona-profile', modelAlias: MOCK_MODEL, personaId: 'lin-lan', personaRevision: 'r1' });
    expect(svc.getSystemPrompt().startsWith('<persona name="林岚" title="发布协调">')).toBe(true);
    expect(svc.getSystemPrompt()).toContain('你运行在 Kiki 中');
    expect(svc.getSystemPrompt()).toContain('Profile capabilities.');
    expect(svc.getSystemPrompt()).not.toContain('You are Kiki');
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

  it('rejects inherit on a main-agent profile even when the caller supplies an explicit model', async () => {
    const main = normalizeAgentProfile({
      name: DEFAULT_AGENT_PROFILE_NAME,
      modelAlias: 'inherit',
      systemPrompt: () => 'main profile',
    });
    ctx = createTestAgent(
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(main)),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    await expect(ctx.get(IAgentProfileService).bind({
      profile: DEFAULT_AGENT_PROFILE_NAME,
      model: MOCK_MODEL,
    })).rejects.toMatchObject({
      code: ProfileErrors.codes.MODEL_CONFIG_INVALID,
      message: expect.stringContaining('has no caller agent'),
    });
  });

  it('resolves a bare default_model through the canonical model entry', async () => {
    const alias = 'canonical-model';
    const canonicalId = `test-provider/${alias}`;
    ctx = createTestAgent({ initialConfig: { defaultModel: alias, models: {
      [canonicalId]: { provider: 'test-provider', model: alias, maxContextSize: 1_000_000, defaultEffort: 'off' },
    } } }, hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(normalizeAgentProfile({
        name: DEFAULT_AGENT_PROFILE_NAME, main: true, systemPrompt: () => 'main profile',
      }))));
    const svc = ctx.get(IAgentProfileService);
    await ctx.get(IConfigService).set('defaultModel', alias, ConfigTarget.Memory);
    expect(ctx.get(IConfigService).get('defaultModel')).toBe(alias);
    expect(ctx.get(ISessionAgentProfileCatalog).getDefault().modelAlias).toBeUndefined();
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
    ctx.kimiConfig = { ...ctx.kimiConfig, models: { ...ctx.kimiConfig.models,
      [MOCK_MODEL]: { ...ctx.kimiConfig.models![MOCK_MODEL]!, capabilities: ['thinking'], supportEfforts: ['low', 'high'], defaultEffort: 'high' },
    } };
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
    ctx.kimiConfig = { ...ctx.kimiConfig, models: {
      [canonicalId]: {
        provider: 'test-provider',
        model: MOCK_MODEL,
        maxContextSize: 1_000_000,
      },
    } };
    await ctx.ready;
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

  it('does not admit deleted collaboration tools on any builtin profile', async () => {
    const catalog = new BuiltinAgentProfileLoaderService(new ShippedAgentProfileSourceService());
    const collaborationTools = [
      'spawn_agent',
      'list_agents',
      'wait_agent',
      'followup_task',
      'interrupt_agent',
      'send_message',
    ];

    const profiles = catalog.list();
    expect(profiles.length).toBeGreaterThan(0);
    for (const profile of profiles) {
      expect(collaborationTools.filter((name) => isToolActive(profile, name))).toEqual([]);
    }

    await catalog.dispose();
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

  it('binds the routed snapshot without warnings when a main user overrides its recommended pins', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent(
      { persistence },
      hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, routedCatalog()),
    );
    ctx.kimiConfig = { ...ctx.kimiConfig, models: { ...ctx.kimiConfig.models,
      'other-model': {
        provider: 'test-provider',
        model: 'other-model',
        maxContextSize: 1_000_000,
        capabilities: ['thinking'],
        supportEfforts: ['low', 'high'],
        defaultEffort: 'high',
      },
    } };
    await ctx.ready;
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
      allowedSubagents: ['explore'],
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
    expect(warnings.filter(({ code }) => code !== 'agents-md-oversized')).toEqual([]);
    await expect(profile.bind({ profile: 'reviewer', model: MOCK_MODEL })).rejects.toMatchObject({
      code: 'agent_profile_route.switch_forbidden',
    });
  });

  it('fails an unavailable route default atomically but accepts an explicit detached model', async () => {
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

    await expect(
      profile.bind({ route: 'reviewer.ui-k3', model: MOCK_MODEL, delegationPosition: 'sub' }),
    ).resolves.toBeUndefined();
    expect(profile.data()).toMatchObject({
      modelAlias: MOCK_MODEL,
      lockedModelAlias: 'removed-model',
      routeDetached: true,
      bindingAdvisories: [expect.objectContaining({
        code: 'model_pin_overridden',
        ruleSource: 'route:reviewer.ui-k3.model_alias',
        valueSource: 'dispatch-explicit',
      })],
    });
  });

  it.each(['main', 'sub'] as const)('uses shared effort with main-only usage overrides and preserves profile/call priority (%s)', async (delegationPosition) => {
    const configured = resumeProfile();
    const options = nativeResumeOptions();
    const build = (profile: AgentProfile) => createTestAgent({ initialConfig: { ...options.initialConfig, models: {
      ...options.initialConfig.models,
      [RESUME_OLD_MODEL]: { ...options.initialConfig.models[RESUME_OLD_MODEL], supportEfforts: ['low', 'medium', 'high', 'max'],
        parameters: { thinkingEffort: 'high' }, usage: { main: { thinkingEffort: 'low' } } },
    } } }, hostEnvironmentServices(homeDir, hostPathClass), sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(profile)));
    ctx = build(configured);
    const svc = ctx.get(IAgentProfileService);
    await svc.bind({ profile: configured.name, delegationPosition });
    expect(svc.data().thinkingLevel).toBe(delegationPosition === 'main' ? 'low' : 'high');
    expect((await ctx.get(IModelCatalog).listModels()).find((model) => model.id === RESUME_OLD_MODEL)?.default_effort).toBe('high');
    await svc.bind({ profile: configured.name, thinking: 'max', delegationPosition });
    expect(svc.data().thinkingLevel).toBe('max');
    await ctx.dispose();
    ctx = build(resumeProfile({ thinkingEffort: 'medium' }));
    await ctx.get(IAgentProfileService).bind({ profile: configured.name, delegationPosition });
    expect(ctx.get(IAgentProfileService).data().thinkingLevel).toBe('medium');
  });

  it('keeps a legal on binding through journal persistence and a cold restore', async () => {
    const options = nativeResumeOptions();
    const persistence = new InMemoryWireRecordPersistence();
    const build = () => createTestAgent({ persistence, autoConfigure: false, initialConfig: { ...options.initialConfig, models: {
      ...options.initialConfig.models,
      [RESUME_OLD_MODEL]: { ...options.initialConfig.models[RESUME_OLD_MODEL], supportEfforts: ['off', 'on'], defaultEffort: 'on' },
    } } }, hostEnvironmentServices(homeDir, hostPathClass), sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(resumeProfile())));
    ctx = build();
    await ctx.get(IAgentProfileService).bind({ profile: 'resume-profile', delegationPosition: 'sub' });
    expect(ctx.get(IAgentProfileService).data().thinkingLevel).toBe('on');
    await ctx.get(IWireService).flush();
    expect(persistence.records.some((record) => JSON.stringify(record).includes('"thinkingEffort":"on"'))).toBe(true);
    await ctx.dispose();
    ctx = build();
    await ctx.restorePersisted();
    expect(ctx.get(IAgentProfileService).data()).toMatchObject({ modelAlias: RESUME_OLD_MODEL, thinkingLevel: 'on', effectiveThinkingLevel: 'on' });
    await expect(ctx.get(IAgentProfileService).prepareResumeBinding({})).resolves.toMatchObject({ model: RESUME_OLD_MODEL, thinking: 'on' });
  });

  it('uses a concrete model default without fabricating on when binding a model-only child', async () => {
    const configured = resumeProfile();
    const options = nativeResumeOptions();
    options.initialConfig.models[RESUME_OLD_MODEL] = {
      ...options.initialConfig.models[RESUME_OLD_MODEL], supportEfforts: [],
      ...{ defaultEffort: 'high' },
    };
    ctx = createTestAgent(options, hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(configured)));
    const svc = ctx.get(IAgentProfileService);
    await svc.bind({ profile: configured.name, delegationPosition: 'sub' });
    expect(svc.data()).toMatchObject({ modelAlias: RESUME_OLD_MODEL, thinkingLevel: 'high', effectiveThinkingLevel: 'high' });
    const saved = JSON.parse(JSON.stringify(svc.data())) as ProfileBindingSnapshot;
    svc.applyBindingSnapshot(saved);
    expect(svc.data()).toMatchObject({ modelAlias: RESUME_OLD_MODEL, thinkingLevel: 'high' });
  });

  it.each(['main', 'sub'] as const)('rejects a model-only child when the model has no resolvable default effort (%s)', async (delegationPosition) => {
    const configured = resumeProfile();
    const options = nativeResumeOptions();
    const { defaultEffort: _default, ...withoutDefault } = options.initialConfig.models[RESUME_OLD_MODEL];
    ctx = createTestAgent({ initialConfig: { ...options.initialConfig, models: { ...options.initialConfig.models, [RESUME_OLD_MODEL]: withoutDefault } } }, hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(configured)));
    const svc = ctx.get(IAgentProfileService);
    const before = svc.data();
    await expect(svc.bind({ profile: configured.name, delegationPosition })).rejects.toThrow(/default.*effort|effort.*default/i);
    expect(svc.data()).toEqual(before);
    await expect(svc.bind({ profile: configured.name, thinking: 'high', delegationPosition })).resolves.toBeUndefined();
    expect(svc.data().thinkingLevel).toBe('high');
  });

  it('rejects an unsupported routed profile effort instead of replacing the authored pin', async () => {
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

    const before = profile.data();
    await expect(profile.bind({ route: 'reviewer.ui-k3' })).rejects.toThrow(/ultra.*not supported/);
    expect(profile.data()).toEqual(before);
  });

  it.each(['sub'] as const)('enforces the frozen menu for %s binding, switches and resume without mutation', async (delegationPosition) => {
    const configured = resumeProfile({ restrictModelsToMenu: true });
    ctx = createTestAgent(nativeResumeOptions(), hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(configured)));
    const svc = ctx.get(IAgentProfileService);
    const unbound = svc.data();
    await expect(svc.bind({ profile: configured.name, model: RESUME_NEW_MODEL, delegationPosition })).rejects.toMatchObject({
      code: ErrorCodes.PROFILE_CONSTRAINT_VIOLATION, details: { ruleSource: 'profile:resume-profile.restrict_models_to_menu' },
    });
    expect(svc.data()).toEqual(unbound);
    await expect(svc.bind({ profile: configured.name, lease: { name: configured.name, modelAlias: RESUME_NEW_MODEL, modelProfiles: [{ alias: RESUME_NEW_MODEL }] }, delegationPosition })).rejects.toThrow(/restrict_models_to_menu/);
    await svc.bind({ profile: configured.name, thinking: 'low', lease: { name: configured.name, modelProfiles: [{ alias: RESUME_NEW_MODEL }] }, delegationPosition });
    const before = svc.data();
    expect(before.boundProfile).toMatchObject({ restrictModelsToMenu: true, modelProfiles: [{ alias: RESUME_NEW_MODEL }],
      modelMenuConstraint: { defaultAlias: RESUME_OLD_MODEL, aliases: [RESUME_OLD_MODEL], identities: [RESUME_OLD_MODEL] } });
    await expect(svc.setModel(RESUME_NEW_MODEL)).rejects.toThrow(/restrict_models_to_menu/);
    await expect(prepareResumeBinding(svc, { modelAlias: RESUME_NEW_MODEL, allowModelChange: true })).rejects.toThrow(/restrict_models_to_menu/);
    await expect(prepareResumeBinding(svc, { modelAlias: RESUME_NEW_MODEL })).rejects.toThrow(/allow_model_change/);
    await expect(prepareResumeBinding(svc, { modelAlias: RESUME_NEW_MODEL, newWindow: true })).rejects.toThrow(/restrict_models_to_menu/);
    await expect(prepareResumeBinding(svc, { callerConstraints: [{ allowedModels: [RESUME_NEW_MODEL] }] })).rejects.toThrow(/allowed_models/);
    await (await prepareResumeBinding(svc, {}))();
    expect(svc.data()).toEqual(before);
    await ctx.expectResumeMatches();
  });

  it.each([true, false])('keeps frozen switch=%s and menu authority despite live catalog edits', async (restrictModelsToMenu) => {
    const original = resumeProfile({ restrictModelsToMenu });
    const catalog = singleProfileCatalog(original);
    ctx = createTestAgent(nativeResumeOptions(), hostEnvironmentServices(homeDir, hostPathClass), sessionService(ISessionAgentProfileCatalog, catalog));
    const svc = ctx.get(IAgentProfileService);
    await svc.bind({ profile: original.name, thinking: 'low', delegationPosition: 'sub' });
    const modified = resumeProfile({ restrictModelsToMenu: !restrictModelsToMenu, modelAlias: RESUME_NEW_MODEL });
    vi.spyOn(catalog, 'get').mockReturnValue(modified);
    vi.spyOn(catalog, 'resolveSelection').mockReturnValue({ profile: modified, baseProfile: modified });
    await (await prepareResumeBinding(svc, {}))();
    expect(svc.data().boundProfile?.restrictModelsToMenu).toBe(restrictModelsToMenu);
    if (restrictModelsToMenu) {
      await expect(prepareResumeBinding(svc, { modelAlias: RESUME_NEW_MODEL, allowModelChange: true })).rejects.toThrow(/restrict_models_to_menu/);
    } else {
      await (await prepareResumeBinding(svc, { modelAlias: RESUME_NEW_MODEL, allowModelChange: true }))();
      expect(svc.data().modelAlias).toBe(RESUME_NEW_MODEL);
    }
    await ctx.expectResumeMatches();
  });

  it('keeps an allowed menu model change subject to resume confirmation', async () => {
    const svc = await bindNativeResumeProfile(resumeProfile({ restrictModelsToMenu: true, modelProfiles: [{ alias: RESUME_NEW_MODEL, when: 'An informational condition' }] }));
    await expect(prepareResumeBinding(svc, { modelAlias: RESUME_NEW_MODEL })).rejects.toThrow(/allow_model_change/);
    await (await prepareResumeBinding(svc, { modelAlias: RESUME_NEW_MODEL, allowModelChange: true }))();
    expect(svc.data().modelAlias).toBe(RESUME_NEW_MODEL);
    expect(svc.data().boundProfile?.modelMenuConstraint?.defaultAlias).toBe(RESUME_OLD_MODEL);
    await ctx.expectResumeMatches();
  });

  it('admits explicit new-window model changes purely without expanding the frozen menu', async () => {
    const svc = await bindNativeResumeProfile(resumeProfile({ restrictModelsToMenu: true,
      modelProfiles: [{ alias: RESUME_NEW_MODEL, when: 'An informational condition' }] }));
    const before = svc.data();
    const prepared = await svc.prepareResumeBinding({ modelAlias: RESUME_NEW_MODEL, newWindow: true, allowParentNotify: false });
    expect(svc.data()).toEqual(before);
    expect(prepared).toMatchObject({ model: RESUME_NEW_MODEL, config: { allowParentNotify: false } });
    prepared.assertCurrent();
    await commitResumeBinding(prepared);
    expect(svc.data()).toMatchObject({ modelAlias: RESUME_NEW_MODEL, allowParentNotify: false });
    expect(svc.data().boundProfile?.modelMenuConstraint).toEqual(before.boundProfile?.modelMenuConstraint);
    await expect(svc.prepareResumeBinding({ modelAlias: `${RESUME_PROVIDER}/missing-model`, newWindow: true })).rejects.toThrow();
    await ctx.expectResumeMatches();
  });

  it('enforces the menu after external executor normalization and on resume', async () => {
    const configured = resumeProfile({ executor: 'grok-acp', restrictModelsToMenu: true, modelAlias: 'external-allowed', thinkingEffort: 'low' });
    const svc = await bindExternalResumeProfile(configured, externalExecutorRegistry());
    const before = svc.data();
    await expect(svc.setModel('external-blocked')).rejects.toThrow(/restrict_models_to_menu/);
    await expect(prepareResumeBinding(svc, { modelAlias: 'external-blocked', allowModelChange: true })).rejects.toThrow(/restrict_models_to_menu/);
    expect(svc.data()).toEqual(before);
    await ctx.expectResumeMatches();
  });

  it('rejects executor-normalized models outside the original menu before any binding state changes', async () => {
    const configured = resumeProfile({ executor: 'grok-acp', restrictModelsToMenu: true, modelAlias: 'external-default' });
    ctx = createTestAgent(hostEnvironmentServices(homeDir, hostPathClass),
      appService(IAgentExecutorRegistry, externalExecutorRegistry(DEFAULT_EXTERNAL_EXECUTOR_DESCRIPTOR, (binding) => ({ ok: true, binding: { ...binding, modelAlias: 'outside-normalized' } }))),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(configured)));
    const svc = ctx.get(IAgentProfileService);
    const before = svc.data();
    await expect(svc.bind({ profile: configured.name, delegationPosition: 'sub' })).rejects.toMatchObject({ code: ErrorCodes.PROFILE_CONSTRAINT_VIOLATION,
      details: { ruleSource: 'profile:resume-profile.restrict_models_to_menu', effectiveValue: 'outside-normalized', valueSource: 'executor-normalized' } });
    expect(svc.data()).toEqual(before);
  });

  it('enforces external executor hard bindings before switches and resume without starting the executor', async () => {
    const configured = resumeProfile({ executor: 'grok-acp', modelAlias: 'external-allowed', thinkingEffort: 'low', allowedModels: ['external-allowed'], allowedEfforts: ['low'] });
    const svc = await bindExternalResumeProfile(configured, externalExecutorRegistry());
    const before = svc.data();
    await expect(svc.setModel('external-blocked')).rejects.toMatchObject({ code: ErrorCodes.PROFILE_CONSTRAINT_VIOLATION });
    expect(() => svc.setEffort('high')).toThrow(/allowed_efforts/);
    await expect(prepareResumeBinding(svc, { modelAlias: 'external-blocked', allowModelChange: true })).rejects.toThrow(/allowed_models/);
    expect(svc.data()).toEqual(before);
    await ctx.expectResumeMatches();
  });

  it.each(['sub'] as const)('enforces hard model and effort rules before %s binding or manual mutation', async (delegationPosition) => {
    const configured = resumeProfile({ allowedModels: [RESUME_OLD_MODEL], allowedEfforts: ['low'], preferredModels: [RESUME_NEW_MODEL] });
    ctx = createTestAgent(nativeResumeOptions(), hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(configured)));
    const svc = ctx.get(IAgentProfileService);
    const unbound = svc.data();
    await expect(svc.bind({ profile: configured.name, model: RESUME_NEW_MODEL, delegationPosition }))
      .rejects.toMatchObject({ code: ErrorCodes.PROFILE_CONSTRAINT_VIOLATION });
    expect(svc.data()).toEqual(unbound);
    await svc.bind({ profile: configured.name, model: RESUME_OLD_MODEL, thinking: 'low', delegationPosition });
    const before = svc.data();
    await expect(svc.setModel(RESUME_NEW_MODEL)).rejects.toMatchObject({ code: ErrorCodes.PROFILE_CONSTRAINT_VIOLATION });
    expect(() => svc.setEffort('high')).toThrow(/allowed_efforts/);
    expect(svc.data()).toEqual(before);
  });

  it('does not warn or reject main choices that depart from recommendations', async () => {
    const configured = resumeProfile({ main: true, preferredModels: [RESUME_OLD_MODEL], discouragedModels: [RESUME_NEW_MODEL],
      preferredEfforts: ['low'], modelProfiles: [{ alias: RESUME_OLD_MODEL, when: 'Recommended', thinkingEffort: 'low' }] });
    ctx = createTestAgent(nativeResumeOptions(), hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(configured)));
    const svc = ctx.get(IAgentProfileService);
    const warnings: WarningIssued[] = [];
    ctx.get(IEventBus).subscribe(WarningIssued, (event) => warnings.push(event));
    await svc.bind({ profile: configured.name, model: RESUME_NEW_MODEL, thinking: 'high', delegationPosition: 'main' });
    svc.publishBindingAdvisories();
    await svc.setModel(RESUME_OLD_MODEL);
    await svc.setModel(RESUME_NEW_MODEL);
    expect(svc.data().modelAlias).toBe(RESUME_NEW_MODEL);
    expect(svc.data().bindingAdvisories).toEqual([]);
    expect(warnings.filter((event) => event.code === 'profile-binding-advisory')).toEqual([]);
  });

  it.each([
    { restrictModelsToMenu: true },
    { allowedModels: [RESUME_OLD_MODEL] },
    { denyModels: [RESUME_NEW_MODEL] },
    { modelProfiles: [{ alias: RESUME_NEW_MODEL, allowedModels: [RESUME_OLD_MODEL] }] },
  ])('allows main binding and model changes outside hard constraints with warnings: %j', async (constraints) => {
    const configured = resumeProfile({ main: true, ...constraints });
    ctx = createTestAgent(nativeResumeOptions(), hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(configured)));
    const svc = ctx.get(IAgentProfileService);
    const warnings: WarningIssued[] = [];
    ctx.get(IEventBus).subscribe(WarningIssued, (event) => warnings.push(event));
    await svc.bind({ profile: configured.name, model: RESUME_NEW_MODEL, delegationPosition: 'main' });
    svc.publishBindingAdvisories();
    expect(svc.data().modelAlias).toBe(RESUME_NEW_MODEL);
    expect(svc.data().bindingAdvisories).toEqual([expect.objectContaining({ dimension: 'model', effectiveValue: RESUME_NEW_MODEL })]);
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'profile-binding-advisory' }));
    await svc.setModel(RESUME_OLD_MODEL);
    expect(svc.data().bindingAdvisories).toEqual([]);
    await svc.setModel(RESUME_NEW_MODEL);
    expect(svc.data().modelAlias).toBe(RESUME_NEW_MODEL);
    expect(svc.data().bindingAdvisories).toHaveLength(1);
  });

  it('warns without rejecting main effort choices outside profile hard rules', async () => {
    const configured = resumeProfile({ main: true, allowedEfforts: ['low'] });
    ctx = createTestAgent(nativeResumeOptions(), hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(configured)));
    const svc = ctx.get(IAgentProfileService);
    await svc.bind({ profile: configured.name, thinking: 'high', delegationPosition: 'main' });
    expect(svc.data().bindingAdvisories).toEqual([expect.objectContaining({ code: 'effort_not_allowed' })]);
    svc.setEffort('low');
    expect(svc.data().bindingAdvisories).toEqual([]);
    svc.setEffort('high');
    expect(svc.data().thinkingLevel).toBe('high');
    expect(svc.data().bindingAdvisories).toEqual([expect.objectContaining({ code: 'effort_not_allowed' })]);
  });

  it('keeps external main selections above profile rules and subagent-only host denials', async () => {
    const configured = resumeProfile({ main: true, executor: 'grok-acp', modelAlias: 'external-default',
      restrictModelsToMenu: true, allowedModels: ['external-default'], denyModels: ['external-outside'] });
    ctx = createTestAgent({ initialConfig: { subagent: { denyModels: ['external-outside'] } } },
      hostEnvironmentServices(homeDir, hostPathClass), appService(IAgentExecutorRegistry, externalExecutorRegistry()),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(configured)));
    const svc = ctx.get(IAgentProfileService);
    await svc.bind({ profile: configured.name, model: 'external-outside', delegationPosition: 'main' });
    expect(svc.data().modelAlias).toBe('external-outside');
    expect(svc.data().bindingAdvisories?.map((entry) => entry.code)).toEqual(['model_not_allowed', 'model_denied', 'model_not_allowed']);
    await svc.setModel('external-default');
    expect(svc.data().bindingAdvisories).toEqual([]);
    await svc.setModel('external-outside');
    expect(svc.data().modelAlias).toBe('external-outside');
  });

  it('retains hard rules for a restored child even when its saved profile has main: true', async () => {
    const configured = resumeProfile({ main: true, allowedModels: [RESUME_OLD_MODEL] });
    ctx = createTestAgent(nativeResumeOptions(), hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(configured)),
      agentService(IAgentScopeContext, makeAgentScopeContext({ agentId: 'child', parentAgentId: 'main', agentScope: 'test/child' })));
    const svc = ctx.get(IAgentProfileService);
    svc.applyBindingSnapshot({ profileName: configured.name, modelAlias: RESUME_OLD_MODEL, thinkingLevel: 'low',
      systemPrompt: 'Saved child prompt', boundProfile: freezeBoundProfile(configured) });
    const before = svc.data();
    await expect(svc.setModel(RESUME_NEW_MODEL)).rejects.toMatchObject({ code: ErrorCodes.PROFILE_CONSTRAINT_VIOLATION });
    expect(svc.data()).toEqual(before);
  });

  it.each(['appliedLease', 'spawnPolicy'] as const)('keeps external model identities distinct from native aliases when restoring legacy %s', async (scope) => {
    const configured = resumeProfile({ executor: 'grok-acp', modelAlias: 'vendor-a', allowedModels: ['vendor-a'] });
    ctx = createTestAgent(hostEnvironmentServices(homeDir, hostPathClass),
      appService(IAgentExecutorRegistry, externalExecutorRegistry()),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(configured)),
      agentService(IAgentScopeContext, makeAgentScopeContext({ agentId: 'child', parentAgentId: 'main', agentScope: 'test/child' })));
    const nativeResolve = vi.spyOn(ctx.get(IModelService), 'resolveId').mockImplementation((alias) =>
      alias === 'vendor-a' || alias === 'vendor-b' ? 'native-collision' : undefined);
    const svc = ctx.get(IAgentProfileService);
    svc.applyBindingSnapshot({ profileName: configured.name, executorId: 'grok-acp', executorProtocol: 'acp-v1',
      modelAlias: 'vendor-a', thinkingLevel: 'low', systemPrompt: 'Saved external child prompt',
      [scope]: { name: configured.name, allowedModels: ['vendor-b'] } });
    const before = svc.data();
    await expect(svc.prepareResumeBinding({})).rejects.toMatchObject({ code: ErrorCodes.PROFILE_CONSTRAINT_VIOLATION });
    expect(nativeResolve).not.toHaveBeenCalledWith('vendor-b');
    expect(svc.data()).toEqual(before);
  });

  it.each(['lease', 'spawnPolicy'] as const)('does not let explicit pins or preferences widen caller %s hard rules', async (scope) => {
    const configured = resumeProfile();
    ctx = createTestAgent(nativeResumeOptions(), hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(configured)));
    const svc = ctx.get(IAgentProfileService);
    const constraint = { name: configured.name, allowedModels: [RESUME_OLD_MODEL], preferredModels: [RESUME_NEW_MODEL] };
    await expect(svc.bind({ profile: configured.name, model: RESUME_NEW_MODEL, delegationPosition: 'sub', [scope]: constraint }))
      .rejects.toMatchObject({ code: ErrorCodes.PROFILE_CONSTRAINT_VIOLATION });
  });

  it('keeps replaced model-profile constraints in the bound snapshot and on resume', async () => {
    const configured = resumeProfile({ modelProfiles: [{ alias: RESUME_OLD_MODEL, allowedEfforts: ['low'] }] });
    ctx = createTestAgent(nativeResumeOptions(), hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(configured)));
    const svc = ctx.get(IAgentProfileService);
    const lease = { name: configured.name, modelProfiles: [{ alias: RESUME_OLD_MODEL, thinkingEffort: 'high' }] };
    await expect(svc.bind({ profile: configured.name, lease, delegationPosition: 'sub' })).rejects.toThrow(/allowed_efforts/);
    await svc.bind({ profile: configured.name, lease: { ...lease, modelProfiles: [{ alias: RESUME_OLD_MODEL, thinkingEffort: 'low' }] }, delegationPosition: 'sub' });
    expect(svc.data().boundProfile?.modelConstraintProfiles).toEqual(configured.modelProfiles);
    await expect(prepareResumeBinding(svc, { thinkingEffort: 'high' })).rejects.toThrow(/allowed_efforts/);
    await ctx.expectResumeMatches();
  });

  it('rejects forced effort outside a hard allowlist instead of softening the host value', async () => {
    const configured = resumeProfile({ allowedEfforts: ['low'] });
    const options = nativeResumeOptions();
    ctx = createTestAgent({ initialConfig: { ...options.initialConfig, thinking: { effort: 'low', forcedEffort: 'high' } } },
      hostEnvironmentServices(homeDir, hostPathClass), sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(configured)));
    await expect(ctx.get(IAgentProfileService).bind({ profile: configured.name, delegationPosition: 'sub' }))
      .rejects.toMatchObject({ code: ErrorCodes.PROFILE_CONSTRAINT_VIOLATION, details: { valueSource: 'environment-forced', effectiveValue: 'high' } });
  });

  it('queues structured binding advisories until creation publication and deduplicates them', async () => {
    const configured = resumeProfile({ preferredModels: [RESUME_OLD_MODEL] });
    ctx = createTestAgent(
      nativeResumeOptions(),
      hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(configured)),
    );
    const profile = ctx.get(IAgentProfileService);
    const warnings: WarningIssued[] = [];
    ctx.get(IEventBus).subscribe(WarningIssued, (event) => warnings.push(event));

    await profile.bind({
      profile: configured.name,
      model: RESUME_NEW_MODEL,
      delegationPosition: 'sub',
      bindingSelection: {
        model: { source: 'dispatch-explicit', requestedValue: RESUME_NEW_MODEL },
      },
    });
    expect(warnings.filter(({ code }) => code !== 'agents-md-oversized')).toEqual([]);
    expect(profile.data().bindingAdvisories).toEqual([
      expect.objectContaining({
        code: 'model_not_preferred',
        ruleSource: 'profile:resume-profile.preferred_models',
      }),
    ]);

    profile.publishBindingAdvisories();
    profile.publishBindingAdvisories();
    const advisoryWarnings = warnings.filter(({ code }) => code === 'profile-binding-advisory');
    expect(advisoryWarnings).toHaveLength(1);
    expect(advisoryWarnings[0]).toMatchObject({
      code: 'profile-binding-advisory',
      advisory: expect.objectContaining({ code: 'model_not_preferred' }),
    });
  });

  it('distinguishes a nonrecommended profile default from an explicit dispatch pin', async () => {
    const configured = resumeProfile({
      modelAlias: RESUME_NEW_MODEL,
      preferredModels: [RESUME_OLD_MODEL],
    });
    ctx = createTestAgent(
      nativeResumeOptions(),
      hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(configured)),
    );
    const profile = ctx.get(IAgentProfileService);

    await profile.bind({ profile: configured.name, delegationPosition: 'sub' });
    expect(profile.data().bindingAdvisories).toEqual([
      expect.objectContaining({
        code: 'model_not_preferred',
        requestedValue: RESUME_NEW_MODEL,
        effectiveValue: RESUME_NEW_MODEL,
        valueSource: 'profile-default',
      }),
    ]);
  });

  it('allows an explicit model to override a caller lease pin with a source-located advisory', async () => {
    const configured = resumeProfile();
    ctx = createTestAgent(
      nativeResumeOptions(),
      hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(configured)),
    );
    const profile = ctx.get(IAgentProfileService);

    await profile.bind({
      profile: configured.name,
      model: RESUME_NEW_MODEL,
      delegationPosition: 'sub',
      lease: { name: configured.name, modelAlias: RESUME_OLD_MODEL },
    });
    expect(profile.data()).toMatchObject({
      modelAlias: RESUME_NEW_MODEL,
      bindingAdvisories: [expect.objectContaining({
        code: 'model_pin_overridden',
        ruleSource: 'caller-lease:resume-profile.model_alias',
        valueSource: 'dispatch-explicit',
      })],
    });
  });

  it('records a runtime effort outside preferred_efforts as advisory', async () => {
    const profile = await bindNativeResumeProfile(resumeProfile({ preferredEfforts: ['low'] }));

    expect(profile.setEffort('high')).toEqual({ effort: 'high' });
    expect(profile.data()).toMatchObject({
      thinkingLevel: 'high',
      bindingAdvisories: [expect.objectContaining({
        code: 'effort_not_preferred',
        valueSource: 'runtime-explicit',
      })],
    });
  });

  it('binds a forced effort outside preferred_efforts with an advisory', async () => {
    const configured = resumeProfile({ thinkingEffort: 'low', preferredEfforts: ['low', 'high'] });
    const options = nativeResumeOptions();
    ctx = createTestAgent(
      {
        initialConfig: {
          ...options.initialConfig,
          thinking: { enabled: true, effort: 'low', forcedEffort: 'max' },
          models: {
            ...options.initialConfig.models,
            [RESUME_OLD_MODEL]: {
              ...options.initialConfig.models[RESUME_OLD_MODEL],
              supportEfforts: ['low', 'high', 'max'],
            },
          },
        },
      },
      hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(configured)),
    );
    const profile = ctx.get(IAgentProfileService);

    await expect(
      profile.bind({ profile: configured.name, delegationPosition: 'sub' }),
    ).resolves.toBeUndefined();
    expect(profile.setEffort('high')).toEqual({ effort: 'max' });
    expect(profile.data()).toMatchObject({
      profileName: configured.name,
      thinkingLevel: 'high',
      effectiveThinkingLevel: 'max',
      bindingAdvisories: [expect.objectContaining({
        code: 'effort_not_preferred',
        effectiveValue: 'max',
        valueSource: 'environment-forced',
      })],
    });
  });

  it('marks a route detached when forced effort differs from its effort pin', async () => {
    const options = nativeResumeOptions();
    ctx = createTestAgent(
      {
        initialConfig: {
          ...options.initialConfig,
          thinking: { enabled: true, effort: 'low', forcedEffort: 'high' },
        },
      },
      hostEnvironmentServices(homeDir, hostPathClass),
      sessionService(ISessionAgentProfileCatalog, routedCatalog(RESUME_OLD_MODEL, 'low')),
    );
    const profile = ctx.get(IAgentProfileService);

    await profile.bind({ route: 'reviewer.ui-k3', delegationPosition: 'sub' });

    expect(profile.data()).toMatchObject({
      thinkingLevel: 'low',
      effectiveThinkingLevel: 'high',
      thinkingEffortSource: 'forced',
      routeDetached: true,
      bindingAdvisories: [expect.objectContaining({
        code: 'effort_pin_overridden',
        valueSource: 'environment-forced',
      })],
    });
  });

  it.each(['main', 'sub'] as const)('applies profile tier over model defaults for %s bindings', async (delegationPosition) => {
    const configured = normalizeAgentProfile({ name: 'tier-helper', modelAlias: 'tier-model', serviceTier: 'flex', systemPrompt: () => '' });
    ctx = createTestAgent({ initialConfig: { models: {
      'tier-model': { provider: 'test-provider', model: 'tier-model', maxContextSize: 1000, serviceTier: 'priority', defaultEffort: 'off' },
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
      [RESUME_OLD_MODEL]: { ...options.initialConfig.models[RESUME_OLD_MODEL], maxContextSize: 1000, maxInputSize: 800, maxOutputSize: 400, supportEfforts: ['low', 'medium', 'high'], defaultEffort: 'low' },
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
    expect(profile.resolveRequestParams()).toMatchObject({ sampling: { temperature: 0.4, topP: 0.8 }, requestParams: { temperature: 0.4, top_p: 0.8 }, serviceTier: 'flex' });
    expect(ctx.get(IModelCatalog).get(RESUME_NEW_MODEL).requestParams).toMatchObject({ seed: 42, temperature: 0.2 });
    const effortOnly = await profile.prepareResumeBinding({ thinkingEffort: 'low' });
    await commitResumeBinding(effortOnly);
    expect(profile.data().thinkingLevel).toBe('low');
    await commitResumeBinding(await profile.prepareResumeBinding({ modelAlias: RESUME_NEW_MODEL }));
    expect(profile.data().thinkingLevel).toBe('low');
    await commitResumeBinding(await profile.prepareResumeBinding({ modelAlias: RESUME_OLD_MODEL, allowModelChange: true }));
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
      allowedSubagents: ['explore'],
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
      allowedSubagents: ['explore'],
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
    const alias = 'canonical-model';
    const canonicalId = `test-provider/${alias}`;
    ctx = createTestAgent({ initialConfig: { models: {
      [canonicalId]: { provider: 'test-provider', model: alias, maxContextSize: 1_000_000, defaultEffort: 'off' },
    } } }, hostEnvironmentServices(homeDir, hostPathClass));
    const svc = ctx.get(IAgentProfileService);

    await svc.setModel(alias);

    expect(svc.data().modelAlias).toBe(canonicalId);
  });

  it.each(['setModel', 'resume'] as const)('persists the changed model in state.json after %s', async (method) => {
    const documents = createAtomicDocumentStore();
    ctx = createTestAgent(nativeResumeOptions(), appService(IAtomicDocumentStore, documents),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(resumeProfile())),
      hostEnvironmentServices(homeDir, hostPathClass));
    const svc = ctx.get(IAgentProfileService);
    const metadata = ctx.get(ISessionMetadata);
    await metadata.registerAgent('main', { type: 'sub', parentAgentId: 'parent', displayName: 'kept-label', model: RESUME_OLD_MODEL });
    await svc.bind({ profile: 'resume-profile', model: RESUME_OLD_MODEL, thinking: 'low', delegationPosition: 'sub' });
    const scope = ctx.get(ISessionContext).metaScope;
    const before = await documents.get<{ agents: Record<string, { model: string }> }>(scope, 'state.json');
    expect(before?.agents['main']?.model).toBe(RESUME_OLD_MODEL);
    if (method === 'setModel') await svc.setModel(RESUME_NEW_MODEL);
    else await commitResumeBinding(await svc.prepareResumeBinding({ modelAlias: RESUME_NEW_MODEL, allowModelChange: true, thinkingEffort: 'high' }));
    const after = await documents.get<{ agents: Record<string, unknown> }>(scope, 'state.json');
    expect(after?.agents['main']).toMatchObject({ model: RESUME_NEW_MODEL, displayName: 'kept-label', parentAgentId: 'parent', type: 'sub',
      thinkingEffort: svc.data().thinkingLevel });
  });

  it('setModel keeps the existing profile when one is already bound', async () => {
    const { profile: svc } = buildContext();

    await svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    await svc.setModel(MOCK_MODEL);

    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
  });

  it('setModel changes only the model of a route-only binding and keeps its route lock', async () => {
    ctx = createTestAgent({ initialConfig: { models: {
      'other-model': { provider: 'test-provider', model: 'other-model', maxContextSize: 1_000_000,
        capabilities: ['thinking'], supportEfforts: ['low', 'high'], defaultEffort: 'high' },
    } } }, hostEnvironmentServices(homeDir, hostPathClass));
    const svc = ctx.get(IAgentProfileService);
    const snapshot: ProfileBindingSnapshot = {
      routeId: 'route-only',
      modelAlias: MOCK_MODEL,
      lockedModelAlias: MOCK_MODEL,
      lockedThinkingEffort: 'high',
      thinkingLevel: 'high',
      executionRestriction: 'research-readonly',
      systemPrompt: 'route prompt snapshot',
      activeToolNames: ['Read'],
      toolAllowPolicies: [['Read']],
      disallowedTools: ['Write'],
      allowedSubagents: ['explore'],
      subagentLeases: { explore: { name: 'explore', modelAlias: MOCK_MODEL } },
      appliedLease: { name: 'explore', modelAlias: MOCK_MODEL },
      spawnPolicy: { allowedModels: [MOCK_MODEL] },
    };
    svc.applyBindingSnapshot(snapshot);
    expect(svc.data()).toMatchObject({
      profileName: undefined,
      routeId: 'route-only',
      modelAlias: MOCK_MODEL,
    });

    const before = svc.data();
    await svc.setModel('other-model');
    const after = svc.data();
    const serialized = (value: unknown): string => JSON.stringify(value) ?? 'undefined';
    const changedKeys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => serialized(before[key as keyof typeof before]) !== serialized(after[key as keyof typeof after]))
      .sort();

    expect(after.modelAlias).toBe('other-model');
    expect(changedKeys).toEqual(['modelAlias', 'modelCapabilities', 'routeDetached']);
    expect(after.bindingAdvisories).toEqual([]);
    expect(after).toMatchObject({
      profileName: undefined,
      routeId: 'route-only',
      routeDetached: true,
      lockedModelAlias: MOCK_MODEL,
      lockedThinkingEffort: 'high',
      executionRestriction: 'research-readonly',
      systemPrompt: 'route prompt snapshot',
      activeToolNames: ['Read'],
      disallowedTools: ['Write'],
      allowedSubagents: ['explore'],
      subagentLeases: { explore: { name: 'explore', modelAlias: MOCK_MODEL } },
      appliedLease: { name: 'explore', modelAlias: MOCK_MODEL },
      spawnPolicy: { allowedModels: [MOCK_MODEL] },
    });
    expect(after.toolAllowPolicies).toEqual([['Read'], RESEARCH_READONLY_TOOLS]);

    await expect(
      svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: 'other-model' }),
    ).rejects.toMatchObject({ code: 'agent_profile_route.switch_forbidden' });
    expect(svc.data()).toEqual(after);
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
      resolveSelection: ({ profile: name, route }) => {
        if (route !== undefined) throw new Error('routes are not configured');
        const profile = [first, second].find((candidate) => candidate.name === name);
        if (profile === undefined) throw new Error(`Unknown agent profile: "${name ?? ''}"`);
        return { profile, baseProfile: profile };
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
              defaultEffort: 'high',
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
              defaultEffort: 'high',
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
    const binding = await svc.prepareResumeBinding({});
    await commitResumeBinding(binding);
    expect(svc.data().thinkingLevel).toBe('off');
    await svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    expect(svc.data().thinkingLevel).toBe('on');
  });

  it('applies an explicit parent-notify resume override and preserves it when omitted', async () => {
    const svc = await bindNativeResumeProfile(resumeProfile({ allowParentNotify: true }));
    expect(svc.data().allowParentNotify).toBe(true);

    const disable = await prepareResumeBinding(svc, { allowParentNotify: false });
    expect(svc.data().allowParentNotify).toBe(true);
    await disable();
    expect(svc.data().allowParentNotify).toBe(false);

    const preserve = await prepareResumeBinding(svc, {});
    await preserve();
    expect(svc.data().allowParentNotify).toBe(false);
  });

  it('validates a native resume change without mutation and commits both values through one model-switch fact', async () => {
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

    await apply();

    expect(update).not.toHaveBeenCalled();
    expect(svc.data()).toMatchObject({ modelAlias: RESUME_NEW_MODEL, thinkingLevel: 'high' });
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

    await apply();

    expect(update).not.toHaveBeenCalled();
    const changed = svc.data();
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
    await apply();
    expect(update).not.toHaveBeenCalled();
    expect(svc.data()).toMatchObject({ modelAlias: RESUME_NEW_MODEL, thinkingLevel: 'high' });
  });

  it('accepts a canonical-equivalent native alias without model-change confirmation', async () => {
    const svc = await bindNativeResumeProfile(resumeProfile());
    const update = vi.spyOn(svc, 'update');
    const apply = await prepareResumeBinding(svc, { modelAlias: 'old-model' });

    expect(update).not.toHaveBeenCalled();
    await apply();

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
        `from "${RESUME_OLD_MODEL}" to "${RESUME_NEW_MODEL}".*allow_model_change.*new_window`,
      ),
    );
    await expect(svc.prepareResumeBinding({ modelAlias: RESUME_NEW_MODEL })).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID,
      details: { previousModel: RESUME_OLD_MODEL, requestedModel: RESUME_NEW_MODEL, requiredParameter: 'allow_model_change',
        confirmationChoices: [{ parameter: 'allow_model_change', value: true, mode: 'direct' }, { parameter: 'new_window', value: true, mode: 'fresh' }] } });
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

  it('keeps machine [subagent].deny_models hard for direct model changes', async () => {
    const options = nativeResumeOptions();
    ctx = createTestAgent(
      {
        initialConfig: {
          ...options.initialConfig,
          subagent: { denyModels: [RESUME_NEW_MODEL] },
        },
      },
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(resumeProfile())),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    const svc = ctx.get(IAgentProfileService);
    await svc.bind({ profile: 'resume-profile', model: RESUME_OLD_MODEL, thinking: 'low', delegationPosition: 'sub' });

    await expect(svc.setModel(RESUME_NEW_MODEL)).rejects.toThrow(/\[subagent\]\.deny_models/);
    expect(svc.data().modelAlias).toBe(RESUME_OLD_MODEL);
  });

  it('rechecks machine deny drift on an ordinary resume with no overrides', async () => {
    const svc = await bindNativeResumeProfile(resumeProfile());
    await ctx.get(IConfigService).set(
      'subagent',
      { denyModels: [RESUME_OLD_MODEL] },
      ConfigTarget.Memory,
    );

    await expect(prepareResumeBinding(svc, {})).rejects.toThrow(/\[subagent\]\.deny_models/);
    expect(svc.data().modelAlias).toBe(RESUME_OLD_MODEL);
  });

  it.each([
    { constraints: { allowedModels: [RESUME_OLD_MODEL] }, input: { modelAlias: RESUME_NEW_MODEL, allowModelChange: true }, field: 'allowed_models' },
    { constraints: { denyModels: [RESUME_NEW_MODEL] }, input: { modelAlias: RESUME_NEW_MODEL, allowModelChange: true }, field: 'deny_models' },
    { constraints: { allowedEfforts: ['low'] }, input: { thinkingEffort: 'high' }, field: 'allowed_efforts' },
  ])('rejects resume $field violations without modifying the saved binding', async ({ constraints, input, field }) => {
    const svc = await bindNativeResumeProfile(resumeProfile(constraints));
    const before = svc.data();
    await expect(prepareResumeBinding(svc, input)).rejects.toMatchObject({
      code: ErrorCodes.PROFILE_CONSTRAINT_VIOLATION,
      details: { strength: 'hard', ruleSource: `profile:resume-profile.${field}` },
    });
    expect(svc.data()).toEqual(before);
    await expect(prepareResumeBinding(svc, {})).resolves.toBeTypeOf('function');
  });

  it.each([
    { constraints: { allowedModels: [RESUME_OLD_MODEL] }, input: { modelAlias: RESUME_NEW_MODEL, allowModelChange: true } },
    { constraints: { denyModels: [RESUME_NEW_MODEL] }, input: { modelAlias: RESUME_NEW_MODEL, allowModelChange: true } },
    { constraints: { allowedEfforts: ['low'] }, input: { thinkingEffort: 'high' } },
  ])('rejects caller hard constraints at resume admission', async ({ constraints, input }) => {
    const svc = await bindNativeResumeProfile(resumeProfile());
    const before = svc.data();
    await expect(prepareResumeBinding(svc, { ...input, callerConstraints: [{ constraints, ruleSource: 'caller-lease:reviewer' }] }))
      .rejects.toMatchObject({ code: ErrorCodes.PROFILE_CONSTRAINT_VIOLATION, details: { ruleSource: expect.stringContaining('caller-lease:reviewer.') } });
    expect(svc.data()).toEqual(before);
  });

  it('continues soft resume deviations and exposes the source-located advisory', async () => {
    const svc = await bindNativeResumeProfile(resumeProfile({ preferredModels: [RESUME_OLD_MODEL], preferredEfforts: ['low'] }));
    const apply = await prepareResumeBinding(svc, { modelAlias: RESUME_NEW_MODEL, allowModelChange: true, thinkingEffort: 'high' });
    await apply();
    expect(svc.data()).toMatchObject({ modelAlias: RESUME_NEW_MODEL, thinkingLevel: 'high', bindingAdvisories: expect.arrayContaining([
      expect.objectContaining({ code: 'model_not_preferred', valueSource: 'dispatch-explicit' }),
      expect.objectContaining({ code: 'effort_not_preferred' }),
    ]) });
  });

  it('allows route pin deviations on resume and marks the binding detached', async () => {
    ctx = createTestAgent(
      nativeResumeOptions(),
      sessionService(ISessionAgentProfileCatalog, routedCatalog(RESUME_OLD_MODEL, 'low')),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    const svc = ctx.get(IAgentProfileService);
    await svc.bind({ route: 'reviewer.ui-k3', delegationPosition: 'sub' });

    const applyModel = await prepareResumeBinding(svc, {
      modelAlias: RESUME_NEW_MODEL,
      allowModelChange: true,
    });
    await applyModel();
    const applyEffort = await prepareResumeBinding(svc, { thinkingEffort: 'high' });
    await applyEffort();
    expect(svc.data()).toMatchObject({
      modelAlias: RESUME_NEW_MODEL,
      thinkingLevel: 'high',
      routeDetached: true,
    });
  });

  it.each([
    ['model', { modelAlias: 'external-new', allowModelChange: true }],
    ['effort', { thinkingEffort: 'high' }],
  ] as const)('updates external resume %s binding without resolving another executor', async (_, input) => {
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

    const apply = await prepareResumeBinding(svc, input);
    await apply();
    expect(resolveExecutable).not.toHaveBeenCalled();
    expect(svc.data()).toMatchObject({
      modelAlias: 'modelAlias' in input ? 'external-new' : 'external-old',
      thinkingLevel: 'thinkingEffort' in input ? 'high' : 'low',
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
    await apply();

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

  it('registers and executes read-only memory in a child main-profile binding with a frozen private view', async () => {
    const childScope = makeAgentScopeContext({ agentId: 'agent-tools', parentAgentId: 'main', agentScope: 'agents/agent-tools' });
    const query = vi.fn<IMemoryStore['query']>(async () => ({ items: [], mode: 'search', next_cursor: null, coverage: { scopes: [], statuses: ['active'], exhausted: true, complete: true, warnings: [] } }));
    const get = vi.fn<IMemoryStore['get']>(async () => undefined);
    const original = resumeProfile({ main: true });
    ctx = createTestAgent(
      { ...nativeResumeOptions(), cwd: homeDir, initialConfig: { ...nativeResumeOptions().initialConfig, memory: { enabled: true, approval: 'auto', workspaces: {} } } },
      agentService(IAgentScopeContext, childScope),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(original)),
      appServices((reg) => reg.definePartialInstance(IMemoryStore, { query, get })),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({ profile: original.name, delegationPosition: 'sub', memoryReadContext: { id: 'reader-persona', shared: [] } });
    await ctx.get(IAgentToolActivationService).activate();
    const registry = ctx.get(IAgentToolRegistryService);
    expect(registry.resolve('Read')).toBeDefined();
    expect(registry.resolve('MemorySearch')).toBeDefined();
    expect(registry.resolve('MemoryRead')).toBeDefined();
    for (const name of ['MemoryWrite', 'ThreadList', 'ThreadRead', 'ThreadWait', 'ThreadCreate', 'ThreadSend', 'AskUserQuestion', 'Cron', 'EnterPlanMode']) expect(registry.resolve(name)).toBeUndefined();
    const results: ToolExecutionResult[] = [];
    for await (const result of ctx.get(IAgentToolExecutorService).execute([
      { id: 'search', type: 'function', name: 'MemorySearch', arguments: JSON.stringify({ query: 'private guidance' }) },
      { id: 'read', type: 'function', name: 'MemoryRead', arguments: JSON.stringify({ id: 'm_private' }) },
    ], { signal: new AbortController().signal, turnId: 1 })) results.push(result);
    expect(results.map((result) => result.result.isError === true)).toEqual([false, false]);
    expect(query.mock.calls[0]?.[0]).toEqual([{ kind: 'persona', personaId: 'reader-persona' }, { kind: 'persona_workspace', personaId: 'reader-persona', workspaceId: 'test-workspace' }]);
    expect(get.mock.calls.map((call) => call[0])).toEqual([{ kind: 'persona', personaId: 'reader-persona' }, { kind: 'persona_workspace', personaId: 'reader-persona', workspaceId: 'test-workspace' }]);
    expect(profile.data().personaId).toBeUndefined();
    expect(await ctx.get(IAgentMemorySnapshot).get()).toBe('');
  });

  it.each(['profile', 'dispatch'] as const)('makes browser and computer opt-in usable through %s selection and revocable on resume', async (selection) => {
    const names = ['*', 'BrowserConnections', 'BrowserTabs', 'browser__*', 'mcp__kiki-computer__*'];
    const original = resumeProfile({
      tools: selection === 'profile' ? names : ['Read'],
      toolsSource: selection === 'profile' ? 'declared' : undefined,
    });
    ctx = createTestAgent({ ...nativeResumeOptions(), autoConfigure: false, cwd: homeDir },
      agentService(IAgentScopeContext, makeAgentScopeContext({ agentId: 'agent-tools', parentAgentId: 'main', agentScope: 'agents/agent-tools' })),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(original)), hostEnvironmentServices(homeDir, hostPathClass));
    await ctx.get(ISessionMetadata).registerAgent('agent-tools', { type: 'sub', parentAgentId: 'main' });
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({ profile: original.name, delegationPosition: 'sub', toolOverride: selection === 'dispatch' ? { tools: names } : undefined });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    await ctx.get(IAgentToolActivationService).activate();
    const registry = ctx.get(IAgentToolRegistryService);
    expect(registry.resolve('BrowserConnections')).toBeDefined();
    expect(registry.resolve('BrowserTabs')).toBeDefined();
    const browser = new PolicyProbeTool('browser__codex_browser_js', 'builtin');
    const computer = new PolicyProbeTool('mcp__kiki-computer__click', 'mcp');
    registry.register(browser, { source: 'builtin' });
    registry.register(Object.assign(computer, { subagentDefault: 'opt-in' as const }), { source: 'mcp' });
    await ctx.get(IAgentLoopService).hooks.onWillBeginStep.run({ turnId: 1, step: 1, firstStepOfTurn: true, signal: new AbortController().signal });
    for (const tool of [browser, computer]) {
      expect(ctx.get(IAgentToolPolicyService).isToolActive(tool.name, tool.source)).toBe(true);
      expect((await executeDirectToolCall(ctx, tool.name)).isError).not.toBe(true);
      expect(tool.calls).toBe(1);
    }
    await commitResumeBinding(await profile.prepareResumeBinding({ toolOverride: { tools: [] } }));
    await ctx.get(IAgentLoopService).hooks.onWillBeginStep.run({ turnId: 2, step: 1, firstStepOfTurn: true, signal: new AbortController().signal });
    for (const tool of [browser, computer]) {
      expect(ctx.get(IAgentToolPolicyService).isToolActive(tool.name, tool.source)).toBe(false);
      const results: ToolExecutionResult[] = [];
      for await (const result of ctx.get(IAgentToolExecutorService).execute([{ type: 'function', id: `revoked_${tool.name}`, name: tool.name, arguments: '{}' }], { signal: new AbortController().signal, turnId: 2 })) results.push(result);
      expect(results[0]?.result).toMatchObject({ isError: true, output: `Tool "${tool.name}" is disabled by the active tool policy` });
      expect(tool.calls).toBe(1);
    }
  });

  it('replaces child tool defaults, commits resume overrides, withdraws stale tools and restores the saved layers', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const original = resumeProfile({ main: true, tools: ['Read'], disallowedTools: ['Write'] });
    const childScope = makeAgentScopeContext({ agentId: 'agent-tools', parentAgentId: 'main', agentScope: 'agents/agent-tools' });
    const readThread = vi.fn(async () => ({ thread: { hostId: 'local', workspaceId: 'workspace-1', sessionId: 'peer' }, turns: [] }));
    const build = () => createTestAgent(
      { ...nativeResumeOptions(), persistence, autoConfigure: false, cwd: homeDir, initialConfig: { ...nativeResumeOptions().initialConfig, threadCommunication: { enabled: true } } },
      agentService(IAgentScopeContext, childScope),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(original)),
      appServices((reg) => reg.definePartialInstance(IThreadCommunicationService, { hostId: 'local', isWorkspaceEnabled: async () => true, readThread })),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    ctx = build();
    const profile = ctx.get(IAgentProfileService);
    await ctx.get(ISessionMetadata).registerAgent('agent-tools', { type: 'sub', parentAgentId: 'main' });
    await profile.bind({ profile: original.name, delegationPosition: 'sub', toolOverride: { tools: ['*', 'ThreadRead'], disallowedTools: ['Bash'] }, memoryReadContext: { id: 'reader-persona', shared: [] } });
    await ctx.get(IAgentToolActivationService).activate();
    const registry = ctx.get(IAgentToolRegistryService);
    expect(registry.resolve('Grep')).toBeDefined();
    expect(registry.resolve('ThreadRead')).toBeDefined();
    expect(registry.resolve('ThreadList')).toBeUndefined();
    expect(registry.resolve('ThreadSend')).toBeUndefined();
    expect(registry.resolve('Write')).toBeUndefined();
    expect(registry.resolve('Bash')).toBeUndefined();
    const result: ToolExecutionResult[] = [];
    for await (const value of ctx.get(IAgentToolExecutorService).execute([{ id: 'peer-read', type: 'function', name: 'ThreadRead', arguments: JSON.stringify({ thread: { workspace_id: 'workspace-1', session_id: 'peer' } }) }], { signal: new AbortController().signal, turnId: 1 })) result.push(value);
    expect(result[0]?.result.isError).not.toBe(true);
    expect(readThread).toHaveBeenCalledWith(expect.objectContaining({ caller: { hostId: 'local', workspaceId: 'test-workspace', sessionId: 'test-session', agentId: 'agent-tools' } }));
    await commitResumeBinding(await profile.prepareResumeBinding({ toolOverride: { tools: [], disallowedTools: [] } }));
    expect(profile.data().activeToolNames).toEqual([]);
    expect(profile.data().disallowedTools).toEqual(['Write']);
    expect(registry.resolve('ThreadRead')).toBeUndefined();
    expect(ctx.get(IAgentToolPolicyService).isToolActive('ThreadRead')).toBe(false);
    await commitResumeBinding(await profile.prepareResumeBinding({}));
    expect(profile.data().toolOverride).toEqual({ tools: [], disallowedTools: [] });
    await ctx.get(IWireService).flush();
    const projected = await readPersistedAgentProfileSnapshot({
      storage: { size: async () => persistence.records.length, mtime: async () => 1 } as unknown as IFileSystemStorageService,
      appendLog: { read: async function* () { yield* persistence.records; } } as unknown as IAppendLogStore,
    }, 'test-workspace', 'test-session', 'agent-tools', undefined);
    expect(projected).toMatchObject({ activeToolNames: [], disallowedTools: ['Write'], toolOverride: { tools: [], disallowedTools: [] }, memoryReadContext: { id: 'reader-persona', shared: [] } });
    await ctx.dispose();
    ctx = build();
    await ctx.restorePersisted();
    await ctx.get(IAgentToolActivationService).activate();
    const restored = ctx.get(IAgentProfileService);
    expect(restored.data().toolOverride).toEqual({ tools: [], disallowedTools: [] });
    expect(restored.data().disallowedTools).toEqual(['Write']);
    expect(ctx.get(IAgentToolRegistryService).resolve('ThreadRead')).toBeUndefined();
    expect(ctx.get(IAgentMemorySnapshot).getPersona()).toEqual({ id: 'reader-persona', shared: [] });
    await ctx.get(ISessionMetadata).registerAgent('agent-tools', { type: 'sub', parentAgentId: 'main' });
    await commitResumeBinding(await restored.prepareResumeBinding({ toolOverride: { tools: ['*', 'ThreadRead'] } }));
    expect(ctx.get(IAgentToolRegistryService).resolve('ThreadRead')).toBeDefined();
    expect(ctx.get(IAgentToolPolicyService).isToolActive('Write')).toBe(false);
  });

  it('refreshes the child Skill prompt projection when a same-model resume replaces tools', async () => {
    const original = normalizeAgentProfile({ name: 'resume-profile', modelAlias: RESUME_OLD_MODEL, tools: ['Read'], systemPrompt: (context) => `skill-active:${String(context.skillActive)}` });
    ctx = createTestAgent(
      { ...nativeResumeOptions(), cwd: homeDir },
      agentService(IAgentScopeContext, makeAgentScopeContext({ agentId: 'agent-tools', parentAgentId: 'main', agentScope: 'agents/agent-tools' })),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(original)),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    const profile = ctx.get(IAgentProfileService);
    await ctx.get(ISessionMetadata).registerAgent('agent-tools', { type: 'sub', parentAgentId: 'main' });
    await profile.bind({ profile: original.name, delegationPosition: 'sub', toolOverride: { tools: ['*'] } });
    expect(profile.data().systemPrompt).toContain('skill-active:true');
    await commitResumeBinding(await profile.prepareResumeBinding({ toolOverride: { tools: [] } }));
    expect(profile.data().systemPrompt).toContain('skill-active:false');
    await commitResumeBinding(await profile.prepareResumeBinding({ toolOverride: { tools: ['*'] } }));
    expect(profile.data().systemPrompt).toContain('skill-active:true');
  });

  it('activates child CronList without granting create or delete actions through the Cron wrapper', async () => {
    const original = resumeProfile();
    ctx = createTestAgent(
      { ...nativeResumeOptions(), cwd: homeDir },
      agentService(IAgentScopeContext, makeAgentScopeContext({ agentId: 'agent-tools', parentAgentId: 'main', agentScope: 'agents/agent-tools' })),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(original)),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    await ctx.get(IAgentProfileService).bind({ profile: original.name, delegationPosition: 'sub', toolOverride: { tools: ['*', 'CronList'] } });
    await ctx.get(IAgentToolActivationService).activate();
    const registry = ctx.get(IAgentToolRegistryService);
    expect(registry.resolve('Cron')).toBeDefined();
    expect(registry.resolve('CronList')).toBeDefined();
    expect(registry.resolve('CronCreate')).toBeUndefined();
    expect(registry.resolve('CronDelete')).toBeUndefined();
    const results: ToolExecutionResult[] = [];
    for await (const result of ctx.get(IAgentToolExecutorService).execute([
      { id: 'list', type: 'function', name: 'Cron', arguments: JSON.stringify({ action: 'list' }) },
      { id: 'create', type: 'function', name: 'Cron', arguments: JSON.stringify({ action: 'create', cron: '* * * * *', prompt: 'must not schedule' }) },
    ], { signal: new AbortController().signal, turnId: 1 })) results.push(result);
    const listed = results.find((result) => result.toolCallId === 'list')?.result;
    expect(listed?.isError).not.toBe(true);
    expect(listed?.output).toContain('cron_jobs: 0');
    expect(results.find((result) => result.toolCallId === 'create')?.result).toMatchObject({ isError: true, output: expect.stringContaining('Cron action create is disabled') });
  });

  it('keeps true selection ceilings and inherited read-only restrictions after child plan exit', async () => {
    const original = resumeProfile({ tools: ['Read'], toolAllowPolicies: [['Read']] });
    ctx = createTestAgent(
      { ...nativeResumeOptions(), cwd: homeDir },
      agentService(IAgentScopeContext, makeAgentScopeContext({ agentId: 'agent-tools', parentAgentId: 'main', agentScope: 'agents/agent-tools' })),
      sessionService(ISessionAgentProfileCatalog, singleProfileCatalog(original)),
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    await ctx.get(IAgentProfileService).bind({ profile: original.name, delegationPosition: 'sub', executionRestriction: 'research-readonly', toolOverride: { tools: ['*', 'ThreadRead', 'Write'] } });
    const plan = ctx.get(IAgentPlanService);
    await plan.enter('child-plan');
    expect((await plan.status())?.path).toContain('/agents/agent-tools/plans/child-plan.md');
    plan.exit();
    expect(ctx.get(IAgentProfileService).data().executionRestriction).toBe('research-readonly');
    expect(ctx.get(IAgentToolPolicyService).isToolActive('Read')).toBe(true);
    expect(ctx.get(IAgentToolPolicyService).isToolActive('Write')).toBe(false);
    expect(ctx.get(IAgentToolPolicyService).isToolActive('ThreadRead')).toBe(false);
    await ctx.get(IAgentToolActivationService).activate();
    expect(ctx.get(IAgentToolRegistryService).resolve('Write')).toBeUndefined();
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
      const savedPromptBase = initial.data().boundProfile?.promptBase?.text;
      expect(savedPromptBase).toBeTruthy();
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
        { ...nativeResumeOptions(), persistence, autoConfigure: false },
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
      if (catalogState === 'missing') {
        await restored.rebuildPromptContext();
        expect(restored.data().profileName).toBe(original.name);
        expect(restored.getSystemPrompt()).toContain(savedPromptBase!);
        expect(restored.getSystemPrompt()).not.toContain('missing profile catalog');
      }
      const apply = await prepareResumeBinding(restored, {
        modelAlias: RESUME_NEW_MODEL,
        thinkingEffort: 'high',
        allowModelChange: true,
      });
      await apply();
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
    registerAgentProfile({
      name: 'deny-group',
      disabledToolGroups: ['shell'],
      systemPrompt: () => 'deny group test',
    });
    registerAgentProfile({
      name: 'group-overridden-by-tools',
      tools: ['Bash', 'Read'],
      disabledToolGroups: ['shell'],
      systemPrompt: () => 'deny group test',
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

  it('blocks every builtin tool in a disabled group', async () => {
    const svc = await bindProfile('deny-group');
    expect(svc.isToolActive('Bash')).toBe(false);
    expect(svc.isToolActive('Read')).toBe(true);
  });

  it('lets an explicit tools entry survive a disabled group', async () => {
    const svc = await bindProfile('group-overridden-by-tools');
    expect(svc.isToolActive('Bash')).toBe(true);
    expect(svc.isToolActive('Read')).toBe(true);
  });

  it('persists disabled tool groups in the bind records', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent({ persistence }, hostEnvironmentServices(homeDir, hostPathClass));

    await ctx.get(IAgentProfileService).bind({ profile: 'deny-group', model: MOCK_MODEL });
    await ctx.get(IWireService).flush();

    const record = persistence.records.find((candidate) => candidate.type === 'profile.bind');
    expect(record).toMatchObject({ profileName: 'deny-group', disabledToolGroups: ['shell'] });
    expect(ctx.get(IAgentProfileService).data().disabledToolGroups).toEqual(['shell']);
  });

  it('lists available profiles when binding an unknown profile', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir, hostPathClass));
    await expect(
      ctx.get(IAgentProfileService).bind({ profile: 'does-not-exist', model: MOCK_MODEL }),
    ).rejects.toThrow(/Unknown agent profile: "does-not-exist"\. Available agent profiles: .*agent/);
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

  it('warns about inert global entries but accepts the universal enabled pattern', async () => {
    ctx = createTestAgent(
      { initialConfig: { tools: { enabled: ['*', 'Bashh', 'mcp__github'], disabled: ['*'] } } },
      hostEnvironmentServices(homeDir, hostPathClass),
    );
    await ctx.get(IAgentProfileService).bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    const messages = toolPatternWarnings().map((warning) => warning.message ?? '');
    expect(messages).toEqual([
      expect.stringMatching(/"Bashh".*enabled.*does not match any registered or built-in tool/),
      expect.stringMatching(/"mcp__github".*enabled.*mcp__github__\*/),
      expect.stringMatching(/"\*".*disabled/),
    ]);
  });

  it('stays silent for the default profile and an empty [tools] config', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir, hostPathClass));
    await ctx.get(IAgentProfileService).bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    expect(toolPatternWarnings()).toEqual([]);
  });

  it('restores a profile whose plugin tools are no longer registered and still rejects patterns that can never match', async () => {
    registerAgentProfile({
      name: 'restore-plugin-tools',
      tools: ['Read', 'plugin__alpha_kit__AlphaPing', 'plugin__beta_kit__BetaPing'],
      systemPrompt: () => 'restore two plugin tools',
    });
    registerAgentProfile({
      name: 'restore-still-strict',
      tools: ['Bash*'],
      disallowedTools: ['mcp__github'],
      systemPrompt: () => 'restore stays strict',
    });
    ctx = createTestAgent(hostEnvironmentServices(homeDir, hostPathClass));
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({
      profile: 'restore-plugin-tools',
      model: MOCK_MODEL,
      unavailableTools: 'restore',
    });
    const restored = (ctx.newEvents() as readonly { event: string; args?: { code?: string; message?: string } }[])
      .filter((entry) => entry.event === 'warning' && entry.args?.code === 'restore-tool-unavailable')
      .map((entry) => entry.args?.message ?? '');
    expect(restored).toEqual([
      expect.stringMatching(/plugin__alpha_kit__AlphaPing/),
      expect.stringMatching(/plugin__beta_kit__BetaPing/),
    ]);
    expect(profile.data().activeToolNames).toEqual(['Read', 'plugin__alpha_kit__AlphaPing', 'plugin__beta_kit__BetaPing']);
    await expect(profile.bind({
      profile: 'restore-still-strict',
      model: MOCK_MODEL,
      unavailableTools: 'restore',
    })).rejects.toThrow(/Bash\*[\s\S]*mcp__github/);
    await expect(profile.bind({ profile: 'restore-plugin-tools', model: MOCK_MODEL })).rejects.toThrow(
      /plugin__alpha_kit__AlphaPing[\s\S]*plugin__beta_kit__BetaPing/,
    );
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
