import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { LifecycleScope } from '#/app/scopes';
import { type IAgentScopeHandle } from '#/_base/di/scope';
import { Event, type Event as KimiEvent } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { toInputJsonSchema } from '#/tool/input-schema';
import { userCancellationReason } from '#/_base/utils/abort';
import { createHooks } from '#/hooks';
import type { ToolCall } from '#/kosong/contract/message';
import type { TokenUsage } from '#/kosong/contract/usage';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { makeHookRunner } from '../features/externalHooks/runner-stub';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ToolAccesses, type ExecutableTool } from '#/tool/toolContract';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentUserToolService, type UserToolRegistration } from '#/agent/userTool/userTool';
import {
  SubagentToolInputSchema,
  type SubagentToolInput,
} from '#/agent/tools/agent/agent';
import { DEFAULT_SUBAGENT_TIMEOUT_MS, SUBAGENT_SECTION } from '#/session/subagent/configSection';
import { Error2, ErrorCodes } from '#/errors';
import { runAgentTurn } from '#/session/subagent/runAgentTurn';
import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionDispatchService } from '#/session/dispatch/dispatch';
import {
  COLLABORATION_AGENT_TYPE_LABEL,
  COLLABORATION_TASK_NAME_LABEL,
} from '#/session/agentCollaboration/registry';
import {
  type AgentRunHandle,
  type AgentRunRequest,
  type AgentTaskStopHookContext,
  ISessionSubagentService,
  type RunAgentOptions,
} from '#/session/subagent/subagent';
import { IEventBus } from '#/app/event/eventBus';
import type { Event2 } from '#/app/event/event2';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { normalizeAgentProfile, type AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';
import { IWireService } from '#/wire/wire';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { createFakeProcessRunner } from '../tools/fixtures/fake-exec';
import { StubConfigService } from '../kosong/stubs';
import { stubFlag } from '../app/flag/stubs';
import {
  agentService,
  appService,
  configServices,
  createCommandRunner,
  createTestAgent,
  execEnvServices,
  externalHookServices,
  homeDirServices,
  modelProviderServices,
  sessionService,
  type TestAgentContext,
  type TestAgentOptions,
  type TestAgentServiceOverride,
} from '../harness';
import { executeTool } from '../tools/fixtures/execute-tool';

const signal = new AbortController().signal;

function agentSchemaProperties<T = unknown>(): Record<string, T> {
  return (
    toInputJsonSchema(SubagentToolInputSchema) as { properties: Record<string, T> }
  ).properties;
}

const POOL_MODEL_ENTRIES = {
  'provider/fast': { provider: 'test-provider', model: 'fast-model', maxContextSize: 262_144 },
  'provider/smart': { provider: 'test-provider', model: 'smart-model', maxContextSize: 262_144 },
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface CapturedLogEntry {
  readonly level: 'error' | 'warn' | 'info' | 'debug';
  readonly message: string;
  readonly payload: unknown;
}

function captureLogs(): {
  readonly entries: CapturedLogEntry[];
  readonly logger: ILogService;
} {
  const entries: CapturedLogEntry[] = [];
  const capture =
    (level: CapturedLogEntry['level']) => (message: string, payload?: unknown) => {
      entries.push({ level, message, payload });
    };
  let logger: ILogService;
  logger = {
    _serviceBrand: undefined,
    level: 'off',
    setLevel: () => {},
    flush: async () => {},
    info: capture('info'),
    warn: capture('warn'),
    error: capture('error'),
    debug: capture('debug'),
    child: () => logger,
  };
  return { entries, logger };
}

function hookSlot<T>() {
  return {
    run: vi.fn(async (_input: T) => {}),
    register: () => ({ dispose: () => {} }),
    delete: () => false,
  };
}

function noopDisposable() {
  return { dispose: () => {} };
}

function modelCatalogResolving(...aliases: readonly string[]): IModelCatalog {
  return {
    _serviceBrand: undefined,
    get: (alias: string) => {
      if (!aliases.includes(alias)) {
        throw new Error2(
          ErrorCodes.CONFIG_INVALID,
          `Model "${alias}" is not configured in config.toml.`,
          { details: { model: alias } },
        );
      }
      return { id: alias, capabilities: UNKNOWN_CAPABILITY } as Model;
    },
    getRequester: (alias: string) => ({
      model: { id: alias, capabilities: UNKNOWN_CAPABILITY } as Model,
      request: async function* () {},
    }),
    notifyConfigChanged: () => {},
  } as unknown as IModelCatalog;
}

interface AgentLifecycleStubOptions {
  readonly createAgentIds?: readonly string[];
  readonly runCompletion?: (
    agentId: string,
    request: AgentRunRequest,
    options: RunAgentOptions,
  ) => Promise<{ readonly summary: string; readonly usage?: TokenUsage }>;
  readonly createError?: Error;
  readonly handleServices?: ReadonlyMap<string, ReadonlyMap<unknown, unknown>>;
}

interface AgentLifecycleStub extends IAgentLifecycleService, ISessionSubagentService {
  readonly create: ReturnType<typeof vi.fn<IAgentLifecycleService['create']>>;
  readonly run: ReturnType<typeof vi.fn<ISessionSubagentService['run']>>;
  readonly get: ReturnType<typeof vi.fn<IAgentLifecycleService['get']>>;
  readonly publishedEvents: Event2[];
  addHandle(
    agentId: string,
    profileName: string,
    services?: ReadonlyMap<unknown, unknown>,
  ): void;
}

function createAgentLifecycleStub(options: AgentLifecycleStubOptions = {}): AgentLifecycleStub {
  let lifecycle: AgentLifecycleStub;
  let created = 0;
  const stateByAgentId = new Map<string, AgentStateService>();
  const profileByAgentId = new Map<
    string,
    {
      readonly profileName: string;
      readonly modelAlias?: string;
      readonly thinkingLevel: string;
      readonly allowParentNotify?: boolean;
    }
  >();
  const handles = new Map<string, IAgentScopeHandle>();
  const servicesByAgentId = new Map(options.handleServices);
  const publishedEvents: Event2[] = [];
  const handle = (agentId: string): IAgentScopeHandle => ({
    id: agentId,
    kind: LifecycleScope.Agent,
    accessor: {
      get: (serviceId) => {
        const service = servicesByAgentId.get(agentId)?.get(serviceId);
        if (service !== undefined) return service as never;
        if (serviceId === IAgentLifecycleService) return lifecycle as never;
        if (serviceId === ISessionSubagentService) return lifecycle as never;
        if (serviceId === IAgentContextInjectorService) {
          return {
            _serviceBrand: undefined,
            register: () => ({ dispose: () => {} }),
          } as never;
        }
        if (serviceId === IAgentContextMemoryService) {
          return {
            _serviceBrand: undefined,
            get: () => [],
          } as never;
        }
        if (serviceId === IAgentProfileService) {
          return {
            _serviceBrand: undefined,
            data: () => profileByAgentId.get(agentId),
            update: () => {},
            prepareResumeBinding: async () => () => {},
            republishStatus: () => {},
            getEffectiveThinkingLevel: () => profileByAgentId.get(agentId)?.thinkingLevel ?? 'off',
            isToolActive: () => false,
          } as never;
        }
        if (serviceId === IAgentToolPolicyService) {
          return {
            _serviceBrand: undefined,
            isToolActive: () => profileByAgentId.get(agentId)?.allowParentNotify !== false,
          } as never;
        }
        if (serviceId === IAgentExecutionService) {
          return {
            _serviceBrand: undefined,
            run: lifecycle.run,
            status: () => ({ state: 'idle' }),
            cancel: () => false,
            settled: () => Promise.resolve(),
            shutdown: () => Promise.resolve(),
            hooks: createHooks(['onWillRun']),
          } as never;
        }
        if (serviceId === IAgentLoopService) {
          return {
            _serviceBrand: undefined,
            status: () => ({ state: 'idle', pendingTurnIds: [], hasPendingRequests: false }),
            hooks: {
              onWillBeginStep: { register: () => ({ dispose: () => {} }) },
              onDidFinishStep: { register: () => ({ dispose: () => {} }) },
            },
          } as never;
        }
        if (serviceId === IAgentPermissionModeService) {
          return {
            _serviceBrand: undefined,
            mode: 'manual',
            setMode: () => {},
            onDidChangeMode: Event.None,
          } as never;
        }
        if (serviceId === IAgentToolRegistryService) {
          return {
            _serviceBrand: undefined,
            register: () => ({ dispose: () => {} }),
          } as never;
        }
        if (serviceId === IAgentUserToolService) {
          return {
            _serviceBrand: undefined,
            list: () => [],
            inheritUserTools: () => {},
            register: () => {},
            unregister: () => {},
          } as never;
        }
        if (serviceId === IEventBus) {
          return {
            _serviceBrand: undefined,
            publish: (event: Event2) => {
              publishedEvents.push(event);
            },
            subscribe: () => noopDisposable(),
          } as never;
        }
        if (serviceId === IWireService) {
          return {
            _serviceBrand: undefined,
            hooks: createHooks(['onDidRestore']),
            dispatch: () => {},
            replay: async () => {},
            flush: async () => {},
            getModel: () => [],
            subscribe: () => noopDisposable(),
            onEmission: () => noopDisposable(),
          } as never;
        }
        if (serviceId === IEventDispatcher) {
          return {
            _serviceBrand: undefined,
            hooks: createHooks(['onDidRestore']),
            dispatch: (event: Event2) => {
              publishedEvents.push(event);
              return Promise.resolve();
            },
            history: () => [],
            checkpointDepth: () => 0,
            undo: () => {},
            restore: () => Promise.resolve(),
            flush: () => Promise.resolve(),
          } as never;
        }
        if (serviceId === IAgentStateService) {
          let state = stateByAgentId.get(agentId);
          if (state === undefined) {
            state = new AgentStateService();
            stateByAgentId.set(agentId, state);
          }
          return state as never;
        }
        return undefined as never;
      },
    },
    dispose: () => {},
  });
  lifecycle = {
    _serviceBrand: undefined,
    hooks: {
      onWillStartAgentTask: hookSlot(),
    },
    onDidStopAgentTask: Event.None as KimiEvent<AgentTaskStopHookContext>,
    onWillCreate: Event.None as KimiEvent<IAgentScopeHandle>,
    onDidCreate: Event.None as KimiEvent<IAgentScopeHandle>,
    onDidDispose: Event.None as KimiEvent<string>,
    create: vi.fn(async (input = {}) => {
      if (options.createError !== undefined) throw options.createError;
      const agentId =
        input.agentId ??
        options.createAgentIds?.[created] ??
        `agent-child-${String(created + 1)}`;
      created += 1;
      const profileName = input.binding?.profile ?? 'coder';
      profileByAgentId.set(agentId, {
        profileName,
        modelAlias: input.binding?.model,
        thinkingLevel: input.binding?.thinking ?? 'off',
        allowParentNotify: input.binding?.allowParentNotify,
      });
      const createdHandle = handle(agentId);
      handles.set(agentId, createdHandle);
      return createdHandle;
    }),
    commitCreate: () => {},
    discard: async (agentId: string) => {
      handles.get(agentId)?.dispose();
      handles.delete(agentId);
      stateByAgentId.delete(agentId);
      profileByAgentId.delete(agentId);
      servicesByAgentId.delete(agentId);
    },
    notifyAgentTaskStopped: vi.fn(),
    trackPromptRun: (_agentId, _completion, signal) => signal,
    fork: vi.fn(async () => {
      throw new Error('unexpected fork');
    }),
    run: vi.fn(async (agentId, request, runOptions): Promise<AgentRunHandle> => {
      const completion =
        options.runCompletion?.(agentId, request, runOptions) ??
        Promise.resolve({ summary: 'child result' });
      return {
        agentId,
        turn: {} as AgentRunHandle['turn'],
        completion,
      };
    }),
    get: vi.fn((agentId) => handles.get(agentId)),
    list: vi.fn(() => [...handles.values()]),
    broadcastPermissionMode: vi.fn(),
    countPendingBackgroundTasks: () => {
      throw new Error('IAgentLifecycleService.countPendingBackgroundTasks is not supported in the tool test');
    },
    drainBackgroundTasks: async () => {
      throw new Error('IAgentLifecycleService.drainBackgroundTasks is not supported in the tool test');
    },
    remove: vi.fn(async (agentId) => {
      handles.delete(agentId);
    }),
    addHandle: (agentId, profileName, services) => {
      profileByAgentId.set(agentId, { profileName, thinkingLevel: 'off' });
      if (services !== undefined) servicesByAgentId.set(agentId, services);
      handles.set(agentId, handle(agentId));
    },
    publishedEvents,
  };
  return lifecycle;
}

function agentTool(ctx: TestAgentContext): ExecutableTool<SubagentToolInput> {
  const tool = ctx.get(IAgentToolRegistryService).resolve('AgentRun');
  expect(tool).toBeDefined();
  return tool! as ExecutableTool<SubagentToolInput>;
}

function executeAgentToolRaw(
  ctx: TestAgentContext,
  args: SubagentToolInput,
  inputSignal: AbortSignal = signal,
) {
  return executeTool(agentTool(ctx), {
    turnId: 0,
    toolCallId: 'call_agent',
    args,
    signal: inputSignal,
  });
}

function executeAgentTool(
  ctx: TestAgentContext,
  args: SubagentToolInput,
  inputSignal: AbortSignal = signal,
) {
  const needsModel =
    args.resume === undefined && args.model_alias === undefined;
  return executeAgentToolRaw(
    ctx,
    needsModel ? { ...args, model_alias: 'mock-model' } : args,
    inputSignal,
  );
}

function currentAgentHandle(ctx: TestAgentContext, agentId: string): IAgentScopeHandle {
  return {
    id: agentId,
    kind: LifecycleScope.Agent,
    accessor: {
      get: ((serviceId: unknown) =>
        ctx.get(serviceId as never)) as IAgentScopeHandle['accessor']['get'],
    },
    dispose: () => {},
  };
}

const cronStub = {
  _serviceBrand: undefined,
  list: () => [],
} as unknown as ISessionCronService;

function sessionMetadataStub(agents: Readonly<Record<string, AgentMeta>>): ISessionMetadata {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeMetadata: Event.None as ISessionMetadata['onDidChangeMetadata'],
    read: async () => ({
      id: 'test-session',
      createdAt: 0,
      updatedAt: 0,
      archived: false,
      agents,
    }),
    usage: () => undefined,
    recordUsage: () => {},
    update: async () => {},
    setTitle: async () => {},
    setGeneratedTitleIfUncustomized: async () => false,
    setArchived: async () => {},
    registerAgent: async () => {},
  };
}

function subagentMeta(parentAgentId = 'main'): AgentMeta {
  return {
    labels: { parentAgentId },
  };
}

function namedSubagentMeta(name: string, parentAgentId = 'main'): AgentMeta {
  return {
    labels: {
      parentAgentId,
      [COLLABORATION_TASK_NAME_LABEL]: name,
      [COLLABORATION_AGENT_TYPE_LABEL]: 'explore',
    },
  };
}

describe('SubagentToolInputSchema', () => {
  it('accepts the background parameter', () => {
    const parsed = SubagentToolInputSchema.parse({
      prompt: 'Investigate',
      description: 'Find cause',
      profile: 'explore',
      background: true,
    });

    expect(parsed).toMatchObject({
      prompt: 'Investigate',
      description: 'Find cause',
      profile: 'explore',
      background: true,
    });
  });

  it('exposes background and not runInBackground in the JSON schema', () => {
    const properties = agentSchemaProperties();

    expect(properties).toHaveProperty('background');
    expect(properties).not.toHaveProperty('runInBackground');
    expect(properties).not.toHaveProperty('run_in_background');
  });

  it('describes background notification without requiring root to keep its turn open', () => {
    const properties = agentSchemaProperties<{ description?: string }>();
    expect(properties['background']?.description).toContain('automatic completion notification');
    expect(properties['background']?.description).toContain('root) can end its turn');
    expect(properties['background']?.description).toContain('synchronously in the same turn');
    expect(properties['background']?.description).not.toContain('Prefer false');
  });

  it('does not expose the timeout parameter in the JSON schema', () => {
    const properties = agentSchemaProperties();

    expect(properties).not.toHaveProperty('timeout');
  });

  it('offers model_alias, effort, routes, profile files, and parent-notify overrides without a symbolic model parameter', () => {
    const properties = agentSchemaProperties<{ description?: string; type?: string; enum?: string[] }>();

    expect(properties).not.toHaveProperty('model');
    expect(properties['model_alias']?.type).toBe('string');
    expect(properties['model_alias']?.enum).toBeUndefined();
    expect(properties).toHaveProperty('effort');
    expect(properties).toHaveProperty('route');
    expect(properties).toHaveProperty('profile_file');
    expect(properties).toHaveProperty('allow_model_change');
    expect(properties['allow_parent_notify']?.type).toBe('boolean');
    expect(properties['allow_parent_notify']?.description).toContain('defaults to enabled');
    expect(properties['allow_parent_notify']?.description).toContain('preserves the saved setting');
  });

  it('leaves the profile unset when no profile selector is supplied', () => {
    expect(
      SubagentToolInputSchema.parse({
        prompt: 'Investigate',
        description: 'Find cause',
      }).profile,
    ).toBeUndefined();
    expect(
      SubagentToolInputSchema.parse({
        prompt: 'Investigate',
        description: 'Find cause',
        profile: '',
      }).profile,
    ).toBeUndefined();
    expect(
      SubagentToolInputSchema.parse({
        prompt: 'Continue',
        description: 'Continue work',
        resume: 'agent-existing',
      }).profile,
    ).toBeUndefined();
    expect(
      SubagentToolInputSchema.parse({
        prompt: 'Follow the role file',
        description: 'Use role file',
        profile_file: 'profiles/explore.md',
      }).profile,
    ).toBeUndefined();
    expect(
      SubagentToolInputSchema.parse({
        prompt: 'Follow the route',
        description: 'Use route',
        route: 'review',
      }).profile,
    ).toBeUndefined();
  });

  it('accepts effort and model_alias for a new subagent', () => {
    const parsed = SubagentToolInputSchema.parse({
      prompt: 'Investigate',
      description: 'Find cause',
      model_alias: ' provider/fast ',
      effort: ' high ',
    });

    expect(parsed).toMatchObject({
      model_alias: 'provider/fast',
      effort: 'high',
    });
  });

  it.each([
    { model_alias: 'inherit' },
    { model_alias: ' \ninherit\t ' },
    { model_alias: 'inherit', resume: 'agent-existing', allow_model_change: true },
    { model_alias: 'inherit', route: 'review' },
    { model_alias: 'inherit', profile_file: 'profiles/explore.md' },
  ])('rejects caller inheritance in AgentRun arguments: %j', (binding) => {
    const parsed = SubagentToolInputSchema.safeParse({
      prompt: 'Investigate', description: 'Find cause', ...binding,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({
        path: ['model_alias'],
        message: 'AgentRun does not accept model_alias: "inherit". Specify a concrete model name, or omit model_alias to use the target default model.',
      }));
    }
  });

  it.each([{}, { model_alias: 'provider/fast' }, { resume: 'agent-existing' },
    { resume: 'agent-existing', model_alias: 'provider/fast', allow_model_change: true }])(
    'accepts concrete models and omitted bindings: %j', (binding) => {
      expect(SubagentToolInputSchema.safeParse({
        prompt: 'Investigate', description: 'Find cause', ...binding,
      }).success).toBe(true);
    },
  );

  it('accepts a stable name for a new subagent', () => {
    expect(
      SubagentToolInputSchema.parse({
        prompt: 'Investigate',
        description: 'Find cause',
        name: 'auth_probe',
      }).name,
    ).toBe('auth_probe');
  });

  it.each([
    ['uppercase letters', 'AuthProbe'],
    ['hyphens', 'auth-probe'],
    ['spaces', 'auth probe'],
    ['the reserved root name', 'root'],
  ])('rejects a name with %s', (_label, name) => {
    expect(() =>
      SubagentToolInputSchema.parse({ prompt: 'Investigate', description: 'Find cause', name }),
    ).toThrow(/name/);
  });

  it.each([
    ['profile', { profile: 'explore' }],
    ['route', { route: 'review' }],
    ['profile_file', { profile_file: 'profiles/explore.md' }],
    ['name', { name: 'auth_probe' }],
  ] as const)('rejects %s together with resume', (_field, extra) => {
    expect(
      SubagentToolInputSchema.safeParse({
        prompt: 'Continue',
        description: 'Continue work',
        resume: 'agent-existing',
        ...extra,
      }).success,
    ).toBe(false);
  });

  it.each([
    ['profile', { profile: 'explore' }],
    ['route', { route: 'review' }],
  ] as const)('rejects profile_file with %s', (_field, extra) => {
    expect(
      SubagentToolInputSchema.safeParse({
        prompt: 'Follow the role file',
        description: 'Use role file',
        profile_file: 'profiles/explore.md',
        ...extra,
      }).success,
    ).toBe(false);
  });

  it('requires resume and model_alias when allow_model_change is set', () => {
    const base = {
      prompt: 'Continue',
      description: 'Continue work',
      allow_model_change: true,
    };

    expect(SubagentToolInputSchema.safeParse(base).success).toBe(false);
    expect(
      SubagentToolInputSchema.safeParse({ ...base, resume: 'agent-existing' }).success,
    ).toBe(false);
    expect(
      SubagentToolInputSchema.safeParse({
        ...base,
        resume: 'agent-existing',
        model_alias: 'provider/fast',
      }).success,
    ).toBe(true);
  });
});

describe('AgentRun tool description', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    await ctx.dispose();
    vi.unstubAllEnvs();
  });

  function agentDescription(): string {
    const tool = ctx.toolsData().find((entry) => entry.name === 'AgentRun');
    expect(tool).toBeDefined();
    return tool!.description;
  }

  it('guides idle root to end its turn while preserving subagent dependency handling', () => {
    ctx = createTestAgent();
    const description = agentDescription();
    expect(description).toContain('An interactive root can continue other work or end its turn without waiting');
    expect(description).toContain('the task and session continue');
    expect(description).toContain('Use foreground when you genuinely need the result in the same turn');
    expect(description).toContain('Do not poll TaskWait/TaskOutput/AgentList just to keep a root turn open');
    expect(description).toContain('A subagent must resolve its own dependencies before sending its final receipt');
    expect(description).toContain('Subagent timeout: 2 hours.');
    expect(description).not.toContain('fixed 2-hour timeout');
    expect(description).not.toContain('Default to a foreground subagent');
  });

  it.each([
    [5 * 60 * 60 * 1000, '5 hours'],
    [0, 'unlimited'],
  ] as const)('renders the effective subagent timeout (%s)', (timeoutMs, label) => {
    ctx = createTestAgent(
      configServices(() => ({ providers: {}, subagent: { timeoutMs, defaultProfile: 'general' } })),
    );
    expect(agentDescription()).toContain(`Subagent timeout: ${label}.`);
  });

  it('renders one compact capability line per subagent type instead of a tool inventory', () => {
    ctx = createTestAgent();

    const description = agentDescription();

    expect(description).toContain('- explore: Use for a scoped reading or retrieval question');
    expect(description).toContain('- general: Use this agent when the delegated task does not name a more specific role');
    expect(description).not.toContain('\n  Tools:');
  });

  it('limits AgentNotify guidance to parent-changing messages while notification is enabled', () => {
    ctx = createTestAgent();
    const description = agentDescription();
    expect(description).toContain('Subagents may use AgentNotify only when the parent must change course before their final result');
    expect(description).toContain('routine progress belongs in the final receipt');
  });

  it('omits AgentNotify while parent notification is disabled', () => {
    ctx = createTestAgent(
      configServices(() => ({ providers: {}, agents: { notify_parent: false } })),
    );
    expect(agentDescription()).not.toContain('Subagents may use AgentNotify');
  });

  it.each(['AgentList', 'AgentSend'])('registers %s on the main profile', (toolName) => {
    ctx = createTestAgent();

    expect(ctx.toolsData().map((entry) => entry.name)).toContain(toolName);
  });

  it('keeps global tool restrictions out of the subagent type summary', () => {
    ctx = createTestAgent(
      configServices(() => ({
        providers: {},
        tools: { disabled: ['Bash'] },
      })),
    );

    const description = agentDescription();

    expect(description).toContain('- explore: Use for a scoped reading or retrieval question');
    expect(description).toContain('- general: Use this agent when the delegated task does not name a more specific role');
    expect(description).not.toContain('\n  Tools:');
    expect(description).not.toContain('Bash');
  });

  it('lists a catalog subagent type the caller profile does not activate', async () => {
    const callerData = {
      profileName: 'orchestrator',
      activeToolNames: ['AgentRun', 'Bash', 'Read'],
      disallowedTools: [],
    } as unknown as ProfileData;
    const teammate: AgentProfile = normalizeAgentProfile({
      name: 'teammate',
      description: 'Teammate',
      tools: ['AgentRun', 'Write', 'Read'],
      systemPrompt: () => 'teammate',
    });
    const catalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name: string) => (name === 'teammate' ? teammate : undefined),
      getDefault: () => teammate,
      list: () => [teammate],
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(
      { autoConfigure: false },
      agentService(IAgentProfileService, {
        _serviceBrand: undefined,
        data: () => callerData,
        onDidChange: Event.None,
      } as unknown as IAgentProfileService),
      sessionService(
        ISessionAgentProfileCatalog,
        catalog as unknown as ISessionAgentProfileCatalog,
      ),
      configServices(() => ({
        providers: {},
        tools: { disabled: ['Write'] },
      })),
    );

    await ctx.ready;
    const description = agentDescription();

    expect(description.match(/- teammate: [^\n]*/)?.[0]).toBe('- teammate: Teammate');
    expect(description).not.toContain('\n  Tools:');
  });

  it('renders restricted profiles without a per-type tool inventory', () => {
    const restricted: AgentProfile = normalizeAgentProfile({
      name: 'restricted',
      description: 'Restricted agent',
      tools: ['Bash', 'Read', 'mcp__github__*'],
      disallowedTools: ['Bash', 'mcp__github__*'],
      systemPrompt: () => 'restricted',
    });
    const allowAllExcept: AgentProfile = normalizeAgentProfile({
      name: 'allow-all-except',
      description: 'Allow all except one',
      disallowedTools: ['Bash'],
      systemPrompt: () => 'allow all except',
    });
    const profiles = [restricted, allowAllExcept];
    const catalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name: string) => profiles.find((profile) => profile.name === name),
      getDefault: () => restricted,
      list: () => profiles,
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(sessionService(
      ISessionAgentProfileCatalog,
      catalog as unknown as ISessionAgentProfileCatalog,
    ));

    const description = agentDescription();

    expect(description.match(/- restricted: [^\n]*/)?.[0]).toBe('- restricted: Restricted agent');
    expect(description.match(/- allow-all-except: [^\n]*/)?.[0]).toBe('- allow-all-except: Allow all except one');
    expect(description).not.toContain('Tools: all');
  });

  it('lists only subagent types allowed by the caller profile', () => {
    const caller: AgentProfile = normalizeAgentProfile({
      name: 'orchestrator',
      description: 'Orchestrator',
      subagentPolicy: 'strict',
      subagents: ['explore'],
      systemPrompt: () => 'orchestrator',
    });
    const coder: AgentProfile = normalizeAgentProfile({
      name: 'coder',
      description: 'Coder',
      systemPrompt: () => 'coder',
    });
    const explore: AgentProfile = normalizeAgentProfile({
      name: 'explore',
      description: 'Explorer',
      systemPrompt: () => 'explore',
    });
    const profiles = [caller, coder, explore];
    const catalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name: string) => profiles.find((profile) => profile.name === name),
      getDefault: () => caller,
      list: () => [coder, explore],
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(sessionService(
      ISessionAgentProfileCatalog,
      catalog as unknown as ISessionAgentProfileCatalog,
    ));

    const description = agentDescription();

    expect(description).toContain('- explore: Explorer');
    expect(description).not.toContain('- coder: Coder');
  });

  it('uses persisted advisory recommendations without filtering legal subagent types', () => {
    const caller: AgentProfile = normalizeAgentProfile({
      name: 'orchestrator',
      description: 'Orchestrator',
      subagents: ['coder'],
      systemPrompt: () => 'orchestrator',
    });
    const coder: AgentProfile = normalizeAgentProfile({
      name: 'coder',
      description: 'Coder',
      systemPrompt: () => 'coder',
    });
    const explore: AgentProfile = normalizeAgentProfile({
      name: 'explore',
      description: 'Explorer',
      systemPrompt: () => 'explore',
    });
    const catalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name: string) => [caller, coder, explore].find((profile) => profile.name === name),
      getDefault: () => caller,
      list: () => [coder, explore],
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(sessionService(
      ISessionAgentProfileCatalog,
      catalog as unknown as ISessionAgentProfileCatalog,
    ));
    ctx.get(IAgentProfileService).applyBindingSnapshot({
      profileName: 'deleted-profile',
      thinkingLevel: 'off',
      systemPrompt: 'persisted prompt',
      subagents: ['explore'],
    });

    const description = agentDescription();

    expect(description).toContain('- explore: Explorer');
    expect(description).toContain('- coder: Coder');
  });

  it('freezes the subagent type list once the profile catalog is ready', async () => {
    const caller: AgentProfile = normalizeAgentProfile({
      name: 'orchestrator',
      description: 'Orchestrator',
      systemPrompt: () => 'orchestrator',
    });
    const coder: AgentProfile = normalizeAgentProfile({
      name: 'coder',
      description: 'Coder',
      systemPrompt: () => 'coder',
    });
    const explore: AgentProfile = normalizeAgentProfile({
      name: 'explore',
      description: 'Explorer',
      systemPrompt: () => 'explore',
    });
    const profiles = [coder];
    const catalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name: string) => [caller, ...profiles].find((profile) => profile.name === name),
      getDefault: () => caller,
      list: () => [...profiles],
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(sessionService(
      ISessionAgentProfileCatalog,
      catalog as unknown as ISessionAgentProfileCatalog,
    ));
    expect(agentDescription()).toContain('- coder: Coder');
    await Promise.resolve();

    const frozen = agentDescription();
    expect(frozen).toContain('- coder: Coder');

    profiles.push(explore);
    const after = agentDescription();
    expect(after).toBe(frozen);
    expect(after).not.toContain('- explore: Explorer');
  });

  it('reflects the current catalog list in the description before the catalog is ready', async () => {
    const caller: AgentProfile = normalizeAgentProfile({
      name: 'orchestrator',
      description: 'Orchestrator',
      systemPrompt: () => 'orchestrator',
    });
    const coder: AgentProfile = normalizeAgentProfile({
      name: 'coder',
      description: 'Coder',
      systemPrompt: () => 'coder',
    });
    const explore: AgentProfile = normalizeAgentProfile({
      name: 'explore',
      description: 'Explorer',
      systemPrompt: () => 'explore',
    });
    const profiles = [coder];
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const catalog = {
      _serviceBrand: undefined,
      ready,
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name: string) => [caller, ...profiles].find((profile) => profile.name === name),
      getDefault: () => caller,
      list: () => [...profiles],
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(sessionService(
      ISessionAgentProfileCatalog,
      catalog as unknown as ISessionAgentProfileCatalog,
    ));

    expect(agentDescription()).toContain('- coder: Coder');
    profiles.push(explore);
    expect(agentDescription()).toContain('- explore: Explorer');

    resolveReady();
    await ready;
  });

  it('renders the available profiles section', () => {
    ctx = createTestAgent();

    expect(agentDescription()).toContain('Available profiles (pass via profile; preferred first):');
  });

  it('lists configured aliases and rejects tool-level inheritance without a silent fallback', () => {
    ctx = createTestAgent({ initialConfig: { models: POOL_MODEL_ENTRIES } });

    const description = agentDescription();

    expect(description).toContain('Model aliases available across the targets above');
    expect(description).toContain('provider/fast');
    expect(description).toContain('provider/smart');
    expect(description).toContain('AgentRun does not accept model_alias: "inherit"');
    expect(description).toContain('specify a concrete configured model name');
    expect(description).toContain('otherwise omit model_alias to use the target default');
    expect(description).not.toContain('Set model_alias to inherit explicitly');
    expect(description).toContain('do not assume they copy your model or effort');
  });

  function agentParameters(): Record<string, unknown> {
    const tool = ctx.toolsData().find((entry) => entry.name === 'AgentRun');
    expect(tool?.parameters).toBeDefined();
    return tool!.parameters!;
  }

  it('advertises dispatch selectors, resume binding controls, and no symbolic model parameter', () => {
    ctx = createTestAgent();

    const properties = agentParameters()['properties'] as Record<string, unknown>;

    expect(properties).not.toHaveProperty('model');
    expect(properties).toHaveProperty('model_alias');
    expect(properties).toHaveProperty('effort');
    expect(properties).toHaveProperty('route');
    expect(properties).toHaveProperty('profile_file');
    expect(properties).toHaveProperty('allow_model_change');
    expect(properties).toHaveProperty('prompt');
    expect((properties['model_alias'] as { description?: string }).description).toContain(
      'target default model',
    );
    expect((properties['model_alias'] as { description?: string }).description).toContain(
      'does not accept "inherit"',
    );
    expect((properties['effort'] as { description?: string }).description).toContain(
      'target default thinking effort',
    );
    expect((properties['effort'] as { description?: string }).description).not.toContain('inherit');
    expect((properties['allow_model_change'] as { description?: string }).description).toContain(
      'different canonical model',
    );
    expect((properties['resume'] as { description?: string }).description).toContain(
      'Do not pass name, profile, profile_file, or route',
    );
    expect((properties['profile_file'] as { description?: string }).description).toContain(
      'mutually exclusive with profile and route',
    );
  });
});

describe('AgentRun tool execution contract', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await ctx?.dispose();
    ctx = undefined;
  });

  function createAgentToolContext(
    lifecycle: AgentLifecycleStub = createAgentLifecycleStub(),
    ...extra: readonly (TestAgentServiceOverride | TestAgentOptions)[]
  ): TestAgentContext {
    lifecycle.addHandle('main', 'agent');
    ctx = createTestAgent(
      sessionService(IAgentLifecycleService, lifecycle),
      sessionService(ISessionSubagentService, lifecycle),
      sessionService(ISessionCronService, cronStub),
      modelProviderServices(
        modelCatalogResolving('mock-model', 'provider/fast', 'provider/smart'),
      ),
      ...extra,
    );
    const config = ctx.get(IConfigService);
    const subagentSection = (config.get<{ defaultProfile?: string }>('subagent') ?? {}) as {
      defaultProfile?: string;
    };
    void config.set('subagent', { ...subagentSection, defaultProfile: subagentSection.defaultProfile ?? 'general' });
    return ctx;
  }

  function allowlistCatalog(
    allowlist: readonly string[],
    subagentPolicy?: AgentProfile['subagentPolicy'],
  ): ISessionAgentProfileCatalog {
    const caller: AgentProfile = normalizeAgentProfile({
      name: 'orchestrator',
      description: 'Orchestrator',
      subagentPolicy,
      subagents: allowlist,
      systemPrompt: () => 'orchestrator',
    });
    const coder: AgentProfile = normalizeAgentProfile({
      name: 'coder',
      description: 'Coder',
      systemPrompt: () => 'coder',
    });
    const explore: AgentProfile = normalizeAgentProfile({
      name: 'explore',
      description: 'Explorer',
      systemPrompt: () => 'explore',
    });
    const profiles = [caller, coder, explore];
    return {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name: string) => profiles.find((profile) => profile.name === name),
      getDefault: () => caller,
      list: () => [coder, explore],
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    } as unknown as ISessionAgentProfileCatalog;
  }

  it('keeps cheap targets recommended while accepting executable costly overrides', async () => {
    const lifecycle = createAgentLifecycleStub();
    const base = allowlistCatalog(['explore']);
    const cheap = normalizeAgentProfile({ name: 'explore', modelAlias: 'provider/fast', thinkingEffort: 'max',
      allowedModels: ['provider/fast', 'mock-model'], systemPrompt: () => '' });
    const catalog = { ...base, get: (name: string) => name === 'explore' ? cheap : base.get(name), list: () => [cheap] };
    const context = createAgentToolContext(lifecycle,
      { initialConfig: { models: POOL_MODEL_ENTRIES } }, sessionService(ISessionAgentProfileCatalog, catalog));
    expect(agentTool(context).description).toContain('Model aliases available across the targets above: mock-model, provider/fast');
    expect(agentTool(context).description).not.toContain('provider/smart');
    const overridden = await executeAgentTool(context, {
      prompt: 'Inspect the fixture', description: 'Inspect fixture', profile: 'explore', model_alias: 'provider/smart',
    });
    expect(overridden.isError).not.toBe(true);
    expect(lifecycle.create).toHaveBeenLastCalledWith(expect.objectContaining({
      binding: expect.objectContaining({
        model: 'provider/smart',
        bindingSelection: expect.objectContaining({
          model: { source: 'dispatch-explicit', requestedValue: 'provider/smart' },
        }),
      }),
    }));
    await executeAgentToolRaw(context, { prompt: 'Inspect the fixture', description: 'Inspect fixture', profile: 'explore' });
    expect(lifecycle.create).toHaveBeenLastCalledWith(expect.objectContaining({ binding: expect.objectContaining({ model: 'provider/fast' }) }));
    await executeAgentTool(context, { prompt: 'Inspect the fixture', description: 'Inspect fixture', profile: 'explore', model_alias: 'mock-model' });
    expect(lifecycle.create).toHaveBeenLastCalledWith(expect.objectContaining({ binding: expect.objectContaining({ model: 'mock-model' }) }));
    expect(lifecycle.run).toHaveBeenCalledTimes(3);
  });

  it('rejects a subagent type outside an explicit strict caller allowlist', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(ISessionAgentProfileCatalog, allowlistCatalog(['explore'], 'strict')),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      profile: 'coder',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Profile "coder" is not allowed by strict subagent policy');
    expect(result.output).toContain('explore');
    expect(lifecycle.create).not.toHaveBeenCalled();
  });

  it('rejects a disabled default profile and reports the available dispatch types', async () => {
    const lifecycle = createAgentLifecycleStub();
    const baseCatalog = allowlistCatalog(['explore']);
    const context = createAgentToolContext(
      lifecycle,
      sessionService(ISessionAgentProfileCatalog, {
        ...baseCatalog,
        get: (name: string) => (name === 'agent' ? undefined : baseCatalog.get(name)),
      }),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      profile: 'agent',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Unknown agent profile: "agent"');
    expect(result.output).toContain('Available agent profiles: coder, explore');
    expect(lifecycle.create).not.toHaveBeenCalled();
  });

  it('enforces the persisted subagent allowlist instead of the current catalog profile', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(ISessionAgentProfileCatalog, allowlistCatalog(['coder'])),
    );
    context.get(IAgentProfileService).applyBindingSnapshot({
      profileName: 'deleted-profile',
      thinkingLevel: 'off',
      systemPrompt: 'persisted prompt',
      subagentPolicy: 'strict',
      subagents: ['explore'],
    });

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      profile: 'coder',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Profile "coder" is not allowed by strict subagent policy');
    expect(result.output).toContain('explore');
    expect(lifecycle.create).not.toHaveBeenCalled();
  });

  it('does not create a subagent when process disappears after tool activation', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle);
    vi.spyOn(context.get(IAgentRuntimeService), 'acquire').mockImplementation(() => {
      throw new Error('process capability is no longer available');
    });

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      profile: 'explore',
    });

    expect(result).toEqual({
      output: 'subagent error: process capability is no longer available',
      isError: true,
    });
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.run).not.toHaveBeenCalled();
    expect(lifecycle.list()).toHaveLength(1);
  });

  it('spawns a subagent type inside the caller allowlist', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => ({ summary: 'child result' }),
    });
    const context = createAgentToolContext(
      lifecycle,
      sessionService(ISessionAgentProfileCatalog, allowlistCatalog(['explore'])),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      profile: 'explore',
    });

    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({ profile: 'explore' }),
      }),
    );
    expect(result.output).toContain('actual_profile: explore');
  });

  it('declares no resource accesses so concurrent AgentRun calls can run in parallel', async () => {
    const context = createAgentToolContext();

    const execution = await agentTool(context).resolveExecution({
      prompt: 'Investigate',
      description: 'Find cause',
      profile: 'explore',
    });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.accesses).toEqual(ToolAccesses.none());
  });

  it('uses the resumed agent profile in the activity description', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle);
    lifecycle.addHandle('agent-existing', 'explore');

    const execution = await agentTool(context).resolveExecution({
      prompt: 'Continue',
      description: 'Continue work',
      resume: ' agent-existing ',
    });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Launching explore agent: Continue work');
    expect(lifecycle.get).toHaveBeenCalledWith('agent-existing');
  });

  it('uses an offline persisted profile for resume display and permission rules', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({
          'agent-existing': {
            type: 'sub',
            labels: { parentAgentId: 'main', profileName: 'explore' },
          },
        }),
      ),
    );

    const execution = await agentTool(context).resolveExecution({
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Launching explore agent: Continue work');
    expect(execution.display).toMatchObject({ agent_name: 'explore' });
    expect(execution.matchesRule?.('explore')).toBe(true);
    expect(execution.matchesRule?.('coder')).toBe(false);
    expect(lifecycle.create).not.toHaveBeenCalled();
  });

  it('resolves a cold named route by its persisted base profile', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({
          'agent-existing': {
            type: 'sub',
            displayName: 'review-route',
            model: 'external/model',
            thinkingEffort: 'xhigh',
            executor: 'grok-acp',
            labels: {
              parentAgentId: 'main',
              profileName: 'coder',
              [COLLABORATION_TASK_NAME_LABEL]: 'reviewer',
              [COLLABORATION_AGENT_TYPE_LABEL]: 'coder',
            },
          },
        }),
      ),
    );

    const execution = await agentTool(context).resolveExecution({
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'reviewer',
    });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Launching coder agent: Continue work');
    expect(execution.matchesRule?.('coder')).toBe(true);
    expect(execution.matchesRule?.('review-route')).toBe(false);
    expect(lifecycle.create).not.toHaveBeenCalled();
  });

  it('returns an error when continuing with a profile', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle);
    lifecycle.addHandle('agent-existing', 'explore');

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
      profile: 'explore',
    });

    expect(result).toMatchObject({
      isError: true,
      output: 'Cannot set profile when continuing an existing agent. Pass only resume with the name or agent id.',
    });
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('spawns a foreground subagent and returns its summary', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => ({ summary: 'child result' }),
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      profile: 'explore',
      name: 'smoke_explore',
    });

    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({ profile: 'explore' }),
        labels: expect.objectContaining({
          collaborationTaskName: 'smoke_explore',
          parentAgentId: 'main',
        }),
      }),
    );
    expect(lifecycle.run).toHaveBeenCalledWith(
      'agent-child',
      { kind: 'prompt', prompt: expect.stringContaining('Investigate') },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(lifecycle.publishedEvents).toContainEqual(
      expect.objectContaining({
        type: 'subagent.spawned',
        subagentId: 'agent-child',
        subagentName: 'explore',
        name: 'smoke_explore',
      }),
    );
    expect(result.output).toContain('agent_id: agent-child');
    expect(result.output).toContain('actual_profile: explore');
    expect(result.output).toContain('child result');
  });

  it.each([
    { model_alias: 'inherit' },
    { model_alias: ' \ninherit\t ' },
    { model_alias: 'inherit', resume: 'agent-existing', allow_model_change: true },
  ])('rejects tool-level caller inheritance before spawning or resuming: %j', async (binding) => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle);
    const result = await executeAgentToolRaw(context, {
      prompt: 'Investigate', description: 'Find cause', ...binding,
    });
    expect(result.isError).toBe(true);
    expect(result.output).toBe('AgentRun does not accept model_alias: "inherit". Specify a concrete model name, or omit model_alias to use the target default model.');
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('preserves profile-authored inheritance when the tool model is omitted', async () => {
    const lifecycle = createAgentLifecycleStub();
    const base = allowlistCatalog(['explore']);
    const inherited = normalizeAgentProfile({ name: 'explore', modelAlias: 'inherit', systemPrompt: () => '' });
    const catalog = { ...base, get: (name: string) => name === 'explore' ? inherited : base.get(name), list: () => [inherited] };
    const context = createAgentToolContext(lifecycle,
      { initialConfig: { models: POOL_MODEL_ENTRIES } }, sessionService(ISessionAgentProfileCatalog, catalog));
    lifecycle.addHandle('main', 'orchestrator', new Map([[IAgentProfileService, {
      data: () => ({ profileName: 'orchestrator', modelAlias: 'provider/fast', effectiveThinkingLevel: 'high' }),
    }]]));
    const result = await executeAgentToolRaw(context, {
      prompt: 'Investigate', description: 'Find cause', profile: 'explore',
    });
    expect(result.isError).not.toBe(true);
    expect(lifecycle.create).toHaveBeenCalledWith(expect.objectContaining({
      binding: expect.objectContaining({ model: 'provider/fast', thinking: 'high' }),
    }));
  });

  it('spawns the subagent on the model_alias passed with the dispatch', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const context = createAgentToolContext(lifecycle, {
      initialConfig: { models: POOL_MODEL_ENTRIES },
    });

    await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      model_alias: 'provider/smart',
    });

    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          model: 'provider/smart',
          thinking: undefined,
        }),
      }),
    );
    expect(lifecycle.publishedEvents).toContainEqual(
      expect.objectContaining({
        type: 'subagent.spawned',
        subagentId: 'agent-child',
        name: undefined,
        model: 'provider/smart',
      }),
    );
  });

  it('fails closed when neither the dispatch nor the profile binds a model', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentToolRaw(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('No model is bound for');
    expect(result.output).toContain('pass a concrete model name as model_alias');
    expect(result.output).toContain('AgentRun does not accept model_alias: "inherit"');
    expect(lifecycle.create).not.toHaveBeenCalled();
  });

  it('does not rewrite spawn failures unrelated to the model config', async () => {
    const lifecycle = createAgentLifecycleStub({
      createError: new Error('MCP server failed to start'),
    });
    const context = createAgentToolContext(lifecycle, {
      initialConfig: { models: POOL_MODEL_ENTRIES },
    });

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      model_alias: 'provider/fast',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('MCP server failed to start');
  });

  it('mirrors v1-compatible subagent lifecycle event fields', async () => {
    const lifecycle = createAgentLifecycleStub();
    const events: Event2[] = [];
    let agentStateService: AgentStateService | undefined;
    const eventBus = {
      _serviceBrand: undefined,
      publish: vi.fn((event: Event2) => {
        events.push(event);
      }),
      subscribe: vi.fn(() => noopDisposable()),
    } as IEventBus;
    lifecycle.addHandle(
      'agent-child',
      'explore',
      new Map([
        [
          IAgentTokenCountingService,
          {
            _serviceBrand: undefined,
            get: () => ({ size: 321, measured: 300, estimated: 21 }),
            measured: () => {},
            statusSize: () => 321,
          },
        ],
      ]),
    );
    const telemetryRecords: Array<{ event: string; properties: unknown }> = [];
    const dispatcher = {
      _serviceBrand: undefined,
      dispatch: async (event: Event2) => {
        eventBus.publish(event);
      },
    } as unknown as IEventDispatcher;
    const requester = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: {
        get: ((serviceId: unknown) => {
          if (serviceId === IEventBus) return eventBus;
          if (serviceId === IEventDispatcher) return dispatcher;
          if (serviceId === IAgentStateService) {
            agentStateService ??= new AgentStateService();
            return agentStateService;
          }
          if (serviceId === IAgentLifecycleService) return lifecycle;
          if (serviceId === ITelemetryService) {
            return {
              ...noopTelemetryService,
              track2: (event: string, properties: unknown) => {
                telemetryRecords.push({ event, properties });
              },
            };
          }
          return undefined;
        }) as IAgentScopeHandle['accessor']['get'],
      },
      dispose: () => {},
    } satisfies IAgentScopeHandle;

    emitAgentRunSpawned(requester, 'agent-child', {
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      runInBackground: false,
      model: 'provider/secondary',
    });
    await mirrorAgentRun(
      requester,
      {
        agentId: 'agent-child',
        turn: {} as AgentRunHandle['turn'],
        completion: Promise.resolve({ summary: 'child result' }),
      },
      {
        profileName: 'explore',
        prompt: 'Investigate',
        signal,
      },
    );

    expect(events.find((event) => event.type === 'subagent.spawned')).toMatchObject({
      parentAgentId: 'main',
      callerAgentId: 'main',
      model: 'provider/secondary',
      thinkingEffort: 'off',
    });
    expect(telemetryRecords).toContainEqual({
      event: 'subagent_created',
      properties: {
        subagent_name: 'explore',
        run_in_background: false,
        agent_id: 'agent-child',
        parent_agent_id: 'main',
        parent_tool_call_id: 'call_agent',
        model: 'provider/secondary',
      },
    });
    expect(events.find((event) => event.type === 'subagent.completed')).toMatchObject({
      subagentId: 'agent-child',
      resultSummary: 'child result',
      contextTokens: 321,
    });
  });

  it.each(['running', 'before start'] as const)('records a terminal killed subagent event when cancelled %s', async (when) => {
    const events: Event2[] = [];
    const dispatcher = {
      dispatch: vi.fn(async (event: Event2) => { events.push(event); }),
    } as unknown as IEventDispatcher;
    const requester = {
      id: 'main', kind: LifecycleScope.Agent,
      accessor: {
        get: ((serviceId: unknown) => serviceId === IEventDispatcher ? dispatcher : undefined) as IAgentScopeHandle['accessor']['get'],
      },
      dispose: () => {},
    } satisfies IAgentScopeHandle;
    const controller = new AbortController();
    const completion = deferred<{ summary: string }>();
    const cancellation = userCancellationReason();
    if (when === 'before start') controller.abort(cancellation);
    const mirrored = mirrorAgentRun(requester, {
      agentId: 'agent-child', turn: {} as AgentRunHandle['turn'], completion: completion.promise,
    }, {
      profileName: 'explore', prompt: 'Investigate', signal: controller.signal,
      resolveTaskId: () => 'agent-task-1',
    });
    if (when === 'running') {
      controller.abort(cancellation);
      completion.reject(cancellation);
    }
    await expect(mirrored).rejects.toBe(cancellation);
    expect(events.filter((event) => event.type === 'subagent.failed')).toEqual([
      expect.objectContaining({ subagentId: 'agent-child', taskId: 'agent-task-1', error: 'terminated' }),
    ]);
    expect(events.some((event) => event.type === 'subagent.completed')).toBe(false);
  });

  it('merges terminal subagent outcomes into metadata without inventing tool counts', async () => {
    const agents: Record<string, AgentMeta> = {
      'agent-child': { type: 'sub', model: 'provider/example', labels: { swarmItem: 'example' } },
    };
    const registerAgent = vi.fn(async (agentId: string, meta: AgentMeta) => { agents[agentId] = meta; });
    const dispatch = vi.fn(async (_event: Event2) => {});
    const requester = {
      id: 'main', kind: LifecycleScope.Agent,
      accessor: {
        get: ((serviceId: unknown) => {
          if (serviceId === ISessionMetadata) return { read: async () => ({ agents }), registerAgent };
          if (serviceId === IEventDispatcher) return { dispatch };
          if (serviceId === IAgentLifecycleService) return {
            get: () => ({ accessor: { get: () => ({ statusSize: () => 23 }) } }),
          };
          return undefined;
        }) as IAgentScopeHandle['accessor']['get'],
      },
      dispose: () => {},
    } satisfies IAgentScopeHandle;
    const run = (completion: Promise<{ summary: string; usage?: TokenUsage }>) => mirrorAgentRun(requester, {
      agentId: 'agent-child', turn: {} as AgentRunHandle['turn'], completion,
    }, { profileName: 'explore', signal });
    const usage = { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 };
    await run(Promise.resolve({ summary: 'Done', usage }));
    expect(agents['agent-child']).toMatchObject({
      type: 'sub', model: 'provider/example', labels: { swarmItem: 'example' },
      status: 'completed', resultSummary: 'Done', usage, contextTokens: 23,
      completedAt: expect.any(Number),
    });
    expect(agents['agent-child']?.toolCallCount).toBeUndefined();
    expect(registerAgent).toHaveBeenCalledOnce();

    await expect(run(Promise.reject(new Error('failed')))).rejects.toThrow('failed');
    expect(agents['agent-child']).toMatchObject({ status: 'failed', error: 'failed' });
    expect(agents['agent-child']?.resultSummary).toBeUndefined();

    const cancellation = userCancellationReason();
    await expect(run(Promise.reject(cancellation))).rejects.toBe(cancellation);
    expect(agents['agent-child']).toMatchObject({ status: 'cancelled', error: 'terminated' });
    expect(registerAgent).toHaveBeenCalledTimes(3);
  });

  it('inherits parent user tools when spawning a subagent', async () => {
    const lookupTool: UserToolRegistration = {
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    };
    const parentUserTools = {
      _serviceBrand: undefined,
      list: () => [lookupTool],
      inheritUserTools: vi.fn(),
      register: vi.fn(),
      unregister: vi.fn(),
    } as unknown as IAgentUserToolService;
    const childUserTools = {
      _serviceBrand: undefined,
      list: () => [],
      inheritUserTools: vi.fn(),
      register: vi.fn(),
      unregister: vi.fn(),
    } as unknown as IAgentUserToolService;
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      handleServices: new Map([
        ['main', new Map([[IAgentUserToolService, parentUserTools]])],
        ['agent-child', new Map([[IAgentUserToolService, childUserTools]])],
      ]),
    });
    const context = createAgentToolContext(lifecycle);

    await executeAgentTool(context, {
      prompt: 'Use the available lookup tool',
      description: 'Use lookup',
    });

    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({ inheritedUserToolNames: [lookupTool.name] }),
      }),
    );
    expect(childUserTools.inheritUserTools).toHaveBeenCalledWith(parentUserTools);
  });

  it('resolves an empty subagent type to the configured default profile', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const context = createAgentToolContext(lifecycle);

    await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      profile: '',
    });

    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({ profile: 'general' }),
      }),
    );
  });

  it('resumes a foreground subagent when resume is provided', async () => {
    const lifecycle = createAgentLifecycleStub({
      runCompletion: async () => ({ summary: 'resumed result' }),
    });
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({ 'agent-existing': subagentMeta() }),
      ),
    );
    lifecycle.addHandle('agent-existing', 'explore');

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.run).toHaveBeenCalledWith(
      'agent-existing',
      { kind: 'prompt', prompt: 'Continue' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.output).toContain('agent_id: agent-existing');
    expect(result.output).toContain('actual_profile: explore');
    expect(result.output).toContain('resumed result');
  });

  it('stamps the requested name on the new subagent', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const context = createAgentToolContext(lifecycle);

    await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      name: 'auth_probe',
    });

    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: expect.objectContaining({
          [COLLABORATION_TASK_NAME_LABEL]: 'auth_probe',
          [COLLABORATION_AGENT_TYPE_LABEL]: 'general',
        }),
        userLabel: 'Find cause',
      }),
    );
  });

  it('resumes a subagent addressed by its name', async () => {
    const lifecycle = createAgentLifecycleStub({
      runCompletion: async () => ({ summary: 'resumed result' }),
    });
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({ 'agent-existing': namedSubagentMeta('auth_probe') }),
      ),
    );
    lifecycle.addHandle('agent-existing', 'explore');

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'auth_probe',
    });

    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.run).toHaveBeenCalledWith(
      'agent-existing',
      { kind: 'prompt', prompt: 'Continue' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.output).toContain('agent_id: agent-existing');
    expect(result.output).toContain('resumed result');
  });

  it('refuses a name already used in this session', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({ 'agent-existing': namedSubagentMeta('auth_probe') }),
      ),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      name: 'auth_probe',
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('already used in this session');
    expect(lifecycle.create).not.toHaveBeenCalled();
  });

  it('rejects direct resume of a non-subagent', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({
          main: { type: 'main' },
        }),
      ),
    );
    lifecycle.addHandle('main', 'agent');

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'main',
    });

    expect(result).toMatchObject({
      isError: true,
      output: 'subagent error: Agent instance "main" is not a subagent',
    });
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('rejects direct resume of another caller owned subagent', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({ 'agent-existing': subagentMeta('other') }),
      ),
    );
    lifecycle.addHandle('agent-existing', 'explore');

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    expect(result).toMatchObject({
      isError: true,
      output: 'subagent error: Agent instance "agent-existing" does not belong to this delegator',
    });
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('rejects direct resume of an already running subagent before launching a turn', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({ 'agent-existing': subagentMeta() }),
      ),
    );
    lifecycle.addHandle(
      'agent-existing',
      'explore',
      new Map([
        [
          IAgentExecutionService,
          {
            _serviceBrand: undefined,
            status: () => ({ state: 'running', turnId: 1 }),
          },
        ],
      ]),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    expect(result).toMatchObject({
      isError: true,
      output:
        'subagent error: Agent instance "agent-existing" is already running and cannot run concurrently',
    });
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('keeps a directly resumed subagent on its persisted binding', async () => {
    const targetProfile = {
      _serviceBrand: undefined,
      data: () => ({ profileName: 'explore', modelAlias: 'stale-model' }),
      prepareResumeBinding: vi.fn(async () => () => {}),
      update: vi.fn(),
      setModel: vi.fn(),
      setThinking: vi.fn(),
      republishStatus: vi.fn(),
      getEffectiveThinkingLevel: () => 'medium',
      isToolActive: () => false,
    } as unknown as IAgentProfileService;
    const lifecycle = createAgentLifecycleStub({
      runCompletion: async () => ({ summary: 'resumed result' }),
    });
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({ 'agent-existing': subagentMeta() }),
      ),
    );
    lifecycle.addHandle(
      'agent-existing',
      'explore',
      new Map([[IAgentProfileService, targetProfile]]),
    );

    await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    expect(targetProfile.setModel).not.toHaveBeenCalled();
    expect(targetProfile.setThinking).not.toHaveBeenCalled();
    expect(lifecycle.run).toHaveBeenCalledWith(
      'agent-existing',
      { kind: 'prompt', prompt: 'Continue' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('ignores a legacy inherit binding-mode label instead of refreshing from the caller', async () => {
    let profileData = {
      profileName: 'explore',
      modelAlias: 'stale-model',
      thinkingLevel: 'low',
    };
    const targetProfile = {
      _serviceBrand: undefined,
      data: () => profileData,
      prepareResumeBinding: vi.fn(async () => () => {}),
      update: vi.fn(),
      setModel: vi.fn(async (model: string) => {
        profileData = { ...profileData, modelAlias: model };
        return { model };
      }),
      setThinking: vi.fn((thinkingLevel: string) => {
        profileData = { ...profileData, thinkingLevel };
      }),
      republishStatus: vi.fn(),
      getEffectiveThinkingLevel: () => profileData.thinkingLevel,
      isToolActive: () => false,
    } as unknown as IAgentProfileService;
    const lifecycle = createAgentLifecycleStub({
      runCompletion: async () => ({ summary: 'resumed result' }),
    });
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({
          'agent-existing': {
            labels: { parentAgentId: 'main', subagentBindingMode: 'inherit' },
          },
        }),
      ),
    );
    lifecycle.addHandle(
      'main',
      'agent',
      new Map([[IAgentProfileService, context.get(IAgentProfileService)]]),
    );
    lifecycle.addHandle(
      'agent-existing',
      'explore',
      new Map([[IAgentProfileService, targetProfile]]),
    );

    await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    expect(targetProfile.setModel).not.toHaveBeenCalled();
    expect(targetProfile.setThinking).not.toHaveBeenCalled();
    expect(profileData).toMatchObject({ modelAlias: 'stale-model', thinkingLevel: 'low' });
    expect(lifecycle.run).toHaveBeenCalledWith(
      'agent-existing',
      { kind: 'prompt', prompt: 'Continue' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('registers background subagents with the task manager', async () => {
    const completion = deferred<{ readonly summary: string }>();
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: () => completion.promise,
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      background: true,
    });

    expect(result.output).toContain('status: running');
    expect(result.output).toContain('agent_id: agent-child');
    if (typeof result.output !== 'string') throw new TypeError('expected string output');
    const taskId = result.output.match(/task_id: (agent-[0-9a-z]{8})/)?.[1];
    expect(taskId).toBeDefined();
    expect(context.get(IAgentTaskService).getTask(taskId!)).toMatchObject({
      status: 'running',
      description: 'Find cause',
      timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
    });
    completion.resolve({ summary: 'finished later' });
  });

  it('emits spawned with the registered task id ahead of started', async () => {
    const completion = deferred<{ readonly summary: string }>();
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: () => completion.promise,
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      background: true,
    });

    if (typeof result.output !== 'string') throw new TypeError('expected string output');
    const taskId = result.output.match(/task_id: (agent-[0-9a-z]{8})/)?.[1];
    expect(taskId).toBeDefined();
    expect(lifecycle.publishedEvents).toContainEqual(
      expect.objectContaining({
        type: 'subagent.spawned',
        subagentId: 'agent-child',
        taskId,
      }),
    );
    const eventOrder = lifecycle.publishedEvents.map((event) => event.type);
    expect(eventOrder.indexOf('subagent.spawned')).toBeGreaterThanOrEqual(0);
    expect(eventOrder.indexOf('subagent.started')).toBeGreaterThan(eventOrder.indexOf('subagent.spawned'));
    completion.resolve({ summary: 'finished later' });
  });

  it.each([false, true])('publishes started before a fast run terminal when run registration is delayed (failed=%s)', async (failed) => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => {
        if (failed) throw new Error('failed immediately');
        return { summary: 'finished immediately' };
      },
    });
    const context = createAgentToolContext(lifecycle);
    const tasks = context.get(IAgentTaskService);
    const gate = deferred<void>();
    const entered = deferred<void>();
    const dispatch = context.get(ISessionDispatchService);
    const recordRun = dispatch.recordRun.bind(dispatch);
    vi.spyOn(dispatch, 'recordRun').mockImplementation(async (agentId, taskId) => {
      await tasks.wait(taskId, 10);
      entered.resolve();
      await gate.promise;
      await recordRun(agentId, taskId);
    });
    const pending = executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      background: true,
    });
    await entered.promise;
    gate.resolve();
    const result = await pending;

    if (typeof result.output !== 'string') throw new TypeError('expected string output');
    const taskId = result.output.match(/task_id: (agent-[0-9a-z]{8})/)?.[1];
    expect(taskId).toBeDefined();
    await vi.waitFor(() => {
      expect(tasks.getTask(taskId!)?.status).toBe(failed ? 'failed' : 'completed');
      expect(lifecycle.publishedEvents).toContainEqual(expect.objectContaining({
        type: failed ? 'subagent.failed' : 'subagent.completed', subagentId: 'agent-child', taskId,
      }));
    });
    expect(lifecycle.publishedEvents.filter((event) => event.type.startsWith('subagent.')).map((event) => event.type))
      .toEqual(['subagent.spawned', 'subagent.started', failed ? 'subagent.failed' : 'subagent.completed']);
    expect(lifecycle.publishedEvents).toContainEqual(expect.objectContaining({
      type: 'subagent.started', subagentId: 'agent-child', taskId,
    }));
  });

  it.each([false, true])('releases the terminal mirror when run registration fails (failed=%s)', async (failed) => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => {
        if (failed) throw new Error('failed immediately');
        return { summary: 'finished immediately' };
      },
    });
    const context = createAgentToolContext(lifecycle);
    vi.spyOn(context.get(ISessionDispatchService), 'recordRun').mockRejectedValueOnce(new Error('recording failed'));
    const result = await executeAgentTool(context, {
      prompt: 'Investigate', description: 'Find cause', background: true,
    });
    expect(result).toMatchObject({ isError: true, output: 'recording failed' });
    const tasks = context.get(IAgentTaskService);
    const task = tasks.list(false).find((item) => item.kind === 'agent' && item.agentId === 'agent-child');
    expect(task).toBeDefined();
    await vi.waitFor(() => {
      expect(tasks.getTask(task!.taskId)?.status).toBe(failed ? 'failed' : 'completed');
    });
    expect(lifecycle.publishedEvents).toContainEqual(expect.objectContaining({
      type: failed ? 'subagent.failed' : 'subagent.completed', taskId: task!.taskId,
    }));
    expect(lifecycle.publishedEvents.some((event) => event.type === 'subagent.started')).toBe(false);
  });

  it('rejects background subagents when background execution is disabled', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle);
    context.get(IAgentProfileService).update({ activeToolNames: ['AgentRun'] });

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      background: true,
    });

    expect(result).toMatchObject({
      isError: true,
      output:
        'Background agent execution is not available for this agent because TaskList, TaskOutput, and TaskStop are not enabled.',
    });
    expect(lifecycle.create).not.toHaveBeenCalled();
  });

  it('does not consume a background task slot when validation fails before launch', async () => {
    const completion = deferred<{ readonly summary: string }>();
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: () => completion.promise,
    });
    const context = createAgentToolContext(
      lifecycle,
      configServices(() => ({
        providers: {},
        task: { maxRunningTasks: 1 },
        subagent: { defaultProfile: 'general' },
      })),
    );

    const invalid = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
      profile: 'explore',
      background: true,
    });
    const valid = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      background: true,
    });

    expect(invalid).toMatchObject({
      isError: true,
      output: 'Cannot set profile when continuing an existing agent. Pass only resume with the name or agent id.',
    });
    expect(valid.output).toContain('status: running');
    expect(lifecycle.create).toHaveBeenCalledTimes(1);
    completion.resolve({ summary: 'finished later' });
  });

  it('returns an error when background registration hits the task limit', async () => {
    const completions = [
      deferred<{ readonly summary: string }>(),
      deferred<{ readonly summary: string }>(),
    ];
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-first', 'agent-second'],
      runCompletion: (_agentId, _request, options) => {
        const next = completions.shift();
        if (next === undefined) throw new Error('unexpected run');
        options.signal.addEventListener(
          'abort',
          () => {
            next.reject(options.signal.reason);
          },
          { once: true },
        );
        return next.promise;
      },
    });
    const context = createAgentToolContext(
      lifecycle,
      configServices(() => ({
        providers: {},
        task: { maxRunningTasks: 1 },
        subagent: { defaultProfile: 'general' },
      })),
    );

    const first = await executeAgentTool(context, {
      prompt: 'Investigate first',
      description: 'Find first',
      background: true,
    });
    const second = await executeAgentTool(context, {
      prompt: 'Investigate second',
      description: 'Find second',
      background: true,
    });

    expect(first.output).toContain('status: running');
    expect(second).toMatchObject({
      isError: true,
      output: 'Too many background tasks are already running.',
    });
    expect(lifecycle.create).toHaveBeenCalledTimes(2);
    expect(
      lifecycle.publishedEvents.filter(
        (event) => (event as { subagentId?: string }).subagentId === 'agent-second',
      ),
    ).toEqual([]);
    completions[0]?.resolve({ summary: 'finished later' });
  });

  it('rejects one of two concurrent background subagents when the task limit is reached', async () => {
    const completions = [
      deferred<{ readonly summary: string }>(),
      deferred<{ readonly summary: string }>(),
    ];
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-first', 'agent-second'],
      runCompletion: (_agentId, _request, options) => {
        const next = completions.shift();
        if (next === undefined) throw new Error('unexpected run');
        options.signal.addEventListener('abort', () => next.reject(options.signal.reason), {
          once: true,
        });
        return next.promise;
      },
    });
    const context = createAgentToolContext(
      lifecycle,
      configServices(() => ({
        providers: {},
        task: { maxRunningTasks: 1 },
        subagent: { defaultProfile: 'general' },
      })),
    );

    const first = executeAgentTool(context, {
      prompt: 'Investigate first',
      description: 'Find first',
      background: true,
    });
    const second = executeAgentTool(context, {
      prompt: 'Investigate second',
      description: 'Find second',
      background: true,
    });

    const results = await Promise.all([first, second]);

    expect(lifecycle.create).toHaveBeenCalledTimes(2);
    expect(results).toContainEqual(
      expect.objectContaining({ output: expect.stringContaining('status: running') }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        isError: true,
        output: 'Too many background tasks are already running.',
      }),
    );
    completions[0]?.resolve({ summary: 'finished later' });
  });

  it('logs background registration failures', async () => {
    const { entries, logger } = captureLogs();
    const completions = [
      deferred<{ readonly summary: string }>(),
      deferred<{ readonly summary: string }>(),
    ];
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-first', 'agent-second'],
      runCompletion: (_agentId, _request, options) => {
        const next = completions.shift();
        if (next === undefined) throw new Error('unexpected run');
        options.signal.addEventListener('abort', () => next.reject(options.signal.reason), {
          once: true,
        });
        return next.promise;
      },
    });
    const context = createAgentToolContext(
      lifecycle,
      configServices(() => ({
        providers: {},
        task: { maxRunningTasks: 1 },
        subagent: { defaultProfile: 'general' },
      })),
      sessionService(ILogService, logger),
    );

    await executeAgentTool(context, {
      prompt: 'Investigate first',
      description: 'Find first',
      background: true,
    });
    await executeAgentTool(context, {
      prompt: 'Investigate second',
      description: 'Find second',
      background: true,
    });

    expect(entries).toContainEqual({
      level: 'warn',
      message: 'background agent task registration failed',
      payload: expect.objectContaining({
        toolCallId: 'call_agent',
        agentId: 'agent-second',
        profile: 'general',
        error: expect.any(Error),
      }),
    });
    completions[0]?.resolve({ summary: 'finished later' });
  });

  it('returns tool errors and logs when spawning fails', async () => {
    const error = new Error('missing subagent');
    const { entries, logger } = captureLogs();
    const lifecycle = createAgentLifecycleStub({ createError: error });
    const context = createAgentToolContext(lifecycle, sessionService(ILogService, logger));

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result).toMatchObject({
      isError: true,
      output: 'subagent error: missing subagent',
    });
    expect(entries).toContainEqual({
      level: 'warn',
      message: 'subagent launch failed',
      payload: expect.objectContaining({
        toolCallId: 'call_agent',
        runInBackground: false,
        operation: 'spawn',
        profile: 'general',
        error,
      }),
    });
  });

  it('can detach a foreground subagent through the task manager', async () => {
    const completion = deferred<{ readonly summary: string }>();
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: () => completion.promise,
    });
    const context = createAgentToolContext(lifecycle);
    const tasks = context.get(IAgentTaskService);

    const running = executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });
    await vi.waitFor(() => {
      expect(tasks.list(false)).toHaveLength(1);
    });
    const task = tasks.list(false)[0]!;

    expect(task).toMatchObject({
      kind: 'agent',
      detached: false,
      agentId: 'agent-child',
    });

    tasks.detach(task.taskId);
    const result = await running;

    expect(result.output).toContain(`task_id: ${task.taskId}`);
    expect(result.output).toContain('agent_id: agent-child');
    expect(result.output).toContain('automatic_notification: true');

    completion.resolve({ summary: 'finished later' });
    await expect(tasks.wait(task.taskId)).resolves.toMatchObject({
      status: 'completed',
      detached: true,
    });
  });

  it('does not recommend disabled task tools when a foreground subagent is detached', async () => {
    const completion = deferred<{ readonly summary: string }>();
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: () => completion.promise,
    });
    const context = createAgentToolContext(lifecycle);
    context.get(IAgentProfileService).update({ activeToolNames: ['AgentRun'] });
    const tasks = context.get(IAgentTaskService);

    const running = executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });
    await vi.waitFor(() => {
      expect(tasks.list(false)).toHaveLength(1);
    });
    const task = tasks.list(false)[0]!;

    tasks.detach(task.taskId);
    const result = await running;

    expect(result.output).toContain(`task_id: ${task.taskId}`);
    expect(result.output).toContain('automatic_notification: true');
    expect(result.output).not.toContain('TaskOutput');
    expect(result.output).not.toContain('TaskStop');

    completion.resolve({ summary: 'finished later' });
    await expect(tasks.wait(task.taskId)).resolves.toMatchObject({
      status: 'completed',
      detached: true,
    });
  });

  it('returns only dynamic facts without repeated tutorials on background launch', async () => {
    const completion = deferred<{ readonly summary: string }>();
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: () => completion.promise,
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      background: true,
    });

    if (typeof result.output !== 'string') throw new TypeError('expected string output');
    const taskId = result.output.match(/task_id: (agent-[0-9a-z]{8})/)?.[1];
    expect(taskId).toBeDefined();
    expect(result.output).toContain('agent_id: agent-child');
    expect(result.output).toContain('actual_profile: general');
    expect(result.output).toContain('status: running');
    expect(result.output).toContain('automatic_notification: true');
    expect(result.output).toContain('parent_notify: enabled');
    expect(result.output).not.toContain('next_step:');
    expect(result.output).not.toContain('resume_hint:');
    expect(result.output.split('\n')).toHaveLength(7);
    completion.resolve({ summary: 'finished later' });
  });

  it('reports a deliberate user interruption when a foreground subagent is cancelled by the user', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: (_agentId, _request, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              reject(options.signal.reason);
            },
            { once: true },
          );
        }),
    });
    const context = createAgentToolContext(lifecycle);
    const controller = new AbortController();

    const resultPromise = executeAgentTool(
      context,
      { prompt: 'Investigate', description: 'Find cause' },
      controller.signal,
    );
    await vi.waitFor(() => {
      expect(context.get(IAgentTaskService).list(false)).toHaveLength(1);
    });
    controller.abort(userCancellationReason());
    const result = await resultPromise;

    expect(result.isError).toBe(true);
    expect(result.output).toContain('status: failed');
    expect(result.output).toContain('The subagent was stopped before it finished by user.');
  });

  it('reports the reason when a foreground subagent is stopped for another cause', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: (_agentId, _request, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        }),
    });
    const context = createAgentToolContext(lifecycle);

    const resultPromise = executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });
    await vi.waitFor(() => {
      expect(context.get(IAgentTaskService).list(false)).toHaveLength(1);
    });
    const [task] = context.get(IAgentTaskService).list(false);
    await context.get(IAgentTaskService).stop(task!.taskId, 'Session closed');
    const result = await resultPromise;

    expect(result.isError).toBe(true);
    expect(result.output).toContain(
      'The subagent was stopped before it finished. Reason: Session closed',
    );
  });

  it('returns the spawned agent id when a foreground subagent times out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: (_agentId, _request, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              reject(options.signal.reason);
            },
            { once: true },
          );
        }),
    });
    const context = createAgentToolContext(lifecycle);

    const resultPromise = executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });
    await vi.waitFor(() => {
      expect(context.get(IAgentTaskService).list(false)).toHaveLength(1);
    });
    expect(context.get(IAgentTaskService).list(false)[0]).toMatchObject({ timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(DEFAULT_SUBAGENT_TIMEOUT_MS);
    expect(context.get(IAgentTaskService).list(false)[0]).toMatchObject({ detached: true });
    const result = await resultPromise;

    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('agent_id: agent-child');
    expect(result.output).toContain('actual_profile: general');
    expect(result.output).toContain('status: running');
    expect(result.output).toContain('automatic_notification: true');
    expect(result.output).not.toContain('resume_hint:');
  });

  it('honours the configured subagent timeout over the default', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: (_agentId, _request, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              reject(options.signal.reason);
            },
            { once: true },
          );
        }),
    });
    const context = createAgentToolContext(lifecycle, {
      initialConfig: { subagent: { timeoutMs: 1000 } },
    });

    const resultPromise = executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });
    await vi.waitFor(() => {
      expect(context.get(IAgentTaskService).list(false)).toHaveLength(1);
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('status: running');
    expect(result.output).toContain('agent_id: agent-child');
  });
});

describe('Agent tools', () => {
  let context: IAgentContextMemoryService;
  let ctx: TestAgentContext;
  let profile: IAgentProfileService;
  let tools: IAgentToolRegistryService;
  let tempHomeDirs: string[] = [];

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      try {
        await ctx.dispose();
      } finally {
        for (const dir of tempHomeDirs) {
          rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
        }
        tempHomeDirs = [];
      }
    }
  });

  it('returns actionable inheritance guidance through the LLM tool-call path', async () => {
    ctx = createTestAgent();
    ctx.mockNextResponse({ type: 'text', text: 'I will delegate.' }, {
      type: 'function', id: 'call_agent', name: 'AgentRun',
      arguments: JSON.stringify({ prompt: 'Investigate', description: 'Find cause', model_alias: 'inherit' }),
    });
    ctx.mockNextResponse({ type: 'text', text: 'I will select a concrete model.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Use an agent' }] });
    await ctx.untilTurnEnd();
    expect(ctx.contextData().history).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', toolCallId: 'call_agent', content: [
        expect.objectContaining({ text: expect.stringContaining('Specify a concrete model name, or omit model_alias to use the target default model.') }),
      ] }),
    ]));
  });

  describe('PreToolUse blocking', () => {
    let exec: ReturnType<typeof vi.fn>;
    let triggered: Array<[string, string, number]>;

    beforeEach(() => {
      exec = vi.fn<IHostProcessService['spawn']>().mockRejectedValue(new Error('Bash should not execute'));
      triggered = [];
      const hookEngine = makeHookRunner(
        [
          {
            event: 'PreToolUse',
            matcher: 'Bash',
            command: `node -e ${JSON.stringify(
              "process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'blocked by PreToolUse' } }))",
            )}`,
          },
          {
            event: 'PostToolUseFailure',
            matcher: 'Bash',
            command: `node -e ${JSON.stringify('process.exit(0)')}`,
          },
        ],
        {
          onTriggered: (event, target, count) => {
            triggered.push([event, target, count]);
          },
        },
      );
      ctx = createTestAgent(
        execEnvServices({ processRunner: createFakeProcessRunner({ spawn: exec as unknown as IHostProcessService['spawn'] }) }),
        externalHookServices(hookEngine),
      );
      context = ctx.get(IAgentContextMemoryService);
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['Bash'] });
    });

    it('blocks tool execution and emits PostToolUseFailure', async () => {
      await ctx.rpc.setPermission({ mode: 'auto' });
      ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
      ctx.mockNextResponse({ type: 'text', text: 'The hook blocked Bash.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Try Bash' }] });

      await ctx.untilTurnEnd();

      expect(exec).not.toHaveBeenCalled();
      expect(triggered).toEqual([
        ['PreToolUse', 'Bash', 1],
        ['PostToolUseFailure', 'Bash', 1],
      ]);
      expect(JSON.stringify(context.get())).toContain('blocked by PreToolUse');
    });
  });

  describe('successful Bash hook flow', () => {
    let resolved: Array<[string, string, string]>;

    beforeEach(async () => {
      resolved = [];
      const hookEngine = makeHookRunner(
        [
          {
            event: 'PreToolUse',
            matcher: 'Bash',
            command: hookPayloadAssertCommand({
              event: 'PreToolUse',
              toolName: 'Bash',
              toolCallId: 'call_bash',
              toolInputCommand: 'printf hook-output',
            }),
          },
          {
            event: 'PostToolUse',
            matcher: 'Bash',
            command: hookPayloadAssertCommand({
              event: 'PostToolUse',
              toolName: 'Bash',
              toolCallId: 'call_bash',
              toolInputCommand: 'printf hook-output',
              toolOutput: 'hook-output',
            }),
          },
        ],
        {
          onResolved: (event, target, action) => {
            resolved.push([event, target, action]);
          },
        },
      );
      ctx = createTestAgent(
        execEnvServices({ processRunner: createCommandRunner('hook-output') }),
        externalHookServices(hookEngine),
      );
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['Bash'] });
      await ctx.rpc.setPermission({ mode: 'auto' });
    });

    it('runs PreToolUse before successful tools and emits PostToolUse with output', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
      ctx.mockNextResponse({ type: 'text', text: 'Bash returned hook-output.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });

      await ctx.untilTurnEnd();

      await vi.waitFor(() => {
        expect(resolved).toEqual([
          ['PreToolUse', 'Bash', 'allow'],
          ['PostToolUse', 'Bash', 'allow'],
        ]);
      });
    });
  });

  describe('failed Bash hook flow', () => {
    let resolved: Array<[string, string, string]>;

    beforeEach(async () => {
      resolved = [];
      const hookEngine = makeHookRunner(
        [
          {
            event: 'PostToolUseFailure',
            matcher: 'Bash',
            command: hookPayloadAssertCommand({
              event: 'PostToolUseFailure',
              toolName: 'Bash',
              toolCallId: 'call_bash',
              toolInputCommand: 'printf hook-output',
              errorMessageIncludes: 'hook-output',
            }),
          },
        ],
        {
          onResolved: (event, target, action) => {
            resolved.push([event, target, action]);
          },
        },
      );
      ctx = createTestAgent(
        execEnvServices({ processRunner: createFailingCommandRunner('hook-output') }),
        externalHookServices(hookEngine),
      );
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['Bash'] });
      await ctx.rpc.setPermission({ mode: 'auto' });
    });

    it('emits PostToolUseFailure with payload when a builtin tool execution fails', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
      ctx.mockNextResponse({ type: 'text', text: 'Bash failed.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });

      await ctx.untilTurnEnd();

      await vi.waitFor(() => {
        expect(resolved).toEqual([['PostToolUseFailure', 'Bash', 'allow']]);
      });
    });
  });

  describe('Bash tool call start event', () => {
    beforeEach(async () => {
      ctx = createTestAgent(execEnvServices({ processRunner: createCommandRunner('ok') }));
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['Bash'] });
      await ctx.rpc.setPermission({ mode: 'yolo' });
    });

    it('uses builtin descriptions on tool call start events', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
      ctx.mockNextResponse({ type: 'text', text: 'Bash returned ok.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });
      await ctx.untilTurnEnd();

      const started = ctx.allEvents.find(
        (event) => event.type === '[rpc]' && event.event === 'tool.call.started',
      );
      expect(started?.args).toMatchObject({
        description: 'Running: printf hook-output',
      });
    });
  });

  describe('foreground AgentRun tool recovery', () => {
    beforeEach(() => {
      const lifecycle = createAgentLifecycleStub({
        createAgentIds: ['agent-child'],
        runCompletion: async () => {
          throw new Error('Subagent turn failed before completing its final summary: reason=max_tokens');
        },
      });
      ctx = createTestAgent(
        sessionService(IAgentLifecycleService, lifecycle),
        sessionService(ISessionSubagentService, lifecycle),
        sessionService(ISessionCronService, cronStub),
      );
      lifecycle.addHandle('main', 'agent');
    });

    it('continues after a foreground AgentRun tool returns a max_tokens failure', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'I will delegate.' }, agentCall());
      ctx.mockNextResponse({ type: 'text', text: 'I recovered from the subagent failure.' });

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Use an agent' }] });
      await ctx.untilTurnEnd();

      expect(ctx.contextData().history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'tool',
            toolCallId: 'call_agent',
            content: [
              expect.objectContaining({
                text: expect.stringContaining('reason=max_tokens'),
              }),
            ],
          }),
          expect.objectContaining({
            role: 'assistant',
            content: [
              expect.objectContaining({
                text: 'I recovered from the subagent failure.',
              }),
            ],
          }),
        ]),
      );
    });

    it('fails an agent run when the final summary is truncated', async () => {
      await ctx.dispose();
      ctx = createTestAgent();
      ctx.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'partial summary' }],
        finishReason: 'truncated',
        rawFinishReason: 'length',
      });

      const run = await runAgentTurn(
        currentAgentHandle(ctx, 'agent-child'),
        { kind: 'prompt', prompt: 'Investigate' },
        { signal },
      );

      await expect(run.completion).rejects.toThrow(
        'Subagent turn failed before completing its final summary: reason=max_tokens',
      );
    });
  });

  describe('registered user tool failure hooks', () => {
    let resolved: Array<[string, string, string]>;

    beforeEach(async () => {
      const lookupCall: ToolCall = {
        type: 'function',
        id: 'call_lookup',
        name: 'Lookup',
        arguments: '{"query":"moon"}',
      };
      resolved = [];
      const hookEngine = makeHookRunner(
        [
          {
            event: 'PostToolUseFailure',
            matcher: 'Lookup',
            command: hookErrorMessageAssertCommand('rich failure text'),
          },
        ],
        {
          onResolved: (event, target, action) => {
            resolved.push([event, target, action]);
          },
        },
      );
      ctx = createTestAgent(externalHookServices(hookEngine));
      await ctx.rpc.setPermission({ mode: 'auto' });
      await ctx.rpc.registerTool({
        name: 'Lookup',
        description: 'Look up a short test value.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      });
      ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
    });

    it('passes text from content-part error outputs to PostToolUseFailure hooks', async () => {
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
      await ctx.untilToolCall({
        isError: true,
        output: [{ type: 'text', text: 'rich failure text' }],
      });

      ctx.mockNextResponse({ type: 'text', text: 'The lookup failed.' });
      await ctx.untilTurnEnd();

      await vi.waitFor(() => {
        expect(resolved).toEqual([['PostToolUseFailure', 'Lookup', 'allow']]);
      });
    });
  });

  describe('active builtin tool set', () => {
    beforeEach(() => {
      ctx = createTestAgent();
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['Write', 'Bash'] });
    });

    it('uses the active builtin tool set as the LLM visible tools', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'ready' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Which tools are active?' }] });

      await ctx.untilTurnEnd();
      expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
        system: <system-prompt>
        tools: Bash, Write
        messages:
          user: text "Which tools are active?"
          user: text <auto-mode-enter-reminder>
      `);
    });
  });

  describe('Bash background mode', () => {
    beforeEach(() => {
      ctx = createTestAgent();
      profile = ctx.get(IAgentProfileService);
      tools = ctx.get(IAgentToolRegistryService);
      profile.update({ activeToolNames: ['Bash'] });
    });

    it('disables Bash background mode unless task management tools are active', async () => {
      const bashOnly = ctx.toolsData().find((tool) => tool.name === 'Bash');
      const bashTool = tools.resolve('Bash');
      expect(bashOnly).toBeDefined();
      expect(bashTool).toBeDefined();
      await expect(
        executeTool(bashTool!, {
          turnId: 0,
          toolCallId: 'call_bash',
          args: { command: 'sleep 10', run_in_background: true, description: 'watch' },
          signal,
        }),
      ).resolves.toMatchObject({
        isError: true,
        output:
          'Background execution is not available for this agent because TaskOutput and TaskStop are not enabled.',
      });

      await ctx.rpc.setActiveTools({ names: ['Bash', 'TaskList', 'TaskOutput', 'TaskStop'] });

      const managedBash = ctx.toolsData().find((tool) => tool.name === 'Bash');
      expect(managedBash).toBeDefined();
      expect(managedBash!.description).toContain('background=true');
    });
  });

  describe('registered user tools', () => {
    const lookupCall: ToolCall = {
      type: 'function',
      id: 'call_lookup',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
    };

    beforeEach(async () => {
      ctx = createTestAgent();
      await ctx.rpc.setPermission({ mode: 'auto' });
      await ctx.rpc.registerTool({
        name: 'Lookup',
        description: 'Look up a short test value.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      });
    });

    it('routes registered user tools through tool.call request/response', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
      expect(
        await ctx.untilToolCall({
          content: 'moon-result',
          output: 'moon-result',
        }),
      ).toMatchInlineSnapshot(`
        [wire] permission.set_mode         { "mode": "auto", "time": "<time>" }
        [wire] tools.register_user_tool    { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false }, "time": "<time>" }
        [wire] prompt.accepted             { "promptId": "<msg-1>", "time": "<time>" }
        [emit] prompt.submitted            { "time": "<time>", "agentId": "main", "promptId": "<msg-1>", "userMessageId": "<msg-1>", "status": "running", "content": [ { "type": "text", "text": "Look up moon" } ], "createdAt": "<time>", "appendTiming": "agent_idle", "revision": 0 }
        [wire] prompt.enqueued             { "schemaVersion": 1, "promptId": "<msg-1>", "userMessageId": "<msg-1>", "createdAt": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "alreadyMaterialized": false, "appendTiming": "agent_idle", "revision": 0, "queueIndex": 0, "time": "<time>" }
        [wire] prompt.launch_committed     { "launchId": "<uuid-1>", "promptId": "<msg-1>", "revision": 0, "committedAt": "<time>", "time": "<time>" }
        [emit] turn.prompt                 { "time": "<time>", "turnId": 0, "promptId": "<msg-1>", "input": [ { "type": "text", "text": "Look up moon" } ], "origin": { "kind": "user" }, "managed": true }
        [emit] turn.started                { "time": "<time>", "turnId": 0, "origin": { "kind": "user" }, "prompt": "Look up moon", "promptId": "<msg-1>" }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 0, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] context.append_message      { "time": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>", "source": { "turnId": 0, "stepId": "<uuid-2>", "step": 1 } }, "delivery": { "deliveryId": "<dlv-1>", "messageId": "<msg-1>", "turnId": 0, "stepId": "<uuid-2>", "step": 1, "deliveredAt": "<time>", "origin": "user" } }
        [emit] context.spliced             { "time": "<time>", "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>", "source": { "turnId": 0, "stepId": "<uuid-2>", "step": 1 } } ] }
        [emit] context.append_message      { "time": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" }, "id": "<msg-2>" }, "delivery": { "deliveryId": "<dlv-2>", "messageId": "<msg-2>", "deliveredAt": "<time>", "origin": "injection" } }
        [emit] context.spliced             { "time": "<time>", "start": 1, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" }, "id": "<msg-2>" } ] }
        [emit] prompt.started              { "time": "<time>", "agentId": "main", "promptId": "<msg-1>" }
        [wire] turn.prompt                 { "turnId": 0, "promptId": "<msg-1>", "input": [ { "type": "text", "text": "Look up moon" } ], "origin": { "kind": "user" }, "managed": true, "time": "<time>" }
        [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>", "source": { "turnId": 0, "stepId": "<uuid-2>", "step": 1 } }, "delivery": { "deliveryId": "<dlv-1>", "messageId": "<msg-1>", "turnId": 0, "stepId": "<uuid-2>", "step": 1, "deliveredAt": "<time>", "origin": "user" }, "time": "<time>" }
        [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" }, "id": "<msg-2>" }, "delivery": { "deliveryId": "<dlv-2>", "messageId": "<msg-2>", "deliveredAt": "<time>", "origin": "injection" }, "time": "<time>" }
        [wire] plugin.session_start        { "content": null, "time": "<time>" }
        [emit] turn.step.started           { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>" }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "step.begin", "uuid": "<uuid-2>", "turnId": "0", "step": 1 } }
        [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-2>", "turnId": "0", "step": 1 }, "time": "<time>" }
        [wire] llm.tools_snapshot          { "hash": "b74f357661bc8c1ebbf3e6ce5bbdf70c0007e3ec485912e6010542899e5f1073", "tools": [ { "name": "AgentList", "description": "List this agent's direct children, not grandchildren; use it to rediscover a child name or id after compaction before AgentRun resume or AgentSend. Default \`include_finished=false\` includes running and idle children; pass true for completed ones. A child's \`running\` status does not guarantee an active background task or notification—use TaskList for tracked work. This is a read-only roster and does not start or message children.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "include_finished": { "default": false, "description": "When true, also include finished or errored children. The default includes live executions even after their background task settles, and idle children with no tracking task.", "type": "boolean" } }, "additionalProperties": false } }, { "name": "AgentRun", "description": "Launch a scoped subagent with its own context; use for a coherent bounded task with useful parallel progress or independent evidence, not a trivial lookup. Give a self-contained brief with the goal, known paths, authority, success evidence, and handoff condition. \`description\` is a short required UI label. Pick \`profile\` or \`route\`, or use \`profile_file\` for a new explicit role; omit all three when using \`resume\` to continue an existing child. A stable \`name\` makes later AgentList/AgentSend/resume easier. Only you see the result; reconcile it and report relevant findings to the user. Do not redo a running child's work. On timeout, resume the same child. A child changing model on resume may need \`allow_model_change=true\`.\\n\\nSubagents may use AgentNotify only when the parent must change course before their final result; routine progress belongs in the final receipt.\\n\\n\\nSubagent timeout: 2 hours.\\n\\nSet \`background=true\` for independent work; automatic completion notification delivers the result. An interactive root can continue other work or end its turn without waiting—the task and session continue. Use foreground when you genuinely need the result in the same turn. Do not poll TaskWait/TaskOutput/AgentList just to keep a root turn open. A subagent must resolve its own dependencies before sending its final receipt.\\n\\n\\nAvailable profiles (pass via profile; preferred first):\\n- explore: Use for a scoped reading or retrieval question when source volume, context isolation, or parallel progress justifies the handoff.\\n- general: Use this agent when the delegated task does not name a more specific role: bounded synthesis or option tradeoffs, code changes, command execution, verification, research, or writin\\n\\nModel aliases available across the targets above: mock-model\\nModel alias and Thinking effort under each profile are defaults. Omit model_alias and effort to use the target defaults; do not assume they copy your model or effort. AgentRun does not accept model_alias: \\"inherit\\". To select a model explicitly, specify a concrete configured model name; otherwise omit model_alias to use the target default. Caller inheritance configured by a profile, route, or caller lease remains supported. Executable explicit overrides are accepted; deviations from role model/effort guidance, caller lease pins, or route pins produce binding advisories. Machine deny rules, missing models, unsupported efforts, and executor restrictions remain errors. A model listed for another target is only a recommendation for that target. If no model is bound, pass model_alias explicitly.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "prompt": { "type": "string", "description": "Full task prompt for the subagent" }, "description": { "type": "string", "description": "Short task description (3-5 words) for UI display" }, "profile": { "description": "One of the available agent profiles (see \\"Available agent profiles\\" in this tool description). When omitted, an explicitly configured [subagent].default_profile is used; otherwise the built-in general-purpose subagent prompt is used. An explicitly blank default requires a target.", "type": "string" }, "route": { "description": "Named profile route for a new subagent. The base profile is derived from the route when profile is omitted.", "type": "string", "minLength": 1 }, "name": { "description": "Optional stable name for the new subagent, unique within this session (lowercase letters, digits, and underscores; \\"root\\" is reserved). Use it to address the same agent again with resume, AgentSend, or AgentList instead of tracking its generated ID. Rejected together with resume.", "type": "string", "minLength": 1 }, "profile_file": { "description": "Explicit profile Markdown file, absolute or workspace-relative. Only for new agents; mutually exclusive with profile and route. This is a role definition, not a shared prompt template.", "type": "string", "minLength": 1, "pattern": "\\\\S" }, "allow_model_change": { "description": "Required true when resume explicitly changes model_alias to a different canonical model. Does not bypass role, caller, route or executor restrictions.", "type": "boolean" }, "allow_parent_notify": { "description": "Override AgentNotify availability for this child. On a new agent, omission uses the selected profile setting, which defaults to enabled. On resume, omission preserves the saved setting. This cannot override the global [agents].notify_parent switch or tool policy.", "type": "boolean" }, "resume": { "description": "Name or agent ID of an existing direct child. Do not pass name, profile, profile_file, or route. Omitted effort/model keep the saved binding. An explicit effort applies to the next idle run; changing model_alias also requires allow_model_change: true.", "type": "string" }, "background": { "description": "If true, return immediately and deliver the result through automatic completion notification. An interactive main agent (root) can end its turn while the subagent runs. Omit when the result must be returned synchronously in the same turn.", "type": "boolean" }, "model_alias": { "description": "Omit to use the target default model, or specify a concrete configured model name. AgentRun does not accept \\"inherit\\"; no silent caller-model fallback.", "type": "string", "minLength": 1, "pattern": "\\\\S" }, "effort": { "description": "Omit to use the target default thinking effort. An explicit effort overrides that default and must be supported by the target.", "type": "string", "minLength": 1, "pattern": "\\\\S" } }, "required": [ "prompt", "description" ], "additionalProperties": false, "allOf": [ { "not": { "allOf": [ { "required": [ "resume" ] }, { "anyOf": [ { "required": [ "profile" ] }, { "required": [ "profile_file" ] }, { "required": [ "route" ] }, { "required": [ "name" ] } ] } ] } }, { "not": { "allOf": [ { "required": [ "profile_file" ] }, { "anyOf": [ { "required": [ "profile" ] }, { "required": [ "route" ] } ] } ] } }, { "if": { "required": [ "allow_model_change" ] }, "then": { "required": [ "resume", "model_alias" ] } } ] } }, { "name": "AgentSend", "description": "Queue a message for a direct child by its AgentRun name or agent id; use AgentList if unsure. A running native child receives it at a step boundary; an idle resumable child starts a background run. Running external children read queued mail on their next run. A queued result means delivery has not necessarily happened; this tool does not wait. Names must be unambiguous, and the child does not see your conversation, so provide context in the message.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "target": { "type": "string", "minLength": 1, "description": "Name or agent id of a direct child. Names come from the \`name\` parameter of the Agent tool; unnamed children are addressed by agent id. Call AgentList when unsure." }, "message": { "type": "string", "description": "Non-empty message to queue in the child mailbox. A running native child receives it at the next step boundary; an idle resumable child starts a new run; a running external child receives it on its next run." } }, "required": [ "target", "message" ], "additionalProperties": false } }, { "name": "AskUserQuestion", "description": "Ask a structured question with 2–4 distinct options when the user's answer materially changes the next action. Do not ask when the answer follows from context; free-form input belongs in a plain question. The user always has an Other option. If an answer is dismissed or empty, do not assume the recommended option was selected. For a background question, do not make the dependent change until the answer arrives.\\n- Set background=true when you can keep working without the answer. This starts a background question task and returns a task_id immediately. The answer arrives automatically in a later turn — you do not need to poll, sleep, or check on it. Continue with other work; never fabricate or predict the answer.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "questions": { "minItems": 1, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "question": { "type": "string", "minLength": 1, "description": "A specific, actionable question. End with '?'." }, "header": { "default": "", "description": "Short category tag (max 12 chars, e.g. 'Auth', 'Style').", "type": "string" }, "options": { "minItems": 2, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "description": "Concise display text (1-5 words). If recommended, append '(Recommended)'." }, "description": { "default": "", "description": "Brief explanation of trade-offs or implications.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false }, "description": "2-4 meaningful, distinct options. Do NOT include an 'Other' option — the system adds one automatically." }, "multi_select": { "default": false, "description": "Whether the user can select multiple options.", "type": "boolean" } }, "required": [ "question", "options" ], "additionalProperties": false }, "description": "The questions to ask the user (1-4 questions)." }, "background": { "default": false, "description": "Set true to ask in the background and return immediately with a background task_id; you are notified automatically when the user answers — do not poll with TaskOutput while the question is pending.", "type": "boolean" } }, "required": [ "questions" ], "additionalProperties": false } }, { "name": "Bash", "description": "Execute a \`bash\` command for shell semantics: processes, pipes, package managers, git, builds and tests. Use Read/Glob/Grep for files and Edit/Write for file changes instead of Bash. Each call runs in a fresh shell: pass \`cwd\` or absolute paths. Quote paths with spaces. Chain dependent commands with \`&&\`; send independent read-only checks in parallel. Use \`run_in_background=true\` with a short \`description\` for long-running work; completion is notified automatically. Inspect detached work with \`TaskList\`/\`TaskOutput\` and cancel only your own work with \`TaskStop\`. Foreground calls return combined stdout/stderr and may move to background on timeout. Set \`lifetime=service\` only for a server, watcher, or listener. Do not run interactive or indefinitely running foreground commands, use \`..\` outside the workspace, access secrets via shell, or run superuser commands. Check command availability with \`which\` when uncertain.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "lifetime": { "description": "Whether background work is finite or a long-running service.", "type": "string", "enum": [ "finite", "service" ] }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false } }, { "name": "Edit", "description": "Replace exact text in an existing file. Use Edit for incremental changes rather than Write or a shell edit. Read the file immediately before each edit and copy a unique \`old_string\` from that result without line-number prefixes; use \`replace_all\` only when every occurrence should change. Read presents pure CRLF as LF and Edit preserves CRLF; mixed line endings need exact \`\\\\r\` characters. Re-read before another edit to the same file.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute." }, "old_string": { "type": "string", "minLength": 1, "description": "Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\\\r escapes where Read shows \\\\r." }, "new_string": { "type": "string", "description": "Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files." }, "replace_all": { "description": "Set true only when every occurrence of old_string should be replaced.", "type": "boolean" } }, "required": [ "path", "old_string", "new_string" ], "additionalProperties": false } }, { "name": "EnterPlanMode", "description": "Enter plan mode to research and draft an implementation plan before a consequential change with competing approaches or substantial uncertainty. Skip it for a small fix, a well-specified task, or pure research. The plan reminder explains the workflow; use ExitPlanMode after writing a concrete, verifiable plan. In plan mode, only the plan file can be edited; new native research-readonly children are permitted, but resuming or messaging children is blocked. Bash retains normal permission rules; this is not a sandbox.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false } }, { "name": "ExitPlanMode", "description": "Submit the finished plan file and exit plan mode. It reads the plan from the file named in the plan reminder; do not pass plan text as a parameter. Write verifiable steps before calling; use \`options\` only for meaningful alternatives. In manual/yolo modes the user reviews it; auto mode exits without an approval prompt. If the plan is rejected, revise the file and call again. Do not use AskUserQuestion just to ask whether the plan is acceptable.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "options": { "description": "When the plan contains multiple alternative approaches, list them here so the user can choose which one to execute. Provide up to 3 options; 2-3 distinct approaches work best when the plan offers a real choice. Passing a single option is allowed and is equivalent to a plain plan approval. Each option represents a distinct approach from the plan. Do not use \\"Reject\\", \\"Revise\\", \\"Approve\\", or \\"Reject and Exit\\" as labels.", "minItems": 1, "maxItems": 3, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 80, "description": "Short name for this option (1-8 words). Append \\"(Recommended)\\" if you recommend this option." }, "description": { "default": "", "description": "Brief summary of this approach and its trade-offs.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false } } }, "additionalProperties": false } }, { "name": "FetchURL", "description": "Fetch or extract content from a URL, or locally scoped/inline readable text. Use FetchURL after WebSearch when the source's full text matters. Minimal sync URL call: \`{ \\"url\\": \\"https://example.com\\" }\`; advanced calls use \`action\` and \`source\` and must not mix them with URL shorthand. Local/inline content cannot use egress pipelines; file inputs need an admitted donor scope and are bound to the approved file identity. Async requires \`idempotency_key\`; use get/read/cancel for the receipt and preserve partial/truncation warnings. Authentication walls do not become authenticated content.\\n\\n\\nCapability snapshot (availability reflects the last successful probe, not a live provider health check). Native nb-search runtime; no Skill or CLI prerequisite.\\nConfiguration source unavailable: TEST_SEARCH_NOT_CONFIGURED.\\nConfigured fetch chains (default representation: markdown):\\nFetch inputs: [].\\nFetch pipelines:\\nFetch limits: {\\"max_source_bytes\\":0,\\"max_response_bytes\\":0,\\"max_content_chars\\":0,\\"max_redirects\\":0,\\"max_timeout_ms\\":0,\\"max_inline_bytes\\":0}.\\nExplicit pipeline and representation override configured selection. Local/inline content stays subject to donor egress restrictions; file scopes do not bypass Kiki path admission.", "parameters": { "type": "object", "properties": { "action": { "type": "string", "enum": [ "run", "get", "read", "cancel" ] }, "source": { "oneOf": [ { "type": "object", "properties": { "kind": { "type": "string", "const": "url" }, "url": { "type": "string", "maxLength": 4096, "format": "uri" } }, "required": [ "kind", "url" ], "additionalProperties": false }, { "type": "object", "properties": { "kind": { "type": "string", "const": "inline_text" }, "content": { "type": "string" }, "media_type": { "type": "string", "enum": [ "text/html", "text/plain", "text/markdown" ] }, "base_url": { "type": "string", "maxLength": 4096, "format": "uri" } }, "required": [ "kind", "content", "media_type" ], "additionalProperties": false }, { "type": "object", "properties": { "kind": { "type": "string", "const": "inline_bytes" }, "content_base64": { "type": "string", "minLength": 1, "pattern": "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$" }, "media_type": { "type": "string", "minLength": 1, "maxLength": 256 }, "filename": { "type": "string", "minLength": 1, "maxLength": 1024 } }, "required": [ "kind", "content_base64", "media_type" ], "additionalProperties": false }, { "type": "object", "properties": { "kind": { "type": "string", "const": "file" }, "path": { "type": "string", "minLength": 1, "maxLength": 4096 }, "scope": { "type": "string", "minLength": 1, "maxLength": 256 } }, "required": [ "kind", "path", "scope" ], "additionalProperties": false } ] }, "pipeline": { "type": "string", "minLength": 1, "maxLength": 256 }, "representation": { "type": "string", "enum": [ "markdown", "text" ] }, "execution": { "type": "string", "enum": [ "sync", "async" ] }, "idempotency_key": { "type": "string", "pattern": "^[A-Za-z0-9._:-]{1,128}$" }, "timeout_ms": { "type": "integer", "minimum": 100, "maximum": 120000 }, "max_content_chars": { "type": "integer", "minimum": 1, "maximum": 10000000 }, "job_id": { "type": "string", "format": "uuid", "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$" }, "cursor": { "type": "string", "minLength": 1, "maxLength": 2048 }, "page_size": { "type": "integer", "minimum": 1, "maximum": 100 }, "url": { "type": "string", "maxLength": 4096, "format": "uri" } }, "additionalProperties": false } }, { "name": "Glob", "description": "Find files by glob pattern, ordered newest first. Use Glob to locate names, Grep to search contents, and Read for a known text file; results are files only, never directories. Patterns recurse unless anchored; \`**\` recurses within an anchored directory. Ignore rules apply unless \`include_ignored=true\`, and sensitive files are excluded. Page large results with \`offset\`; a new call rescans the filesystem, so results may shift.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Glob pattern to match files." }, "head_limit": { "description": "Maximum number of matching paths to return after offset. Defaults to 100. Pass 0 to remove the match-count limit. The character limit still applies: large pages are saved for Read, and a continuation offset is provided when more paths remain. Search time and output capture limits still apply.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of matching paths to skip. Defaults to 0. Each call searches the current filesystem again; changes can shift results between pages.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "path": { "description": "Directory to search. Accepts an absolute path, or a path relative to the current working directory. Defaults to the current working directory.", "type": "string" }, "include_ignored": { "description": "Also match files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" }, "include_dirs": { "description": "Deprecated and ignored. Results are always files-only — directories are never listed. Accepted only so older calls that still pass this flag are not rejected by parameter validation.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false } }, { "name": "Goal", "description": "Manage an autonomous, multi-turn goal: action=create, get, set_budget, or update. Create only when the user explicitly requests autonomous goal work; give it a verifiable objective, and use replace only with authorization. Get shows current status and remaining budget. Set_budget requires a user-given turns/tokens/time limit. Update with status=active, complete, or blocked only after checking the actual outcome; do not mark partial work complete. A nonterminal blocker must persist for three consecutive goal turns before blocking.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "oneOf": [ { "type": "object", "properties": { "objective": { "type": "string", "minLength": 1, "description": "The objective to pursue. Must have a verifiable end state." }, "completionCriterion": { "description": "How to verify the goal is complete. Include when the user provides one.", "type": "string" }, "replace": { "description": "Replace an existing active, paused, or blocked goal instead of failing.", "type": "boolean" }, "action": { "type": "string", "const": "create" } }, "required": [ "objective", "action" ], "additionalProperties": false }, { "type": "object", "properties": { "action": { "type": "string", "const": "get" } }, "required": [ "action" ], "additionalProperties": false }, { "type": "object", "properties": { "value": { "type": "number", "exclusiveMinimum": 0, "description": "The positive numeric budget value." }, "unit": { "type": "string", "enum": [ "turns", "tokens", "milliseconds", "seconds", "minutes", "hours" ] }, "action": { "type": "string", "const": "set_budget" } }, "required": [ "value", "unit", "action" ], "additionalProperties": false }, { "type": "object", "properties": { "status": { "type": "string", "enum": [ "active", "complete", "blocked" ], "description": "The lifecycle status to set for the current goal. Use \`blocked\` for impossible, unsafe, or contradictory objectives, or after the same non-terminal blocking condition repeats for at least 3 consecutive goal turns." }, "action": { "type": "string", "const": "update" } }, "required": [ "status", "action" ], "additionalProperties": false } ], "type": "object" } }, { "name": "Grep", "description": "Search file contents with ripgrep regular expressions. Use Grep instead of shell grep/rg; use Glob to locate files by name and Read to inspect a known file. Searches include hidden files, respect ignore rules by default, and omit sensitive files. Set \`include_ignored\` to search ignored build outputs or dependencies. Escape regex metacharacters when matching them literally.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Regular expression to search for." }, "path": { "description": "File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.", "type": "string" }, "glob": { "description": "Optional glob filter for which files to search, e.g. \`*.ts\`. Matched against each file's full absolute path, so a path-anchored pattern like \`src/**/*.ts\` silently matches nothing — use a basename pattern (\`*.ts\`), or anchor with \`**/\` (\`**/src/**/*.ts\`). To scope the search to a directory, use \`path\` instead.", "type": "string" }, "type": { "description": "Optional ripgrep file type filter, such as ts or py. Prefer this over \`glob\` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.", "type": "string" }, "output_mode": { "description": "Shape of the result. \`content\` shows matching lines (honors \`-A\`, \`-B\`, \`-C\`, \`-n\`, and \`head_limit\`); \`files_with_matches\` shows only the paths of files that contain a match, most-recently-modified first (honors \`head_limit\`); \`count_matches\` shows per-file match counts as \`path:count\` lines, preceded by an aggregate total line. Defaults to \`files_with_matches\`.", "type": "string", "enum": [ "content", "files_with_matches", "count_matches" ] }, "-i": { "description": "Perform a case-insensitive search. Defaults to false.", "type": "boolean" }, "-n": { "description": "Prefix each matching line with its line number. Applies only when \`output_mode\` is \`content\`. Defaults to true.", "type": "boolean" }, "-A": { "description": "Number of lines to show after each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-B": { "description": "Number of lines to show before each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-C": { "description": "Number of lines to show before and after each match. Applies only when \`output_mode\` is \`content\`; takes precedence over \`-A\` and \`-B\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "head_limit": { "description": "Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of leading lines/entries to skip before applying \`head_limit\`. Use it together with \`head_limit\` to page through large result sets. Defaults to 0.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "multiline": { "description": "Enable multiline matching, where the pattern can span line boundaries and \`.\` also matches newlines. Defaults to false.", "type": "boolean" }, "include_ignored": { "description": "Also search files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false } }, { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false } }, { "name": "Read", "description": "Read a UTF-8 or UTF-16 text file at a known path. Use Read rather than Bash to inspect a concrete file; directories belong to Glob or \`ls\`. Relative paths use the working directory. Large files are paged with \`line_offset\` and \`n_lines\`; each call returns at most 1000 lines or 100 KB, and lines longer than 2000 characters are truncated. Sensitive files require approval. Read the target before editing it.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to a text file. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use \`ls\` via Bash for a known directory, or Glob for pattern search." }, "line_offset": { "description": "The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file; the absolute value cannot exceed 1000.", "anyOf": [ { "type": "integer", "minimum": 1, "maximum": 9007199254740991 }, { "type": "integer", "minimum": -1000, "maximum": -1 } ] }, "n_lines": { "description": "The number of lines to read; the tool also applies its internal cap. Omit to read up to the internal cap of 1000 lines.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 } }, "required": [ "path" ], "additionalProperties": false } }, { "name": "Skill", "description": "Invoke a skill by its registered name (\`skill\`) or an explicit Markdown file (\`path\`), never both. A path load is local to this invocation; it does not replace a same-named registered skill, install a plugin, or execute scripts. Model-invocation restrictions also apply to path loads. Relative resources resolve from the loaded file's directory. BLOCKING REQUIREMENT: when a skill from the listing matches the user's request, you MUST call this tool (not free-form text). Do not re-invoke a skill to repeat work already done: if a \`<skill-loaded>\` block for the same source file (check \`path\` or \`dir\`, not just the name) with the same \`args\` is already present in the conversation, follow those instructions directly instead of calling the tool again. Do call the tool again when you need the skill with different arguments — the loaded block was expanded with the earlier \`args\` and will not reflect new inputs.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "skill": { "description": "The exact name of a skill in the current listing. Mutually exclusive with path.", "type": "string", "minLength": 1 }, "path": { "description": "An explicit Markdown skill file, absolute or relative to the workspace. Mutually exclusive with skill; loading does not register a global skill or execute scripts.", "type": "string", "minLength": 1 }, "args": { "description": "Optional argument string for the skill, written like a command line (e.g. \`-m \\"fix bug\\"\`, \`123\`, a file path). It is split on whitespace (quotes group a token) and expanded into the skill's placeholders ($NAME, $1, $ARGUMENTS); if the skill body has no placeholders, the whole string is still appended as a trailing \`ARGUMENTS:\` line. Omit it only when there is nothing to pass.", "type": "string" } }, "additionalProperties": false, "oneOf": [ { "required": [ "skill" ] }, { "required": [ "path" ] } ] } }, { "name": "TaskList", "description": "List background tasks and their statuses, including task ids for TaskOutput or TaskStop. Use it to rediscover task ids after compaction; default \`active_only=true\` hides completed work. This is read-only, not a wait; use TaskOutput to inspect a result and TaskWait only when synchronous same-turn completion is necessary. A task's completed receipt may contain an output path for its full log.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "active_only": { "default": true, "description": "Whether to list only non-terminal background tasks.", "type": "boolean" }, "limit": { "default": 20, "description": "Maximum number of tasks to return.", "type": "integer", "minimum": 1, "maximum": 100 }, "offset": { "default": 0, "description": "Number of matching tasks to skip before returning the page.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 } }, "additionalProperties": false } }, { "name": "TaskOutput", "description": "Inspect a running or completed background task without waiting. Use TaskList first if you do not know its id; for a truncated preview, Read the returned \`output_path\`. A completed shell task succeeds only with exit code 0; \`timed_out\` or \`stopped\` is a separate terminal reason. Prefer completion notifications; do not poll merely to hold a turn open. A subagent must resolve its own outstanding dependencies before returning a final receipt.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to inspect." }, "offset": { "description": "Byte offset from the beginning of the persisted output; starts at 0. Requires an available full log.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "max_bytes": { "description": "Maximum UTF-8 bytes to return in a page (4–32768; default 16384 when paging).", "type": "integer", "minimum": 4, "maximum": 32768 } }, "required": [ "task_id" ], "additionalProperties": false } }, { "name": "TaskStop", "description": "Stop a running background task only when it genuinely must be cancelled. Prefer TaskOutput for a normally finishing task; stopping can leave partial side effects. Calling on an already finished task only returns its current status. This does not stop arbitrary processes: use it only for tasks started by this agent.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to stop." }, "reason": { "default": "Stopped by TaskStop", "description": "Short reason recorded when the task is stopped.", "type": "string" } }, "required": [ "task_id" ], "additionalProperties": false } }, { "name": "TaskWait", "description": "Wait for an owned background task to finish within the current turn; \`timeout\` is required. Use only for a genuine same-turn dependency, not to poll an automatically notifying task. Without \`task_id\`, returns when any task running at call time finishes; with one, waits for that task. A timeout leaves tasks running. A task reported here does not also send an automatic completion notification. Subagents must resolve their own dependencies before returning a final receipt.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "timeout": { "type": "integer", "exclusiveMinimum": 0, "maximum": 600, "description": "Maximum time for an explicit same-turn wait, in seconds (1-600). A timeout returns still-running tasks without stopping them; do not automatically repeat the wait." }, "task_id": { "description": "The background task ID to wait for. When omitted, the wait ends as soon as any background task that was running at call time finishes.", "type": "string" } }, "required": [ "timeout" ], "additionalProperties": false } }, { "name": "ThreadCreate", "description": "Create a new independent top-level session thread only when the user explicitly asks. Unlike AgentRun, the new thread is user-owned, does not report its work back, and may start immediately if \`prompt\` is provided. \`cwd\` must be an existing absolute directory; \`profile\` names an enabled main-agent profile and \`persona\` names a stored persona. A persona may choose its profile and model when those fields are omitted. Initial permission mode cannot exceed the current mode. To interact later, use ThreadList, ThreadSend, and ThreadWait when enabled.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "title": { "type": "string", "minLength": 1 }, "cwd": { "type": "string", "minLength": 1 }, "profile": { "type": "string", "minLength": 1 }, "persona": { "type": "string", "minLength": 1 }, "model_alias": { "type": "string", "minLength": 1 }, "effort": { "type": "string", "minLength": 1 }, "permission_mode": { "type": "string", "enum": [ "manual", "auto", "review", "yolo" ] }, "plan_mode": { "type": "boolean" }, "prompt": { "type": "string", "minLength": 1, "maxLength": 100000 } }, "additionalProperties": false } }, { "name": "TodoList", "description": "Track a multi-step task as short actionable todos, with exactly one \`in_progress\` item while working. Use it when progress tracking helps; skip for trivial requests. Mark an item \`done\` only after implementation and relevant checks succeed; keep blocked or failing items active. Call without \`todos\` to inspect the current list, or \`todos: []\` to clear it. Avoid repeated updates with no meaningful progress. This list belongs only to the calling agent. For longer work, keep working notes alongside the todos: put the user's request and success criteria in \`goal\`, then record decisions, evidence, and the next step in the relevant sections. Each supplied section replaces that entire section; include earlier content you want to keep. Omitted sections stay unchanged, \`\\"\\"\` deletes one section, and \`null\` clears all notes.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "todos": { "description": "The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.", "type": "array", "items": { "type": "object", "properties": { "title": { "type": "string", "minLength": 1, "description": "Short, actionable title for the todo." }, "status": { "type": "string", "enum": [ "pending", "in_progress", "done" ], "description": "Current status of the todo." } }, "required": [ "title", "status" ], "additionalProperties": false } }, "notes": { "description": "Each supplied working-note section replaces that section entirely. To keep earlier content in a section, include all of it when updating. Record the user request and success criteria in goal. Empty text deletes one section; null clears all notes. Omit notes to leave them unchanged. Each section is limited to 1,500 characters and all sections together to 7,500.", "anyOf": [ { "type": "object", "properties": { "goal": { "description": "The user’s original request and what success requires. Keep this current so omitted history remains understandable.", "type": "string", "maxLength": 1500 }, "directives": { "description": "Still-active user instructions for this task: quote closely and include t<turn>. Reference saved memory as [m_id].", "type": "string", "maxLength": 1500 }, "decided": { "description": "Decisions already made; include previous decisions you still need to keep.", "type": "string", "maxLength": 1500 }, "rejected": { "description": "Options ruled out and why.", "type": "string", "maxLength": 1500 }, "evidence": { "description": "Verified observations and checks supporting the work.", "type": "string", "maxLength": 1500 }, "files": { "description": "Relevant files and their roles or changes.", "type": "string", "maxLength": 1500 }, "next": { "description": "The concrete next step to take.", "type": "string", "maxLength": 1500 }, "open": { "description": "Remaining questions or blockers.", "type": "string", "maxLength": 1500 } }, "additionalProperties": false }, { "type": "null" } ] } }, "additionalProperties": false } }, { "name": "WebSearch", "description": "Discover current web sources, ranked links, or typed provider research. Use FetchURL for full primary-source text rather than treating search snippets or synthesis as verification. Call with \`query\`; optional \`lane\`, \`lanes\`, and \`preset\` are mutually exclusive. Sync returns results directly. Async requires \`idempotency_key\` and returns a donor job receipt; use get/read/cancel and follow \`poll_after_ms\` without busy-polling. Cite actual source URLs.\\n\\n\\nCapability snapshot (availability reflects the last successful probe, not a live provider health check). Native nb-search runtime; no Skill or CLI prerequisite.\\nConfiguration source unavailable: TEST_SEARCH_NOT_CONFIGURED.\\nDefault search lane: not configured. Select an available lane or preset explicitly.\\nExplicit lane/lanes/preset selection overrides the default. Invalid or unavailable selections fail without switching providers.\\nAvailable search lanes:\\nNone available in this snapshot.\\nPresets: none.\\nSearch limits: {\\"max_queries\\":0,\\"max_results\\":0,\\"max_timeout_ms\\":0,\\"max_inline_bytes\\":0}.", "parameters": { "type": "object", "properties": { "action": { "type": "string", "enum": [ "run", "get", "read", "cancel" ] }, "query": { "anyOf": [ { "type": "string", "minLength": 1, "maxLength": 4000 }, { "minItems": 1, "maxItems": 64, "type": "array", "items": { "type": "string", "minLength": 1, "maxLength": 4000 } } ] }, "lane": { "type": "string", "minLength": 1, "maxLength": 256 }, "lanes": { "minItems": 1, "type": "array", "items": { "type": "string", "minLength": 1, "maxLength": 256 } }, "preset": { "type": "string", "minLength": 1, "maxLength": 256 }, "execution": { "type": "string", "enum": [ "sync", "async" ] }, "idempotency_key": { "type": "string", "pattern": "^[A-Za-z0-9._:-]{1,128}$" }, "freshness": { "type": "string", "enum": [ "pd", "pw", "pm", "py" ] }, "max_results": { "type": "integer", "minimum": 1, "maximum": 100 }, "timeout_ms": { "type": "integer", "minimum": 100, "maximum": 3600000 }, "job_id": { "type": "string", "format": "uuid", "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$" }, "cursor": { "type": "string", "minLength": 1, "maxLength": 2048 }, "page_size": { "type": "integer", "minimum": 1, "maximum": 100 } }, "additionalProperties": false } }, { "name": "Write", "description": "Create, append to, or entirely replace a file; missing parent directories are created. Use Edit for incremental changes to existing text, and Read before replacing a file. \`mode=append\` adds exactly the supplied content without a newline. Do not create unsolicited documentation. Content is written literally, including line endings; never include Read's line-number prefixes.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created automatically." }, "content": { "type": "string", "description": "Raw full file content to write exactly as provided. This does not use the Read/Edit text view." }, "mode": { "description": "Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline.", "type": "string", "enum": [ "overwrite", "append" ] } }, "required": [ "path", "content" ], "additionalProperties": false } } ], "time": "<time>" }
        [wire] llm.request                 { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "b74f357661bc8c1ebbf3e6ce5bbdf70c0007e3ec485912e6010542899e5f1073", "messageCount": 2, "turnStep": "0.1", "time": "<time>" }
        [emit] assistant.delta             { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>", "partId": "<uuid-3>", "delta": "I will look it up." }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] tool.call.delta             { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>", "toolCallId": "call_lookup", "name": "Lookup", "argumentsPart": "{\\"query\\":\\"moon\\"}" }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "tool_call", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 196, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "turnId": 0, "agentId": "main", "provider": "test-provider", "modelAlias": "mock-model", "executorId": "native", "usageKnown": true, "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "usage": { "byModel": { "mock-model": { "inputOther": 196, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 196, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 196, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] token_counting.measured     { "length": 3, "tokens": 212, "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "contextTokens": 212 }
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "part": { "type": "text", "text": "I will look it up." } } }
        [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "part": { "type": "text", "text": "I will look it up." } }, "time": "<time>" }
        [emit] tool.call.started           { "time": "<time>", "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "tool_call", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [ { "toolCallId": "call_lookup", "name": "Lookup", "since": "<time>" } ], "since": "<time>" }, "background": [] }
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "tool.call", "uuid": "<uuid-4>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } } }
        [emit] toolCall                    { "turnId": 0, "toolCallId": "call_lookup", "args": { "query": "moon" } }
      `);
      expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
        system: <system-prompt>
        tools: AgentList, AgentRun, AgentSend, AskUserQuestion, Bash, Edit, EnterPlanMode, ExitPlanMode, FetchURL, Glob, Goal, Grep, Lookup, Read, Skill, TaskList, TaskOutput, TaskStop, TaskWait, ThreadCreate, TodoList, WebSearch, Write
        messages:
          user: text "Look up moon"
          user: text <auto-mode-enter-reminder>
      `);

      ctx.mockNextResponse({ type: 'text', text: 'The lookup result is moon-result.' });
      expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
        [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "<uuid-4>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }, "time": "<time>" }
        [emit] tool.result                 { "time": "<time>", "turnId": 0, "toolCallId": "call_lookup", "output": "moon-result" }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "tool.result", "parentUuid": "<uuid-4>", "toolCallId": "call_lookup", "result": { "output": "moon-result" } } }
        [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "<uuid-4>", "toolCallId": "call_lookup", "result": { "output": "moon-result" } }, "time": "<time>" }
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "step.end", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 196, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" } }
        [emit] turn.step.completed         { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>", "usage": { "inputOther": 196, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }
        [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 196, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "time": "<time>" }
        [emit] turn.step.started           { "time": "<time>", "turnId": 0, "step": 2, "stepId": "<uuid-5>" }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "step.begin", "uuid": "<uuid-5>", "turnId": "0", "step": 2 } }
        [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-5>", "turnId": "0", "step": 2 }, "time": "<time>" }
        [wire] llm.request                 { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "b74f357661bc8c1ebbf3e6ce5bbdf70c0007e3ec485912e6010542899e5f1073", "messageCount": 4, "turnStep": "0.2", "time": "<time>" }
        [emit] assistant.delta             { "time": "<time>", "turnId": 0, "step": 2, "stepId": "<uuid-5>", "partId": "<uuid-6>", "delta": "The lookup result is moon-result." }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 216, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "turnId": 0, "agentId": "main", "provider": "test-provider", "modelAlias": "mock-model", "executorId": "native", "usageKnown": true, "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "usage": { "byModel": { "mock-model": { "inputOther": 412, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 412, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 412, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] token_counting.measured     { "length": 5, "tokens": 228, "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "contextTokens": 228 }
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "content.part", "uuid": "<uuid-6>", "turnId": "0", "step": 2, "stepUuid": "<uuid-5>", "part": { "type": "text", "text": "The lookup result is moon-result." } } }
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "step.end", "uuid": "<uuid-5>", "turnId": "0", "step": 2, "finishReason": "end_turn", "usage": { "inputOther": 216, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-2", "providerFinishReason": "completed", "rawFinishReason": "stop" } }
        [emit] turn.step.completed         { "time": "<time>", "turnId": 0, "step": 2, "stepId": "<uuid-5>", "usage": { "inputOther": 216, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-6>", "turnId": "0", "step": 2, "stepUuid": "<uuid-5>", "part": { "type": "text", "text": "The lookup result is moon-result." } }, "time": "<time>" }
        [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-5>", "turnId": "0", "step": 2, "finishReason": "end_turn", "usage": { "inputOther": 216, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-2", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
        [wire] turn.ended                  { "turnId": 0, "reason": "completed", "time": "<time>" }
        [emit] turn.ended                  { "time": "<time>", "turnId": 0, "reason": "completed" }
      `);
      expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      messages:
        <last>
        assistant: text "I will look it up."  calls call_lookup:Lookup { "query": "moon" }
        tool[call_lookup]: text "moon-result"
    `);
      await ctx.rpc.unregisterTool({ name: 'Lookup' });
      ctx.mockNextResponse({ type: 'text', text: 'No lookup tool is available.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Can you still use Lookup?' }] });

      expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
        [emit] agent.activity.updated       { "time": "<time>", "lifecycle": "ready", "lastTurn": { "turnId": 0, "reason": "completed", "at": "<time>" }, "background": [] }
        [wire] tools.unregister_user_tool   { "name": "Lookup", "time": "<time>" }
        [emit] prompt.completed             { "time": "<time>", "promptId": "<msg-1>", "finishedAt": "<time>", "reason": "completed" }
        [wire] prompt.completed             { "promptId": "<msg-1>", "finishedAt": "<time>", "reason": "completed", "time": "<time>" }
        [wire] prompt.accepted              { "promptId": "<msg-3>", "time": "<time>" }
        [emit] prompt.submitted             { "time": "<time>", "agentId": "main", "promptId": "<msg-3>", "userMessageId": "<msg-3>", "status": "running", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "createdAt": "<time>", "appendTiming": "agent_idle", "revision": 0 }
        [wire] prompt.enqueued              { "schemaVersion": 1, "promptId": "<msg-3>", "userMessageId": "<msg-3>", "createdAt": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-3>" }, "alreadyMaterialized": false, "appendTiming": "agent_idle", "revision": 0, "queueIndex": 0, "time": "<time>" }
        [wire] prompt.launch_committed      { "launchId": "<uuid-7>", "promptId": "<msg-3>", "revision": 0, "committedAt": "<time>", "time": "<time>" }
        [emit] turn.prompt                  { "time": "<time>", "turnId": 1, "promptId": "<msg-3>", "input": [ { "type": "text", "text": "Can you still use Lookup?" } ], "origin": { "kind": "user" }, "managed": true }
        [emit] turn.started                 { "time": "<time>", "turnId": 1, "origin": { "kind": "user" }, "prompt": "Can you still use Lookup?", "promptId": "<msg-3>" }
        [emit] agent.activity.updated       { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "running", "step": 0, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] context.append_message       { "time": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-3>", "source": { "turnId": 1, "stepId": "<uuid-8>", "step": 1 } }, "delivery": { "deliveryId": "<dlv-3>", "messageId": "<msg-3>", "turnId": 1, "stepId": "<uuid-8>", "step": 1, "deliveredAt": "<time>", "origin": "user" } }
        [emit] context.spliced              { "time": "<time>", "start": 5, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-3>", "source": { "turnId": 1, "stepId": "<uuid-8>", "step": 1 } } ] }
        [emit] prompt.started               { "time": "<time>", "agentId": "main", "promptId": "<msg-3>" }
        [wire] turn.prompt                  { "turnId": 1, "promptId": "<msg-3>", "input": [ { "type": "text", "text": "Can you still use Lookup?" } ], "origin": { "kind": "user" }, "managed": true, "time": "<time>" }
        [wire] context.append_message       { "message": { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-3>", "source": { "turnId": 1, "stepId": "<uuid-8>", "step": 1 } }, "delivery": { "deliveryId": "<dlv-3>", "messageId": "<msg-3>", "turnId": 1, "stepId": "<uuid-8>", "step": 1, "deliveredAt": "<time>", "origin": "user" }, "time": "<time>" }
        [emit] turn.step.started            { "time": "<time>", "turnId": 1, "step": 1, "stepId": "<uuid-8>" }
        [emit] agent.activity.updated       { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] context.append_loop_event    { "time": "<time>", "event": { "type": "step.begin", "uuid": "<uuid-8>", "turnId": "1", "step": 1 } }
        [wire] context.append_loop_event    { "event": { "type": "step.begin", "uuid": "<uuid-8>", "turnId": "1", "step": 1 }, "time": "<time>" }
        [wire] llm.tools_snapshot           { "hash": "593751aeb2df1b0b1043a42211dd198692e788543d41fbf13f0f712ad5b3dc7b", "tools": [ { "name": "AgentList", "description": "List this agent's direct children, not grandchildren; use it to rediscover a child name or id after compaction before AgentRun resume or AgentSend. Default \`include_finished=false\` includes running and idle children; pass true for completed ones. A child's \`running\` status does not guarantee an active background task or notification—use TaskList for tracked work. This is a read-only roster and does not start or message children.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "include_finished": { "default": false, "description": "When true, also include finished or errored children. The default includes live executions even after their background task settles, and idle children with no tracking task.", "type": "boolean" } }, "additionalProperties": false } }, { "name": "AgentRun", "description": "Launch a scoped subagent with its own context; use for a coherent bounded task with useful parallel progress or independent evidence, not a trivial lookup. Give a self-contained brief with the goal, known paths, authority, success evidence, and handoff condition. \`description\` is a short required UI label. Pick \`profile\` or \`route\`, or use \`profile_file\` for a new explicit role; omit all three when using \`resume\` to continue an existing child. A stable \`name\` makes later AgentList/AgentSend/resume easier. Only you see the result; reconcile it and report relevant findings to the user. Do not redo a running child's work. On timeout, resume the same child. A child changing model on resume may need \`allow_model_change=true\`.\\n\\nSubagents may use AgentNotify only when the parent must change course before their final result; routine progress belongs in the final receipt.\\n\\n\\nSubagent timeout: 2 hours.\\n\\nSet \`background=true\` for independent work; automatic completion notification delivers the result. An interactive root can continue other work or end its turn without waiting—the task and session continue. Use foreground when you genuinely need the result in the same turn. Do not poll TaskWait/TaskOutput/AgentList just to keep a root turn open. A subagent must resolve its own dependencies before sending its final receipt.\\n\\n\\nAvailable profiles (pass via profile; preferred first):\\n- explore: Use for a scoped reading or retrieval question when source volume, context isolation, or parallel progress justifies the handoff.\\n- general: Use this agent when the delegated task does not name a more specific role: bounded synthesis or option tradeoffs, code changes, command execution, verification, research, or writin\\n\\nModel aliases available across the targets above: mock-model\\nModel alias and Thinking effort under each profile are defaults. Omit model_alias and effort to use the target defaults; do not assume they copy your model or effort. AgentRun does not accept model_alias: \\"inherit\\". To select a model explicitly, specify a concrete configured model name; otherwise omit model_alias to use the target default. Caller inheritance configured by a profile, route, or caller lease remains supported. Executable explicit overrides are accepted; deviations from role model/effort guidance, caller lease pins, or route pins produce binding advisories. Machine deny rules, missing models, unsupported efforts, and executor restrictions remain errors. A model listed for another target is only a recommendation for that target. If no model is bound, pass model_alias explicitly.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "prompt": { "type": "string", "description": "Full task prompt for the subagent" }, "description": { "type": "string", "description": "Short task description (3-5 words) for UI display" }, "profile": { "description": "One of the available agent profiles (see \\"Available agent profiles\\" in this tool description). When omitted, an explicitly configured [subagent].default_profile is used; otherwise the built-in general-purpose subagent prompt is used. An explicitly blank default requires a target.", "type": "string" }, "route": { "description": "Named profile route for a new subagent. The base profile is derived from the route when profile is omitted.", "type": "string", "minLength": 1 }, "name": { "description": "Optional stable name for the new subagent, unique within this session (lowercase letters, digits, and underscores; \\"root\\" is reserved). Use it to address the same agent again with resume, AgentSend, or AgentList instead of tracking its generated ID. Rejected together with resume.", "type": "string", "minLength": 1 }, "profile_file": { "description": "Explicit profile Markdown file, absolute or workspace-relative. Only for new agents; mutually exclusive with profile and route. This is a role definition, not a shared prompt template.", "type": "string", "minLength": 1, "pattern": "\\\\S" }, "allow_model_change": { "description": "Required true when resume explicitly changes model_alias to a different canonical model. Does not bypass role, caller, route or executor restrictions.", "type": "boolean" }, "allow_parent_notify": { "description": "Override AgentNotify availability for this child. On a new agent, omission uses the selected profile setting, which defaults to enabled. On resume, omission preserves the saved setting. This cannot override the global [agents].notify_parent switch or tool policy.", "type": "boolean" }, "resume": { "description": "Name or agent ID of an existing direct child. Do not pass name, profile, profile_file, or route. Omitted effort/model keep the saved binding. An explicit effort applies to the next idle run; changing model_alias also requires allow_model_change: true.", "type": "string" }, "background": { "description": "If true, return immediately and deliver the result through automatic completion notification. An interactive main agent (root) can end its turn while the subagent runs. Omit when the result must be returned synchronously in the same turn.", "type": "boolean" }, "model_alias": { "description": "Omit to use the target default model, or specify a concrete configured model name. AgentRun does not accept \\"inherit\\"; no silent caller-model fallback.", "type": "string", "minLength": 1, "pattern": "\\\\S" }, "effort": { "description": "Omit to use the target default thinking effort. An explicit effort overrides that default and must be supported by the target.", "type": "string", "minLength": 1, "pattern": "\\\\S" } }, "required": [ "prompt", "description" ], "additionalProperties": false, "allOf": [ { "not": { "allOf": [ { "required": [ "resume" ] }, { "anyOf": [ { "required": [ "profile" ] }, { "required": [ "profile_file" ] }, { "required": [ "route" ] }, { "required": [ "name" ] } ] } ] } }, { "not": { "allOf": [ { "required": [ "profile_file" ] }, { "anyOf": [ { "required": [ "profile" ] }, { "required": [ "route" ] } ] } ] } }, { "if": { "required": [ "allow_model_change" ] }, "then": { "required": [ "resume", "model_alias" ] } } ] } }, { "name": "AgentSend", "description": "Queue a message for a direct child by its AgentRun name or agent id; use AgentList if unsure. A running native child receives it at a step boundary; an idle resumable child starts a background run. Running external children read queued mail on their next run. A queued result means delivery has not necessarily happened; this tool does not wait. Names must be unambiguous, and the child does not see your conversation, so provide context in the message.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "target": { "type": "string", "minLength": 1, "description": "Name or agent id of a direct child. Names come from the \`name\` parameter of the Agent tool; unnamed children are addressed by agent id. Call AgentList when unsure." }, "message": { "type": "string", "description": "Non-empty message to queue in the child mailbox. A running native child receives it at the next step boundary; an idle resumable child starts a new run; a running external child receives it on its next run." } }, "required": [ "target", "message" ], "additionalProperties": false } }, { "name": "AskUserQuestion", "description": "Ask a structured question with 2–4 distinct options when the user's answer materially changes the next action. Do not ask when the answer follows from context; free-form input belongs in a plain question. The user always has an Other option. If an answer is dismissed or empty, do not assume the recommended option was selected. For a background question, do not make the dependent change until the answer arrives.\\n- Set background=true when you can keep working without the answer. This starts a background question task and returns a task_id immediately. The answer arrives automatically in a later turn — you do not need to poll, sleep, or check on it. Continue with other work; never fabricate or predict the answer.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "questions": { "minItems": 1, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "question": { "type": "string", "minLength": 1, "description": "A specific, actionable question. End with '?'." }, "header": { "default": "", "description": "Short category tag (max 12 chars, e.g. 'Auth', 'Style').", "type": "string" }, "options": { "minItems": 2, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "description": "Concise display text (1-5 words). If recommended, append '(Recommended)'." }, "description": { "default": "", "description": "Brief explanation of trade-offs or implications.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false }, "description": "2-4 meaningful, distinct options. Do NOT include an 'Other' option — the system adds one automatically." }, "multi_select": { "default": false, "description": "Whether the user can select multiple options.", "type": "boolean" } }, "required": [ "question", "options" ], "additionalProperties": false }, "description": "The questions to ask the user (1-4 questions)." }, "background": { "default": false, "description": "Set true to ask in the background and return immediately with a background task_id; you are notified automatically when the user answers — do not poll with TaskOutput while the question is pending.", "type": "boolean" } }, "required": [ "questions" ], "additionalProperties": false } }, { "name": "Bash", "description": "Execute a \`bash\` command for shell semantics: processes, pipes, package managers, git, builds and tests. Use Read/Glob/Grep for files and Edit/Write for file changes instead of Bash. Each call runs in a fresh shell: pass \`cwd\` or absolute paths. Quote paths with spaces. Chain dependent commands with \`&&\`; send independent read-only checks in parallel. Use \`run_in_background=true\` with a short \`description\` for long-running work; completion is notified automatically. Inspect detached work with \`TaskList\`/\`TaskOutput\` and cancel only your own work with \`TaskStop\`. Foreground calls return combined stdout/stderr and may move to background on timeout. Set \`lifetime=service\` only for a server, watcher, or listener. Do not run interactive or indefinitely running foreground commands, use \`..\` outside the workspace, access secrets via shell, or run superuser commands. Check command availability with \`which\` when uncertain.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "lifetime": { "description": "Whether background work is finite or a long-running service.", "type": "string", "enum": [ "finite", "service" ] }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false } }, { "name": "Edit", "description": "Replace exact text in an existing file. Use Edit for incremental changes rather than Write or a shell edit. Read the file immediately before each edit and copy a unique \`old_string\` from that result without line-number prefixes; use \`replace_all\` only when every occurrence should change. Read presents pure CRLF as LF and Edit preserves CRLF; mixed line endings need exact \`\\\\r\` characters. Re-read before another edit to the same file.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute." }, "old_string": { "type": "string", "minLength": 1, "description": "Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\\\r escapes where Read shows \\\\r." }, "new_string": { "type": "string", "description": "Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files." }, "replace_all": { "description": "Set true only when every occurrence of old_string should be replaced.", "type": "boolean" } }, "required": [ "path", "old_string", "new_string" ], "additionalProperties": false } }, { "name": "EnterPlanMode", "description": "Enter plan mode to research and draft an implementation plan before a consequential change with competing approaches or substantial uncertainty. Skip it for a small fix, a well-specified task, or pure research. The plan reminder explains the workflow; use ExitPlanMode after writing a concrete, verifiable plan. In plan mode, only the plan file can be edited; new native research-readonly children are permitted, but resuming or messaging children is blocked. Bash retains normal permission rules; this is not a sandbox.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false } }, { "name": "ExitPlanMode", "description": "Submit the finished plan file and exit plan mode. It reads the plan from the file named in the plan reminder; do not pass plan text as a parameter. Write verifiable steps before calling; use \`options\` only for meaningful alternatives. In manual/yolo modes the user reviews it; auto mode exits without an approval prompt. If the plan is rejected, revise the file and call again. Do not use AskUserQuestion just to ask whether the plan is acceptable.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "options": { "description": "When the plan contains multiple alternative approaches, list them here so the user can choose which one to execute. Provide up to 3 options; 2-3 distinct approaches work best when the plan offers a real choice. Passing a single option is allowed and is equivalent to a plain plan approval. Each option represents a distinct approach from the plan. Do not use \\"Reject\\", \\"Revise\\", \\"Approve\\", or \\"Reject and Exit\\" as labels.", "minItems": 1, "maxItems": 3, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 80, "description": "Short name for this option (1-8 words). Append \\"(Recommended)\\" if you recommend this option." }, "description": { "default": "", "description": "Brief summary of this approach and its trade-offs.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false } } }, "additionalProperties": false } }, { "name": "FetchURL", "description": "Fetch or extract content from a URL, or locally scoped/inline readable text. Use FetchURL after WebSearch when the source's full text matters. Minimal sync URL call: \`{ \\"url\\": \\"https://example.com\\" }\`; advanced calls use \`action\` and \`source\` and must not mix them with URL shorthand. Local/inline content cannot use egress pipelines; file inputs need an admitted donor scope and are bound to the approved file identity. Async requires \`idempotency_key\`; use get/read/cancel for the receipt and preserve partial/truncation warnings. Authentication walls do not become authenticated content.\\n\\n\\nCapability snapshot (availability reflects the last successful probe, not a live provider health check). Native nb-search runtime; no Skill or CLI prerequisite.\\nConfiguration source unavailable: TEST_SEARCH_NOT_CONFIGURED.\\nConfigured fetch chains (default representation: markdown):\\nFetch inputs: [].\\nFetch pipelines:\\nFetch limits: {\\"max_source_bytes\\":0,\\"max_response_bytes\\":0,\\"max_content_chars\\":0,\\"max_redirects\\":0,\\"max_timeout_ms\\":0,\\"max_inline_bytes\\":0}.\\nExplicit pipeline and representation override configured selection. Local/inline content stays subject to donor egress restrictions; file scopes do not bypass Kiki path admission.", "parameters": { "type": "object", "properties": { "action": { "type": "string", "enum": [ "run", "get", "read", "cancel" ] }, "source": { "oneOf": [ { "type": "object", "properties": { "kind": { "type": "string", "const": "url" }, "url": { "type": "string", "maxLength": 4096, "format": "uri" } }, "required": [ "kind", "url" ], "additionalProperties": false }, { "type": "object", "properties": { "kind": { "type": "string", "const": "inline_text" }, "content": { "type": "string" }, "media_type": { "type": "string", "enum": [ "text/html", "text/plain", "text/markdown" ] }, "base_url": { "type": "string", "maxLength": 4096, "format": "uri" } }, "required": [ "kind", "content", "media_type" ], "additionalProperties": false }, { "type": "object", "properties": { "kind": { "type": "string", "const": "inline_bytes" }, "content_base64": { "type": "string", "minLength": 1, "pattern": "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$" }, "media_type": { "type": "string", "minLength": 1, "maxLength": 256 }, "filename": { "type": "string", "minLength": 1, "maxLength": 1024 } }, "required": [ "kind", "content_base64", "media_type" ], "additionalProperties": false }, { "type": "object", "properties": { "kind": { "type": "string", "const": "file" }, "path": { "type": "string", "minLength": 1, "maxLength": 4096 }, "scope": { "type": "string", "minLength": 1, "maxLength": 256 } }, "required": [ "kind", "path", "scope" ], "additionalProperties": false } ] }, "pipeline": { "type": "string", "minLength": 1, "maxLength": 256 }, "representation": { "type": "string", "enum": [ "markdown", "text" ] }, "execution": { "type": "string", "enum": [ "sync", "async" ] }, "idempotency_key": { "type": "string", "pattern": "^[A-Za-z0-9._:-]{1,128}$" }, "timeout_ms": { "type": "integer", "minimum": 100, "maximum": 120000 }, "max_content_chars": { "type": "integer", "minimum": 1, "maximum": 10000000 }, "job_id": { "type": "string", "format": "uuid", "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$" }, "cursor": { "type": "string", "minLength": 1, "maxLength": 2048 }, "page_size": { "type": "integer", "minimum": 1, "maximum": 100 }, "url": { "type": "string", "maxLength": 4096, "format": "uri" } }, "additionalProperties": false } }, { "name": "Glob", "description": "Find files by glob pattern, ordered newest first. Use Glob to locate names, Grep to search contents, and Read for a known text file; results are files only, never directories. Patterns recurse unless anchored; \`**\` recurses within an anchored directory. Ignore rules apply unless \`include_ignored=true\`, and sensitive files are excluded. Page large results with \`offset\`; a new call rescans the filesystem, so results may shift.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Glob pattern to match files." }, "head_limit": { "description": "Maximum number of matching paths to return after offset. Defaults to 100. Pass 0 to remove the match-count limit. The character limit still applies: large pages are saved for Read, and a continuation offset is provided when more paths remain. Search time and output capture limits still apply.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of matching paths to skip. Defaults to 0. Each call searches the current filesystem again; changes can shift results between pages.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "path": { "description": "Directory to search. Accepts an absolute path, or a path relative to the current working directory. Defaults to the current working directory.", "type": "string" }, "include_ignored": { "description": "Also match files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" }, "include_dirs": { "description": "Deprecated and ignored. Results are always files-only — directories are never listed. Accepted only so older calls that still pass this flag are not rejected by parameter validation.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false } }, { "name": "Goal", "description": "Manage an autonomous, multi-turn goal: action=create, get, set_budget, or update. Create only when the user explicitly requests autonomous goal work; give it a verifiable objective, and use replace only with authorization. Get shows current status and remaining budget. Set_budget requires a user-given turns/tokens/time limit. Update with status=active, complete, or blocked only after checking the actual outcome; do not mark partial work complete. A nonterminal blocker must persist for three consecutive goal turns before blocking.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "oneOf": [ { "type": "object", "properties": { "objective": { "type": "string", "minLength": 1, "description": "The objective to pursue. Must have a verifiable end state." }, "completionCriterion": { "description": "How to verify the goal is complete. Include when the user provides one.", "type": "string" }, "replace": { "description": "Replace an existing active, paused, or blocked goal instead of failing.", "type": "boolean" }, "action": { "type": "string", "const": "create" } }, "required": [ "objective", "action" ], "additionalProperties": false }, { "type": "object", "properties": { "action": { "type": "string", "const": "get" } }, "required": [ "action" ], "additionalProperties": false }, { "type": "object", "properties": { "value": { "type": "number", "exclusiveMinimum": 0, "description": "The positive numeric budget value." }, "unit": { "type": "string", "enum": [ "turns", "tokens", "milliseconds", "seconds", "minutes", "hours" ] }, "action": { "type": "string", "const": "set_budget" } }, "required": [ "value", "unit", "action" ], "additionalProperties": false }, { "type": "object", "properties": { "status": { "type": "string", "enum": [ "active", "complete", "blocked" ], "description": "The lifecycle status to set for the current goal. Use \`blocked\` for impossible, unsafe, or contradictory objectives, or after the same non-terminal blocking condition repeats for at least 3 consecutive goal turns." }, "action": { "type": "string", "const": "update" } }, "required": [ "status", "action" ], "additionalProperties": false } ], "type": "object" } }, { "name": "Grep", "description": "Search file contents with ripgrep regular expressions. Use Grep instead of shell grep/rg; use Glob to locate files by name and Read to inspect a known file. Searches include hidden files, respect ignore rules by default, and omit sensitive files. Set \`include_ignored\` to search ignored build outputs or dependencies. Escape regex metacharacters when matching them literally.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Regular expression to search for." }, "path": { "description": "File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.", "type": "string" }, "glob": { "description": "Optional glob filter for which files to search, e.g. \`*.ts\`. Matched against each file's full absolute path, so a path-anchored pattern like \`src/**/*.ts\` silently matches nothing — use a basename pattern (\`*.ts\`), or anchor with \`**/\` (\`**/src/**/*.ts\`). To scope the search to a directory, use \`path\` instead.", "type": "string" }, "type": { "description": "Optional ripgrep file type filter, such as ts or py. Prefer this over \`glob\` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.", "type": "string" }, "output_mode": { "description": "Shape of the result. \`content\` shows matching lines (honors \`-A\`, \`-B\`, \`-C\`, \`-n\`, and \`head_limit\`); \`files_with_matches\` shows only the paths of files that contain a match, most-recently-modified first (honors \`head_limit\`); \`count_matches\` shows per-file match counts as \`path:count\` lines, preceded by an aggregate total line. Defaults to \`files_with_matches\`.", "type": "string", "enum": [ "content", "files_with_matches", "count_matches" ] }, "-i": { "description": "Perform a case-insensitive search. Defaults to false.", "type": "boolean" }, "-n": { "description": "Prefix each matching line with its line number. Applies only when \`output_mode\` is \`content\`. Defaults to true.", "type": "boolean" }, "-A": { "description": "Number of lines to show after each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-B": { "description": "Number of lines to show before each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-C": { "description": "Number of lines to show before and after each match. Applies only when \`output_mode\` is \`content\`; takes precedence over \`-A\` and \`-B\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "head_limit": { "description": "Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of leading lines/entries to skip before applying \`head_limit\`. Use it together with \`head_limit\` to page through large result sets. Defaults to 0.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "multiline": { "description": "Enable multiline matching, where the pattern can span line boundaries and \`.\` also matches newlines. Defaults to false.", "type": "boolean" }, "include_ignored": { "description": "Also search files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false } }, { "name": "Read", "description": "Read a UTF-8 or UTF-16 text file at a known path. Use Read rather than Bash to inspect a concrete file; directories belong to Glob or \`ls\`. Relative paths use the working directory. Large files are paged with \`line_offset\` and \`n_lines\`; each call returns at most 1000 lines or 100 KB, and lines longer than 2000 characters are truncated. Sensitive files require approval. Read the target before editing it.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to a text file. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use \`ls\` via Bash for a known directory, or Glob for pattern search." }, "line_offset": { "description": "The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file; the absolute value cannot exceed 1000.", "anyOf": [ { "type": "integer", "minimum": 1, "maximum": 9007199254740991 }, { "type": "integer", "minimum": -1000, "maximum": -1 } ] }, "n_lines": { "description": "The number of lines to read; the tool also applies its internal cap. Omit to read up to the internal cap of 1000 lines.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 } }, "required": [ "path" ], "additionalProperties": false } }, { "name": "Skill", "description": "Invoke a skill by its registered name (\`skill\`) or an explicit Markdown file (\`path\`), never both. A path load is local to this invocation; it does not replace a same-named registered skill, install a plugin, or execute scripts. Model-invocation restrictions also apply to path loads. Relative resources resolve from the loaded file's directory. BLOCKING REQUIREMENT: when a skill from the listing matches the user's request, you MUST call this tool (not free-form text). Do not re-invoke a skill to repeat work already done: if a \`<skill-loaded>\` block for the same source file (check \`path\` or \`dir\`, not just the name) with the same \`args\` is already present in the conversation, follow those instructions directly instead of calling the tool again. Do call the tool again when you need the skill with different arguments — the loaded block was expanded with the earlier \`args\` and will not reflect new inputs.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "skill": { "description": "The exact name of a skill in the current listing. Mutually exclusive with path.", "type": "string", "minLength": 1 }, "path": { "description": "An explicit Markdown skill file, absolute or relative to the workspace. Mutually exclusive with skill; loading does not register a global skill or execute scripts.", "type": "string", "minLength": 1 }, "args": { "description": "Optional argument string for the skill, written like a command line (e.g. \`-m \\"fix bug\\"\`, \`123\`, a file path). It is split on whitespace (quotes group a token) and expanded into the skill's placeholders ($NAME, $1, $ARGUMENTS); if the skill body has no placeholders, the whole string is still appended as a trailing \`ARGUMENTS:\` line. Omit it only when there is nothing to pass.", "type": "string" } }, "additionalProperties": false, "oneOf": [ { "required": [ "skill" ] }, { "required": [ "path" ] } ] } }, { "name": "TaskList", "description": "List background tasks and their statuses, including task ids for TaskOutput or TaskStop. Use it to rediscover task ids after compaction; default \`active_only=true\` hides completed work. This is read-only, not a wait; use TaskOutput to inspect a result and TaskWait only when synchronous same-turn completion is necessary. A task's completed receipt may contain an output path for its full log.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "active_only": { "default": true, "description": "Whether to list only non-terminal background tasks.", "type": "boolean" }, "limit": { "default": 20, "description": "Maximum number of tasks to return.", "type": "integer", "minimum": 1, "maximum": 100 }, "offset": { "default": 0, "description": "Number of matching tasks to skip before returning the page.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 } }, "additionalProperties": false } }, { "name": "TaskOutput", "description": "Inspect a running or completed background task without waiting. Use TaskList first if you do not know its id; for a truncated preview, Read the returned \`output_path\`. A completed shell task succeeds only with exit code 0; \`timed_out\` or \`stopped\` is a separate terminal reason. Prefer completion notifications; do not poll merely to hold a turn open. A subagent must resolve its own outstanding dependencies before returning a final receipt.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to inspect." }, "offset": { "description": "Byte offset from the beginning of the persisted output; starts at 0. Requires an available full log.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "max_bytes": { "description": "Maximum UTF-8 bytes to return in a page (4–32768; default 16384 when paging).", "type": "integer", "minimum": 4, "maximum": 32768 } }, "required": [ "task_id" ], "additionalProperties": false } }, { "name": "TaskStop", "description": "Stop a running background task only when it genuinely must be cancelled. Prefer TaskOutput for a normally finishing task; stopping can leave partial side effects. Calling on an already finished task only returns its current status. This does not stop arbitrary processes: use it only for tasks started by this agent.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to stop." }, "reason": { "default": "Stopped by TaskStop", "description": "Short reason recorded when the task is stopped.", "type": "string" } }, "required": [ "task_id" ], "additionalProperties": false } }, { "name": "TaskWait", "description": "Wait for an owned background task to finish within the current turn; \`timeout\` is required. Use only for a genuine same-turn dependency, not to poll an automatically notifying task. Without \`task_id\`, returns when any task running at call time finishes; with one, waits for that task. A timeout leaves tasks running. A task reported here does not also send an automatic completion notification. Subagents must resolve their own dependencies before returning a final receipt.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "timeout": { "type": "integer", "exclusiveMinimum": 0, "maximum": 600, "description": "Maximum time for an explicit same-turn wait, in seconds (1-600). A timeout returns still-running tasks without stopping them; do not automatically repeat the wait." }, "task_id": { "description": "The background task ID to wait for. When omitted, the wait ends as soon as any background task that was running at call time finishes.", "type": "string" } }, "required": [ "timeout" ], "additionalProperties": false } }, { "name": "ThreadCreate", "description": "Create a new independent top-level session thread only when the user explicitly asks. Unlike AgentRun, the new thread is user-owned, does not report its work back, and may start immediately if \`prompt\` is provided. \`cwd\` must be an existing absolute directory; \`profile\` names an enabled main-agent profile and \`persona\` names a stored persona. A persona may choose its profile and model when those fields are omitted. Initial permission mode cannot exceed the current mode. To interact later, use ThreadList, ThreadSend, and ThreadWait when enabled.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "title": { "type": "string", "minLength": 1 }, "cwd": { "type": "string", "minLength": 1 }, "profile": { "type": "string", "minLength": 1 }, "persona": { "type": "string", "minLength": 1 }, "model_alias": { "type": "string", "minLength": 1 }, "effort": { "type": "string", "minLength": 1 }, "permission_mode": { "type": "string", "enum": [ "manual", "auto", "review", "yolo" ] }, "plan_mode": { "type": "boolean" }, "prompt": { "type": "string", "minLength": 1, "maxLength": 100000 } }, "additionalProperties": false } }, { "name": "TodoList", "description": "Track a multi-step task as short actionable todos, with exactly one \`in_progress\` item while working. Use it when progress tracking helps; skip for trivial requests. Mark an item \`done\` only after implementation and relevant checks succeed; keep blocked or failing items active. Call without \`todos\` to inspect the current list, or \`todos: []\` to clear it. Avoid repeated updates with no meaningful progress. This list belongs only to the calling agent. For longer work, keep working notes alongside the todos: put the user's request and success criteria in \`goal\`, then record decisions, evidence, and the next step in the relevant sections. Each supplied section replaces that entire section; include earlier content you want to keep. Omitted sections stay unchanged, \`\\"\\"\` deletes one section, and \`null\` clears all notes.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "todos": { "description": "The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.", "type": "array", "items": { "type": "object", "properties": { "title": { "type": "string", "minLength": 1, "description": "Short, actionable title for the todo." }, "status": { "type": "string", "enum": [ "pending", "in_progress", "done" ], "description": "Current status of the todo." } }, "required": [ "title", "status" ], "additionalProperties": false } }, "notes": { "description": "Each supplied working-note section replaces that section entirely. To keep earlier content in a section, include all of it when updating. Record the user request and success criteria in goal. Empty text deletes one section; null clears all notes. Omit notes to leave them unchanged. Each section is limited to 1,500 characters and all sections together to 7,500.", "anyOf": [ { "type": "object", "properties": { "goal": { "description": "The user’s original request and what success requires. Keep this current so omitted history remains understandable.", "type": "string", "maxLength": 1500 }, "directives": { "description": "Still-active user instructions for this task: quote closely and include t<turn>. Reference saved memory as [m_id].", "type": "string", "maxLength": 1500 }, "decided": { "description": "Decisions already made; include previous decisions you still need to keep.", "type": "string", "maxLength": 1500 }, "rejected": { "description": "Options ruled out and why.", "type": "string", "maxLength": 1500 }, "evidence": { "description": "Verified observations and checks supporting the work.", "type": "string", "maxLength": 1500 }, "files": { "description": "Relevant files and their roles or changes.", "type": "string", "maxLength": 1500 }, "next": { "description": "The concrete next step to take.", "type": "string", "maxLength": 1500 }, "open": { "description": "Remaining questions or blockers.", "type": "string", "maxLength": 1500 } }, "additionalProperties": false }, { "type": "null" } ] } }, "additionalProperties": false } }, { "name": "WebSearch", "description": "Discover current web sources, ranked links, or typed provider research. Use FetchURL for full primary-source text rather than treating search snippets or synthesis as verification. Call with \`query\`; optional \`lane\`, \`lanes\`, and \`preset\` are mutually exclusive. Sync returns results directly. Async requires \`idempotency_key\` and returns a donor job receipt; use get/read/cancel and follow \`poll_after_ms\` without busy-polling. Cite actual source URLs.\\n\\n\\nCapability snapshot (availability reflects the last successful probe, not a live provider health check). Native nb-search runtime; no Skill or CLI prerequisite.\\nConfiguration source unavailable: TEST_SEARCH_NOT_CONFIGURED.\\nDefault search lane: not configured. Select an available lane or preset explicitly.\\nExplicit lane/lanes/preset selection overrides the default. Invalid or unavailable selections fail without switching providers.\\nAvailable search lanes:\\nNone available in this snapshot.\\nPresets: none.\\nSearch limits: {\\"max_queries\\":0,\\"max_results\\":0,\\"max_timeout_ms\\":0,\\"max_inline_bytes\\":0}.", "parameters": { "type": "object", "properties": { "action": { "type": "string", "enum": [ "run", "get", "read", "cancel" ] }, "query": { "anyOf": [ { "type": "string", "minLength": 1, "maxLength": 4000 }, { "minItems": 1, "maxItems": 64, "type": "array", "items": { "type": "string", "minLength": 1, "maxLength": 4000 } } ] }, "lane": { "type": "string", "minLength": 1, "maxLength": 256 }, "lanes": { "minItems": 1, "type": "array", "items": { "type": "string", "minLength": 1, "maxLength": 256 } }, "preset": { "type": "string", "minLength": 1, "maxLength": 256 }, "execution": { "type": "string", "enum": [ "sync", "async" ] }, "idempotency_key": { "type": "string", "pattern": "^[A-Za-z0-9._:-]{1,128}$" }, "freshness": { "type": "string", "enum": [ "pd", "pw", "pm", "py" ] }, "max_results": { "type": "integer", "minimum": 1, "maximum": 100 }, "timeout_ms": { "type": "integer", "minimum": 100, "maximum": 3600000 }, "job_id": { "type": "string", "format": "uuid", "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$" }, "cursor": { "type": "string", "minLength": 1, "maxLength": 2048 }, "page_size": { "type": "integer", "minimum": 1, "maximum": 100 } }, "additionalProperties": false } }, { "name": "Write", "description": "Create, append to, or entirely replace a file; missing parent directories are created. Use Edit for incremental changes to existing text, and Read before replacing a file. \`mode=append\` adds exactly the supplied content without a newline. Do not create unsolicited documentation. Content is written literally, including line endings; never include Read's line-number prefixes.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created automatically." }, "content": { "type": "string", "description": "Raw full file content to write exactly as provided. This does not use the Read/Edit text view." }, "mode": { "description": "Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline.", "type": "string", "enum": [ "overwrite", "append" ] } }, "required": [ "path", "content" ], "additionalProperties": false } } ], "time": "<time>" }
        [wire] llm.request                  { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "593751aeb2df1b0b1043a42211dd198692e788543d41fbf13f0f712ad5b3dc7b", "messageCount": 6, "turnStep": "1.1", "time": "<time>" }
        [emit] assistant.delta              { "time": "<time>", "turnId": 1, "step": 1, "stepId": "<uuid-8>", "partId": "<uuid-9>", "delta": "No lookup tool is available." }
        [emit] agent.activity.updated       { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] usage.record                 { "model": "mock-model", "usage": { "inputOther": 236, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "turnId": 1, "agentId": "main", "provider": "test-provider", "modelAlias": "mock-model", "executorId": "native", "usageKnown": true, "time": "<time>" }
        [emit] agent.status.updated         { "time": "<time>", "usage": { "byModel": { "mock-model": { "inputOther": 648, "output": 38, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 648, "output": 38, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 236, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] token_counting.measured      { "length": 7, "tokens": 246, "time": "<time>" }
        [emit] agent.status.updated         { "time": "<time>", "contextTokens": 246 }
        [emit] context.append_loop_event    { "time": "<time>", "event": { "type": "content.part", "uuid": "<uuid-9>", "turnId": "1", "step": 1, "stepUuid": "<uuid-8>", "part": { "type": "text", "text": "No lookup tool is available." } } }
        [emit] context.append_loop_event    { "time": "<time>", "event": { "type": "step.end", "uuid": "<uuid-8>", "turnId": "1", "step": 1, "finishReason": "end_turn", "usage": { "inputOther": 236, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-3", "providerFinishReason": "completed", "rawFinishReason": "stop" } }
        [emit] turn.step.completed          { "time": "<time>", "turnId": 1, "step": 1, "stepId": "<uuid-8>", "usage": { "inputOther": 236, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
        [emit] agent.activity.updated       { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] context.append_loop_event    { "event": { "type": "content.part", "uuid": "<uuid-9>", "turnId": "1", "step": 1, "stepUuid": "<uuid-8>", "part": { "type": "text", "text": "No lookup tool is available." } }, "time": "<time>" }
        [wire] context.append_loop_event    { "event": { "type": "step.end", "uuid": "<uuid-8>", "turnId": "1", "step": 1, "finishReason": "end_turn", "usage": { "inputOther": 236, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-3", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
        [wire] turn.ended                   { "turnId": 1, "reason": "completed", "time": "<time>" }
        [emit] turn.ended                   { "time": "<time>", "turnId": 1, "reason": "completed" }
      `);
      expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
        tools: AgentList, AgentRun, AgentSend, AskUserQuestion, Bash, Edit, EnterPlanMode, ExitPlanMode, FetchURL, Glob, Goal, Grep, Read, Skill, TaskList, TaskOutput, TaskStop, TaskWait, ThreadCreate, TodoList, WebSearch, Write
        messages:
          <last>
          assistant: text "The lookup result is moon-result."
          user: text "Can you still use Lookup?"
      `);
    });

    it('persists oversized registered user tool results before adding them to context', async () => {
      await ctx.dispose();
      const homeDir = mkdtempSync(join(tmpdir(), 'tool-result-truncation-'));
      tempHomeDirs.push(homeDir);
      ctx = createTestAgent(homeDirServices(homeDir));
      await ctx.rpc.setPermission({ mode: 'auto' });
      await ctx.rpc.registerTool({
        name: 'Lookup',
        description: 'Look up a long test value.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      });

      const fullOutput =
        `${'x'.repeat(99)}\n`.repeat(500) +
        'middle elided from preview\n' +
        `${'x'.repeat(99)}\n`.repeat(10);
      ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
      await ctx.untilToolCall({
        content: fullOutput,
        output: fullOutput,
      });
      ctx.mockNextResponse({ type: 'text', text: 'The lookup output was saved.' });
      await ctx.untilTurnEnd();

      const toolMessage = ctx.compactHistory().find((message) => message.role === 'tool')?.text;
      expect(toolMessage).toContain('Tool output exceeded 50000 characters');
      expect(toolMessage).toContain('tool_name: Lookup');
      expect(toolMessage).toContain('tool_call_id: call_lookup');
      expect(toolMessage).not.toContain('middle elided from preview');

      const outputPath = renderedOutputPath(toolMessage);
      expect(outputPath).toContain(
        join(
          homeDir,
          'sessions/test-workspace/test-session/agents/main/tool-results/Lookup-call_lookup-',
        ).replaceAll('\\', '/'),
      );
      expect(readFileSync(outputPath, 'utf8')).toBe(fullOutput);
    });
  });
});

function renderedOutputPath(output: string | undefined): string {
  if (output === undefined) throw new Error('expected tool output');
  const match = /^output_path: (.+)$/m.exec(output);
  if (match === null) throw new Error('expected tool output to include output_path');
  return match[1]!;
}

function bashCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_bash',
    name: 'Bash',
    arguments: '{"command":"printf hook-output","timeout":60}',
  };
}

function createFailingCommandRunner(stdout: string): IHostProcessService {
  function createProcess(): IHostProcess {
    return {
      _serviceBrand: undefined,
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout: Readable.from([stdout]),
      stderr: Readable.from(['']),
      pid: 42,
      exitCode: 2,
      wait: vi.fn().mockResolvedValue(2) as IHostProcess['wait'],
      kill: vi.fn().mockResolvedValue(undefined) as IHostProcess['kill'],
      dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
    };
  }
  return createFakeProcessRunner({
    spawn: vi.fn().mockImplementation(async () => createProcess()),
  });
}

function agentCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_agent',
    name: 'AgentRun',
    arguments: JSON.stringify({
      prompt: 'Investigate deeply',
      description: 'Investigate deeply',
      profile: 'general',
      model_alias: 'mock-model',
    }),
  };
}

function hookErrorMessageAssertCommand(expected: string): string {
  const script = [
    "let input = '';",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    '  const payload = JSON.parse(input);',
    `  if (payload.error?.message === ${JSON.stringify(expected)}) process.exit(0);`,
    "  console.error(payload.error?.message ?? '<missing>');",
    '  process.exit(2);',
    '});',
  ].join('');
  return `node -e ${JSON.stringify(script)}`;
}

function hookPayloadAssertCommand(expected: {
  readonly event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure';
  readonly toolName: string;
  readonly toolCallId: string;
  readonly toolInputCommand: string;
  readonly toolOutput?: string;
  readonly errorMessageIncludes?: string;
}): string {
  const script = [
    "let input = '';",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    '  const payload = JSON.parse(input);',
    `  if (payload.hook_event_name !== ${JSON.stringify(expected.event)}) throw new Error('bad event: ' + payload.hook_event_name);`,
    `  if (payload.tool_name !== ${JSON.stringify(expected.toolName)}) throw new Error('bad tool_name: ' + payload.tool_name);`,
    `  if (payload.tool_call_id !== ${JSON.stringify(expected.toolCallId)}) throw new Error('bad tool_call_id: ' + payload.tool_call_id);`,
    `  if (payload.tool_input?.command !== ${JSON.stringify(expected.toolInputCommand)}) throw new Error('bad command: ' + payload.tool_input?.command);`,
    expected.toolOutput === undefined
      ? ''
      : `  if (payload.tool_output !== ${JSON.stringify(expected.toolOutput)}) throw new Error('bad tool_output: ' + payload.tool_output);`,
    expected.toolOutput === undefined
      ? ''
      : "  if (payload.error !== undefined) throw new Error('unexpected error payload');",
    expected.errorMessageIncludes === undefined
      ? ''
      : `  if (typeof payload.error?.message !== 'string' || !payload.error.message.includes(${JSON.stringify(expected.errorMessageIncludes)})) throw new Error('bad error: ' + payload.error?.message);`,
    expected.errorMessageIncludes === undefined
      ? ''
      : "  if (payload.tool_output !== undefined) throw new Error('unexpected tool_output: ' + payload.tool_output);",
    '  process.exit(0);',
    '});',
    "process.on('uncaughtException', (error) => { console.error(error.message); process.exit(2); });",
  ].filter((line) => line.length > 0).join('');
  return `node -e ${JSON.stringify(script)}`;
}
